/** Held device leases for the agent surfaces: `canaveral mcp` and `canaveral lease hold`.
 *
 * The consumer SDK never polls, retries or renews. This layer is the explicit owner that does:
 * it submits one durable `kind: "lease"` request per lease under a stable caller UUID, waits for
 * admission and a checked ready device, renews what it holds and releases everything on close.
 * A mutation is only ever replayed with its identical UUID and body; a device operation is never
 * replayed here at all (see agent-device.ts).
 *
 * Limits: one process holds its leases in memory only. If it is killed without a chance to
 * release, a waiting request ends at its deadline and an admitted lease ends at its TTL; neither
 * is recovered by a later process unless the caller passes the same request UUID again.
 * Portable fixtures cover this module against a real loopback controller and a scripted host.
 * It has no native acceptance against a real emulator.
 */
import { randomUUID } from "node:crypto";
import { ConsumerClient, ConsumerConfigurationError, ConsumerError, ConsumerServiceError, LeaseClient, Serial, identifier } from "./sdk.ts";
import type { Catalogue, CatalogueImage, ClientOptions, Lease, WaitingRequest, WaitingRequestInput } from "./sdk.ts";

/** A refusal decided by this layer, before or instead of a controller call. `message` is static text. */
export class AgentError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(message: string, code: string, details: Record<string, unknown> = {}) {
    super(message); this.name = "AgentError"; this.code = code; this.details = details;
  }
}
/** The caller's AbortSignal fired. Waiting intent has been cancelled where that could be confirmed. */
export class Cancelled extends Error {
  constructor() { super("Cancelled."); this.name = "Cancelled"; }
}

export type NoticeLevel = "info" | "notice" | "warning" | "error";
/** Lease-ending and renewal notices. They carry identifiers and states, never credentials. */
export interface SessionNotice { level: NoticeLevel; event: string; message: string; leaseId?: string; [detail: string]: unknown }
export interface LeaseIntent {
  templateId: string; templateRevision?: string; arch?: "arm64" | "amd64";
  ttlSeconds?: number; name?: string; priority?: number;
  /** Bounds waiting for admission only. Default 600 seconds. */
  waitSeconds?: number;
  /** Stable request UUID, which becomes the lease UUID. Generated when absent. An existing own request is adopted. */
  requestId?: string;
  /** Opaque tags stored with the request, for example a CI run. They drive no behavior. */
  source?: Record<string, unknown>;
}
export interface WaitProgress {
  phase: "queued" | "booting" | "ready"; requestId: string; message: string;
  /** Queue position, when the controller's request view carries one. */
  position?: number; reason?: string;
}
export interface LeaseOptions {
  signal?: AbortSignal; progress?: (progress: WaitProgress) => void;
  /** Exchange the application key for this lease's scoped key once the device is ready. Default true. */
  key?: boolean;
}
export interface HeldView {
  leaseId: string; state: string; runtimeState: string; revision: number; createdAt: string; expiresAt: string; ttlSeconds: number;
  template: { id: string; revision: string; arch: string; os: string };
  capabilities: Record<string, boolean>; members: Array<{ name: string; state: string; ready: boolean }>;
  cleanup: string;
  renewal: { automatic: boolean; count: number; lastRenewedAt: string | null; stopped: string | null; lastFailure: string | null };
}
export interface EndedView { leaseId: string; state: string; endedAt: string; expiresAt: string }
export interface SessionOptions extends ClientOptions {
  applicationKey: string;
  notice?: (notice: SessionNotice) => void;
}

