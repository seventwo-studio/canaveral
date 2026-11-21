/** Xcode simulator lifecycle and idb control, always bound to one owned UDID. */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { ServiceError, object } from "../errors.ts";
import { assignmentFingerprint, noLinks, present, StateLock } from "../runtime-process.ts";
import type { LeaseAuthorization } from "../runtime-process.ts";
import { MobileProvider, MAX_OUTPUT, SUPERVISOR_REFUSED, SupervisorLaunchError, atomicUpload, authorized, canonical, confined, containerParts, decodeData, digest, encoded, integer, locked, operationRequest, privateDirectory, readJson, readRegular, saveJson, text, unsupported, uuid } from "./mobile.ts";
import type { Authorized, ByteReader, DeviceRequest, Download, LeaseSupervisorStatus, NativePipe, RecordValue, RunOptions, SupervisedChild } from "./mobile.ts";
import { leasedApps, redactHost, tail } from "./ios-apps.ts";
import { fenceLeaseAuthorization, publishLeaseAuthorization, requireLeaseAccess } from "./lease-supervision.ts";
import { materializeIosApp } from "./ios-artifact.ts";
import { openIosVideo } from "./ios-video.ts";
import type { IosVideoOptions } from "./ios-video.ts";
import { iosOrphan, purgeOrphan, runtimeOperation, storageDevices, strayDevices } from "./mobile-runtimes.ts";
import type { OrphanEvidence, OrphanRemoval, RuntimeContext, RuntimeReport } from "./mobile-runtimes.ts";

/** The only isolation class an iOS simulator lease runs in. A simulator app is an ordinary
 * process of the Mac host's user, with the host's network and files, so a leased simulator
 * is not fenced from the host or from other simulators on it. Owner decision, 21 November
 * 2026: iOS leases are operator opt-in under this declared class, for trusted code only. */
export const IOS_LEASE_ISOLATION = "shared-host";
/** macOS limits a Unix socket path to 104 bytes, terminator included. */
const COMPANION_SOCKET_BYTES = 100;
/** Without the supervisor's own receipt, the runner accepts a stop only after the device
 * stayed shut down and its tree stayed absent this long, over at least this many checks. */
const STOP_SETTLE_SECONDS = 5, STOP_SETTLE_SAMPLES = 3;
/** An unproven stop is re-examined at most this often; each check lists the device set
 * and takes a process inventory. */
const STOP_RECHECK_MS = 1000;
/** A lease's `logs` action returns at most this much of the simulator's last minute. */
const LEASE_LOG_LINES = 1000, LEASE_LOG_BYTES = 524288;
/** How far a leased simulator's stop is established. `held`: its supervisor is alive and
 * owns the deadline. `proven`: positive evidence that the device is shut down and stays
 * shut down. `ended`: the supervisor ended with its own receipt, but that receipt carries
 * no proof or the runner has not confirmed it. `lost`: the supervisor is gone without a
 * receipt and the runner's own evidence is incomplete. */
type StopState = "held" | "proven" | "ended" | "lost";
/** A leased simulator's private device set and the socket of its own control companion. */
interface LeaseScope { set: string; companion: string }
const inside = (child: string, parent: string): boolean => child.startsWith(parent + path.sep);
const ownership = (message: string): ServiceError => new ServiceError(message, 409, { code: "ownership" });

