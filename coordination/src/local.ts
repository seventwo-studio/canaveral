/** Isolated local orchestration and authorization-fenced attached-host connectors. */
import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError, expandPath, option, privateInput, privateOutput, record, removeSameFile, uuid } from "./account-cli.ts";
import type { CliArguments } from "./account-cli.ts";
import type { CliIO, CliService } from "./cli.ts";
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
async function exported(name: string, fn: string): Promise<(...args: never[]) => unknown> {
  const module = await import(new URL(name, import.meta.url).href) as Record<string, unknown>;
  if (typeof module[fn] !== "function") throw new CliError(`This build does not expose ${fn}; native execution remains unavailable.`, 503);
  return module[fn] as (...args: never[]) => unknown;
}
function numberOption(args: CliArguments, name: string, fallback: number, min: number, max: number): number { const text = option(args, name, String(fallback)), value = Number(text); if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw new CliError(`Invalid --${name}.`); return value; }
async function exists(path: string): Promise<boolean> { try { await fs.lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function jsonFile(path: string): Promise<Record<string, unknown>> { const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); try { const info = await file.stat(); if (!info.isFile() || info.size > 1048576) throw new CliError("Local configuration requires a bounded regular JSON file."); return record(JSON.parse(await file.readFile("utf8")) as unknown); } finally { await file.close(); } }
async function stopped(signal: AbortSignal): Promise<void> { if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })); }
async function localConfig(root: string, args: CliArguments, url: string): Promise<{ config: Record<string, unknown>; state: string } | undefined> {
  const physical = join(root, "machine-host.json");
  if (await exists(physical)) {
    const config = loadHost(await jsonFile(physical), root);
    if (typeof config.agentStateDirectory !== "string") throw new CliError("Local physical host config requires agentStateDirectory.");
    return { config, state: resolve(root, config.agentStateDirectory) };
  }
  const androidPath = join(root, "host.json");
  if (args.options["android-sdk"] && !await exists(androidPath)) {
    const sdk = resolve(expandPath(option(args, "android-sdk")));
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
    if (!arch) throw new CliError("Unsupported local Android host architecture.");
    const abi = arch === "arm64" ? "arm64-v8a" : "x86_64";
    const images: string[] = [];
    const systems = join(sdk, "system-images");
    if (await exists(systems)) {
      for (const platform of await fs.readdir(systems)) {
        const platformPath = join(systems, platform); if (!(await fs.stat(platformPath)).isDirectory()) continue;
        for (const vendor of await fs.readdir(platformPath)) {
          const image = join(platformPath, vendor, abi);
          if (await exists(image) && (await fs.stat(image)).isDirectory()) images.push(join("system-images", platform, vendor, abi));
        }
      }
    }
    const image = images.sort().at(-1);
    if (!image) throw new CliError("No installed Android system image for this host architecture. Install one or omit --android-sdk.");
    await privateOutput(androidPath, async write => write(JSON.stringify({ name: "local-android", provider: "android", pollIntervalSeconds: 0.25,
      capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 64 }, androidSDK: sdk, storage: join(root, "devices"),
      templates: [{ id: "local-android", revision: "1", os: "android", mode: "device", arch, device: { systemImage: image.split(/[\\/]/).join(";"), profile: "pixel_8" }, minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }],
    }, null, 2) + "\n"));
  }
  const linuxPath = join(root, "linux-host.json");
  if (args.options["linux-image"] && !await exists(linuxPath)) {
    const runner = resolve(expandPath(option(args, "apple-runner")));
    const manifestValue = args.options["guest-helper-manifest"] ?? process.env.CANAVERAL_GUEST_BUNDLE;
    if (typeof manifestValue !== "string") throw new CliError("Supply --guest-helper-manifest (or CANAVERAL_GUEST_BUNDLE) with the installed TypeScript guest bundle; local does not synthesize guest services.");
    const manifest = resolve(expandPath(manifestValue));
    const { desktopRecipe, loadHelperArtifacts } = await import("./guest/access.ts");
    const helpers = loadHelperArtifacts(manifest);
    if (!helpers.some(file => file.path === "/opt/canaveral/server.mjs" && file.content.length)) throw new CliError("The installed guest bundle must include /opt/canaveral/server.mjs.");
    const key = join(root, "desktop_ed25519");
    if (!await exists(key)) {
      if (await exists(key + ".pub")) throw new CliError("An orphaned local SSH public key exists; inspect it before generating another identity.");
      const { execFile } = await import("node:child_process");
      await new Promise<void>((done, reject) => execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { timeout: 10000, maxBuffer: 4096 }, error => error ? reject(new CliError("Local SSH identity generation failed; inspect retained key files.")) : done()));
    }
    const prepare = desktopRecipe((await fs.readFile(key + ".pub", "utf8")).trim(), helpers);
    const config = {
      name: "local-linux", provider: "apple", pollIntervalSeconds: 0.25, runner,
      storage: join(root, "linux-disks"), guestOrchestratorURL: "http://192.168.64.1:" + numberOption(args, "api-port", 8875, 1, 65535),
      guestAccess: { identityFile: key, helperManifest: manifest }, guestHelperManifest: manifest, guestPreparation: prepare,
      capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 128 },
      templates: [{ id: "ubuntu-desktop", revision: "1", os: "linux", mode: "desktop", arch: "arm64", image: resolve(expandPath(option(args, "linux-image"))), guestAccess: true,
        minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 32 }, memoryStepMiB: 1024, prepare }],
    };
    await privateOutput(linuxPath, async write => write(JSON.stringify(config, null, 2) + "\n"));
  }
  const configs: Array<{ path: string; config: Record<string, unknown>; state: string }> = [];
  for (const [path, state] of [[androidPath, join(root, "agent")], [linuxPath, join(root, "linux-agent")]] as const) {
    if (await exists(path)) configs.push({ path, config: loadHost(await jsonFile(path), root), state });
  }
  if (!configs.length) return undefined;
  // Never re-enroll or silently discard a legacy identity during consolidation.
  const identities: Array<{ state: string; id: string }> = [];
  for (const entry of configs) if (await exists(join(entry.state, "identity.json"))) { const identity = await jsonFile(join(entry.state, "identity.json")); if (identity.orchestrator !== url) throw new CliError("Local runtime state belongs to another controller."); identities.push({ state: entry.state, id: uuid(String(identity.id)) }); }
  const capacity: Record<string, number> = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
  const runtimes: Record<string, unknown> = {}; const templates: unknown[] = []; const offered: string[] = [];
  for (const { config, state } of configs) {
    const provider = String(config.provider);
    runtimes[provider] = { ...Object.fromEntries(Object.entries(config).filter(([key]) => !["name", "provider", "capacity", "templates", "pollIntervalSeconds", "offerTemplateRevisions"].includes(key))), stateDirectory: state };
    const limits = record(config.capacity);
    for (const key of Object.keys(capacity)) { if (!Number.isSafeInteger(limits[key]) || Number(limits[key]) < 0) throw new CliError("Invalid local capacity."); capacity[key]! += Number(limits[key]); }
    if (!Array.isArray(config.templates)) throw new CliError("Invalid local templates.");
    templates.push(...config.templates);
    if (Array.isArray(config.offerTemplateRevisions)) offered.push(...config.offerTemplateRevisions.map(String));
    else offered.push(...config.templates.map(item => { const template = record(item); return `${String(template.id)}@${String(template.revision)}:${String(template.arch)}`; }));
  }
  const system = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform as "darwin" | "linux" | "win32"];
  if (!system) throw new CliError("Unsupported local host platform.");
  const state = identities[0]?.state ?? join(root, "agent");
  const guestPreparation = configs.map(entry => entry.config.guestPreparation).find(Boolean);
  const config = { ...(guestPreparation ? { guestPreparation } : {}), name: `local-${system}`, provider: system, storage: join(root, "machines"), pollIntervalSeconds: 0.25, capacity, runtimes, templates, offerTemplateRevisions: offered, agentStateDirectory: state };
  if (identities.length) await consolidateLocalHost(root, configs.map(entry => entry.state), identities, config);
  await privateOutput(physical, async write => write(JSON.stringify(config, null, 2) + "\n"));
  return { config, state };
}
export async function runLocal(args: CliArguments, io: CliIO, signal: AbortSignal): Promise<void> {
  const apiPort = numberOption(args, "api-port", 8875, 1, 65535), dashboardPort = numberOption(args, "dashboard-port", 8876, 1, 65535);
  if (apiPort === dashboardPort) throw new CliError("Use distinct valid API and dashboard ports.");
  const root = resolve(expandPath(option(args, "state", "./state/local"))); await fs.mkdir(root, { mode: 0o700, recursive: true });
  const lockPath = join(root, "local.lock");
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError("Local state is locked. Confirm the previous controller and host have stopped before recovering local.lock.", 409); throw error; }
  const lockInfo = await lock.stat(); const services: CliService[] = [];
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + "\n"); await lock.sync();
    const credentials = join(root, "credentials.json");
    if (!await exists(credentials)) await privateOutput(credentials, async write => write(JSON.stringify({ admin: randomBytes(32).toString("base64url"), enrollment: randomBytes(32).toString("base64url"), controllerId: randomUUID() }) + "\n"));
    // Credentials JSON is private input too; unlike token files it has a structured payload.
    const credentialFile = await fs.open(credentials, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let tokens: Record<string, unknown>;
    try {
      const info = await credentialFile.stat();
      if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new CliError("Local credentials must be a private regular file owned by you.");
      tokens = record(JSON.parse(await credentialFile.readFile("utf8")) as unknown);
    } finally { await credentialFile.close(); }
    const controllerIdFile = join(root, "controller-id");
    if (args.options["controller-id"]) {
      const selected = uuid(option(args, "controller-id"));
      if (tokens.controllerId && tokens.controllerId !== selected) throw new CliError("Explicit controller ID conflicts with local credentials.");
      if (await exists(controllerIdFile)) { if ((await fs.readFile(controllerIdFile, "utf8")).trim() !== selected) throw new CliError("Explicit controller ID conflicts with persisted local identity."); }
      else await privateOutput(controllerIdFile, async write => write(selected + "\n"));
    }
    if (!tokens.controllerId && !await exists(controllerIdFile)) {
      if (await exists(join(root, "controller.sqlite3"))) throw new CliError("Existing local controller state requires an explicit persisted controller-id; identity will not be guessed.");
      await privateOutput(controllerIdFile, async write => write(randomUUID() + "\n"));
    }
    const controllerId = uuid(typeof tokens.controllerId === "string" ? tokens.controllerId : (await fs.readFile(controllerIdFile, "utf8")).trim());
    for (const [key, name] of [["admin", "admin.token"], ["enrollment", "enrollment.token"]]) {
      const value = tokens[key!]; if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new CliError("Invalid local credential file.");
      const destination = join(root, name!);
      if (await exists(destination)) { if (await privateInput(destination) !== value) throw new CliError("Local credential files disagree; no credentials were replaced."); }
      else await privateOutput(destination, async write => write(value + "\n"));
    }
    const url = `http://127.0.0.1:${apiPort}`;
    const local = await localConfig(root, args, url);
    services.push(await io.runtime.controller({ statePath: join(root, "controller.sqlite3"), adminTokenFile: join(root, "admin.token"), enrollmentTokenFile: join(root, "enrollment.token"), controllerId, listen: { host: "127.0.0.1", port: apiPort } }));
    const attachedHosts: LocalAttachedHost[] = [];
    if (local) {
      const host = await io.runtime.host({ config: local.config, configDirectory: root, stateDirectory: local.state, controllerUrl: url, enrollmentToken: String(tokens.enrollment), allowHttp: true, signal });
      services.push(host); attachedHosts.push(host as LocalAttachedHost);
    }
    const store = new SqliteStore(join(root, "controller.sqlite3"));
    const connectors = createLocalConnectors({ store, signal, hosts: () => attachedHosts, machine: id => store.transaction(db => {
      const row = db.prepare("SELECT * FROM machines WHERE id=?").get(uuid(id));
      if (!row) return undefined;
      const host = attachedHosts.find(host => host.identity?.id === row.host);
      const assignment = host?.assignments.find(machine => machine.id === id);
      return { ...assignment, ...record(JSON.parse(String(row.request)) as unknown), id: String(row.id), template: record(JSON.parse(String(row.template)) as unknown), hostId: row.host, desired: row.desired, observed: row.observed };
    }) });
    services.push(await io.runtime.dashboard({ listen: { host: "127.0.0.1", port: dashboardPort }, controllerUrl: url, allowHttp: true, bootstrapToken: tokens.admin, connectors }));
    io.stdout(JSON.stringify({ dashboard: `http://127.0.0.1:${dashboardPort}`, state: root, hostConfigured: Boolean(local) }) + "\n");
    await stopped(signal);
  } finally {
    let failed = false;
    for (const service of services.reverse()) try { await service.close(); } catch { failed = true; }
    await lock.close();
    if (!failed) await removeSameFile(lockPath, lockInfo);
    if (failed) throw new CliError("Local shutdown was not confirmed. Retained local.lock; inspect running services before recovery.", 503, undefined, "unknown");
    io.stderr("Local services stopped. Machine disks and running devices are retained; stop machines before shutting down.\n");
  }
}

