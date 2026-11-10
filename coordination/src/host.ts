import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSecureContext } from "node:tls";
import { join, resolve } from "node:path";
import { identifier } from "./consumers.ts";
import { object, secret, ServiceError } from "./errors.ts";
import { enabledRuntimes, HOST_RUNTIMES, legacyDigest, loadHostConfig, normalizeOperatorTemplate as normalizeTemplate, resources, runtimeFor, text } from "./control/templates.ts";
import { credential, sshPreparation, userData } from "./control/preparation.ts";
import { createProvider } from "./providers/index.ts";
import type { NativeProvider } from "./providers/index.ts";
import { ImageLibrary, prepareImage, specification } from "./control/images.ts";
import type { CaptureProvider, ImageReader, ImportOptions } from "./control/images.ts";
import { inferenceOffer } from "./control/inference.ts";
import { InferenceRunner, ResourceGuard } from "./control/inference.ts";
import type { InferenceAssignment, InferenceExecutor } from "./control/inference.ts";
import { RunnerSessions, SessionConnection, SqliteSessionReceipts } from "./control/sessions.ts";
import type { RunnerSessionBackend, RunnerSessionJob, SessionDownload } from "./control/sessions.ts";
import { SqliteStore } from "./sqlite.ts";
import { DisplayControls, DisplayEndpoint } from "./guest/display.ts";
import type { DisplayConnection } from "./guest/display.ts";
import type { ByteReader, VerifiedDownload } from "./control/transfers.ts";
import { cpus, freemem, hostname, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { ProcessUsageCollector, validateSample } from "./control/infrastructure.ts";
import type { ProcessObservation, UsageCategory } from "./control/infrastructure.ts";
import { createGuestAccess, guestReady, guestRecipe, loadHelperArtifacts } from "./guest/access.ts";
import { createInferenceExecutor } from "./inference-runtime.ts";
import { assignmentAccess, assignmentFingerprint, cleanupLease, contactFresh, executionClock, helpersClosed, LeaseGuard, noLinks, present, privateDirectory, ProcessSupervisor, readRecord, recordPreparation, saveRecord, StateLock, unknownOutcome } from "./runtime-process.ts";
import type { ExecutionClock, LeaseAuthorization, RecordValue } from "./runtime-process.ts";

export interface HostConfig extends RecordValue {
  url: string; stateDir: string;
  enrollmentToken?: string; allowHTTP?: boolean; caFile?: string;
}
export interface HostTransport { request(method: string, path: string, body: RecordValue, token: string, signal?: AbortSignal): Promise<RecordValue> }
export interface HostWorkContext {
  signal: AbortSignal; authorized(): boolean; processes: ProcessSupervisor;
}
export interface HostTaskAdapter {
  execute(task: RecordValue, context: HostWorkContext): Promise<RecordValue>;
  close?(): Promise<void>;
  closeMachine?(id: string): Promise<void>;
}
export interface HostImageAdapter extends HostTaskAdapter {
  importImage?(metadata: RecordValue, source: ImageReader, size: number, authorized: () => boolean): Promise<RecordValue>;
}
export interface GuestAccess {
  closeMachine?(id: string): Promise<void>;
  prepare?(machine: RecordValue, image: RecordValue, folder: string): Promise<RecordValue>;
  control(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue): Promise<RecordValue>;
  sweep?(active: Set<string>): Promise<unknown>;
  close?(): Promise<void>;
  streamUpload?(machine: RecordValue, image: RecordValue, folder: string, path: string, app: string | undefined, reader: ByteReader, size: number, authorized: () => boolean): Promise<RecordValue>;
  streamDownload?(machine: RecordValue, image: RecordValue, folder: string, path: string, app?: string, authorized?: () => boolean): Promise<VerifiedDownload>;
  desktop?(machine: RecordValue, image: RecordValue, folder: string): Promise<DisplayConnection>;
}
export interface HostDependencies {
  transport?: HostTransport; clock?: ExecutionClock;
  providerFactory?: (config: RecordValue, state: string) => NativeProvider | Promise<NativeProvider>;
  guest?: GuestAccess;
  inference?: HostTaskAdapter; images?: HostImageAdapter; sessions?: HostTaskAdapter;
  log?: (message: string) => void;
}
interface Runtime extends NativeProvider {
  updateStopped?(machine: RecordValue, image: RecordValue, folder: string): Promise<boolean>;
  confirmExecutionStopped?(machine: RecordValue, folder: string): RecordValue | null;
  readonly state?: string;
  readonly config?: RecordValue;
  operate?(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue, authorized?: () => boolean): Promise<RecordValue>;
  refreshExecution?(machine: RecordValue, image: RecordValue, folder: string, authorization: () => LeaseAuthorization): Promise<RecordValue | undefined>;
  removeOwnedStorage?(machine: RecordValue, image: RecordValue, folder: string, requestId: string, preboot?: boolean): Promise<RecordValue>;
  stopForCleanup?(machine: RecordValue, image: RecordValue, folder: string): Promise<RecordValue>;
  sweep?(active: Set<string>): Promise<unknown>;
  close?(): Promise<unknown>;
  resourceProcesses?(machine: RecordValue, image: RecordValue, folder: string): Promise<unknown[]>;
  control?(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue): Promise<RecordValue>;
  streamUpload?: GuestAccess["streamUpload"];
  streamDownload?: GuestAccess["streamDownload"];
  desktop?: GuestAccess["desktop"];
  closeShells?(machine: RecordValue): Promise<void>;
  resourceReport?(assignments: RecordValue[]): Promise<RecordValue>;
}
interface DurableWork { fingerprint: string; state: string; report?: RecordValue }
const TERMINAL = new Set(["succeeded", "failed", "unknown", "cancelled"]);
const PRIVATE_CONFIG = new Set(["url", "stateDir", "enrollmentToken", "allowHTTP", "caFile"]);

/** Bounded JSON HTTP, no redirects or ambient proxy, optional host-scoped trust bundle. */
export function hostTransport(config: HostConfig): HostTransport {
  let base: URL;
  try { base = new URL(config.url); } catch { throw new ServiceError("Invalid controller URL.", 400); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || !base.hostname ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && (config.allowHTTP === true || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))))) throw new ServiceError("Remote hosts require HTTPS without embedded credentials or URL parameters.", 400);
  let ca: Buffer | undefined;
  if (config.caFile) {
    try { ca = readFileSync(config.caFile); if (!ca.toString("ascii").includes("-----BEGIN CERTIFICATE-----")) throw new Error(); createSecureContext({ ca }); }
    catch { throw new ServiceError("The host CA bundle is unavailable or invalid.", 400); }
  }
  return { request: async (method, path, body, token, signal) => {
    if (!path.startsWith("/v1/") || path.includes("?") && !(method === "GET" && /^\/v1\/updates\/artifacts\/[a-f0-9]{64}\?jobId=[a-f0-9-]{36}&offset=(0|[1-9][0-9]*)&length=[1-9][0-9]*$/.test(path))) throw new ServiceError("Invalid host API path.", 400);
    secret(token);
    const data = Buffer.from(JSON.stringify(body));
    if (data.length > 8 * 1_048_576) throw new ServiceError("Host report exceeds the request bound.", 413);
    return new Promise((accept, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, result?: RecordValue): void => { if (settled) return; settled = true; clearTimeout(deadline); if (error) reject(error); else accept(result!); };
      const invoke = base.protocol === "https:" ? httpsRequest : httpRequest;
      const request = invoke(new URL(path, base), { method, ...(ca ? { ca } : {}), ...(signal ? { signal } : {}), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": data.length } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1_048_576) { response.destroy(); finish(new ServiceError("Controller reply exceeds its bound.", 413)); } else chunks.push(chunk);
        });
        response.once("error", () => finish(unknownOutcome("Controller response was interrupted; retry only the saved intent.")));
        response.once("end", () => {
          try {
            if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) throw new ServiceError("Host controller redirects are refused.", 409);
            const value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            if ((response.statusCode ?? 500) >= 400) throw new ServiceError(typeof value.error === "string" ? value.error.slice(0, 1000) : "Host controller request failed.", response.statusCode, { retryable: false, ...(value.outcome === "unknown" ? { outcome: "unknown" } : {}) });
            finish(undefined, value);
          } catch (error) { finish(error instanceof ServiceError ? error : unknownOutcome("Invalid controller reply; retain local intent.")); }
        });
      });
      const deadline = setTimeout(() => { request.destroy(); finish(unknownOutcome("Controller request deadline ended; its outcome is unconfirmed.")); }, 20_000);
      request.once("error", () => finish(unknownOutcome("Controller contact failed; retain the saved identity and assignments.")));
      request.end(data);
    });
  } };
}

