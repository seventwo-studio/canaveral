/** Live screen views of mobile devices.
 *
 * A view is one viewer's broker session (`canaveral-session-v1`, capability `live`). Views of
 * one device share that device's live capture, a `kind='live'` row of the video session table
 * (mobile-video-sessions.ts), which holds the host slot and reservation and is released on the
 * recording path's cleanup proof. The capture is admitted with its first view and stays
 * authorized only while a view does, so capture runs only while someone watches.
 *
 * Two routes, two authorities, never mixed:
 * - `/v1/leases/{lease}/live-views`: the lease's current key only. The application key, the
 *   operator, account credentials and another lease's key are refused, as for every lease
 *   session. A view ends with its lease, its key or its device.
 * - `/v1/machines/{machine}/live-views`: the owner of an account-owned device, or an
 *   administrator. Leased machines are refused here, so no operator or owner view of a leased
 *   device exists. A view ends when its credential, ownership or device does.
 *
 * A view has a bounded lifetime (`ttlSeconds`, counted from readiness) that the attached viewer
 * renews in-band (`{type:"renew"}`); the broker answers it and the host never sees it. Fixture-covered only: no native run has measured
 * frame rate, latency or decoder compatibility of a live view. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { tokenHash } from '../accounts.ts';
import { ServiceError, object, secret } from '../errors.ts';
import type { SqliteStore } from '../sqlite.ts';
import { LIVE_BIT_RATE, LIVE_EPOCH_SECONDS, LIVE_FPS, LIVE_VIEW_MIN_SECONDS, LIVE_VIEW_SECONDS } from '../mobile-live.ts';
import { owns, requireScope } from './contracts.ts';
import type { ControlModule, ControlRequest, Principal } from './contracts.ts';
import { MachineStore, machineDigest, registerMachineHooks } from './machines.ts';
import { hostAdmissionClosed, requireHostAdmission } from './maintenance.ts';
import { HELD_VIDEO_SESSION } from './video-cleanup.ts';
import { legacyMachineReady, leaseScopedMember, legacySessionLease } from './leases.ts';
import type { MobileVideoSessions, VideoSessionRow } from './mobile-video-sessions.ts';
import { uuid } from './transfers.ts';
import type { SessionSide } from './session-protocol.ts';
import { requireNotPooled } from './pool-ledger.ts';

export type LiveViewCommand =
  | { type: 'live-views.attach'; sessionId: string; generation: string; side: SessionSide; ownerId: string; token: string }
  | { type: 'live-views.authorized'; sessionId: string; generation: string; ready?: boolean }
  | { type: 'live-views.disconnect'; sessionId: string; generation: string }
  | { type: 'live-views.renew'; sessionId: string; generation: string };
type Row = { id: string; capture: string; machine: string; host: string; generation: string; credential: string; lease: string | null; member: string | null;
  state: string; reason: string | null; created: number; deadline: number; host_attached: number; consumer_attached: number; ttl: number; ended: number | null };
const LIVE = ['pending', 'attaching', 'ready'];
const ATTACH_SECONDS = 30;
/** Live views per device, host and creating credential, and rows per device within the
 * retention window, so a create/close loop cannot grow the table. Captures are bounded by the
 * video session limits: one live capture per device and four held video sessions per host. */
export const LIVE_VIEWS_PER_MACHINE = 4, LIVE_VIEWS_PER_HOST = 16, LIVE_VIEWS_PER_CREDENTIAL = 8;
const ROWS_PER_MACHINE = 64, RETAIN_SECONDS = 300;
/** The host enforces a lease deadline and its own assignment slightly before the controller
 * observes the same ending. A view is then first recorded as `disconnected` (its sockets
 * dropped) or, for a lease, by the stopping device or host the runner reported, or by its
 * capture, which the runner stopped at its own deadline. Within this window the controller's
 * later finding replaces such a provisional reason: any cause replaces `disconnected`, and the
 * lease's or its key's own ending replaces a lease's device cause. A capture's ending is
 * replaced only when the evidence ties it to the lease's end (see `fencedCapture`). */
