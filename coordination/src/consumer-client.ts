import { serverSentEvents } from "./sse.ts";
import type { FileTransfer, FileStep, FileRequest, TransferIntent } from "./linux-transfer-sdk.ts";
export { uploadWorkspaceFile, downloadWorkspaceFile } from "./linux-transfer-sdk.ts";
export type { FileTransfer, FileStep, FileRequest, TransferIntent, TransferJournal, TransferWait } from "./linux-transfer-sdk.ts";
import { operationReceipt } from "./linux-operations.ts";
import { X509Certificate, randomBytes, createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

/** Consumer HTTP SDK for the application/lease subset of the packaged OpenAPI contract.
 * It never retries, rotates credentials, follows redirects or generates identifiers.
 */

export type Capability = "command" | "pty" | "files" | "screenshot" | "displayStream" | "input" | "hierarchy";
export interface Resources { cpu: number; memoryMiB: number; diskGiB: number }
export type Capabilities = Record<Capability, boolean>;
/** A declared isolation class weaker than the runtime's own contract. `shared-host`: an iOS
 * simulator lease runs as ordinary processes of the Mac host's user, with the host's network
 * and files. It is not isolated from that host or from other simulators on it; lease it for
 * trusted code only. Absent on templates that declare no such class. */
export type LeaseIsolation = "shared-host";
export interface CatalogueImage {
  id: string; revision: string; os: string; arch: "arm64" | "amd64"; mode: string;
  minimum: Resources; defaults: Resources; memoryStepMiB: number; available: boolean; capabilities: Capabilities;
  isolation?: LeaseIsolation;
  [field: string]: unknown;
}
export interface Catalogue { templates: CatalogueImage[]; limits: Record<string, unknown> }
export type LeaseState = "provisioning" | "ready" | "failed" | "released" | "expired";
export interface Lease {
  /** The label given at acquisition, for display only. Absent from controllers that predate it. */
  name?: string | null;
  id: string; state: LeaseState; runtimeState: string; revision: number; createdAt: string; expiresAt: string;
  cleanup: { state: "notRequested" | "pending" | "running" | "blocked" | "complete" };
  members: Array<Record<string, unknown>>; capabilities: Partial<Capabilities>;
  /** Repeated from the single member, which also carries it as `members[].isolation`. */
  isolation?: LeaseIsolation;
}
export interface LeasePage { leases: Lease[]; nextCursor: string | null }
export interface Mutation { id: string; state: LeaseState; revision: number; expiresAt: string }
export interface MutationResult { mutation: Mutation; lease: Lease }
export interface AcquireRequest {
  /** Caller-owned UUID. Persist it with the body before dispatch and reuse both after uncertainty. */
  id: string; templateId: string; templateRevision: string; arch: "arm64" | "amd64";
  name?: string; resources?: Partial<Resources>; ttlSeconds?: number; requiredCapabilities?: Capability[];
}
export interface AcquireResult { /** True for 201 (new intent); false for an idempotent 200 replay. */ created: boolean; lease: Lease }
/** Linux TTLs must be >=30 seconds; the controller returns linux_ttl_below_minimum. */
export interface RenewRequest { id: string; expectedRevision: number; ttlSeconds: number }
export interface ReleaseRequest { id: string }
/** Opt-in durable lease intent. Persist the envelope before dispatch. */
/** Queued model-call intent: the model-job/1 submit message without `type`. Admission happens at a runner claim. */
export interface ModelJobIntent { adapter: "ollama" | "llama.cpp" | "vllm" | "mlx"; model: string; digest: string; prompt: string; maxTokens: number }
export type WaitingRequestInput = { id: string; priority?: number; deadline?: string; source?: Record<string, unknown> } &
  ({ kind: "lease" | "linux-lease"; intent: Omit<AcquireRequest,"id"> } | { kind: "model-job"; intent: ModelJobIntent });
/** Stored model-call intent as returned in request views: the prompt is replaced by `sha256:<hex>` of its UTF-8 bytes. */
export interface ModelJobRequestIntent { adapter: ModelJobIntent["adapter"]; model: string; digest: string; promptDigest: string; maxTokens: number }
export interface WaitingRequest { id: string; kind: "lease" | "linux-lease" | "model-job"; intent: AcquireRequest | ModelJobRequestIntent; resources: Partial<Resources>; priority: number; deadline: string | null; source: Record<string,unknown> | null; state: "waiting" | "admitted" | "cancelled" | "expired" | "rejected"; sequence: number; createdAt: string; admittedAt: string | null; target: string | null; reason: string | null;
  /** 1-based place in the controller's attempt order while a lease request waits; null once it is no longer waiting
   * and for model calls. An estimate of order, not a promise of admission. Absent from controllers that predate it. */
  position?: number | null }
export interface WaitingRequestPage { requests: WaitingRequest[]; nextCursor: string | null }
function waitingRequest(value: unknown, id?: string): WaitingRequest {
  if (!isRecord(value) || typeof value["id"] !== "string" || (id !== undefined && !sameId(value["id"],id)) ||
      !["lease","linux-lease","model-job"].includes(value["kind"] as string) || !["waiting","admitted","cancelled","expired","rejected"].includes(value["state"] as string) ||
      !Number.isSafeInteger(value["sequence"]) || !isRecord(value["intent"]) || typeof value["createdAt"] !== "string" ||
      !Number.isSafeInteger(value["priority"]) || !isRecord(value["resources"]) ||
      !(value["deadline"] === null || (typeof value["deadline"] === "string" && Number.isFinite(Date.parse(value["deadline"])))) ||
      !(value["source"] === null || isRecord(value["source"])) ||
      !(value["admittedAt"] === null || (typeof value["admittedAt"] === "string" && Number.isFinite(Date.parse(value["admittedAt"])))) ||
      !(value["reason"] === null || typeof value["reason"] === "string") ||
      !(value["position"] === undefined || value["position"] === null || (Number.isSafeInteger(value["position"]) && Number(value["position"]) >= 1 && value["state"] === "waiting")) ||
      (value["state"] === "admitted" && (value["target"] !== value["id"] || value["admittedAt"] === null)) ||
      !(value["target"] === null || value["target"] === value["id"])) throw new TypeError("waiting request");
  return value as unknown as WaitingRequest;
}
/** One entry of the application's own event history. `sequence` is the resume cursor. */
export interface ControllerEvent {
  sequence: number; at: string; kind: string; applicationId?: string; leaseId?: string; requestId?: string; machineId?: string; data: Record<string, unknown>;
}
/** `cursor` is the `after` value for the next page. `truncated` means retention removed history after the supplied cursor. */
export interface EventPage { events: ControllerEvent[]; cursor: number; more: boolean; truncated: boolean }
export interface EventFilter { kinds?: string[]; leaseId?: string; requestId?: string }
export interface EventListOptions extends EventFilter { after?: number; tail?: number; since?: string; limit?: number }
export interface EventFollowOptions extends EventFilter {
  after?: number; signal?: AbortSignal;
  /** Called when retention removed history after `after`. Supplying it accepts the gap; without it the stream throws. */
  onTruncated?: (gap: { after: number }) => void;
  /** Called when the stream reports how far it has read without an event, so a quiet follower can save a fresh cursor. */
  onCursor?: (cursor: number) => void;
}
/** An ordinary end of a followed stream. Continue with `after: cursor`. */
export interface EventStreamEnd { reason: "stream_lifetime" | "controller_closing" | "aborted"; cursor: number | undefined }
export interface UsageDistribution { p50: number | null; p95: number | null; samples: number }
export interface UsageRow {
  key: string; label?: string;
  requests?: { submitted: number; admitted: number; cancelled: number; expired: number; rejected: number; waiting: number; waitSeconds: UsageDistribution };
  leases: { admitted: number; ready: number; released: number; expired: number; failed: number; active: number; cleanupBlocked: number; deviceSeconds: number;
    timeToReadySeconds: UsageDistribution; holdSeconds: UsageDistribution };
}
export interface UsageReport {
  from: string; to: string; groupBy: "application" | "template" | "platform"; generatedAt: string; applicationId?: string;
  retention: { requestRecords: string; leaseLedgerSeconds: number; leaseLedgerStartedAt: string | null }; rows: UsageRow[]; totals: UsageRow;
}
function controllerEvent(value: unknown): ControllerEvent {
  if (!isRecord(value) || !Number.isSafeInteger(value["sequence"]) || Number(value["sequence"]) < 1 || typeof value["kind"] !== "string"
    || typeof value["at"] !== "string" || !Number.isFinite(Date.parse(value["at"])) || !isRecord(value["data"])) throw new TypeError("event");
  return value as unknown as ControllerEvent;
}
function eventPage(value: unknown): EventPage {
  if (!isRecord(value) || !Array.isArray(value["events"]) || value["events"].length > 500 || !Number.isSafeInteger(value["cursor"]) || Number(value["cursor"]) < 0
    || typeof value["more"] !== "boolean" || typeof value["truncated"] !== "boolean") throw new TypeError("event page");
  return { events: value["events"].map(controllerEvent), cursor: value["cursor"] as number, more: value["more"], truncated: value["truncated"] };
}
function eventQuery(options: EventFilter & { after?: number; tail?: number; since?: string; limit?: number }): string {
  const query = new URLSearchParams();
  const whole = (value: unknown, what: string, max: number) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new ConsumerConfigurationError(`${what} must be a whole number.`, "invalid_request");
    return String(value);
  };
  if (options.after !== undefined) query.set("after", whole(options.after, "after", Number.MAX_SAFE_INTEGER));
  if (options.tail !== undefined) query.set("tail", whole(options.tail, "tail", 500));
  if (options.limit !== undefined) query.set("limit", String(positive(options.limit, "limit", 500)));
  if (options.since !== undefined) {
    if (typeof options.since !== "string" || !options.since.endsWith("Z") || !Number.isFinite(Date.parse(options.since))) throw new ConsumerConfigurationError("since must be UTC RFC3339.", "invalid_request");
    query.set("since", options.since);
  }
  for (const kind of options.kinds ?? []) {
    if (typeof kind !== "string" || !/^[a-z]+\.(?:[a-z_]+|\*)$/.test(kind)) throw new ConsumerConfigurationError("kinds must be event kinds or families such as lease.*.", "invalid_request");
    query.append("kind", kind);
  }
  if (options.leaseId !== undefined) query.set("lease", uuid(options.leaseId, "leaseId"));
  if (options.requestId !== undefined) query.set("request", uuid(options.requestId, "requestId"));
  const text = query.toString();
  return text ? "?" + text : "";
}
/** Fresh lease-scoped key. Store privately and never log it. */
export interface LeaseCredential { id: string; credential: string }