export function hostOffer(config: RecordValue): RecordValue {
  if ("leaseProtocol" in config || "leaseImages" in config) throw new ServiceError("This runner cannot advertise lease execution before native fencing and owned cleanup acceptance.", 400);
  const provider = text(config.provider, "provider");
  if (!["macos", "linux", "windows", "apple", "libvirt", "hyperv", "kubevirt", "android", "ios", "native"].includes(provider)) throw new ServiceError("Unsupported host provider.", 400);
  if (!Array.isArray(config.templates) || config.templates.length > 100) throw new ServiceError("Offer at most 100 installed templates.", 400);
  let templates = config.templates.map(normalizeTemplate);
  if (new Set(templates.map(t => `${t.id}@${t.revision}:${t.arch}`)).size !== templates.length) throw new ServiceError("Duplicate installed template revision.", 400);
  if (Object.hasOwn(HOST_RUNTIMES, provider)) { enabledRuntimes(config); for (const image of templates) runtimeFor(config, image); }
  else for (const image of templates) if (["android", "ios"].includes(image.os) ? image.os !== provider : ["android", "ios", "native"].includes(provider)) throw new ServiceError("Template requires a matching runtime.", 400);
  if (config.offerTemplateRevisions !== undefined) {
    const selected = config.offerTemplateRevisions;
    if (!Array.isArray(selected) || !selected.length || selected.some(x => typeof x !== "string" || !templates.some(t => `${t.id}@${t.revision}:${t.arch}` === x))) throw new ServiceError("Offered revisions must be installed locally.", 400);
    templates = templates.filter(t => selected.includes(`${t.id}@${t.revision}:${t.arch}`));
  }
  const offer: RecordValue = { name: text(config.name, "host name"), provider, capacity: resources(config.capacity), templates };
  if (Object.hasOwn(HOST_RUNTIMES, provider)) offer.runtimes = Object.keys(enabledRuntimes(config)).sort();
  // An inference adapter must provide its validated public catalogue explicitly;
  // executable paths, model directories and resource guard settings stay private.
  if (config.inference !== undefined) {
    if (!["native", "apple", "libvirt"].includes(provider)) throw new ServiceError("Embedded inference requires a native Mac or Linux host.", 400);
    offer.inference = inferenceOffer(config.inference);
  }
  return offer;
}