const REFINE_SECONDS = 3;
const PROVISIONAL = ['device_stopped', 'host_unavailable', 'capture_ended'], LEASE_ENDED = ['lease_expired', 'lease_released', 'lease_failed', 'key_rotated', 'application_revoked'];
const CAPTURE_REQUEST = JSON.stringify({ fps: LIVE_FPS, durationSeconds: LIVE_EPOCH_SECONDS, bitRate: LIVE_BIT_RATE });
const fail = (status = 409, code?: string): never => { throw new ServiceError('Live view rejected.', status, code ? { code } : {}); };
function exact(body: Record<string, unknown>, fields: string[], optional: string[] = []): void { if (fields.some(k => !Object.hasOwn(body, k)) || Object.keys(body).some(k => !fields.includes(k) && !optional.includes(k))) fail(400); }
function lifetime(value: unknown): number {
  if (value === undefined) return LIVE_VIEW_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < LIVE_VIEW_MIN_SECONDS || value > LIVE_VIEW_SECONDS) fail(400);
  return value as number;
}
function binding(m: Record<string, unknown>): string { return machineDigest([m.id, m.host, m.owner, m.template, m.request]); }
function iso(seconds: number): string { return new Date(seconds * 1000).toISOString(); }
function leaseDigest(token: string): string | undefined { try { return machineDigest(secret(token)); } catch { return undefined; } }
function view(r: Row) {
  return { id: r.id, machineId: r.machine, ...(r.lease ? { leaseId: r.lease, member: r.member } : {}), captureId: r.capture, generation: r.generation,
    capability: 'live' as const, protocol: 'canaveral-session-v1' as const, state: r.state, ...(r.reason ? { endReason: r.reason } : {}),
    mediaType: 'video/mp4' as const, codec: 'avc1' as const, fps: LIVE_FPS, bitRate: LIVE_BIT_RATE, ttlSeconds: r.ttl,
    attachBefore: iso(r.created + ATTACH_SECONDS), authorizationDeadline: iso(r.deadline) };
}

