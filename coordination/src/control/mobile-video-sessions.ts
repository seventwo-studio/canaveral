import { requireHostAdmission } from "./maintenance.ts";
/** Native-video admission. Owners and administrators record a machine through
 * `/v1/machines/{machine}/video-sessions`; a lease's current key records its own leased
 * emulator through `/v1/leases/{lease}/video-sessions`. Both share one session table,
 * broker protocol, host reservation, positive-cleanup rule and abandonment. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenHash } from '../accounts.ts';
import { ServiceError, object, secret } from '../errors.ts';
import type { SqliteStore } from '../sqlite.ts';
import { owns, requireScope } from './contracts.ts';
import type { ControlModule, Principal } from './contracts.ts';
import { MachineStore, machineDigest, registerMachineHooks } from './machines.ts';
import { uuid } from './transfers.ts';
import type { SessionSide } from './session-protocol.ts';
import { HELD_VIDEO_SESSION, VIDEO_SESSION_RESERVATION, initializeVideoResolutions, settleLeaseVideoSessions } from './video-cleanup.ts';
import { legacyMachineReady, leaseScopedMember, legacySessionLease, requireApplicationCapacity } from './leases.ts';
export type VideoSessionCommand =
  | { type: 'video-sessions.attach'; sessionId: string; generation: string; side: SessionSide; ownerId: string; token: string }
  | { type: 'video-sessions.authorized'; sessionId: string; generation: string; ready?: boolean }
  | { type: 'video-sessions.disconnect'; sessionId: string; generation: string };
type Row = { id: string; machine: string; host: string; binding: string; generation: string; credential: string; host_credential: string | null; request: string; state: string; created: number; deadline: number; host_attached: number; consumer_attached: number; cleaned: number;
  /** Lease sessions only: the lease and member, and the runner's own encoder-exit receipt. */
  lease: string | null; member: string | null; host_cleaned: number };
const live = ['pending','attaching','ready'];
const reservations = `SELECT COALESCE(SUM(1),0) AS cpu,COALESCE(SUM(256),0) AS memoryMiB,0 AS diskGiB FROM mobile_video_sessions v WHERE v.host=? AND ${HELD_VIDEO_SESSION}`;
const fail = (status = 409): never => { throw new ServiceError('Mobile video session rejected.', status); };
function exact(body: Record<string, unknown>, fields: string[]): void { if (Object.keys(body).length !== fields.length || fields.some(k => !Object.hasOwn(body, k))) fail(400); }
function binding(m: Record<string, unknown>): string { return machineDigest([m.id,m.host,m.owner,m.template,m.request]); }
function row(db: DatabaseSync, id: string): Row { return db.prepare('SELECT * FROM mobile_video_sessions WHERE id=?').get(uuid(id)) as unknown as Row ?? fail(404); }
type Resolution = { session: string; decision: string; reason: string; decided_by: string; created: number };
function resolution(db: DatabaseSync, id: string): Resolution | undefined { return db.prepare('SELECT * FROM mobile_video_session_resolutions WHERE session=?').get(id) as unknown as Resolution | undefined; }
/** Owner-facing view: adds positive cleanup and any administrator abandonment. */
function present(db: DatabaseSync, r: Row) {
  const decision = resolution(db, r.id);
  return { ...view(r), cleaned: r.cleaned === 1, ...(r.lease ? { hostCleaned: r.host_cleaned === 1 } : {}), ...(decision ? { resolution: { decision: decision.decision, reason: decision.reason, decidedBy: JSON.parse(decision.decided_by) as unknown, decided: new Date(decision.created * 1000).toISOString() } } : {}) };
}
function reasonText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new ServiceError('Abandonment requires a reason of at most 1000 characters.', 400);
  return value;
}
function leaseDigest(token: string): string | undefined { try { return machineDigest(secret(token)); } catch { return undefined; } }
function view(r: Row) { return { id: r.id, machineId: r.machine, ...(r.lease ? { leaseId: r.lease, member: r.member } : {}), generation: r.generation, capability: 'video' as const, protocol: 'canaveral-session-v1' as const, state: r.state, ...object(JSON.parse(r.request)), attachBefore: new Date((r.created + 30) * 1000).toISOString(), authorizationDeadline: new Date(r.deadline * 1000).toISOString() }; }