export class HostRunner {
  readonly config: HostConfig;
  readonly state: string;
  readonly offer: RecordValue;
  readonly library: ImageLibrary;
  imageAdapter: HostImageAdapter;
  private inferenceAdapter: HostTaskAdapter | undefined;
  private sessionAdapter: HostTaskAdapter | undefined;
  readonly guard: LeaseGuard;
  readonly clock: ExecutionClock;
  readonly processes = new ProcessSupervisor();
  readonly reports = new Map<string, RecordValue>();
  readonly deviceReports = new Map<string, RecordValue>();
  readonly inferenceReports = new Map<string, RecordValue>();
  readonly imageReports = new Map<string, RecordValue>();
  readonly sessionReports = new Map<string, RecordValue>();
  readonly runtimes = new Map<string, Runtime>();
  readonly transport: HostTransport;
  identity: { id: string; credential: string; orchestrator: string } | undefined;
  assignments: RecordValue[] = [];
  lastContact = 0;
  health: RecordValue = { status: "checking", checkedAt: 0, checks: [] };
  private queues: Record<string, RecordValue[]> = { device: [], inference: [], images: [], sessions: [] };
  private active = new Map<string, { controller: AbortController; promise: Promise<void>; authorized: () => boolean }>();
  private loops: Promise<void>[] = [];
  private stopController = new AbortController();
  private lock: StateLock | undefined;
  closed = false;
  private started = false;
  private checkRequested = true;
  private nextCheck = 0;
  private lastCheckRequest = 0;
  private pollInterval: number;
  private concurrency: number;
  private log: (message: string) => void;
  private guest: GuestAccess | undefined;
  private outboundSessions: RunnerSessions | undefined;
  private displayControls: DisplayControls | undefined;
  private usage = new ProcessUsageCollector();
  resourceSample: RecordValue | undefined;
  private hostCpu: { idle: number; total: number } | undefined;
  private readonly processBirth = Date.now() / 1000 - process.uptime();
  private cleanupDue = new Map<string, number>();
  private machineCursor = 0;
  private updateAdmissionBlocked = false;
  private updateEpoch = 0;
  private updateExternalWork = 0;
  private updateAssignments = new Map<string, RecordValue>();
  constructor(config: HostConfig, readonly dependencies: HostDependencies = {}) {
    // Validate trust before writing identity, even with an injected transport.
    const transport = hostTransport(config);
    this.config = structuredClone(config);
    this.state = resolve(config.stateDir); privateDirectory(this.state);
    this.library = new ImageLibrary(this.state);
    this.config.templates = [...recordsWithoutIds(config.templates), ...this.library.definitions()];
    this.offer = hostOffer(this.config);
    this.imageAdapter = dependencies.images ?? {
      execute: (task, context) => this.imageWork(task, context),
      importImage: (metadata, source, size, authorized) => this.importImage(metadata, source, size, authorized),
    };
    this.inferenceAdapter = dependencies.inference; this.sessionAdapter = dependencies.sessions;
    this.pollInterval = Number(config.pollIntervalSeconds ?? 5);
    this.concurrency = Number(config.concurrency ?? 2);
    if (!Number.isFinite(this.pollInterval) || this.pollInterval < .25 || this.pollInterval > 5 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) throw new ServiceError("Invalid host poll interval or concurrency.", 400);
    this.clock = dependencies.clock ?? executionClock();
    this.guard = new LeaseGuard(this.state, this.clock);
    this.transport = dependencies.transport ?? transport; this.log = dependencies.log ?? (() => {}); this.guest = dependencies.guest;
    this.loadReports();
    const retained = join(this.state, "update-assignments.json");
    if (present(retained)) for (const machine of records(readRecord(retained).machines, "retained update assignments")) this.updateAssignments.set(String(machine.id), machine);
  }
  private loadReports(): void {
    const path = join(this.state, "host-reports.json");
    if (!present(path)) return;
    const saved = readRecord(path, 16 * 1_048_576);
    for (const [name, target] of [["machines", this.reports], ["device", this.deviceReports], ["inference", this.inferenceReports], ["images", this.imageReports], ["sessions", this.sessionReports]] as const) {
      for (const [id, report] of Object.entries(object(saved[name] ?? {}))) target.set(identifier(id), object(report));
    }
  }
  private saveReports(): void {
    saveRecord(join(this.state, "host-reports.json"), { machines: Object.fromEntries(this.reports), device: Object.fromEntries(this.deviceReports), inference: Object.fromEntries(this.inferenceReports), images: Object.fromEntries(this.imageReports), sessions: Object.fromEntries(this.sessionReports) });
  }
  async connect(): Promise<void> {
    const path = join(this.state, "identity.json"), orchestrator = this.config.url.replace(/\/+$/, "");
    if (present(path)) {
      const value = readRecord(path);
      if (value.orchestrator !== orchestrator) throw new ServiceError("Host identity belongs to another controller; use separate state.", 409);
      this.identity = { id: identifier(value.id), credential: secret(value.credential), orchestrator };
    } else {
      if (!this.config.enrollmentToken) throw new ServiceError("A new host needs an enrollment credential.", 400);
      this.identity = { id: randomUUID(), credential: randomBytes(32).toString("base64url"), orchestrator }; saveRecord(path, this.identity);
    }
    if (this.config.enrollmentToken) await this.transport.request("POST", "/v1/hosts/enroll", { ...this.identity, offer: this.offer }, secret(this.config.enrollmentToken), this.stopController.signal);
  }
  async initializeProviders(): Promise<void> {
    const factory = this.dependencies.providerFactory ?? createProvider, provider = String(this.config.provider);
    const clean = Object.fromEntries(Object.entries(this.config).filter(([key]) => !PRIVATE_CONFIG.has(key)));
    if (Object.hasOwn(HOST_RUNTIMES, provider)) {
      for (const [kind, options] of Object.entries(enabledRuntimes(this.config))) this.runtimes.set(kind, await factory({ ...clean, ...options, provider: kind,
        storage: options.storage ?? join(String(clean.storage), kind), templates: (clean.templates as RecordValue[]).filter(i => runtimeFor(this.config, i) === kind) }, String(options.stateDirectory ?? this.state)));
    } else if (provider !== "native") this.runtimes.set(provider, await factory(clean, this.state));
    if (!this.guest && (this.config.templates as RecordValue[]).some(t => t.guestAccess)) this.guest = createGuestAccess(clean, this.state);
    if (!this.inferenceAdapter && this.config.inference) {
      const executor = createInferenceExecutor(object(this.config.inference), this.state); await executor.check();
      const models = inferenceOffer(this.config.inference).models;
      const runner = new InferenceRunner(new SqliteStore(join(this.state, "inference-runner.sqlite")), models, new ResourceGuard(this.state), executor);
      this.inferenceAdapter = {
        execute: async (task, context) => {
          if (present(join(this.state, "inference", `${identifier(task.id)}.json`))) return { state: "unknown", stopped: false, cleanup: "pending", detail: "Legacy inference attempt retained; fence and inspect it before recovery." };
          return { ...await runner.reconcile(task as unknown as InferenceAssignment, () => this.queues.inference?.some(t => t.id === task.id && t.desired === "cancelled") ? "cancel" : context.signal.aborted || !context.authorized() ? "fence" : "continue") };
        }, close: () => executor.close(),
      };
    }
    if (!this.dependencies.sessions) {
      this.displayControls = new DisplayControls(join(this.state, "display-controls.sqlite"));
      this.outboundSessions = new RunnerSessions({
        authorized: job => this.sessionAuthorized(job),
        beginExecution: job => {
          const machine = this.assignments.find(m => m.id === job.machineId);
          if (!machine || !this.sessionAuthorized(job)) throw new ServiceError("Session execution is unauthorized.", 410);
          const { folder } = this.context(machine);
          if (readRecord(join(folder, "assignment.json")).fingerprint !== assignmentFingerprint(machine)) throw new ServiceError("Session assignment fingerprint differs.", 409);
          this.guard.beginExecution(job.machineId, job.leaseId);
        },
        receipts: new SqliteSessionReceipts(new SqliteStore(join(this.state, "host-sessions.sqlite")), join(this.state, "access-sessions")),
        connect: async (job, authorized) => {
          if (!this.identity) throw new ServiceError("Host identity is unavailable.", 410);
          return SessionConnection.connect(this.config.url, `/v1/hosts/${this.identity.id}/sessions/${job.id}/${job.generation}`, this.identity.credential, { authorized, ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}) });
        },
        backend: job => this.sessionBackend(job),
      });
    }
  }
  private sessionAuthorized(job: RunnerSessionJob): boolean {
    const machine = this.assignments.find(m => m.id === job.machineId);
    return this.fresh() && this.queues.sessions!.some(s => s.id === job.id && s.generation === job.generation && s.leaseId === job.leaseId && s.machineId === job.machineId && s.capability === job.capability) && !!machine && machine.ready === true && machine.desired === "running" && !!machine.lease && object(machine.lease).id === job.leaseId && object(machine.lease).state === "ready" && this.offer.leaseProtocol === 1 && this.guard.allowed(job.machineId);
  }
  private sessionBackend(job: RunnerSessionJob): RunnerSessionBackend {
    const machine = this.assignments.find(m => m.id === job.machineId);
    if (!machine) throw new ServiceError("Session assignment is unavailable.", 410);
    const { runtime, image, folder } = this.context(machine), backend = this.guest ?? runtime;
    const control = async (action: string, args: RecordValue): Promise<RecordValue> => {
      if (!this.sessionAuthorized(job) && action !== "shell-close") throw new ServiceError("Session authorization ended.", 410);
      if (!backend.control) throw new ServiceError("Assignment has no verified guest control transport.", 409, { code: "capability_unsupported" });
      return backend.control(machine, image, folder, { action, arguments: args });
    };
    return {
      control,
      upload: async (path, app, reader, size, authorized) => {
        if (!backend.streamUpload) throw new ServiceError("Assignment has no streaming upload transport.", 409);
        const result = await backend.streamUpload(machine, image, folder, path, app, reader, size, authorized);
        if (result.uploaded !== size || result.durable !== true) throw unknownOutcome("Upload publication is unconfirmed.");
        return { uploaded: size, durable: true };
      },
      download: async (path, app) => {
        if (!backend.streamDownload) throw new ServiceError("Assignment has no streaming download transport.", 409);
        return backend.streamDownload(machine, image, folder, path, app, () => this.sessionAuthorized(job)) as Promise<SessionDownload>;
      },
      inspect: () => control("accessibility", {}),
      display: async (channel, authorized, current) => {
        if (!backend.desktop || !this.displayControls) throw new ServiceError("Assignment has no verified desktop transport.", 409, { code: "capability_unsupported" });
        const endpoint = new DisplayEndpoint(this.displayControls, job.machineId, () => backend.desktop!(machine, image, folder), authorized, { viewer: current.id });
        await endpoint.runDisplay(channel);
      },
    };
  }
  get guestAccess(): GuestAccess | undefined { return this.guest; }
  get stopping(): boolean { return this.stopController.signal.aborted; }
  async accessControl(machineId: string, operation: RecordValue): Promise<RecordValue> {
    if (this.updateAdmissionBlocked) throw new ServiceError("Host update admission is fenced.", 409);
    const id = identifier(machineId), machine = this.assignments.find(m => m.id === id);
    if (!machine || !this.machineAuthorized(id)) throw new ServiceError("Current assignment access is unavailable.", 410);
    const { runtime, image, folder } = this.context(machine);
    this.updateEpoch++; this.updateExternalWork++;
    try { return await assignmentAccess(machine, folder, async () => {
      if (!this.machineAuthorized(id)) throw new ServiceError("Assignment access ended.", 410);
      if (this.guest) return this.guest.control(machine, image, folder, operation);
      if (runtime.operate) { const report = await runtime.operate(machine, image, folder, { ...operation, id: operation.id ?? randomUUID(), expiresAt: operation.expiresAt ?? this.clock.wall() + 30 }, () => this.machineAuthorized(id)); if (report.state !== "succeeded") throw unknownOutcome("Guest operation was not confirmed."); return object(report.result); }
      throw new ServiceError("Verified assignment access is unavailable.", 409, { code: "capability_unsupported" });
    }); } finally { this.updateExternalWork--; }
  }
  private imageSettings(metadata: RecordValue): ImportOptions {
    const spec = specification(metadata), kind = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? runtimeFor(this.config, spec) : String(this.config.provider);
    const compatible: Record<string, string[]> = { apple: ["linux", "macos"], libvirt: ["linux", "windows"], hyperv: ["linux", "windows"] };
    if (!compatible[kind]?.includes(String(spec.os))) throw new ServiceError("Runtime cannot provision this image OS.", 409);
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
    if (spec.arch !== arch) throw new ServiceError("Image architecture must match this host.", 400);
    if (kind === "apple" && (Number(object(spec.minimum).memoryMiB) % 1024 || spec.os === "macos" && spec.format !== "ipsw" || spec.os === "linux" && !["iso", "raw", "qcow2"].includes(String(spec.format)))) throw new ServiceError("Apple import requires compatible media and whole GiB memory.", 409);
    if (kind === "hyperv" && spec.format !== "vhdx") throw new ServiceError("Hyper-V import requires VHDX.", 409);
    // An automatic guest-access import needs the host's signed/helper bundle
    // recipe; accepting the flag without installing that recipe would invent readiness.
    let prepare = this.config.guestPreparation;
    if (spec.guestAccess && !prepare) {
      const runtimeConfig = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? object(enabledRuntimes(this.config)[kind]) : this.config;
      const settings = object(runtimeConfig.guestAccess ?? this.config.guestAccess);
      const manifest = settings.helperManifest ?? this.config.guestHelperManifest ?? process.env.CANAVERAL_GUEST_BUNDLE;
      if (typeof settings.identityFile !== "string" || typeof manifest !== "string") throw new ServiceError("Configure the verified guest SSH identity and service bundle before import.", 409);
      prepare = guestRecipe(readFileSync(`${settings.identityFile}.pub`, "utf8").trim(), spec.mode === "desktop" ? "desktop" : "headless", loadHelperArtifacts(manifest));
    }
    return { memoryStep: kind === "apple" ? 1024 : 1, ...(spec.guestAccess ? { prepare: object(prepare) } : {}) };
  }
  async importImage(metadata: RecordValue, source: ImageReader, size: number, authorized: () => boolean): Promise<RecordValue> {
    if (this.updateAdmissionBlocked) throw new ServiceError("Host update admission is fenced.", 409);
    this.updateEpoch++; this.updateExternalWork++;
    try { return await this.library.importStream(metadata, source, size, authorized, this.imageSettings(metadata)); } finally { this.updateExternalWork--; }
  }
  private async imageWork(task: RecordValue, context: HostWorkContext): Promise<RecordValue> {
    if (task.kind === "registry") return { ...await this.library.registryImport(task, {
      authorized: context.authorized, importSettings: metadata => this.imageSettings(metadata),
      pinSource: async (id, source) => {
        if (!this.identity || !context.authorized()) throw new ServiceError("Registry authorization ended.", 410);
        return this.transport.request("POST", `/v1/hosts/${this.identity.id}/image-tasks/${id}/resolve`, { ...source }, this.identity.credential, context.signal);
      },
    }) };
    if (task.kind === "import") {
      const record = this.library.records().find(r => r.public.id === task.id);
      return record ? { state: "succeeded", result: record.public } : { state: "failed", result: { detail: "Import bytes were not published on this host." } };
    }
    const machine = object(task.machine), { runtime, image, folder } = this.context(machine);
    if (typeof (runtime as unknown as CaptureProvider).withCaptureSource !== "function") return { state: "failed", result: { detail: "Runtime has no positively fenced cold-capture source." } };
    const captured = { ...image }; delete captured.prepare;
    if (image.guestAccess) captured.prepare = this.imageSettings({ id: task.id, name: task.name, os: image.os, arch: image.arch, mode: image.mode, minimum: machine.resources, format: "qcow2", guestAccess: true }).prepare;
    return { ...await this.library.capture({ id: identifier(task.id), machineId: identifier(task.machineId), name: String(task.name), machine }, runtime as unknown as CaptureProvider, captured, folder) };
  }
  refreshImages(): void {
    const installed = this.config.templates as RecordValue[];
    for (const definition of this.library.definitions()) {
      const old = installed.find(t => t.id === definition.id && t.revision === definition.revision && t.arch === definition.arch);
      if (old) { if (legacyDigest(normalizeTemplate(old)) !== legacyDigest(normalizeTemplate(definition))) throw new ServiceError("Local immutable image catalogue conflicts.", 409); }
      else {
        installed.push(definition); (this.offer.templates as RecordValue[]).push(normalizeTemplate(definition));
        const name = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? runtimeFor(this.config, definition) : String(this.config.provider);
        const providerTemplates = this.runtimes.get(name)?.config?.templates;
        if (Array.isArray(providerTemplates) && providerTemplates !== installed) providerTemplates.push(definition);
      }
    }
    if (!this.guest && installed.some(t => t.guestAccess)) this.guest = createGuestAccess(this.config, this.state);
  }
  context(machine: RecordValue): { runtime: Runtime; image: RecordValue; folder: string } {
    const id = identifier(machine.id), template = object(machine.template);
    const image = (this.config.templates as RecordValue[]).find(t => t.id === machine.templateId && t.revision === template.revision && t.arch === template.arch);
    if (!image || legacyDigest(normalizeTemplate(image)) !== legacyDigest(normalizeTemplate(template))) throw new ServiceError("Assigned immutable template no longer matches this host.", 409);
    const name = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? runtimeFor(this.config, image) : String(this.config.provider);
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new ServiceError("Assignment runtime is unavailable.", 409, { code: "capability_unsupported" });
    const folder = join(runtime.state ?? this.state, "machines", id); noLinks(folder);
    return { runtime, image: structuredClone(image), folder };
  }
  async poll(): Promise<void> {
    if (!this.identity) throw new ServiceError("Host is not connected.", 409);
    const sentReports = new Map(this.reports), deviceReports = firstReport(this.deviceReports), inferenceReports = Object.keys(deviceReports).length ? {} : firstReport(this.inferenceReports), imageReports = firstReport(this.imageReports);
    const sent = this.clock.now();
    // Read the current credential on every heartbeat. Rotation delivery may replace
    // identity.json between requests, but cannot change the host/controller binding.
    const identity = readRecord(join(this.state, "identity.json"));
    if (identity.id !== this.identity.id || identity.orchestrator !== this.identity.orchestrator) throw new ServiceError("Persisted host identity binding changed.", 409);
    this.identity.credential = secret(identity.credential);
    const response = await this.transport.request("POST", `/v1/hosts/${this.identity.id}/heartbeat`, { offer: this.offer, reports: Object.fromEntries(sentReports), deviceReports, inferenceReports, imageReports, installedImages: (this.config.templates as RecordValue[]).map(normalizeTemplate), health: this.health, ...(this.resourceSample ? { resources: this.resourceSample } : {}) }, this.identity.credential, this.stopController.signal);
    const machines = records(response.machines, "machines");
    if (new Set(machines.map(m => identifier(m.id))).size !== machines.length) throw new ServiceError("Duplicate host assignments.", 409);
    // Validate the complete response before replacing current authorization.
    const queues = { device: records(response.deviceOperations ?? [], "device operations"), inference: records(response.inferenceJobs ?? [], "inference jobs"), images: records(response.imageTasks ?? [], "image tasks"), sessions: records(response.accessSessions ?? [], "access sessions") };
    this.guard.observe(machines, Math.max(0, this.clock.now() - sent));
    this.library.acknowledge(object(response.imageAcknowledged ?? {}) as Record<string, string>); this.refreshImages();
    const active = new Set(machines.map(m => String(m.id)));
    for (const [id, report] of sentReports) if (!active.has(id)) {
      if (report.leaseCleanup && object(report.leaseCleanup).state === "complete") { const cleanup = object(report.leaseCleanup); this.guard.retire(id, String(cleanup.leaseId), String(cleanup.id)); }
      this.reports.delete(id);
    }
    this.updateEpoch++;
    for (const machine of machines) this.updateAssignments.set(String(machine.id), structuredClone(machine));
    for (const [id, record] of this.guard.records) if (record.retired) this.updateAssignments.delete(id);
    saveRecord(join(this.state, "update-assignments.json"), { machines: [...this.updateAssignments.values()] });
    this.assignments = machines; this.queues = queues; this.lastContact = sent;
    for (const [key, target, sentMap] of [["device", this.deviceReports, deviceReports], ["inference", this.inferenceReports, inferenceReports], ["images", this.imageReports, imageReports]] as const) {
      const ids = new Set(queues[key].map(r => String(r.id)));
      for (const id of Object.keys(sentMap)) if (!ids.has(id)) target.delete(id);
    }
    if (typeof response.checksRequestedAt === "number" && response.checksRequestedAt > this.lastCheckRequest) { this.lastCheckRequest = response.checksRequestedAt; this.checkRequested = true; }
    this.saveReports(); this.cancelUnauthorized();
  }
  fresh(): boolean { return !this.stopController.signal.aborted && contactFresh(this.lastContact, this.clock.now()); }
  private cancelUnauthorized(): void { for (const item of this.active.values()) if (!item.authorized()) item.controller.abort(); }
  private publish(target: Map<string, RecordValue>, id: string, report: RecordValue): void { target.set(id, report); this.saveReports(); }
  private launch(key: string, authorized: () => boolean, work: (context: HostWorkContext) => Promise<void>): void {
    if (this.active.has(key)) return;
    this.updateEpoch++;
    const controller = new AbortController();
    const context = { signal: controller.signal, authorized, processes: this.processes };
    const promise = Promise.resolve().then(() => work(context)).catch(() => this.log("Owned host work needs inspection; its durable intent is retained.")).finally(() => this.active.delete(key));
    this.active.set(key, { controller, promise, authorized });
  }
  async reconcile(machine: RecordValue, context?: HostWorkContext): Promise<RecordValue> {
    if (this.updateAdmissionBlocked && machine.desired !== "stopped") throw new ServiceError("Host update admission is fenced.", 409);
    const { runtime, image: originalImage, folder } = this.context(machine), id = identifier(machine.id);
    if (machine.leaseCleanup) {
      const nativeCleanup = runtime.kind === "apple" || runtime.kind === "libvirt" && !!runtime.stopForCleanup;
      return cleanupLease({ state: this.state, storageRoot: String(runtime.config?.storage ?? this.config.storage), machine, folder, guard: this.guard, now: this.clock.wall(),
        closeSessions: async () => {
          this.outboundSessions?.closeMachine(id); await this.guest?.closeMachine?.(id); await runtime.closeShells?.(machine);
          const active = new Set(this.assignments.filter(m => m.id !== id && this.machineAuthorized(String(m.id))).map(m => String(m.id))); await runtime.sweep?.(active);
        },
        ...(nativeCleanup && runtime.removeOwnedStorage ? {
          stop: () => runtime.stopForCleanup ? runtime.stopForCleanup(machine, originalImage, folder) : runtime.reconcile(machine, { ...originalImage, _leaseAuthorization: () => this.guard.authorization(id, String(object(machine.lease).id)) }, folder),
          remove: (requestId: string, preboot?: boolean) => runtime.removeOwnedStorage!(machine, originalImage, folder, requestId, preboot), preboot: runtime.kind === "apple",
        } : {}),
      });
    }
    return assignmentAccess(machine, folder, async () => {
      const fingerprint = assignmentFingerprint(machine), receipt = join(folder, "assignment.json");
      privateDirectory(folder);
      if (present(receipt)) { const owner = readRecord(receipt); if (owner.fingerprint !== fingerprint || (owner.leaseId ?? null) !== (machine.lease ? object(machine.lease).id : null)) throw new ServiceError("Local assignment ownership differs.", 409); }
      else saveRecord(receipt, { fingerprint, ...(machine.lease ? { leaseId: object(machine.lease).id } : {}) });
      if (machine.deletion) {
        const requestId = identifier(object(machine.deletion).id);
        if (!runtime.removeOwnedStorage) return { state: "unknown", deletion: { id: requestId, state: "blocked" }, detail: "Runtime does not implement verified owned removal." };
        try {
          const proof = await runtime.removeOwnedStorage({ ...machine, desired: "stopped" }, originalImage, folder, requestId);
          if (proof.state !== "complete" || proof.id !== requestId || proof.machineId !== id) throw unknownOutcome();
          return { state: "stopped", deletion: { id: requestId, state: "complete" } };
        } catch { return { state: "unknown", deletion: { id: requestId, state: "blocked" }, detail: "Owned removal is unconfirmed; retain storage reservations." }; }
      }
      if (present(join(folder, "deletion.json"))) throw new ServiceError("Durable deletion intent prevents reconciliation.", 409);
      let current = machine, image = originalImage;
      let leaseAuthorization: (() => LeaseAuthorization) | undefined;
      if (machine.lease) {
        // Default portable clock never authorizes leased starts; preserve and stop
        // pre-existing assignments while their independent native fence runs.
        if (!this.guard.allowed(id)) current = { ...machine, desired: "stopped", leaseFenced: true };
        if (current.desired === "running") {
          if (!runtime.refreshExecution) throw new ServiceError("Native independent lease fence is unavailable.", 409);
          const leaseId = String(object(machine.lease).id);
          if (runtime.kind === "apple") recordPreparation(machine, folder, this.guard.neverStarted(id, leaseId));
          this.guard.beginExecution(id, leaseId);
        }
        leaseAuthorization = () => this.guard.authorization(id, String(object(machine.lease).id));
      }
      // Stopping bypasses credentials, source preparation and guest connectivity.
      if (current.desired === "stopped") return runtime.reconcile(current, leaseAuthorization ? { ...image, _leaseAuthorization: leaseAuthorization } : image, folder);
      if (context && !context.authorized()) throw new ServiceError("Assignment authorization ended.", 410);
      if (image.source && !image.image && !image.catalogueImageId) throw new ServiceError("Prepare and verify the configured base image before runtime creation.", 409);
      if (image.catalogueImageId) this.library.verifyDefinition(image);
      if (image.guestAccess && this.guest?.prepare) image = await this.guest.prepare(current, image, folder);
      if (leaseAuthorization) image = { ...image, _leaseAuthorization: leaseAuthorization };
      const prepared = image.prepare ? object(image.prepare) : undefined;
      let preparation: RecordValue | undefined;
      if (prepared) {
        const token = credential(folder);
        preparation = { state: current.preparation && object(current.preparation).state === "ready" ? "ready" : "pending", tokenHash: legacyDigest(token) };
        if (prepared.driver !== "ssh") {
          const endpoint = text(runtime.config?.guestOrchestratorURL ?? this.config.guestOrchestratorURL, "guest controller URL", 8000);
          image._userData = userData(image, { id }, endpoint, token, this.config.allowHTTP === true, !image.guestAccess);
        }
      }
      const result = await runtime.reconcile(current, image, folder);
      if (prepared && preparation) {
        if (result.state === "running" && image.guestAccess && this.guest) {
          result.accessReady = false;
          try { if (guestReady(await this.guest.control(current, image, folder, { action: "health", arguments: {} }), image)) { preparation.state = "ready"; result.accessReady = true; } }
          catch { result.detail = "Waiting for the verified guest preparation connection."; }
        }
        if (result.state === "running" && prepared.driver === "ssh") {
          const complete = join(folder, "ssh-prepared.json");
          if (!present(complete)) {
            const plan = sshPreparation(image, { id });
            try {
              const value = await this.processes.run(plan.argv, { input: plan.input, timeoutMs: plan.timeoutSeconds * 1000, ...(context ? { signal: context.signal } : {}) });
              if (value.code !== 0) throw new Error();
              saveRecord(complete, { recipeDigest: object(current.template).recipeDigest });
            } catch { preparation.state = "failed"; result.detail = "SSH preparation was not confirmed; inspect its guest receipt before retrying."; }
          }
          if (present(complete)) { if (readRecord(complete).recipeDigest !== object(current.template).recipeDigest) throw new ServiceError("SSH preparation recipe differs.", 409); preparation.state = "ready"; }
        } else if (result.state === "running" && preparation.state !== "ready") {
          const timing = join(folder, "preparation-timing.json");
          if (!present(timing)) saveRecord(timing, { runningAt: this.clock.wall() });
          if (this.clock.wall() - Number(readRecord(timing).runningAt) > Number(prepared.timeoutSeconds ?? 1800)) { preparation.state = "failed"; result.detail = "Guest preparation receipt timed out."; }
        }
        result.preparation = preparation;
      }
      return result;
    });
  }
  private machineAuthorized(id: string): boolean {
    const current = this.assignments.find(m => m.id === id);
    return this.fresh() && !!current && current.desired === "running" && !current.deletion && !current.leaseCleanup && this.guard.allowed(id);
  }
  consumerOperationAuthorized(operation: RecordValue): boolean {
    if (!this.fresh() || !this.queues.device?.some(o => legacyDigest(o) === legacyDigest(operation)) || this.clock.wall() >= Number(operation.expiresAt)) return false;
    const machine = this.assignments.find(m => m.id === operation.machineId);
    if (!machine || machine.ready !== true || machine.desired !== "running" || !machine.lease || object(machine.lease).id !== operation.leaseId || object(machine.lease).state !== "ready") return false;
    // This runner advertises no accepted consumer execution selector.
    return this.offer.leaseProtocol === 1 && this.guard.allowed(String(machine.id));
  }
  private async durableWork(kind: string, task: RecordValue, target: Map<string, RecordValue>, work: (context: HostWorkContext) => Promise<RecordValue>, context: HostWorkContext): Promise<void> {
    const id = identifier(task.id), path = join(this.state, "work", kind, `${id}.json`);
    const stable = kind === "device" ? ["id", "machineId", "leaseId", "action", "arguments"] : kind === "inference" ? ["id", "hostId", "request", "definition"] : kind === "images" ? ["id", "kind", "machineId", "name", "metadata", "registryId"] : ["id", "generation", "leaseId", "machineId", "capability"];
    const fingerprint = legacyDigest(Object.fromEntries(stable.filter(k => Object.hasOwn(task, k)).map(k => [k, task[k]])));
    if (present(path)) {
      const previous = readRecord(path) as unknown as DurableWork;
      if (previous.fingerprint !== fingerprint) { this.publish(target, id, { state: "unknown", detail: "Work identity conflicts with its durable receipt." }); return; }
      this.publish(target, id, previous.report ?? { state: "unknown", detail: "Work was interrupted after dispatch; its effect is not replayed." }); return;
    }
    if (!context.authorized()) { this.publish(target, id, { state: "failed", result: { detail: "Authorization ended before dispatch." } }); return; }
    saveRecord(path, { fingerprint, state: "started" });
    this.publish(target, id, { state: "running" });
    let report: RecordValue;
    try { report = await work(context); if (!TERMINAL.has(String(report.state))) throw unknownOutcome(); }
    catch { report = { state: "unknown", result: { detail: "Dispatched work outcome requires inspection; it is not replayed." } }; }
    saveRecord(path, { fingerprint, state: report.state, report }); this.publish(target, id, report);
  }
  private async operate(task: RecordValue, context: HostWorkContext): Promise<RecordValue> {
    const machine = this.assignments.find(m => m.id === task.machineId);
    if (!machine || !context.authorized() || task.leaseId && !this.consumerOperationAuthorized(task)) return { state: "failed", result: { detail: "Current operation authorization is unavailable." } };
    const { runtime, image, folder } = this.context(machine);
    return assignmentAccess(machine, folder, async () => {
      if (!context.authorized()) return { state: "failed", result: { detail: "Operation authorization ended before execution." } };
      const operation = { ...task };
      if (runtime.operate) return runtime.operate(machine, image, folder, operation, context.authorized);
      if (this.guest) return { state: "succeeded", result: await this.guest.control(machine, image, folder, operation) };
      return { state: "failed", result: { detail: "No verified guest or device access transport is configured.", code: "capability_unsupported" } };
    });
  }
  async step(): Promise<void> {
    this.cancelUnauthorized();
    const machines = this.guard.assignments(this.assignments);
    const activeIds = new Set(machines.filter(m => this.machineAuthorized(String(m.id))).map(m => String(m.id)));
    await Promise.all([...this.runtimes.values()].map(async runtime => { try { await runtime.sweep?.(activeIds); } catch { this.log("Runtime connection closure is unconfirmed."); } }));
    await this.guest?.sweep?.(activeIds);
    for (const machine of machines) if (!activeIds.has(String(machine.id))) {
      try { await this.context(machine).runtime.closeShells?.(machine); } catch { this.log("Owned shell closure remains unconfirmed."); }
    }
    let slots = this.concurrency - [...this.active.keys()].filter(k => k.startsWith("machine:") || k.startsWith("device:")).length;
    const pendingDevice = this.queues.device?.some(o => !TERMINAL.has(String(this.deviceReports.get(String(o.id))?.state)) && this.reports.get(String(o.machineId))?.state === "running");
    let machineSlots = Math.max(0, slots - (pendingDevice ? 1 : 0));
    const ordered = machines.length ? [...machines.slice(this.machineCursor % machines.length), ...machines.slice(0, this.machineCursor % machines.length)] : [];
    for (const machine of ordered) {
      const id = String(machine.id), key = `machine:${id}`;
      if (machine.leaseCleanup || this.updateAdmissionBlocked && machine.desired !== "stopped") continue;
      if (machineSlots <= 0 || this.active.has(key) || !this.fresh() && !machine.leaseFenced) continue;
      if (machine.desired === "running" && ["checking", "failed"].includes(String(this.health.status))) continue;
      slots--; machineSlots--; this.machineCursor = (machines.indexOf(machine) + 1) % machines.length;
      const authorized = (): boolean => machine.desired === "stopped" || machine.leaseFenced === true ? !this.closed : this.machineAuthorized(id);
      this.launch(key, authorized, async context => {
        let report: RecordValue;
        try { report = await this.reconcile(machine, context); }
        catch { report = { state: "unknown", detail: "Assignment reconciliation requires inspection; owned state is retained." }; }
        if (machine.leaseFenced) report.leaseFenced = true;
        if (machine.powerOffRequest) report.powerOffId = machine.powerOffRequest;
        if (context.signal.aborted && machine.desired === "running" && report.state === "running") report = { state: "unknown", detail: "Reconciliation ended after authorization; positive native stop evidence is required." };
        this.publish(this.reports, id, report);
      });
    }
    if (!this.fresh() || this.updateAdmissionBlocked) return;
    for (const task of this.queues.device ?? []) {
      if (slots <= 0) break;
      const id = identifier(task.id), key = `device:${id}`;
      if (this.active.has(key) || TERMINAL.has(String(this.deviceReports.get(id)?.state))) continue;
      const machine = this.assignments.find(m => m.id === task.machineId);
      if (machine && this.reports.get(String(machine.id))?.state !== "running" && this.clock.wall() < Number(task.expiresAt)) continue;
      slots--;
      const authorized = (): boolean => this.fresh() && this.queues.device!.some(o => o.id === id) && this.machineAuthorized(String(task.machineId)) && this.clock.wall() < Number(task.expiresAt) && (!task.leaseId || this.consumerOperationAuthorized(task));
      this.launch(key, authorized, context => this.durableWork("device", task, this.deviceReports, c => this.operate(task, c), context));
    }
    this.outboundSessions?.step((this.queues.sessions ?? []) as unknown as RunnerSessionJob[]);
    for (const [kind, adapter, target] of [["inference", this.inferenceAdapter, this.inferenceReports], ["images", this.imageAdapter, this.imageReports]] as const) {
      if ([...this.active.keys()].some(k => k.startsWith(`${kind}:`)) || kind === "inference" && [...target.values()].some(r => r.state === "unknown")) continue;
      const task = this.queues[kind]?.find(t => !TERMINAL.has(String(target.get(String(t.id))?.state)));
      if (!task) continue;
      if (kind === "images" && task.kind === "import" && !this.library.records().some(r => r.public.id === task.id)) continue;
      const id = identifier(task.id), authorized = (): boolean => this.fresh() && this.queues[kind]!.some(t => t.id === id && t.desired !== "cancelled");
      if (kind === "inference" && adapter) this.launch(`${kind}:${id}`, authorized, async context => this.publish(target, id, await adapter.execute(task, context)));
      else this.launch(`${kind}:${id}`, authorized, context => this.durableWork(kind, task, target, c => adapter ? adapter.execute(task, c) : Promise.resolve({ state: "failed", result: { code: "capability_unsupported", detail: `No ${kind} execution adapter is installed; no effect was started.` } }), context));
    }
  }
  private async deadlines(): Promise<void> {
    const fenced = this.guard.fencedMachines();
    for (const [key, work] of this.active) if ([...fenced].some(id => key.endsWith(`:${id}`))) work.controller.abort();
    for (const machine of this.guard.assignments(this.assignments)) {
      if (!machine.lease) continue;
      const id = String(machine.id), key = `fence:${id}`;
      if (this.active.has(key)) continue;
      const { runtime, image, folder } = this.context(machine);
      if (!runtime.refreshExecution) continue;
      this.launch(key, () => !this.closed, async () => {
        const report = await runtime.refreshExecution!(machine, image, folder, () => this.guard.authorization(id, String(object(machine.lease).id)));
        if (report && !machine.leaseCleanup) this.publish(this.reports, id, report);
      });
    }
  }
  private async cleanupStep(): Promise<void> {
    for (const machine of this.guard.assignments(this.assignments)) {
      if (!machine.leaseCleanup) continue;
      const id = String(machine.id), key = `cleanup:${id}`, intent = object(machine.leaseCleanup);
      if (this.active.has(key) || this.clock.wall() < Math.max(this.cleanupDue.get(id) ?? 0, Number(intent.notBefore ?? 0))) continue;
      this.launch(key, () => !this.closed, async () => {
        const report = await this.reconcile(machine); this.publish(this.reports, id, report);
        const cleanup = object(report.leaseCleanup);
        this.cleanupDue.set(id, this.clock.wall() + (cleanup.state === "complete" ? 1 : Math.min(60, 2 ** Math.min(6, Number(cleanup.attempt)))));
      });
    }
  }
  async checkEnvironment(): Promise<void> {
    const checks: RecordValue[] = [];
    for (const runtime of this.runtimes.values()) {
      try { const result = await runtime.check(); if (this.stopController.signal.aborted) return; checks.push({ id: runtime.kind, label: `${runtime.kind} runtime`, detail: "Provider prerequisite validation completed.", status: objectOrStatus(result) }); }
      catch { checks.push({ id: runtime.kind, label: `${runtime.kind} runtime`, status: "failed", detail: "Runtime diagnostics failed; inspect private configuration." }); }
    }
    if (!this.stopController.signal.aborted) this.health = { status: checks.some(c => c.status === "failed") ? "failed" : "passed", checkedAt: this.clock.wall(), checks };
  }
  async collectResources(): Promise<void> {
    const cores = cpus(), cpuCount = cores.length, idle = cores.reduce((n, c) => n + c.times.idle, 0), total = cores.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
    const previous = this.hostCpu; this.hostCpu = { idle, total };
    const usage = process.cpuUsage(), birth = this.processBirth;
    const observations: ProcessObservation[] = [{ pid: process.pid, birth, name: "runner", userSeconds: usage.user / 1e6, systemSeconds: usage.system / 1e6, rssBytes: process.memoryUsage().rss, category: "services", verify: () => true }];
    const unavailable = new Set<UsageCategory>();
    for (const machine of this.assignments) {
      const category: UsageCategory = ["android", "ios"].includes(String(object(machine.template).os)) ? "simulators" : "virtualMachines";
      try {
        const { runtime, image, folder } = this.context(machine);
        if (!runtime.resourceProcesses) { if (machine.observed !== "stopped") unavailable.add(category); continue; }
        const collected = await runtime.resourceProcesses(machine, image, folder);
        for (const value of collected) {
          const p = object(value);
          // Provider attribution must carry its own post-sample identity check.
          if (typeof p.verify !== "function" || ![p.pid, p.birth, p.userSeconds, p.systemSeconds, p.rssBytes].every(n => typeof n === "number" && Number.isFinite(n))) { unavailable.add(category); continue; }
          observations.push({ ...(p as unknown as ProcessObservation), category });
        }
      } catch { unavailable.add(category); }
    }
    let disk: RecordValue = { diskTotalGiB: null, diskFreeGiB: null };
    try { const sample = statfsSync(String(this.config.storage ?? this.state)); disk = { diskTotalGiB: sample.blocks * sample.bsize / 2 ** 30, diskFreeGiB: sample.bavail * sample.bsize / 2 ** 30 }; } catch { /* Missing telemetry remains unknown. */ }
    let cluster: RecordValue | undefined;
    const binding = legacyDigest(this.assignments);
    for (const runtime of this.runtimes.values()) if (runtime.resourceReport) {
      try { const report = await runtime.resourceReport(structuredClone(this.assignments)); if (binding === legacyDigest(this.assignments)) cluster = report; }
      catch { this.log("Cluster resource observation unavailable; no ownership totals inferred."); }
    }
    const sample = validateSample({ scope: this.config.provider === "kubevirt" ? "runner" : "host", domain: hostname().slice(0, 100), sampledAt: this.clock.wall(), cpuCount, cpuPercent: previous && total > previous.total ? Math.max(0, Math.min(100, 100 * (1 - (idle - previous.idle) / (total - previous.total)))) : null, memoryTotalMiB: totalmem() / 2 ** 20, memoryAvailableMiB: freemem() / 2 ** 20, ...disk, ...(cluster ? { cluster } : {}), canaveral: this.usage.collect(observations, cpuCount, this.clock.now(), unavailable, true) });
    if (!this.stopping) this.resourceSample = sample;
  }
  /** Admission only: existing operations keep their original authorization and signals. */
  get updateAdmissionFenced(): boolean { return this.updateAdmissionBlocked; }
  fenceUpdateAdmission(): void { this.updateAdmissionBlocked = true; }
  resumeUpdateAdmission(): void { this.updateAdmissionBlocked = false; }
  async updateIdle(): Promise<{ idle: boolean; workloadsStopped: boolean }> {
    const negative = { idle: false, workloadsStopped: false };
    const eligible = (): boolean => this.fresh() && !this.closed && this.active.size === 0 && this.updateExternalWork === 0 &&
      Object.values(this.queues).every(queue => queue.length === 0) &&
      [this.reports, this.deviceReports, this.inferenceReports, this.imageReports, this.sessionReports].every(reports =>
        [...reports.values()].every(r => ["stopped", "succeeded", "failed", "cancelled"].includes(String(r.state)) && (r.stopped === undefined || r.stopped === true) && !["pending", "unknown"].includes(String(r.cleanup))));
    if (!eligible()) return negative;
    const epoch = this.updateEpoch;
    const retained = new Map(this.updateAssignments);
    for (const machine of this.guard.assignments(this.assignments)) retained.set(String(machine.id), machine);
    if ([...retained.values()].some(m => m.desired !== "stopped")) return negative;
    try {
      // Unknown older local assignment directories cannot be inferred stopped from an empty heartbeat.
      for (const state of new Set([this.state, ...[...this.runtimes.values()].map(r => r.state ?? this.state)])) {
        const root = join(state, "machines"); noLinks(root);
        if (present(root) && readdirSync(root).some(id => !retained.has(id) && !this.guard.records.get(id)?.retired)) return negative;
      }
      for (const machine of retained.values()) {
        const { runtime, image, folder } = this.context(machine);
        if (!helpersClosed(machine, folder)) return negative;
        const stopped = runtime.updateStopped ? await runtime.updateStopped(machine, image, folder) :
          runtime.confirmExecutionStopped?.(machine, folder)?.executionStopped === true;
        if (!stopped || epoch !== this.updateEpoch || !eligible()) return negative;
      }
      // Only stopped assignments reach helper closure; a live VM is never closed for an update.
      await this.guest?.sweep?.(new Set());
      for (const runtime of this.runtimes.values()) await runtime.sweep?.(new Set());
      for (const machine of retained.values()) await this.context(machine).runtime.closeShells?.(machine);
    } catch { return negative; }
    return epoch === this.updateEpoch && eligible() ? { idle: true, workloadsStopped: true } : negative;
  }
  async quiesceForUpdate(): Promise<{ idle: boolean; workloadsStopped: boolean; quiesced: boolean }> {
    this.fenceUpdateAdmission();
    const receipt = await this.updateIdle();
    return { ...receipt, quiesced: receipt.idle && receipt.workloadsStopped };
  }
  async start(): Promise<this> {
    if (this.started || this.closed) throw new ServiceError("Host runner cannot be started twice.", 409);
    this.lock = new StateLock(join(this.state, "host-runner.sqlite")); this.started = true;
    try {
      for (const image of this.config.templates as RecordValue[]) if (image.source && !image.catalogueImageId) {
        if (this.config.provider === "kubevirt") throw new ServiceError("KubeVirt requires a separately installed base PVC; omit image source.", 409);
        const runtimeConfig = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? enabledRuntimes(this.config)[runtimeFor(this.config, image)] : undefined;
        const cache = runtimeConfig?.imageCache ?? this.config.imageCache;
        if (typeof cache !== "string") throw new ServiceError("Configure imageCache for verified base sources.", 400);
        image.image = await prepareImage(image.source, cache);
      }
      await this.initializeProviders();
      try { await this.connect(); } catch (error) { if (!this.identity || !this.guard.records.size) throw error; this.log("Controller enrollment unavailable; enforcing retained lease deadlines while reconnecting."); }
      if (this.updateAdmissionBlocked) { await this.poll(); if (!this.fresh()) throw unknownOutcome("Managed startup needs fresh authenticated controller contact."); }
      this.loops.push(this.loop(async () => { try { await this.poll(); } catch { this.log("Host heartbeat failed; enforcing retained execution deadlines."); } }, this.pollInterval * 1000));
      this.loops.push(this.loop(() => this.step(), 100));
      this.loops.push(this.loop(() => this.deadlines(), 100));
      this.loops.push(this.loop(() => this.cleanupStep(), 100));
      this.loops.push(this.loop(() => this.collectResources(), 5000));
      this.loops.push(this.loop(async () => { if (this.checkRequested || this.clock.wall() >= this.nextCheck) { this.checkRequested = false; this.nextCheck = this.clock.wall() + 60; await this.checkEnvironment(); } }, 1000));
      return this;
    } catch (error) { try { await this.close(); } catch { this.log("Host startup cleanup was not fully confirmed."); } throw error; }
  }
  private async loop(work: () => Promise<void>, interval: number): Promise<void> {
    while (!this.stopController.signal.aborted) {
      try { await work(); } catch { this.log("Host worker failed; retained state requires inspection."); }
      await delay(interval, this.stopController.signal);
    }
  }
  async wait(): Promise<void> { await Promise.all(this.loops); }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.stopController.abort();
    for (const work of this.active.values()) work.controller.abort();
    let failed = false;
    const cleanup = async (work: () => Promise<unknown>): Promise<void> => { try { await bounded(work(), 5000); } catch { failed = true; this.log("Host cleanup was not confirmed; inspect retained state."); } };
    await cleanup(() => this.processes.close());
    if (this.guest?.sweep) await cleanup(() => this.guest!.sweep!(new Set()));
    for (const runtime of this.runtimes.values()) if (runtime.sweep) await cleanup(() => runtime.sweep!(new Set()));
    for (const machine of this.guard.assignments(this.assignments)) await cleanup(async () => this.context(machine).runtime.closeShells?.(machine));
    if (this.outboundSessions) await cleanup(() => this.outboundSessions!.close());
    if (this.displayControls) await cleanup(async () => this.displayControls!.close());
    for (const adapter of [this.guest, this.inferenceAdapter, this.imageAdapter, this.sessionAdapter, ...this.runtimes.values()]) if (adapter?.close) await cleanup(() => adapter.close!());
    await cleanup(() => Promise.all([...this.loops, ...[...this.active.values()].map(w => w.promise)]));
    // A still-running in-process adapter could mutate state. Keep the lock until
    // that work settles; do not let another host adopt it after a timeout.
    if (!failed) { this.lock?.close(); this.lock = undefined; }
    else { void Promise.allSettled([...this.loops, ...[...this.active.values()].map(w => w.promise)]).then(() => { this.lock?.close(); this.lock = undefined; }); throw new ServiceError("Host shutdown was not fully confirmed.", 409, { code: "host_shutdown_incomplete", retryable: false, outcome: "unknown" }); }
  }
}
function objectOrStatus(value: unknown): string { if (value === false) return "failed"; if (value && typeof value === "object" && "status" in value) return String((value as RecordValue).status); return "passed"; }
function records(value: unknown, label: string): RecordValue[] { if (!Array.isArray(value) || value.length > 10_000) throw new ServiceError(`Invalid ${label}.`, 400); return value.map(v => { const r = object(v); identifier(r.id); return r; }); }
function recordsWithoutIds(value: unknown): RecordValue[] { if (!Array.isArray(value)) throw new ServiceError("Invalid template catalogue.", 400); return value.map(object); }
function firstReport(reports: Map<string, RecordValue>): RecordValue { const first = reports.entries().next().value; if (!first) return {}; reports.delete(first[0]); reports.set(first[0], first[1]); return { [first[0]]: first[1] }; }
function delay(ms: number, signal: AbortSignal): Promise<void> { return new Promise(r => { if (signal.aborted) { r(); return; } const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); r(); }; const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true }); }); }
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unknownOutcome()), ms); })]); } finally { if (timer) clearTimeout(timer); } }
/** Start outbound workers. The caller owns signals and awaits close() on shutdown. */
export async function startHost(config: HostConfig, dependencies: HostDependencies = {}): Promise<HostRunner> { return new HostRunner(config, dependencies).start(); }
export async function checkHost(config: HostConfig, dependencies: HostDependencies = {}): Promise<RecordValue> {
  const runner = new HostRunner(config, dependencies);
  try { await runner.initializeProviders(); await runner.checkEnvironment(); return runner.health; }
  finally { await runner.close(); }
}
/** CLI-compatible entry point, invoked by the main CLI rather than import side effects. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "host") argv = argv.slice(1);
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name === "--allow-http") options[name] = true;
    else if (["--config", "--setup-file", "--state", "--url", "--enrollment-token-file", "--ca-file"].includes(name) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) options[name] = argv[++i]!;
    else throw new ServiceError("Host requires --config or --setup-file, --state and --url.", 400);
  }
  if (!options["--state"] || (!!options["--config"] === !!options["--setup-file"])) throw new ServiceError("Specify exactly one host config or setup file and a private state directory.", 400);
  const setup = options["--setup-file"] ? object(JSON.parse(readFileSync(String(options["--setup-file"]), "utf8")) as unknown) : undefined;
  const local = setup ? object(setup.config) : loadHostConfig(String(options["--config"]));
  const token = options["--enrollment-token-file"] ? readFileSync(String(options["--enrollment-token-file"]), "utf8").trim() : setup?.enrollmentToken;
  const config: HostConfig = { ...local, url: text(setup?.controllerUrl ?? options["--url"], "controller URL", 8000), stateDir: String(options["--state"]), allowHTTP: options["--allow-http"] === true, ...(token ? { enrollmentToken: secret(token) } : {}), ...(options["--ca-file"] ? { caFile: String(options["--ca-file"]) } : {}) };
  const runner = await startHost(config);
  const stop = (): void => { void runner.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await runner.wait(); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); await runner.close(); }
}
