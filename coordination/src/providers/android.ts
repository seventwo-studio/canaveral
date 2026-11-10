/** Android AVDs and transfers, scoped to immutable local assignment receipts. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ServiceError, object } from "../errors.ts";
import { MobileProvider, authorized, canonical, copyUpload, decodeData, digest, encoded, integer, locked, operationRequest, privateDirectory, publicationUncertain, readJson, readRegular, saveJson, text, unsupported, uuid, writeAll } from "./mobile.ts";
import type { Authorized, ByteReader, DeviceRequest, Download, NativeChild, NativePipe, RecordValue, RunOptions } from "./mobile.ts";

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
  async devices(): Promise<Record<string, string>> {
    const lines = (await this.runText([this.tool("adb"), "devices"])).split(/\r?\n/);
    const result: Record<string, string> = {};
    for (const line of lines.slice(1)) { const parts = line.trim().split(/\s+/); if (parts.length >= 2) result[parts[0]!] = parts[1]!; }
    return result;
  }
  async owned(machine: RecordValue, serial: string): Promise<void> {
    if ((await this.adb(serial, ["emu", "avd", "name"])).split(/\r?\n/)[0] !== this.name(machine)) throw new ServiceError("Android serial belongs to another AVD; refusing control.");
  }
  async endpoint(machine: RecordValue, storage: string, check: Authorized = () => true): Promise<string | undefined> {
    await authorized(check);
    const endpoint = readJson(path.join(storage, "endpoint.json"));
    if (!endpoint) return undefined;
    const port = integer(endpoint.port, "emulator console port", 5554, 5680);
    if (port % 2) throw new ServiceError("Invalid reserved Android console port.");
    const launch = readJson(path.join(storage, "launch.json")), owner = readJson(path.join(storage, "canaveral-owner.json"));
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
  launchArguments(machine: RecordValue, port: number): string[] {
    const resources = object(machine.resources);
    return [this.tool("emulator"), "-avd", this.name(machine), "-port", String(port), "-cores", String(integer(resources.cpu, "cpu", 1, 1024)), "-memory", String(integer(resources.memoryMiB, "memory", 1, 2 ** 30)), "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim"];
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
  async reconcile(machine: RecordValue, image: RecordValue, _folder: string): Promise<RecordValue> {
    this.executionAllowed(machine);
    const storage = this.storage(machine, image);
    return locked(path.join(storage, "assignment.lock"), async () => {
      if (machine.desired !== "running" && machine.desired !== "stopped") throw new ServiceError("Invalid desired mobile state.", 400);
      if (machine.desired === "stopped") await this.closeShells(machine);
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
  async processStopped(machine: RecordValue, storage: string): Promise<boolean> {
    const child = this.processes.get(uuid(machine.id));
    if (child) return child.stopped();
    const pid = readJson(path.join(storage, "launch.json"))?.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !this.transport?.processAbsent) return false;
    return await this.transport.processAbsent(pid as number) === true;
  }
  displayEpoch(machine: RecordValue, image: RecordValue): RecordValue | undefined {
    const launch = readJson(path.join(this.storage(machine, image), "launch.json"));
    if (!launch || launch.version !== 2 || launch.fingerprint !== digest(this.binding(machine, image))) return undefined;
    return { startedAt: launch.startedAt, identity: digest(launch) };
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