import { ServiceError } from "./errors.ts";
import { SqliteStore } from "./sqlite.ts";
import { assignmentAccess, contactFresh, StateLock } from "./runtime-process.ts";
import { ImageLibrary, ImagesController, specification } from "./control/images.ts";
import { enabledRuntimes, legacyDigest, loadHost, normalizeOperatorTemplate as normalizeTemplate, runtimeFor } from "./control/templates.ts";
import type { DashboardConnectors, DownloadSource, StreamAttachment } from "./dashboard.ts";
import type { ByteReader } from "./control/transfers.ts";
import type { DisplayConnection, BootEpoch } from "./guest/display.ts";
import type { DeviceRequest } from "./providers/mobile.ts";

type Json = Record<string, unknown>;
type Check = () => boolean;
interface LocalAccess {
  control(machine: Json, image: Json, folder: string, request: Json): Promise<Json>;
  streamUpload?(machine: Json, image: Json, folder: string, path: string, app: string | undefined, reader: ByteReader, size: number, authorized: Check): Promise<Json>;
  streamDownload?(machine: Json, image: Json, folder: string, path: string, app: string | undefined, authorized: Check): Promise<{ size: number; read(n: number): Promise<Uint8Array>; verify(): boolean | void | Promise<boolean | void>; close(): void | Promise<void> }>;
  desktop?(machine: Json, image: Json, folder: string): Promise<DisplayConnection>;
}
export interface LocalRuntime extends Partial<LocalAccess> {
  kind: string;
  config?: Json;
  operate?(machine: Json, image: Json, folder: string, operation: Json, check?: Check, handler?: (request: DeviceRequest) => Promise<Json>): Promise<{ state: "succeeded" | "failed" | "unknown"; result?: unknown }>;
  operationReceipt?(machine: Json, image: Json, id: string): { state: "succeeded" | "failed" | "unknown"; result?: unknown };
  displayEpoch?(machine: Json, image: Json, folder?: string): Json | null | undefined | Promise<Json | null | undefined>;
  displayDensity?(machine: Json, image: Json): Promise<number>;
  access?: LocalAccess;
}
export interface LocalAttachedHost extends CliService {
  state: string; config: Json; offer: Json;
  identity?: { id: string; credential: string; orchestrator: string } | undefined;
  assignments: Json[]; lastContact: number;
  clock: { now(): number; readonly suspendAware?: boolean };
  guard: { allowed(id: string): boolean; beginExecution(id: string, leaseId: string): void };
  readonly stopping?: boolean;
  readonly guestAccess?: LocalAccess | undefined;
  context(machine: Json): { runtime: LocalRuntime; image: Json; folder: string };
  refreshImages?(): void;
  importImage?(metadata: Json, source: ByteReader, size: number, authorized: Check): Promise<Json>;
  imageImportSettings?(metadata: Json): Promise<{ metadata: Json; prepare?: Json; memoryStep?: number }> | { metadata: Json; prepare?: Json; memoryStep?: number };
}
export interface LocalConnectorOptions {
  hosts(): readonly LocalAttachedHost[];
  machine(id: string): Json | undefined;
  store: SqliteStore;
  signal: AbortSignal;
  /** Tests can inject the socket adapter while retaining all local authorization gates. */
  attachDisplay?(attachment: StreamAttachment, factory: () => Promise<DisplayConnection>, attached: AttachedContext, check: Check): Promise<void>;
  attachShell?(attachment: StreamAttachment, control: (request: Json) => Promise<Json>, check: Check): Promise<void>;
}
export interface AttachedContext { host: LocalAttachedHost; machine: Json; runtime: LocalRuntime; image: Json; folder: string }

