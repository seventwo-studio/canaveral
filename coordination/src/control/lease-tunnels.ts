/** Lease port tunnels: controller admission and the authority the session broker re-checks.
 *
 * A tunnel maps one port of a leased Android emulator to the lease holder's machine (`reverse`)
 * or one holder-side listener to a device port (`forward`). It is carried by the device's own
 * control channel on the runner and relayed through this controller's session broker; the
 * leased guest keeps no network of its own. See docs/mobile-control.md, "Lease port tunnels".
 *
 * Scope: only the lease's current key opens, lists, closes and attaches a tunnel. The
 * application key, another lease's key, account and operator credentials and the runner get 401.
 * Off unless both the member's host declares `leaseTunnelProtocol: 1` and the application's
 * policy sets `limits.tunnelsPerLease` above zero.
 *
 * A tunnel holds no capacity reservation. It holds one of its lease's tunnel slots and its
 * device port from creation until it has ended and its device mapping is known to be gone:
 * the runner never installed one, the runner reported the removal, or the lease's own cleanup
 * proved the emulator stopped and removed. It never delays that cleanup. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ApplicationSpec } from '../consumers.ts';
import { ServiceError, object, secret } from '../errors.ts';
import type { SqliteStore } from '../sqlite.ts';
import type { ControlModule, ControlRequest } from './contracts.ts';
import { ACTIVE, legacyMachineReady, legacySessionLease, legacyTable, utc } from './leases.ts';
import { MachineStore, machineDigest, registerMachineHooks } from './machines.ts';
import { requireHostAdmission } from './maintenance.ts';
import { SESSION_PROTOCOL } from './session-protocol.ts';
import type { SessionSide } from './session-protocol.ts';
import { uuid } from './transfers.ts';
import { TUNNEL_ATTACH_SECONDS, TUNNEL_CONNECTIONS, TUNNEL_IDENTITIES_PER_LEASE, TUNNEL_WINDOW_BYTES, TUNNELS_PER_HOST, TUNNELS_PER_LEASE_MAX, tunnelIntent } from '../tunnel-relay.ts';

export type TunnelCommand =
  | { type: 'tunnels.attach'; sessionId: string; generation: string; side: SessionSide; ownerId: string; token: string }
  | { type: 'tunnels.authorized'; sessionId: string; generation: string; ready?: boolean }
  | { type: 'tunnels.disconnect'; sessionId: string; generation: string };
type Row = { id: string; lease: string; member: string; machine: string; host: string; binding: string; generation: string; credential: string; host_credential: string | null;
  request: string; state: string; created: number; host_attached: number; consumer_attached: number; mapping_removed: number; ended: number | null };
const LIVE = ['pending', 'attaching', 'ready'];
const LIVE_SQL = "('pending','attaching','ready')";
/** Over alias `t`: the tunnel still holds its lease slot, its host slot and its device port. */
const HELD = `(t.state IN ${LIVE_SQL} OR t.mapping_removed=0)`;
const refuse = (status: number, code?: string): never => { throw new ServiceError('Lease tunnel request rejected.', status, code ? { code } : {}); };
function exact(body: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(k => !Object.hasOwn(body, k)) || Object.keys(body).some(k => !required.includes(k) && !optional.includes(k))) refuse(400);
}
function binding(m: Record<string, unknown>): string { return machineDigest([m.id, m.host, m.owner, m.template, m.request]); }
function leaseDigest(token: string): string | undefined { try { return machineDigest(secret(token)); } catch { return undefined; } }
/** The host offers lease tunnels for this Android image. A host-wide lease protocol alone grants none. */
function tunnelHost(m: Record<string, unknown>): boolean {
  try {
    const offer = object(JSON.parse(String(m.host_offer)));
    return offer.leaseProtocol === 1 && offer.leaseTunnelProtocol === 1 && object(JSON.parse(String(m.template))).os === 'android';
  } catch { return false; }
}