export interface OperationRequest { id: string; member: "primary"; action: "shell"; arguments: { argv: string[]; timeoutMs?: number } }
export interface Operation {
  id: string; leaseId: string; member: "primary"; state: "queued" | "succeeded" | "failed" | "unknown"; updatedAt: string;
  previewReady?: boolean; dispatchedAt?: string; result?: Record<string, unknown>;
}
export interface CreateOperationResult { created: boolean; operation: Operation }
function boundOperation(value: unknown, leaseId: string, id: string): Operation {
  if (!isRecord(value) || typeof value.id !== "string" || !sameId(value.id, id) ||
      typeof value.leaseId !== "string" || !sameId(value.leaseId, leaseId) || value.member !== "primary" ||
      !["queued", "succeeded", "failed", "unknown"].includes(value.state as string) ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || !value.updatedAt.endsWith("Z")) throw new TypeError("operation");
  if (value.state === "queued") { if (Object.hasOwn(value, "result")) throw new TypeError("queued result"); }
  else operationReceipt({ state: value.state, ...(Object.hasOwn(value, "result") ? { result: value.result } : {}) });
  return value as unknown as Operation;
}

export type ErrorOutcome = "unknown" | undefined;
/** Base for all SDK errors. `outcome === "unknown"` means a mutation may or may not have taken effect. */
export class ConsumerError extends Error {
  readonly code: string;
  readonly outcome: ErrorOutcome;
  readonly requestId: string | undefined;
  /** SDK errors never authorize an automatic retry; service errors echo the controller's hint. */
  readonly retryable: boolean;
  constructor(name: string, message: string, code: string, options: { outcome?: "unknown"; requestId?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = name; this.code = code; this.outcome = options.outcome;
    this.requestId = options.requestId; this.retryable = options.retryable ?? false;
  }
}
/** Invalid local options or request, raised before any network activity. */
export class ConsumerConfigurationError extends ConsumerError {
  constructor(message: string, code = "invalid_configuration") { super("ConsumerConfigurationError", message, code); }
}
/** The controller returned its structured error shape (or the legacy error-only 503). */
export class ConsumerServiceError extends ConsumerError {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  constructor(message: string, code: string, status: number, options: {
    outcome?: "unknown"; requestId?: string; retryable?: boolean; retryAfterSeconds?: number;
  }) {
    super("ConsumerServiceError", message, code, options);
    this.status = status; this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
/** The reply violated the HTTP/JSON contract: redirect, wrong type, oversize, malformed or unexpected shape. */
export class ConsumerProtocolError extends ConsumerError {
  readonly status: number | undefined;
  constructor(message: string, code: string, status: number | undefined, options: { outcome?: "unknown"; requestId?: string }) {
    super("ConsumerProtocolError", message, code, options);
    this.status = status;
  }
}
/** Connection, TLS or timeout failure. */
export class ConsumerTransportError extends ConsumerError {
  constructor(message: string, code: "timeout" | "connection_failed" | "tls_verification_failed", options: { outcome?: "unknown"; requestId?: string }) {
    super("ConsumerTransportError", message, code, options);
  }
}

export interface ClientOptions {
  /** `https://host[:port][/prefix]`. Plain HTTP requires `allowLoopbackHttp` and an IP-literal loopback host. */
  baseUrl: string;
  /** Per-request wall-clock limit including connection and body. Default 30 s, maximum 300 s. */
  timeoutMs?: number;
  /** Maximum response body. Default 4 MiB, maximum 16 MiB. */
  maxResponseBytes?: number;
  /** PEM bundle path replacing the default trust store for this client. HTTPS only. */
  caFile?: string;
  /** PEM bundle contents; alternative to `caFile`. HTTPS only. */
  ca?: string | Buffer;
  /** Permit unencrypted HTTP to 127.0.0.0/8 or ::1 only, for local tests. */
  allowLoopbackHttp?: boolean;
}
export interface ApplicationClientOptions extends ClientOptions { applicationKey: string }
export interface LeaseClientOptions extends ClientOptions { leaseId: string; leaseKey: string }

const REQUEST_LIMIT = 1_048_576;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i;
const TOKEN = /^[A-Za-z0-9_-]{43,128}(?![\s\S])/;
const LEASE_STATES = ["provisioning", "ready", "failed", "released", "expired"];
/** Longest `inspectRequest` hold the controller accepts; see MAX_REQUEST_WAIT_SECONDS in control/http.ts. */
const MAX_REQUEST_WAIT_SECONDS = 15;
const CLEANUP_STATES = ["notRequested", "pending", "running", "blocked", "complete"];
const CAPABILITIES = ["command", "pty", "files", "screenshot", "displayStream", "input", "hierarchy"];
/** An isolation class this client does not know is never silently treated as stronger. */
function isolationKnown(value: Record<string, unknown>): boolean { return !Object.hasOwn(value, "isolation") || value["isolation"] === "shared-host"; }
const TLS_CODES = /^(CERT_|ERR_TLS_CERT|ERR_SSL|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_TLS)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ConsumerConfigurationError(`${what} must be a UUID.`, "invalid_request");
  return value;
}
function positive(value: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ConsumerConfigurationError(`${what} must be a positive integer.`, "invalid_request");
  }
  return value;
}
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || !/\S/.test(value)) {
    throw new ConsumerConfigurationError(`${what} must be a non-empty string of at most 100 characters.`, "invalid_request");
  }
  return value;
}
function exact(value: unknown, allowed: string[], what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConsumerConfigurationError(`${what} must be an object.`, "invalid_request");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ConsumerConfigurationError(`${what} has an unsupported field.`, "invalid_request");
  }
  return value;
}
function isLoopback(host: string): boolean {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const family = isIP(bare);
  return (family === 4 && bare.startsWith("127.")) || (family === 6 && (bare === "::1" || bare === "0:0:0:0:0:0:0:1"));
}

