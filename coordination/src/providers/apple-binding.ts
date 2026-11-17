import { pinnedGuestBindingFactory, type GuestAssignmentContext } from "../guest/binding.ts";
import type { PinnedGuestEndpoint } from "../guest/https.ts";
import type { ExecutionClock } from "../runtime-process.ts";
import type { GuestHelperBinding } from "../control/session-protocol.ts";
import { GuestUnavailableError, ServiceError } from "../errors.ts";
export interface OwnedGuestAuthority { authorized(): boolean; clock: ExecutionClock }
export interface AppleBindingEvidence {
  assignment: GuestAssignmentContext; credential: string; identity: string; pinned: PinnedGuestEndpoint;
}
interface Entry { identity: string; current(): boolean; close(recoverable?: boolean): void; promise: Promise<GuestHelperBinding> }
const unavailable = () => new GuestUnavailableError("Owned guest proof is temporarily unavailable.", 503, { retryable: false });
const redacted = (error: unknown): ServiceError => error instanceof ServiceError ? error : new ServiceError("Owned guest binding could not be verified.", 409, { retryable: false });
/** Swift's heartbeat is fresh for under eight seconds; suspend age is checked separately. */
export function requireRunningAppleStatus(status: Record<string, unknown>, wall: number): void {
  const updated = status.updatedAt;
  const age = typeof updated === "number" ? wall - (updated + 978307200) : Infinity;
  if (!Number.isFinite(wall) || typeof updated !== "number" || !Number.isFinite(updated) || age < -5 || age >= 8 ||
      status.phase !== "Running" || status.runnerProtocol !== 1 || status.runtimeState !== 1) throw new GuestUnavailableError("Native running status is not fresh.",503,{retryable:false});
}
/** Transient loss closes this generation; only a later explicit call may resolve anew. */
export class AppleBindings {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly dial: (factory: ReturnType<typeof pinnedGuestBindingFactory>, evidence: AppleBindingEvidence, current: () => boolean, endpoint: string) => Promise<GuestHelperBinding> =
    (factory, evidence, current, endpoint) => factory.resolve(() => evidence.assignment, endpoint, evidence.credential, current, evidence.pinned, 2)) {}
  resolve(id: string, authority: OwnedGuestAuthority, evidence: () => AppleBindingEvidence, probe: () => Promise<string>): Promise<GuestHelperBinding> {
    if (this.closed) return Promise.reject(new ServiceError("Owned resolver is closed.",410));
    const old = this.entries.get(id);
    let initial: AppleBindingEvidence;
    try {
      if (!authority.authorized() || !authority.clock.suspendAware || !authority.clock.bootId) throw new ServiceError("Trusted assignment authority and clock are required.",410);
      initial = evidence();
    } catch (error) { old?.close(error instanceof GuestUnavailableError); return Promise.reject(redacted(error)); }
    if (old) {
      if (old.identity !== initial.identity) { old.close(); return Promise.reject(new ServiceError("Owned guest custody changed.",410)); }
      old.current();
      // This resolve is a new explicit call. Only a transiently evicted entry
      // may be replaced here; its already dispatched operation is never retried.
      if (this.entries.get(id) === old) return old.promise;
    }
    const factory = pinnedGuestBindingFactory();
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, last = -1, dispatched = -Infinity, processIdentity: string | undefined;
    const boot = authority.clock.bootId;
    const close = (recoverable = false) => {
      if (!alive) return;
      const retry = recoverable && (!factory.closed || factory.recoverable);
      alive = false; if (timer) clearTimeout(timer); factory.closeAll();
      if (retry && this.entries.get(id) === entry) this.entries.delete(id);
    };
    const sample = () => {
      const now = authority.clock.now();
      if (!Number.isFinite(now) || now < 0 || now < last || authority.clock.bootId !== boot) throw new Error("clock");
      last = now; return now;
    };
    const current = (fresh = true): boolean => {
      if (!alive) return false;
      try {
        if (this.entries.get(id) !== entry || !authority.authorized()) throw new ServiceError("Owned guest authority ended.",410);
        const now = sample();
        if (evidence().identity !== initial.identity) throw new ServiceError("Owned guest custody changed.",410);
        if (factory.closed) { close(factory.recoverable); return false; }
        if (fresh && now - dispatched >= 2) throw unavailable();
        return true;
      } catch (error) { close(error instanceof GuestUnavailableError); return false; }
    };
    const check = (fresh = true) => { if (!current(fresh)) throw new ServiceError("Owned guest binding ended.",410); };
    const refresh = async () => {
      check(processIdentity !== undefined); const start = sample(); let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const identity = await Promise.race([probe(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(unavailable()),1000); })]);
        check(false);
        if (sample() - start >= 1) throw unavailable();
        if (processIdentity !== undefined && identity !== processIdentity) throw new ServiceError("Owned guest process proof changed.",410);
        processIdentity = identity; dispatched = start;
      } finally { if (deadline) clearTimeout(deadline); }
    };
    const maintain = () => { if (!alive) return; timer = setTimeout(() => { void refresh().then(() => { check(); maintain(); }).catch(error => close(error instanceof GuestUnavailableError)); },Math.max(0, 1000 - (sample() - dispatched) * 1000)); timer.unref(); };
    const entry: Entry = { identity: initial.identity, current: () => current(processIdentity !== undefined), close, promise: undefined! }; this.entries.set(id,entry);
    entry.promise = (async () => {
      try {
        check(false); await refresh(); check(); initial = evidence(); maintain();
        const binding = await this.dial(factory, initial, () => current(), `https://${initial.pinned.address}:8767`);
        check(); return binding;
      } catch (error) { close(error instanceof GuestUnavailableError); throw redacted(error); }
    })();
    return entry.promise;
  }
  closeMachine(id: string): void { this.entries.get(id)?.close(); }
  sweep(active: Set<string>): void { for (const [id, entry] of this.entries) if (!active.has(id)) { entry.close(); this.entries.delete(id); } }
  close(): void { this.closed = true; this.sweep(new Set()); }
}
