/** Owner desktop display sessions for unleased machines: the controller half of the
 * dashboard's remote display relay. The dashboard opens one per viewer under the
 * owner's own credential; the machine's host attaches outbound. Every relayed message
 * and a 250 ms monitor re-check this same ownership, scope and assignment state. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenHash } from '../accounts.ts';
import { ServiceError, object } from '../errors.ts';
import type { SqliteStore } from '../sqlite.ts';
import { owns, requireScope } from './contracts.ts';
import type { ControlModule, ControlRequest, Principal } from './contracts.ts';
import { MachineStore, machineDigest, registerMachineHooks } from './machines.ts';
import { uuid } from './transfers.ts';
import type { SessionSide } from './session-protocol.ts';

export type DisplaySessionCommand =
  | { type: 'display-sessions.attach'; sessionId: string; generation: string; side: SessionSide; ownerId: string; token: string }
  | { type: 'display-sessions.authorized'; sessionId: string; generation: string; ready?: boolean }
  | { type: 'display-sessions.disconnect'; sessionId: string; generation: string };
type Row = { id: string; machine: string; host: string; binding: string; generation: string; credential: string; host_credential: string | null; state: string; created: number; host_attached: number; consumer_attached: number };
const LIVE = ['pending', 'attaching', 'ready'];
/** Both peers must attach within this window; a ready session has no fixed lifetime. */
export const DISPLAY_ATTACH_SECONDS = 30;
/** Live sessions per machine, host and creating credential; rows per machine in any state
 * within the retention window, so a create/close loop cannot grow the table. */
const PER_MACHINE = 4, PER_HOST = 16, PER_CREDENTIAL = 8, ROWS_PER_MACHINE = 64, RETAIN_SECONDS = 300;
const fail = (status = 409): never => { throw new ServiceError('Desktop display session rejected.', status); };
function binding(m: Record<string, unknown>): string { return machineDigest([m.id, m.host, m.owner, m.template, m.request]); }
function row(db: DatabaseSync, id: string): Row { return db.prepare('SELECT * FROM owner_display_sessions WHERE id=?').get(uuid(id)) as unknown as Row ?? fail(404); }
function view(r: Row) {
  return { id: r.id, machineId: r.machine, generation: r.generation, capability: 'display' as const, protocol: 'canaveral-session-v1' as const, state: r.state,
    attachBefore: new Date((r.created + DISPLAY_ATTACH_SECONDS) * 1000).toISOString() };
}