/** Shared verified HTTP/session transport. No retries or credential exchanges. */
export class Transport {
  readonly #base: URL;
  readonly #prefix: string;
  readonly #timeoutMs: number;
  get timeoutMs(): number { return this.#timeoutMs; }
  readonly #maxResponse: number;
  readonly #ca: string | Buffer | undefined;
  readonly #secure: boolean;
  readonly #credential: string;
  constructor(options: ClientOptions, credential: string) {
    if (!TOKEN.test(credential)) {
      throw new ConsumerConfigurationError("Credential must be an opaque URL-safe token of 43 to 128 characters.", "invalid_credential");
    }
    this.#credential = credential;
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new ConsumerConfigurationError("baseUrl is not a valid URL."); }
    if (url.username || url.password || url.search || url.hash) {
      throw new ConsumerConfigurationError("baseUrl must not contain credentials, a query or a fragment.");
    }
    if (url.protocol === "https:") this.#secure = true;
    else if (url.protocol === "http:" && options.allowLoopbackHttp === true && isLoopback(url.hostname)) this.#secure = false;
    else throw new ConsumerConfigurationError("Use https; plain HTTP is allowed only to a loopback IP literal with allowLoopbackHttp.");
    if ((options.ca !== undefined || options.caFile !== undefined) && !this.#secure) {
      throw new ConsumerConfigurationError("A CA bundle requires an https baseUrl.");
    }
    if (options.ca !== undefined && options.caFile !== undefined) throw new ConsumerConfigurationError("Pass ca or caFile, not both.");
    if (options.caFile !== undefined) {
      try { this.#ca = readFileSync(options.caFile); } catch { throw new ConsumerConfigurationError("The CA file could not be read.", "invalid_ca"); }
    } else this.#ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;
    if (this.#ca !== undefined) {
      try {
        const blocks = String(this.#ca).match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g);
        if (!blocks) throw new Error("no certificate");
        for (const block of blocks) new X509Certificate(block);
        tls.createSecureContext({ ca: this.#ca });
      } catch { throw new ConsumerConfigurationError("The CA bundle is not valid PEM.", "invalid_ca"); }
    }
    this.#base = url;
    this.#prefix = url.pathname.replace(/\/+$/, "");
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new ConsumerConfigurationError("timeoutMs must be 1 to 300000.");
    this.#timeoutMs = timeout;
    const limit = options.maxResponseBytes ?? 4_194_304;
    if (!Number.isInteger(limit) || limit < 1 || limit > 16_777_216) throw new ConsumerConfigurationError("maxResponseBytes must be 1 to 16777216.");
    this.#maxResponse = limit;
  }

  async openSession(path: string): Promise<{ socket: Duplex; head: Buffer }> {
    if (!/^\/v1\/(?:leases\/[0-9a-f-]+\/(?:(?:video-)?sessions|tunnels)|machines\/[0-9a-f-]+\/video-sessions)\/[0-9a-f-]+\/[0-9a-f-]+$/i.test(path)) {
      throw new ConsumerConfigurationError("Invalid session attachment path.");
    }
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    return new Promise((resolve, reject) => {
      let settled = false, verified = !this.#secure;
      const request = (this.#secure ? https : http).request({
        protocol: this.#base.protocol, hostname: this.#base.hostname.replace(/^\[|\]$/g, ""), port: this.#base.port || undefined,
        path: this.#prefix + path, method: "GET", agent: false,
        headers: { Authorization: "Bearer " + this.#credential, Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "canaveral-session-v1" },
        ...(this.#secure ? { minVersion: "TLSv1.2", rejectUnauthorized: true, ...(this.#ca !== undefined ? { ca: this.#ca } : {}) } : {}),
      });
      const fail = (error: ConsumerError) => { if (!settled) { settled = true; clearTimeout(timer); request.destroy(); reject(error); } };
      const timer = setTimeout(() => fail(new ConsumerTransportError("Session attachment timed out.", "timeout", {})), this.#timeoutMs);
      request.on("socket", socket => { if (this.#secure) socket.once("secureConnect", () => { verified = true; }); });
      request.on("error", (error: NodeJS.ErrnoException) => fail(new ConsumerTransportError("Session attachment failed; no input was replayed.",
        !verified && TLS_CODES.test(error.code ?? "") ? "tls_verification_failed" : "connection_failed", {})));
      request.on("response", response => {
        response.destroy();
        const status = response.statusCode ?? 0;
        fail(new ConsumerProtocolError("Session upgrade was refused.", status >= 300 && status < 400 ? "redirect_refused" : "session_upgrade_refused", status, {}));
      });
      request.on("upgrade", (response, socket, head) => {
        if (settled) { socket.destroy(); return; }
        if (response.statusCode !== 101 || response.headers["upgrade"]?.toLowerCase() !== "websocket" ||
            !String(response.headers["connection"]).toLowerCase().split(/\s*,\s*/).includes("upgrade") ||
            response.headers["sec-websocket-accept"] !== accept || response.headers["sec-websocket-protocol"] !== "canaveral-session-v1" ||
            response.headers["sec-websocket-extensions"] !== undefined) {
          socket.destroy(); fail(new ConsumerProtocolError("Invalid session upgrade response.", "session_protocol_error", 101, {})); return;
        }
        settled = true; clearTimeout(timer); socket.pause(); resolve({ socket, head });
      });
      request.end();
    });
  }

  /** `mutating` makes every uncertain failure carry `outcome: "unknown"`. `requestId` is the caller-owned body UUID. */
  async call(method: "GET" | "POST", path: string, body: unknown, accepted: number[], mutating: boolean, requestId?: string): Promise<{ status: number; json: unknown }> {
    const unknownOutcome = mutating ? { outcome: "unknown" as const } : {};
    const identity = requestId === undefined ? {} : { requestId };
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload !== undefined && payload.length > REQUEST_LIMIT) throw new ConsumerConfigurationError("Request body exceeds 1 MiB.", "invalid_request");
    const headers: OutgoingHttpHeaders = {
      Accept: "application/json", Authorization: "Bearer " + this.#credential, Connection: "close", "User-Agent": "canaveral-consumer-sdk",
      ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
    };
    const options: https.RequestOptions = {
      protocol: this.#base.protocol, hostname: this.#base.hostname.replace(/^\[|\]$/g, ""), port: this.#base.port || undefined,
      method, path: this.#prefix + path, headers, agent: false,
      ...(this.#secure ? { minVersion: "TLSv1.2" as const, rejectUnauthorized: true, ...(this.#ca !== undefined ? { ca: this.#ca } : {}) } : {}),
    };
    const reply = await new Promise<{ response: IncomingMessage; chunks: Buffer[] }>((resolve, reject) => {
      let settled = false; let timedOut = false; let verified = !this.#secure;
      const fail = (error: ConsumerError) => { if (!settled) { settled = true; clearTimeout(timer); request.destroy(); reject(error); } };
      const request = (this.#secure ? https : http).request(options);
      request.on("socket", socket => {
        if (this.#secure) socket.once("secureConnect", () => { verified = true; });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        fail(new ConsumerTransportError("The request timed out.", "timeout", { ...unknownOutcome, ...identity }));
      }, this.#timeoutMs);
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (timedOut) return;
        const code = typeof error.code === "string" ? error.code : "";
        // Certificate failures end the handshake before any request bytes are sent.
        if (!verified && TLS_CODES.test(code)) fail(new ConsumerTransportError("TLS verification failed.", "tls_verification_failed", identity));
        else fail(new ConsumerTransportError("The connection failed" + (code ? ` (${code}).` : "."), "connection_failed", { ...unknownOutcome, ...identity }));
      });
      request.on("response", response => {
        const status = response.statusCode ?? 0;
        // Never read a redirect body or follow Location: the bearer stays with the configured origin.
        if (status >= 300 && status < 400) {
          fail(new ConsumerProtocolError("The controller replied with a redirect, which is refused.", "redirect_refused", status, { ...unknownOutcome, ...identity }));
          return;
        }
        const declared = response.headers["content-length"];
        if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > this.#maxResponse)) {
          fail(new ConsumerProtocolError("The reply exceeds the response size limit.", "response_too_large", status, { ...unknownOutcome, ...identity }));
          return;
        }
        const chunks: Buffer[] = []; let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.#maxResponse) {
            fail(new ConsumerProtocolError("The reply exceeds the response size limit.", "response_too_large", status, { ...unknownOutcome, ...identity }));
          } else chunks.push(chunk);
        });
        response.on("error", () => fail(new ConsumerTransportError("The reply was interrupted.", "connection_failed", { ...unknownOutcome, ...identity })));
        response.on("close", () => {
          if (!response.complete) fail(new ConsumerTransportError("The reply was incomplete.", "connection_failed", { ...unknownOutcome, ...identity }));
        });
        response.on("end", () => {
          if (settled || !response.complete) return;
          settled = true; clearTimeout(timer); resolve({ response, chunks });
        });
      });
      request.end(payload);
    });
    const status = reply.response.statusCode ?? 0;
    const invalid = (message: string, code = "response_invalid") =>
      new ConsumerProtocolError(message, code, status, { ...unknownOutcome, ...identity });
    if (!/^application\/json\s*(;\s*charset=("?)utf-8\2\s*)?$/i.test(String(reply.response.headers["content-type"] ?? ""))) {
      throw invalid("The reply is not JSON.", "content_type_invalid");
    }
    let json: unknown;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(reply.chunks))); }
    catch { throw invalid("The reply is not valid JSON."); }
    if (status >= 200 && status < 300) {
      if (!accepted.includes(status)) throw invalid("The reply status is not defined for this operation.");
      return { status, json };
    }
    throw this.#serviceError(status, json, mutating, requestId, reply.response, invalid);
  }

  /** Opens a server-sent event stream. The request timeout bounds the wait for the reply headers; an
   * open stream then lasts until the controller ends it, the caller aborts, or the connection fails.
   * A refusal is read as the same structured error as any other reply. Nothing is retried. */
  async stream(path: string, signal?: AbortSignal): Promise<IncomingMessage> {
    const options: https.RequestOptions = {
      protocol: this.#base.protocol, hostname: this.#base.hostname.replace(/^\[|\]$/g, ""), port: this.#base.port || undefined,
      method: "GET", path: this.#prefix + path, agent: false,
      headers: { Accept: "text/event-stream", Authorization: "Bearer " + this.#credential, Connection: "close", "User-Agent": "canaveral-consumer-sdk" },
      ...(this.#secure ? { minVersion: "TLSv1.2" as const, rejectUnauthorized: true, ...(this.#ca !== undefined ? { ca: this.#ca } : {}) } : {}),
    };
    return new Promise<IncomingMessage>((resolve, reject) => {
      let settled = false, verified = !this.#secure;
      const request = (this.#secure ? https : http).request(options);
      const abort = () => { request.destroy(); if (!settled) { settled = true; clearTimeout(timer); reject(new ConsumerTransportError("The event stream was aborted.", "connection_failed", {})); } };
      const fail = (error: ConsumerError) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); request.destroy(); reject(error); } };
      const timer = setTimeout(() => fail(new ConsumerTransportError("The request timed out.", "timeout", {})), this.#timeoutMs);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      request.on("socket", socket => { if (this.#secure) socket.once("secureConnect", () => { verified = true; }); });
      request.on("error", (error: NodeJS.ErrnoException) => fail(new ConsumerTransportError("The connection failed.",
        !verified && TLS_CODES.test(error.code ?? "") ? "tls_verification_failed" : "connection_failed", {})));
      request.on("response", response => {
        const status = response.statusCode ?? 0;
        const invalid = (message: string, code = "response_invalid") => new ConsumerProtocolError(message, code, status, {});
        if (status >= 300 && status < 400) { fail(invalid("The controller replied with a redirect, which is refused.", "redirect_refused")); return; }
        if (status === 200) {
          if (!/^text\/event-stream\s*(;|$)/i.test(String(response.headers["content-type"] ?? ""))) { fail(invalid("The reply is not an event stream.", "content_type_invalid")); return; }
          settled = true; clearTimeout(timer);
          response.once("close", () => signal?.removeEventListener("abort", abort));
          resolve(response); return;
        }
        const chunks: Buffer[] = []; let received = 0;
        response.on("data", (chunk: Buffer) => { received += chunk.length; if (received > 65536) fail(invalid("The reply exceeds the response size limit.", "response_too_large")); else chunks.push(chunk); });
        response.on("error", () => fail(new ConsumerTransportError("The reply was interrupted.", "connection_failed", {})));
        response.on("end", () => {
          let json: unknown;
          try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail(invalid("The reply is not valid JSON.")); return; }
          fail(this.#serviceError(status, json, false, undefined, response, invalid));
        });
      });
      request.end();
    });
  }

  #serviceError(status: number, json: unknown, mutating: boolean, requestId: string | undefined,
    response: IncomingMessage, invalid: (message: string) => ConsumerProtocolError): ConsumerError {
    // Only a 4xx structured reply is a definite rejection; anything else leaves a mutation uncertain.
    const definite = status >= 400 && status < 500 && status !== 408;
    const outcome = mutating && !definite ? { outcome: "unknown" as const } : {};
    const clean = (value: string) => value.split(this.#credential).join("[redacted]").slice(0, 500);
    if (!isRecord(json) || typeof json["error"] !== "string") return invalid("The error reply has an unexpected shape.");
    if (typeof json["code"] === "string" && typeof json["message"] === "string" && typeof json["retryable"] === "boolean") {
      const header = response.headers["retry-after"];
      const after = typeof header === "string" && /^[0-9]{1,6}$/.test(header) ? Number(header) : undefined;
      // HTTP tracing IDs do not identify durable effects. Recovery of an uncertain
      // mutation must retain the caller's operation/acquisition/mutation UUID.
      const correlation = typeof json["requestId"] === "string" && UUID.test(json["requestId"]) ? json["requestId"] : requestId;
      const echoed = mutating && !definite && requestId !== undefined ? requestId : correlation;
      return new ConsumerServiceError(clean(json["message"]), clean(json["code"]).slice(0, 100), status, {
        ...outcome, ...(echoed ? { requestId: echoed } : {}), retryable: json["retryable"], ...(after !== undefined ? { retryAfterSeconds: after } : {}),
      });
    }
    if (Object.keys(json).length === 1 && status === 503) {
      return new ConsumerServiceError("The controller's storage or service is unavailable.", "unavailable", status,
        { ...outcome, ...(requestId ? { requestId } : {}), retryable: true });
    }
    return invalid("The error reply has an unexpected shape.");
  }
}

function lease(value: unknown): Lease {
  if (!isRecord(value) || typeof value["id"] !== "string" || !UUID.test(value["id"])
    || !LEASE_STATES.includes(value["state"] as string)
    || typeof value["runtimeState"] !== "string" || !Number.isSafeInteger(value["revision"]) || Number(value["revision"]) < 1
    || typeof value["createdAt"] !== "string" || typeof value["expiresAt"] !== "string"
    || !(value["name"] === undefined || value["name"] === null || typeof value["name"] === "string")
    || !isRecord(value["cleanup"]) || !CLEANUP_STATES.includes(value["cleanup"]["state"] as string)
    || !Array.isArray(value["members"]) || !value["members"].every(isRecord) || !isRecord(value["capabilities"])
    || !Object.values(value["capabilities"]).every(v => typeof v === "boolean")
    || !isolationKnown(value) || !value["members"].every(isolationKnown)) {
    throw new TypeError("lease");
  }
  return value as unknown as Lease;
}
function mutation(value: unknown): MutationResult {
  if (!isRecord(value) || !isRecord(value["mutation"])) throw new TypeError("mutation");
  const m = value["mutation"];
  if (typeof m["id"] !== "string" || !UUID.test(m["id"]) || !LEASE_STATES.includes(m["state"] as string)
    || !Number.isSafeInteger(m["revision"]) || Number(m["revision"]) < 1 || typeof m["expiresAt"] !== "string") throw new TypeError("mutation");
  return { mutation: m as unknown as Mutation, lease: lease(value["lease"]) };
}
function sameId(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function boundMutation(value: unknown, leaseId: string, mutationId: string): MutationResult {
  const reply = mutation(value);
  if (!sameId(reply.lease.id, leaseId) || !sameId(reply.mutation.id, mutationId)) throw new TypeError("receipt identity");
  return reply;
}
function catalogue(value: unknown): Catalogue {
  if (!isRecord(value) || !Array.isArray(value["templates"]) || !isRecord(value["limits"])) throw new TypeError("catalogue");
  for (const image of value["templates"]) {
    if (!isRecord(image) || typeof image["id"] !== "string" || typeof image["revision"] !== "string"
      || typeof image["os"] !== "string" || typeof image["arch"] !== "string" || typeof image["mode"] !== "string"
      || typeof image["available"] !== "boolean" || !isRecord(image["minimum"]) || !isRecord(image["defaults"])
      || !Number.isSafeInteger(image["memoryStepMiB"]) || !isRecord(image["capabilities"]) || !isolationKnown(image)) throw new TypeError("catalogue");
  }
  return value as unknown as Catalogue;
}
function page(value: unknown): LeasePage {
  const cursor = isRecord(value) ? value["nextCursor"] : undefined;
  if (!isRecord(value) || !Array.isArray(value["leases"]) || value["leases"].length > 100
    || !(cursor === null || (typeof cursor === "string" && UUID.test(cursor)))) throw new TypeError("page");
  value["leases"].forEach(lease);
  return value as unknown as LeasePage;
}

async function parsed<T>(transport: Transport, method: "GET" | "POST", path: string, body: unknown, accepted: number[],
  mutating: boolean, requestId: string | undefined, validate: (value: unknown) => T): Promise<{ status: number; value: T }> {
  const { status, json } = await transport.call(method, path, body, accepted, mutating, requestId);
  try { return { status, value: validate(json) }; }
  catch {
    // A syntactically valid but unrecognised success still leaves a mutation's effect unconfirmed.
    throw new ConsumerProtocolError("The reply does not match the consumer contract.", "response_invalid", status,
      { ...(mutating ? { outcome: "unknown" as const } : {}), ...(requestId ? { requestId } : {}) });
  }
}

function acquireBody(request: AcquireRequest): Record<string, unknown> {
  const r = exact(request, ["id", "templateId", "templateRevision", "arch", "name", "resources", "ttlSeconds", "requiredCapabilities"], "Acquire request");
  if (r["arch"] !== "arm64" && r["arch"] !== "amd64") throw new ConsumerConfigurationError("arch must be arm64 or amd64.", "invalid_request");
  const body: Record<string, unknown> = {
    id: uuid(r["id"], "id"), templateId: text(r["templateId"], "templateId"),
    templateRevision: text(r["templateRevision"], "templateRevision"), arch: r["arch"],
  };
  if (r["name"] !== undefined) body["name"] = text(r["name"], "name");
  if (r["resources"] !== undefined) {
    const res = exact(r["resources"], ["cpu", "memoryMiB", "diskGiB"], "resources");
    body["resources"] = Object.fromEntries(Object.entries(res).filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, positive(v, k, 1_048_576)]));
  }
  if (r["ttlSeconds"] !== undefined) body["ttlSeconds"] = positive(r["ttlSeconds"], "ttlSeconds", 2_147_483_647);
  if (r["requiredCapabilities"] !== undefined) {
    const list = r["requiredCapabilities"];
    if (!Array.isArray(list) || !list.every(c => CAPABILITIES.includes(c as string)) || new Set(list).size !== list.length) {
      throw new ConsumerConfigurationError("requiredCapabilities must be unique known capabilities.", "invalid_request");
    }
    body["requiredCapabilities"] = list;
  }
  return body;
}
function renewBody(request: RenewRequest): Record<string, unknown> {
  const r = exact(request, ["id", "expectedRevision", "ttlSeconds"], "Renew request");
  return { id: uuid(r["id"], "id"), expectedRevision: positive(r["expectedRevision"], "expectedRevision"),
    ttlSeconds: positive(r["ttlSeconds"], "ttlSeconds", 2_147_483_647) };
}
function releaseBody(request: ReleaseRequest): Record<string, unknown> {
  return { id: uuid(exact(request, ["id"], "Release request")["id"], "id") };
}

class LeaseOperations {
  protected readonly transport: Transport;
  constructor(transport: Transport) { this.transport = transport; }
  protected async inspectById(leaseId: string): Promise<Lease> {
    const id = uuid(leaseId, "leaseId");
    const { value } = await parsed(this.transport, "GET", `/v1/leases/${id}`, undefined, [200], false, undefined, lease);
    if (!sameId(value.id, id)) throw new ConsumerProtocolError("The reply describes a different lease.", "response_invalid", 200, {});
    return value;
  }
  /** Replaying the identical `id`, `expectedRevision` and `ttlSeconds` returns the original mutation with the current lease. */
  protected async renewById(leaseId: string, request: RenewRequest): Promise<MutationResult> {
    const id = uuid(leaseId, "leaseId"); const body = renewBody(request);
    return (await parsed(this.transport, "POST", `/v1/leases/${id}/renew`, body, [200], true, body["id"] as string,
      value => boundMutation(value, id, body["id"] as string))).value;
  }
  protected async releaseById(leaseId: string, request: ReleaseRequest): Promise<MutationResult> {
    const id = uuid(leaseId, "leaseId"); const body = releaseBody(request);
    return (await parsed(this.transport, "POST", `/v1/leases/${id}/release`, body, [200], true, body["id"] as string,
      value => boundMutation(value, id, body["id"] as string))).value;
  }
}

/** Application-key client: catalogue, listing, acquisition and owned-lease lifecycle. */
export class ConsumerClient extends LeaseOperations {
  readonly #transport: Transport;
  constructor(options: ApplicationClientOptions) {
    const transport = new Transport(options, options.applicationKey);
    super(transport); this.#transport = transport;
  }
  async submitRequest(request: WaitingRequestInput): Promise<{ created: boolean; request: WaitingRequest }> {
    const r = exact(request, ["id","kind","intent","priority","deadline","source"], "Waiting request");
    const id = uuid(r["id"], "id");
    if (r["kind"] !== "lease" && r["kind"] !== "linux-lease" && r["kind"] !== "model-job") throw new ConsumerConfigurationError("Use lease, linux-lease or model-job.", "invalid_request");
    if (!isRecord(r["intent"]) || Object.hasOwn(r["intent"],"id")) throw new ConsumerConfigurationError("intent excludes the envelope UUID.", "invalid_request");
    let intent: Record<string, unknown>;
    if (r["kind"] === "model-job") intent = exact(r["intent"], ["adapter","model","digest","prompt","maxTokens"], "Model-job intent");
    else { intent = acquireBody({ ...r["intent"] as Omit<AcquireRequest,"id">, id }); delete intent["id"]; }
    const body = { ...r, id, intent };
    if (r["priority"] !== undefined && (typeof r["priority"] !== "number" || !Number.isSafeInteger(r["priority"]) || Math.abs(r["priority"]) > 1000000)) throw new ConsumerConfigurationError("Invalid priority.", "invalid_request");
    if (r["deadline"] !== undefined && (typeof r["deadline"] !== "string" || !r["deadline"].endsWith("Z") || !Number.isFinite(Date.parse(r["deadline"])))) throw new ConsumerConfigurationError("Invalid deadline.", "invalid_request");
    if (r["source"] !== undefined && (!isRecord(r["source"]) || Buffer.byteLength(JSON.stringify(r["source"])) > 4096)) throw new ConsumerConfigurationError("source must be an object within 4096 bytes.", "invalid_request");
    const result = await parsed(this.#transport,"POST","/v1/requests",body,[200,201],true,id,v => waitingRequest(v,id));
    return { created:result.status === 201, request:result.value };
  }
  /** With `waitSeconds` (1 to 15) the controller holds the reply while the request is still waiting and nothing a
   * caller acts on has changed (state, position, reason), then returns the current view. It is one bounded read,
   * not a retry loop: the SDK still never polls, and a caller that wants to keep waiting calls again. */
  async inspectRequest(requestId: string, options: { waitSeconds?: number } = {}): Promise<WaitingRequest> {
    const id = uuid(requestId,"requestId"), wait = exact(options,["waitSeconds"],"Inspect options")["waitSeconds"];
    if (wait !== undefined) {
      positive(wait,"waitSeconds",MAX_REQUEST_WAIT_SECONDS);
      // The reply arrives after the wait plus the controller's own latency; without this margin a healthy hold would be reported as a timeout.
      if (Number(wait) * 1000 + 5000 > this.#transport.timeoutMs) throw new ConsumerConfigurationError("waitSeconds must leave five seconds within timeoutMs.","invalid_request");
    }
    return (await parsed(this.#transport,"GET",`/v1/requests/${id}` + (wait === undefined ? "" : `?wait=${wait}`),undefined,[200],false,undefined,v => waitingRequest(v,id))).value;
  }
  async cancelRequest(requestId: string): Promise<WaitingRequest> {
    const id = uuid(requestId,"requestId");
    return (await parsed(this.#transport,"POST",`/v1/requests/${id}/cancel`,{},[200],true,id,v => waitingRequest(v,id))).value;
  }
  async listRequests(options: { after?: string } = {}): Promise<WaitingRequestPage> {
    const query = options.after === undefined ? "" : "?after=" + uuid(options.after,"after");
    return (await parsed(this.#transport,"GET","/v1/requests"+query,undefined,[200],false,undefined,v => {
      if (!isRecord(v) || !Array.isArray(v["requests"]) || !(v["nextCursor"] === null || typeof v["nextCursor"] === "string")) throw new TypeError("request page");
      return { requests:v["requests"].map(r => waitingRequest(r)),nextCursor:v["nextCursor"] as string | null };
    })).value;
  }
  async catalogue(): Promise<Catalogue> {
    return (await parsed(this.#transport, "GET", "/v1/environments/templates", undefined, [200], false, undefined, catalogue)).value;
  }
  /** One page of this application's own events, oldest first. Pass the returned `cursor` as `after` to continue. */
  async listEvents(options: EventListOptions = {}): Promise<EventPage> {
    const o = exact(options, ["after", "tail", "since", "limit", "kinds", "leaseId", "requestId"], "Event options") as EventListOptions;
    if (o.after !== undefined && o.tail !== undefined) throw new ConsumerConfigurationError("Use either after or tail.", "invalid_request");
    return (await parsed(this.#transport, "GET", "/v1/events" + eventQuery(o), undefined, [200], false, undefined, eventPage)).value;
  }
  /** Follows this application's events live over one server-sent event stream. Without `after` it starts
   * with the next event. It never reconnects.
   *
   * How it ends is always visible:
   * - It returns an `EventStreamEnd` when the controller ends the stream in the ordinary way
   *   (`stream_lifetime` after an hour, `controller_closing`) or when the caller aborts. A `for await` loop
   *   simply finishes; follow again with `after` set to the returned `cursor` or the last `sequence` seen.
   * - It throws `ConsumerServiceError` when the stream ends because the credential is no longer accepted
   *   (`unauthenticated`, `forbidden`) or the controller reports `unavailable`.
   * - It throws `ConsumerTransportError` when the connection drops without an end message.
   * - When retention has removed history after `after`, it calls `onTruncated` and continues. Without that
   *   handler it throws `events_truncated`, so a consumer is never left unaware that it may have missed events.
   * Stop iterating, or abort the signal, to close the stream. */
  async *followEvents(options: EventFollowOptions = {}): AsyncGenerator<ControllerEvent, EventStreamEnd, void> {
    const o = exact(options, ["after", "kinds", "leaseId", "requestId", "signal", "onTruncated", "onCursor"], "Event options") as EventFollowOptions;
    const { signal, onTruncated, onCursor, ...filter } = o;
    for (const handler of [onTruncated, onCursor]) if (handler !== undefined && typeof handler !== "function") throw new ConsumerConfigurationError("Event handlers must be functions.", "invalid_request");
    let cursor: number | undefined = filter.after, response: IncomingMessage;
    // An abort is the caller's own decision at any point, including while the stream is still being opened.
    try { response = await this.#transport.stream("/v1/events/stream" + eventQuery(filter), signal); }
    catch (error) { if (signal?.aborted) return { reason: "aborted", cursor }; throw error; }
    const stop = () => response.destroy();
    signal?.addEventListener("abort", stop, { once: true });
    const position = (data: unknown): void => { if (isRecord(data) && Number.isSafeInteger(data["cursor"]) && Number(data["cursor"]) >= 0) cursor = data["cursor"] as number; };
    const invalid = () => new ConsumerProtocolError("The event stream sent a message outside the consumer contract.", "response_invalid", 200, {});
    try {
      for await (const message of serverSentEvents(response)) {
        let data: unknown;
        try { data = JSON.parse(message.data); } catch { throw invalid(); }
        if (message.event === "open" || message.event === "cursor") { position(data); if (cursor !== undefined) onCursor?.(cursor); continue; }
        if (message.event === "truncated") {
          if (!onTruncated) throw new ConsumerServiceError("Retention removed events after this cursor; some history may have been missed. Pass onTruncated to continue from what remains.", "events_truncated", 410, { retryable: false });
          onTruncated({ after: filter.after ?? 0 });
          continue;
        }
        if (message.event === "end") {
          position(data);
          const reason = isRecord(data) ? data["code"] : undefined;
          if (reason === "stream_lifetime" || reason === "controller_closing") return { reason, cursor };
          if (reason === "unauthenticated") throw new ConsumerServiceError("The credential is no longer accepted; the event stream ended.", "unauthenticated", 401, { retryable: false });
          if (reason === "forbidden") throw new ConsumerServiceError("The credential may no longer read these events; the event stream ended.", "forbidden", 403, { retryable: false });
          throw new ConsumerServiceError("The controller ended the event stream; resume from the last sequence received.", "unavailable", 503, { retryable: true });
        }
        if (message.event !== undefined) continue;
        let event: ControllerEvent;
        try { event = controllerEvent(data); } catch { throw invalid(); }
        cursor = event.sequence;
        yield event;
      }
    } catch (error) {
      if (error instanceof ConsumerError) throw error;
      if (signal?.aborted) return { reason: "aborted", cursor };
      throw new ConsumerTransportError("The event stream was interrupted; resume from the last sequence received.", "connection_failed", {});
    } finally { signal?.removeEventListener("abort", stop); response.destroy(); }
    if (signal?.aborted) return { reason: "aborted", cursor };
    // The response ended without an end message: the connection was cut, not closed by the controller.
    throw new ConsumerTransportError("The event stream ended without a closing message; resume from the last sequence received.", "connection_failed", {});
  }
  /** This application's own usage over a UTC range (default: the last 24 hours), grouped by application, template or platform. */
  async usage(options: { from?: string; to?: string; groupBy?: "application" | "template" | "platform" } = {}): Promise<UsageReport> {
    const o = exact(options, ["from", "to", "groupBy"], "Usage options"), query = new URLSearchParams();
    for (const key of ["from", "to"] as const) if (o[key] !== undefined) {
      if (typeof o[key] !== "string" || !o[key].endsWith("Z") || !Number.isFinite(Date.parse(o[key]))) throw new ConsumerConfigurationError(`${key} must be UTC RFC3339.`, "invalid_request");
      query.set(key, o[key]);
    }
    if (o["groupBy"] !== undefined) {
      if (!["application", "template", "platform"].includes(o["groupBy"] as string)) throw new ConsumerConfigurationError("groupBy must be application, template or platform.", "invalid_request");
      query.set("groupBy", o["groupBy"] as string);
    }
    const text = query.toString();
    return (await parsed(this.#transport, "GET", "/v1/usage" + (text ? "?" + text : ""), undefined, [200], false, undefined, value => {
      if (!isRecord(value) || !Array.isArray(value["rows"]) || !isRecord(value["totals"]) || !isRecord(value["retention"]) || typeof value["from"] !== "string" || typeof value["to"] !== "string") throw new TypeError("usage");
      return value as unknown as UsageReport;
    })).value;
  }
  async listLeases(options: { after?: string } = {}): Promise<LeasePage> {
    const query = options.after === undefined ? "" : "?after=" + uuid(options.after, "after");
    return (await parsed(this.#transport, "GET", "/v1/leases" + query, undefined, [200], false, undefined, page)).value;
  }
  /** Not retried. After an unknown outcome, inspect the lease or replay this exact `id` and body. */
  async acquireLease(request: AcquireRequest): Promise<AcquireResult> {
    const body = acquireBody(request);
    const { status, value } = await parsed(this.#transport, "POST", "/v1/leases", body, [200, 201], true, body["id"] as string, value => {
      const reply = lease(value);
      if (!sameId(reply.id, body["id"] as string)) throw new TypeError("acquisition identity");
      return reply;
    });
    return { created: status === 201, lease: value };
  }
  /** Owner-only explicit exchange. Not idempotent and never retried: each success revokes the
   * previous lease key. After an unknown outcome, deliberately call again to obtain a fresh key. */
  async rotateLeaseCredential(leaseId: string): Promise<LeaseCredential> {
    const id = uuid(leaseId, "leaseId");
    return (await parsed(this.#transport, "POST", `/v1/leases/${id}/credential`, {}, [200], true, undefined, value => {
      if (!isRecord(value) || typeof value["id"] !== "string" || !sameId(value["id"], id) || typeof value["credential"] !== "string"
        || !TOKEN.test(value["credential"])) throw new TypeError("credential");
      return { id: value["id"], credential: value["credential"] };
    })).value;
  }
  inspectLease(leaseId: string): Promise<Lease> { return this.inspectById(leaseId); }
  renewLease(leaseId: string, request: RenewRequest): Promise<MutationResult> { return this.renewById(leaseId, request); }
  releaseLease(leaseId: string, request: ReleaseRequest): Promise<MutationResult> { return this.releaseById(leaseId, request); }
}

/** Lease-key client bound to one lease. It cannot list, acquire or rotate. */
export class LeaseClient extends LeaseOperations {
  readonly leaseId: string;
  constructor(options: LeaseClientOptions) {
    const leaseId = uuid(options.leaseId, "leaseId");
    super(new Transport({...options,timeoutMs:Math.min(options.timeoutMs??20000,20000)}, options.leaseKey)); this.leaseId = leaseId;
  }
  async createOperation(request: OperationRequest): Promise<CreateOperationResult> {
    const r = exact(request, ["id", "member", "action", "arguments"], "Operation request"), id = uuid(r.id, "id");
    const args = exact(r.arguments, ["argv", "timeoutMs"], "Operation arguments"), argv = args.argv;
    if (r.member !== "primary" || r.action !== "shell" || !Array.isArray(argv) || !argv.length || argv[0] === "" ||
        argv.some(v => typeof v !== "string" || v.includes("\0")) || Buffer.byteLength(JSON.stringify(argv)) > 65536) {
      throw new ConsumerConfigurationError("Invalid shell operation.", "invalid_request");
    }
    if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== "number" || !Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > 1800000)) throw new ConsumerConfigurationError("Invalid timeoutMs.", "invalid_request");
    const body = { id, member: "primary", action: "shell", arguments: { argv, ...(args.timeoutMs === undefined ? {} : {timeoutMs:args.timeoutMs}) } };
    const { status, value } = await parsed(this.transport, "POST", `/v1/leases/${this.leaseId}/operations`, body, [200, 201], true, id,
      value => boundOperation(value, this.leaseId, id));
    return { created: status === 201, operation: value };
  }
  async operation(operationId: string): Promise<Operation> {
    const id = uuid(operationId, "operationId");
    return (await parsed(this.transport, "GET", `/v1/leases/${this.leaseId}/operations/${id}`, undefined, [200], false, undefined,
      value => boundOperation(value, this.leaseId, id))).value;
  }
  async createTransfer(intent:TransferIntent):Promise<FileTransfer> {
    return (await parsed(this.transport,'POST',`/v1/leases/${this.leaseId}/transfers`,intent,[200,201],true,intent.id,v=>this.fileReply<FileTransfer>(v,intent.id))).value;
  }
  async transfer(id:string):Promise<FileTransfer> {
    return (await parsed(this.transport,'GET',`/v1/leases/${this.leaseId}/transfers/${uuid(id,'id')}`,undefined,[200],false,undefined,v=>this.fileReply<FileTransfer>(v,id))).value;
  }
  async createTransferStep(id:string,step:number,request:FileRequest):Promise<FileStep> {
    return (await parsed(this.transport,'POST',`/v1/leases/${this.leaseId}/transfers/${uuid(id,'id')}/steps`,{step,request},[200,202],true,id,v=>this.fileReply<FileStep>(v,id,step))).value;
  }
  async transferStep(id:string,step:number):Promise<FileStep> {
    return (await parsed(this.transport,'GET',`/v1/leases/${this.leaseId}/transfers/${uuid(id,'id')}/steps/${step}`,undefined,[200],false,undefined,v=>this.fileReply<FileStep>(v,id,step))).value;
  }
  private fileReply<T>(v:unknown,id:string,step?:number):T {
    if(!isRecord(v)||v.id!==id||typeof v.state!=='string'||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.updatedAt))||(step!==undefined?v.step!==step:v.leaseId!==this.leaseId)) throw new TypeError('Transfer response');
    return v as T;
  }
  inspect(): Promise<Lease> { return this.inspectById(this.leaseId); }
  renew(request: RenewRequest): Promise<MutationResult> { return this.renewById(this.leaseId, request); }
  release(request: ReleaseRequest): Promise<MutationResult> { return this.releaseById(this.leaseId, request); }
}
