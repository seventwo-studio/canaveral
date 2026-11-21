/** Android AVDs and transfers, scoped to immutable local assignment receipts. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ServiceError, object } from "../errors.ts";
import { assignmentFingerprint, noLinks, present } from "../runtime-process.ts";
import type { LeaseAuthorization } from "../runtime-process.ts";
import { MobileProvider, SUPERVISOR_REFUSED, SupervisorLaunchError, authorized, canonical, copyUpload, markNotStaged, decodeData, digest, encoded, integer, locked, operationRequest, privateDirectory, publicationUncertain, readJson, readRegular, saveJson, text, unsupported, uuid, writeAll } from "./mobile.ts";
import type { Authorized, ByteReader, DeviceRequest, Download, LeaseSupervisorStatus, NativeChild, NativePipe, RecordValue, RunOptions, SupervisedChild } from "./mobile.ts";
import { fenceLeaseAuthorization, publishLeaseAuthorization, requireLeaseAccess } from "./lease-supervision.ts";
import { openAndroidVideo } from './android-video.ts';
import { androidOrphan, purgeOrphan, runtimeOperation, storageDevices, strayDevices } from "./mobile-runtimes.ts";
import type { OrphanEvidence, OrphanRemoval, RuntimeContext, RuntimeReport } from "./mobile-runtimes.ts";
import type { AndroidVideoOptions } from './android-video.ts';

/** Leased guests get no network path to the host. User-mode networking (slirp) maps
 * 10.0.2.2 to the host's loopback, so an unrestricted guest can reach the adb server,
 * other emulators' adb ports and every loopback service. `restrict=on` drops all guest
 * traffic leaving the virtual network, for the radio and the Wi-Fi interface; netsim
 * Wi-Fi, Bluetooth and UWB are disabled so no host-wide netsimd (a radio medium shared
 * between emulators) starts; crash reporting is disabled so no crashpad_handler escapes
 * the supervised process group. Verified against emulator 37.2.13 on 19 November 2026. */
export const LEASE_ISOLATION_ARGUMENTS: readonly string[] = ["-feature", "-WiFiPacketStream", "-feature", "-BluetoothEmulation", "-feature", "-Uwb",
  "-network-user-mode-options", "restrict=on,ipv6=off", "-wifi-user-mode-options", "restrict=on,ipv6=off", "-crash-report-mode", "disabled", "-no-metrics"];
/** The guest's alias for the host loopback under user-mode networking. */
export const GUEST_HOST_ALIAS = "10.0.2.2";
export function quote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
export interface TransferHelper { data: Buffer; sha256: string }
export function loadHelper(config: RecordValue, image: RecordValue): TransferHelper {
  try {
    const manifestPath = text(config.transferHelperManifest, "transfer helper manifest");
    if (!path.isAbsolute(manifestPath)) throw new Error("absolute path required");
    const manifest = object(JSON.parse(readRegular(manifestPath, 65536).toString("utf8")));
    if (manifest.schemaVersion !== 1 || manifest.protocol !== "CANAVERAL_TRANSFER_V1" || manifest.minimumAPI !== 26) throw new Error("invalid helper protocol");
    const systemImage = text(object(image.device).systemImage, "system image");
    const api = /^system-images;android-([0-9]+);[^;]+;[^;]+$/.exec(systemImage);
    if (!api || Number(api[1]) < 26) throw new Error("unsupported API");
    const arch = String(image.arch), machine = arch === "arm64" ? 183 : arch === "amd64" ? 62 : undefined;
    const artifact = object(object(manifest.artifacts)[arch]);
    if (!machine || artifact.file !== "canaveral-transfer-" + arch || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("invalid artifact");
    integer(artifact.bytes, "helper size", 64, 16 * 1048576);
    const data = readRegular(path.join(path.dirname(manifestPath), artifact.file as string), 16 * 1048576);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.length !== artifact.bytes || sha256 !== artifact.sha256 || !data.subarray(0, 6).equals(Buffer.from("7f454c460201", "hex")) || data.readUInt16LE(16) !== 3 || data.readUInt16LE(18) !== machine || data.includes(Buffer.from("CANAVERAL_TRANSFER_TEST_FAIL"))) throw new Error("invalid helper binary");
    return { data, sha256 };
  } catch { throw new ServiceError("Android transfer helper manifest, architecture, API level or checksum validation failed.", 400, { code: "transfer_helper_invalid" }); }
}
function guestPath(value: unknown, app: unknown): string {
  const result = text(value, "Android guest path");
  if (app || !result.startsWith("/") || result.endsWith("/") || result === "/") throw new ServiceError("Use an absolute Android guest file path without app.", 400);
  return result;
}
async function receiptLine(pipe: NativePipe, check: Authorized): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  const deadline = performance.now() + 30000;
  while (size <= 128) {
    await authorized(check);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ServiceError("Android helper receipt timed out.");
    const data = Buffer.from(await pipe.read(129 - size, remaining));
    await authorized(check);
    if (!data.length || data.length > 129 - size) throw new ServiceError("Android helper ended without its bounded receipt.");
    chunks.push(data); size += data.length;
    if (data.includes(10)) return Buffer.concat(chunks);
  }
  throw new ServiceError("Android helper response exceeded its metadata envelope.");
}

