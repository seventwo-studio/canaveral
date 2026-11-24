import { GuestHelperAccess } from "./control/sessions.ts";
import { appArtifactSource } from './app-artifact-source.ts';
import { captureNotRunning, markNotStaged } from './providers/mobile.ts';
import type { WarmAuthorization } from './providers/mobile.ts';
import { IOS_LEASE_ISOLATION } from './providers/ios.ts';
import { serveMobileVideo } from './mobile-video.ts';
import { LiveCaptureHub, LiveCaptureRefused } from './live-capture.ts';
import type { LiveCaptureSource } from './live-capture.ts';
import { LIVE_FPS } from './mobile-live.ts';
import type { GuestHelperBinding } from "./control/session-protocol.ts";
import type { OwnedGuestAuthority } from "./providers/apple-binding.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSecureContext } from "node:tls";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldWork } from "node:timers/promises";
import { identifier } from "./consumers.ts";
import { object, secret, ServiceError } from "./errors.ts";
import { enabledRuntimes, HOST_RUNTIMES, legacyDigest, loadHostConfig, normalizeOperatorTemplate as normalizeTemplate, resources, runtimeFor, text } from "./control/templates.ts";
import { credential, sshPreparation, userData } from "./control/preparation.ts";
import { createProvider } from "./providers/index.ts";
import type { NativeProvider } from "./providers/index.ts";
import { ImageLibrary, prepareImage, specification } from "./control/images.ts";
import type { CaptureProvider, ImageReader, ImportOptions } from "./control/images.ts";
import { inferenceOffer, INFERENCE_HOST_PROVIDERS } from "./control/inference.ts";
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
import { nativeExecutionClock } from './native-clock.ts';
import { TUNNEL_END_REASONS, TunnelRelay, tunnelIntent } from './tunnel-relay.ts';
import type { TunnelEndReason } from './tunnel-relay.ts';
import { TunnelMappingError, tunnelStorageProblem } from './providers/android-tunnels.ts';
import type { TunnelEndpoint, TunnelSpec } from './providers/android-tunnels.ts';
import { WORKER_MESSAGES } from './control/session-protocol.ts';
import { PressureMonitor, pressureConfig, readMemorySignal } from "./pressure.ts";
import type { PressureGates, PressureReport, PressureSample } from "./pressure.ts";
import type { OrphanEvidence, OrphanRemoval, RuntimeContext, RuntimeReport } from "./providers/mobile-runtimes.ts";

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
  /** Readiness of a guest connection that needs no preparation recipe (macOS desktops). */
  ready?(machine: RecordValue, image: RecordValue, folder: string): Promise<boolean>;
}
export interface HostDependencies {
  transport?: HostTransport; clock?: ExecutionClock;
  /** The operating system the lease gate judges. Fixtures inject it in code; no configuration
   * key or environment variable can change it. */
  platform?: NodeJS.Platform;
  providerFactory?: (config: RecordValue, state: string) => NativeProvider | Promise<NativeProvider>;
  guest?: GuestAccess;
  inference?: HostTaskAdapter; images?: HostImageAdapter; sessions?: HostTaskAdapter;
  log?: (message: string) => void;
  /** Test seam: the length of one live capture run; production uses the native 180 seconds. */
  liveEpochSeconds?: number;
  /** One raw memory and disk reading; fixtures script it instead of reading this machine. */
  pressureSample?: () => Promise<PressureSample> | PressureSample;
}
interface Runtime extends NativeProvider {
  guestHelperBinding?(machine: RecordValue, image: RecordValue, folder: string, authority: OwnedGuestAuthority): Promise<GuestHelperBinding>;
  closeMachine?(id: string): Promise<void>;
  updateStopped?(machine: RecordValue, image: RecordValue, folder: string, readOnly?: boolean): Promise<boolean>;
  confirmExecutionStopped?(machine: RecordValue, folder: string, readOnly?: boolean): RecordValue | null;
  deletionFingerprint?(machine: RecordValue, image: RecordValue): string;
  maintenanceStorage?(machine: RecordValue, image: RecordValue, folder: string): Promise<StoragePresence>;
  readonly state?: string;
  readonly config?: RecordValue;
  operate?(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue, authorized?: () => boolean, handler?: (request: import('./providers/mobile.ts').DeviceRequest) => Promise<RecordValue>): Promise<RecordValue>;
  installArtifact?(machine: RecordValue, image: RecordValue, folder: string, source: import('./providers/mobile.ts').Download, sha256: string, authorized: () => boolean): Promise<RecordValue>;
  inspectInstall?(machine: RecordValue, image: RecordValue, args: RecordValue): Promise<RecordValue>;
  openVideo?(machine: RecordValue, image: RecordValue, folder: string, options: { fps: number; durationSeconds: number; bitRate: number }, authorized: () => boolean, cleanupAuthorized?: () => boolean): Promise<import('./providers/mobile.ts').NativePipe>;
  pipe?(argv: readonly string[]): Promise<import('./providers/mobile.ts').NativePipe>;
  /** Installs one lease tunnel mapping. Throws TunnelMappingError once a mapping may exist; any other error means none was installed. */
  openTunnel?(machine: RecordValue, image: RecordValue, folder: string, spec: TunnelSpec, authorized: () => boolean, onConnection: (socket: import('node:net').Socket) => void): Promise<TunnelEndpoint>;
  tunnelMappingAbsent?(machine: RecordValue, image: RecordValue, spec: TunnelSpec, authorized: () => boolean): Promise<boolean>;
  closeTunnels?(machine: RecordValue): Promise<void>;
  refreshExecution?(machine: RecordValue, image: RecordValue, folder: string, authorization: () => LeaseAuthorization): Promise<RecordValue | undefined>;
  removeOwnedStorage?(machine: RecordValue, image: RecordValue, folder: string, requestId: string, preboot?: boolean): Promise<RecordValue>;
  stopForCleanup?(machine: RecordValue, image: RecordValue, folder: string): Promise<RecordValue>;
  ownsStorage?(machine: RecordValue, image: RecordValue, storage: string): boolean;
  settleClaim?(machine: RecordValue, image: RecordValue, folder: string): Promise<void>;
  saveBaseline?(machine: RecordValue, image: RecordValue, folder: string, request: { id: string; name: string; revision: string }, authorized: () => boolean): Promise<RecordValue>;
  removeBaseline?(request: { id: string; name: string; revision: string }): RecordValue;
  baselineInventory?(): RecordValue[];
  sweep?(active: Set<string>): Promise<unknown>;
  close?(): Promise<unknown>;
  resourceProcesses?(machine: RecordValue, image: RecordValue, folder: string): Promise<unknown[]>;
  control?(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue): Promise<RecordValue>;
  streamUpload?: GuestAccess["streamUpload"];
  streamDownload?: GuestAccess["streamDownload"];
  desktop?: GuestAccess["desktop"];
  closeShells?(machine: RecordValue): Promise<void>;
  resourceReport?(assignments: RecordValue[]): Promise<RecordValue>;
  /** Mobile runtimes only: operator-requested runtime changes and orphan storage evidence. */
  runtimeOperation?(kind: string, args: RecordValue, context: RuntimeContext): Promise<RuntimeReport>;
  orphanEvidence?(name: string): Promise<OrphanEvidence>;
  purgeOrphan?(name: string, requestId: string, hostId: string | undefined): Promise<{ assignmentFingerprint: string | undefined; removed: OrphanRemoval[] }>;
  strayDevices?(): Promise<{ name: string; machineId: string; kind: string }[]>;
}
interface DurableWork { fingerprint: string; state: string; report?: RecordValue }
interface MaintenanceFence { drainId: string; challenge: string }
type StoragePresence = "present" | "absent" | "unknown" | "unsupported" | "notMaterialized";
interface MaintenanceProof extends MaintenanceFence {
  idle: boolean; workloadsStopped: boolean;
  inventory: { complete: boolean; assignments: { id: string; storage: StoragePresence; stopProof: "native" | "unsupported" }[]; unexpected: string[] };
  issues: string[];
}
type IdleReceipt = Pick<MaintenanceProof, "idle" | "workloadsStopped">;
const NOT_IDLE = { idle: false, workloadsStopped: false };
const MAX_HOST_MESSAGE = 8 * 1_048_576;
const TERMINAL = new Set(["succeeded", "failed", "unknown", "cancelled"]);
const PRIVATE_CONFIG = new Set(["url", "stateDir", "enrollmentToken", "allowHTTP", "caFile", "leaseClockHelper"]);
export interface IdleStopPolicy { defaultSeconds: number | null; templates: Record<string, number | null> }
/** Operator idle-stop policy (`upkeep` in the host file): off unless set, for the host and
 * optionally per template. The controller applies it; this host only advertises it. */