/** Acquire the assignment guard until the returned stream is closed, including verification. */
async function holdAssignment(machine: Json, folder: string): Promise<() => Promise<void>> {
  let release!: () => void, ready!: () => void;
  const retained = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  const holding = assignmentAccess(machine, folder, async () => { ready(); await retained; });
  await Promise.race([acquired, holding]);
  let closed = false;
  return async () => { if (!closed) { closed = true; release(); } await holding; };
}
export function createLocalConnectors(options: LocalConnectorOptions): DashboardConnectors {
  const libraries = new Map<LocalAttachedHost, ImageLibrary>();
  const images = new ImagesController(options.store);
  const library = (host: LocalAttachedHost) => { let current = libraries.get(host); if (!current) { current = new ImageLibrary(host.state); libraries.set(host, current); } return current; };
  function liveHost(host: LocalAttachedHost): boolean { return !options.signal.aborted && host.stopping !== true && contactFresh(host.lastContact, host.clock.now()); }
  function attached(id: string, established = false): AttachedContext {
    id = uuid(id); const machine = options.machine(id);
    const host = options.hosts().find(current => machine && current.identity?.id === machine.hostId);
    if (!machine || !host || !liveHost(host) || machine.desired !== "running" || (!established && machine.observed !== "running")) throw new ServiceError("Environment is not running on an attached, connected host.", 409);
    // HostRunner.context also verifies its immutable local template against the controller assignment.
    if (!host.guard.allowed(id)) throw new ServiceError("Lease execution is fenced.", 410);
    if (machine.lease) host.guard.beginExecution(id, uuid(String(record(machine.lease).id)));
    return { host, machine, ...host.context(machine) };
  }
  function still(context: AttachedContext): boolean {
    try {
      const current = attached(String(context.machine.id), true);
      return current.host === context.host && current.folder === context.folder && legacyDigest(current.machine.template) === legacyDigest(context.machine.template);
    } catch { return false; }
  }
  function backend(context: AttachedContext): LocalAccess | LocalRuntime {
    const { runtime, host, image } = context;
    return runtime.access ?? (image.guestAccess ? host.guestAccess : undefined) ?? runtime;
  }
  async function control(context: AttachedContext, request: Json, check: Check): Promise<Json> {
    if (!check()) throw new ServiceError("Attached environment authorization ended.", 410);
    const access = backend(context);
    if (!access.control) throw new ServiceError("This runtime has no attached guest control adapter.", 409, { code: "capability_unsupported" });
    const result = await assignmentAccess(context.machine, context.folder, () => access.control!(context.machine, context.image, context.folder, request));
    if (!check()) throw new ServiceError("Authorization ended during guest control; inspect before retrying.", 410, { outcome: "unknown", retryable: false });
    return result;
  }
  async function displayFactory(context: AttachedContext, check: Check): Promise<DisplayConnection> {
    const access = backend(context);
    if (access.desktop) return access.desktop(context.machine, context.image, context.folder);
    if (!["android", "ios"].includes(String(context.image.os)) || !context.runtime.control || !context.runtime.displayDensity) throw new ServiceError("This provider has no display connection.", 409, { code: "capability_unsupported" });
    const { SimulatorScreen } = await import("./providers/mobile.ts");
    const screen = new SimulatorScreen({ control: (m, i, f, r) => context.runtime.control!(m, i, f, r as unknown as Json), displayDensity: (m, i) => context.runtime.displayDensity!(m, i) }, context.machine, context.image, context.folder, check);
    return simulatorConnection(screen, check);
  }
  return {
    upload: {
      check(id) { try { const context = attached(id, true); return typeof backend(context).streamUpload === "function"; } catch { return false; } },
      async write(request) {
        const context = attached(request.machineId), access = backend(context);
        if (!access.streamUpload) throw new ServiceError("This provider has no streaming file connection.", 409);
        let allowed = await request.authorized();
        const check = () => allowed && still(context);
        const guardedReader: ByteReader = { async read(n) { allowed = await request.authorized(); if (!check()) throw new ServiceError("Upload authorization ended.", 401); const data = await request.reader.read(n); allowed = await request.authorized(); if (!check()) throw new ServiceError("Upload authorization ended during read.", 401); return data; } };
        return assignmentAccess(context.machine, context.folder, () => access.streamUpload!(context.machine, context.image, context.folder, request.path, request.app, guardedReader, request.size, check));
      },
    },
    download: {
      check(id) { try { const context = attached(id, true); return typeof backend(context).streamDownload === "function"; } catch { return false; } },
      async open(id, path, app): Promise<DownloadSource> {
        const context = attached(id), access = backend(context);
        if (!access.streamDownload) throw new ServiceError("This provider has no streaming download connection.", 409);
        const check = () => still(context), release = await holdAssignment(context.machine, context.folder);
        try {
          const source = await access.streamDownload(context.machine, context.image, context.folder, path, app, check);
          return { size: source.size,
            async read(n) { if (!check()) throw new ServiceError("Download authorization ended.", 410); const data = await source.read(n); if (!check()) throw new ServiceError("Download authorization ended during read.", 410); return data; },
            async verify() { if (!check() || await source.verify() === false || !check()) throw new ServiceError("Download source identity changed or authorization ended.", 409); },
            async close() { try { await source.close(); } finally { await release(); } },
          };
        } catch (error) { await release(); throw error; }
      },
    },
    async accessibility(id) {
      const context = attached(id), check = () => still(context), access = backend(context);
      const { inspectProvider } = await import("./accessibility-sdk.ts");
      if (!access.control) throw new ServiceError("This provider has no accessibility connection.", 409);
      return assignmentAccess(context.machine, context.folder, async () => {
        const result = await inspectProvider({ control: (m, i, _f, r) => control(context, { id: randomUUID(), ...r }, check) }, context.machine, context.image, context.folder, false, context.host.clock.suspendAware ? () => context.host.clock.now() : undefined);
        if (!check()) throw new ServiceError("Accessibility authorization ended during inspection.", 410);
        return result;
      });
    },
    desktop: {
      check(id) { try { const context = attached(id, true); return context.image.mode !== "headless" && (typeof backend(context).desktop === "function" || ["android", "ios"].includes(String(context.image.os))); } catch { return false; } },
      async attach(request) {
        const context = attached(request.machineId), check = () => !request.signal.aborted && still(context);
        const release = await holdAssignment(context.machine, context.folder);
        try {
          const factory = () => displayFactory(context, check);
          if (options.attachDisplay) await options.attachDisplay(request, factory, context, check);
          else await attachLocalDisplay(request, factory, context, check);
        } finally { await release(); }
      },
    },
    shell: {
      check(id) { try { const context = attached(id, true); return (context.image.os === "android" || context.image.guestAccess === true) && typeof backend(context).control === "function"; } catch { return false; } },
      async attach(request) {
        const context = attached(request.machineId, true), check = () => !request.signal.aborted && still(context);
        const action = (operation: Json) => control(context, operation, check);
        const release = await holdAssignment(context.machine, context.folder);
        try {
          if (options.attachShell) await options.attachShell(request, action, check);
          else { const { attachShell } = await import("./guest/server.ts"); await attachShell(request, action, check); }
        } finally { await release(); }
      },
    },
    imageImport: {
      check(hostId) { return options.hosts().some(host => host.identity?.id === hostId && liveHost(host)); },
      async write(request) {
        const host = options.hosts().find(host => host.identity?.id === request.hostId && liveHost(host));
        if (!host) throw new ServiceError("Image host is not attached and connected.", 409);
        const spec = specification(request.metadata);
        const settings = host.importImage ? { metadata: spec } : host.imageImportSettings ? await host.imageImportSettings(spec) : await importSettings(host, spec);
        let allowed = await request.authorized();
        const check = () => allowed && liveHost(host);
        const guarded: ByteReader = { async read(n) { allowed = await request.authorized(); if (!check()) throw new ServiceError("Image import authorization ended.", 403); const data = await request.reader.read(n); allowed = await request.authorized(); if (!check()) throw new ServiceError("Image import authorization ended during read.", 403); return data; } };
        const current = library(host);
        images.reserveImageImport(request.hostId, settings.metadata, request.size);
        try {
          const result = host.importImage ? await host.importImage(settings.metadata, guarded, request.size, check) : await current.importStream(settings.metadata, guarded, request.size, check, { ...("prepare" in settings && settings.prepare ? { prepare: settings.prepare } : {}), ...("memoryStep" in settings && settings.memoryStep ? { memoryStep: settings.memoryStep } : {}) });
          allowed = await request.authorized();
          if (!check()) throw new ServiceError("Image import publication authorization ended; inspect its task.", 409, { outcome: "unknown", retryable: false });
          images.finishImageImport(String(result.id), request.hostId, result);
          current.acknowledge({ [String(result.id)]: String(result.sha256) });
          refreshImages(host, current);
          return result;
        } catch (error) {
          const published = current.publicRecords().some(record => record.id === spec.id);
          if (error instanceof ServiceError && [400, 403].includes(error.status) && !published) images.finishImageImport(spec.id, request.hostId, undefined, true);
          throw error;
        }
      },
    },
  };
}

