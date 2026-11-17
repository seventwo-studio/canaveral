import { pinnedGuestBindingFactory, type GuestAssignmentContext } from "../guest/binding.ts";
import type { PinnedGuestEndpoint } from "../guest/https.ts";
import type { ExecutionClock } from "../runtime-process.ts";
import type { GuestHelperBinding } from "../control/session-protocol.ts";
import { ServiceError } from "../errors.ts";
export interface OwnedGuestAuthority { authorized(): boolean; clock: ExecutionClock }
export interface AppleBindingEvidence {
  assignment: GuestAssignmentContext; credential: string; identity: string; pinned: PinnedGuestEndpoint;
}
interface Entry { close(): void; promise: Promise<GuestHelperBinding> }
/** Entries are registered before any probe/handshake await. Failed launches stay closed. */
export class AppleBindings {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly dial: (factory: ReturnType<typeof pinnedGuestBindingFactory>, evidence: AppleBindingEvidence, current: () => boolean) => Promise<GuestHelperBinding> =
    (factory, evidence, current) => factory.resolve(() => evidence.assignment, `https://${evidence.pinned.address}:8769`, evidence.credential, current, evidence.pinned, 2)) {}
  resolve(id: string, authority: OwnedGuestAuthority, evidence: () => AppleBindingEvidence, probe: () => Promise<string>): Promise<GuestHelperBinding> {
    if (this.closed) return Promise.reject(new ServiceError("Owned resolver is closed.",410));
    const old = this.entries.get(id); if (old) return old.promise;
    if (!authority.authorized() || !authority.clock.suspendAware || !authority.clock.bootId) return Promise.reject(new ServiceError("Trusted assignment authority and clock are required.",410));
    const factory = pinnedGuestBindingFactory();
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, last = -1, dispatched = -Infinity, processIdentity: string | undefined;
    const boot = authority.clock.bootId;
    const close = () => { alive = false; if (timer) clearTimeout(timer); factory.closeAll(); };
    let initial: AppleBindingEvidence;
    const sample = () => {
      const now = authority.clock.now();
      if (!Number.isFinite(now) || now < 0 || now < last || authority.clock.bootId !== boot) throw new Error("clock");
      last = now; return now;
    };
    const current = (fresh = true): boolean => {
      if (!alive || factory.closed) { close(); return false; }
      try {
        if (this.entries.get(id) !== entry || !authority.authorized() || evidence().identity !== initial.identity || fresh && sample() - dispatched >= 2) throw new Error("ownership");
        return true;
      } catch { close(); return false; }
    };
    const check = (fresh = true) => { if (!current(fresh)) throw new ServiceError("Owned guest binding ended.",410); };
    const refresh = async () => {
      check(processIdentity !== undefined); const start = sample(); let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const identity = await Promise.race([probe(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("probe timeout")),1000); })]);
        check(false); if (sample() - start >= 1 || processIdentity !== undefined && identity !== processIdentity) throw new Error("proof");
        processIdentity = identity; dispatched = start;
      } finally { if (deadline) clearTimeout(deadline); }
    };
    const maintain = () => { timer = setTimeout(() => { void refresh().then(() => { check(); maintain(); }).catch(close); },Math.max(0, 1000 - (sample() - dispatched) * 1000)); timer.unref(); };
    const entry: Entry = { close, promise: undefined! }; this.entries.set(id,entry);
    entry.promise = (async () => {
      try {
        initial = evidence(); check(false); await refresh(); check(); initial = evidence();
        const binding = await this.dial(factory, initial, () => current());
        check(); maintain(); return binding;
      } catch (error) { close(); throw error; }
    })();
    return entry.promise;
  }
  closeMachine(id: string): void { this.entries.get(id)?.close(); }
  sweep(active: Set<string>): void { for (const [id, entry] of this.entries) if (!active.has(id)) { entry.close(); this.entries.delete(id); } }
  close(): void { this.closed = true; this.sweep(new Set()); }
}