export class LeaseTunnels implements ControlModule {
  constructor(readonly store: SqliteStore, readonly machines: MachineStore) {
    store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS lease_tunnels (
      id TEXT PRIMARY KEY,lease TEXT NOT NULL,member TEXT NOT NULL,machine TEXT NOT NULL,host TEXT NOT NULL,binding TEXT NOT NULL,
      generation TEXT NOT NULL,credential TEXT NOT NULL,host_credential TEXT,request TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,
      host_attached INTEGER NOT NULL,consumer_attached INTEGER NOT NULL,mapping_removed INTEGER NOT NULL,ended REAL);
      CREATE INDEX IF NOT EXISTS lease_tunnels_lease ON lease_tunnels(lease,created);
      CREATE INDEX IF NOT EXISTS lease_tunnels_host ON lease_tunnels(host,state);
      UPDATE lease_tunnels SET state='disconnected',ended=COALESCE(ended,created) WHERE state IN ${LIVE_SQL};`));
    registerMachineHooks(store, { heartbeatResponse: (db, host) => {
      this.refresh(db);
      // Never truncated: admission keeps a host at or below this many held tunnels.
      return { leaseTunnels: (db.prepare(`SELECT * FROM lease_tunnels t WHERE t.host=? AND ${HELD} ORDER BY t.created,t.id LIMIT ?`).all(host, TUNNELS_PER_HOST) as unknown as Row[])
        .map(r => ({ ...this.view(db, r), machineId: r.machine, hostId: r.host })) };
    } });
  }
  private row(db: DatabaseSync, id: string): Row { return db.prepare('SELECT * FROM lease_tunnels WHERE id=?').get(uuid(id)) as unknown as Row ?? refuse(404); }
  private machine(db: DatabaseSync, id: string): Record<string, unknown> | undefined {
    return db.prepare('SELECT m.*,h.seen,h.enabled,h.offer AS host_offer,h.credential AS hostCredential FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(id);
  }
  private view(db: DatabaseSync, r: Row) {
    const lease = db.prepare('SELECT expires FROM leases WHERE id=?').get(r.lease);
    return { id: r.id, leaseId: r.lease, member: r.member, ...object(JSON.parse(r.request)), generation: r.generation, capability: 'tunnel' as const, protocol: SESSION_PROTOCOL, state: r.state,
      createdAt: utc(r.created), attachBefore: utc(r.created + TUNNEL_ATTACH_SECONDS), authorizationDeadline: utc(Number(lease?.expires ?? r.created)),
      mappingRemoved: r.mapping_removed === 1, limits: { connections: TUNNEL_CONNECTIONS, windowBytes: TUNNEL_WINDOW_BYTES } };
  }
  /** Why a live tunnel may no longer be used, or undefined while it is still authorized. A tunnel
   * follows its lease: the key that opened it, a ready unexpired lease, an active application, a
   * checked ready device on the same assignment, and a host that still offers tunnels. */
  private lapsed(db: DatabaseSync, r: Row, now: number): 'revoked' | 'expired' | 'disconnected' | undefined {
    const lease = db.prepare('SELECT l.state,l.expires,l.credential,c.revoked,c.specification FROM leases l JOIN consumers c ON c.id=l.consumer WHERE l.id=?').get(r.lease);
    if (!lease || lease.revoked !== 0 || lease.credential !== r.credential) return 'revoked';
    if (lease.state === 'expired' || now >= Number(lease.expires)) return 'expired';
    if (lease.state !== 'ready' || !this.permitted(String(lease.specification))) return 'revoked';
    if (r.state !== 'ready' && now >= r.created + TUNNEL_ATTACH_SECONDS) return 'expired';
    const m = this.machine(db, r.machine);
    if (!m || !db.prepare('SELECT 1 FROM lease_members WHERE lease=? AND name=? AND machine=?').get(r.lease, r.member, r.machine) || binding(m) !== r.binding || m.host !== r.host ||
        !tunnelHost(m) || !legacyMachineReady(db, m, now) || r.host_credential && r.host_credential !== m.hostCredential) return 'disconnected';
    return undefined;
  }
  private permitted(specification: string): number {
    const allowed = (JSON.parse(specification) as ApplicationSpec).limits.tunnelsPerLease ?? 0;
    return Number.isSafeInteger(allowed) && allowed > 0 ? Math.min(allowed, TUNNELS_PER_LEASE_MAX) : 0;
  }
  private finish(db: DatabaseSync, r: Row, state: string): void {
    db.prepare(`UPDATE lease_tunnels SET state=?,ended=? WHERE id=? AND state IN ${LIVE_SQL}`).run(state, this.store.clock(), r.id);
  }
  /** Ends lapsed tunnels and settles ended ones whose mapping cannot exist any more: the runner
   * never attached, or the lease's cleanup proved the emulator stopped and its storage removed. */
  private refresh(db: DatabaseSync): void {
    const now = this.store.clock();
    for (const r of db.prepare(`SELECT * FROM lease_tunnels WHERE state IN ${LIVE_SQL}`).all() as unknown as Row[]) { const end = this.lapsed(db, r, now); if (end) this.finish(db, r, end); }
    db.prepare(`UPDATE lease_tunnels SET mapping_removed=1 WHERE mapping_removed=0 AND state NOT IN ${LIVE_SQL} AND (host_attached=0${legacyTable(db, 'lease_cleanup_members') ?
      " OR EXISTS (SELECT 1 FROM lease_cleanup_members c WHERE c.machine=lease_tunnels.machine AND c.state='complete')" : ''})`).run();
  }
  /** Broker authority. The broker asks once per relayed message and every 250 ms, so this checks
   * one row and writes only when that tunnel ends. */
  command(command: TunnelCommand): unknown {
    return this.store.transaction(db => {
      const r = this.row(db, command.sessionId);
      if (r.generation !== uuid(command.generation)) return refuse(403);
      if (command.type === 'tunnels.disconnect') { this.finish(db, r, 'disconnected'); return { disconnected: true }; }
      const live = LIVE.includes(r.state), end = live ? this.lapsed(db, r, this.store.clock()) : undefined;
      if (end) this.finish(db, r, end);
      const current = live && !end;
      if (command.type === 'tunnels.authorized') return { authorized: current && (!command.ready || r.state === 'ready') };
      if (!current) return refuse(410);
      if (command.side === 'host') {
        if (uuid(command.ownerId) !== r.host) return refuse(403);
        this.machines.authenticateHost(r.host, command.token);
        if (r.host_attached) return refuse(409);
        db.prepare('UPDATE lease_tunnels SET host_attached=1,host_credential=?,state=? WHERE id=?').run(machineDigest(command.token), r.consumer_attached ? 'ready' : 'attaching', r.id);
      } else {
        if (uuid(command.ownerId) !== r.lease || leaseDigest(command.token) !== r.credential || r.consumer_attached) return refuse(403);
        db.prepare('UPDATE lease_tunnels SET consumer_attached=1,state=? WHERE id=?').run(r.host_attached ? 'ready' : 'attaching', r.id);
      }
      const attached = this.row(db, r.id);
      return { id: attached.id, generation: attached.generation, capability: 'tunnel', direction: object(JSON.parse(attached.request)).direction };
    });
  }
  handle(req: ControlRequest) {
    const p = req.parts;
    const receipt = req.method === 'POST' && p.length === 6 && p[0] === 'v1' && p[1] === 'hosts' && p[3] === 'tunnels' && p[5] === 'finish';
    const lease = p[0] === 'v1' && p[1] === 'leases' && p[3] === 'tunnels' && !!p[2] && (p.length === 4 && ['GET', 'POST'].includes(req.method) || p.length === 5 && req.method === 'GET' || p.length === 6 && p[5] === 'close' && req.method === 'POST');
    if (!receipt && !lease) return undefined;
    if (req.query.size) return refuse(400);
    return this.store.transaction(db => {
      if (receipt) return this.receipt(db, req);
      const leaseId = uuid(p[2]);
      // Route ownership follows the lease's ledger, never the outcome of authentication.
      if (!legacyTable(db, 'leases') || !db.prepare('SELECT 1 FROM leases WHERE id=?').get(leaseId)) return undefined;
      this.refresh(db);
      const owner = legacySessionLease(db, leaseId, req.token);
      if (p.length === 4 && req.method === 'GET') return { body: { tunnels: (db.prepare('SELECT * FROM lease_tunnels WHERE lease=? ORDER BY created,id').all(owner.id) as unknown as Row[]).map(r => this.view(db, r)) } };
      if (p.length !== 4) {
        const r = db.prepare('SELECT * FROM lease_tunnels WHERE id=?').get(uuid(p[4])) as unknown as Row | undefined;
        if (!r || r.lease !== owner.id) return refuse(404);
        if (p.length === 6) { exact(req.body, []); this.finish(db, r, 'closed'); }
        return { body: this.view(db, this.row(db, r.id)) };
      }
      exact(req.body, ['id', 'member', 'direction', 'devicePort'], ['idleSeconds']);
      const id = uuid(req.body.id), member = req.body.member, intent = tunnelIntent(req.body.direction, req.body.devicePort, req.body.idleSeconds);
      if (!intent || typeof member !== 'string' || !member.trim() || [...member].length > 100) return refuse(400);
      const request = JSON.stringify(intent);
      const old = db.prepare('SELECT * FROM lease_tunnels WHERE id=?').get(id) as unknown as Row | undefined;
      // A replay returns the saved tunnel in its current state. It never opens a second one.
      if (old) { if (old.lease !== owner.id) return refuse(404); if (old.member !== member || old.request !== request) return refuse(409); return { body: this.view(db, old) }; }
      const now = this.store.clock();
      if (!ACTIVE.includes(owner.state) || now >= owner.expires) return refuse(410, 'lease_ended');
      const assigned = db.prepare('SELECT machine FROM lease_members WHERE lease=? AND name=?').get(owner.id, member);
      const m = assigned ? this.machine(db, String(assigned.machine)) : undefined;
      if (!m) return refuse(404);
      const allowed = this.permitted(String(db.prepare('SELECT specification FROM consumers WHERE id=?').get(owner.consumer)!.specification));
      if (!allowed) return refuse(403, 'tunnels_not_permitted');
      if (!tunnelHost(m)) return refuse(409, 'capability_unsupported');
      if (owner.state !== 'ready' || !legacyMachineReady(db, m, now)) return refuse(409, 'member_not_ready');
      requireHostAdmission(db, String(m.host));
      const count = (where: string, value: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM lease_tunnels t WHERE ${where}`).get(value)!.n);
      if (count(`t.lease=? AND ${HELD}`, owner.id) >= allowed || count('t.lease=?', owner.id) >= TUNNEL_IDENTITIES_PER_LEASE) return refuse(429, 'tunnel_limit');
      if (count(`t.host=? AND ${HELD}`, String(m.host)) >= TUNNELS_PER_HOST) return refuse(429, 'tunnel_host_limit');
      // One mapping per device port and direction. An ended tunnel keeps its port until its mapping is known gone.
      for (const held of db.prepare(`SELECT request FROM lease_tunnels t WHERE t.machine=? AND ${HELD}`).all(String(m.id))) {
        const other = object(JSON.parse(String(held.request)));
        if (other.direction === intent.direction && other.devicePort === intent.devicePort) return refuse(409, 'tunnel_port_busy');
      }
      db.prepare(`INSERT INTO lease_tunnels (id,lease,member,machine,host,binding,generation,credential,host_credential,request,state,created,host_attached,consumer_attached,mapping_removed,ended)
        VALUES (?,?,?,?,?,?,?,?,NULL,?,'pending',?,0,0,0,NULL)`).run(id, owner.id, member, String(m.id), String(m.host), binding(m), randomUUID(), owner.credential!, request, now);
      return { status: 201, body: this.view(db, this.row(db, id)) };
    });
  }
  /** The runner's positive receipt that it removed the device mapping, or never installed one.
   * Current host credentials may repeat it after a rotation; it never revives a tunnel. */
  private receipt(db: DatabaseSync, req: ControlRequest) {
    const p = req.parts;
    exact(req.body, ['generation', 'mappingRemoved']);
    const host = uuid(p[2]), r = this.row(db, p[4]!);
    this.machines.authenticateHost(host, req.token);
    if (r.host !== host || r.generation !== uuid(req.body.generation) || !r.host_attached || req.body.mappingRemoved !== true) return refuse(403);
    this.finish(db, r, 'disconnected');
    db.prepare('UPDATE lease_tunnels SET mapping_removed=1 WHERE id=?').run(r.id);
    return { body: this.view(db, this.row(db, r.id)) };
  }
}