async function importSettings(host: LocalAttachedHost, metadata: Json): Promise<{ metadata: Json; memoryStep: number; prepare?: Json }> {
  const spec = specification(metadata), provider = String(host.config.provider);
  const runtime = ["macos", "linux", "windows"].includes(provider) ? runtimeFor(host.config, spec) : provider;
  const supported: Record<string, string[]> = { apple: ["linux", "macos"], libvirt: ["linux", "windows"], hyperv: ["linux", "windows"] };
  if (!supported[runtime]?.includes(spec.os)) throw new ServiceError("This runtime cannot provision the selected image OS.", 409);
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "unsupported";
  if (spec.arch !== architecture) throw new ServiceError("Image architecture must match this native host.", 400);
  if (runtime === "apple") {
    if (spec.minimum.memoryMiB % 1024) throw new ServiceError("Apple VM memory must use whole GiB.", 400);
    if (spec.os === "macos" && spec.format !== "ipsw") throw new ServiceError("Installed macOS disks also require their platform artifacts; import a restore image.", 409);
    if (spec.os === "linux" && !["iso", "raw", "qcow2"].includes(spec.format)) throw new ServiceError("Apple Linux VMs require ISO, raw or standalone QCOW2 images.", 400);
  }
  if (runtime === "hyperv" && spec.format !== "vhdx") throw new ServiceError("Hyper-V import requires an installed VHDX disk.", 409);
  if (spec.guestAccess) {
    const settings = ["macos", "linux", "windows"].includes(provider) ? { ...host.config, ...enabledRuntimes(host.config)[runtime] } : host.config;
    const guest = record(settings.guestAccess);
    if (typeof guest.identityFile !== "string") throw new ServiceError("Configure the Linux guest-access identity before importing an automatic guest-access image.", 409);
    const { guestRecipe } = await import("./guest/access.ts");
    const helpers = await loadLocalGuestHelpers(settings);
    return { metadata: spec, memoryStep: runtime === "apple" ? 1024 : 1, prepare: guestRecipe((await fs.readFile(guest.identityFile + ".pub", "utf8")).trim(), spec.mode, helpers) as unknown as Json };
  }
  return { metadata: spec, memoryStep: runtime === "apple" ? 1024 : 1 };
}
async function loadLocalGuestHelpers(config: Json): Promise<Array<{ path: string; mode: string; content: string }>> {
  const value = config.guestHelperFiles ?? record(config.guestAccess ?? {}).helperFiles;
  if (!Array.isArray(value)) throw new ServiceError("Configure guestHelperFiles with the installed TypeScript guest service bundle before automatic desktop preparation.", 409, { code: "capability_unsupported" });
  return value.map(item => { const file = record(item); if (typeof file.path !== "string" || typeof file.content !== "string" || typeof file.mode !== "string") throw new ServiceError("Invalid installed guest helper artifact.", 400); return { path: file.path, content: file.content, mode: file.mode }; });
}
function refreshImages(host: LocalAttachedHost, library: ImageLibrary): void {
  if (host.refreshImages) { host.refreshImages(); return; }
  const installed = host.config.templates;
  if (!Array.isArray(installed) || !Array.isArray(host.offer.templates)) throw new ServiceError("Attached host has no mutable installed image catalogue.", 409);
  for (const definition of library.definitions()) {
    const previous = installed.find(item => { const image = record(item); return image.id === definition.id && image.revision === definition.revision && image.arch === definition.arch; });
    if (previous) { if (legacyDigest(normalizeTemplate(previous)) !== legacyDigest(normalizeTemplate(definition))) throw new ServiceError("Local image catalogue conflicts with an installed immutable definition.", 409); continue; }
    installed.push(definition); host.offer.templates.push(normalizeTemplate(definition));
  }
}