export function upkeepPolicy(value: unknown, templateIds: readonly string[]): IdleStopPolicy {
  if (value === undefined) return { defaultSeconds: null, templates: {} };
  const input = object(value), invalid = (): never => { throw new ServiceError("Invalid upkeep configuration.", 400); };
  if (Object.keys(input).some(key => key !== "idleStopSeconds" && key !== "templates")) invalid();
  const seconds = (raw: unknown): number | null => {
    if (raw === undefined || raw === null || raw === 0) return null;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 300 || raw > 2_592_000) invalid();
    return raw as number;
  };
  const templates: Record<string, number | null> = {};
  for (const [id, entry] of Object.entries(object(input.templates ?? {}))) {
    const settings = object(entry);
    if (!templateIds.includes(id) || Object.keys(settings).some(key => key !== "idleStopSeconds")) invalid();
    templates[id] = seconds(settings.idleStopSeconds);
  }
  return { defaultSeconds: seconds(input.idleStopSeconds), templates };
}

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
    const data = method === "GET" ? undefined : Buffer.from(JSON.stringify(body));
    if (data && data.length > MAX_HOST_MESSAGE) throw new ServiceError("Host report exceeds the request bound.", 413);
    return new Promise((accept, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, result?: RecordValue): void => { if (settled) return; settled = true; clearTimeout(deadline); if (error) reject(error); else accept(result!); };
      const invoke = base.protocol === "https:" ? httpsRequest : httpRequest;
      const request = invoke(new URL(path, base), { method, ...(ca ? { ca } : {}), ...(signal ? { signal } : {}), headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HOST_MESSAGE) { response.destroy(); finish(new ServiceError("Controller reply exceeds its bound.", 413)); } else chunks.push(chunk);
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

/** Only supervised Android emulators and, by explicit operator opt-in, supervised iOS simulators
 * have independent native deadline enforcement and owned cleanup. Every other runtime keeps
 * refusing lease declarations, whatever the configuration.
 *
 * iOS (owner decision, 21 November 2026): a simulator app is an ordinary process of the Mac
 * host's user, so a leased simulator is not fenced from the host. A host therefore advertises
 * an iOS lease image only when that selector itself declares `isolation: "shared-host"`, on
 * macOS, with the native supervisor and the lease's control companion configured. There is no
 * default for the declaration and nothing outside this configuration can supply it. */
export function leaseOffer(config: RecordValue, platform: NodeJS.Platform = process.platform): RecordValue {
  if (!("leaseProtocol" in config) && !("leaseImages" in config)) {
    if ("leaseTunnelProtocol" in config) throw new ServiceError("Lease tunnels require lease execution on this host.", 400);
    if ("leaseWarmPool" in config) throw new ServiceError("Warm devices need supervised Android lease execution on this host.", 400);
    return {};
  }
  const refuse = (detail = "before native fencing and owned cleanup acceptance"): never => { throw new ServiceError(`This runner cannot advertise lease execution ${detail}.`, 400); };
  if (config.leaseProtocol !== 1 || !Array.isArray(config.leaseImages) || !config.leaseImages.length || config.leaseImages.length > 100) refuse();
  const provider = String(config.provider);
  const runtime = (kind: "android" | "ios"): RecordValue | undefined => {
    try { const settings = provider === kind ? config : Object.hasOwn(HOST_RUNTIMES, provider) ? enabledRuntimes(config)[kind] : undefined; return settings === undefined ? undefined : object(settings); }
    catch { return refuse(); }
  };
  const absolute = (value: unknown): boolean => typeof value === "string" && isAbsolute(value);
  if (!absolute(config.leaseClockHelper)) refuse();
  const leaseImages = (config.leaseImages as unknown[]).map(value => {
    const entry = object(value), fields = Object.keys(entry).sort().join();
    const identity = () => ({ id: text(entry.id, "lease image id"), revision: text(entry.revision, "lease image revision"), arch: text(entry.arch, "lease image arch") });
    if (entry.runtime === "android") {
      if (fields !== "arch,id,revision,runtime" || !absolute(runtime("android")?.leaseSupervisor) || !["darwin", "linux"].includes(platform)) refuse();
      return { ...identity(), runtime: "android" };
    }
    if (entry.runtime === "ios") {
      const ios = runtime("ios");
      if (fields !== "arch,id,isolation,revision,runtime" || entry.isolation !== IOS_LEASE_ISOLATION) refuse("for an iOS simulator without the explicit shared-host isolation declaration on its lease image");
      if (!ios || !absolute(ios.leaseSupervisor) || !absolute(ios.idbCompanion) || ios.xcrun !== undefined && !absolute(ios.xcrun) || platform !== "darwin") refuse("for iOS simulators without macOS, the native lease supervisor and an absolute idbCompanion");
      return { ...identity(), runtime: "ios", isolation: IOS_LEASE_ISOLATION };
    }
    return refuse();
  });
  const offer: RecordValue = { leaseProtocol: 1, leaseImages };
  // Lease port tunnels are off unless the operator declares them. Their host-side sockets live in
  // each lease's private storage, so the storage path must fit a Unix socket address.
  if (config.leaseTunnelProtocol !== undefined) {
    if (config.leaseTunnelProtocol !== 1) throw new ServiceError("Unsupported lease tunnel protocol.", 400);
    const android = runtime("android");
    if (!android || !leaseImages.some(image => image.runtime === "android")) throw new ServiceError("Lease tunnels require an Android lease image on this host.", 400);
    const root = typeof android.storage === "string" ? android.storage : typeof config.storage === "string" ? join(config.storage, "android") : undefined;
    const problem = root === undefined ? "Lease tunnels need a configured Android storage path." : tunnelStorageProblem(root);
    if (problem) throw new ServiceError(problem, 400);
    offer.leaseTunnelProtocol = 1;
  }
  // Warm devices are an explicit host opt-in with the host's own bounds. The controller's targets
  // can only be smaller; this runner refuses a warm assignment beyond them whatever it is sent.
  if ("leaseWarmPool" in config) {
    if (!leaseImages.some(image => image.runtime === "android")) throw new ServiceError("Warm devices need supervised Android lease execution on this host.", 400);
    const pool = object(config.leaseWarmPool), bound = (key: string, minimum: number, maximum: number): number => {
      const value = pool[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ServiceError(`leaseWarmPool.${key} must be an integer from ${minimum} to ${maximum}.`, 400);
      return value;
    };
    if (Object.keys(pool).sort().join() !== "maxAgeSeconds,maxDevices") throw new ServiceError("leaseWarmPool takes exactly maxDevices and maxAgeSeconds.", 400);
    offer.warmPool = { maxDevices: bound("maxDevices", 1, 64), maxAgeSeconds: bound("maxAgeSeconds", 60, 86400) };
  }
  return offer;
}
export function hostOffer(config: RecordValue, platform: NodeJS.Platform = process.platform): RecordValue {
  const leases = leaseOffer(config, platform);
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
  for (const entry of (leases.leaseImages ?? []) as RecordValue[]) if (!templates.some(t => t.id === entry.id && t.revision === entry.revision && t.arch === entry.arch && t.os === entry.runtime)) throw new ServiceError(`Lease images must name offered ${entry.runtime === "ios" ? "iOS" : "Android"} templates.`, 400);
  // An account-owned emulator launches without the lease isolation arguments, so it can reach this
  // host's adb server and, through it, the device port of another lease's tunnel. A host that
  // declares tunnels therefore offers Android templates for leases only, and refuses to start.
  if (leases.leaseTunnelProtocol === 1 && templates.some(t => t.os === "android" && !((leases.leaseImages ?? []) as RecordValue[]).some(entry => entry.id === t.id && entry.revision === t.revision && entry.arch === t.arch))) {
    throw new ServiceError("A host that declares lease tunnels may offer only leased Android templates; move account-owned Android devices to another host.", 400);
  }
  Object.assign(offer, leases);
  // An inference adapter must provide its validated public catalogue explicitly;
  // executable paths, model directories and resource guard settings stay private.
  if (config.inference !== undefined) {
    if (!INFERENCE_HOST_PROVIDERS.includes(provider)) throw new ServiceError("Embedded inference requires a native Mac or Linux host.", 400);
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
  readonly baselineReports = new Map<string, RecordValue>();
  /** Each warm hold's fixed deadline on this runner's clock. It only ever shortens. */
  private readonly warmHolds = new Map<string, { hold: string; deadline: number }>();
  /** Public view of the baselines stored on this host, refreshed outside the heartbeat path. */
  private baselines: RecordValue[] | undefined;
  readonly hostOperationReports = new Map<string, RecordValue>();
  readonly runtimes = new Map<string, Runtime>();
  readonly transport: HostTransport;
  identity: { id: string; credential: string; orchestrator: string } | undefined;
  assignments: RecordValue[] = [];
  lastContact = 0;
  health: RecordValue = { status: "checking", checkedAt: 0, checks: [] };
  private queues: Record<string, RecordValue[]> = { device: [], inference: [], images: [], sessions: [], video: [], display: [], baselines: [], hostOperations: [], tunnels: [], live: [], liveCaptures: [] };
  /** Running upkeep operations by lane: one runtime change per platform, one storage operation. */
  private readonly upkeepLanes = new Map<string, string>();
  /** Devices that had host-visible work since the last delivered heartbeat, so that work shorter
   * than one heartbeat still counts as activity. */
  private readonly recentlyBusy = new Set<string>();
  readonly idlePolicy: IdleStopPolicy;
  private pressureMonitor: PressureMonitor | undefined;
  /** Off unless the operator opted in: by default pressure is reported, never enforced. */
  private readonly pressureGates: PressureGates;
  pressureReport: PressureReport | undefined;
  /** Running lease tunnels by tunnel id, and when an unconfirmed mapping removal is next rechecked. */
  private readonly tunnelMachines = new Map<string, string>();
  private readonly tunnelRetry = new Map<string, number>();
  private readonly tunnelAuthority = new Map<string, { at: number; allowed: boolean }>();
  /** Live views are attached once per identity; a refused or ended attachment is not retried. */
  private readonly liveAttempts = new Set<string>();
  private readonly liveAuthority = new Map<string, { at: number; value: boolean }>();
  private readonly liveRecordings = new Map<string, { at: number; value: boolean }>();
  /** Recordings whose native capture this runner runs now: from their journal until the capture is
   * stopped. A finished recording's repeated receipt also runs under its `video:` key, and is not one. */
  private readonly recordingCaptures = new Set<string>();
  private liveCaptures: LiveCaptureHub | undefined;
  /** One shared native capture per watched device (live-capture.ts). Its journal lives beside
   * the recording journals; its cleanup receipt uses the recording's finish route. */
  private get liveHub(): LiveCaptureHub {
    const path = (id: string) => join(this.state, 'work', 'live', `${identifier(id)}.json`);
    return this.liveCaptures ??= new LiveCaptureHub({
      load: id => present(path(id)) ? readRecord(path(id)) : undefined,
      save: (id, value) => saveRecord(path(id), value),
      report: async (job, receipt) => {
        if (!this.identity) throw unknownOutcome('Host identity is unavailable.');
        await this.transport.request('POST', `/v1/hosts/${this.identity.id}/video-sessions/${identifier(job.id)}/finish`, { generation: job.generation, ...receipt }, this.identity.credential);
      },
      ...(this.dependencies.liveEpochSeconds === undefined ? {} : { epochSeconds: this.dependencies.liveEpochSeconds }),
    });
  }
  /** Owner display attachments are attempted once per identity; a refused attach is not retried. */
  private readonly displayAttempts = new Set<string>();
  private active = new Map<string, { controller: AbortController; promise: Promise<void>; authorized: () => boolean }>();
  private readonly deviceMachines = new Set<string>();
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
  private readonly retainedAccess = new Set<Runtime | GuestAccess>();
  private readonly appleAccess = new Map<Runtime, GuestAccess>();
  /** Per-machine backoff for macOS desktop helper probes that are not yet answering. */
  private readonly macOSProbeBackoff = new Map<string, { failures: number; next: number }>();
  private readonly accessMachines = new Map<Runtime, Map<string, RecordValue>>();
  private readonly unsupportedAccess: GuestAccess = {control: async () => { throw new ServiceError("Owned macOS access is unavailable.",409,{code:"capability_unsupported"}); }};
  private accessAuthority(machine: RecordValue): () => boolean {
    const id = String(machine.id), lease = object(machine.lease ?? {}).id, fingerprint = assignmentFingerprint(machine);
    return () => {
      const current = this.assignments.find(m => m.id === id);
      return !!current && object(current.lease ?? {}).id === lease && assignmentFingerprint(current) === fingerprint && this.machineAuthorized(id);
    };
  }
  accessBackend(machine: RecordValue): Runtime | GuestAccess {
    const {runtime, image} = this.context(machine); this.retainedAccess.add(runtime);
    let machines = this.accessMachines.get(runtime);
    if (!machines) { machines = new Map(); this.accessMachines.set(runtime,machines); }
    machines.set(String(machine.id), machine);
    let backend: Runtime | GuestAccess;
    if (this.dependencies.guest) backend = this.dependencies.guest;
    else if (image.os === "macos" && runtime.guestHelperBinding) {
      let adapter = this.appleAccess.get(runtime);
      if (!adapter) {
        adapter = new GuestHelperAccess((m,i,f) => runtime.guestHelperBinding!(m,i,f,{authorized:this.accessAuthority(m),clock:this.clock}));
        this.appleAccess.set(runtime,adapter);
      }
      backend = adapter;
    } else if (image.os === "macos") {
      backend = this.dependencies.providerFactory ? runtime : this.unsupportedAccess;
    } else backend = image.os === "linux" ? this.guest ?? runtime : runtime;
    this.retainedAccess.add(backend); return backend;
  }
  private async closeAccessShells(machine: RecordValue): Promise<void> {
    const retained = [...this.accessMachines].filter(([,machines]) => machines.has(String(machine.id)));
    if (retained.length) { for (const [runtime,machines] of retained) await runtime.closeShells?.(machines.get(String(machine.id))!); }
    else await this.context(machine).runtime.closeShells?.(machine);
  }
  private async sweepAccess(active: Set<string>): Promise<void> {
    let failed = false;
    for (const backend of new Set([...this.retainedAccess, ...this.runtimes.values(), ...(this.guest ? [this.guest] : [])])) { try { await backend.sweep?.(active); } catch { failed = true; } }
    if (failed) throw unknownOutcome("Runtime access closure is unconfirmed.");
  }
  private async closeMachineAccess(id: string): Promise<void> {
    for (const backend of new Set([...this.retainedAccess, ...this.runtimes.values(), ...(this.guest ? [this.guest] : [])])) await backend.closeMachine?.(id);
  }
  private outboundSessions: RunnerSessions | undefined;
  private displayControls: DisplayControls | undefined;
  private usage = new ProcessUsageCollector();
  resourceSample: RecordValue | undefined;
  private hostCpu: { idle: number; total: number } | undefined;
  private readonly processBirth = Date.now() / 1000 - process.uptime();
  private cleanupDue = new Map<string, number>();
  private machineCursor = 0;
  private maintenanceFence: MaintenanceFence | null = null;
  private maintenanceChallenge: MaintenanceFence | null = null;
  private maintenanceProof: { challenge: MaintenanceFence; proof: MaintenanceProof } | undefined;
  private inspectingMaintenance = false;
  private updateAdmissionBlocked = false;
  private updateEpoch = 0;
  private updateExternalWork = 0;
  private updateAssignments = new Map<string, RecordValue>();
  constructor(config: HostConfig, readonly dependencies: HostDependencies = {}) {
    // Validate trust before writing identity, even with an injected transport.
    const transport = hostTransport(config), platform = dependencies.platform ?? process.platform;
    leaseOffer(config, platform);
    const clock = dependencies.clock ?? (config.leaseClockHelper === undefined ? executionClock() : nativeExecutionClock(config.leaseClockHelper as string));
    this.config = structuredClone(config);
    this.state = resolve(config.stateDir); privateDirectory(this.state);
    this.library = new ImageLibrary(this.state);
    this.config.templates = [...recordsWithoutIds(config.templates), ...this.library.definitions()];
    this.offer = hostOffer(this.config, platform);
    this.imageAdapter = dependencies.images ?? {
      execute: (task, context) => this.imageWork(task, context),
      importImage: (metadata, source, size, authorized) => this.importImage(metadata, source, size, authorized),
    };
    this.inferenceAdapter = dependencies.inference; this.sessionAdapter = dependencies.sessions;
    this.pollInterval = Number(config.pollIntervalSeconds ?? 5);
    this.concurrency = Number(config.concurrency ?? 2);
    if (!Number.isFinite(this.pollInterval) || this.pollInterval < .25 || this.pollInterval > 5 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) throw new ServiceError("Invalid host poll interval or concurrency.", 400);
    this.clock = clock;
    this.guard = new LeaseGuard(this.state, this.clock);
    this.idlePolicy = upkeepPolicy(config.upkeep, (this.config.templates as RecordValue[]).map(template => String(template.id)));
    const pressure = pressureConfig(config.pressure);
    this.pressureGates = pressure.gates;
    if (this.config.provider === "kubevirt" && (pressure.gates.placement || pressure.gates.restart)) throw new ServiceError("A KubeVirt pool reports no host pressure and cannot gate on it.", 400);
    // A KubeVirt pool runner measures its own pod, not the cluster's nodes, so it reports no pressure.
    if (this.config.provider !== "kubevirt") {
      if (pressure.enabled) this.pressureMonitor = new PressureMonitor(pressure.thresholds);
      else this.pressureReport = { version: 1, state: "disabled", sampledAt: clock.wall() };
    }
    this.transport = dependencies.transport ?? transport; this.log = dependencies.log ?? (() => {}); this.guest = dependencies.guest;
    this.loadReports();
    const retained = join(this.state, "update-assignments.json");
    if (present(retained)) for (const machine of records(readRecord(retained).machines, "retained update assignments")) this.updateAssignments.set(String(machine.id), machine);
  }
  private loadReports(): void {
    const path = join(this.state, "host-reports.json");
    if (!present(path)) return;
    const saved = readRecord(path, 16 * 1_048_576);
    for (const [name, target] of [["machines", this.reports], ["device", this.deviceReports], ["inference", this.inferenceReports], ["images", this.imageReports], ["sessions", this.sessionReports], ["baselines", this.baselineReports], ["hostOperations", this.hostOperationReports]] as const) {
      for (const [id, report] of Object.entries(object(saved[name] ?? {}))) target.set(identifier(id), object(report));
    }
  }
  private saveReports(): void {
    saveRecord(join(this.state, "host-reports.json"), { machines: Object.fromEntries(this.reports), device: Object.fromEntries(this.deviceReports), inference: Object.fromEntries(this.inferenceReports), images: Object.fromEntries(this.imageReports), sessions: Object.fromEntries(this.sessionReports), baselines: Object.fromEntries(this.baselineReports), hostOperations: Object.fromEntries(this.hostOperationReports) });
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
    // Leased Android guests must not reach the controller's port on this host; the probe needs only the number.
    try { const controller = new URL(String(this.config.url)); clean.leaseControllerPort = Number(controller.port || (controller.protocol === "https:" ? 443 : 80)); } catch { /* no controller URL */ }
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
    return this.fresh() && this.queues.sessions!.some(s => s.id === job.id && s.generation === job.generation && s.leaseId === job.leaseId && s.machineId === job.machineId && s.capability === job.capability) && !!machine && machine.ready === true && machine.desired === "running" && !!machine.lease && object(machine.lease).id === job.leaseId && object(machine.lease).state === "ready" && this.offer.leaseProtocol === 1 && this.leaseEligible(machine) && this.guard.allowed(job.machineId);
  }
  private sessionBackend(job: RunnerSessionJob): RunnerSessionBackend {
    const machine = this.assignments.find(m => m.id === job.machineId);
    if (!machine) throw new ServiceError("Session assignment is unavailable.", 410);
    const { image, folder } = this.context(machine), backend = this.accessBackend(machine);
    const control = async (action: string, args: RecordValue): Promise<RecordValue> => {
      if (!this.sessionAuthorized(job) && action !== "shell-close") throw new ServiceError("Session authorization ended.", 410);
      if (!backend.control) throw new ServiceError("Assignment has no verified guest control transport.", 409, { code: "capability_unsupported" });
      return backend.control(machine, image, folder, { action, arguments: args });
    };
    return {
      control,
      upload: async (path, app, reader, size, authorized) => {
        if (!backend.streamUpload) throw new ServiceError("Assignment has no streaming upload transport.", 409, { code: "capability_unsupported" });
        const result = await backend.streamUpload(machine, image, folder, path, app, reader, size, authorized);
        if (result.uploaded !== size || result.durable !== true) throw unknownOutcome("Upload publication is unconfirmed.");
        return { uploaded: size, durable: true };
      },
      download: async (path, app) => {
        if (!backend.streamDownload) throw new ServiceError("Assignment has no streaming download transport.", 409, { code: "capability_unsupported" });
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
  get guestAccess(): GuestAccess {
    return {
      control: (m,i,f,o) => this.localWork(async () => { const b=this.accessBackend(m); if (!b.control) throw new ServiceError("Access unsupported.",409,{code:"capability_unsupported"}); return b.control(m,i,f,o); }),
      streamUpload: (m,i,f,p,a,r,n,ok) => this.localWork(async () => { const b=this.accessBackend(m); if (!b.streamUpload) throw new ServiceError("Upload unsupported.",409,{code:"capability_unsupported"}); return b.streamUpload(m,i,f,p,a,r,n,ok); }),
      streamDownload: (m,i,f,p,a,ok) => this.localConnection(async () => { const b=this.accessBackend(m); if (!b.streamDownload) throw new ServiceError("Download unsupported.",409,{code:"capability_unsupported"}); return b.streamDownload(m,i,f,p,a,ok); }),
      desktop: (m,i,f) => this.localConnection(async () => { const b=this.accessBackend(m); if (!b.desktop) throw new ServiceError("Desktop unsupported.",409,{code:"capability_unsupported"}); return b.desktop(m,i,f); }),
    };
  }
  get stopping(): boolean { return this.stopController.signal.aborted; }
  /** Use at local connector admission only. Established work keeps its own authority. */
  beginLocalWork(committed = false): () => void {
    if (!committed && this.maintenanceFence) throw new ServiceError("Host maintenance admission is fenced.", 409, { code: "host_draining" });
    this.updateEpoch++; this.updateExternalWork++;
    for (const machine of this.assignments) if (machine.desired === "running") this.recentlyBusy.add(String(machine.id));
    let done = false;
    return () => { if (!done) { done = true; this.updateExternalWork--; } };
  }
  private async localWork<T>(work: () => Promise<T>, committed = false): Promise<T> {
    const done = this.beginLocalWork(committed);
    try { return await work(); } finally { done(); }
  }
  private async localConnection<T extends { close(): void | Promise<void> }>(open: () => Promise<T>): Promise<T> {
    const done = this.beginLocalWork();
    try {
      const connection = await open();
      return new Proxy(connection, { get(target, key) {
        if (key === "close") return async () => { await target.close(); done(); };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } catch (error) { done(); throw error; }
  }
  async accessControl(machineId: string, operation: RecordValue): Promise<RecordValue> {
    if (this.updateAdmissionBlocked) throw new ServiceError("Host update admission is fenced.", 409);
    return this.localWork(async () => {
      const id = identifier(machineId), machine = this.assignments.find(m => m.id === id);
      if (!machine || !this.machineAuthorized(id)) throw new ServiceError("Current assignment access is unavailable.", 410);
      const { runtime, image, folder } = this.context(machine);
      return assignmentAccess(machine, folder, async () => {
        if (!this.machineAuthorized(id)) throw new ServiceError("Assignment access ended.", 410);
        const backend = this.accessBackend(machine);
        if (backend.control) return backend.control(machine, image, folder, operation);
        if (backend === runtime && runtime.operate) { const report = await runtime.operate(machine, image, folder, { ...operation, id: operation.id ?? randomUUID(), expiresAt: operation.expiresAt ?? this.clock.wall() + 30 }, () => this.machineAuthorized(id)); if (report.state !== "succeeded") throw unknownOutcome("Guest operation was not confirmed."); return object(report.result); }
        throw new ServiceError("Verified assignment access is unavailable.", 409, { code: "capability_unsupported" });
      });
    });
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
  async importImage(metadata: RecordValue, source: ImageReader, size: number, authorized: () => boolean, committed = false): Promise<RecordValue> {
    if (this.updateAdmissionBlocked) throw new ServiceError("Host update admission is fenced.", 409);
    return this.localWork(() => this.library.importStream(metadata, source, size, authorized, this.imageSettings(metadata)), committed);
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
  /** Configured definitions are immutable once loaded, but an operator recipe can embed a
   * multi-MiB guest bundle; validating it on every access fence would saturate the host. */
  private readonly configuredDigests = new WeakMap<RecordValue, string>();
  private configuredDigest(image: RecordValue): string {
    let digest = this.configuredDigests.get(image);
    if (digest === undefined) { digest = legacyDigest(normalizeTemplate(image)); this.configuredDigests.set(image, digest); }
    return digest;
  }
  context(machine: RecordValue): { runtime: Runtime; image: RecordValue; folder: string } {
    const result = this.runtimeContext(machine); noLinks(result.folder); return result;
  }
  private runtimeContext(machine: RecordValue): { runtime: Runtime; image: RecordValue; folder: string } {
    const id = identifier(machine.id), template = object(machine.template);
    const image = (this.config.templates as RecordValue[]).find(t => t.id === machine.templateId && t.revision === template.revision && t.arch === template.arch);
    if (!image || this.configuredDigest(image) !== legacyDigest(normalizeTemplate(template))) throw new ServiceError("Assigned immutable template no longer matches this host.", 409);
    const name = Object.hasOwn(HOST_RUNTIMES, String(this.config.provider)) ? runtimeFor(this.config, image) : String(this.config.provider);
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new ServiceError("Assignment runtime is unavailable.", 409, { code: "capability_unsupported" });
    const folder = join(runtime.state ?? this.state, "machines", id);
    // Mobile storage binds the full public template, including normalized defaults.
    // Keep private host settings while giving the provider that exact definition.
    return { runtime, image: structuredClone(['android','ios'].includes(String(image.os)) ? { ...image, ...normalizeTemplate(image) } : image), folder };
  }
  async poll(): Promise<void> {
    if (!this.identity) throw new ServiceError("Host is not connected.", 409);
    const sentReports = new Map(this.reports), deviceReports = firstReport(this.deviceReports, true), inferenceReports = Object.keys(deviceReports).length ? {} : firstReport(this.inferenceReports), imageReports = firstReport(this.imageReports), baselineReports = firstReport(this.baselineReports, true);
    const sent = this.clock.now();
    // Read the current credential on every heartbeat. Rotation delivery may replace
    // identity.json between requests, but cannot change the host/controller binding.
    const identity = readRecord(join(this.state, "identity.json"));
    if (identity.id !== this.identity.id || identity.orchestrator !== this.identity.orchestrator) throw new ServiceError("Persisted host identity binding changed.", 409);
    this.identity.credential = secret(identity.credential);
    const pending = this.maintenanceProof;
    const proof = pending && pending.challenge === this.maintenanceChallenge && this.fresh() ?
      { ...pending.proof, ...(!this.idleEligible() ? NOT_IDLE : {}) } : undefined;
    // Dispatch can consume a challenge even if its response is lost.
    this.maintenanceChallenge = null;
    this.maintenanceProof = undefined;
    const upkeep = this.upkeepReport(), hostOperationReports = upkeep ? Object.fromEntries([...this.hostOperationReports].slice(0, 16)) : {};
    const reportedBusy = upkeep ? upkeep.busy as string[] : [];
    const body = { offer: this.offer, reports: Object.fromEntries(sentReports), deviceReports, inferenceReports, imageReports, installedImages: (this.config.templates as RecordValue[]).map(normalizeTemplate), health: this.health, maintenance: { version: 1, ...(proof ? { proof } : {}) }, ...(this.resourceSample ? { resources: this.resourceSample } : {}),
      ...(this.pressureReport ? { pressure: this.pressureReport } : {}), ...(upkeep ? { upkeep, hostOperationReports } : {}), ...(this.baselines ? { baselines: this.baselines, baselineReports } : {}) };
    if (proof && Buffer.byteLength(JSON.stringify(body)) > MAX_HOST_MESSAGE) delete body.maintenance.proof;
    const response = await this.transport.request("POST", `/v1/hosts/${this.identity.id}/heartbeat`, body, this.identity.credential, this.stopController.signal);
    const machines = records(response.machines, "machines");
    if (new Set(machines.map(m => identifier(m.id))).size !== machines.length) throw new ServiceError("Duplicate host assignments.", 409);
    // Validate the complete response before replacing current authorization.
    const queues = { device: records(response.deviceOperations ?? [], "device operations"), inference: records(response.inferenceJobs ?? [], "inference jobs"), images: records(response.imageTasks ?? [], "image tasks"), sessions: records(response.accessSessions ?? [], "access sessions"), video: records(response.videoSessions ?? [], 'video sessions'), display: records(response.displaySessions ?? [], 'display sessions'), baselines: records(response.baselineTasks ?? [], "baseline tasks"), hostOperations: records(response.hostOperations ?? [], "host operations"), tunnels: records(response.leaseTunnels ?? [], "lease tunnels") ,
      live: records(response.liveViews ?? [], 'live views'), liveCaptures: records(response.liveCaptures ?? [], 'live captures') };
    const maintenance = Object.hasOwn(response, "maintenance") ? maintenanceResponse(response.maintenance) : undefined;
    this.observeWarm(machines, sent);
    this.guard.observe(machines, Math.max(0, this.clock.now() - sent));
    this.library.acknowledge(object(response.imageAcknowledged ?? {}) as Record<string, string>); this.refreshImages();
    const active = new Set(machines.map(m => String(m.id)));
    for (const [id, report] of sentReports) if (!active.has(id)) {
      if (report.leaseCleanup && object(report.leaseCleanup).state === "complete") { const cleanup = object(report.leaseCleanup); this.guard.retire(id, String(cleanup.leaseId), String(cleanup.id)); }
      if (report.deletion && object(report.deletion).state === "complete") this.forgetWarm(id);
      this.reports.delete(id);
    }
    if (legacyDigest({ machines: this.assignments, queues: this.queues }) !== legacyDigest({ machines, queues })) this.updateEpoch++;
    for (const machine of machines) this.updateAssignments.set(String(machine.id), structuredClone(machine));
    for (const [id, record] of this.guard.records) if (record.retired) this.updateAssignments.delete(id);
    saveRecord(join(this.state, "update-assignments.json"), { machines: [...this.updateAssignments.values()] });
    this.assignments = machines; this.queues = queues; this.lastContact = sent;
    // Delivered: work that ended before this heartbeat has now been counted as activity.
    for (const id of reportedBusy) this.recentlyBusy.delete(id);
    if (maintenance !== undefined) this.maintenanceFence = maintenance;
    this.maintenanceChallenge = maintenance ?? null;
    for (const [key, target, sentMap] of [["device", this.deviceReports, deviceReports], ["inference", this.inferenceReports, inferenceReports], ["images", this.imageReports, imageReports], ["baselines", this.baselineReports, baselineReports], ["hostOperations", this.hostOperationReports, hostOperationReports]] as const) {
      const ids = new Set(queues[key].map(r => String(r.id)));
      for (const id of Object.keys(sentMap)) if (!ids.has(id)) target.delete(id);
    }
    if (typeof response.checksRequestedAt === "number" && response.checksRequestedAt > this.lastCheckRequest) { this.lastCheckRequest = response.checksRequestedAt; this.checkRequested = true; }
    this.saveReports(); this.cancelUnauthorized();
    this.inspectMaintenance();
  }
  /** A warm hold's deadline is fixed when the controller creates the device. On this runner's clock
   * it is the earliest value ever derived for it, capped by the host's own maximum age. */
  private observeWarm(machines: RecordValue[], sent: number): void {
    const limit = Number(object(this.offer.warmPool ?? {}).maxAgeSeconds ?? 0), seen = new Set<string>();
    for (const machine of machines) {
      if (!machine.warm) continue;
      const warm = object(machine.warm), id = String(machine.id), hold = identifier(warm.id), previous = this.warmHolds.get(id);
      if (![warm.authorizationDeadline, warm.controllerNow].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new ServiceError("Invalid warm hold deadline.", 400);
      const offered = sent + Math.max(0, Number(warm.authorizationDeadline) - Number(warm.controllerNow));
      this.warmHolds.set(id, { hold, deadline: previous?.hold === hold ? Math.min(previous.deadline, offered) : Math.min(offered, sent + limit) });
      seen.add(id);
    }
    for (const id of [...this.warmHolds.keys()]) if (!seen.has(id)) this.warmHolds.delete(id);
  }
  private warmAuthorization(id: string, hold: string): WarmAuthorization {
    const held = this.warmHolds.get(id);
    if (!held || held.hold !== hold) throw new ServiceError("The warm hold is unavailable.", 409);
    return { holdID: hold, remainingSeconds: Math.max(0, held.deadline - this.clock.now()) };
  }
  /** Warm devices run only where this host's operator enabled them, for its advertised lease images,
   * and never more of them than the host's own limit. */
  warmEligible(machine: RecordValue): boolean {
    const pool = this.offer.warmPool ? object(this.offer.warmPool) : undefined;
    if (!pool || !this.leaseEligible(machine)) return false;
    const held = this.assignments.filter(m => m.warm && !m.lease && !m.deletion && m.desired === "running").map(m => String(m.id)).sort();
    return held.indexOf(String(machine.id)) < Number(pool.maxDevices);
  }
  /** A retired warm device leaves nothing on this host once the controller has acknowledged its proven removal. */
  private forgetWarm(id: string): void {
    const machine = this.updateAssignments.get(id);
    if (!machine?.warm || machine.lease) return;
    try {
      const { folder } = this.context(machine), receipt = join(folder, "deletion.json");
      if (!present(receipt)) return;
      const proof = readRecord(receipt);
      if (proof.state !== "complete" || proof.machineId !== id) return;
      rmSync(folder, { recursive: true }); this.updateAssignments.delete(id);
    } catch { this.log("A retired warm device's local journal was kept for inspection."); }
  }
  /** A claimed warm device's local assignment record gains its lease exactly once. */
  private claimAssignment(machine: RecordValue, folder: string): void {
    const receipt = join(folder, "assignment.json");
    if (!machine.warm || !machine.lease || !present(receipt)) return;
    const owner = readRecord(receipt);
    if (owner.fingerprint === assignmentFingerprint(machine) && owner.warmId === object(machine.warm).id && owner.leaseId === undefined) saveRecord(receipt, { ...owner, leaseId: object(machine.lease).id });
  }
  /** A claimed warm device ran before its lease existed. Before that lease's cleanup, its local
   * records are bound to the lease so the ordinary stop, removal and erasure proofs apply to it. */
  private async settleClaim(machine: RecordValue, runtime: Runtime, image: RecordValue, folder: string): Promise<void> {
    const id = identifier(machine.id), receipt = join(dirname(folder), ".lease-cleanup", `${id}.json`);
    try {
      this.guard.markStarted(id, String(object(machine.lease).id));
      // Only before cleanup has removed anything: afterwards the assignment and its storage are gone on purpose.
      if (!present(folder) || present(receipt) && readRecord(receipt).phase !== "planned") return;
      await assignmentAccess(machine, folder, async () => { this.claimAssignment(machine, folder); await runtime.settleClaim?.(machine, image, folder); }, { exclusive: true });
    } catch { this.log("A claimed warm device could not be settled before cleanup; cleanup reports the reason."); }
  }
  private refreshBaselines(): void {
    const runtime = this.runtimes.get("android");
    if (!runtime?.baselineInventory) return;
    try { this.baselines = runtime.baselineInventory().slice(0, 100); } catch { this.log("The baseline inventory could not be read; the last one is kept."); }
  }
  /** One save or removal at a time. A save holds its device's assignment against reconciliation. */
  private stepBaselines(): void {
    if (!this.fresh() || this.updateAdmissionBlocked || [...this.active.keys()].some(key => key.startsWith("baselines:"))) return;
    const task = (this.queues.baselines ?? []).find(t => !TERMINAL.has(String(this.baselineReports.get(String(t.id))?.state)));
    if (!task) return;
    const id = identifier(task.id), source = task.kind === "save" ? identifier(task.machineId) : undefined;
    if (source && (this.active.has(`machine:${source}`) || this.deviceMachines.has(source))) return;
    if (source) this.deviceMachines.add(source);
    this.launch(`baselines:${id}`, () => this.fresh() && this.queues.baselines!.some(t => t.id === id), async context => {
      try { await this.durableWork("baselines", task, this.baselineReports, c => this.baselineWork(task, c), context); }
      finally { if (source) this.deviceMachines.delete(source); this.refreshBaselines(); }
    });
  }
  private async baselineWork(task: RecordValue, context: HostWorkContext): Promise<RecordValue> {
    const runtime = this.runtimes.get("android"), failed = (code: string, detail: string): RecordValue => ({ state: "failed", result: { code, detail } });
    if (!runtime?.saveBaseline || !runtime.removeBaseline) return failed("capability_unsupported", "This host has no Android baseline store.");
    const request = { id: identifier(task.baseline), name: String(task.name), revision: String(task.revision) };
    const names = (template: unknown): boolean => { const baseline = object(template).baseline; return !!baseline && object(baseline).name === request.name && object(baseline).revision === request.revision; };
    try {
      if (task.kind === "remove") {
        // The host refuses on its own account while anything here still names the baseline.
        if ((this.config.templates as RecordValue[]).some(names) || this.assignments.some(machine => names(machine.template))) return failed("baseline_referenced", "A template or device on this host still names this baseline.");
        return { state: "succeeded", result: runtime.removeBaseline(request) };
      }
      if (task.kind !== "save") return failed("invalid_request", "Unknown baseline task.");
      // The source is this runner's own current, stopped, unleased assignment; nothing else is captured.
      const machine = this.assignments.find(m => m.id === task.machineId);
      if (!machine || machine.lease || machine.warm || machine.deletion || machine.desired !== "stopped" || assignmentFingerprint(machine) !== assignmentFingerprint(object(task.machine))) return failed("baseline_source_unsupported", "The source device is not a stopped, account-owned assignment of this host.");
      const { image, folder } = this.context(machine);
      return { state: "succeeded", result: await runtime.saveBaseline(machine, image, folder, request, context.authorized) };
    } catch (error) {
      // A baseline refusal precedes publication, and the store has already removed its staging directory.
      if (error instanceof ServiceError && error.code.startsWith("baseline_")) return failed(error.code, error.message.slice(0, 500));
      throw error;
    }
  }
  fresh(): boolean {
    try { return !this.stopController.signal.aborted && contactFresh(this.lastContact, this.clock.now()); }
    catch { return false; }
  }
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
    const hold = machine.warm ? identifier(object(machine.warm).id) : null;
    if (machine.leaseCleanup) {
      if (hold && machine.lease) await this.settleClaim(machine, runtime, originalImage, folder);
      const nativeCleanup = runtime.kind === "apple" || ["libvirt", "android", "ios"].includes(runtime.kind) && !!runtime.stopForCleanup;
      return cleanupLease({ state: this.state, storageRoot: String(runtime.config?.storage ?? this.config.storage), machine, folder, guard: this.guard, now: this.clock.wall(),
        closeSessions: async () => {
          this.outboundSessions?.closeMachine(id); await this.closeMachineTunnels(id, runtime, machine); await this.closeMachineAccess(id); await runtime.closeShells?.(machine);
          const active = new Set(this.assignments.filter(m => m.id !== id && this.machineAuthorized(String(m.id))).map(m => String(m.id))); await runtime.sweep?.(active);
        },
        ...(nativeCleanup && runtime.removeOwnedStorage ? {
          stop: () => runtime.stopForCleanup ? runtime.stopForCleanup(machine, originalImage, folder) : runtime.reconcile(machine, { ...originalImage, _leaseAuthorization: () => this.guard.authorization(id, String(object(machine.lease).id)) }, folder),
          remove: (requestId: string, preboot?: boolean) => runtime.removeOwnedStorage!(machine, originalImage, folder, requestId, preboot), preboot: runtime.kind === "apple",
        } : {}),
        ...(runtime.ownsStorage ? { storageOwned: (storage: string) => runtime.ownsStorage!(machine, originalImage, storage) } : {}),
      });
    }
    return assignmentAccess(machine, folder, async () => {
      const fingerprint = assignmentFingerprint(machine), receipt = join(folder, "assignment.json");
      privateDirectory(folder);
      if (hold && machine.lease) { this.guard.markStarted(id, String(object(machine.lease).id)); this.claimAssignment(machine, folder); }
      if (present(receipt)) { const owner = readRecord(receipt); if (owner.fingerprint !== fingerprint || (owner.leaseId ?? null) !== (machine.lease ? object(machine.lease).id : null) || (owner.warmId ?? null) !== hold) throw new ServiceError("Local assignment ownership differs.", 409); }
      else saveRecord(receipt, { fingerprint, ...(hold ? { warmId: hold } : {}), ...(machine.lease ? { leaseId: object(machine.lease).id } : {}) });
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
      let leaseAuthorization: (() => LeaseAuthorization) | undefined, refused = false;
      // A host that declares lease tunnels runs no account-owned emulator, whatever template it
      // was created from: only supervised guests are fenced from the host's adb server.
      const unfenced = !machine.lease && !hold && machine.desired === "running" && runtime.kind === "android" && this.offer.leaseTunnelProtocol === 1;
      if (unfenced) current = { ...machine, desired: "stopped" };
      if (machine.lease) {
        // Default portable clock never authorizes leased starts; preserve and stop
        // pre-existing assignments while their independent native fence runs.
        // The host enforces its own lease gate rather than trusting the controller: an assignment
        // outside its advertised Android or iOS lease images is never started, and is stopped if running.
        refused = machine.desired === "running" && !this.leaseEligible(machine);
        if (!this.guard.allowed(id) || refused) current = { ...machine, desired: "stopped", leaseFenced: true };
        if (current.desired === "running") {
          if (!runtime.refreshExecution) throw new ServiceError("Native independent lease fence is unavailable.", 409);
          const leaseId = String(object(machine.lease).id);
          if (runtime.kind === "apple") recordPreparation(machine, folder, this.guard.neverStarted(id, leaseId));
          this.guard.beginExecution(id, leaseId);
        }
        leaseAuthorization = () => this.guard.authorization(id, String(object(machine.lease).id));
      }
      let warmAuthorization: (() => WarmAuthorization) | undefined;
      if (hold && !machine.lease) {
        // A warm device is not a lease, but the host gates it the same way: its own opt-in, its
        // advertised lease images and its own device limit, whatever the controller sends.
        refused = machine.desired === "running" && !this.warmEligible(machine);
        if (refused) current = { ...machine, desired: "stopped" };
        warmAuthorization = () => this.warmAuthorization(id, hold);
      }
      const authorizations = { ...(leaseAuthorization ? { _leaseAuthorization: leaseAuthorization } : {}), ...(warmAuthorization ? { _warmAuthorization: warmAuthorization } : {}) };
      // Stopping bypasses credentials, source preparation and guest connectivity.
      if (current.desired === "stopped") {
        const stopped = await runtime.reconcile(current, { ...image, ...authorizations }, folder);
        if (!refused && !unfenced) return stopped;
        const detail = unfenced ? "This host declares lease tunnels and runs only supervised, network-isolated Android emulators."
          : hold && !machine.lease ? "This host does not offer warm devices for this runtime and template."
          : "This host does not offer leased execution for this runtime and template.";
        return { ...stopped, state: stopped.state === "stopped" ? "error" : stopped.state, detail };
      }
      if (context && !context.authorized()) throw new ServiceError("Assignment authorization ended.", 410);
      if (image.source && !image.image && !image.catalogueImageId) throw new ServiceError("Prepare and verify the configured base image before runtime creation.", 409);
      if (image.catalogueImageId) this.library.verifyDefinition(image);
      const backend = this.accessBackend(current);
      if (image.guestAccess && "prepare" in backend && backend.prepare) image = await backend.prepare(current, image, folder);
      image = { ...image, ...authorizations };
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
      // A macOS desktop has no preparation recipe: its access is ready once the
      // launch's own helper answers the pinned identity challenge and shows a frame.
      if (!prepared && image.os === "macos" && image.guestAccess && result.state === "running") {
        result.accessReady = false;
        const ready = "ready" in backend ? backend.ready : undefined, key = String(current.id), backoff = this.macOSProbeBackoff.get(key);
        const waiting = "Waiting for the verified macOS guest helper. A desktop whose helper stopped or whose launch certificate expired needs a new launch.";
        // A helper that is not answering is retried with backoff (5 s doubling to 30 s), so one
        // stuck desktop does not dial and run process checks on every poll.
        const unready = (detail: string) => { const failures = (backoff?.failures ?? 0) + 1; this.macOSProbeBackoff.set(key, { failures, next: this.clock.now() + Math.min(30, 5 * 2 ** (failures - 1)) }); result.detail = detail; };
        if (!ready) result.detail = "This host has no verified macOS guest connection.";
        else if (backoff && this.clock.now() < backoff.next) result.detail = waiting;
        else try {
          if (await ready.call(backend, current, image, folder)) { result.accessReady = true; this.macOSProbeBackoff.delete(key); }
          else unready("Waiting for the guest helper to show the desktop.");
        } catch { unready(waiting); }
      } else this.macOSProbeBackoff.delete(String(current.id));
      if (prepared && preparation) {
        if (result.state === "running" && image.guestAccess && backend.control) {
          result.accessReady = false;
          try { if (guestReady(await backend.control!(current, image, folder, { action: "health", arguments: {} }), image)) { preparation.state = "ready"; result.accessReady = true; } }
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
  /** Leased execution runs only on the Android or iOS runtime, for a template this host advertised
   * in leaseImages. An iOS entry counts only with its explicit shared-host isolation declaration. */
  leaseEligible(machine: RecordValue): boolean {
    if (this.offer.leaseProtocol !== 1 || !Array.isArray(this.offer.leaseImages)) return false;
    let context: { runtime: Runtime; image: RecordValue };
    try { context = this.context(machine); } catch { return false; }
    const { runtime, image } = context;
    if (!["android", "ios"].includes(runtime.kind) || image.os !== runtime.kind) return false;
    return (this.offer.leaseImages as RecordValue[]).some(entry => entry.runtime === runtime.kind && entry.id === image.id && entry.revision === image.revision && entry.arch === image.arch &&
      (runtime.kind === "ios" ? entry.isolation === IOS_LEASE_ISOLATION : !("isolation" in entry)));
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
    return this.offer.leaseProtocol === 1 && this.leaseEligible(machine) && this.guard.allowed(String(machine.id));
  }
  private async durableWork(kind: string, task: RecordValue, target: Map<string, RecordValue>, work: (context: HostWorkContext) => Promise<RecordValue>, context: HostWorkContext): Promise<void> {
    const id = identifier(task.id), path = join(this.state, "work", kind, `${id}.json`);
    const stable = kind === "device" ? ["id", "machineId", "leaseId", "action", "arguments"] : kind === "inference" ? ["id", "hostId", "request", "definition"] : kind === "images" ? ["id", "kind", "machineId", "name", "metadata", "registryId"] : kind === "baselines" ? ["id", "kind", "baseline", "name", "revision", "machineId"] : kind === "hostOperations" ? ["id", "kind", "arguments"] : ["id", "generation", "leaseId", "machineId", "capability"];
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
      const backend = this.accessBackend(machine);
      if (operation.action === 'inspect-install') {
        if (!runtime.operate || !runtime.inspectInstall || !['android','ios'].includes(String(image.os))) throw new ServiceError('Install inspection is unsupported.', 409);
        return runtime.operate(machine, image, folder, operation, context.authorized, request => runtime.inspectInstall!(machine, image, request.arguments));
      }
      if (operation.action === 'install-uploaded') {
        if (!runtime.operate || !runtime.installArtifact || !['android','ios'].includes(String(image.os))) throw new ServiceError('Uploaded app installation is unsupported.', 409);
        const identity = this.identity;
        if (!identity) throw new ServiceError('Host identity is unavailable.', 401);
        return runtime.operate(machine, image, folder, operation, context.authorized, async request => {
          const artifact = identifier(request.arguments.artifact), hostId = identity.id;
          const prefix = `/v1/hosts/${hostId}/app-artifacts/${artifact}/operations/${identifier(task.id)}`;
          // A failure while opening the controller download precedes any provider stage.
          const { source, sha256 } = await appArtifactSource(
            path => this.transport.request('GET', path, {}, identity.credential, context.signal), prefix,
            { artifact, machine: identifier(machine.id), format: image.os === 'android' ? 'apk' : 'ios-app-tar' }, context.authorized)
            .catch((error: unknown) => { throw markNotStaged(error); });
          try { return await runtime.installArtifact!(machine, image, folder, source, sha256, context.authorized); }
          finally { await source.close(); }
        });
      }
      if (runtime.operate && (backend === runtime || image.os !== "macos")) return runtime.operate(machine, image, folder, operation, context.authorized);
      if (backend.control) return { state: "succeeded", result: await backend.control(machine, image, folder, operation) };
      return { state: "failed", result: { detail: "No verified guest or device access transport is configured.", code: "capability_unsupported" } };
    });
  }
  async step(): Promise<void> {
    this.cancelUnauthorized();
    // Before machine reconciliation, so a pending save can take its stopped device's turn.
    this.stepBaselines();
    const machines = this.guard.assignments(this.assignments);
    const activeIds = new Set(machines.filter(m => this.machineAuthorized(String(m.id))).map(m => String(m.id)));
    try { await this.sweepAccess(activeIds); } catch { this.log("Runtime connection closure is unconfirmed."); }
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
      // Device operations own the same assignment lock. Keep polling/cancellation
      // active, but wait for the owned operation before reconciling this machine.
      if (this.deviceMachines.has(id) || machine.desired === 'running' && this.reports.get(id)?.state === 'running' && this.queues.device?.some(o => o.machineId === id && !TERMINAL.has(String(this.deviceReports.get(String(o.id))?.state)))) continue;
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
    if (!this.fresh()) return;
    // A runner fenced for an update starts nothing, and says so, so the operation fails as never
    // started instead of holding the update until its deadline and then ending unknown.
    if (this.updateAdmissionBlocked) { this.declineHostOperations("update_fenced", "This runner is fenced for an update and did not start the operation."); return; }
    for (const task of this.queues.device ?? []) {
      if (slots <= 0) break;
      const id = identifier(task.id), key = `device:${id}`;
      if (this.active.has(key) || TERMINAL.has(String(this.deviceReports.get(id)?.state))) continue;
      // Reconciliation owns the same assignment lock; dispatching now would turn a
      // busy lock into an uncertain outcome. Wait for it, as reconciliation waits for operations.
      if (this.active.has(`machine:${String(task.machineId)}`)) continue;
      const machine = this.assignments.find(m => m.id === task.machineId);
      if (machine && this.reports.get(String(machine.id))?.state !== "running" && this.clock.wall() < Number(task.expiresAt)) continue;
      slots--;
      const authorized = (): boolean => this.fresh() && this.queues.device!.some(o => o.id === id) && this.machineAuthorized(String(task.machineId)) && this.clock.wall() < Number(task.expiresAt) && (!task.leaseId || this.consumerOperationAuthorized(task));
      this.launch(key, authorized, async context => {
        const machineId = String(task.machineId); this.deviceMachines.add(machineId); this.recentlyBusy.add(machineId);
        try { await this.durableWork('device', task, this.deviceReports, c => this.operate(task, c), context); }
        finally { this.deviceMachines.delete(machineId); }
      });
    }
    this.outboundSessions?.step((this.queues.sessions ?? []) as unknown as RunnerSessionJob[]);
    this.stepVideo();
    this.stepLive();
    this.stepDisplay();
    this.stepTunnels();
    this.stepHostOperations();
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
  private stepVideo(): void {
    for (const job of this.queues.video ?? []) {
      const id = identifier(job.id), key = `video:${id}`, machineId = identifier(job.machineId), generation = identifier(job.generation);
      if (this.active.has(key) || !this.fresh() || this.updateAdmissionBlocked) continue;
      const path = join(this.state, 'work', 'video', `${id}.json`);
      if (present(path)) {
        const saved = readRecord(path);
        // A lease session may repeat its host-only receipt: the encoder exited, and the lease's own
        // proven emulator removal settles the guest recorder on the controller.
        const receipt = saved.cleaned === true ? { generation, cleaned: true } : saved.hostCleaned === true ? { generation, hostCleaned: true } : undefined;
        if (saved.generation === generation && saved.machineId === machineId && receipt && this.identity) {
          const identity = this.identity;
          this.launch(key, () => this.fresh(), async () => {
            await this.transport.request('POST', `/v1/hosts/${identity.id}/video-sessions/${id}/finish`, receipt, identity.credential, this.stopController.signal);
          });
        }
        continue; // Only positive cleanup reports repeat; native capture never does.
      }
      if (!['pending','attaching','ready'].includes(String(job.state))) continue;
      const allowed = () => this.fresh() && this.machineAuthorized(machineId) && this.leasedCaptureAuthorized(machineId) && this.queues.video!.some(j => j.id === id && j.generation === generation && j.machineId === machineId && ['pending','attaching','ready'].includes(String(j.state))) && this.clock.wall() < Date.parse(String(job.authorizationDeadline)) / 1000;
      this.recentlyBusy.add(machineId);
      this.launch(key, allowed, context => this.runVideo(job, path, context));
    }
  }
  /** Live views: one outbound broker session per viewer, all fed by the device's one capture. */
  private stepLive(): void {
    // A stopping runner takes no new view: it could no longer journal and prove its capture.
    if (this.closed) return;
    const identity = this.identity;
    // Repeat a saved cleanup receipt the controller has not acknowledged. Only receipts repeat;
    // a capture this process no longer holds is never resumed. A journal that never left
    // `attaching` belongs to a capture that dispatched nothing native, which is positive cleanup.
    for (const job of this.queues.liveCaptures ?? []) {
      const id = identifier(job.id), key = `live-capture:${id}`, generation = identifier(job.generation), path = join(this.state, 'work', 'live', `${id}.json`);
      if (!identity || this.active.has(key) || !this.fresh() || this.liveCaptures?.active(id) || !present(path)) continue;
      const saved = readRecord(path);
      const receipt = saved.cleaned === true || saved.state === 'attaching' ? { cleaned: true } : saved.hostCleaned === true ? { hostCleaned: true } : undefined;
      if (saved.generation !== generation || saved.machineId !== job.machineId || !receipt) continue;
      this.launch(key, () => this.fresh(), async () => {
        await this.transport.request('POST', `/v1/hosts/${identity.id}/video-sessions/${id}/finish`, { generation, ...receipt }, identity.credential, this.stopController.signal);
      });
    }
    const queued = new Set((this.queues.live ?? []).map(job => `${String(job.id)}:${String(job.generation)}`));
    for (const attempt of this.liveAttempts) if (!queued.has(attempt)) this.liveAttempts.delete(attempt);
    for (const job of this.queues.live ?? []) {
      const id = identifier(job.id), machineId = identifier(job.machineId), generation = identifier(job.generation), key = `live:${id}`, attempt = `${id}:${generation}`;
      if (this.active.has(key) || this.liveAttempts.has(attempt) || !this.fresh() || this.updateAdmissionBlocked) continue;
      if (!['pending', 'attaching'].includes(String(job.state))) continue;
      // The same authority as a recording: the assignment, and for a leased emulator its ready
      // lease and local lease guard. The view must also still be listed by the controller.
      const allowed = () => this.liveAuthorized(machineId) && this.queues.live!.some(j => j.id === id && j.generation === generation && j.machineId === machineId);
      if (!allowed()) continue;
      this.liveAttempts.add(attempt);
      this.launch(key, allowed, context => this.runLiveView(job, context));
    }
  }
  /** Assignment and lease authority for a device's viewers, evaluated at most once per 250 ms
   * (the recording path's own check interval) and shared by them. A sample of the native lease
   * clock is a helper process, and viewers consult their authority for every segment. */
  private liveAuthorized(machineId: string): boolean {
    if (this.stopController.signal.aborted) return false;
    const now = performance.now(), cached = this.liveAuthority.get(machineId);
    if (cached && now - cached.at < 250) return cached.value;
    const value = this.machineAuthorized(machineId) && this.leasedCaptureAuthorized(machineId);
    this.liveAuthority.set(machineId, { at: now, value }); return value;
  }
  /** True while `machine` is still the assignment a capture started under: fingerprint and lease
   * unchanged. The lease's identity, not its whole assignment record: that carries the controller's
   * clock and revision, which change on every heartbeat and renewal without changing the owner.
   * A lease without a string id never matches, so a malformed record fails closed. */
  private assignmentUnchanged(machine: RecordValue): () => boolean {
    const leaseOf = (m: RecordValue) => { if (m.lease == null) return null; const id = object(m.lease).id; return typeof id === "string" && id ? id : Symbol("unidentified lease"); };
    const capturedAssignment = assignmentFingerprint(machine), capturedLease = leaseOf(machine);
    return () => { const current = this.assignments.find(m => m.id === machine.id); return !!current && assignmentFingerprint(current) === capturedAssignment && leaseOf(current) === capturedLease; };
  }
  /** A recording of this device that the controller still lists and that still holds the
   * device's native capture here: running, not yet started, or ended without positive proof that
   * its native source stopped (for a lease, only its encoder's exit was confirmed, and the guest
   * recorder's stop waits for the lease's cleanup). No live epoch starts meanwhile, so a recording
   * finds the device free and no second recorder can run beside an unproven one. A recording that
   * ended here with proof does not count, even while the controller's list still trails it and
   * this runner repeats its receipt. Evaluated at most once per 250 ms per device, like the
   * authority above. */
  private recordingPending(machineId: string): boolean {
    const now = performance.now(), cached = this.liveRecordings.get(machineId);
    if (cached && now - cached.at < 250) return cached.value;
    const value = (this.queues.video ?? []).some(job => {
      if (job.machineId !== machineId) return false;
      const id = identifier(job.id), path = join(this.state, 'work', 'video', `${id}.json`);
      if (this.recordingCaptures.has(id)) return true;
      if (!present(path)) return ['pending', 'attaching', 'ready'].includes(String(job.state));
      try { return readRecord(path).cleaned !== true; } catch { return true; }
    });
    this.liveRecordings.set(machineId, { at: now, value }); return value;
  }
  private liveSource(machine: RecordValue): LiveCaptureSource | undefined {
    const { runtime, image, folder } = this.context(machine), encoder = runtime.config?.videoEncoder;
    // iOS is opt-in per host: idb's stop is unconfirmed on some installations, and there every
    // ended view would leave a capture that only an administrator can abandon.
    const offered = image.os === 'android' || image.os === 'ios' && runtime.config?.liveView === true;
    if (!runtime.openVideo || !runtime.pipe || typeof encoder !== 'string' || !isAbsolute(encoder) || !offered) return undefined;
    // Stopping an early-ended recorder needs the same assignment that started it, as for recordings.
    const sameAssignment = this.assignmentUnchanged(machine);
    return { encoder, guestSource: image.os === 'android', notRunning: captureNotRunning, recordingQueued: () => this.recordingPending(String(machine.id)),
      openSource: (options, authorized) => runtime.openVideo!(machine, image, folder, options, authorized, () => this.machineAuthorized(String(machine.id)) && sameAssignment()),
      openEncoder: argv => runtime.pipe!(argv) };
  }
  private async runLiveView(job: RecordValue, context: HostWorkContext): Promise<void> {
    const identity = this.identity, machine = this.assignments.find(m => m.id === job.machineId);
    if (!identity || !machine || !context.authorized()) return;
    const id = identifier(job.id), generation = identifier(job.generation);
    let channel: SessionConnection | undefined, handle: ReturnType<LiveCaptureHub['acquire']> | undefined;
    const authorized = () => !context.signal.aborted && context.authorized();
    try {
      const source = this.liveSource(machine);
      // Journals the capture before this runner attaches for it; native dispatch is journaled again.
      // The controller treats a capture as needing a cleanup receipt from the moment its host
      // attaches, so this runner never attaches for a capture it holds no journal for: its view
      // then times out and the controller releases the unattached capture by itself. A capture
      // that is ending, or was attempted before a restart, has a journal and will be reported;
      // it is never joined or repeated, and the viewer is told so.
      try { handle = this.liveHub.acquire({ id: identifier(job.captureId), generation: identifier(job.captureGeneration), machineId: String(machine.id) }, source); }
      catch (error) { if (!(error instanceof LiveCaptureRefused) || !error.journaled) return; }
      channel = await SessionConnection.connect(this.config.url, `/v1/hosts/${identity.id}/live-views/${id}/${generation}`, identity.credential,
        { authorized, ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}) });
      const ready = await channel.receive(30), stream = channel;
      if (!ready || ready instanceof Uint8Array || ready.type !== 'ready' || ready.sessionId !== id || ready.generation !== generation || ready.capability !== 'live') return;
      if (!source) { await stream.sendControl({ type: 'error', code: 'capability_unsupported', message: 'This host has no live screen capture for this device.', outcome: 'unknown' }); return; }
      if (!handle) { await stream.sendControl({ type: 'end', reason: 'capture_ended' }); return; }
      await stream.sendControl({ type: 'live', mediaType: 'video/mp4', codec: 'avc1', fps: LIVE_FPS });
      // A view feeds the capture only while its own socket and authority hold.
      const subscription = handle.subscribe(() => authorized() && stream.open);
      try {
        while (authorized() && stream.open) {
          const item = await subscription.next(250);
          if (!item) continue;
          if (item.type === 'end') { await stream.sendControl({ type: 'end', reason: item.reason }); break; }
          await stream.sendControl(item.type === 'init' ? { type: 'init', epoch: item.epoch, bytes: item.data.length }
            : { type: 'segment', epoch: item.epoch, sequence: item.sequence, keyframe: item.keyframe, bytes: item.data.length });
          for (let offset = 0; offset < item.data.length; offset += 65536) await stream.sendBytes(item.data.subarray(offset, offset + 65536));
        }
      } finally { subscription.close(); }
    } catch {
      // A viewer holds no durable intent: a refused attach, a departed viewer or lost authority
      // ends it. The capture's own journal and receipt are the hub's.
    } finally { channel?.close(); handle?.release(); }
  }
  /** Lease port tunnels. Each delivered tunnel is attempted once: its journal is written before
   * the broker attach and before any mapping, and a restart never installs it again. A tunnel
   * whose mapping removal is not yet proven stays delivered until this runner confirms it, or
   * the controller settles it from the lease's own cleanup. */
  private stepTunnels(): void {
    const queued = new Set((this.queues.tunnels ?? []).map(job => String(job.id)));
    for (const id of this.tunnelRetry.keys()) if (!queued.has(id)) this.tunnelRetry.delete(id);
    for (const id of this.tunnelAuthority.keys()) if (!this.assignments.some(machine => machine.id === id)) this.tunnelAuthority.delete(id);
    for (const job of this.queues.tunnels ?? []) {
      const id = identifier(job.id), key = `tunnel:${id}`, machineId = identifier(job.machineId), generation = identifier(job.generation), leaseId = identifier(job.leaseId);
      // The caller already required fresh controller contact for this step.
      if (this.active.has(key) || this.updateAdmissionBlocked || !this.identity) continue;
      const path = join(this.state, 'work', 'tunnel', `${id}.json`);
      if (present(path)) {
        // A pacing timer only, so it needs no native clock sample.
        if (performance.now() < (this.tunnelRetry.get(id) ?? 0)) continue;
        const saved = readRecord(path);
        if (saved.generation !== generation || saved.machineId !== machineId) continue;
        this.tunnelRetry.set(id, performance.now() + 5000);
        this.launch(key, () => this.fresh(), context => this.settleTunnel(id, path, saved, context));
        continue; // Only the mapping-removal receipt repeats; a tunnel is never opened twice.
      }
      if (!['pending', 'attaching'].includes(String(job.state))) continue;
      const allowed = () => !this.closed && this.tunnelAuthorized(machineId, leaseId) &&
        this.queues.tunnels!.some(j => j.id === id && j.generation === generation && j.machineId === machineId && ['pending', 'attaching', 'ready'].includes(String(j.state)));
      if (!allowed()) continue;
      this.launch(key, allowed, context => this.runTunnel(job, path, context));
    }
  }
  /** Runner-side authority for every tunnel of one lease: fresh controller contact, the lease
   * guard's deadline, the assignment, and the host's own tunnel gate. Contact freshness and the
   * lease guard each sample the native clock, which is a process spawn, and the session channel
   * asks on every frame it relays. The result is therefore shared per machine and re-evaluated at
   * most every 250 ms, the same bound as the channel's own watcher. The controller's broker still
   * checks its authority on every relayed message. */
  private tunnelAuthorized(machineId: string, leaseId: string): boolean {
    const cached = this.tunnelAuthority.get(machineId), now = performance.now();
    if (cached && now - cached.at < 250) return cached.allowed;
    let allowed = false;
    try { allowed = this.machineAuthorized(machineId) && this.tunnelOffered(machineId, leaseId); } catch { allowed = false; }
    this.tunnelAuthority.set(machineId, { at: now, allowed });
    return allowed;
  }
  /** The host's own gate, independent of the controller: tunnels only for a ready lease on an
   * advertised Android lease image, and only when this host's configuration declares them. */
  private tunnelOffered(machineId: string, leaseId: string): boolean {
    const machine = this.assignments.find(m => m.id === machineId);
    return !!machine?.lease && machine.ready === true && object(machine.lease).id === leaseId && object(machine.lease).state === "ready" &&
      this.offer.leaseProtocol === 1 && this.offer.leaseTunnelProtocol === 1 && this.leaseEligible(machine);
  }
  private async runTunnel(job: RecordValue, path: string, context: HostWorkContext): Promise<void> {
    const identity = this.identity, machine = this.assignments.find(m => m.id === job.machineId);
    if (!identity || !machine || !context.authorized()) return;
    const id = identifier(job.id), generation = identifier(job.generation), machineId = String(machine.id);
    const intent = tunnelIntent(job.direction, job.devicePort, job.idleSeconds);
    const { runtime, image, folder } = this.context(machine);
    const journal = { generation, machineId, direction: job.direction, devicePort: job.devicePort };
    saveRecord(path, { ...journal, state: 'started' });
    this.tunnelMachines.set(id, machineId);
    const live = () => !context.signal.aborted && context.authorized();
    // A device mapping is removed only under the same assignment that installed it.
    const assignment = assignmentFingerprint(machine), lease = object(machine.lease ?? {}).id;
    const held = () => { const current = this.assignments.find(m => m.id === machineId); return !!current && assignmentFingerprint(current) === assignment && object(current.lease ?? {}).id === lease && this.machineAuthorized(machineId); };
    let channel: SessionConnection | undefined, endpoint: TunnelEndpoint | undefined, mappingRemoved = true, reason: TunnelEndReason | undefined;
    try {
      channel = await SessionConnection.connect(this.config.url, `/v1/hosts/${identity.id}/tunnels/${id}/${generation}`, identity.credential,
        { authorized: live, ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}) });
      const connection = channel, ready = await connection.receive(30);
      if (!ready || ready instanceof Uint8Array || ready.type !== 'ready' || ready.sessionId !== id || ready.generation !== generation || ready.capability !== 'tunnel') throw unknownOutcome('Tunnel peers did not attach.');
      if (!intent || !runtime.openTunnel) throw new ServiceError('This runtime has no lease tunnel adapter.', 409, { code: 'capability_unsupported' });
      // The device side listens for a reverse tunnel and connects for a forward tunnel. Neither
      // side is ever told a destination: this endpoint is the tunnel's only one.
      const relay = new TunnelRelay({ sendControl: value => connection.sendControl(value), sendBytes: value => connection.sendBytes(value), receive: () => connection.receive(30), close: () => connection.close() },
        { role: intent.direction === 'reverse' ? 'listen' : 'connect', idleSeconds: intent.idleSeconds, authorized: live, alive: () => endpoint!.alive(),
          ...(intent.direction === 'forward' ? { connect: () => endpoint!.connect() } : {}),
          // This runner ended the tunnel on its own evidence. Send the terminal frame before
          // reporting the reason, since that report can revoke broker authority.
          ending: async end => {
            const cause: TunnelEndReason | undefined = end.reason === 'flood' ? 'open_rate' : end.code === 'tunnel_mapping_lost' ? 'mapping_lost' : undefined;
            if (!cause) return;
            reason = cause;
            const code = cause === 'open_rate' ? 'tunnel_open_rate' : 'tunnel_mapping_lost';
            try { await connection.sendControl({ type: 'error', code, message: WORKER_MESSAGES[code]!, outcome: 'unknown' }); } catch { /* The receipt will name the cause. */ }
          } });
      try { endpoint = await runtime.openTunnel(machine, image, folder, { id, direction: intent.direction, devicePort: intent.devicePort }, live, socket => relay.accept(socket)); }
      catch (error) { if (error instanceof TunnelMappingError) { mappingRemoved = error.mappingRemoved; reason = 'mapping_failed'; } throw error; }
      // Sent only once the mapping is installed and verified: the holder's open completes on it.
      await connection.sendControl({ type: 'tunnel', direction: intent.direction, devicePort: intent.devicePort });
      await relay.run();
    } catch (error) {
      const code = error instanceof ServiceError && ['capability_unsupported', 'tunnel_mapping_failed'].includes(error.code) ? error.code : 'session_incomplete';
      try { await channel?.sendControl({ type: 'error', code, message: WORKER_MESSAGES[code]!, outcome: 'unknown' }); } catch { /* A disconnected holder learns the outcome from the tunnel's receipt. */ }
    } finally {
      channel?.close();
      if (endpoint) { try { mappingRemoved = (await bounded(endpoint.close(held), 30_000)).mappingRemoved; } catch { mappingRemoved = false; } }
      this.tunnelMachines.delete(id);
      saveRecord(path, { ...journal, state: 'finished', mappingRemoved, ...(reason ? { reason } : {}) });
      if (mappingRemoved || reason) await this.tunnelReceipt(id, generation, { ...(mappingRemoved ? { mappingRemoved: true } : {}), ...(reason ? { reason } : {}) });
    }
  }
  /** Repeats a saved removal receipt, or confirms a removal that was unproven when the tunnel
   * ended (lost device authority, a failed adb call, a runner restart). Read-only on the device. */
  private async settleTunnel(id: string, path: string, saved: RecordValue, context: HostWorkContext): Promise<void> {
    const generation = identifier(saved.generation), machineId = identifier(saved.machineId);
    if (saved.mappingRemoved !== true) {
      const machine = this.assignments.find(m => m.id === machineId), intent = tunnelIntent(saved.direction, saved.devicePort, undefined);
      if (!machine || !intent || !this.machineAuthorized(machineId)) return;
      const { runtime, image } = this.context(machine);
      if (!runtime.tunnelMappingAbsent) return;
      try { if (!await runtime.tunnelMappingAbsent(machine, image, { id, direction: intent.direction, devicePort: intent.devicePort }, () => !context.signal.aborted && this.machineAuthorized(machineId))) return; }
      catch { return; }
      saveRecord(path, { ...saved, state: 'finished', mappingRemoved: true });
    }
    const reason = (TUNNEL_END_REASONS as readonly unknown[]).includes(saved.reason) ? saved.reason as TunnelEndReason : undefined;
    await this.tunnelReceipt(id, generation, { mappingRemoved: true, ...(reason ? { reason } : {}) });
  }
  /** Tells the controller why this runner ended a tunnel, and that its mapping is positively gone. */
  private async tunnelReceipt(id: string, generation: string, receipt: { mappingRemoved?: true; reason?: TunnelEndReason }): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    try { await this.transport.request('POST', `/v1/hosts/${identity.id}/tunnels/${id}/finish`, { generation, ...receipt }, identity.credential, this.stopController.signal); }
    catch { this.log('Tunnel receipt was not acknowledged; the removal receipt is repeated while the tunnel stays delivered.'); }
  }
  /** Lease cleanup: ends this machine's tunnels before the stop proof is evaluated. Host-side
   * endpoints close without device access, and a tunnel never delays cleanup beyond this bound. */
  private async closeMachineTunnels(machineId: string, runtime: Runtime, machine: RecordValue): Promise<void> {
    const works = [...this.tunnelMachines].filter(([, owner]) => owner === machineId).map(([tunnel]) => this.active.get(`tunnel:${tunnel}`)).filter(work => work !== undefined);
    for (const work of works) work.controller.abort();
    try { await runtime.closeTunnels?.(machine); } catch { this.log('Tunnel endpoint closure needs inspection; cleanup continues from the stop proof.'); }
    await Promise.race([Promise.allSettled(works.map(work => work.promise)), new Promise(resolvePromise => setTimeout(resolvePromise, 5000).unref())]);
  }
  /** A leased emulator records only while its lease is ready on this runner and the host offers
   * leased execution for it; the lease guard (machineAuthorized) fences it at the deadline. */
  private leasedCaptureAuthorized(machineId: string): boolean {
    const machine = this.assignments.find(m => m.id === machineId);
    if (!machine?.lease) return true;
    return machine.ready === true && object(machine.lease).state === "ready" && this.offer.leaseProtocol === 1 && this.leaseEligible(machine);
  }
  /** Owner desktop viewers relayed by a standalone dashboard through the controller. Only
   * unleased desktop assignments qualify; leased machines use their lease's sessions. */
  private stepDisplay(): void {
    const queued = new Set((this.queues.display ?? []).map(job => `${String(job.id)}:${String(job.generation)}`));
    for (const attempt of this.displayAttempts) if (!queued.has(attempt)) this.displayAttempts.delete(attempt);
    for (const job of this.queues.display ?? []) {
      const id = identifier(job.id), machineId = identifier(job.machineId), generation = identifier(job.generation), key = `display:${id}`, attempt = `${id}:${generation}`;
      if (this.active.has(key) || this.displayAttempts.has(attempt) || !this.fresh() || this.updateAdmissionBlocked || !this.displayControls) continue;
      if (!['pending', 'attaching'].includes(String(job.state))) continue;
      const allowed = () => this.machineAuthorized(machineId) && !this.assignments.find(m => m.id === machineId)?.lease &&
        this.queues.display!.some(j => j.id === id && j.generation === generation && j.machineId === machineId);
      if (!allowed()) continue;
      this.displayAttempts.add(attempt); this.recentlyBusy.add(machineId);
      this.launch(key, allowed, context => this.runDisplaySession(id, generation, machineId, context));
    }
  }
  private async runDisplaySession(id: string, generation: string, machineId: string, context: HostWorkContext): Promise<void> {
    const identity = this.identity, machine = this.assignments.find(m => m.id === machineId), controls = this.displayControls;
    if (!identity || !machine || !controls || !context.authorized()) return;
    const { image, folder } = this.context(machine), backend = this.accessBackend(machine);
    let channel: SessionConnection | undefined;
    // Input authority is tied to the relayed socket: once the controller ends the pair,
    // no further buffered event is written to the guest.
    const live = () => !context.signal.aborted && context.authorized() && channel?.open === true;
    try {
      channel = await SessionConnection.connect(this.config.url, `/v1/hosts/${identity.id}/display-sessions/${id}/${generation}`, identity.credential,
        { authorized: () => !context.signal.aborted && context.authorized(), ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}) });
      const ready = await channel.receive(30);
      if (!ready || ready instanceof Uint8Array || ready.type !== 'ready' || ready.sessionId !== id || ready.generation !== generation || ready.capability !== 'display') return;
      if (image.mode !== 'desktop' || !backend.desktop) return;
      const endpoint = new DisplayEndpoint(controls, machineId, () => backend.desktop!(machine, image, folder), live, { viewer: id });
      const stop = () => endpoint.close();
      context.signal.addEventListener('abort', stop, { once: true });
      try { await endpoint.runDisplay(channel); } finally { context.signal.removeEventListener('abort', stop); }
    } catch {
      // A viewer session holds no durable intent: a refused attach, a closed viewer or lost
      // authority ends it, and the endpoint has already reset any held input.
    } finally { channel?.close(); }
  }
  private async runVideo(job: RecordValue, path: string, context: HostWorkContext): Promise<void> {
    const identity = this.identity, machine = this.assignments.find(m => m.id === job.machineId);
    if (!identity || !machine || !context.authorized()) return;
    const { runtime, image, folder } = this.context(machine);
    // hostCleaned: this runner's own encoder is confirmed exited (or never started). For a leased
    // emulator that alone may be reported when the guest recorder's stop is unproven.
    let channel: SessionConnection | undefined, captureStarted = false, cleaned = false, hostCleaned = true;
    let tap: Awaited<ReturnType<LiveCaptureHub['beginRecording']>> | undefined;
    const leased = machine.lease != null;
    saveRecord(path, { generation: job.generation, machineId: machine.id, state: 'started' });
    const recordingId = identifier(job.id); this.recordingCaptures.add(recordingId);
    try {
      channel = await SessionConnection.connect(this.config.url, `/v1/hosts/${identity.id}/video-sessions/${identifier(job.id)}/${identifier(job.generation)}`, identity.credential,
        { authorized: () => !context.signal.aborted && context.authorized(), ...(this.config.caFile ? { ca: readFileSync(this.config.caFile) } : {}) });
      const ready = await channel.receive(30);
      if (!ready || ready instanceof Uint8Array || ready.type !== 'ready' || ready.sessionId !== job.id || ready.generation !== job.generation || ready.capability !== 'video') throw unknownOutcome('Video peers did not attach.');
      const encoder = runtime.config?.videoEncoder;
      if (!runtime.openVideo || !runtime.pipe || typeof encoder !== 'string' || !isAbsolute(encoder) || !['android','ios'].includes(String(image.os))) {
        cleaned = true; throw new ServiceError('Native video requires an operator-configured encoder and capture adapter.', 409, { code: 'capability_unsupported' });
      }
      const options = { fps: 30 as const, durationSeconds: Number(job.durationSeconds), bitRate: Number(job.bitRate) };
      // Capture ends with the session; stopping an early-cancelled recorder needs only the assignment,
      // and only the same assignment that started the capture.
      const sameAssignment = this.assignmentUnchanged(machine);
      // A recording has priority over a live view of its device. A running live epoch is stopped
      // and this recording waits a bounded time for proof of that stop. The recording's duration and
      // time limit start only below, when its capture does.
      tap = await this.liveHub.beginRecording(String(machine.id));
      if (!tap.proven) throw new ServiceError('The prior live capture did not prove it stopped before recording.', 409, { code: 'capture_cleanup_pending' });
      // Nothing of this recording was dispatched yet: authorization that ended during the wait
      // leaves it clean.
      if (context.signal.aborted || !context.authorized()) throw new ServiceError('Video authorization ended before capture.', 410);
      captureStarted = true;
      const recording = channel, viewers = tap;
      // The recording receives exactly its own bytes; live viewers are fed a copy of them.
      const tee = { receive: (seconds?: number) => recording.receive(seconds), sendControl: (value: RecordValue) => recording.sendControl(value), close: () => recording.close(),
        sendBytes: async (data: Uint8Array) => { viewers.push(data); await recording.sendBytes(data); } };
      const source = await runtime.openVideo(machine, image, folder, options, () => !context.signal.aborted && context.authorized(), () => this.machineAuthorized(String(machine.id)) && sameAssignment());
      await serveMobileVideo(tee, source, argv => runtime.pipe!(argv), encoder, options, () => !context.signal.aborted && context.authorized(), (positive, parts) => { cleaned = positive; hostCleaned = parts.encoder; });
      cleaned = true;
    } catch {
      if (!captureStarted) cleaned = true;
      try { await channel?.sendControl({ type: 'error', code: 'session_incomplete', message: 'Native video capture did not complete.', outcome: 'unknown' }); } catch { /* A disconnected viewer receives no completion proof. */ }
    } finally {
      channel?.close();
      this.recordingCaptures.delete(recordingId);
      // Live viewers may resume their own capture only after this one is proven stopped.
      tap?.end(cleaned);
      const hostOnly = !cleaned && leased && hostCleaned;
      // The hand-over wait is recorded with the recording's journal, for the operator.
      const handover = tap && (tap.waitedMs >= 100 || !tap.proven) ? { liveHandoverMs: Math.round(tap.waitedMs), liveStopProven: tap.proven } : {};
      saveRecord(path, { generation: job.generation, machineId: machine.id, state: cleaned ? 'finished' : 'unknown', cleaned, ...(hostOnly ? { hostCleaned: true } : {}), ...handover });
      if (cleaned || hostOnly) {
        try { await this.transport.request('POST', `/v1/hosts/${identity.id}/video-sessions/${identifier(job.id)}/finish`, cleaned ? { generation: job.generation, cleaned: true } : { generation: job.generation, hostCleaned: true }, identity.credential, this.stopController.signal); }
        catch { this.log('Video cleanup receipt was not acknowledged; its reservation is retained.'); }
      }
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
    this.refreshBaselines();
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
  private idleEligible(): boolean {
    return this.fresh() && !this.closed && this.active.size === 0 && this.updateExternalWork === 0 && (this.liveCaptures?.idle ?? true) &&
      Object.values(this.queues).every(queue => queue.length === 0) &&
      [this.reports, this.deviceReports, this.inferenceReports, this.imageReports, this.sessionReports, this.hostOperationReports].every(reports =>
        [...reports.values()].every(r => ["stopped", "succeeded", "failed", "cancelled"].includes(String(r.state)) && (r.stopped === undefined || r.stopped === true) && !["pending", "unknown"].includes(String(r.cleanup))));
  }
  private retainedAssignments(current: RecordValue[]): Map<string, RecordValue> {
    const retained = new Map(this.updateAssignments);
    for (const [id, record] of this.guard.records) {
      if (record.retired) retained.delete(id);
      else if (!retained.has(id) || record.fenced) retained.set(id, record.fenced ? { ...record.machine, desired: "stopped" } : record.machine);
    }
    for (const machine of current) retained.set(String(machine.id), machine);
    return retained;
  }
  private machineRoots(): Set<string> {
    return new Set([this.state, ...[...this.runtimes.values()].map(r => r.state ?? this.state)].map(state => resolve(state, "machines")));
  }
  private async inspectStopped(retained: Map<string, RecordValue>, readOnly = false): Promise<IdleReceipt> {
    if (!this.idleEligible() || [...retained.values()].some(m => m.desired !== "stopped")) return NOT_IDLE;
    const epoch = this.updateEpoch;
    let inspected = 0;
    for (const machine of retained.values()) {
      if (readOnly && inspected++ % 32 === 0) await yieldWork();
      if (epoch !== this.updateEpoch || !this.fresh()) return NOT_IDLE;
      const { runtime, image, folder } = this.context(machine);
      if (!helpersClosed(machine, folder)) return NOT_IDLE;
      const stopped = runtime.updateStopped ? await runtime.updateStopped(machine, image, folder, readOnly) :
        runtime.confirmExecutionStopped?.(machine, folder, readOnly)?.executionStopped === true;
      if (!stopped || epoch !== this.updateEpoch || !this.fresh()) return NOT_IDLE;
    }
    return this.idleEligible() ? { idle: true, workloadsStopped: true } : NOT_IDLE;
  }
  async updateIdle(): Promise<IdleReceipt> {
    if (!this.idleEligible()) return NOT_IDLE;
    const epoch = this.updateEpoch;
    const retained = new Map(this.updateAssignments);
    for (const machine of this.guard.assignments(this.assignments)) retained.set(String(machine.id), machine);
    try {
      // Unknown older local assignment directories cannot be inferred stopped from an empty heartbeat.
      for (const root of this.machineRoots()) {
        noLinks(root);
        if (present(root) && readdirSync(root).some(id => !retained.has(id) && !this.guard.records.get(id)?.retired)) return NOT_IDLE;
      }
      if (!(await this.inspectStopped(retained)).workloadsStopped) return NOT_IDLE;
      // Only stopped assignments reach helper closure; a live VM is never closed for an update.
      await this.sweepAccess(new Set());
      for (const machine of retained.values()) await this.context(machine).runtime.closeShells?.(machine);
    } catch { return NOT_IDLE; }
    return epoch === this.updateEpoch && this.idleEligible() ? { idle: true, workloadsStopped: true } : NOT_IDLE;
  }
  private inspectMaintenance(): void {
    const challenge = this.maintenanceChallenge;
    if (this.closed || !challenge || this.inspectingMaintenance) return;
    this.inspectingMaintenance = true;
    // Inventory and provider probes never run on the heartbeat's critical path.
    void yieldWork().then(async () => {
      if (challenge !== this.maintenanceChallenge || !this.fresh()) return;
      const proof = await this.collectMaintenance(challenge);
      if (proof && challenge === this.maintenanceChallenge && this.fresh()) this.maintenanceProof = { challenge, proof };
    }).catch(() => this.log("Host maintenance inspection failed; no proof was sent.")).finally(() => {
      this.inspectingMaintenance = false;
      if (challenge !== this.maintenanceChallenge) this.inspectMaintenance();
    });
  }
  private async collectMaintenance(challenge: MaintenanceFence): Promise<MaintenanceProof | undefined> {
    const current = this.assignments, retained = this.retainedAssignments(current);
    const assignments: MaintenanceProof["inventory"]["assignments"] = [];
    const knownFolders = new Set<string>(), knownStorage = new Set<string>(), knownQuarantines = new Set<string>();
    const unexpected = new Set<string>(), issues: string[] = [];
    let complete = true;
    for (const machine of current) {
      if (assignments.length % 32 === 0) await yieldWork();
      if (challenge !== this.maintenanceChallenge || !this.fresh()) return;
      const id = identifier(machine.id);
      let storage: StoragePresence = "unknown", stopProof: "native" | "unsupported" = "unsupported";
      try {
        const { runtime, image, folder } = this.runtimeContext(machine);
        knownFolders.add(resolve(folder));
        const root = maintenanceStorageRoot(runtime);
        if (root) {
          knownStorage.add(join(root, id));
          if (["apple", "libvirt", "android"].includes(runtime.kind)) {
            for (const intent of runtime.kind === "android" ? [machine.deletion] : [machine.deletion, machine.leaseCleanup]) {
              const receipt = object(intent ?? {});
              if (["queued", "pending", "running", "blocked", "unknown", "uncertain"].includes(String(receipt.state))) {
                knownQuarantines.add(join(root, `.removing-${id}-${identifier(receipt.id)}`));
              }
            }
          }
        }
        if (runtime.updateStopped || runtime.confirmExecutionStopped) stopProof = "native";
        storage = await maintenanceStorage(machine, image, folder, runtime);
      } catch { /* A broken or foreign path cannot prove storage presence or absence. */ }
      assignments.push({ id, storage, stopProof });
    }
    // A deleted administrative assignment can leave a journal in its local
    // directory. Only a matching completion receipt and absent backing storage
    // explain it after the controller stops delivering that assignment.
    const currentIds = new Set(assignments.map(a => a.id));
    let checkedRetirements = 0;
    for (const [id, machine] of retained) {
      if (currentIds.has(id) || !machine.deletion) continue;
      if (checkedRetirements++ % 32 === 0) await yieldWork();
      if (challenge !== this.maintenanceChallenge || !this.fresh()) return;
      try {
        const { runtime, image, folder } = this.context(machine), root = runtime.config?.storage;
        const receipt = readOwnedRecord(join(folder, "deletion.json"));
        const fingerprint = runtime.deletionFingerprint?.(machine, image) ?? assignmentFingerprint(machine);
        if (receipt.state !== "complete" || receipt.id !== object(machine.deletion).id || (receipt.machineId ?? receipt.machine_id) !== id || receipt.fingerprint !== fingerprint ||
            typeof root !== "string" || !isAbsolute(root) || ownedDirectory(join(root, id))) continue;
        knownFolders.add(resolve(folder)); retained.delete(id);
      } catch { /* Retain assignments with unconfirmed retirement. */ }
    }
    const scan = await this.scanRoots({ folders: knownFolders, storage: knownStorage, quarantines: knownQuarantines }, () => challenge === this.maintenanceChallenge && this.fresh());
    if (!scan) return;
    for (const found of scan.found) unexpected.add(found.name);
    if (!scan.complete) { complete = false; issues.push("Local journal or provider storage inventory could not be completed."); }
    const receipt = complete && !unexpected.size && assignments.every(a => a.storage === "present" || a.storage === "unsupported" || a.storage === "notMaterialized") ?
      await this.inspectStopped(retained, true) : NOT_IDLE;
    return { ...challenge, ...receipt, inventory: { complete, assignments, unexpected: [...unexpected].sort() }, issues };
  }
  /** Directory entries under the journal and provider storage roots that no known assignment
   * explains. Shared by the maintenance proof and the storage inspection; it changes nothing. */
  private async scanRoots(known: { folders: Set<string>; storage: Set<string>; quarantines: Set<string> }, live: () => boolean):
    Promise<{ complete: boolean; found: { name: string; path: string; storage: boolean; quarantine: boolean }[] } | undefined> {
    const journalRoots = this.machineRoots(), storageRoots = new Set([...this.runtimes.values()].map(maintenanceStorageRoot).filter(root => root !== undefined));
    const names = new Set<string>(), found: { name: string; path: string; storage: boolean; quarantine: boolean }[] = [];
    let complete = true, entries = 0;
    for (const root of new Set([...journalRoots, ...storageRoots])) {
      try {
        if (!ownedDirectory(root)) continue;
        const before = lstatSync(root);
        for await (const entry of await opendir(root)) {
          if (!live()) return undefined;
          if (++entries > 20_000) { complete = false; break; }
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const path = join(root, entry.name);
          const quarantine = storageRoots.has(root) && removalQuarantine.test(entry.name);
          if (quarantine && entry.isDirectory() && known.quarantines.has(path)) continue;
          // Retirement only explains an old journal, never backing storage that still exists.
          const unexplainedJournal = journalRoots.has(root) && !known.folders.has(path) && !this.guard.records.get(entry.name)?.retired;
          const unexplainedStorage = storageRoots.has(root) && !known.storage.has(path) && storageId.test(entry.name);
          if (!quarantine && !unexplainedJournal && !unexplainedStorage) continue;
          if (names.size >= 100 && !names.has(entry.name) || entry.name.length > 200) { complete = false; break; }
          names.add(entry.name); found.push({ name: entry.name, path, storage: storageRoots.has(root), quarantine });
        }
        noLinks(root);
        const after = lstatSync(root);
        if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) complete = false;
      } catch { complete = false; }
      if (!complete) break;
    }
    return { complete, found };
  }
  /** Pressure is sampled on its own cadence, so a slow resource collection cannot age it. */
  async samplePressure(): Promise<void> {
    if (!this.pressureMonitor) return;
    let sample: PressureSample;
    try { sample = await (this.dependencies.pressureSample ?? (() => this.readPressure()))(); }
    catch { sample = { memory: null, disk: null }; }
    const report = this.pressureMonitor.observe(sample, this.clock.now(), this.clock.wall());
    if (!this.stopping) this.pressureReport = { ...report, gates: this.pressureGates };
  }
  private async readPressure(): Promise<PressureSample> {
    let memory: PressureSample["memory"], disk: PressureSample["disk"] = null;
    try { memory = await readMemorySignal(); } catch { memory = null; }
    try {
      // The tightest filesystem among the host's storage roots decides. A root that does not
      // exist yet is measured through its nearest existing parent.
      const roots = [this.config.storage ?? this.state, ...[...this.runtimes.values()].map(runtime => runtime.config?.storage)].filter((root): root is string => typeof root === "string" && isAbsolute(root));
      for (let root of new Set(roots.length ? roots : [this.state])) {
        while (!present(root) && dirname(root) !== root) root = dirname(root);
        const sample = statfsSync(root), next = { freeGiB: sample.bavail * sample.bsize / 2 ** 30, totalGiB: sample.blocks * sample.bsize / 2 ** 30 };
        if (!disk || next.freeGiB < disk.freeGiB) disk = next;
      }
    } catch { disk = null; }
    return { memory, disk };
  }
  /** Devices with work this host can see but the controller may not, such as a local viewer:
   * busy now, or busy at some point since the last delivered heartbeat. */
  private busyMachines(): string[] {
    const busy = new Set<string>([...this.deviceMachines, ...this.recentlyBusy]);
    for (const key of this.active.keys()) {
      const [kind, id] = key.split(":");
      if (kind === "video" || kind === "display") { const job = this.queues[kind]?.find(entry => entry.id === id); if (job) busy.add(String(job.machineId)); }
    }
    // Local connector work is not attributed to one device, so it holds every running one.
    if (this.updateExternalWork > 0) for (const machine of this.assignments) if (machine.desired === "running") busy.add(String(machine.id));
    for (const id of busy) this.recentlyBusy.add(id);
    return [...busy].sort();
  }
  /** Mobile hosts advertise their upkeep capability, idle-stop policy and locally busy devices. */
  private upkeepReport(): RecordValue | undefined {
    const mobile = [...this.runtimes.values()].filter(runtime => runtime.kind === "android" || runtime.kind === "ios");
    if (!mobile.length) return undefined;
    return { version: 1, platforms: mobile.filter(runtime => runtime.runtimeOperation).map(runtime => runtime.kind).sort(), idleStop: this.idlePolicy, busy: this.busyMachines() };
  }
  /** Reports every operation this runner holds but has not started as failed, so the controller
   * records that it never ran. An operation with a journal started earlier: it keeps the outcome
   * its journal holds, or `unknown` when it was interrupted, and is never run again. */
  private declineHostOperations(code: string, detail: string, expiredOnly = false): void {
    for (const task of this.queues.hostOperations ?? []) {
      const id = identifier(task.id), path = join(this.state, "work", "hostOperations", `${id}.json`);
      if (this.active.has(`upkeep:${id}`) || TERMINAL.has(String(this.hostOperationReports.get(id)?.state))) continue;
      if (present(path)) {
        if (!expiredOnly) this.publish(this.hostOperationReports, id, (readRecord(path) as unknown as DurableWork).report ?? { state: "unknown", detail: "Work was interrupted after dispatch; its effect is not replayed." });
        continue;
      }
      if (expiredOnly && this.clock.wall() < Number(task.startBy)) continue;
      this.publish(this.hostOperationReports, id, { state: "failed", result: { code, detail } });
    }
  }
  private stepHostOperations(): void {
    // An operation the controller stopped waiting for must not start late, and one still waiting
    // for its lane says so at once instead of ending unknown at its deadline.
    this.declineHostOperations("expired", "The start window ended before this host began the operation.", true);
    for (const task of this.queues.hostOperations ?? []) {
      const id = identifier(task.id), key = `upkeep:${id}`, kind = String(task.kind), args = object(task.arguments ?? {});
      if (this.active.has(key) || TERMINAL.has(String(this.hostOperationReports.get(id)?.state))) continue;
      // One install or removal per platform, one listing per platform and one storage operation at a time.
      const lane = kind === "runtime-list" ? `list:${String(args.platform)}` : kind.startsWith("runtime-") ? `change:${String(args.platform)}` : "storage";
      if ([...this.upkeepLanes.values()].includes(lane)) continue;
      const path = join(this.state, "work", "hostOperations", `${id}.json`);
      const authorized = (): boolean => this.fresh() && this.queues.hostOperations!.some(operation => operation.id === id);
      this.upkeepLanes.set(key, lane);
      this.launch(key, authorized, async context => {
        try {
          if (!present(path) && this.clock.wall() >= Number(task.startBy)) { this.publish(this.hostOperationReports, id, { state: "failed", result: { code: "expired", detail: "The start window ended before this host began the operation." } }); return; }
          await this.durableWork("hostOperations", task, this.hostOperationReports, c => this.hostOperation(task, c), context);
        } finally { this.upkeepLanes.delete(key); }
      });
    }
  }
  private async hostOperation(task: RecordValue, context: HostWorkContext): Promise<RecordValue> {
    const id = identifier(task.id), kind = String(task.kind), args = object(task.arguments ?? {});
    const authorized = (): boolean => !context.signal.aborted && context.authorized();
    const interrupted = { state: "failed", result: { code: "interrupted", detail: "Authorization ended during the inspection; nothing was changed." } };
    if (kind === "storage-inspect") { const inventory = await this.inspectStorage(authorized); return inventory ? { state: "succeeded", result: inventory } : interrupted; }
    if (kind === "storage-purge") return this.purgeStorage(id, args, authorized);
    const runtime = this.runtimes.get(String(args.platform));
    if (!runtime?.runtimeOperation) return { state: "failed", result: { code: "upkeep_unsupported", detail: "This host has no runtime manager for that platform." } };
    const timeoutSeconds = Math.max(1, Math.min(14_400, Number(task.timeoutSeconds) || 300));
    return { ...await runtime.runtimeOperation(kind, args, { authorized, timeoutSeconds,
      progress: update => { if (authorized() && this.hostOperationReports.get(id)?.state === "running") this.publish(this.hostOperationReports, id, { state: "running", progress: update }); },
      uses: name => this.runtimeUses(runtime, name) }) };
  }
  /** Configured templates (offered or retained: the host check needs each one's runtime) and
   * every assignment this host holds: those the controller delivers and unretired lease records.
   * Storage left behind by anything else is counted by the provider's own storage scan. */
  private runtimeUses(runtime: Runtime, name: string): string[] {
    const pins = (template: unknown): boolean => { const device = object(object(template).device ?? {}); return device.systemImage === name || device.runtime === name; };
    const uses: string[] = [];
    if ((Array.isArray(runtime.config?.templates) ? runtime.config.templates as unknown[] : []).some(pins)) uses.push("template");
    if (this.guard.assignments(this.assignments).some(machine => pins(machine.template))) uses.push("device");
    return uses;
  }
  /** Read-only report of storage and journals that no live owner on this host explains, with the
   * owning runtime's evidence for each. A live owner is an assignment the controller delivered on
   * the last heartbeat, or a lease record this runner has not retired. Only android and ios
   * storage can be proven; the caller must hold fresh controller contact. */
  async inspectStorage(live: () => boolean = () => true): Promise<RecordValue | undefined> {
    const held = new Map(this.guard.assignments(this.assignments).map(machine => [String(machine.id), machine])), known = { folders: new Set<string>(), storage: new Set<string>(), quarantines: new Set<string>() };
    let complete = true;
    for (const machine of held.values()) {
      try {
        const { runtime, folder } = this.runtimeContext(machine), root = maintenanceStorageRoot(runtime);
        known.folders.add(resolve(folder));
        if (root) known.storage.add(join(root, identifier(machine.id)));
      } catch { complete = false; } // An assignment this host cannot place makes absence of an owner unprovable.
    }
    const scan = await this.scanRoots(known, live);
    if (!scan) return undefined;
    complete &&= scan.complete;
    const runtimes = new Map([...this.runtimes.values()].map(runtime => [maintenanceStorageRoot(runtime), runtime] as const));
    const entries: RecordValue[] = [];
    for (const found of scan.found) {
      if (!live()) return undefined;
      const machineId = found.quarantine ? found.name.slice(10, 46) : found.name, base = { name: found.name, machineId, root: found.storage ? "storage" : "journal" };
      if (!found.storage) { entries.push({ ...base, kind: "assignment-journal", owned: false, removable: false, reason: "journal_without_storage_proof" }); continue; }
      const runtime = runtimes.get(dirname(found.path)), kind = found.quarantine ? "removal-quarantine" : "device-storage";
      // A quarantine of an assignment this host still holds belongs to that assignment's own removal.
      if (held.has(machineId)) entries.push({ ...base, runtime: runtime?.kind ?? null, kind, owned: true, removable: false, reason: "assignment_retained" });
      else if (!runtime?.orphanEvidence) entries.push({ ...base, runtime: runtime?.kind ?? null, kind, owned: false, removable: false, reason: "unsupported_runtime" });
      else {
        const { hostId, ...evidence } = await runtime.orphanEvidence(found.name);
        // The receipt names the host identity its assignment was issued to, and an identity belongs
        // to one controller. Storage receipted for another identity is not this host's to remove.
        if (evidence.removable && hostId !== this.identity?.id) Object.assign(evidence, { removable: false, reason: "owner_receipt_differs", removes: undefined });
        // The assignment's own journal goes with its storage, and only when it records that same assignment.
        if (evidence.removable && this.orphanJournal(runtime, machineId, evidence.assignmentFingerprint)) evidence.removes = [...evidence.removes ?? [], "assignment-journal"];
        entries.push({ ...base, runtime: runtime.kind, ...evidence });
      }
    }
    // Registrations and simulators that carry an assignment's name without any storage: report only.
    const registries: Record<string, string> = {};
    for (const runtime of this.runtimes.values()) if (runtime.strayDevices) {
      try {
        for (const stray of await runtime.strayDevices()) if (!held.has(stray.machineId)) entries.push({ name: stray.name, machineId: stray.machineId, root: "registry", runtime: runtime.kind, kind: stray.kind, owned: false, removable: false, reason: "no_storage_or_receipt" });
        registries[runtime.kind] = "listed";
      } catch { registries[runtime.kind] = "unavailable"; }
    }
    for (const entry of entries) if (!complete && entry.removable === true) Object.assign(entry, { removable: false, reason: "inventory_incomplete", removes: undefined });
    // A journal is never named in a purge. It is listed with the storage entry that removes it.
    for (const entry of entries) if (entry.kind === "assignment-journal") {
      const storage = entries.find(candidate => candidate.root === "storage" && candidate.machineId === entry.machineId && candidate.removable === true);
      if (storage && (storage.removes as string[]).includes("assignment-journal")) Object.assign(entry, { removedWith: storage.name, reason: "removed_with_its_storage" });
      else if (storage) entry.reason = "journal_records_another_assignment";
    }
    return { complete, inspectedAt: this.clock.wall(), registries, entries: entries.map(entry => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))) };
  }
  /** Explicit administrator purge. Each named entry is inspected again and removed only as a
   * proven orphan; nothing is stopped, and an entry that cannot be proven is refused. */
  private async purgeStorage(requestId: string, args: RecordValue, live: () => boolean): Promise<RecordValue> {
    const inventory = await this.inspectStorage(live);
    if (!inventory) return { state: "failed", result: { code: "interrupted", detail: "Authorization ended before the purge; nothing was changed." } };
    if (inventory.complete !== true) return { state: "failed", result: { code: "inventory_incomplete", detail: "This host could not inspect its whole storage; nothing was removed." } };
    const results: RecordValue[] = []; let uncertain = false;
    for (const name of (Array.isArray(args.entries) ? args.entries : []).map(String)) {
      const entry = (inventory.entries as RecordValue[]).find(candidate => candidate.name === name && candidate.root === "storage");
      const runtime = [...this.runtimes.values()].find(candidate => candidate.kind === entry?.runtime);
      if (!entry || entry.removable !== true || !runtime?.purgeOrphan) { results.push({ name, state: "refused", reason: entry ? entry.reason : "not_found" }); continue; }
      if (!live()) { results.push({ name, state: "refused", reason: "interrupted" }); continue; }
      try {
        const proof = await runtime.purgeOrphan(name, requestId, this.identity?.id), journal = this.orphanJournal(runtime, String(entry.machineId), proof.assignmentFingerprint);
        if (journal) rmSync(journal, { recursive: true });
        results.push({ name, state: "removed", removed: [...proof.removed, ...(journal ? ["assignment-journal"] : [])] });
      } catch (error) {
        // A refusal precedes any change; any other failure may have removed part of the storage.
        if (error instanceof ServiceError && error.code === "orphan_refused") results.push({ name, state: "refused", reason: "evidence_changed" });
        else { uncertain = true; results.push({ name, state: "unknown" }); }
      }
    }
    return { state: uncertain ? "unknown" : "succeeded", result: { entries: results } };
  }
  /** The local journal directory of an orphan's assignment: only when it is this runner's own
   * and carries the fingerprint of the assignment that the storage's owner receipt bound. */
  private orphanJournal(runtime: Runtime, machineId: string, fingerprint: string | undefined): string | undefined {
    if (!fingerprint) return undefined;
    try {
      const folder = join(runtime.state ?? this.state, "machines", identifier(machineId));
      return ownedDirectory(folder) && readOwnedRecord(join(folder, "assignment.json")).fingerprint === fingerprint ? folder : undefined;
    } catch { return undefined; }
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
      this.refreshBaselines();
      try { await this.connect(); } catch (error) { if (!this.identity || !this.guard.records.size) throw error; this.log("Controller enrollment unavailable; enforcing retained lease deadlines while reconnecting."); }
      if (this.updateAdmissionBlocked) { await this.poll(); if (!this.fresh()) throw unknownOutcome("Managed startup needs fresh authenticated controller contact."); }
      this.loops.push(this.loop(async () => { try { await this.poll(); } catch { this.log("Host heartbeat failed; enforcing retained execution deadlines."); } }, this.pollInterval * 1000));
      this.loops.push(this.loop(() => this.step(), 100));
      this.loops.push(this.loop(() => this.deadlines(), 100));
      this.loops.push(this.loop(() => this.cleanupStep(), 100));
      this.loops.push(this.loop(() => this.collectResources(), 5000));
      this.loops.push(this.loop(() => this.samplePressure(), 5000));
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
    if (this.closed) return; this.closed = true;
    // Live captures stop first, while this runner still holds the authority to stop and prove
    // each guest recorder; afterwards a capture could only be left unknown. With no capture
    // running this is immediate, so a runner without viewers stops as promptly as before.
    if (this.liveCaptures) await bounded(this.liveCaptures.close(), 20000).catch(() => this.log("Live capture cleanup was not confirmed; its reservation is retained."));
    this.stopController.abort();
    for (const work of this.active.values()) work.controller.abort();
    let failed = false;
    const cleanup = async (work: () => Promise<unknown>): Promise<void> => { try { await bounded(work(), 5000); } catch { failed = true; this.log("Host cleanup was not confirmed; inspect retained state."); } };
    await cleanup(() => this.processes.close());
    await cleanup(() => this.sweepAccess(new Set()));
    for (const machine of this.guard.assignments(this.assignments)) await cleanup(() => this.closeAccessShells(machine));
    if (this.outboundSessions) await cleanup(() => this.outboundSessions!.close());
    if (this.displayControls) await cleanup(async () => this.displayControls!.close());
    for (const adapter of [this.guest, this.inferenceAdapter, this.imageAdapter, this.sessionAdapter, ...new Set([...this.runtimes.values(), ...this.retainedAccess])]) if (adapter?.close) await cleanup(() => adapter.close!());
    await cleanup(() => Promise.all([...this.loops, ...[...this.active.values()].map(w => w.promise)]));
    // A still-running in-process adapter could mutate state. Keep the lock until
    // that work settles; do not let another host adopt it after a timeout.
    if (!failed) { this.lock?.close(); this.lock = undefined; }
    else { void Promise.allSettled([...this.loops, ...[...this.active.values()].map(w => w.promise)]).then(() => { this.lock?.close(); this.lock = undefined; }); throw new ServiceError("Host shutdown was not fully confirmed.", 409, { code: "host_shutdown_incomplete", retryable: false, outcome: "unknown" }); }
  }
}
function maintenanceResponse(value: unknown): MaintenanceFence | null {
  const envelope = object(value);
  if (envelope.version === 1) {
    if (envelope.phase === "open" && envelope.drainId === null && Object.keys(envelope).length === 3) return null;
    if (envelope.phase === "draining" || envelope.phase === "resumed") {
      const drainId = identifier(envelope.drainId);
      if (drainId === envelope.drainId) {
        if (envelope.phase === "resumed" && Object.keys(envelope).length === 3) return null;
        if (envelope.phase === "draining" && Object.keys(envelope).length === 4 && typeof envelope.challenge === "string" && /^[a-f0-9]{64}$/.test(envelope.challenge)) return { drainId, challenge: envelope.challenge };
      }
    }
  }
  throw new ServiceError("Invalid host maintenance response.", 400);
}
function ownedDirectory(path: string): boolean {
  noLinks(path);
  if (!present(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o022) throw new ServiceError("Expected an owned machine directory.", 409);
  return true;
}
function readOwnedRecord(path: string): RecordValue {
  noLinks(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o022) throw new ServiceError("Expected an owned machine record.", 409);
  return readRecord(path, 4096);
}
const storageIdPattern = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const storageId = new RegExp(`^${storageIdPattern}$`);
const removalQuarantine = new RegExp(`^\\.removing-${storageIdPattern}-${storageIdPattern}$`);
function maintenanceStorageRoot(runtime: Runtime): string | undefined {
  const root = runtime.config?.storage;
  if (["apple", "hyperv", "libvirt", "android", "ios"].includes(runtime.kind) && typeof root === "string" && isAbsolute(root)) return resolve(root);
}
async function maintenanceStorage(machine: RecordValue, image: RecordValue, folder: string, runtime: Runtime): Promise<StoragePresence> {
  const hasAssignment = ownedDirectory(folder), fingerprint = assignmentFingerprint(machine);
  if (hasAssignment) {
    const owner = readOwnedRecord(join(folder, "assignment.json"));
    if (owner.fingerprint !== fingerprint || (owner.leaseId ?? null) !== (machine.lease ? object(machine.lease).id : null)) return "unknown";
  }
  const root = runtime.config?.storage;
  if (runtime.maintenanceStorage) return runtime.maintenanceStorage(machine, image, folder);
  const id = identifier(machine.id);
  const disk = runtime.kind === "apple" ? join(id.toUpperCase(), "disk.img") : runtime.kind === "hyperv" ? "disk.vhdx" : undefined;
  if (!disk) return "unsupported";
  if (typeof root !== "string" || !isAbsolute(root)) return "unknown";
  const storage = join(root, id);
  if (!ownedDirectory(storage)) return "absent";
  if (readOwnedRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint) return "unknown";
  const path = join(storage, disk);
  noLinks(path);
  if (!present(path)) {
    if (runtime.kind === "apple" && !present(join(storage, id.toUpperCase())) &&
        !["apple-prepare.json", "guest-launch.json"].some(file => present(join(storage, file))) &&
        !["apple-boot-request.json", "provisioning.json"].some(file => present(join(folder, file)))) return "notMaterialized";
    if (runtime.kind === "hyperv" &&
        !["hyperv-owner.json", "hyperv-operation.json"].some(file => present(join(folder, file)))) return "notMaterialized";
    return "absent";
  }
  const stat = lstatSync(path);
  return stat.isFile() && stat.nlink === 1 && (!process.getuid || stat.uid === process.getuid()) ? "present" : "unknown";
}
function objectOrStatus(value: unknown): string { if (value === false) return "failed"; if (value && typeof value === "object" && "status" in value) return String((value as RecordValue).status); return "passed"; }
function records(value: unknown, label: string): RecordValue[] { if (!Array.isArray(value) || value.length > 10_000) throw new ServiceError(`Invalid ${label}.`, 400); return value.map(v => { const r = object(v); identifier(r.id); return r; }); }
function recordsWithoutIds(value: unknown): RecordValue[] { if (!Array.isArray(value)) throw new ServiceError("Invalid template catalogue.", 400); return value.map(object); }
function firstReport(reports: Map<string, RecordValue>, terminalOnly = false): RecordValue { const first = [...reports].find(([, report]) => !terminalOnly || ['succeeded','failed','unknown'].includes(String(report.state))); if (!first) return {}; reports.delete(first[0]); reports.set(first[0], first[1]); return { [first[0]]: first[1] }; }
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