export class AndroidProvider extends MobileProvider {
  override readonly kind = "android";
  readonly processes = new Map<string, NativeChild>();
  tool(name: "adb" | "emulator" | "avdmanager"): string {
    const sdk = text(this.config.androidSDK, "androidSDK");
    if (!path.isAbsolute(sdk)) throw new ServiceError("androidSDK must be absolute.", 400);
    return path.join(sdk, { adb: "platform-tools/adb", emulator: "emulator/emulator", avdmanager: "cmdline-tools/latest/bin/avdmanager" }[name]);
  }
  override environment(): Record<string, string> {
    const env = super.environment();
    env.ANDROID_HOME = text(this.config.androidSDK, "androidSDK"); env.ANDROID_SDK_ROOT = env.ANDROID_HOME;
    env.ANDROID_AVD_HOME = path.join(text(this.config.storage, "storage"), "avds");
    for (const key of ["ANDROID_SERIAL", "ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_PORT"]) delete env[key];
    return env;
  }
  async adb(serial: string, args: readonly string[], options: Partial<RunOptions> = {}): Promise<string> { return this.runText([this.tool("adb"), "-s", serial, ...args], options); }
  async adbBytes(serial: string, args: readonly string[]): Promise<Buffer> { return this.run([this.tool("adb"), "-s", serial, ...args]); }
  async check(): Promise<unknown> {
    if (!["darwin", "linux"].includes(String(this.config.hostPlatform ?? process.platform))) throw new ServiceError("Android requires native macOS or Linux.");
    const images = this.checkTemplates("android");
    for (const name of ["adb", "emulator", "avdmanager"] as const) if (!fs.statSync(this.tool(name)).isFile()) throw new ServiceError("Install Android SDK tools before offering devices.");
    for (const image of images) {
      const directory = path.join(text(this.config.androidSDK, "androidSDK"), ...String(object(image.device).systemImage).split(";"));
      if (!fs.statSync(directory).isDirectory()) throw new ServiceError("Install every offered Android system image.");
      if (this.config.transferHelperManifest != null) loadHelper(this.config, image);
    }
    await this.run([this.tool("adb"), "start-server"]);
    return { ready: true, nativeAcceptance: false, androidUploadHelper: this.config.transferHelperManifest != null };
  }
  /** Operator-requested system-image listing, install and removal; never called by reconciliation. */
  runtimeOperation(kind: string, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> { return runtimeOperation(this, kind, args, context); }
  storageDevices(): { id: string; runtime: string | null }[] { return storageDevices(this); }
  orphanEvidence(name: string): Promise<OrphanEvidence> { return androidOrphan(this, name); }
  strayDevices(): Promise<{ name: string; machineId: string; kind: "avd-registration" | "simulator" }[]> { return strayDevices(this); }
  purgeOrphan(name: string, requestId: string, hostId: string | undefined): Promise<{ assignmentFingerprint: string | undefined; removed: OrphanRemoval[] }> { return purgeOrphan(this, name, requestId, hostId); }
  async devices(): Promise<Record<string, string>> {
    const lines = (await this.runText([this.tool("adb"), "devices"])).split(/\r?\n/);
    const result: Record<string, string> = {};
    for (const line of lines.slice(1)) { const parts = line.trim().split(/\s+/); if (parts.length >= 2) result[parts[0]!] = parts[1]!; }
    return result;
  }
  async owned(machine: RecordValue, serial: string, options: Partial<RunOptions> = {}): Promise<void> {
    if ((await this.adb(serial, ["emu", "avd", "name"], options)).split(/\r?\n/)[0] !== this.name(machine)) throw new ServiceError("Android serial belongs to another AVD; refusing control.");
  }
  async endpoint(machine: RecordValue, storage: string, check: Authorized = () => true): Promise<string | undefined> {
    await authorized(check);
    const endpoint = readJson(path.join(storage, "endpoint.json"));
    if (!endpoint) return undefined;
    const port = integer(endpoint.port, "emulator console port", 5554, 5680);
    if (port % 2) throw new ServiceError("Invalid reserved Android console port.");
    const launch = readJson(path.join(storage, "launch.json")), owner = readJson(path.join(storage, "canaveral-owner.json"));
    // A fenced, stopped, lost or expired lease supervisor ends device access, whatever the host still believes.
    if (machine.lease != null) await this.leaseAccess(launch, storage);
    if (!launch || launch.version !== 2 || launch.machineId !== uuid(machine.id) || launch.fingerprint !== owner?.fingerprint || launch.leaseId !== (machine.lease ? object(machine.lease).id ?? null : null) || canonical(launch.argv) !== canonical(this.launchArguments(machine, port))) throw new ServiceError("Android launch binding is incomplete or contradictory; refusing device adoption.");
    const serial = "emulator-" + port;
    await authorized(check); const devices = await this.devices(); await authorized(check);
    const state = devices[serial];
    if (state) {
      if (state !== "device") throw new ServiceError("Reserved Android serial is offline or unauthorized; inspect it.");
      await this.owned(machine, serial); await authorized(check); return serial;
    }
    return undefined;
  }
  /** Ownership recheck for long-running device work. A leased emulator additionally needs its live
   * supervisor and current, unfenced authorization (endpoint), so a fence, expiry or supervisor
   * loss ends the work within one recheck rather than at the next reconcile. */
  async ownedLive(machine: RecordValue, image: RecordValue, serial: string, check: Authorized = () => true): Promise<void> {
    if (machine.lease == null) { await this.owned(machine, serial); return; }
    if (await this.endpoint(machine, this.storage(machine, image), check) !== serial) throw new ServiceError("Leased Android device access ended.", 410);
  }
  launchArguments(machine: RecordValue, port: number): string[] {
    const resources = object(machine.resources);
    return [this.tool("emulator"), "-avd", this.name(machine), "-port", String(port), "-cores", String(integer(resources.cpu, "cpu", 1, 1024)), "-memory", String(integer(resources.memoryMiB, "memory", 1, 2 ** 30)), "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim",
      ...(machine.lease != null ? LEASE_ISOLATION_ARGUMENTS : [])];
  }
  async maintenanceStorage(machine: RecordValue, image: RecordValue): Promise<"present" | "absent" | "unknown" | "notMaterialized"> {
    const storage = this.maintenanceDirectory(machine, image);
    if (!storage) return "absent";
    const receipt = path.join(storage, "avd-created.json"), avd = path.join(storage, "device.avd");
    noLinks(receipt); noLinks(avd);
    const owner = readJson(receipt);
    if (!owner) {
      const ini = path.join(this.environment().ANDROID_AVD_HOME!, this.name(machine) + ".ini");
      noLinks(ini);
      return present(ini) || [avd, ...["avd-create-started.json", "launch.json", "endpoint.json"].map(file => path.join(storage, file))].some(present)
        ? "unknown" : "notMaterialized";
    }
    if (owner.name !== this.name(machine) || owner.fingerprint !== digest(this.binding(machine, image))) return "unknown";
    if (!present(avd)) return "absent";
    const stat = fs.lstatSync(avd);
    return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()) ? "present" : "unknown";
  }
  async provision(machine: RecordValue, image: RecordValue, storage: string): Promise<string> {
    const avds = this.environment().ANDROID_AVD_HOME!, avd = path.join(storage, "device.avd"), receipt = path.join(storage, "avd-created.json");
    privateDirectory(avds);
    const saved = readJson(receipt), fingerprint = digest(this.binding(machine, image));
    if (!saved) {
      if (fs.existsSync(avd) || fs.existsSync(path.join(avds, this.name(machine) + ".ini")) || readJson(path.join(storage, "avd-create-started.json"))) throw new ServiceError("Partial or foreign AVD exists; inspect before provisioning again.");
      saveJson(path.join(storage, "avd-create-started.json"), { name: this.name(machine), fingerprint });
      const device = object(image.device);
      await this.run([this.tool("avdmanager"), "create", "avd", "--name", this.name(machine), "--package", text(device.systemImage, "system image"), "--device", text(device.profile, "profile"), "--path", avd], { input: Buffer.from("no\n"), timeoutMs: 120000 });
      if (fs.lstatSync(avd).isSymbolicLink() || fs.realpathSync(avd) !== avd) throw new ServiceError("AVD storage was replaced.");
      const configPath = path.join(avd, "config.ini"), config = readRegular(configPath, 1048576);
      const fd = fs.openSync(configPath, fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try { if (!fs.fstatSync(fd).isFile()) throw new ServiceError("AVD configuration must be regular."); fs.writeSync(fd, Buffer.concat([Buffer.from(config.length && config.at(-1) === 10 ? "" : "\n"), Buffer.from(`disk.dataPartition.size=${integer(object(machine.resources).diskGiB, "disk", 1, 2 ** 30)}G\n`)])); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      saveJson(receipt, { name: this.name(machine), fingerprint });
    } else if (saved.name !== this.name(machine) || saved.fingerprint !== fingerprint) throw new ServiceError("AVD creation receipt belongs to another assignment.");
    if (!fs.lstatSync(avd).isDirectory() || fs.lstatSync(avd).isSymbolicLink()) throw new ServiceError("Owned AVD data is missing; it was not recreated.");
    return avd;
  }
  async reconcile(machine: RecordValue, supplied: RecordValue, _folder: string): Promise<RecordValue> {
    this.executionAllowed(machine);
    // The host passes the lease authorization beside the pinned template; it is never part of the binding.
    const { _leaseAuthorization: lease, ...image } = supplied;
    const storage = this.storage(machine, image);
    return locked(path.join(storage, "assignment.lock"), async () => {
      if (machine.desired !== "running" && machine.desired !== "stopped") throw new ServiceError("Invalid desired mobile state.", 400);
      if (machine.desired === "stopped") await this.closeShells(machine);
      if (machine.lease != null) return this.reconcileLeased(machine, image, storage, typeof lease === "function" ? lease as () => LeaseAuthorization : undefined);
      const endpoint = await this.endpoint(machine, storage), launchPath = path.join(storage, "launch.json"), stopPath = path.join(storage, "stop.json");
      if (endpoint) {
        if (machine.desired === "stopped") {
          if (!readJson(stopPath)?.acknowledged) { saveJson(stopPath, { requested: true }); await this.adb(endpoint, ["emu", "kill"]); saveJson(stopPath, { requested: true, acknowledged: true }); }
          return { state: "stopping" };
        }
        return { state: await this.adb(endpoint, ["shell", "getprop", "sys.boot_completed"]) === "1" ? "running" : "starting" };
      }
      const stop = readJson(stopPath);
      if (stop) {
        if (stop.acknowledged !== true) return { state: "unknown", detail: "Shutdown was not acknowledged; inspect its process and receipts." };
        if (!await this.processStopped(machine, storage)) return { state: "stopping", detail: "Waiting for the owned emulator process to exit." };
        for (const file of [launchPath, stopPath, path.join(storage, "endpoint.json")]) fs.rmSync(file, { force: true });
        this.processes.delete(uuid(machine.id));
        if (machine.desired === "stopped") return { state: "stopped" };
      }
      const launch = readJson(launchPath);
      if (launch) return { state: typeof launch.startedAt === "number" && this.now() - launch.startedAt < 120 ? "starting" : "unknown", detail: "Existing launch intent prevents relaunch; inspect launch.json and emulator.log." };
      // An endpoint without a launch is an incomplete attempt, never a free port.
      if (readJson(path.join(storage, "endpoint.json"))) return { state: "unknown", detail: "Reserved endpoint has no launch receipt; inspect before recovery." };
      if (machine.desired === "stopped") return { state: "stopped" };
      if (!this.transport?.spawn || !this.transport.portPairAvailable) unsupported("Native emulator launch and port-reservation adapters are not configured.");
      await this.provision(machine, image, storage);
      return this.withPort(storage, async port => {
        const argv = this.launchArguments(machine, port), identity = { version: 2, bootId: randomUUID(), machineId: uuid(machine.id), leaseId: machine.lease ? object(machine.lease).id ?? null : null, fingerprint: digest(this.binding(machine, image)), argv, startedAt: this.now() };
        saveJson(launchPath, identity);
        const child = await this.transport!.spawn!(argv, { env: this.environment(), timeoutMs: 120000, maxBytes: 0, log: path.join(storage, "emulator.log") });
        // Retain child before final receipt publication; a write failure cannot authorize a relaunch.
        this.processes.set(uuid(machine.id), child);
        saveJson(launchPath, { ...identity, pid: integer(child.pid, "emulator pid", 1, 2 ** 31 - 1), ...(typeof child.processStartedAt === "number" && Number.isFinite(child.processStartedAt) ? { processStartedAt: child.processStartedAt } : {}) });
        return { state: "starting" };
      });
    });
  }
  /** Reserves one console/ADB port pair under the shared storage lock, then launches. */
  private async withPort(storage: string, launch: (port: number) => Promise<RecordValue>): Promise<RecordValue> {
    const root = text(this.config.storage, "storage");
    return locked(path.join(root, "ports.lock"), async () => {
      const devices = await this.devices(), reserved = new Set<number>();
      for (const child of fs.readdirSync(root)) {
        if (!/^[0-9a-f-]{36}$/.test(child)) continue;
        const entry = path.join(root, child);
        if (!fs.lstatSync(entry).isDirectory() || fs.lstatSync(entry).isSymbolicLink()) throw new ServiceError("Foreign entry in Android storage.");
        const saved = readJson(path.join(entry, "endpoint.json"));
        if (saved) reserved.add(integer(saved.port, "reserved port", 5554, 5680));
      }
      let port: number | undefined;
      for (let candidate = 5554; candidate < 5682; candidate += 2) if (!reserved.has(candidate) && !("emulator-" + candidate in devices) && await this.transport!.portPairAvailable!(candidate)) { port = candidate; break; }
      if (port === undefined) throw new ServiceError("No free Android console/ADB port pair.");
      saveJson(path.join(storage, "endpoint.json"), { port });
      return launch(port);
    });
  }

  // Leased emulators. The native lease supervisor owns the emulator's process group and
  // enforces the published boot-bound deadline even when this runner or the controller
  // is lost. Its stopped receipt, or positively absent processes, is the only stop proof.
  // Supervisor liveness is the kernel-held lifetime lock on its storage, never a PID.
  readonly supervisors = new Map<string, SupervisedChild>();
  private leaseHelper(): string {
    const helper = this.config.leaseSupervisor;
    if (typeof helper !== "string" || !path.isAbsolute(helper) || !this.transport?.leases) unsupported("Leased Android execution requires the configured native lease supervisor.");
    return helper;
  }
  override executionAllowed(machine: RecordValue): void { if (machine.lease != null) this.leaseHelper(); }
  private leaseStorage(machine: RecordValue): string { return path.join(text(this.config.storage, "storage"), uuid(machine.id)); }
  private leaseIdentity(machine: RecordValue): { machineId: string; leaseId: string } {
    return { machineId: uuid(machine.id), leaseId: uuid(object(machine.lease).id) };
  }
  private supervisorStatus(storage: string): Promise<LeaseSupervisorStatus> { return this.transport!.leases!.status(this.leaseHelper(), storage); }
  /** Device access needs a live supervisor and a current, unfenced authorization on this boot's clock. */
  private async leaseAccess(launch: RecordValue | undefined, storage: string): Promise<void> {
    return requireLeaseAccess(this.transport!.leases!, this.leaseHelper(), launch, storage, "Android");
  }
  /** Positive stop proof only: a matching stopped receipt, a launch proven never to have
   * spawned, or a gone supervisor with its emulator and process group positively absent.
   * Anything else stays unknown. */
  async leaseStopped(machine: RecordValue, storage: string): Promise<boolean> {
    const { machineId, leaseId } = this.leaseIdentity(machine), leases = this.transport?.leases;
    const launchPath = path.join(storage, "launch.json"), launch = readJson(launchPath), record = readJson(path.join(storage, "lease-supervisor.json"));
    if (!launch) return !record;
    if (launch.supervised !== true || launch.machineId !== machineId || launch.leaseId !== leaseId) throw new ServiceError("Leased launch identity is contradictory; inspect it.", 409);
    if (!leases) return false;
    if (!record && (launch.supervisorExit === SUPERVISOR_REFUSED || launch.nothingRunning === true)) return true;
    if ((await this.supervisorStatus(storage)).supervisor === "held") return false;
    if (!record) {
      // Launch intent without a supervisor record: the runner crashed around the launch, or the
      // supervisor failed without its refusal status. Only a process inventory with neither this
      // storage's supervisor nor this AVD's emulator proves that nothing of the launch runs.
      const avd = `-avd ${this.name(machine)}`, supervisor = `lease-supervise ${storage}`;
      if ((await leases.commandLines()).some(line => line.includes(avd) || line.includes(supervisor))) return false;
      saveJson(launchPath, { ...launch, nothingRunning: true });
      return true;
    }
    const pid = record.childPid, supervisor = record.supervisorPid;
    if (record.machineId !== machineId || record.leaseId !== leaseId || record.bootId !== launch.bootId || !Number.isSafeInteger(pid) || !Number.isSafeInteger(supervisor) ||
      launch.supervisorPid !== undefined && launch.supervisorPid !== supervisor) throw new ServiceError("Lease supervisor record belongs to another launch.", 409);
    const stopped = readJson(path.join(storage, "lease-stopped.json"));
    if (stopped && stopped.machineId === machineId && stopped.leaseId === leaseId && stopped.bootId === launch.bootId && stopped.childPid === pid && stopped.supervisorPid === supervisor && stopped.groupAbsent === true) return true;
    return await this.transport?.processAbsent?.(pid as number) === true && await leases.groupAbsent(pid as number);
  }
  /** Publishes the host's current lease authorization as an absolute native deadline. */
  async publishLease(machine: RecordValue, storage: string, authorization: () => LeaseAuthorization, stopping: boolean): Promise<RecordValue> {
    return publishLeaseAuthorization(this.transport!.leases!, this.leaseHelper(), storage, this.leaseIdentity(machine), authorization, stopping);
  }
  /** Fences an existing authorization without needing the host's lease clock. */
  private fenceLease(storage: string): void { fenceLeaseAuthorization(storage); }
  private async reconcileLeased(machine: RecordValue, image: RecordValue, storage: string, authorization: (() => LeaseAuthorization) | undefined): Promise<RecordValue> {
    const launchPath = path.join(storage, "launch.json"), launch = readJson(launchPath), stopping = machine.desired === "stopped";
    if (!launch) {
      if (readJson(path.join(storage, "lease-supervisor.json"))) return { state: "unknown", detail: "Lease supervisor record has no launch intent; inspect before recovery." };
      if (readJson(path.join(storage, "endpoint.json"))) return { state: "unknown", detail: "Reserved endpoint has no launch receipt; inspect before recovery." };
      if (stopping) return { state: "stopped", leaseFenced: true };
      if (!authorization) unsupported("Leased Android launch requires the host's lease authorization.");
      const allowed = authorization();
      if (allowed.fenced || allowed.remainingSeconds <= 1) throw new ServiceError("Lease authorization ended before launch.", 410);
      if (!this.transport?.portPairAvailable) unsupported("Native emulator port reservation is not configured.");
      const helper = this.leaseHelper();
      await this.provision(machine, image, storage);
      return this.withPort(storage, async port => {
        const argv = this.launchArguments(machine, port), { machineId, leaseId } = this.leaseIdentity(machine);
        const identity = { version: 2, bootId: randomUUID(), machineId, leaseId, fingerprint: digest(this.binding(machine, image)), argv, startedAt: this.now(), supervised: true };
        saveJson(launchPath, identity);
        await this.publishLease(machine, storage, authorization, false);
        let child: SupervisedChild;
        try { child = await this.transport!.leases!.supervise(helper, storage, { version: 1, machineId, leaseId, bootId: identity.bootId, executable: argv[0], args: argv.slice(1), env: this.environment(), cwd: storage }); }
        catch (error) {
          // Only the supervisor's dedicated refusal status proves nothing was spawned. Any other
          // failure is recovered later from the lifetime lock and a process inventory.
          const exit = error instanceof SupervisorLaunchError ? error.supervisorExit : undefined;
          if (exit === SUPERVISOR_REFUSED && !readJson(path.join(storage, "lease-supervisor.json"))) saveJson(launchPath, { ...identity, supervisorExit: exit });
          throw error;
        }
        this.supervisors.set(machineId, child);
        saveJson(launchPath, { ...identity, pid: integer(child.pid, "emulator pid", 2, 2 ** 31 - 1), supervisorPid: integer(child.supervisorPid, "supervisor pid", 2, 2 ** 31 - 1) });
        return { state: "starting", accessReady: false, detail: "Leased emulator launched under its native deadline supervisor." };
      });
    }
    if (await this.leaseStopped(machine, storage)) {
      this.supervisors.delete(uuid(machine.id));
      return stopping ? { state: "stopped", leaseFenced: true } : { state: "error", detail: "The leased emulator stopped; a lease is never relaunched." };
    }
    if ((await this.supervisorStatus(storage)).supervisor !== "held") {
      // Gone without a stop receipt (killed, crashed or never recorded): nothing enforces the
      // deadline any more. Fence access now and fail the lease; cleanup waits for stop proof.
      this.fenceLease(storage);
      const detail = "The lease supervisor is gone without a stop receipt. Device access is fenced; cleanup waits until the emulator's process group is proven absent.";
      return stopping ? { state: "stopping", leaseFenced: true, detail } : { state: "error", leaseFenced: true, detail };
    }
    if (stopping) {
      if (authorization) await this.publishLease(machine, storage, authorization, true); else this.fenceLease(storage);
      return { state: "stopping", leaseFenced: true, detail: "Lease fenced; the native supervisor's process-group exit proof is pending." };
    }
    if (!authorization) unsupported("Leased Android execution requires the host's lease authorization.");
    // The fence worker republishes on every revision change; reconciliation only fills a gap.
    const allowed = authorization(), previous = readJson(path.join(storage, "lease-authorization.json"));
    if (!previous || previous.revision !== allowed.revision || allowed.fenced && previous.fenced !== true) await this.publishLease(machine, storage, () => allowed, false);
    return this.leasedReadiness(machine, storage, launch);
  }
  /** Ready means booted, owned, serving package management and network-isolated from the host. */
  private async leasedReadiness(machine: RecordValue, storage: string, launch: RecordValue): Promise<RecordValue> {
    const waiting = (detail: string): RecordValue => ({ state: "starting", accessReady: false, detail });
    let serial: string | undefined;
    try { serial = await this.endpoint(machine, storage); } catch (error) { if (error instanceof ServiceError && error.status === 410) throw error; return waiting("Waiting for the owned emulator serial."); }
    if (!serial) return waiting("Waiting for the owned emulator to connect.");
    try {
      if (await this.adb(serial, ["shell", "getprop", "sys.boot_completed"]) !== "1") return waiting("Waiting for Android to finish booting.");
      if (!(await this.adb(serial, ["shell", "pm", "path", "android"])).startsWith("package:")) return waiting("Waiting for the package manager.");
      // A debuggable (userdebug or eng) guest can get root and act as adbd toward the shared host adb
      // server without using the network; leased images must be user builds.
      if (await this.adb(serial, ["shell", "getprop", "ro.debuggable"]) !== "0") {
        this.fenceLease(storage);
        return { state: "error", leaseFenced: true, detail: "Leased Android images must be user builds (ro.debuggable=0); the lease was fenced before use." };
      }
    } catch { return waiting("Waiting for the booted emulator to answer readiness checks."); }
    const receipt = path.join(storage, "lease-isolation.json");
    if (readJson(receipt)?.bootId !== launch.bootId) {
      const port = integer(readJson(path.join(storage, "endpoint.json"))?.port, "emulator console port", 5554, 5680);
      let probe: { outcome: "isolated" | "reachable" | "inconclusive"; ports: number[] };
      try { probe = await this.isolationProbe(serial, port); } catch { return waiting("Waiting for the guest network isolation check."); }
      if (probe.outcome === "reachable") {
        // Fail closed: a guest that reaches the host is never handed to a lease holder.
        this.fenceLease(storage);
        return { state: "error", leaseFenced: true, detail: "The leased guest reached a host loopback service; the lease was fenced before use." };
      }
      if (probe.outcome !== "isolated") return waiting("Waiting for a conclusive guest network isolation check.");
      saveJson(receipt, { version: 1, bootId: launch.bootId, target: GUEST_HOST_ALIAS, ports: probe.ports, isolated: true });
    }
    return { state: "running", accessReady: true };
  }
  /** Ports the guest must not reach on the host: the default adb server, this emulator's
   * console and adb ports, the controller, operator-declared services and a fresh canary. */
  isolationPorts(consolePort: number): number[] {
    const configured = Array.isArray(this.config.leaseIsolationPorts) ? this.config.leaseIsolationPorts : [];
    const ports = [5037, consolePort, consolePort + 1, ...(this.config.leaseControllerPort === undefined ? [] : [this.config.leaseControllerPort]), ...configured];
    return [...new Set(ports.map(port => integer(port, "isolation probe port", 1, 65535)))];
  }
  /** Negative guest-to-host probe from the lease's own shell. Isolated only when every port is
   * refused with a recognized error and the host-side canary saw no connection. */
  private async isolationProbe(serial: string, consolePort: number): Promise<{ outcome: "isolated" | "reachable" | "inconclusive"; ports: number[] }> {
    let connections = 0;
    const canary = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => { canary.once("error", reject); canary.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const address = canary.address();
      if (!address || typeof address === "string") throw new ServiceError("Isolation canary has no port.");
      const ports = [...this.isolationPorts(consolePort), address.port];
      const script = `command -v nc >/dev/null 2>&1 || { echo canaveral-isolation-unavailable; exit 0; }; for p in ${ports.join(" ")}; do r=$( (echo | timeout 3 nc ${GUEST_HOST_ALIAS} $p >/dev/null) 2>&1 ); echo "canaveral-isolation $p $? $r"; done; echo canaveral-isolation-done`;
      const output = await this.adb(serial, ["shell", script], { timeoutMs: 10000 + 4000 * ports.length });
      await new Promise(resolve => setImmediate(resolve));
      const lines = output.split(/\r?\n/), results = new Map<number, string>();
      for (const line of lines) { const match = /^canaveral-isolation (\d+) (\d+) ?(.*)$/.exec(line.trim()); if (match) results.set(Number(match[1]), match[2] + " " + match[3]); }
      const reached = [...results.values()].some(result => result.startsWith("0 "));
      if (connections || reached) return { outcome: "reachable", ports };
      const refused = (result: string | undefined) => !!result && /^1 .*(refused|unreachable|no route|timed out)/i.test(result);
      return { outcome: lines.some(line => line.trim() === "canaveral-isolation-done") && ports.every(port => refused(results.get(port))) ? "isolated" : "inconclusive", ports };
    } finally { await new Promise<void>(resolve => canary.close(() => resolve())); }
  }
  /** Independent deadline publication, called by the host's fence worker. Never launches. */
  async refreshExecution(machine: RecordValue, _image: RecordValue, _folder: string, authorization: () => LeaseAuthorization): Promise<RecordValue | null> {
    this.executionAllowed(machine);
    const storage = this.leaseStorage(machine), launch = readJson(path.join(storage, "launch.json"));
    if (!launch || launch.supervised !== true) return null;
    // A launch whose supervisor has not written its record yet is still starting (or the runner crashed
    // around it); its recovery belongs to cleanup, never to this fence poll, which could race the launch.
    if (!readJson(path.join(storage, "lease-supervisor.json")) && launch.supervisorExit === undefined && launch.nothingRunning !== true) return null;
    if (await this.leaseStopped(machine, storage)) return { state: "stopped", leaseFenced: true };
    const allowed = authorization(), previous = readJson(path.join(storage, "lease-authorization.json")), stopping = machine.desired === "stopped" || allowed.fenced;
    if (!previous || previous.revision !== allowed.revision || stopping && previous.fenced !== true) await this.publishLease(machine, storage, () => allowed, stopping);
    return stopping ? { state: "stopping", leaseFenced: true, detail: "Lease fenced; the native supervisor's process-group exit proof is pending." } : null;
  }
  /** Storage marker check for lease cleanup; the marker binds the full pinned assignment. */
  ownsStorage(machine: RecordValue, image: RecordValue, storage: string): boolean {
    const owner = readJson(path.join(storage, "canaveral-owner.json")), binding = this.binding(machine, image);
    return !!owner && owner.fingerprint === digest(binding) && canonical(owner.binding) === canonical(binding);
  }
  /** Cleanup stop: fence the supervisor and report stopped only on positive proof. */
  async stopForCleanup(machine: RecordValue, _image: RecordValue, _folder: string): Promise<RecordValue> {
    this.executionAllowed(machine);
    const storage = this.leaseStorage(machine);
    if (!fs.existsSync(storage)) return { state: "stopped" };
    await this.closeShells(machine);
    if (await this.leaseStopped(machine, storage)) { this.supervisors.delete(uuid(machine.id)); return { state: "stopped" }; }
    this.fenceLease(storage);
    return { state: "stopping" };
  }
  async removeOwnedStorage(machine: RecordValue, image: RecordValue, folder: string, requestId: string): Promise<RecordValue> {
    const id = uuid(machine.id), request = uuid(requestId), fingerprint = this.deletionFingerprint(machine, image);
    const assignment = readJson(path.join(folder, "assignment.json")), lease = machine.lease == null ? null : object(machine.lease);
    // A leased assignment is removed only for its own terminal lease, after the supervisor proves the stop.
    if (machine.desired !== "stopped" || assignment?.fingerprint !== assignmentFingerprint(machine) || (assignment.leaseId ?? null) !== (lease ? uuid(lease.id) : null) ||
      lease && !["released", "expired", "failed"].includes(String(lease.state))) {
      throw new ServiceError("Android removal requires a matching stopped assignment.");
    }
    const root = text(this.config.storage, "storage"), storage = path.join(root, id);
    const quarantine = path.join(root, `.removing-${id}-${request}`);
    const avds = this.environment().ANDROID_AVD_HOME!, ini = path.join(avds, this.name(machine) + ".ini");
    const receipt = path.join(folder, "deletion.json");
    const identity = (file: string): string | null => {
      const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      return stat ? stat.dev + "/" + stat.ino : null;
    };
    privateDirectory(root);
    privateDirectory(avds);
    let journal = readJson(receipt);
    if (!journal) {
      if (identity(quarantine)) throw new ServiceError("Android removal quarantine is already occupied.");
      if (lease) { this.executionAllowed(machine); if (!await this.leaseStopped(machine, storage)) throw new ServiceError("Leased emulator stop is unconfirmed.", 409, { code: "execution_pending" }); }
      else if ((await this.reconcile(machine, image, folder)).state !== "stopped") throw new ServiceError("Android emulator stop is unconfirmed.");
      const name = this.name(machine), created = readJson(path.join(storage, "avd-created.json"));
      const started = readJson(path.join(storage, "avd-create-started.json"));
      const avd = path.join(storage, "device.avd");
      if (created || started || identity(avd) || identity(ini)) {
        if (created?.name !== name || created.fingerprint !== fingerprint || started?.name !== name || started.fingerprint !== fingerprint ||
          fs.realpathSync(avd) !== avd || !fs.lstatSync(avd).isDirectory()) throw new ServiceError("Android AVD creation ownership is unconfirmed.");
        const paths = readRegular(ini, 65536).toString("utf8").split(/\r?\n/).filter(line => line.startsWith("path="));
        if (paths.length !== 1 || paths[0] !== "path=" + avd) throw new ServiceError("Android AVD registration points outside the assignment.");
      }
      journal = { id: request, machineId: id, fingerprint, storageIdentity: identity(storage), iniIdentity: identity(ini), state: "removing" };
      saveJson(receipt, journal);
    }
    if (journal.id !== request || journal.machineId !== id || journal.fingerprint !== fingerprint || !["removing", "complete"].includes(String(journal.state)) ||
      typeof journal.storageIdentity !== "string") throw new ServiceError("Android deletion receipt belongs to another assignment or request.");
    const remaining = identity(storage), staged = identity(quarantine), registration = identity(ini);
    if ((remaining && (remaining !== journal.storageIdentity || staged)) || (staged && staged !== journal.storageIdentity) ||
      (registration && registration !== journal.iniIdentity) || (journal.state === "complete" && (remaining || staged || registration))) {
      throw new ServiceError("Android storage or registration changed during removal.");
    }
    if (remaining) fs.renameSync(storage, quarantine);
    if (registration) fs.unlinkSync(ini);
    if (identity(quarantine)) fs.rmSync(quarantine, { recursive: true });
    if (identity(storage) || identity(quarantine) || identity(ini)) throw new ServiceError("Android removal remains incomplete.");
    for (const dir of [avds, root]) {
      const fd = fs.openSync(dir, fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (journal.state !== "complete") saveJson(receipt, { ...journal, state: "complete" });
    return { id: request, machineId: id, state: "complete" };
  }
  async processStopped(machine: RecordValue, storage: string): Promise<boolean> {
    const child = this.processes.get(uuid(machine.id));
    if (child) return child.stopped();
    const pid = readJson(path.join(storage, "launch.json"))?.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !this.transport?.processAbsent) return false;
    return await this.transport.processAbsent(pid as number) === true;
  }
  /** The caller journals this attempt before dispatch. Sources are private verified
   * uploads, never consumer-selected host paths. Only a verified APK is committed. */
  async installArtifact(machine: RecordValue, image: RecordValue, _folder: string, source: Download, sha256: string, check: Authorized = () => true): Promise<RecordValue> {
    let session: string | undefined, serial: string | undefined, pipe: NativePipe | undefined, commitAttempted = false, createAttempted = false;
    const recheck = async () => {
      await authorized(check);
      if (serial) { await this.ownedLive(machine, image, serial, check); await authorized(check); }
    };
    try {
      this.executionAllowed(machine);
      await authorized(check);
      const size = integer(source.size, "APK size", 1, 2 * 1024 ** 3);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ServiceError("Expected a SHA-256 APK digest.", 400);
      if (!this.transport?.pipe) unsupported("Streaming APK installation requires a native pipe transport.");
      if (machine.desired !== "running") throw new ServiceError("Android device is stopping or stopped.", 409);
      if (await source.verify() !== true) throw new ServiceError("Uploaded APK identity could not be verified.", 409);
      await authorized(check);
      serial = await this.endpoint(machine, this.storage(machine, image), check);
      if (!serial || await this.adb(serial, ["shell", "getprop", "sys.boot_completed"]) !== "1") throw new ServiceError("Android device is not ready.");
      await recheck();
      // From here a package session may exist on the device, so failures stay uncertain.
      createAttempted = true;
      const created = await this.adb(serial, ["shell", "pm", "install-create", "-r", "-S", String(size)]);
      const identity = /^Success: created install session \[([0-9]+)\]$/.exec(created);
      if (!identity || !Number.isSafeInteger(Number(identity[1])) || Number(identity[1]) > 2147483647) throw new ServiceError("Android install session creation is unconfirmed; inspect before retrying.", 409, { outcome: "unknown" });
      session = identity[1]!;
      await recheck();
      pipe = await this.pipe([this.tool("adb"), "-s", serial, "shell", "-T", "pm", "install-write", "-S", String(size), session, "base.apk", "-"]);
      const connection = pipe, digest = createHash("sha256"), output: Buffer[] = [];
      let length = 0;
      const receive = (async () => {
        for (;;) {
          await authorized(check);
          const bytes = Buffer.from(await connection.read(Math.min(4097 - length, 4096), 30000));
          await authorized(check);
          if (!bytes.length) return;
          length += bytes.length;
          if (length > 4096) throw new ServiceError("Android install response exceeds its bounded envelope.", 413);
          output.push(bytes);
        }
      })();
      const send = (async () => {
        await copyUpload({ read: async count => {
          const bytes = await source.read(count); digest.update(bytes); return bytes;
        } }, bytes => writeAll(connection, bytes, check), size, check);
        await connection.end();
      })();
      // A failed branch closes its retained process so the other branch cannot hang.
      const branches = [send, receive].map(branch => branch.catch(async error => { await connection.close(); throw error; }));
      const outcomes = await Promise.allSettled(branches);
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      if (await connection.wait(30000) !== 0 || Buffer.concat(output).toString("utf8").trim() !== `Success: streamed ${size} bytes`) throw new ServiceError("Android APK staging is unconfirmed.", 409, { outcome: "unknown" });
      await connection.close(); pipe = undefined;
      await recheck();
      if (digest.digest("hex") !== sha256 || await source.verify() !== true) throw new ServiceError("Uploaded APK digest or source identity changed; installation was not committed.", 409);
      await recheck();
      commitAttempted = true;
      if (await this.adb(serial, ["shell", "pm", "install-commit", session]) !== "Success") throw new ServiceError("Android installation commit is unconfirmed; inspect before retrying.", 409, { outcome: "unknown" });
      await recheck();
      return { installed: true, sha256, bytes: size, artifactCleaned: true };
    } catch (error) {
      // Before install-create nothing reached the device; the upload has no device-side stage.
      throw createAttempted ? error : markNotStaged(error);
    } finally {
      try {
        if (pipe) await pipe.close();
        if (session && serial && !commitAttempted) {
          // Never abandon after an uncertain commit or after authorization ends.
          try { await recheck(); await this.adb(serial, ["shell", "pm", "install-abandon", session]); } catch { /* Owned session cleanup needs operator inspection. */ }
        }
      } finally { await source.close(); }
    }
  }
  displayEpoch(machine: RecordValue, image: RecordValue): RecordValue | undefined {
    const launch = readJson(path.join(this.storage(machine, image), "launch.json"));
    if (!launch || launch.version !== 2 || launch.fingerprint !== digest(this.binding(machine, image))) return undefined;
    return { startedAt: launch.startedAt, identity: digest(launch) };
  }
  /** cleanupCheck is the assignment authority under which an early-cancelled recorder may be stopped. */
  openVideo(machine: RecordValue, image: RecordValue, folder: string, options: AndroidVideoOptions, check: Authorized, cleanupCheck?: Authorized): Promise<NativePipe> {
    return openAndroidVideo(this, machine, image, folder, options, check, cleanupCheck);
  }
  override async control(machine: RecordValue, image: RecordValue, folder: string, input: DeviceRequest): Promise<RecordValue> {
    this.executionAllowed(machine);
    const request = operationRequest(input), args = request.arguments, action = request.action;
    if (action === "accessibility" || action === "accessibility-action") return this.mobileAccessibility(machine, image, folder, request);
    const storage = this.storage(machine, image), serial = await this.endpoint(machine, storage);
    if (!serial || await this.adb(serial, ["shell", "getprop", "sys.boot_completed"]) !== "1") throw new ServiceError("Android device is not ready.");
    if (action.startsWith("shell-")) return this.shellControl(machine, request, [this.tool("adb"), "-s", serial, "shell", "-tt"]);
    if (action === "list-files") {
      const directory = text(args.path, "guest directory");
      if ("app" in args || !directory.startsWith("/")) throw new ServiceError("Android browsing requires an absolute path without app.", 400);
      const script = `cd ${quote(directory)} || exit; for entry in ./* ./.[!.]* ./..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; if [ -d "$entry" ]; then kind=directory; else kind=file; fi; printf '%s\\000%s\\000' "$kind" "\${entry##*/}"; done`;
      const raw = await this.adbBytes(serial, ["exec-out", "sh", "-c", script]), parts = raw.toString("utf8").split("\0");
      if (raw.length && (raw.at(-1) !== 0 || parts.length % 2 !== 1 || parts.slice(0, -1).some((p, i) => i % 2 === 0 && !["file", "directory"].includes(p)))) throw new ServiceError("Directory could not be listed.");
      const entries = []; for (let i = 0; i < parts.length - 1 && entries.length < 2000; i += 2) entries.push({ kind: parts[i], name: parts[i + 1] });
      return { entries, truncated: parts.length > 4001 };
    }
    if (action === "screenshot") return encoded(await this.adbBytes(serial, ["exec-out", "screencap", "-p"]), "image/png");
    if (action === "hierarchy") {
      const temporary = "/data/local/tmp/canaveral-" + request.id + ".xml";
      await this.adb(serial, ["shell", "uiautomator", "dump", temporary]);
      try { return { output: await this.adb(serial, ["shell", "cat", temporary]) }; } finally { await this.owned(machine, serial); await this.adb(serial, ["shell", "rm", "-f", temporary]); }
    }
    if (action === "push" || action === "pull") {
      const destination = guestPath(args.path, args.app);
      if (action === "pull") return encoded(await this.adbBytes(serial, ["exec-out", "sh", "-c", "cat -- " + quote(destination)]));
      privateDirectory(folder);
      const temporary = path.join(folder, "transfer-" + randomUUID());
      fs.writeFileSync(temporary, decodeData(args.data), { flag: "wx", mode: 0o600 });
      try { return { output: await this.adb(serial, ["push", temporary, destination]) }; } finally { fs.unlinkSync(temporary); }
    }
    let argv: string[];
    if (action === "install") argv = ["install", "-r", this.artifact(args.artifact)];
    else if (action === "uninstall") argv = ["uninstall", String(args.app)];
    else if (action === "apps") argv = ["shell", "pm", "list", "packages"];
    else if (action === "launch") argv = ["shell", "am", "start", "-n", String(args.app)];
    else if (action === "terminate") argv = ["shell", "am", "force-stop", String(args.app)];
    else if (action === "open-url") argv = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", String(args.url)];
    else if (action === "tap" || action === "swipe") argv = ["shell", "input", action, ...(action === "tap" ? ["x", "y"] : ["x", "y", "toX", "toY", "durationMs"]).map(k => String(args[k]))];
    else if (action === "text") {
      const value = args.text as string;
      if (/[^\x00-\x7f]|[\r\n]/.test(value)) throw new ServiceError("Android input supports single-line ASCII.", 400);
      const commands: string[] = [];
      value.split("%s").forEach((chunk, i) => { if (i) commands.push("input text %", "input text s"); if (chunk) commands.push("input text " + quote(chunk.replaceAll(" ", "%s"))); });
      return { output: commands.length ? await this.adb(serial, ["shell", commands.join(" && ")]) : "" };
    } else if (action === "key") argv = ["shell", "input", "keyevent", String(args.key)];
    else if (action === "location") argv = ["emu", "geo", "fix", String(args.longitude), String(args.latitude)];
    else if (action === "logs") argv = ["logcat", "-d", "-t", "200"];
    else if (action === "shell") argv = ["shell", ...args.argv as string[]];
    else if (action === "permission") { if (args.state === "reset") throw new ServiceError("Android permissions support grant/revoke only.", 400); argv = ["shell", "pm", String(args.state), String(args.app), String(args.permission)]; }
    else if (action === "rotate") argv = ["shell", "wm", "user-rotation", "lock", String({ PORTRAIT: 0, LANDSCAPE_LEFT: 1, PORTRAIT_UPSIDE_DOWN: 2, LANDSCAPE_RIGHT: 3 }[args.orientation as "PORTRAIT"])];
    else return unsupported("Native accessibility inspection requires the shared revalidation handler.");
    if (argv[0] === "shell") argv = ["shell", argv.slice(1).map(quote).join(" ")];
    return { output: await this.adb(serial, argv) };
  }
  requireDurableUpload(image: RecordValue): void {
    if (this.config.transferHelperManifest == null) unsupported("Android durable uploads require a configured native transfer helper.");
    loadHelper(this.config, image);
  }
  async streamUpload(machine: RecordValue, image: RecordValue, folder: string, destination: string, app: string | null | undefined, reader: ByteReader, size: number, check: Authorized): Promise<RecordValue> {
    this.executionAllowed(machine);
    guestPath(destination, app); integer(size, "transfer length", 0, Number.MAX_SAFE_INTEGER); await authorized(check);
    if (!this.transport?.pipe) unsupported("Android transfer pipe adapter is not configured.");
    // Consumer callers must use requireDurableUpload before accepting any bytes.
    if (this.config.transferHelperManifest == null) return this.legacyUpload(machine, image, destination, reader, size, check);
    const helper = loadHelper(this.config, image); await authorized(check);
    const storage = this.storage(machine, image), serial = await this.endpoint(machine, storage, check);
    if (!serial) throw new ServiceError("Android device is not connected.");
    const recheck = async () => { await authorized(check); this.storage(machine, image); await this.owned(machine, serial); await authorized(check); };
    await recheck();
    const id = randomUUID(), directory = "/data/local/tmp/.canaveral-transfer-" + id, installed = directory + "/helper";
    privateDirectory(folder);
    const temporary = path.join(folder, "android-helper-" + id);
    fs.writeFileSync(temporary, helper.data, { flag: "wx", mode: 0o600 });
    let directoryOwned = false, pipe: NativePipe | undefined, commitAttempted = false;
    try {
      await recheck();
      if (await this.adb(serial, ["shell", `umask 077; mkdir -m 700 -- ${quote(directory)} && printf '%s' ${quote("CREATED " + id)}`]) !== "CREATED " + id) throw new ServiceError("Helper directory creation was not confirmed.");
      directoryOwned = true;
      await recheck(); await this.adb(serial, ["push", temporary, installed]);
      await recheck();
      if ((await this.adb(serial, ["shell", `chmod 500 ${quote(installed)} && sha256sum -- ${quote(installed)}`])).split(/\s+/).join(" ") !== helper.sha256 + " " + installed) throw new ServiceError("Installed helper identity was not confirmed.");
      await recheck();
      pipe = await this.pipe([this.tool("adb"), "-s", serial, "shell", "-T", `exec ${quote(installed)} upload ${quote(destination)} ${size} ${id}`]);
      await copyUpload(reader, bytes => writeAll(pipe!, bytes, check), size, check);
      if (!(await receiptLine(pipe, check)).equals(Buffer.from(`CANAVERAL_TRANSFER_V1 STAGED ${id} ${size}\n`))) throw new ServiceError("Staged upload receipt did not match.");
      await recheck();
      commitAttempted = true;
      await writeAll(pipe, Buffer.from(`COMMIT ${id}\n`), check); await pipe.end();
      if (!(await receiptLine(pipe, check)).equals(Buffer.from(`CANAVERAL_TRANSFER_V1 COMMITTED ${id} ${size}\n`))) throw new ServiceError("Committed upload receipt did not match.");
      if (await pipe.wait(30000) !== 0 || (await pipe.read(1, 30000)).length) throw new ServiceError("Helper completion was not confirmed.");
      await recheck();
    } catch (error) { if (commitAttempted) throw publicationUncertain(); throw error; }
    finally {
      if (pipe) await pipe.close().catch(() => {});
      fs.unlinkSync(temporary);
      if (directoryOwned) try { await recheck(); await this.adb(serial, ["shell", `rm -f -- ${quote(installed)}; rmdir -- ${quote(directory)}`]); } catch { /* No guest cleanup after authorization ends; no recursive removal. */ }
    }
    try { await recheck(); } catch { throw publicationUncertain(); }
    return { uploaded: size, durable: true };
  }
  private async legacyUpload(machine: RecordValue, image: RecordValue, destination: string, reader: ByteReader, size: number, check: Authorized): Promise<RecordValue> {
    const serial = await this.endpoint(machine, this.storage(machine, image), check);
    if (!serial) throw new ServiceError("Android device is not connected.");
    const recheck = async () => { await authorized(check); this.storage(machine, image); await this.owned(machine, serial); await authorized(check); };
    await recheck();
    const temporary = path.posix.join(path.posix.dirname(destination), ".canaveral-upload-" + randomUUID());
    const pipe = await this.pipe([this.tool("adb"), "-s", serial, "shell", "-T", "umask 077; set -C; cat > " + quote(temporary)]);
    let commitAttempted = false;
    try {
      await copyUpload(reader, bytes => writeAll(pipe, bytes, check), size, check); await pipe.end();
      if (await pipe.wait(30000) !== 0) throw new ServiceError("Guest drive could not accept the upload.");
      await recheck(); commitAttempted = true;
      await this.adb(serial, ["shell", "mv -f -- " + quote(temporary) + " " + quote(destination)]); await recheck();
      return { uploaded: size, durable: false };
    } catch (error) { if (commitAttempted) throw publicationUncertain(); throw error; }
    finally {
      await pipe.close().catch(() => {});
      if (!commitAttempted) try { await recheck(); await this.adb(serial, ["shell", "rm -f -- " + quote(temporary)]); } catch { /* Authorization loss prohibits guest cleanup. */ }
    }
  }
  async streamDownload(machine: RecordValue, image: RecordValue, _folder: string, source: string, app?: string | null, check: Authorized = () => true): Promise<Download> {
    this.executionAllowed(machine);
    guestPath(source, app); await authorized(check);
    const serial = await this.endpoint(machine, this.storage(machine, image), check);
    if (!serial) throw new ServiceError("Android device is not connected.");
    const recheck = async () => { await authorized(check); this.storage(machine, image); await this.owned(machine, serial); await authorized(check); };
    await recheck();
    const command = "stat -L -c '%d|%i|%f|%s|%y|%z' -- ";
    const info = await this.adb(serial, ["shell", command + quote(source)]), fields = info.split("|");
    const stamp = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} [+-]\d{4}$/;
    if (info.length > 1024 || fields.length !== 6 || ![0, 1, 3].every(i => /^[0-9]+$/.test(fields[i]!)) || !/^[a-fA-F0-9]+$/.test(fields[2]!) || (parseInt(fields[2]!, 16) & 0xf000) !== 0x8000 || !stamp.test(fields[4]!) || !stamp.test(fields[5]!)) throw new ServiceError("Download requires verifiable regular-file metadata.");
    const size = integer(Number(fields[3]), "download size", 0, Number.MAX_SAFE_INTEGER), marker = Buffer.from("\ncanaveral-download-complete-" + randomBytes(16).toString("hex") + "\n");
    const expected = quote(info), script = `exec 3< ${quote(source)} || exit 1\ncheck_fd() { current=$(${command}/proc/self/fd/3) && [ "$current" = ${expected} ]; }\ncheck_fd || exit 1\ncat <&3 || exit 1\ncheck_fd || exit 1\ncurrent=$(${command}${quote(source)}) || exit 1\n[ "$current" = ${expected} ] || exit 1\nprintf '%s' ${quote(marker.toString())}`;
    await recheck();
    const pipe = await this.pipe([this.tool("adb"), "-s", serial, "exec-out", "sh", "-c", script]);
    let remaining = size, completed = false, closed = false;
    return {
      size,
      read: async count => {
        integer(count, "read size", 1, 1048576); if (closed) throw new ServiceError("Download is closed.");
        await recheck(); if (!remaining) return Buffer.alloc(0);
        const data = await pipe.read(Math.min(count, remaining), 30000); await authorized(check);
        if (!data.length || data.length > Math.min(count, remaining)) throw new ServiceError("Download interrupted or exceeded its length.");
        remaining -= data.length; return data;
      },
      verify: async () => {
        if (closed) throw new ServiceError("Download is closed."); await recheck();
        if (!remaining && !completed) {
          const parts: Buffer[] = []; let length = 0;
          while (length <= marker.length) { const data = Buffer.from(await pipe.read(marker.length + 1 - length, 30000)); if (!data.length) break; length += data.length; parts.push(data); if (length > marker.length) break; }
          if (!Buffer.concat(parts).equals(marker) || await pipe.wait(30000) !== 0) throw new ServiceError("Download source changed or completion was not verified.");
          completed = true;
        }
        if (await this.adb(serial, ["shell", command + quote(source)]) !== info) throw new ServiceError("Download source identity changed.");
        await recheck(); return true;
      },
      close: async () => { if (!closed) { closed = true; await pipe.close(); } },
    };
  }
}