/** A bounded pair of private in-memory byte queues for the simulator's RFB adapter. */
async function simulatorConnection(screen: import("./providers/mobile.ts").SimulatorScreen, check: Check): Promise<DisplayConnection> {
  class Queue {
    data: Buffer = Buffer.alloc(0); dead = false; wake: (() => void) | undefined;
    push(data: Uint8Array) { if (this.dead || this.data.length + data.length > 6 * 1048576) throw new ServiceError("Simulator display backpressure exceeded.", 409); this.data = Buffer.concat([this.data, data]); this.wake?.(); }
    async read(n: number, timeout: number): Promise<Buffer | null> {
      if (!this.data.length && !this.dead) await new Promise<void>(done => { const ready = () => { clearTimeout(timer); if (this.wake === ready) this.wake = undefined; done(); }; const timer = setTimeout(ready, timeout); this.wake = ready; });
      if (!check()) throw new ServiceError("Simulator display authorization ended.", 410);
      if (!this.data.length) return this.dead ? Buffer.alloc(0) : null;
      const part = this.data.subarray(0, n); this.data = this.data.subarray(part.length); return part;
    }
    close() { this.dead = true; this.wake?.(); }
  }
  const input = new Queue(), output = new Queue(); let ended = false;
  const close = () => { ended = true; input.close(); output.close(); screen.resetInput(); };
  const serving = screen.serve({
    async read(n, timeout) { while (!ended && check()) { const value = await input.read(n, Math.min(timeout, 100)); if (value !== null) return value; } return Buffer.alloc(0); },
    async write(data) { if (!check()) throw new ServiceError("Simulator display authorization ended.", 410); output.push(data); return data.length; },
    async close() { close(); },
    async end() { input.close(); },
    async wait() { await serving; return 0; },
  }, () => { screen.resetInput(); return true; }).catch(() => { close(); });
  return { read: (n, seconds = 0.1) => output.read(n, seconds * 1000), async write(data) { if (!check()) throw new ServiceError("Simulator display authorization ended.", 410); input.push(data); }, async close() { close(); await serving; }, async cancelInput() { screen.resetInput(); return true; } };
}
const displayControls = new WeakMap<LocalAttachedHost, import("./guest/display.ts").DisplayControls>();
async function attachLocalDisplay(request: StreamAttachment, factory: () => Promise<DisplayConnection>, context: AttachedContext, check: Check): Promise<void> {
  const { DisplayControls, DisplayEndpoint } = await import("./guest/display.ts");
  const { acceptDashboardSocket } = await import("./guest/server.ts");
  const store = new SqliteStore(join(context.host.state, "local-access.sqlite"));
  store.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS local_display_actions(machine TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,report TEXT,PRIMARY KEY(machine,id))"));
  let controls = displayControls.get(context.host); if (!controls) { controls = new DisplayControls(store); displayControls.set(context.host, controls); }
  async function readEpoch(): Promise<BootEpoch> {
    const value = await context.runtime.displayEpoch?.(context.machine, context.image, context.folder);
    if (value == null) return null;
    if (typeof value.startedAt !== "number" || typeof value.identity !== "string") throw new ServiceError("Display boot identity is unavailable.", 409);
    return { startedAt: value.startedAt, identity: value.identity };
  }
  let epoch = await readEpoch(); const initial = legacyDigest(epoch);
  async function sameBoot() { epoch = await readEpoch(); if (!check() || legacyDigest(epoch) !== initial) throw new ServiceError("Display boot or authorization changed; input was not replayed.", 410); }
  const perform = async (operation: import("./control/devices.ts").OperationRequest, effect?: (request: import("./control/devices.ts").OperationRequest) => Promise<Json>) => {
    await sameBoot(); const id = uuid(operation.id), machine = String(context.machine.id);
    const fingerprint = legacyDigest({ machine: context.machine.id, template: context.machine.template, resources: context.machine.resources, epoch, operation });
    const previous = store.transaction(db => { const old = db.prepare("SELECT fingerprint,report FROM local_display_actions WHERE machine=? AND id=?").get(machine, id); if (old) { if (old.fingerprint !== fingerprint) throw new ServiceError("Display action ID belongs to another request.", 409); return old; } db.prepare("INSERT INTO local_display_actions VALUES (?,?,?,NULL)").run(machine, id, fingerprint); return undefined; });
    if (previous) return previous.report ? JSON.parse(String(previous.report)) as { state: "succeeded" | "failed" | "unknown"; result?: unknown } : { state: "unknown" as const };
    let report: { state: "succeeded" | "failed" | "unknown"; result?: unknown };
    try {
      const access = context.runtime.access ?? (context.image.guestAccess ? context.host.guestAccess : undefined) ?? context.runtime;
      if (context.runtime.operate) report = await context.runtime.operate(context.machine, context.image, context.folder, { ...operation, machineId: machine, expiresAt: Date.now() / 1000 + 30 }, check, effect ? r => effect(r) : undefined);
      else if (effect) report = { state: "succeeded", result: await effect(operation) };
      else if (access.control) report = { state: "succeeded", result: await access.control(context.machine, context.image, context.folder, operation as unknown as Json) };
      else throw new ServiceError("Display action transport is unavailable.", 409, { code: "capability_unsupported" });
      await sameBoot();
    } catch (error) { report = { state: error instanceof ServiceError && error.code === "input_rejected" ? "failed" : "unknown", result: { detail: "Display action outcome requires inspection before another request." } }; }
    store.transaction(db => db.prepare("UPDATE local_display_actions SET report=? WHERE machine=? AND id=?").run(JSON.stringify(report), machine, id)); return report;
  };
  const endpoint = new DisplayEndpoint(controls, String(context.machine.id), async () => {
    const remote = await factory();
    return { ...remote, read: async (n, seconds) => { await sameBoot(); const data = await remote.read(n, seconds); await sameBoot(); return data; }, write: async data => { await sameBoot(); await remote.write(data); await sameBoot(); }, close: () => remote.close(),
      ...(remote.cancelInput ? { cancelInput: () => remote.cancelInput!() } : {}), ...(remote.takeInput ? { takeInput: () => remote.takeInput!() } : {}), ...(remote.controlAction ? { controlAction: r => remote.controlAction!(r) } : {}) };
  }, check, { epoch: () => epoch, actionHandler: operation => perform(operation), contextActionHandler: (operation, effect) => perform(operation, effect), receiptHandler: async id => store.transaction(db => { const row = db.prepare("SELECT report FROM local_display_actions WHERE machine=? AND id=?").get(String(context.machine.id), uuid(id)); return row?.report ? JSON.parse(String(row.report)) as { state: "succeeded" | "failed" | "unknown"; result?: unknown } : { state: "unknown" }; }) });
  const channel = await acceptDashboardSocket(request, check);
  try { await endpoint.runDisplay(channel); } finally { endpoint.close(); channel.close(); }
}