export class MobileVideoSessions implements ControlModule {
  constructor(readonly store: SqliteStore, readonly machines: MachineStore, readonly principalHash: (db: DatabaseSync, hash: string) => Principal) {
    store.transaction(db => { db.exec(`CREATE TABLE IF NOT EXISTS mobile_video_sessions (
      id TEXT PRIMARY KEY,machine TEXT NOT NULL,host TEXT NOT NULL,binding TEXT NOT NULL,generation TEXT NOT NULL,
      credential TEXT NOT NULL,host_credential TEXT,request TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,deadline REAL NOT NULL,
      host_attached INTEGER NOT NULL,consumer_attached INTEGER NOT NULL,cleaned INTEGER NOT NULL);
      UPDATE mobile_video_sessions SET state='disconnected',cleaned=CASE WHEN host_attached=0 THEN 1 ELSE cleaned END WHERE state IN ('pending','attaching','ready');`);
      // Additive lease columns; administrative sessions keep NULL lease and member.
      const columns = (db.prepare('PRAGMA table_info(mobile_video_sessions)').all() as { name: string }[]).map(c => c.name);
      if (!columns.includes('lease')) db.exec('ALTER TABLE mobile_video_sessions ADD COLUMN lease TEXT');
      if (!columns.includes('member')) db.exec('ALTER TABLE mobile_video_sessions ADD COLUMN member TEXT');
      if (!columns.includes('host_cleaned')) db.exec('ALTER TABLE mobile_video_sessions ADD COLUMN host_cleaned INTEGER NOT NULL DEFAULT 0');
      initializeVideoResolutions(db); });
    registerMachineHooks(store, {
      additionalReservationsSql: { id: 'mobile-video-v1', query: reservations },
      additionalReservations: (db, host) => { const r = db.prepare(reservations).get(host)!; return { cpu: Number(r.cpu), memoryMiB: Number(r.memoryMiB) }; },
      heartbeatResponse: (db, host) => {
        this.refresh(db);
        return { videoSessions: (db.prepare(`SELECT * FROM mobile_video_sessions v WHERE v.host=? AND ${HELD_VIDEO_SESSION} ORDER BY created,id LIMIT 4`).all(host) as unknown as Row[]).map(r => ({ ...view(r), hostId: r.host })) };
      },
    });
  }
  private target(db: DatabaseSync, id: string, principal?: Principal): Record<string, unknown> {
    const m = db.prepare('SELECT m.*,h.enabled,h.seen,h.offer AS host_offer,h.credential AS hostCredential FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(uuid(id));
    if (!m || principal && !owns(principal, m.owner)) return fail(404); return m;
  }
  private current(db: DatabaseSync, r: Row): boolean {
    try {
      if (r.lease) return this.leaseCurrent(db, r);
      const principal = this.principalHash(db, r.credential), m = this.target(db, r.machine, principal);
      if (!(principal.kind === 'operator' || principal.user?.role === 'admin' && principal.scopes.includes('admin') || principal.scopes.includes('machines:access'))) return false;
      return binding(m) === r.binding && m.host === r.host && m.enabled === 1 && m.desired === 'running' && m.observed === 'running' && this.store.clock() - Number(m.seen) < 30 && this.store.clock() < r.deadline && (r.state === 'ready' || this.store.clock() < r.created + 30) && (!r.host_credential || r.host_credential === m.hostCredential);
    } catch { return false; }
  }
  /** A lease recording stays authorized only while the lease is ready, unexpired and still holds
   * the key that created it, its application is active and its member is a checked, ready device. */
  private leaseCurrent(db: DatabaseSync, r: Row): boolean {
    const now = this.store.clock(), lease = db.prepare('SELECT l.state,l.expires,l.credential,c.revoked FROM leases l JOIN consumers c ON c.id=l.consumer WHERE l.id=?').get(r.lease!);
    if (!lease || lease.revoked !== 0 || lease.state !== 'ready' || lease.credential !== r.credential || now >= Number(lease.expires)) return false;
    if (!db.prepare('SELECT 1 FROM lease_members WHERE lease=? AND name=? AND machine=?').get(r.lease!, r.member!, r.machine)) return false;
    const m = this.target(db, r.machine);
    return binding(m) === r.binding && m.host === r.host && legacyMachineReady(db, m, now) && now < r.deadline && (r.state === 'ready' || now < r.created + 30) && (!r.host_credential || r.host_credential === m.hostCredential);
  }
  private refresh(db: DatabaseSync): void {
    for (const r of db.prepare("SELECT * FROM mobile_video_sessions WHERE state IN ('pending','attaching','ready')").all() as unknown as Row[]) if (!this.current(db, r)) this.disconnect(db, r);
    settleLeaseVideoSessions(db);
  }
  private disconnect(db: DatabaseSync, r: Row): void { db.prepare("UPDATE mobile_video_sessions SET state='disconnected',cleaned=CASE WHEN host_attached=0 THEN 1 ELSE cleaned END WHERE id=?").run(r.id); }
  /** Administrator decision for a disconnected session whose native cleanup is unknown.
   * It records no cleanup and is not retried by the runner. It permits machine deletion
   * only; the reservation is released when that deletion completes. The same reason
   * repeats safely; a different reason, a live session or positive cleanup conflicts. */
  private abandon(db: DatabaseSync, req: import('./contracts.ts').ControlRequest, principal: Principal, r: Row) {
    requireScope(req, 'admin');
    exact(req.body, ['reason']); const reason = reasonText(req.body.reason);
    const old = resolution(db, r.id);
    if (old) { if (old.reason !== reason) throw new ServiceError('This video session was already abandoned with another reason.', 409); return present(db, r); }
    if (live.includes(r.state)) throw new ServiceError('Close the video session before abandoning its cleanup.', 409);
    if (r.cleaned) throw new ServiceError('This video session already has positive cleanup; no abandonment is needed.', 409);
    // A runner may still be tearing the recorder down until the session deadline; its cleanup
    // receipt must be able to arrive first.
    if (this.store.clock() < r.deadline) throw new ServiceError('Wait until the video session deadline has passed before abandoning its cleanup.', 409, { retryable: true });
    const decidedBy = JSON.stringify({ kind: principal.kind, userId: principal.user?.id ?? null, username: principal.user?.username ?? null });
    db.prepare("INSERT INTO mobile_video_session_resolutions VALUES (?,'abandoned',?,?,?)").run(r.id, reason, decidedBy, this.store.clock());
    return present(db, r);
  }
  command(command: VideoSessionCommand): unknown {
    return this.store.transaction(db => {
      this.refresh(db); const r = row(db, command.sessionId);
      if (r.generation !== uuid(command.generation)) return fail(403);
      if (command.type === 'video-sessions.disconnect') { this.disconnect(db, r); return { disconnected: true }; }
      if (command.type === 'video-sessions.authorized') return { authorized: live.includes(r.state) && this.current(db, r) && (!command.ready || r.state === 'ready') };
      if (!live.includes(r.state) || !this.current(db, r)) return fail(410);
      if (command.side === 'host') {
        if (uuid(command.ownerId) !== r.host) return fail(403);
        this.machines.authenticateHost(r.host, command.token);
        if (r.host_attached) return fail(409);
        db.prepare("UPDATE mobile_video_sessions SET host_attached=1,host_credential=?,state=? WHERE id=?").run(machineDigest(command.token), r.consumer_attached ? 'ready' : 'attaching', r.id);
      } else {
        const owner = r.lease ?? r.machine, digest = r.lease ? leaseDigest(command.token) : tokenHash(command.token);
        if (uuid(command.ownerId) !== owner || digest !== r.credential || r.consumer_attached) return fail(403);
        db.prepare('UPDATE mobile_video_sessions SET consumer_attached=1,state=? WHERE id=?').run(r.host_attached ? 'ready' : 'attaching', r.id);
      }
      return view(row(db, r.id));
    });
  }
  handle(req: import('./contracts.ts').ControlRequest) {
    const p = req.parts;
    const hostFinish = req.method === 'POST' && p.length === 6 && p[0] === 'v1' && p[1] === 'hosts' && p[3] === 'video-sessions' && p[5] === 'finish';
    const machineRoute = p[0] === 'v1' && p[1] === 'machines' && p[3] === 'video-sessions' && (p.length === 4 && req.method === 'POST' || p.length === 5 && req.method === 'GET' || p.length === 6 && (p[5] === 'close' || p[5] === 'abandon') && req.method === 'POST');
    const leaseRoute = p[0] === 'v1' && p[1] === 'leases' && p[3] === 'video-sessions' && (p.length === 4 && req.method === 'POST' || p.length === 5 && req.method === 'GET' || p.length === 6 && p[5] === 'close' && req.method === 'POST');
    if (leaseRoute) { if (req.query.size) return fail(400); return this.leaseRoute(req); }
    if (!hostFinish && !machineRoute) return undefined;
    if (req.query.size) return fail(400);
    return this.store.transaction(db => {
      this.refresh(db);
      if (hostFinish) {
        // `cleaned` is complete positive cleanup. A lease session may instead report `hostCleaned`:
        // the runner's encoder exited but the guest recorder's stop is unproven; the lease's own
        // proven emulator removal then completes its cleanup (video-cleanup.ts).
        const hostOnly = Object.hasOwn(req.body, 'hostCleaned');
        exact(req.body, ['generation', hostOnly ? 'hostCleaned' : 'cleaned']); const r = row(db, p[4]!);
        this.machines.authenticateHost(uuid(p[2]), req.token);
        // Current credentials may acknowledge saved cleanup after rotation; they
        // cannot revive capture or acknowledge another immutable assignment.
        if (r.host !== uuid(p[2]) || r.generation !== uuid(req.body.generation) || !r.host_attached || (hostOnly ? req.body.hostCleaned !== true || !r.lease : req.body.cleaned !== true) || binding(this.target(db, r.machine)) !== r.binding) return fail(403);
        if (hostOnly) { db.prepare("UPDATE mobile_video_sessions SET state=CASE WHEN state IN ('pending','attaching','ready') THEN 'disconnected' ELSE state END,host_cleaned=1 WHERE id=?").run(r.id); settleLeaseVideoSessions(db); }
        else db.prepare("UPDATE mobile_video_sessions SET state='finished',cleaned=1,host_cleaned=1 WHERE id=?").run(r.id);
        return { body: present(db, row(db, r.id)) };
      }
      const principal = requireScope(req, 'access'), m = this.target(db, p[2]!, principal);
      if (p.length !== 4) {
        const r = row(db, p[4]!); if (r.machine !== m.id) return fail(404);
        if (p[5] === 'abandon') return { body: this.abandon(db, req, principal, r) };
        if (p.length === 6) { exact(req.body, []); this.disconnect(db, r); }
        return { body: present(db, row(db, r.id)) };
      }
      exact(req.body, ['id','fps','durationSeconds','bitRate']);
      const id = uuid(req.body.id), request = videoRequest(req.body), hash = tokenHash(req.token);
      const old = db.prepare('SELECT * FROM mobile_video_sessions WHERE id=?').get(id) as unknown as Row | undefined;
      if (old) { if (old.machine !== m.id || old.binding !== binding(m) || old.credential !== hash || old.request !== request) return fail(409); return { body: present(db, old) }; }
      requireHostAdmission(db, String(m.host));
      if (!['android','ios'].includes(String(object(JSON.parse(String(m.template))).os)) || m.enabled !== 1 || m.desired !== 'running' || m.observed !== 'running' || this.store.clock() - Number(m.seen) >= 30) return fail(409);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_members'").get() && db.prepare('SELECT 1 FROM lease_members WHERE machine=?').get(m.id as string)) return fail(409);
      this.admit(db, m);
      this.insert(db, id, m, hash, request, null, null);
      return { status: 201, body: present(db, row(db, id)) };
    });
  }
  /** Host slots and capacity shared by both routes. An abandoned session keeps blocking this
   * machine's capture until positive cleanup. */
  private admit(db: DatabaseSync, m: Record<string, unknown>): void {
    if (db.prepare('SELECT 1 FROM mobile_video_sessions WHERE machine=? AND cleaned=0').get(m.id as string)) fail(409);
    if (Number(db.prepare(`SELECT COUNT(*) AS n FROM mobile_video_sessions v WHERE v.host=? AND ${HELD_VIDEO_SESSION}`).get(m.host as string)!.n) >= 4) fail(429);
    const available = this.machines.remainingCapacity(db, String(m.host));
    if (available.cpu < VIDEO_SESSION_RESERVATION.cpu || available.memoryMiB < VIDEO_SESSION_RESERVATION.memoryMiB) fail(409);
  }
  private insert(db: DatabaseSync, id: string, m: Record<string, unknown>, credential: string, request: string, lease: string | null, member: string | null): void {
    const now = this.store.clock(), durationSeconds = Number(object(JSON.parse(request)).durationSeconds);
    db.prepare(`INSERT INTO mobile_video_sessions (id,machine,host,binding,generation,credential,host_credential,request,state,created,deadline,host_attached,consumer_attached,cleaned,lease,member,host_cleaned)
      VALUES (?,?,?,?,?,?,NULL,?,'pending',?,?,0,0,0,?,?,0)`).run(id, String(m.id), String(m.host), binding(m), randomUUID(), credential, request, now, now + durationSeconds + 60, lease, member);
  }
  /** Lease-key recording of the lease's own member. Only the lease's current key reaches it; a
   * session ends with the lease (expiry, release, fence, failure) or a key rotation. Reading and
   * closing stay available to the current key after the lease ends. */
  private leaseRoute(req: import('./contracts.ts').ControlRequest) {
    const p = req.parts, leaseId = uuid(p[2]);
    return this.store.transaction(db => {
      this.refresh(db);
      const lease = legacySessionLease(db, leaseId, req.token);
      if (p.length !== 4) {
        const r = db.prepare('SELECT * FROM mobile_video_sessions WHERE id=?').get(uuid(p[4])) as unknown as Row | undefined;
        if (!r || r.lease !== lease.id) return fail(404);
        if (p.length === 6) { exact(req.body, []); if (live.includes(r.state)) this.disconnect(db, r); }
        return { body: present(db, row(db, r.id)) };
      }
      exact(req.body, ['id','member','fps','durationSeconds','bitRate']);
      const id = uuid(req.body.id), request = videoRequest(req.body), member = req.body.member;
      const old = db.prepare('SELECT * FROM mobile_video_sessions WHERE id=?').get(id) as unknown as Row | undefined;
      if (old) { if (old.lease !== lease.id) return fail(404); if (old.member !== member || old.credential !== lease.credential || old.request !== request) return fail(409); return { body: present(db, old) }; }
      const { machine } = leaseScopedMember(db, leaseId, req.token, member, 'displayStream', this.store.clock());
      const m = this.target(db, String(machine.id));
      // iOS lease recording stays refused: native iOS recording has no accepted stop and cleanup proof.
      if (String(object(JSON.parse(String(m.template))).os) !== 'android') throw new ServiceError('Lease recording is available for Android emulators only.', 409, { code: 'capability_unsupported' });
      this.admit(db, m);
      requireApplicationCapacity(db, lease.consumer, VIDEO_SESSION_RESERVATION);
      this.insert(db, id, m, lease.credential!, request, lease.id, String(member));
      return { status: 201, body: present(db, row(db, id)) };
    });
  }
}
function videoRequest(body: Record<string, unknown>): string {
  const { fps, durationSeconds, bitRate } = body;
  if (fps !== 30 || typeof durationSeconds !== 'number' || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 180 || typeof bitRate !== 'number' || !Number.isSafeInteger(bitRate) || bitRate < 100000 || bitRate > 20000000) return fail(400);
  return JSON.stringify({ fps, durationSeconds, bitRate });
}