interface Held {
  id: string; ttlSeconds: number; template: HeldView["template"]; lease: Lease; device: LeaseClient | undefined; credential: string | undefined;
  /** Lower bound, on this process's monotonic clock, of when the controller ends the lease. */
  expiry: number;
  /** False until `expiry` rests on a monotonic observation instead of this machine's wall clock. */
  anchored: boolean;
  /** Controller time (ms) of the application's maximum lifetime for this lease; Infinity when unknown. */
  lifetimeEnd: number;
  /** Why automatic renewal stopped, if it did: the lease keeps running until `expiresAt`. */
  stopped: string | undefined;
  /** One renewal mutation in flight or unconfirmed; replayed identically until its receipt arrives. */
  renewal: { id: string; expectedRevision: number; sent: number } | undefined;
  renewals: number; renewedAt: string | undefined; failure: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined; serial: Serial; releasing: boolean;
  /** False while the device is still booting for the call that requested it. */
  granted: boolean;
}

const ACTIVE = ["provisioning", "ready"];
const now = (): number => performance.now();
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Cancelled()); return; }
    const stop = () => { clearTimeout(timer); reject(new Cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
/** A read that may simply be repeated: transport loss, 408, 429 or a 5xx reply. */
export function transient(error: unknown): boolean {
  if (!(error instanceof ConsumerError) || error instanceof ConsumerConfigurationError || error.code === "tls_verification_failed") return false;
  return !(error instanceof ConsumerServiceError) || error.status >= 500 || error.status === 408 || error.status === 429;
}
/** Repeats a safe read through a short outage. Structured refusals are returned to the caller at once. */
export async function read<T>(work: () => Promise<T>, signal?: AbortSignal, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) { if (!transient(error) || attempt >= attempts) throw error; await pause(500 * attempt, signal); }
  }
}
/** Sends one idempotent mutation again, byte for byte, while its outcome is unknown. Never changes the UUID or body. */
async function replay<T>(send: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await send(); }
    catch (error) {
      if (!(error instanceof ConsumerError) || error.outcome !== "unknown" || attempt >= attempts) throw error;
      await pause(500 * attempt);
    }
  }
}
function limit(catalogue: Catalogue, key: string): number | undefined {
  const value = catalogue.limits[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
/** Device templates only: this surface submits `kind: "lease"`, never a Linux workspace box. */
export function deviceTemplates(catalogue: Catalogue): CatalogueImage[] {
  return catalogue.templates.filter(image => image.os === "android" || image.os === "ios");
}
function whole(value: unknown, what: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AgentError(`${what} must be an integer from ${minimum} to ${maximum}.`, "invalid_arguments");
  return value;
}

export class LeaseSession {
  readonly client: ConsumerClient;
  readonly #options: ClientOptions;
  readonly #notice: (notice: SessionNotice) => void;
  readonly #held = new Map<string, Held>();
  readonly #ended = new Map<string, EndedView>();
  readonly #waits = new Map<AbortController, { id: string; settled: Promise<unknown> }>();
  #closed = false;
  #closing: Promise<Array<{ leaseId: string; state: string }>> | undefined;

  constructor(options: SessionOptions) {
    const { applicationKey, notice, ...client } = options;
    // Calls are short JSON exchanges; a stalled controller must not stall shutdown for long.
    this.client = new ConsumerClient({ timeoutMs: 15_000, ...client, applicationKey });
    this.#options = client; this.#notice = notice ?? (() => {});
  }

  catalogue(): Promise<Catalogue> { return this.client.catalogue(); }

  /** Submits (or adopts) the durable request, waits for admission and readiness, and starts renewing.
   * Any other exit cancels the request, which also releases a lease admitted meanwhile. */
  async lease(intent: LeaseIntent, options: LeaseOptions = {}): Promise<HeldView> {
    if (this.#closed) throw new AgentError("This session is closing and takes no new leases.", "session_closed");
    const id = intent.requestId === undefined ? randomUUID() : identifier(intent.requestId);
    const existing = this.#held.get(id);
    if (existing?.granted) return this.#view(existing);
    if (existing) throw new AgentError("Another call is still acquiring that lease.", "lease_in_progress", { leaseId: id });
    const abort = new AbortController(), forward = () => abort.abort();
    if (options.signal?.aborted) throw new Cancelled();
    options.signal?.addEventListener("abort", forward, { once: true });
    const work = this.#acquire(id, intent, { ...options, signal: abort.signal });
    this.#waits.set(abort, { id, settled: work.catch(() => {}) });
    try { return await work; }
    finally { this.#waits.delete(abort); options.signal?.removeEventListener("abort", forward); }
  }

  async #acquire(id: string, intent: LeaseIntent, options: LeaseOptions & { signal: AbortSignal }): Promise<HeldView> {
    const signal = options.signal, progress = options.progress ?? (() => {});
    const catalogue = await read(() => this.client.catalogue(), signal);
    const matches = deviceTemplates(catalogue).filter(image => image.id === intent.templateId &&
      (intent.templateRevision === undefined || image.revision === intent.templateRevision) && (intent.arch === undefined || image.arch === intent.arch));
    const candidates = (matches.length ? matches : deviceTemplates(catalogue)).map(image => ({ id: image.id, revision: image.revision, arch: image.arch, os: image.os }));
    if (!matches.length) throw new AgentError("No device template this application may lease matches.", "template_unknown", { available: candidates });
    if (matches.length > 1) throw new AgentError("Several templates match; give the revision and arch.", "template_ambiguous", { candidates });
    const image = matches[0]!, maxTtl = limit(catalogue, "maxTTLSeconds"), defaultTtl = limit(catalogue, "defaultTTLSeconds");
    const ttlSeconds = intent.ttlSeconds ?? defaultTtl;
    if (ttlSeconds === undefined) throw new AgentError("Give a TTL; the application reports no default.", "invalid_arguments");
    whole(ttlSeconds, "The TTL in seconds", 1, maxTtl ?? 2_147_483_647);
    const waitSeconds = whole(intent.waitSeconds ?? 600, "The wait in seconds", 1, 86_400);
    if (intent.priority !== undefined) whole(intent.priority, "Priority", -1_000_000, 1_000_000);
    const template = { id: image.id, revision: image.revision, arch: image.arch, os: image.os };
    // False while a cancellation is still owed: it withdraws waiting intent and releases a lease admitted meanwhile.
    let settled = false, held: Held | undefined;
    try {
      // `anchor` is when the last call whose reply did not yet show an admitted lease was sent. The lease is
      // created after it, so `anchor + (expiresAt - createdAt)` never overstates the lease's life on this clock.
      let anchor = now(), anchored = true, request: WaitingRequest | undefined;
      if (intent.requestId !== undefined) {
        try { request = await read(() => this.client.inspectRequest(id), signal); anchored = request.state === "waiting"; }
        catch (error) { if (!(error instanceof ConsumerServiceError) || error.status !== 404) throw error; }
      }
      if (request === undefined) {
        const source = intent.source ?? {};
        const envelope: WaitingRequestInput = { id, kind: "lease",
          intent: { templateId: image.id, templateRevision: image.revision, arch: image.arch, ttlSeconds, ...(intent.name === undefined ? {} : { name: intent.name }) },
          // The deadline also ends the wait when this process dies. It is set on the controller's clock from this one.
          deadline: new Date(Date.now() + waitSeconds * 1000).toISOString(),
          ...(intent.priority === undefined ? {} : { priority: intent.priority }), ...(Object.keys(source).length ? { source } : {}) };
        anchor = now();
        request = (await replay(() => this.client.submitRequest(envelope))).request;
      }
      if (request.kind !== "lease") { settled = true; throw new AgentError("That request UUID belongs to another kind of request.", "request_conflict"); }
      const waitUntil = now() + waitSeconds * 1000 + 5000;
      for (let polls = 0; request.state === "waiting"; polls++) {
        // The queue position is optional: older controllers' request views carry none.
        const reported = (request as unknown as { position?: unknown }).position;
        const position = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0 ? reported : undefined;
        progress({ phase: "queued", requestId: id, ...(position === undefined ? {} : { position }), ...(request.reason ? { reason: request.reason } : {}),
          message: "Waiting for a free device" + (position === undefined ? "" : ` (queue position ${position})`) + (request.reason ? `: ${request.reason}` : "") + "." });
        // The controller expires the request at its deadline; this bound only covers a controller clock far ahead of ours.
        if (now() > waitUntil) throw new AgentError("No device became free before the wait deadline. Nothing was leased.", "wait_deadline", { requestId: id, reason: request.reason });
        await pause(polls < 20 ? 500 : polls < 80 ? 1000 : 2000, signal);
        const asked = now();
        request = await read(() => this.client.inspectRequest(id), signal);
        if (request.state === "waiting") anchor = asked;
      }
      if (request.state !== "admitted") {
        settled = true;
        const text = request.state === "expired" ? "No device became free before the wait deadline. Nothing was leased."
          : request.state === "cancelled" ? "The request was cancelled. Nothing was leased." : "The controller rejected the request. Nothing was leased.";
        throw new AgentError(text, request.state === "expired" ? "wait_deadline" : `request_${request.state}`, { requestId: id, reason: request.reason });
      }
      const lease = await read(() => this.client.inspectLease(id), signal);
      // An adopted request whose lease is already over: nothing to hold and nothing to cancel.
      if (!ACTIVE.includes(lease.state)) { settled = true; throw new AgentError(`That lease has already ended (${lease.state}).`, "lease_ended", { leaseId: id, state: lease.state }); }
      const created = Date.parse(lease.createdAt), expires = Date.parse(lease.expiresAt), lifetime = limit(catalogue, "maxLifetimeSeconds");
      const admitted: Held = held = { id, ttlSeconds, template, lease, device: undefined, credential: undefined,
        // An adopted request was admitted at an unknown earlier time: use the wall clock until the first renewal.
        expiry: anchored ? anchor + (expires - created) : now() + Math.min(expires - Date.now(), expires - created), anchored,
        lifetimeEnd: lifetime === undefined ? Infinity : created + lifetime * 1000, stopped: undefined, renewal: undefined,
        renewals: 0, renewedAt: undefined, failure: undefined, timer: undefined, serial: new Serial(), releasing: false, granted: false };
      // The TTL runs from admission, through the boot. Hold and renew from now so a slow boot cannot outlast it.
      this.#held.set(id, admitted); this.#ended.delete(id); this.#schedule(admitted);
      const bootUntil = now() + ((limit(catalogue, "provisioningTimeoutSeconds") ?? 3600) + 60) * 1000;
      for (let polls = 0; admitted.lease.state === "provisioning" && this.#held.has(id); polls++) {
        progress({ phase: "booting", requestId: id, message: `Admitted; the device is booting and being checked (${admitted.lease.runtimeState}).` });
        if (now() > bootUntil) throw new AgentError("The device did not become ready in time.", "provisioning_timeout", { leaseId: id });
        await pause(polls < 20 ? 500 : 1000, signal);
        await admitted.serial.run(async () => { if (this.#held.has(id)) this.#adopt(admitted, await read(() => this.client.inspectLease(id), signal)); });
      }
      if (admitted.lease.state !== "ready" || !this.#held.has(id)) throw new AgentError(`The lease ended (${admitted.lease.state}) before its device was ready.`, "lease_ended", { leaseId: id, state: admitted.lease.state });
      if (options.key !== false) await this.#exchange(admitted);
      if (signal.aborted) throw new Cancelled();
      if (this.#closed) throw new AgentError("This session is closing and takes no new leases.", "session_closed");
      settled = admitted.granted = true;
      progress({ phase: "ready", requestId: id, message: "The device is ready." });
      return this.#view(admitted);
    } finally {
      if (!settled) {
        if (held) { held.releasing = true; clearTimeout(held.timer); this.#held.delete(id); }
        await replay(() => this.client.cancelRequest(id)).catch(() => {});
      }
    }
  }

  /** A deliberate owner-side exchange. It is not idempotent: every success revokes the previous key of
   * this lease. For a request this session submitted no earlier key exists; adopting a request
   * takes the lease over from whoever held a key before. */
  async #exchange(held: Held): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const { credential } = await this.client.rotateLeaseCredential(held.id);
        held.credential = credential; held.device = new LeaseClient({ ...this.#options, leaseId: held.id, leaseKey: credential });
        return;
      } catch (error) {
        if (!(error instanceof ConsumerError) || error.outcome !== "unknown" || attempt >= 3) throw error;
        await pause(500 * attempt);
      }
    }
  }

  #schedule(held: Held, delay?: number): void {
    if (this.#closed || held.releasing || !this.#held.has(held.id)) return;
    clearTimeout(held.timer);
    const ttl = held.ttlSeconds * 1000, watch = Math.min(30_000, Math.max(2000, ttl / 6));
    // Renew when about a third of the TTL remains (docs/mobile-control.md, "Renew early"); look in on the lease more often.
    const due = held.stopped !== undefined ? Infinity : !held.anchored ? 0 : held.expiry - ttl / 3 - now();
    held.timer = setTimeout(() => { void held.serial.run(() => this.#tick(held)).catch(() => {}); }, delay ?? Math.max(0, Math.min(watch, due)));
  }

  async #tick(held: Held): Promise<void> {
    if (this.#closed || held.releasing || !this.#held.has(held.id)) return;
    let delay: number | undefined;
    try {
      if (held.stopped !== undefined || (held.anchored && held.expiry - now() > held.ttlSeconds * 1000 / 3)) this.#adopt(held, await this.client.inspectLease(held.id));
      else await this.#renew(held);
      held.failure = undefined;
    } catch (error) { delay = await this.#failed(held, error); }
    this.#schedule(held, delay);
  }

  /** Takes the controller's current view. An expiry moved by anyone moves the local bound by the same amount. */
  #adopt(held: Held, view: Lease): void {
    const extension = Date.parse(view.expiresAt) - Date.parse(held.lease.expiresAt);
    if (Number.isFinite(extension) && extension > 0) held.expiry += extension;
    held.lease = view;
    if (!ACTIVE.includes(view.state)) this.#end(held, view.state);
  }

  async #renew(held: Held): Promise<void> {
    const pending = held.renewal ??= { id: randomUUID(), expectedRevision: held.lease.revision, sent: now() };
    const result = await this.client.renewLease(held.id, { id: pending.id, expectedRevision: pending.expectedRevision, ttlSeconds: held.ttlSeconds });
    held.renewal = undefined;
    this.#adopt(held, result.lease);
    if (!this.#held.has(held.id)) return;
    held.renewals++; held.renewedAt = new Date().toISOString();
    if (Date.parse(result.mutation.expiresAt) >= held.lifetimeEnd - 50) {
      // The controller capped this renewal at the application's maximum lifetime; another one cannot extend it.
      held.stopped = "maximum_lifetime";
      this.#notice({ level: "warning", event: "lease_lifetime_reached", leaseId: held.id, expiresAt: held.lease.expiresAt,
        message: `Lease ${held.id} reached the application's maximum lifetime. It ends at ${held.lease.expiresAt} and cannot be renewed; finish or lease again.` });
    } else {
      // The controller set expiry to its own now + TTL, and its now was not before this renewal was first sent.
      held.expiry = Math.max(held.expiry, pending.sent + held.ttlSeconds * 1000); held.anchored = true;
    }
  }

  async #failed(held: Held, error: unknown): Promise<number | undefined> {
    const refusal = error instanceof ConsumerServiceError && error.outcome === undefined && !transient(error) ? error : undefined;
    if (refusal && (refusal.status === 404 || refusal.status === 410)) { this.#end(held, "ended"); return undefined; }
    if (refusal && (refusal.status === 401 || refusal.status === 403)) {
      this.#notice({ level: "error", event: "credential_refused", leaseId: held.id, message: "The controller refused the application credential. Held leases can no longer be renewed or released from this session." });
      this.#end(held, "unauthorized"); return undefined;
    }
    if (refusal && held.renewal) {
      held.renewal = undefined;
      if (refusal.status === 409) {
        // The revision moved or the lease ended. Look, then renew against the current revision.
        try { this.#adopt(held, await this.client.inspectLease(held.id)); } catch { /* The next look decides. */ }
        return 250;
      }
      held.stopped = refusal.code;
      this.#notice({ level: "error", event: "lease_renewal_refused", leaseId: held.id, code: refusal.code, expiresAt: held.lease.expiresAt,
        message: `The controller refused to renew lease ${held.id} (${refusal.code}). It ends at ${held.lease.expiresAt}.` });
      return undefined;
    }
    const remaining = Math.max(0, held.expiry - now()), code = error instanceof ConsumerError ? error.code : "internal_error";
    // A look that failed is simply repeated.
    if (!held.renewal) { held.failure = code; return 2000; }
    // Unconfirmed: keep the pending renewal so the next attempt replays the identical mutation.
    if (held.failure === undefined) this.#notice({ level: "warning", event: "lease_renewal_unconfirmed", leaseId: held.id, code, remainingSeconds: Math.floor(remaining / 1000),
      message: `Renewal of lease ${held.id} is unconfirmed (${code}); retrying. About ${Math.floor(remaining / 1000)} s remain.` });
    held.failure = code;
    return Math.max(250, Math.min(5000, remaining / 8));
  }

  #end(held: Held, state: string): void {
    clearTimeout(held.timer);
    if (!this.#held.delete(held.id)) return;
    this.#ended.set(held.id, { leaseId: held.id, state, endedAt: new Date().toISOString(), expiresAt: held.lease.expiresAt });
    for (const key of [...this.#ended.keys()].slice(0, Math.max(0, this.#ended.size - 50))) this.#ended.delete(key);
    const expected = held.releasing && state === "released";
    this.#notice({ level: expected ? "info" : "warning", event: "lease_ended", leaseId: held.id, state,
      message: expected ? `Lease ${held.id} was released.` : `Lease ${held.id} ended (${state}). Its device is no longer yours; do not send it further actions.` });
  }

  #view(held: Held): HeldView {
    const lease = held.lease;
    return { leaseId: held.id, state: lease.state, runtimeState: lease.runtimeState, revision: lease.revision, createdAt: lease.createdAt, expiresAt: lease.expiresAt,
      ttlSeconds: held.ttlSeconds, template: held.template,
      capabilities: Object.fromEntries(Object.entries(lease.capabilities).map(([key, value]) => [key, value === true])),
      members: lease.members.map(member => ({ name: String(member.name), state: String(member.state), ready: member.ready === true })),
      cleanup: lease.cleanup.state,
      renewal: { automatic: held.stopped === undefined && !held.releasing, count: held.renewals, lastRenewedAt: held.renewedAt ?? null, stopped: held.stopped ?? null, lastFailure: held.failure ?? null } };
  }

  #require(id: string | undefined): Held {
    if (id === undefined) {
      if (this.#held.size === 1) return [...this.#held.values()][0]!;
      throw new AgentError(this.#held.size ? "This session holds several leases; name one." : "This session holds no lease. Lease a device first.", this.#held.size ? "lease_ambiguous" : "lease_not_held", { held: [...this.#held.keys()] });
    }
    const held = this.#held.get(identifier(id));
    if (held) return held;
    const ended = this.#ended.get(identifier(id));
    throw new AgentError(ended ? `That lease ended (${ended.state}). Its device is no longer yours.` : "This session does not hold that lease. Never act on a device you do not hold.", ended ? "lease_ended" : "lease_not_held", ended ? { ...ended } : {});
  }

  /** The lease-key client of a held lease. The key itself stays inside this process. */
  device(id?: string): { leaseId: string; client: LeaseClient; capabilities: Record<string, boolean> } {
    const held = this.#require(id);
    if (!held.granted) throw new AgentError("That lease's device is still booting.", "lease_in_progress", { leaseId: held.id });
    if (!held.device) throw new AgentError("This session holds no key for that lease.", "lease_key_missing");
    return { leaseId: held.id, client: held.device, capabilities: this.#view(held).capabilities };
  }
  /** The scoped key, for the one caller that writes it to a private file (`lease hold --lease-key-file`). */
  credential(id: string): string {
    const value = this.#require(id).credential;
    if (value === undefined) throw new AgentError("This session holds no key for that lease.", "lease_key_missing");
    return value;
  }

  /** Current controller view of one held lease, or of all of them. */
  async status(id?: string): Promise<{ held: HeldView[]; waiting: string[]; ended: EndedView[] }> {
    // A request this session is still waiting on is neither held nor foreign.
    if (id !== undefined && !this.#held.has(identifier(id)) && [...this.#waits.values()].some(wait => wait.id === identifier(id))) return { held: [], waiting: [identifier(id)], ended: [] };
    const targets = id === undefined ? [...this.#held.values()] : [this.#require(id)];
    await Promise.all(targets.map(held => held.serial.run(async () => {
      if (this.#held.has(held.id)) this.#adopt(held, await read(() => this.client.inspectLease(held.id)));
    })));
    const requested = id === undefined ? undefined : identifier(id);
    return { held: targets.filter(held => this.#held.has(held.id)).map(held => this.#view(held)),
      waiting: requested === undefined ? [...this.#waits.values()].map(wait => wait.id).filter(wait => !this.#held.has(wait)) : [],
      ended: [...this.#ended.values()].filter(ended => requested === undefined || ended.leaseId === requested) };
  }
  /** A device answered that the lease is over: take the controller's view now instead of at the next look. */
  async observe(id: string): Promise<void> {
    const held = this.#held.get(id);
    if (held) await held.serial.run(async () => { if (this.#held.has(id)) this.#adopt(held, await this.client.inspectLease(id)); }).catch(() => {});
  }

  /** Releases through the durable request, which is idempotent and needs no further UUID. Renewal stops
   * first and stays stopped even if the release cannot be confirmed, so the lease then ends at its TTL. */
  async release(id?: string): Promise<{ leaseId: string; state: string; cleanup: string }> {
    const held = this.#require(id);
    held.releasing = true; clearTimeout(held.timer);
    return held.serial.run(async () => {
      await replay(() => this.client.cancelRequest(held.id));
      const view = await read(() => this.client.inspectLease(held.id));
      held.lease = view;
      if (ACTIVE.includes(view.state)) throw new AgentError("The controller still reports the lease as active after the release.", "release_unconfirmed", { leaseId: held.id, state: view.state });
      this.#end(held, view.state);
      return { leaseId: held.id, state: view.state, cleanup: view.cleanup.state };
    });
  }

  /** Cancels every wait and releases every held lease. Safe to call more than once. */
  close(): Promise<Array<{ leaseId: string; state: string }>> {
    return this.#closing ??= (async () => {
      this.#closed = true;
      for (const abort of this.#waits.keys()) abort.abort();
      await Promise.all([...this.#waits.values()].map(wait => wait.settled));
      return Promise.all([...this.#held.values()].map(held => this.release(held.id)
        .then(result => ({ leaseId: result.leaseId, state: result.state }), () => ({ leaseId: held.id, state: "release_unconfirmed" }))));
    })();
  }

  /** Stops renewing without releasing: the leases live on until their TTL or an explicit release elsewhere. */
  detach(): string[] {
    this.#closed = true;
    for (const held of this.#held.values()) clearTimeout(held.timer);
    return [...this.#held.keys()];
  }
}