export class MobileLiveViews implements ControlModule {
  constructor(readonly store: SqliteStore, readonly machines: MachineStore, readonly principalHash: (db: DatabaseSync, hash: string) => Principal, readonly video: MobileVideoSessions) {
    store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS mobile_live_views (
      id TEXT PRIMARY KEY,capture TEXT NOT NULL,machine TEXT NOT NULL,host TEXT NOT NULL,generation TEXT NOT NULL,credential TEXT NOT NULL,
      lease TEXT,member TEXT,state TEXT NOT NULL,reason TEXT,created REAL NOT NULL,deadline REAL NOT NULL,
      host_attached INTEGER NOT NULL,consumer_attached INTEGER NOT NULL,ttl INTEGER NOT NULL,ended REAL);
      CREATE INDEX IF NOT EXISTS mobile_live_views_machine ON mobile_live_views(machine,created);
      CREATE INDEX IF NOT EXISTS mobile_live_views_host ON mobile_live_views(host,state);
      CREATE INDEX IF NOT EXISTS mobile_live_views_capture ON mobile_live_views(capture,state);
      UPDATE mobile_live_views SET state='ended',reason='controller_restarted',ended=created WHERE state IN ('pending','attaching','ready');`));
    // A capture is authorized exactly while one of its views is.
    video.liveAuthority = (db, capture) => { this.refreshViews(db, capture.id); return db.prepare("SELECT 1 FROM mobile_live_views WHERE capture=? AND state IN ('pending','attaching','ready')").get(capture.id) !== undefined; };
    // A recording has priority for a host's capture slots: the views of a capture ended to make
    // room for one are told so.
    video.livePreempted = (db, capture) => { db.prepare("UPDATE mobile_live_views SET state='ended',reason='preempted_by_recording',ended=? WHERE capture=? AND state IN ('pending','attaching','ready')").run(this.store.clock(), capture.id); };
    registerMachineHooks(store, {
      heartbeatResponse: (db, host) => {
        this.refresh(db);
        // An ended view stays readable for a while, so its viewer can learn why it ended.
        db.prepare("DELETE FROM mobile_live_views WHERE state='ended' AND COALESCE(ended,created)<?").run(this.store.clock() - RETAIN_SECONDS);
        const views = db.prepare(`SELECT w.*,c.generation AS capture_generation FROM mobile_live_views w JOIN mobile_video_sessions c ON c.id=w.capture
          WHERE w.host=? AND w.state IN ('pending','attaching','ready') ORDER BY w.created,w.id LIMIT ?`).all(host, LIVE_VIEWS_PER_HOST) as unknown as (Row & { capture_generation: string })[];
        // Held live captures, so the runner can repeat a saved cleanup receipt: the same rule as
        // for recordings, so an abandoned capture of a removed device leaves the runner's queue
        // and no longer keeps it from being idle. Recordings travel in `videoSessions`; a runner
        // that predates live views ignores both fields.
        const captures = db.prepare(`SELECT v.id,v.generation,v.machine,v.state FROM mobile_video_sessions v WHERE v.host=? AND v.kind='live' AND ${HELD_VIDEO_SESSION} ORDER BY v.created,v.id LIMIT 32`).all(host);
        return { liveViews: views.map(r => ({ id: r.id, generation: r.generation, machineId: r.machine, state: r.state, captureId: r.capture, captureGeneration: r.capture_generation, ...(r.lease ? { leaseId: r.lease } : {}) })),
          liveCaptures: captures.map(c => ({ id: c.id, generation: c.generation, machineId: c.machine, state: c.state })) };
      },
    });
  }
  private target(db: DatabaseSync, id: string, principal?: Principal): Record<string, unknown> {
    const m = db.prepare('SELECT m.*,h.enabled,h.seen,h.offer AS host_offer,h.credential AS hostCredential FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(uuid(id));
    if (!m || principal && !owns(principal, m.owner)) return fail(404); return m;
  }
  private leased(db: DatabaseSync, machine: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_members'").get() && !!db.prepare('SELECT 1 FROM lease_members WHERE machine=?').get(machine);
  }
  private row(db: DatabaseSync, id: unknown): Row | undefined { return db.prepare('SELECT * FROM mobile_live_views WHERE id=?').get(uuid(id)) as unknown as Row | undefined; }
  private capture(db: DatabaseSync, id: string): VideoSessionRow | undefined { return db.prepare('SELECT * FROM mobile_video_sessions WHERE id=?').get(id) as unknown as VideoSessionRow | undefined; }
  /** Why the view's authority has ended (its lease and key, or its credential and ownership, and
   * its device), or the device row while it holds. */
  private authority(db: DatabaseSync, r: Row): string | Record<string, unknown> {
    const now = this.store.clock();
    let m: Record<string, unknown>;
    try {
      if (r.lease) {
        // Only the key that created the view, of a ready, unexpired lease of an active application.
        const lease = db.prepare('SELECT l.state,l.expires,l.credential,c.revoked FROM leases l JOIN consumers c ON c.id=l.consumer WHERE l.id=?').get(r.lease);
        if (!lease || lease.revoked !== 0) return 'application_revoked';
        if (lease.state === 'released') return 'lease_released';
        if (lease.state === 'failed') return 'lease_failed';
        if (lease.state !== 'ready' || now >= Number(lease.expires)) return 'lease_expired';
        if (lease.credential !== r.credential) return 'key_rotated';
        if (!db.prepare('SELECT 1 FROM lease_members WHERE lease=? AND name=? AND machine=?').get(r.lease, r.member!, r.machine)) return 'device_stopped';
        m = this.target(db, r.machine);
        if (m.desired !== 'running' || m.observed !== 'running') return 'device_stopped';
        if (!legacyMachineReady(db, m, now)) return 'host_unavailable';
      } else {
        // The creating credential must still hold machine access to this unleased device.
        let principal: Principal;
        try { principal = this.principalHash(db, r.credential); } catch { return 'access_revoked'; }
        if (!(principal.kind === 'operator' || principal.user?.role === 'admin' && principal.scopes.includes('admin') || principal.scopes.includes('machines:access'))) return 'access_revoked';
        const found = db.prepare('SELECT m.*,h.enabled,h.seen,h.credential AS hostCredential FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(r.machine);
        if (!found) return 'device_stopped';
        if (!owns(principal, found.owner) || this.leased(db, r.machine)) return 'access_revoked';
        m = found;
        if (m.desired !== 'running' || m.observed !== 'running') return 'device_stopped';
        if (m.enabled !== 1 || now - Number(m.seen) >= 30) return 'host_unavailable';
      }
    } catch { return 'device_stopped'; }
    return m;
  }
  /** Why this view may no longer continue, or undefined while it may. Evaluated on every relayed
   * message and by the broker's 250 ms monitor, so a view ends with its authority. */
  private lapse(db: DatabaseSync, r: Row): string | undefined {
    const now = this.store.clock(), capture = this.capture(db, r.capture), m = this.authority(db, r);
    if (typeof m === 'string') return m;
    if (!capture || !LIVE.includes(capture.state)) return 'capture_ended';
    if (binding(m) !== capture.binding || m.host !== r.host || capture.host_credential && capture.host_credential !== m.hostCredential) return 'host_unavailable';
    if (r.state !== 'ready' && now >= r.created + ATTACH_SECONDS) return 'attach_timeout';
    if (now >= r.deadline) return 'view_expired';
    return undefined;
  }
  private end(db: DatabaseSync, r: Row, reason: string): void { db.prepare("UPDATE mobile_live_views SET state='ended',reason=?,ended=? WHERE id=? AND state IN ('pending','attaching','ready')").run(reason, this.store.clock(), r.id); }
  private refreshViews(db: DatabaseSync, capture?: string): void {
    const rows = (capture ? db.prepare("SELECT * FROM mobile_live_views WHERE capture=? AND state IN ('pending','attaching','ready')").all(capture)
      : db.prepare("SELECT * FROM mobile_live_views WHERE state IN ('pending','attaching','ready')").all()) as unknown as Row[];
    for (const r of rows) { const reason = this.lapse(db, r); if (reason) this.end(db, r, reason); }
    if (capture) return;
    for (const r of db.prepare(`SELECT * FROM mobile_live_views WHERE state='ended' AND ended>=? AND (reason='disconnected' OR lease IS NOT NULL AND reason IN (${PROVISIONAL.map(() => '?').join(',')}))`).all(this.store.clock() - REFINE_SECONDS, ...PROVISIONAL) as unknown as Row[]) {
      const reason = this.authority(db, r);
      if (typeof reason === 'string' && reason !== r.reason && (r.reason === 'disconnected' || LEASE_ENDED.includes(reason)) && (r.reason !== 'capture_ended' || this.fencedCapture(db, r, reason))) db.prepare('UPDATE mobile_live_views SET reason=? WHERE id=? AND reason=?').run(reason, r.id, r.reason);
    }
  }
  /** Whether a view's `capture_ended` was the runner's fence of this same lease ending, so the
   * lease's own reason may replace it. The fenced runner cannot prove the guest recorder stopped,
   * so its receipt for the view's capture is the host-only one, and a fence comes only at the
   * lease's expiry (the runner's native deadline, so the capture ended within the window before
   * it) or its failure. A release or key rotation is recorded here before any runner acts on it:
   * a capture that ended before one of those ended for its own reason, and keeps it. */
  private fencedCapture(db: DatabaseSync, r: Row, reason: string): boolean {
    const capture = this.capture(db, r.capture);
    if (!capture || !r.lease || capture.lease !== r.lease || capture.host_cleaned !== 1 || capture.state === 'finished' || r.ended === null) return false;
    if (reason === 'lease_failed') return true;
    if (reason !== 'lease_expired') return false;
    const lease = db.prepare('SELECT expires FROM leases WHERE id=?').get(r.lease);
    return !!lease && r.ended >= Number(lease.expires) - REFINE_SECONDS && r.ended <= Number(lease.expires);
  }
  /** Ends lapsed views, then the captures left without one, and settles proven cleanup. */
  private refresh(db: DatabaseSync): void { this.refreshViews(db); this.video.refresh(db); }
  command(command: LiveViewCommand): unknown {
    return this.store.transaction(db => {
      // The broker asks once per relayed message: check only this view, and record a lapse.
      const r = this.row(db, command.sessionId) ?? fail(404);
      if (r.generation !== uuid(command.generation)) return fail(403);
      if (command.type === 'live-views.disconnect') {
        // Prefer the controller's own finding over the bare fact that a socket dropped.
        if (LIVE.includes(r.state)) { const cause = this.authority(db, r); this.end(db, r, typeof cause === 'string' ? cause : 'disconnected'); this.video.refresh(db); }
        return { disconnected: true };
      }
      const reason = LIVE.includes(r.state) ? this.lapse(db, r) : 'ended';
      if (reason && LIVE.includes(r.state)) { this.end(db, r, reason); this.video.refresh(db); }
      if (command.type === 'live-views.authorized') return { authorized: !reason && (!command.ready || r.state === 'ready') };
      if (command.type === 'live-views.renew') {
        // Only an attached viewer renews, and a draining host takes no renewal, so a drain is
        // bounded by the view lifetime. Renewal never extends a lease or any other authority.
        const now = this.store.clock(), deadline = now + r.ttl;
        const renewed = !reason && r.state === 'ready' && !hostAdmissionClosed(db, r.host).closed;
        if (renewed && deadline - r.deadline >= 1) {
          db.prepare('UPDATE mobile_live_views SET deadline=? WHERE id=?').run(deadline, r.id);
          db.prepare('UPDATE mobile_video_sessions SET deadline=MAX(deadline,?) WHERE id=?').run(deadline + 60, r.capture);
        }
        return { renewed, authorizationDeadline: iso(renewed ? Math.max(deadline, r.deadline) : r.deadline) };
      }
      if (reason) return fail(410);
      if (command.side === 'host') {
        if (uuid(command.ownerId) !== r.host) return fail(403);
        this.machines.authenticateHost(r.host, command.token);
        if (r.host_attached) return fail(409);
        db.prepare('UPDATE mobile_live_views SET host_attached=1,state=? WHERE id=?').run(r.consumer_attached ? 'ready' : 'attaching', r.id);
        if (r.consumer_attached) this.started(db, r);
        // The runner starts native capture only after a view's host peer was accepted here, so a
        // capture whose host never attached has nothing to clean up.
        db.prepare("UPDATE mobile_video_sessions SET host_attached=1,host_credential=COALESCE(host_credential,?),state='ready' WHERE id=?").run(machineDigest(command.token), r.capture);
      } else {
        const owner = r.lease ?? r.machine, digest = r.lease ? leaseDigest(command.token) : tokenHash(command.token);
        if (uuid(command.ownerId) !== owner || digest !== r.credential || r.consumer_attached) return fail(403);
        db.prepare('UPDATE mobile_live_views SET consumer_attached=1,state=? WHERE id=?').run(r.host_attached ? 'ready' : 'attaching', r.id);
        if (r.host_attached) this.started(db, r);
      }
      return view(this.row(db, r.id)!);
    });
  }
  /** The lifetime runs from readiness, so a slow attachment does not consume it. */
  private started(db: DatabaseSync, r: Row): void {
    const deadline = this.store.clock() + r.ttl;
    db.prepare('UPDATE mobile_live_views SET deadline=? WHERE id=?').run(deadline, r.id);
    db.prepare('UPDATE mobile_video_sessions SET deadline=MAX(deadline,?) WHERE id=?').run(deadline + 60, r.capture);
  }
  private limits(db: DatabaseSync, m: Record<string, unknown>, credential: string): void {
    const live = (column: string, value: unknown) => Number(db.prepare(`SELECT COUNT(*) AS n FROM mobile_live_views WHERE ${column}=? AND state IN ('pending','attaching','ready')`).get(value as string)!.n);
    const recent = Number(db.prepare('SELECT COUNT(*) AS n FROM mobile_live_views WHERE machine=? AND created>=?').get(String(m.id), this.store.clock() - RETAIN_SECONDS)!.n);
    if (live('machine', m.id) >= LIVE_VIEWS_PER_MACHINE || live('host', m.host) >= LIVE_VIEWS_PER_HOST || live('credential', credential) >= LIVE_VIEWS_PER_CREDENTIAL || recent >= ROWS_PER_MACHINE) fail(429, 'live_view_limit');
  }
  /** Joins the device's running live capture, or admits one. A recording in progress does not
   * prevent it: the runner feeds the views from the recording's stream until it ends. */
  private admit(db: DatabaseSync, id: string, m: Record<string, unknown>, credential: string, ttl: number, lease: { id: string; consumer: string; credential: string; member: string } | null): Row {
    requireHostAdmission(db, String(m.host));
    this.limits(db, m, credential);
    const running = db.prepare("SELECT * FROM mobile_video_sessions WHERE machine=? AND kind='live' AND state IN ('pending','attaching','ready')").get(String(m.id)) as unknown as VideoSessionRow | undefined;
    const capture = running ?? this.video.admitLiveCapture(db, m, CAPTURE_REQUEST, LIVE_VIEW_SECONDS, lease);
    const now = this.store.clock();
    db.prepare("INSERT INTO mobile_live_views VALUES (?,?,?,?,?,?,?,?,'pending',NULL,?,?,0,0,?,NULL)").run(id, capture.id, String(m.id), String(m.host), randomUUID(), credential, lease?.id ?? null, lease?.member ?? null, now, now + ATTACH_SECONDS + ttl, ttl);
    db.prepare('UPDATE mobile_video_sessions SET deadline=MAX(deadline,?) WHERE id=?').run(now + ATTACH_SECONDS + ttl + 60, capture.id);
    return this.row(db, id)!;
  }
  handle(req: ControlRequest) {
    const p = req.parts;
    if (!(p[0] === 'v1' && (p[1] === 'machines' || p[1] === 'leases') && p[3] === 'live-views' && (p.length === 4 && req.method === 'POST' || p.length === 5 && req.method === 'GET' || p.length === 6 && p[5] === 'close' && req.method === 'POST'))) return undefined;
    if (req.query.size) return fail(400);
    return this.store.transaction(db => {
      this.refresh(db);
      return p[1] === 'leases' ? this.leaseRoute(db, req) : this.machineRoute(db, req);
    });
  }
  /** Reading and closing stay available to the lease's current key after the lease ends. */
  private leaseRoute(db: DatabaseSync, req: ControlRequest) {
    const p = req.parts, leaseId = uuid(p[2]), lease = legacySessionLease(db, leaseId, req.token);
    if (p.length !== 4) {
      const r = this.row(db, p[4]);
      if (!r || r.lease !== lease.id) return fail(404);
      if (p.length === 6) { exact(req.body, []); this.end(db, r, 'closed'); this.video.refresh(db); }
      return { body: view(this.row(db, r.id)!) };
    }
    exact(req.body, ['id', 'member'], ['ttlSeconds']);
    const id = uuid(req.body.id), member = req.body.member, ttl = lifetime(req.body.ttlSeconds), old = this.row(db, id);
    if (old) { if (old.lease !== lease.id) return fail(404); if (old.member !== member || old.credential !== lease.credential || old.ttl !== ttl) return fail(409); return { body: view(old) }; }
    const { machine } = leaseScopedMember(db, leaseId, req.token, member, 'displayStream', this.store.clock());
    const m = this.target(db, String(machine.id));
    // iOS simulator leases do not exist yet; their live view arrives with them.
    if (String(object(JSON.parse(String(m.template))).os) !== 'android') return fail(409, 'capability_unsupported');
    return { status: 201, body: view(this.admit(db, id, m, lease.credential!, ttl, { id: lease.id, consumer: lease.consumer, credential: lease.credential!, member: String(member) })) };
  }
  private machineRoute(db: DatabaseSync, req: ControlRequest) {
    const p = req.parts, principal = requireScope(req, 'access'), m = this.target(db, p[2]!, principal), hash = tokenHash(req.token);
    if (p.length !== 4) {
      const r = this.row(db, p[4]);
      // Views are bearer-bound: another credential of the same owner cannot observe or end them.
      if (!r || r.machine !== m.id || r.lease || r.credential !== hash) return fail(404);
      if (p.length === 6) { exact(req.body, []); this.end(db, r, 'closed'); this.video.refresh(db); }
      return { body: view(this.row(db, r.id)!) };
    }
    exact(req.body, ['id'], ['ttlSeconds']);
    const id = uuid(req.body.id), ttl = lifetime(req.body.ttlSeconds), old = this.row(db, id);
    if (old) { if (old.machine !== m.id || old.lease || old.credential !== hash || old.ttl !== ttl) return fail(409); return { body: view(old) }; }
    // A leased device is visible to its lease holder only, through the lease route.
    if (this.leased(db, String(m.id))) return fail(409);
    requireNotPooled(db, String(m.id));
    if (!['android', 'ios'].includes(String(object(JSON.parse(String(m.template))).os))) return fail(409, 'capability_unsupported');
    if (m.enabled !== 1 || m.desired !== 'running' || m.observed !== 'running' || this.store.clock() - Number(m.seen) >= 30) return fail(409);
    return { status: 201, body: view(this.admit(db, id, m, hash, ttl, null)) };
  }
}
