/** Xcode simulator lifecycle and idb control, always bound to one owned UDID. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ServiceError, object } from "../errors.ts";
import { MobileProvider, MAX_OUTPUT, atomicUpload, authorized, confined, containerParts, decodeData, digest, encoded, locked, operationRequest, readJson, readRegular, saveJson, text, unsupported, uuid } from "./mobile.ts";
import type { Authorized, ByteReader, DeviceRequest, Download, RecordValue, RunOptions } from "./mobile.ts";

export class IosProvider extends MobileProvider {
  override readonly kind = "ios";
  async simctl(args: readonly string[], options: Partial<RunOptions> = {}): Promise<string> { return this.runText([String(this.config.xcrun ?? "xcrun"), "simctl", ...args], options); }
  idbEnvironment(): Record<string, string> {
    const env = this.environment();
    for (const key of Object.keys(env)) if (key.startsWith("IDB_")) delete env[key];
    return env;
  }
  async idb(udid: string, args: readonly string[]): Promise<string> {
    return this.runText([String(this.config.idb ?? "idb"), ...args, "--udid", uuid(udid)], { env: this.idbEnvironment() });
  }
  async inventory(): Promise<{ runtime: string; device: RecordValue }[]> {
    const devices = object(object(JSON.parse(await this.simctl(["list", "devices", "--json"]))).devices), result = [];
    for (const [runtime, entries] of Object.entries(devices)) {
      if (!Array.isArray(entries)) throw new ServiceError("Malformed simulator inventory.");
      for (const entry of entries) result.push({ runtime, device: object(entry) });
    }
    return result;
  }
  async check(): Promise<unknown> {
    if ((this.config.hostPlatform ?? process.platform) !== "darwin") throw new ServiceError("iOS simulators require native macOS with Xcode.");
    const images = this.checkTemplates("ios");
    if (!this.transport?.executableAvailable) unsupported("iOS executable preflight adapter is not configured.");
    for (const executable of [String(this.config.idb ?? "idb"), "idb_companion"]) if (!await this.transport.executableAvailable(executable)) throw new ServiceError("Install idb and idb_companion before offering iOS devices.");
    const runtimes = object(JSON.parse(await this.simctl(["list", "runtimes", "--json"]))).runtimes, types = object(JSON.parse(await this.simctl(["list", "devicetypes", "--json"]))).devicetypes;
    if (!Array.isArray(runtimes) || !Array.isArray(types)) throw new ServiceError("Malformed simulator runtime inventory.");
    const available = new Set(runtimes.map(object).filter(r => r.isAvailable === true).map(r => r.identifier)), deviceTypes = new Set(types.map(object).map(t => t.identifier));
    for (const image of images) { const device = object(image.device); if (!available.has(device.runtime) || !deviceTypes.has(device.deviceType)) throw new ServiceError("Install every offered iOS runtime and device type before offering it."); }
    return { ready: true, nativeAcceptance: false, resourceLimits: "scheduling-reservations-only" };
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
  async reconcile(machine: RecordValue, image: RecordValue, _folder: string): Promise<RecordValue> {
    this.executionAllowed(machine);
    const storage = this.storage(machine, image);
    return locked(path.join(storage, "assignment.lock"), async () => {
      if (machine.desired !== "running" && machine.desired !== "stopped") throw new ServiceError("Invalid desired mobile state.", 400);
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
  private async ready(machine: RecordValue, image: RecordValue): Promise<string> {
    this.executionAllowed(machine);
    const device = await this.owned(machine, image, this.storage(machine, image));
    if (!device || device.state !== "Booted") throw new ServiceError("iOS simulator is not booted.");
    return uuid(device.udid);
  }
  async containerRoot(udid: string, app: unknown): Promise<string> {
    const bundle = text(app, "app bundle ID");
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(bundle)) throw new ServiceError("Choose an app bundle ID.", 400);
    const root = await this.simctl(["get_app_container", uuid(udid), bundle, "data"]);
    if (!path.isAbsolute(root) || root.includes("\0")) throw new ServiceError("Simulator returned an invalid data container.");
    return root;
  }
  override async displayDensity(machine: RecordValue, image: RecordValue): Promise<number> {
    const id = await this.ready(machine, image), info = object(JSON.parse(await this.idb(id, ["describe", "--json"]))), screen = object(info.screen_dimensions ?? {}), density = screen.density;
    if (typeof density !== "number" || !Number.isFinite(density) || density <= 0) throw new ServiceError("iOS display scale is unavailable; refusing imprecise input.");
    return density;
  }
  override async control(machine: RecordValue, image: RecordValue, folder: string, input: DeviceRequest): Promise<RecordValue> {
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
    } else if (action === "text") return { output: await this.runText([String(this.config.idb ?? "idb"), "ui", "text", "--udid", id, "--", args.text as string], { env: this.idbEnvironment() }) };
    else if (action === "key") argv = ["ui", /^[0-9]+$/.test(args.key as string) ? "key" : "button", String(args.key)];
    else if (action === "hierarchy") argv = ["ui", "describe-all", "--json"];
    else if (action === "rotate") argv = ["ui", "rotate", String(args.orientation)];
    else if (action === "permission") return { output: await this.simctl(["privacy", id, String(args.state), String(args.permission), String(args.app)]) };
    else if (action === "apps") return { output: await this.simctl(["listapps", id]) };
    else if (action === "install") return { output: await this.simctl(["install", id, this.artifact(args.artifact)]) };
    else if (["launch", "terminate", "uninstall"].includes(action)) {
      if ((args.app as string).includes("/")) throw new ServiceError("iOS operations require an app bundle ID.", 400);
      return { output: await this.simctl([action, id, args.app as string]) };
    } else if (action === "open-url") return { output: await this.simctl(["openurl", id, args.url as string]) };
    else if (action === "location") return { output: await this.simctl(["location", id, "set", `${args.latitude},${args.longitude}`]) };
    else if (action === "logs") return { output: await this.simctl(["spawn", id, "log", "show", "--last", "1m", "--style", "compact"]) };
    else return unsupported("iOS supports app, file and UI actions; shell/accessibility require a supported shared adapter.");
    return { output: await this.idb(id, argv) };
  }
  async streamUpload(machine: RecordValue, image: RecordValue, _folder: string, relative: string, app: string | null | undefined, reader: ByteReader, size: number, check: Authorized): Promise<RecordValue> {
    await authorized(check); containerParts(relative);
    const id = await this.ready(machine, image), root = await this.containerRoot(id, app);
    const recheck = async () => { await authorized(check); if (await this.ready(machine, image) !== id || await this.containerRoot(id, app) !== root) throw new ServiceError("App container identity changed."); await authorized(check); return true; };
    return confined(this.transport?.files, root, relative, (parent, name) => atomicUpload(parent, name, reader, size, recheck));
  }
  async streamDownload(machine: RecordValue, image: RecordValue, _folder: string, relative: string, app?: string | null, check: Authorized = () => true): Promise<Download> {
    await authorized(check); containerParts(relative);
    const id = await this.ready(machine, image), root = await this.containerRoot(id, app);
    const source = await confined(this.transport?.files, root, relative, (parent, name) => parent.download(name));
    // The adapter's returned download owns its descriptor independently of the directory handle.
    return { size: source.size,
      read: async count => { await authorized(check); const result = await source.read(count); await authorized(check); return result; },
      verify: async () => { await authorized(check); if (await this.ready(machine, image) !== id || await this.containerRoot(id, app) !== root || await source.verify() !== true) throw new ServiceError("Download identity changed."); await authorized(check); return true; },
      close: () => source.close(),
    };
  }
}