export class IosProvider extends MobileProvider {
  override readonly kind = "ios";
  /** Set while working for a leased machine. Every simctl call then names the lease's own
   * device set and every idb call its own companion, so a leased command can never reach
   * the account's default device set or another lease's simulator. */
  private readonly scope = new AsyncLocalStorage<LeaseScope>();
  /** The operating system this provider judges. A fixture injects it through the constructor;
   * no configuration key or environment variable can change it. */
  private readonly platform: NodeJS.Platform;
  constructor(config: RecordValue, state: string, options: { platform?: NodeJS.Platform } = {}) {
    super(config, state);
    this.platform = options.platform ?? process.platform;
  }
  async simctl(args: readonly string[], options: Partial<RunOptions> = {}): Promise<string> {
    const scope = this.scope.getStore();
    return this.runText([String(this.config.xcrun ?? "xcrun"), "simctl", ...(scope ? ["--set", scope.set] : []), ...args], options);
  }
  idbEnvironment(): Record<string, string> {
    const env = this.environment();
    for (const key of Object.keys(env)) if (key.startsWith("IDB_")) delete env[key];
    return env;
  }
  /** idb finds an account-owned simulator by UDID in the default device set. A leased simulator
   * is outside that set; it is reached only through its own companion's private socket. */
  idbCommand(udid: string, args: readonly string[], tail: readonly string[] = []): string[] {
    const scope = this.scope.getStore(), idb = String(this.config.idb ?? "idb");
    return scope ? [idb, "--companion", scope.companion, ...args, ...tail] : [idb, ...args, "--udid", uuid(udid), ...tail];
  }
  async idb(udid: string, args: readonly string[]): Promise<string> {
    return this.runText(this.idbCommand(udid, args), { env: this.idbEnvironment() });
  }
  /** Operator-requested runtime listing, install and removal; never called by reconciliation. */
  runtimeOperation(kind: string, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport> { return runtimeOperation(this, kind, args, context); }
  storageDevices(): { id: string; runtime: string | null }[] { return storageDevices(this); }
  orphanEvidence(name: string): Promise<OrphanEvidence> { return iosOrphan(this, name); }
  strayDevices(): Promise<{ name: string; machineId: string; kind: "avd-registration" | "simulator" }[]> { return strayDevices(this); }
  purgeOrphan(name: string, requestId: string, hostId: string | undefined): Promise<{ assignmentFingerprint: string | undefined; removed: OrphanRemoval[] }> { return purgeOrphan(this, name, requestId, hostId); }
  async inventory(): Promise<{ runtime: string; device: RecordValue }[]> {
    const devices = object(object(JSON.parse(await this.simctl(["list", "devices", "--json"]))).devices), result = [];
    for (const [runtime, entries] of Object.entries(devices)) {
      if (!Array.isArray(entries)) throw new ServiceError("Malformed simulator inventory.");
      for (const entry of entries) result.push({ runtime, device: object(entry) });
    }
    return result;
  }
  async check(): Promise<unknown> {
    if (this.platform !== "darwin") throw new ServiceError("iOS simulators require native macOS with Xcode.");
    const images = this.checkTemplates("ios");
    if (!this.transport?.executableAvailable) unsupported("iOS executable preflight adapter is not configured.");
    for (const executable of [String(this.config.idb ?? "idb"), "idb_companion"]) if (!await this.transport.executableAvailable(executable)) throw new ServiceError("Install idb and idb_companion before offering iOS devices.");
    const runtimes = object(JSON.parse(await this.simctl(["list", "runtimes", "--json"]))).runtimes, types = object(JSON.parse(await this.simctl(["list", "devicetypes", "--json"]))).devicetypes;
    if (!Array.isArray(runtimes) || !Array.isArray(types)) throw new ServiceError("Malformed simulator runtime inventory.");
    const available = new Set(runtimes.map(object).filter(r => r.isAvailable === true).map(r => r.identifier)), deviceTypes = new Set(types.map(object).map(t => t.identifier));
    for (const image of images) { const device = object(image.device); if (!available.has(device.runtime) || !deviceTypes.has(device.deviceType)) throw new ServiceError("Install every offered iOS runtime and device type before offering it."); }
    const leased = this.leaseSelectors().length > 0;
    if (leased) {
      const helper = this.leaseHelper(); this.simctlTool();
      if (!await this.transport.executableAvailable(this.companionPath())) throw new ServiceError("Install the configured idb_companion before offering iOS leases.");
      // idb reads a companion address containing a colon as host:port, and macOS bounds socket paths.
      const probe = path.join(text(this.config.storage, "storage"), "00000000-0000-0000-0000-000000000000"), scope = this.leaseScope(probe);
      if (Buffer.byteLength(scope.companion) > COMPANION_SOCKET_BYTES || scope.companion.includes(":")) throw new ServiceError("iOS lease storage path cannot hold the control companion's socket; configure a shorter storage path without a colon.");
      // The installed helper must be one that inventories a simulator's process tree. An older
      // helper would start the companion without booting anything and could never prove a stop.
      let inventory: string;
      try { inventory = (await this.transport.leases!.simulatorTree(helper, probe, scope.set, "00000000-0000-0000-0000-000000000000")).tree; } catch { inventory = "unavailable"; }
      if (inventory !== "absent") throw new ServiceError("The configured lease supervisor cannot inventory a simulator's process tree; install the matching canaveral-mobile-native.");
    }
    return { ready: true, nativeAcceptance: false, resourceLimits: "scheduling-reservations-only", ...(leased ? { leaseIsolation: IOS_LEASE_ISOLATION } : {}) };
  }
  async owned(machine: RecordValue, image: RecordValue, storage: string): Promise<RecordValue | undefined> {
    const record = readJson(path.join(storage, "simulator.json"));
    if (!record) return undefined;
    if (record.fingerprint !== digest(this.binding(machine, image))) throw new ServiceError("Simulator receipt belongs to another immutable assignment.");
    const id = uuid(record.udid), found = (await this.inventory()).filter(({ device }) => typeof device.udid === "string" && device.udid.toLowerCase() === id);
    if (found.length !== 1) throw new ServiceError("Owned simulator is missing; it was not recreated.");
    const { runtime, device } = found[0]!, definition = object(image.device);
    if (device.name !== this.name(machine) || runtime !== definition.runtime || device.deviceTypeIdentifier !== definition.deviceType || device.isAvailable !== true) throw new ServiceError("Simulator identity/runtime differs from its assignment; refusing control.");
    return { ...device, udid: id };
  }
  async maintenanceStorage(machine: RecordValue, image: RecordValue): Promise<"present" | "absent" | "unknown" | "notMaterialized"> {
    const storage = this.maintenanceDirectory(machine, image);
    if (!storage) return "absent";
    noLinks(path.join(storage, "simulator.json"));
    if (machine.lease != null) {
      // No CoreSimulator call: by construction the lease's device lives in its own device set.
      const receipt = readJson(path.join(storage, "simulator.json")), set = this.leaseScope(storage).set;
      noLinks(set);
      if (!receipt) return present(path.join(storage, "create-started.json")) || present(set) ? "unknown" : "notMaterialized";
      if (receipt.fingerprint !== digest(this.binding(machine, image)) || receipt.deviceSet !== set || typeof receipt.udid !== "string") return "unknown";
      const data = path.join(set, receipt.udid);
      noLinks(data);
      if (!present(data)) return "absent";
      const stat = fs.lstatSync(data);
      return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()) ? "present" : "unknown";
    }
    const device = await this.owned(machine, image, storage);
    if (!device) {
      return present(path.join(storage, "create-started.json")) || (await this.inventory()).some(({ device }) => device.name === this.name(machine))
        ? "unknown" : "notMaterialized";
    }
    if (typeof device.dataPath !== "string" || !path.isAbsolute(device.dataPath)) return "unknown";
    noLinks(device.dataPath);
    if (!present(device.dataPath)) return "absent";
    const stat = fs.lstatSync(device.dataPath);
    return stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()) ? "present" : "unknown";
  }
  async removeOwnedStorage(machine: RecordValue, image: RecordValue, folder: string, requestId: string): Promise<RecordValue> {
    if (machine.lease != null) return this.removeLeasedStorage(machine, image, folder, requestId);
    this.executionAllowed(machine);
    const lock = new StateLock(path.join(folder, "simulator-removal.sqlite"));
    try { return await this.removeSimulator(machine, image, folder, requestId); }
    finally { lock.close(); }
  }
  private async removeSimulator(machine: RecordValue, image: RecordValue, folder: string, requestId: string): Promise<RecordValue> {
    const machineId = uuid(machine.id), id = uuid(requestId), fingerprint = this.deletionFingerprint(machine, image);
    const root = text(this.config.storage, "storage"), storage = path.join(root, machineId);
    if (!path.isAbsolute(root) || path.resolve(folder) === storage || path.resolve(folder).startsWith(storage + path.sep))
      throw new ServiceError("Simulator storage overlaps host state or is not absolute.");
    const journal = path.join(folder, "deletion.json");
    const previous = readJson(journal);
    let proof = previous ?? { machineId, id, fingerprint, state: "pending" };
    if (proof.id !== id || proof.machineId !== machineId || proof.fingerprint !== fingerprint)
      throw new ServiceError("Deletion receipt belongs to another assignment or request.");
    const record = (state: string, fields: RecordValue = {}) => {
      proof = { ...proof, ...fields, state };
      saveJson(journal, proof);
    };
    const identity = () => {
      const info = fs.lstatSync(storage, { bigint: true, throwIfNoEntry: false });
      if (!info) return null;
      if (!info.isDirectory() || fs.realpathSync(storage) !== storage) throw new ServiceError("Invalid simulator storage directory.");
      return String(info.dev) + ":" + String(info.ino);
    };
    const absent = async () => {
      const devices = await this.inventory();
      return devices.every(({ device }) => uuid(device.udid) !== proof.udid && text(device.name, "simulator name") !== this.name(machine));
    };
    const original = identity();
    if (!previous) record("pending", { directory: original });
    if ((proof.state === "pending" || original !== null) && proof.directory !== original) throw new ServiceError("Simulator storage changed since removal began.");
    if (!["pending", "deleting", "erasing", "complete"].includes(String(proof.state))) throw new ServiceError("Unknown simulator deletion state.");
    if (original !== null && proof.state !== "complete") {
      if (!readJson(path.join(storage, "canaveral-owner.json"))) throw new ServiceError("Simulator storage has no owner.");
      this.storage(machine, image);
      await locked(path.join(storage, "assignment.lock"), async () => {
        const receipt = readJson(path.join(storage, "simulator.json"));
        if (proof.state === "pending") {
          if (receipt) {
            const device = await this.owned(machine, image, storage);
            if (!device) throw new ServiceError("Missing owned simulator.");
            const udid = uuid(device.udid);
            if (device.state === "Booted") await this.simctl(["shutdown", udid]);
            if ((await this.owned(machine, image, storage))?.state !== "Shutdown") throw new ServiceError("Simulator shutdown is unconfirmed.");
            record("deleting", { udid, directory: original });
            await this.simctl(["delete", udid]);
          } else if (readJson(path.join(storage, "create-started.json"))) throw new ServiceError("Simulator creation outcome is uncertain.");
        }
        if (proof.state !== "pending" && (proof.directory !== original || proof.udid !== receipt?.udid))
          throw new ServiceError("Simulator removal identity changed.");
        if (!await absent()) throw new ServiceError("Simulator removal is unconfirmed.");
        record("erasing", { directory: original });
      });
      if (identity() !== original) throw new ServiceError("Simulator storage changed during removal.");
      this.storage(machine, image);
      fs.rmSync(storage, { recursive: true });
      const parent = fs.openSync(root, "r");
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } else if (original !== null || !["pending", "erasing", "complete"].includes(String(proof.state)) || !await absent()) {
      throw new ServiceError("Simulator removal evidence is inconsistent.");
    }
    record("complete");
    return proof;
  }
  async reconcile(machine: RecordValue, supplied: RecordValue, _folder: string): Promise<RecordValue> {
    // Stopping a leased simulator needs only the supervisor helper, so a withdrawn lease
    // declaration can never prevent the host from fencing what already runs.
    if (machine.lease != null && machine.desired === "stopped") this.leaseHelper(); else this.executionAllowed(machine);
    // The host passes the lease authorization beside the pinned template; it is never part of the binding.
    const { _leaseAuthorization: lease, ...image } = supplied;
    const storage = this.storage(machine, image);
    return locked(path.join(storage, "assignment.lock"), async () => {
      if (machine.desired !== "running" && machine.desired !== "stopped") throw new ServiceError("Invalid desired mobile state.", 400);
      if (machine.lease != null) return this.scope.run(this.leaseScope(storage), () => this.reconcileLeased(machine, image, storage, typeof lease === "function" ? lease as () => LeaseAuthorization : undefined));
      let device = await this.owned(machine, image, storage);
      if (!device) {
        if (machine.desired === "stopped") return { state: "stopped" };
        const intent = path.join(storage, "create-started.json");
        if (readJson(intent)) throw new ServiceError("Simulator creation outcome is uncertain; inspect create-started.json before recovery.");
        if ((await this.inventory()).some(({ device }) => device.name === this.name(machine))) throw new ServiceError("Simulator assignment name exists without an owner receipt; refusing adoption.");
        const fingerprint = digest(this.binding(machine, image));
        saveJson(intent, { name: this.name(machine), fingerprint });
        const definition = object(image.device);
        const id = uuid(await this.simctl(["create", this.name(machine), text(definition.deviceType, "device type"), text(definition.runtime, "runtime")]));
        saveJson(path.join(storage, "simulator.json"), { udid: id, fingerprint });
        device = await this.owned(machine, image, storage);
        if (!device) throw new ServiceError("New simulator identity could not be confirmed.");
      }
      const id = uuid(device.udid), state = device.state;
      if (machine.desired === "stopped") {
        if (state === "Shutdown") return { state: "stopped" };
        if (state === "Booted") await this.simctl(["shutdown", id]);
        return { state: "stopping" };
      }
      if (state === "Shutdown") await this.simctl(["boot", id]);
      else if (state !== "Booted" && state !== "Booting") return { state: "unknown", detail: "Unsupported simulator state: " + String(state) };
      await this.simctl(["bootstatus", id, "-b"], { timeoutMs: 120000 });
      return { state: "running" };
    });
  }
  /** The device identity every command targets. For a leased machine this is also the access
   * gate: its supervisor must be alive and its authorization current, and the simulator must be
   * the single device of the lease's own device set. */
  async ready(machine: RecordValue, image: RecordValue): Promise<string> {
    this.executionAllowed(machine);
    if (machine.lease != null) return this.within(machine, image, async () => {
      const storage = this.storage(machine, image);
      await this.leaseAccess(storage);
      const device = await this.leasedDevice(machine, image, storage);
      if (!device || device.state !== "Booted") throw new ServiceError("iOS simulator is not booted.");
      return String(device.udid);
    });
    const device = await this.owned(machine, image, this.storage(machine, image));
    if (!device || device.state !== "Booted") throw new ServiceError("iOS simulator is not booted.");
    return uuid(device.udid);
  }
  /** Lease recording stays refused on iOS. The administrative path fails natively at idb's stop
   * (idb-cli 1.7.8 exits 1 after the graceful interrupt), so every recording would end with
   * unproven cleanup, and its capture process is not scoped to the lease's device set. */
  async openVideo(machine: RecordValue, image: RecordValue, folder: string, options: IosVideoOptions, check: Authorized): Promise<NativePipe> {
    if (machine.lease != null) unsupported("Lease recording is not available for iOS simulators; native iOS recording has no accepted stop and cleanup proof.");
    return openIosVideo(this, machine, image, folder, options, check);
  }
  async containerRoot(udid: string, app: unknown): Promise<string> {
    const bundle = text(app, "app bundle ID");
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(bundle)) throw new ServiceError("Choose an app bundle ID.", 400);
    const scope = this.scope.getStore();
    // A leased simulator keeps the identity CoreSimulator printed at creation, case included.
    const root = await this.simctl(["get_app_container", scope ? udid : uuid(udid), bundle, "data"]);
    if (!path.isAbsolute(root) || root.includes("\0")) throw new ServiceError("Simulator returned an invalid data container.");
    if (scope && !inside(root, scope.set)) throw ownership("Simulator returned a data container outside this lease's device set; refusing access.");
    return root;
  }
  /** installArtifact stages only in private `.artifact-*` directories of this assignment's storage. */
  override async stagedArtifacts(dir: string): Promise<"absent" | "present"> {
    return (await fsp.readdir(dir)).some(name => name.startsWith(".artifact-")) ? "present" : "absent";
  }
  /** The caller's durable operation journal owns dispatch and never retries uncertain installs. */
  async installArtifact(machine: RecordValue, image: RecordValue, folder: string, source: Download, sha256: string, check: Authorized = () => true): Promise<RecordValue> {
    // A leased install rechecks its supervisor and authorization at every ready() below:
    // before staging, before the install and after it.
    return this.within(machine, image, () => this.installStaged(machine, image, folder, source, sha256, check));
  }
  private async installStaged(machine: RecordValue, image: RecordValue, _folder: string, source: Download, sha256: string, check: Authorized): Promise<RecordValue> {
    let stage: string | undefined, identity: string | undefined;
    const bytes = source.size;
    try {
      await authorized(check);
      const maximum = this.config.maxArtifactBytes ?? 2 * 1024 ** 3;
      if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1024 || !Number.isSafeInteger(bytes) || bytes < 1024 || bytes > maximum || !/^[a-f0-9]{64}$/.test(sha256)) throw new ServiceError("Invalid iOS application artifact size or digest.", 400);
      const id = await this.ready(machine, image), storage = this.storage(machine, image);
      stage = await fsp.mkdtemp(path.join(storage, ".artifact-"));
      await fsp.chmod(stage, 0o700);
      const info = await fsp.lstat(stage, { bigint: true }); identity = `${info.dev}:${info.ino}`;
      const archivePath = path.join(stage, "application.tar"), archive = await fsp.open(archivePath, "wx", 0o600), hash = createHash("sha256");
      try {
        if (await source.verify() !== true) throw new ServiceError("Application artifact source identity is unverified.", 409);
        let remaining = bytes;
        while (remaining) {
          await authorized(check);
          const chunk = await source.read(Math.min(65536, remaining));
          await authorized(check);
          if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > Math.min(65536, remaining)) throw new ServiceError("Application artifact length differs from its declaration.", 400);
          hash.update(chunk); let written = 0;
          while (written < chunk.length) {
            await authorized(check); const result = await archive.write(chunk, written, chunk.length - written);
            if (!result.bytesWritten) throw new ServiceError("Application artifact staging was interrupted.", 409);
            written += result.bytesWritten;
          }
          remaining -= chunk.length;
        }
        if (await source.verify() !== true || hash.digest("hex") !== sha256) throw new ServiceError("Application artifact changed or failed its SHA-256 checksum.", 400);
        await authorized(check); await archive.sync();
      } finally { await archive.close(); }
      const destination = path.join(stage, "bundle"); await fsp.mkdir(destination, { mode: 0o700 });
      const app = await materializeIosApp(archivePath, destination, { maxBytes: bytes, authorized: check });
      await authorized(check);
      if (await this.ready(machine, image) !== id) throw new ServiceError("Simulator identity changed before application installation.", 409);
      await authorized(check); await this.simctl(["install", id, app]); await authorized(check);
      if (await this.ready(machine, image) !== id) throw new ServiceError("Simulator identity changed during application installation.", 409, { outcome: "unknown" });
    } finally {
      try { await source.close(); }
      finally {
        if (stage) {
          try {
            const current = await fsp.lstat(stage, { bigint: true });
            if (!current.isDirectory() || `${current.dev}:${current.ino}` !== identity) throw new Error("stage identity changed");
            await fsp.rm(stage, { recursive: true });
            try { await fsp.lstat(stage); throw new Error("stage still exists"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          } catch { throw new ServiceError("Application artifact staging cleanup is unconfirmed; inspect before retrying.", 409, { outcome: "unknown" }); }
        }
      }
    }
    return { installed: true, sha256, bytes, artifactCleaned: true };
  }
  override async displayDensity(machine: RecordValue, image: RecordValue): Promise<number> {
    return this.within(machine, image, async () => {
      const id = await this.ready(machine, image), info = object(JSON.parse(await this.idb(id, ["describe", "--json"]))), screen = object(info.screen_dimensions ?? {}), density = screen.density;
      if (typeof density !== "number" || !Number.isFinite(density) || density <= 0) throw new ServiceError("iOS display scale is unavailable; refusing imprecise input.");
      return density;
    });
  }
  override async control(machine: RecordValue, image: RecordValue, folder: string, input: DeviceRequest): Promise<RecordValue> {
    return this.within(machine, image, async () => {
      const result = await this.controlDevice(machine, image, folder, input), scope = this.scope.getStore();
      // A lease holder reads device output without this host's layout or the device identity.
      if (scope && typeof result.output === "string") result.output = this.redact(result.output, scope);
      return result;
    });
  }
  /** Replaces this host's own locations and the device identity in text a lease holder reads:
   * the device, device set, lease storage, storage root, runner state and the account's home.
   * It cannot remove what an app or the system itself wrote into a log line. */
  private redact(value: string, scope: LeaseScope): string {
    const storage = path.dirname(scope.set), udid = String(readJson(path.join(storage, "simulator.json"))?.udid ?? "");
    return redactHost(value, [[path.join(scope.set, udid), "<device>"], [scope.set, "<device-set>"], [storage, "<lease>"],
      [text(this.config.storage, "storage"), "<storage>"], [this.state, "<state>"], [os.homedir(), "<home>"]], udid);
  }
  private async controlDevice(machine: RecordValue, image: RecordValue, folder: string, input: DeviceRequest): Promise<RecordValue> {
    const request = operationRequest(input), args = request.arguments, action = request.action;
    if (action === "accessibility" || action === "accessibility-action") return this.mobileAccessibility(machine, image, folder, request);
    const id = await this.ready(machine, image);
    if (action === "list-files" || action === "push" || action === "pull") {
      const relative = text(args.path, "app-container path"); containerParts(relative, action === "list-files");
      const root = await this.containerRoot(id, args.app);
      return confined(this.transport?.files, root, relative, async (parent, name) => {
        if (action === "list-files") { const entries = (await parent.list()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); return { entries: entries.slice(0, 2000), truncated: entries.length > 2000 }; }
        if (action === "push") { const bytes = decodeData(args.data); let offset = 0; await atomicUpload(parent, name, { read: async count => { const chunk = bytes.subarray(offset, offset + count); offset += chunk.length; return chunk; } }, bytes.length, () => true); return { output: "File written to app data container." }; }
        const source = await parent.download(name);
        try {
          if (source.size > MAX_OUTPUT || !Number.isSafeInteger(source.size) || source.size < 0) throw new ServiceError("File exceeds 4 MiB or has invalid size.", 413);
          const chunks: Buffer[] = []; let remaining = source.size;
          await source.verify();
          while (remaining) { const data = Buffer.from(await source.read(Math.min(65536, remaining))); if (!data.length || data.length > Math.min(65536, remaining)) throw new ServiceError("File read was interrupted."); chunks.push(data); remaining -= data.length; }
          await source.verify(); return encoded(Buffer.concat(chunks));
        } finally { await source.close(); }
      }, action === "list-files");
    }
    if (action === "screenshot") {
      // Private random path; consumer operation IDs never select a host file.
      const temporary = fs.mkdtempSync(path.join(this.storage(machine, image), ".screenshot-")), file = path.join(temporary, randomUUID() + ".png");
      try { await this.simctl(["io", id, "screenshot", "--type=png", file]); return encoded(readRegular(file, MAX_OUTPUT), "image/png"); }
      finally { fs.rmSync(file, { force: true }); fs.rmdirSync(temporary); }
    }
    let argv: string[];
    if (action === "tap" || action === "swipe") {
      argv = ["ui", action, ...(action === "tap" ? ["x", "y"] : ["x", "y", "toX", "toY"]).map(k => String(args[k]))];
      if (action === "swipe") argv.push("--duration", String(Number(args.durationMs) / 1000));
    } else if (action === "text") return { output: await this.runText(this.idbCommand(id, ["ui", "text"], ["--", args.text as string]), { env: this.idbEnvironment() }) };
    else if (action === "key") argv = ["ui", /^[0-9]+$/.test(args.key as string) ? "key" : "button", String(args.key)];
    else if (action === "hierarchy") argv = ["ui", "describe-all", "--json"];
    else if (action === "rotate") argv = ["ui", "rotate", String(args.orientation)];
    else if (action === "permission") return { output: await this.simctl(["privacy", id, String(args.state), String(args.permission), String(args.app)]) };
    else if (action === "apps") {
      const listing = await this.simctl(["listapps", id]);
      // The raw listing carries absolute host paths for every app; a lease gets identifiers only.
      if (!this.scope.getStore()) return { output: listing };
      const apps = leasedApps(listing);
      return { output: apps.map(app => app.bundleId).join("\n"), apps };
    }
    else if (action === "install") return { output: await this.simctl(["install", id, this.artifact(args.artifact)]) };
    else if (["launch", "terminate", "uninstall"].includes(action)) {
      if ((args.app as string).includes("/")) throw new ServiceError("iOS operations require an app bundle ID.", 400);
      return { output: await this.simctl([action, id, args.app as string]) };
    } else if (action === "open-url") return { output: await this.simctl(["openurl", id, args.url as string]) };
    else if (action === "location") return { output: await this.simctl(["location", id, "set", `${args.latitude},${args.longitude}`]) };
    else if (action === "logs") {
      const log = await this.simctl(["spawn", id, "log", "show", "--last", "1m", "--style", "compact"]), scope = this.scope.getStore();
      // Redacted before it is bounded, so the bound is on what the lease holder receives.
      return scope ? tail(this.redact(log, scope), LEASE_LOG_LINES, LEASE_LOG_BYTES) : { output: log };
    }
    else return unsupported("iOS supports app, file and UI actions; shell/accessibility require a supported shared adapter.");
    return { output: await this.idb(id, argv) };
  }
  async streamUpload(machine: RecordValue, image: RecordValue, _folder: string, relative: string, app: string | null | undefined, reader: ByteReader, size: number, check: Authorized): Promise<RecordValue> {
    return this.within(machine, image, async () => {
      await authorized(check); containerParts(relative);
      const id = await this.ready(machine, image), root = await this.containerRoot(id, app);
      const recheck = async () => { await authorized(check); if (await this.ready(machine, image) !== id || await this.containerRoot(id, app) !== root) throw new ServiceError("App container identity changed."); await authorized(check); return true; };
      return confined(this.transport?.files, root, relative, (parent, name) => atomicUpload(parent, name, reader, size, recheck));
    });
  }
  async streamDownload(machine: RecordValue, image: RecordValue, _folder: string, relative: string, app?: string | null, check: Authorized = () => true): Promise<Download> {
    return this.within(machine, image, async () => {
      await authorized(check); containerParts(relative);
      const id = await this.ready(machine, image), root = await this.containerRoot(id, app);
      const source = await confined(this.transport?.files, root, relative, (parent, name) => parent.download(name));
      // The adapter's returned download owns its descriptor independently of the directory handle.
      // The caller reads it later, so each identity check re-enters the lease's own scope.
      return { size: source.size,
        read: async count => { await authorized(check); const result = await source.read(count); await authorized(check); return result; },
        verify: () => this.within(machine, image, async () => { await authorized(check); if (await this.ready(machine, image) !== id || await this.containerRoot(id, app) !== root || await source.verify() !== true) throw new ServiceError("Download identity changed."); await authorized(check); return true; }),
        close: () => source.close(),
      };
    });
  }

  // Leased simulators. Each lease gets its own private device set with one simulator created
  // for it, so ownership and cleanup follow from the directory: nothing in the account's
  // default device set is ever read, changed or deleted for a lease. The native lease
  // supervisor boots the simulator, owns the lease's control companion and enforces the
  // published boot-bound deadline when this runner or the controller is lost. Supervisor
  // liveness is the kernel-held lifetime lock on its storage, never a PID. A stop counts
  // only on positive evidence: CoreSimulator reporting the device shut down, and none of
  // its process tree present, both held across a settling period.
  //
  // Isolation class: shared-host. Nothing here fences simulated code from the Mac host.
  // Native acceptance is open: no leased simulator has been booted on real CoreSimulator.
  readonly supervisors = new Map<string, SupervisedChild>();
  /** This host's iOS lease selectors. Each must carry the explicit shared-host declaration. */
  private leaseSelectors(): RecordValue[] {
    return (Array.isArray(this.config.leaseImages) ? this.config.leaseImages : []).map(object).filter(entry => entry.runtime === "ios");
  }
  private leaseHelper(): string {
    const helper = this.config.leaseSupervisor;
    if (typeof helper !== "string" || !path.isAbsolute(helper) || !this.transport?.leases) unsupported("Leased iOS execution requires the configured native lease supervisor.");
    return helper;
  }
  private companionPath(): string {
    const companion = this.config.idbCompanion;
    if (typeof companion !== "string" || !path.isAbsolute(companion)) unsupported("Leased iOS execution requires an absolute idbCompanion path.");
    return companion;
  }
  /** The supervisor runs simctl itself, with a cleared environment, so the tool path is absolute. */
  private simctlTool(): string[] {
    const xcrun = this.config.xcrun ?? "/usr/bin/xcrun";
    if (typeof xcrun !== "string" || !path.isAbsolute(xcrun)) unsupported("Leased iOS execution requires an absolute xcrun path.");
    return [xcrun, "simctl"];
  }
  /** Operator opt-in, checked by the provider as well as the host: a leased machine runs only on
   * macOS, with the native supervisor, for a template whose lease selector declares shared-host. */
  override executionAllowed(machine: RecordValue): void {
    if (machine.lease == null) return;
    this.leaseHelper();
    const template = object(machine.template), id = machine.templateId ?? template.id;
    if (this.platform !== "darwin" || !this.leaseSelectors().some(entry => entry.isolation === IOS_LEASE_ISOLATION && entry.id === id && entry.revision === template.revision && entry.arch === template.arch))
      unsupported("This host has not declared the shared-host isolation class for leases of this iOS template; leased execution is refused.");
  }
  private leaseScope(storage: string): LeaseScope { return { set: path.join(storage, "device-set"), companion: path.join(storage, "idb.sock") }; }
  /** Device work for a leased machine runs against its own device set and companion only. */
  private within<T>(machine: RecordValue, image: RecordValue, work: () => Promise<T>): Promise<T> {
    if (machine.lease == null) return work();
    this.executionAllowed(machine);
    return this.scope.run(this.leaseScope(this.storage(machine, image)), work);
  }
  private leaseStorage(machine: RecordValue): string { return path.join(text(this.config.storage, "storage"), uuid(machine.id)); }
  private leaseIdentity(machine: RecordValue): { machineId: string; leaseId: string } {
    return { machineId: uuid(machine.id), leaseId: uuid(object(machine.lease).id) };
  }
  private supervisorStatus(storage: string): Promise<LeaseSupervisorStatus> { return this.transport!.leases!.status(this.leaseHelper(), storage); }
  /** A fenced, stopped, lost or expired lease supervisor ends device access, whatever the host still believes. */
  private leaseAccess(storage: string): Promise<void> {
    return requireLeaseAccess(this.transport!.leases!, this.leaseHelper(), readJson(path.join(storage, "launch.json")), storage, "iOS");
  }
  async publishLease(machine: RecordValue, storage: string, authorization: () => LeaseAuthorization, stopping: boolean): Promise<RecordValue> {
    return publishLeaseAuthorization(this.transport!.leases!, this.leaseHelper(), storage, this.leaseIdentity(machine), authorization, stopping);
  }
  private fenceLease(storage: string): void { fenceLeaseAuthorization(storage); }
  /** The lease's own simulator: the single device of its private device set, matching the
   * creation receipt and the pinned template. Call inside the lease scope. */
  private async leasedDevice(machine: RecordValue, image: RecordValue, storage: string): Promise<RecordValue | undefined> {
    const record = readJson(path.join(storage, "simulator.json")), set = this.leaseScope(storage).set;
    if (!record) return undefined;
    if (record.fingerprint !== digest(this.binding(machine, image)) || record.deviceSet !== set || typeof record.udid !== "string") throw ownership("Simulator receipt belongs to another immutable assignment.");
    const id = uuid(record.udid), found = await this.inventory();
    if (found.length !== 1 || typeof found[0]!.device.udid !== "string" || uuid(found[0]!.device.udid) !== id) throw ownership("The lease's device set does not hold exactly its own simulator; refusing control.");
    const { runtime, device } = found[0]!, definition = object(image.device);
    if (device.name !== this.name(machine) || runtime !== definition.runtime || device.deviceTypeIdentifier !== definition.deviceType || device.isAvailable !== true) throw ownership("Simulator identity/runtime differs from its lease; refusing control.");
    if (typeof device.dataPath === "string" && !inside(device.dataPath, set)) throw ownership("Simulator data lies outside this lease's device set; refusing control.");
    return { ...device, udid: record.udid };
  }
  /** Creates the lease's private device set and its single simulator. Nothing is adopted: a
   * creation whose outcome is uncertain is never repeated, and cleanup removes what it left. */
  private async provisionLeased(machine: RecordValue, image: RecordValue, storage: string): Promise<string> {
    const set = this.leaseScope(storage).set, receipt = path.join(storage, "simulator.json"), intent = path.join(storage, "create-started.json");
    const fingerprint = digest(this.binding(machine, image)), name = this.name(machine);
    if (!readJson(receipt)) {
      if (readJson(intent) || fs.existsSync(set)) throw new ServiceError("Leased simulator creation outcome is uncertain; a lease is never provisioned twice.");
      saveJson(intent, { name, fingerprint, deviceSet: set });
      privateDirectory(set);
      const definition = object(image.device);
      const udid = await this.simctl(["create", name, text(definition.deviceType, "device type"), text(definition.runtime, "runtime")]);
      uuid(udid);
      saveJson(receipt, { udid, fingerprint, name, deviceSet: set });
    }
    const device = await this.leasedDevice(machine, image, storage);
    if (!device) throw new ServiceError("New simulator identity could not be confirmed.");
    // Only the supervisor ever boots a leased simulator.
    if (device.state !== "Shutdown") throw new ServiceError("A new leased simulator must be shut down before its supervised boot.");
    return String(device.udid);
  }
  /** CoreSimulator's own state for the lease's simulator in its own device set: `Shutdown`,
   * `Booted` and so on, `absent` when the set no longer lists it, or undefined when
   * CoreSimulator did not answer. Only `Shutdown` and `absent` count as shut down. */
  private async leasedState(scope: LeaseScope, udid: string): Promise<string | undefined> {
    try {
      const found = (await this.scope.run(scope, () => this.inventory())).filter(({ device }) => typeof device.udid === "string" && uuid(device.udid) === uuid(udid));
      if (!found.length) return "absent";
      return found.length === 1 && typeof found[0]!.device.state === "string" ? found[0]!.device.state : undefined;
    } catch { return undefined; }
  }
  /** Counts consecutive positive checks on the host's continuous clock. Any negative check
   * removes the record, so the settling period always starts again from the first one. */
  private settled(storage: string, status: LeaseSupervisorStatus): boolean {
    const file = path.join(storage, "lease-stop-observation.json"), previous = readJson(file);
    if (!previous || previous.bootSessionID !== status.bootSessionID || typeof previous.since !== "number" || !Number.isSafeInteger(previous.samples) || status.continuous < previous.since) {
      saveJson(file, { version: 1, bootSessionID: status.bootSessionID, since: status.continuous, samples: 1 });
      return false;
    }
    const samples = Number(previous.samples) + 1;
    saveJson(file, { ...previous, samples });
    return status.continuous - previous.since >= STOP_SETTLE_SECONDS && samples >= STOP_SETTLE_SAMPLES;
  }
  /** Positive evidence that the leased simulator is shut down and stays shut down. Never
   * absence of evidence: an unanswered question is a negative answer here.
   *
   * With the supervisor's receipt: that receipt must itself state the proof (companion group
   * absent, tree absent, CoreSimulator reporting the device shut down across the supervisor's
   * settling period), and a fresh check must agree: CoreSimulator still reports the device
   * `Shutdown` or gone, and the process table still shows none of its tree.
   *
   * Without it (the supervisor was lost): the companion must be positively absent, the tree
   * must have been observed while it ran unless no boot was ever issued, and the device must
   * stay shut down with its tree absent across the runner's own settling period. */
  private async stopEvidence(storage: string, launch: RecordValue, record: RecordValue | undefined, receipt: RecordValue | undefined, status: LeaseSupervisorStatus): Promise<boolean> {
    const leases = this.transport!.leases!, helper = this.leaseHelper(), scope = this.leaseScope(storage), udid = String(launch.udid ?? "");
    const observation = path.join(storage, "lease-stop-observation.json");
    try {
      const attested = !!receipt && receipt.groupAbsent === true && receipt.treeAbsent === true && ["Shutdown", "absent"].includes(String(receipt.deviceState));
      if (!attested) {
        // The companion is only observed, never signalled. A launch without a supervisor record
        // may still have left a supervisor or a companion behind: both name this lease's storage.
        const gone = record ? await this.transport?.processAbsent?.(record.childPid as number) === true && await leases.groupAbsent(record.childPid as number)
          : !(await leases.commandLines()).some(line => line.includes(`lease-supervise ${storage}`) || line.includes(scope.companion));
        if (!gone) { fs.rmSync(observation, { force: true }); return false; }
      }
      const tree = await leases.simulatorTree(helper, storage, scope.set, udid), state = await this.leasedState(scope, udid);
      const quiet = tree.tree === "absent" && (state === "Shutdown" || state === "absent");
      if (attested) return quiet;
      // The device's launchd_sim seen once, by the supervisor or by this runner after it was
      // lost, shows that this simulator's tree is visible in the process table. It is kept,
      // so a simulator that booted late and was then shut down by hand can still be proven.
      const seen = path.join(storage, "lease-tree-observed.json");
      if (tree.observed && !fs.existsSync(seen)) saveJson(seen, { version: 1, bootId: launch.bootId });
      // The boot is issued only after the supervisor record exists, so without one nothing booted.
      if (!quiet || record && !fs.existsSync(seen)) { fs.rmSync(observation, { force: true }); return false; }
      return this.settled(storage, status);
    } catch { fs.rmSync(observation, { force: true }); return false; }
  }
  private readonly stopChecks = new Map<string, { at: number; state: "ended" | "lost" }>();
  private async stopState(machine: RecordValue, storage: string): Promise<StopState> {
    const { machineId, leaseId } = this.leaseIdentity(machine), leases = this.transport?.leases;
    const launchPath = path.join(storage, "launch.json"), launch = readJson(launchPath), record = readJson(path.join(storage, "lease-supervisor.json"));
    if (!launch) {
      // Nothing was ever handed to a supervisor, and only a supervisor boots a leased simulator.
      // Once a device set exists, CoreSimulator must still report everything in it shut down.
      const scope = this.leaseScope(storage);
      if (record) return "lost";
      if (!fs.existsSync(scope.set)) return "proven";
      try { return (await this.scope.run(scope, () => this.inventory())).every(({ device }) => device.state === "Shutdown") ? "proven" : "lost"; } catch { return "lost"; }
    }
    if (launch.supervised !== true || launch.machineId !== machineId || launch.leaseId !== leaseId) throw new ServiceError("Leased launch identity is contradictory; inspect it.", 409);
    if (!leases) return "lost";
    if (launch.stopProven === true) return "proven";
    const status = await leases.status(this.leaseHelper(), storage);
    if (status.supervisor === "held") return "held";
    const found = readJson(path.join(storage, "lease-stopped.json"));
    const receipt = found && found.machineId === machineId && found.leaseId === leaseId && found.bootId === launch.bootId ? found : undefined;
    if (record) {
      const pid = record.childPid, supervisor = record.supervisorPid;
      if (record.machineId !== machineId || record.leaseId !== leaseId || record.bootId !== launch.bootId || !Number.isSafeInteger(pid) || !Number.isSafeInteger(supervisor) ||
        launch.supervisorPid !== undefined && launch.supervisorPid !== supervisor || receipt && (receipt.childPid !== pid || receipt.supervisorPid !== supervisor)) throw new ServiceError("Lease supervisor record belongs to another launch.", 409);
    }
    const outcome = receipt ? "ended" : "lost", checked = this.stopChecks.get(machineId);
    if (checked && checked.state === outcome && performance.now() - checked.at < STOP_RECHECK_MS) return outcome;
    if (!await this.stopEvidence(storage, launch, record, receipt, status)) { this.stopChecks.set(machineId, { at: performance.now(), state: outcome }); return outcome; }
    this.stopChecks.delete(machineId);
    // Single-use storage: nothing boots this simulator again, so the proof is recorded once.
    saveJson(launchPath, { ...launch, stopProven: true });
    return "proven";
  }
  /** Positive stop proof only; see stopEvidence. A held lifetime lock, a receipt that states
   * no proof, a device CoreSimulator does not report as shut down, an unreadable inventory,
   * a tree that was never observed or a tree record that lost members all stay unproven. */
  async leaseStopped(machine: RecordValue, storage: string): Promise<boolean> {
    return await this.stopState(machine, storage) === "proven";
  }
  private async reconcileLeased(machine: RecordValue, image: RecordValue, storage: string, authorization: (() => LeaseAuthorization) | undefined): Promise<RecordValue> {
    const launchPath = path.join(storage, "launch.json"), launch = readJson(launchPath), stopping = machine.desired === "stopped";
    if (!launch) {
      if (readJson(path.join(storage, "lease-supervisor.json"))) return { state: "unknown", detail: "Lease supervisor record has no launch intent; inspect before recovery." };
      if (stopping) return { state: "stopped", leaseFenced: true };
      if (!authorization) unsupported("Leased iOS launch requires the host's lease authorization.");
      const allowed = authorization();
      if (allowed.fenced || allowed.remainingSeconds <= 1) throw new ServiceError("Lease authorization ended before launch.", 410);
      const helper = this.leaseHelper(), companion = this.companionPath(), tool = this.simctlTool(), scope = this.leaseScope(storage);
      if (Buffer.byteLength(scope.companion) > COMPANION_SOCKET_BYTES || scope.companion.includes(":")) throw new ServiceError("iOS lease storage path cannot hold the control companion's socket.");
      const udid = await this.provisionLeased(machine, image, storage), { machineId, leaseId } = this.leaseIdentity(machine);
      const identity = { version: 2, bootId: randomUUID(), machineId, leaseId, fingerprint: digest(this.binding(machine, image)), udid, deviceSet: scope.set, isolation: IOS_LEASE_ISOLATION, startedAt: this.now(), supervised: true };
      saveJson(launchPath, identity);
      await this.publishLease(machine, storage, authorization, false);
      let child: SupervisedChild;
      try {
        child = await this.transport!.leases!.supervise(helper, storage, { version: 1, machineId, leaseId, bootId: identity.bootId, executable: companion,
          args: ["--udid", udid, "--device-set-path", scope.set, "--grpc-domain-sock", scope.companion, "--only", "simulator", "--log-level", "info"],
          env: this.idbEnvironment(), cwd: storage, simulator: { tool, deviceSet: scope.set, udid } });
      } catch (error) {
        // Only the supervisor's dedicated refusal status proves nothing was spawned or booted.
        // Any other failure is recovered later from the lifetime lock and a process inventory.
        const exit = error instanceof SupervisorLaunchError ? error.supervisorExit : undefined;
        if (exit === SUPERVISOR_REFUSED && !readJson(path.join(storage, "lease-supervisor.json"))) saveJson(launchPath, { ...identity, supervisorExit: exit });
        throw error;
      }
      this.supervisors.set(machineId, child);
      saveJson(launchPath, { ...identity, pid: integer(child.pid, "companion pid", 2, 2 ** 31 - 1), supervisorPid: integer(child.supervisorPid, "supervisor pid", 2, 2 ** 31 - 1) });
      return { state: "starting", accessReady: false, detail: "Leased simulator is booting under its native deadline supervisor." };
    }
    const stop = await this.stopState(machine, storage);
    if (stop === "proven") {
      this.supervisors.delete(uuid(machine.id));
      return stopping ? { state: "stopped", leaseFenced: true } : { state: "error", detail: "The leased simulator stopped; a lease is never relaunched." };
    }
    if (stop === "ended") {
      // The supervisor ended with its receipt, which already fences access. The proof is not
      // confirmed (or the receipt states none), so nothing is removed yet.
      const detail = "The leased simulator's supervisor ended; its stop is not proven yet, so cleanup waits. A lease is never relaunched.";
      return stopping ? { state: "stopping", leaseFenced: true, detail } : { state: "error", leaseFenced: true, detail };
    }
    if (stop === "lost") {
      // Gone without a stop receipt (killed, crashed or never recorded): nothing enforces the
      // deadline any more. Fence access now and fail the lease; cleanup waits for stop proof.
      this.fenceLease(storage);
      const detail = "The lease supervisor is gone without a stop receipt. Device access is fenced; cleanup waits until the simulator's process tree is proven absent.";
      return stopping ? { state: "stopping", leaseFenced: true, detail } : { state: "error", leaseFenced: true, detail };
    }
    if (stopping) {
      if (authorization) await this.publishLease(machine, storage, authorization, true); else this.fenceLease(storage);
      return { state: "stopping", leaseFenced: true, detail: "Lease fenced; the native supervisor's shutdown and process-tree proof is pending." };
    }
    if (!authorization) unsupported("Leased iOS execution requires the host's lease authorization.");
    // The fence worker republishes on every revision change; reconciliation only fills a gap.
    const allowed = authorization(), previous = readJson(path.join(storage, "lease-authorization.json"));
    if (!previous || previous.revision !== allowed.revision || allowed.fenced && previous.fenced !== true) await this.publishLease(machine, storage, () => allowed, false);
    return this.leasedReadiness(machine, image, storage, launch);
  }
  /** Ready means booted, owned (the single device of this lease's device set) and answering:
   * boot finished, the install service lists apps, the device's launchd spawns a process and
   * the lease's own companion describes this device as booted. There is no network isolation
   * probe: a simulator shares the host's network and nothing here restricts it. */
  private async leasedReadiness(machine: RecordValue, image: RecordValue, storage: string, launch: RecordValue): Promise<RecordValue> {
    const waiting = (detail: string): RecordValue => ({ state: "starting", accessReady: false, detail });
    const refused = (detail: string): RecordValue => { this.fenceLease(storage); return { state: "error", leaseFenced: true, detail }; };
    let device: RecordValue | undefined;
    try { await this.leaseAccess(storage); device = await this.leasedDevice(machine, image, storage); }
    catch (error) {
      if (error instanceof ServiceError && error.status === 410) throw error;
      // Fail closed: a device set that is no longer exactly this lease's is never handed out.
      if (error instanceof ServiceError && error.code === "ownership") return refused("The lease's device set no longer holds exactly its own simulator; the lease was fenced.");
      return waiting("Waiting for the lease's own simulator.");
    }
    if (!device) return refused("The leased simulator has no creation receipt; the lease was fenced.");
    if (device.state !== "Booted") return waiting("Waiting for the simulator to boot.");
    const udid = String(device.udid), receipt = path.join(storage, "lease-ready.json");
    if (readJson(receipt)?.bootId === launch.bootId) return { state: "running", accessReady: true };
    try {
      // Never `bootstatus -b`: that would boot the device, which only the supervisor may do.
      await this.simctl(["bootstatus", udid], { timeoutMs: 20000 });
      if (!await this.simctl(["listapps", udid])) return waiting("Waiting for the install service.");
      if (!await this.simctl(["spawn", udid, "launchctl", "print", "system"])) return waiting("Waiting for the launch service.");
      const described = object(JSON.parse(await this.idb(udid, ["describe", "--json"])));
      if (typeof described.udid !== "string" || uuid(described.udid) !== uuid(udid)) return refused("The lease's control companion answered for another device; the lease was fenced.");
      if (described.state !== "Booted") return waiting("Waiting for the control companion to see the booted simulator.");
    } catch { return waiting("Waiting for the booted simulator's install, launch and control services."); }
    saveJson(receipt, { version: 1, bootId: launch.bootId, udid, deviceSet: this.leaseScope(storage).set, isolation: IOS_LEASE_ISOLATION, networkIsolation: "not-probed",
      checks: ["booted", "owned", "boot-finished", "install-service", "launch-service", "control-companion"] });
    return { state: "running", accessReady: true };
  }
  /** Independent deadline publication, called by the host's fence worker. Never launches. */
  async refreshExecution(machine: RecordValue, _image: RecordValue, _folder: string, authorization: () => LeaseAuthorization): Promise<RecordValue | null> {
    this.leaseHelper();
    const storage = this.leaseStorage(machine), launch = readJson(path.join(storage, "launch.json"));
    if (!launch || launch.supervised !== true) return null;
    // A launch whose supervisor has not written its record yet is still starting (or the runner crashed
    // around it); its recovery belongs to cleanup, never to this fence poll, which could race the launch.
    if (!readJson(path.join(storage, "lease-supervisor.json")) && launch.supervisorExit === undefined && launch.stopProven !== true) return null;
    if (await this.leaseStopped(machine, storage)) return { state: "stopped", leaseFenced: true };
    const allowed = authorization(), previous = readJson(path.join(storage, "lease-authorization.json")), stopping = machine.desired === "stopped" || allowed.fenced;
    if (!previous || previous.revision !== allowed.revision || stopping && previous.fenced !== true) await this.publishLease(machine, storage, () => allowed, stopping);
    return stopping ? { state: "stopping", leaseFenced: true, detail: "Lease fenced; the native supervisor's shutdown and process-tree proof is pending." } : null;
  }
  /** Storage marker check for lease cleanup; the marker binds the full pinned assignment. */
  ownsStorage(machine: RecordValue, image: RecordValue, storage: string): boolean {
    const owner = readJson(path.join(storage, "canaveral-owner.json")), binding = this.binding(machine, image);
    return !!owner && owner.fingerprint === digest(binding) && canonical(owner.binding) === canonical(binding);
  }
  /** Cleanup stop: fence the supervisor and report stopped only on positive proof. Cleanup
   * needs the supervisor helper, not the lease declaration, so withdrawing the declaration
   * never strands a lease that already ran. */
  async stopForCleanup(machine: RecordValue, _image: RecordValue, _folder: string): Promise<RecordValue> {
    this.leaseHelper();
    const storage = this.leaseStorage(machine);
    if (!fs.existsSync(storage)) return { state: "stopped" };
    if (await this.leaseStopped(machine, storage)) { this.supervisors.delete(uuid(machine.id)); return { state: "stopped" }; }
    this.fenceLease(storage);
    return { state: "stopping" };
  }
  /** Deletes every simulator of the lease's private device set through CoreSimulator. Nothing
   * else ever creates a device there, so a device with another name means the set is not what
   * this lease made, and removal is refused instead. */
  private async emptyDeviceSet(machine: RecordValue, storage: string): Promise<void> {
    const scope = this.leaseScope(storage);
    if (!fs.existsSync(scope.set)) return;
    await this.scope.run(scope, async () => {
      let devices: { runtime: string; device: RecordValue }[];
      try { devices = await this.inventory(); } catch { throw new ServiceError("The lease's device set could not be listed; removal is retried.", 409, { code: "storage_removal" }); }
      for (const { device } of devices) {
        if (device.name !== this.name(machine) || typeof device.udid !== "string") throw ownership("The lease's device set holds a simulator it did not create; removal is refused.");
        if (device.state !== "Shutdown") throw new ServiceError("Leased simulator shutdown is unconfirmed.", 409, { code: "execution_pending" });
      }
      try {
        for (const { device } of devices) await this.simctl(["delete", device.udid as string]);
        if ((await this.inventory()).length) throw new Error("devices remain");
      } catch { throw new ServiceError("Leased simulator deletion is unconfirmed.", 409, { code: "storage_removal" }); }
    });
  }
  /** Removes a leased assignment only for its own terminal lease, after positive stop proof:
   * the simulator is deleted through CoreSimulator, then the whole storage (device set,
   * companion socket, logs and receipts) through the recoverable quarantine path. */
  private async removeLeasedStorage(machine: RecordValue, image: RecordValue, folder: string, requestId: string): Promise<RecordValue> {
    const id = uuid(machine.id), request = uuid(requestId), fingerprint = this.deletionFingerprint(machine, image);
    const assignment = readJson(path.join(folder, "assignment.json")), lease = object(machine.lease);
    if (machine.desired !== "stopped" || assignment?.fingerprint !== assignmentFingerprint(machine) || (assignment.leaseId ?? null) !== uuid(lease.id) ||
      !["released", "expired", "failed"].includes(String(lease.state))) throw ownership("Leased simulator removal requires its own terminal lease and a stopped assignment.");
    const root = text(this.config.storage, "storage"), storage = path.join(root, id), quarantine = path.join(root, `.removing-${id}-${request}`), receipt = path.join(folder, "deletion.json");
    const identity = (file: string): string | null => {
      const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      return stat ? stat.dev + "/" + stat.ino : null;
    };
    privateDirectory(root);
    let journal = readJson(receipt);
    if (!journal) {
      if (identity(quarantine)) throw new ServiceError("Simulator removal quarantine is already occupied.", 409, { code: "recovery" });
      this.leaseHelper();
      let stopped: boolean;
      try { stopped = await this.leaseStopped(machine, storage); } catch { stopped = false; }
      if (!stopped) throw new ServiceError("Leased simulator stop is unconfirmed.", 409, { code: "execution_pending" });
      await this.emptyDeviceSet(machine, storage);
      journal = { id: request, machineId: id, fingerprint, storageIdentity: identity(storage), state: "removing" };
      saveJson(receipt, journal);
    }
    if (journal.id !== request || journal.machineId !== id || journal.fingerprint !== fingerprint || !["removing", "complete"].includes(String(journal.state)) ||
      typeof journal.storageIdentity !== "string") throw ownership("Simulator deletion receipt belongs to another assignment or request.");
    const remaining = identity(storage), staged = identity(quarantine);
    if ((remaining && (remaining !== journal.storageIdentity || staged)) || (staged && staged !== journal.storageIdentity) || (journal.state === "complete" && (remaining || staged)))
      throw new ServiceError("Simulator storage changed during removal.", 409, { code: "recovery" });
    try {
      if (remaining) fs.renameSync(storage, quarantine);
      if (identity(quarantine)) fs.rmSync(quarantine, { recursive: true });
      if (identity(storage) || identity(quarantine)) throw new Error("storage remains");
      const fd = fs.openSync(root, fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { throw new ServiceError("Simulator removal remains incomplete.", 409, { code: "storage_removal" }); }
    if (journal.state !== "complete") saveJson(receipt, { ...journal, state: "complete" });
    return { id: request, machineId: id, state: "complete" };
  }
}