/** Offline consolidation uses the same process-loss-safe locks as TypeScript hosts.
 * A historical native flock cannot be replaced by a SQLite lock: retain it for explicit migration. */
export async function consolidateLocalHost(root: string, states: string[], identities: Array<{ state: string; id: string }>, definition: Json): Promise<void> {
  if (!identities.length) return;
  const locks: StateLock[] = [];
  try {
    for (const state of states) {
      if (await exists(join(state, "agent.lock"))) throw new CliError("Legacy native runner locks require an explicit offline migration; identities and disks were retained.", 409);
      locks.push(new StateLock(join(state, "host-runner.sqlite")));
    }
    const path = join(root, "controller.sqlite3"); if (!await exists(path)) throw new CliError("Local host identities have no controller database; no host was adopted.", 409);
    const backupPath = join(root, "before-physical-host.sqlite3");
    const { DatabaseSync, backup } = await import("node:sqlite");
    if (!await exists(backupPath)) {
      const file = await fs.open(backupPath, "wx", 0o600); const info = await file.stat(); await file.close();
      const source = new DatabaseSync(path, { readOnly: true });
      try { await backup(source, backupPath); } catch (error) { await removeSameFile(backupPath, info); throw error; } finally { source.close(); }
    }
    const store = new SqliteStore(path);
    const { initializeMachines } = await import("./control/machines.ts");
    const { initializeInfrastructure, consolidateLocalRuntimes } = await import("./control/infrastructure.ts");
    const { initializeDevices } = await import("./control/devices.ts");
    const { initializeInference } = await import("./control/inference.ts");
    store.transaction(db => { initializeMachines(db); initializeInfrastructure(db); initializeDevices(db); initializeInference(db); });
    new ImagesController(store);
    const target = identities[0]!;
    consolidateLocalRuntimes(store, target.id, identities.slice(1).map(item => item.id), definition, ids => {
      if (locks.length !== states.length || ids.some(id => !identities.some(identity => identity.id === id))) throw new CliError("Local identity fencing is unavailable.", 409);
    });
  } finally { for (const lock of locks.reverse()) lock.close(); }
}