export class OwnerDisplaySessions implements ControlModule {
  constructor(readonly store: SqliteStore, readonly machines: MachineStore, readonly principalHash: (db: DatabaseSync, hash: string) => Principal) {
    store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS owner_display_sessions (
      id TEXT PRIMARY KEY,machine TEXT NOT NULL,host TEXT NOT NULL,binding TEXT NOT NULL,generation TEXT NOT NULL,
      credential TEXT NOT NULL,host_credential TEXT,state TEXT NOT NULL,created REAL NOT NULL,
      host_attached INTEGER NOT NULL,consumer_attached INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_display_sessions_host ON owner_display_sessions(host,state);
      CREATE INDEX IF NOT EXISTS owner_display_sessions_state ON owner_display_sessions(state,created);
      CREATE INDEX IF NOT EXISTS owner_display_sessions_machine ON owner_display_sessions(machine,created);
      UPDATE owner_display_sessions SET state='disconnected' WHERE state IN ('pending','attaching','ready');`));
    registerMachineHooks(store, {
      heartbeatResponse: (db, host) => {
        this.refresh(db); this.prune(db);
        return { displaySessions: (db.prepare("SELECT * FROM owner_display_sessions WHERE host=? AND state IN ('pending','attaching','ready') ORDER BY created,id LIMIT ?").all(host, PER_HOST) as unknown as Row[]).map(view) };
      },
    });
  }
  private target(db: DatabaseSync, id: string, principal?: Principal): Record<string, unknown> {
    const m = db.prepare('SELECT m.*,h.enabled,h.seen,h.credential AS hostCredential FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(uuid(id));
    if (!m || principal && !owns(principal, m.owner)) return fail(404);
    return m;
  }
  private leased(db: DatabaseSync, machine: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_members'").get() && !!db.prepare('SELECT 1 FROM lease_members WHERE machine=?').get(machine);
  }
  /** The creating credential must still hold machine access to this exact, running,
   * unleased assignment on a fresh host whose credential has not rotated since attach. */
  private current(db: DatabaseSync, r: Row): boolean {
    try {
      const principal = this.principalHash(db, r.credential), m = this.target(db, r.machine, principal);
      if (!(principal.kind === 'operator' || principal.user?.role === 'admin' && principal.scopes.includes('admin') || principal.scopes.includes('machines:access'))) return false;
      const now = this.store.clock();
      return binding(m) === r.binding && m.host === r.host && m.enabled === 1 && m.desired === 'running' && m.observed === 'running' && now - Number(m.seen) < 30 &&
        !this.leased(db, r.machine) && (r.state === 'ready' || now < r.created + DISPLAY_ATTACH_SECONDS) && (!r.host_credential || r.host_credential === m.hostCredential);
    } catch { return false; }
  }
  private refresh(db: DatabaseSync): void {
    for (const r of db.prepare("SELECT * FROM owner_display_sessions WHERE state IN ('pending','attaching','ready')").all() as unknown as Row[]) if (!this.current(db, r)) this.disconnect(db, r);
  }
  private prune(db: DatabaseSync): void {
    db.prepare("DELETE FROM owner_display_sessions WHERE state='disconnected' AND created<?").run(this.store.clock() - RETAIN_SECONDS);
  }
  private disconnect(db: DatabaseSync, r: Row): void { db.prepare("UPDATE owner_display_sessions SET state='disconnected' WHERE id=? AND state IN ('pending','attaching','ready')").run(r.id); }
  command(command: DisplaySessionCommand): unknown {
    return this.store.transaction(db => {
      // The broker asks once per relayed message: check only this row, and record a lapse.
      const r = row(db, command.sessionId);
      if (r.generation !== uuid(command.generation)) return fail(403);
      if (command.type === 'display-sessions.disconnect') { this.disconnect(db, r); return { disconnected: true }; }
      if (command.type === 'display-sessions.authorized') {
        const authorized = LIVE.includes(r.state) && this.current(db, r);
        if (LIVE.includes(r.state) && !authorized) this.disconnect(db, r);
        return { authorized: authorized && (!command.ready || r.state === 'ready') };
      }
      if (!LIVE.includes(r.state) || !this.current(db, r)) return fail(410);
      if (command.side === 'host') {
        if (uuid(command.ownerId) !== r.host) return fail(403);
        this.machines.authenticateHost(r.host, command.token);
        if (r.host_attached) return fail(409);
        db.prepare('UPDATE owner_display_sessions SET host_attached=1,host_credential=?,state=? WHERE id=?').run(machineDigest(command.token), r.consumer_attached ? 'ready' : 'attaching', r.id);
      } else {
        if (uuid(command.ownerId) !== r.machine || tokenHash(command.token) !== r.credential || r.consumer_attached) return fail(403);
        db.prepare('UPDATE owner_display_sessions SET consumer_attached=1,state=? WHERE id=?').run(r.host_attached ? 'ready' : 'attaching', r.id);
      }
      return view(row(db, r.id));
    });
  }
  handle(req: ControlRequest) {
    const p = req.parts;
    if (!(p[0] === 'v1' && p[1] === 'machines' && p[3] === 'display-sessions' && (p.length === 4 && req.method === 'POST' || p.length === 5 && req.method === 'GET' || p.length === 6 && p[5] === 'close' && req.method === 'POST'))) return undefined;
    if (req.query.size) return fail(400);
    return this.store.transaction(db => {
      this.refresh(db);
      const principal = requireScope(req, 'access'), m = this.target(db, p[2]!, principal), hash = tokenHash(req.token);
      if (p.length !== 4) {
        const r = row(db, p[4]!);
        // Sessions are bearer-bound: another credential of the same owner cannot observe or end them.
        if (r.machine !== m.id || r.credential !== hash) return fail(404);
        if (p.length === 6) { if (Object.keys(req.body).length) fail(400); this.disconnect(db, r); }
        return { body: view(row(db, r.id)) };
      }
      if (Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'id')) return fail(400);
      const id = uuid(req.body.id);
      const old = db.prepare('SELECT * FROM owner_display_sessions WHERE id=?').get(id) as unknown as Row | undefined;
      if (old) { if (old.machine !== m.id || old.binding !== binding(m) || old.credential !== hash) return fail(409); return { body: view(old) }; }
      const template = object(JSON.parse(String(m.template)));
      if (template.mode !== 'desktop' || m.enabled !== 1 || m.desired !== 'running' || m.observed !== 'running' || this.store.clock() - Number(m.seen) >= 30 || this.leased(db, String(m.id))) return fail(409);
      const live = (column: string, value: unknown) => Number(db.prepare(`SELECT COUNT(*) AS n FROM owner_display_sessions WHERE ${column}=? AND state IN ('pending','attaching','ready')`).get(value as string)!.n);
      const recent = Number(db.prepare('SELECT COUNT(*) AS n FROM owner_display_sessions WHERE machine=? AND created>=?').get(String(m.id), this.store.clock() - RETAIN_SECONDS)!.n);
      if (live('machine', m.id) >= PER_MACHINE || live('host', m.host) >= PER_HOST || live('credential', hash) >= PER_CREDENTIAL || recent >= ROWS_PER_MACHINE) return fail(429);
      db.prepare("INSERT INTO owner_display_sessions VALUES (?,?,?,?,?,?,NULL,'pending',?,0,0)").run(id, String(m.id), String(m.host), binding(m), randomUUID(), hash, this.store.clock());
      return { status: 201, body: view(row(db, id)) };
    });
  }
}
