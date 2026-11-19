import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tokenHash } from '../../src/accounts.ts';
import { MachineStore, machineDigest } from '../../src/control/machines.ts';
import { OwnerDisplaySessions } from '../../src/control/display-sessions.ts';
import type { ControlRequest, Principal } from '../../src/control/contracts.ts';
import { object, ServiceError } from '../../src/errors.ts';
import { SqliteStore } from '../../src/sqlite.ts';

type View = { id: string; generation: string; state: string; capability: string; machineId: string };
const key = () => randomBytes(32).toString('base64url');
const status = (code: number) => (error: unknown) => error instanceof ServiceError && error.status === code;
const desktop = { id: 'desktop', revision: '1', os: 'linux', arch: 'arm64', mode: 'desktop', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, image: '/private/desktop.img' };
const headless = { ...desktop, id: 'headless', mode: 'headless' };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'display-sessions-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite'), options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  let now = 1000;
  const user = (id = randomUUID()): Principal => ({ kind: 'session', user: { id, username: 'owner', role: 'user', status: 'active' }, scopes: ['machines:read', 'machines:write', 'machines:access'] });
  const credentials = new Map<string, Principal>();
  const ownerToken = key(), secondToken = key(), otherToken = key();
  let owner = user(); const other = user();
  credentials.set(tokenHash(ownerToken), owner); credentials.set(tokenHash(secondToken), owner); credentials.set(tokenHash(otherToken), other);
  const principalHash = (_db: unknown, hash: string) => { const p = credentials.get(hash); if (!p) throw new ServiceError('Credential revoked.', 401); return p; };
  let store = new SqliteStore(file, () => now), machines = new MachineStore(store, options), sessions = new OwnerDisplaySessions(store, machines, principalHash);
  const host = randomUUID(), hostToken = key();
  const offer = { name: 'display-fixture', provider: 'libvirt', capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 64 }, templates: [desktop, headless] };
  machines.enroll({ id: host, credential: hostToken, offer }, options.enrollmentToken);
  const req = (method: string, path: string, body: Record<string, unknown> = {}, token = ownerToken): ControlRequest => ({ method, path, parts: path.split('/').filter(Boolean), body, token,
    query: new URLSearchParams(), principal: () => principalHash(undefined, tokenHash(token)) });
  const make = (templateId: string) => machines.create({ id: randomUUID(), name: templateId, templateId, resources: {} }, req('POST', '/v1/machines'));
  const machine = make('desktop'), plain = make('headless');
  const heartbeat = (state = 'running') => machines.heartbeat(host, hostToken, { offer, reports: { [machine.id]: { state }, [plain.id]: { state: 'running' } } });
  heartbeat();
  const call = (method: string, path: string, body: Record<string, unknown> = {}, token = ownerToken) => { const response = sessions.handle(req(method, path, body, token)); assert.ok(response); return object(response.body) as unknown as View; };
  const create = (id = randomUUID(), token = ownerToken, target = machine.id) => call('POST', `/v1/machines/${target}/display-sessions`, { id }, token);
  const attach = (session: View, side: 'host' | 'consumer', patch = {}) => sessions.command({ type: 'display-sessions.attach', sessionId: session.id, generation: session.generation,
    side, ownerId: side === 'host' ? host : session.machineId, token: side === 'host' ? hostToken : ownerToken, ...patch }) as View;
  const authorized = (session: View) => (sessions.command({ type: 'display-sessions.authorized', sessionId: session.id, generation: session.generation, ready: true }) as { authorized: boolean }).authorized;
  return { get store() { return store; }, host, hostToken, machine, plain, ownerToken, secondToken, otherToken, call, create, attach, authorized, heartbeat,
    revoke: (token: string) => credentials.delete(tokenHash(token)),
    restrict: () => { owner = { ...owner, scopes: ['machines:read'] }; credentials.set(tokenHash(ownerToken), owner); },
    advance: (seconds: number) => { now += seconds; },
    restart: () => { store = new SqliteStore(file, () => now); machines = new MachineStore(store, options); sessions = new OwnerDisplaySessions(store, machines, principalHash); },
    hostSessions: () => object(machines.heartbeat(host, hostToken, { offer, reports: { [machine.id]: { state: 'running' }, [plain.id]: { state: 'running' } } })).displaySessions as View[] };
}

test('display admission binds owner, credential, desktop mode and a running unleased assignment', t => {
  const f = fixture(t), id = randomUUID(), first = f.create(id);
  assert.equal(first.capability, 'display'); assert.equal(first.state, 'pending'); assert.deepEqual(f.create(id), first, 'the same request replays');
  assert.throws(() => f.create(id, f.secondToken), status(409), 'another credential cannot claim the identity');
  assert.throws(() => f.create(randomUUID(), f.otherToken), status(404), 'another account cannot see the machine');
  assert.throws(() => f.create(randomUUID(), f.ownerToken, f.plain.id), status(409), 'headless machines have no owner desktop');
  assert.throws(() => f.call('GET', `/v1/machines/${f.machine.id}/display-sessions/${first.id}`, {}, f.secondToken), status(404), 'sessions are bound to their creating credential');
  assert.equal(f.call('GET', `/v1/machines/${f.machine.id}/display-sessions/${first.id}`).id, first.id);
  assert.deepEqual(f.hostSessions().map(s => s.id), [first.id], 'the host learns of live sessions from its heartbeat');
  assert.throws(() => f.attach(first, 'host', { ownerId: randomUUID() }), status(403));
  assert.throws(() => f.attach(first, 'host', { token: key() }), status(401));
  assert.throws(() => f.attach(first, 'consumer', { token: f.secondToken }), status(403));
  assert.throws(() => f.attach(first, 'consumer', { generation: randomUUID() }), status(403));
  assert.equal(f.attach(first, 'host').state, 'attaching'); assert.throws(() => f.attach(first, 'host'), status(409));
  assert.equal(f.attach(first, 'consumer').state, 'ready'); assert.throws(() => f.attach(first, 'consumer'), status(403));
  assert.equal(f.authorized(first), true);
  for (let i = 0; i < 3; i++) f.create();
  assert.throws(() => f.create(), status(429), 'live sessions per machine are bounded');
  f.store.transaction(db => { db.exec("CREATE TABLE IF NOT EXISTS lease_members (lease TEXT, name TEXT, machine TEXT)"); db.prepare('INSERT INTO lease_members VALUES (?,?,?)').run(randomUUID(), 'm', f.machine.id); });
  assert.equal(f.authorized(first), false, 'a leased machine uses its lease sessions instead');
});

test('display authority ends with logout, scope, machine stop, host credential rotation, attach deadline and restart', t => {
  const loggedOut = fixture(t), a = loggedOut.create(); loggedOut.attach(a, 'host'); loggedOut.attach(a, 'consumer');
  loggedOut.revoke(loggedOut.ownerToken); assert.equal(loggedOut.authorized(a), false);
  assert.throws(() => loggedOut.attach(a, 'host'), status(410));

  const scoped = fixture(t), b = scoped.create(); scoped.attach(b, 'host'); scoped.attach(b, 'consumer');
  scoped.restrict(); assert.equal(scoped.authorized(b), false); assert.throws(() => scoped.create(), status(403));

  const stopped = fixture(t), c = stopped.create(); stopped.attach(c, 'host'); stopped.attach(c, 'consumer');
  stopped.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(stopped.machine.id));
  assert.equal(stopped.authorized(c), false); assert.deepEqual(stopped.hostSessions(), []);

  const rotated = fixture(t), d = rotated.create(); rotated.attach(d, 'host'); rotated.attach(d, 'consumer');
  rotated.store.transaction(db => db.prepare('UPDATE hosts SET credential=? WHERE id=?').run(machineDigest(key()), rotated.host));
  assert.equal(rotated.authorized(d), false);

  const late = fixture(t), e = late.create(); late.attach(e, 'consumer'); late.advance(31);
  assert.throws(() => late.attach(e, 'host'), status(410), 'both peers attach within the window');
  late.heartbeat(); const ready = late.create(); late.attach(ready, 'host'); late.attach(ready, 'consumer');
  // A live broker re-checks continuously; that, not a fixed lifetime, keeps a ready session.
  for (let i = 0; i < 12; i++) { late.advance(5); late.heartbeat(); assert.equal(late.authorized(ready), true, 'a re-checked ready session has no fixed lifetime'); }
  const lapsed = late.create(); late.attach(lapsed, 'host'); late.attach(lapsed, 'consumer');
  late.advance(5); late.heartbeat(); late.authorized(ready); late.advance(6); late.heartbeat();
  assert.equal(late.authorized(lapsed), false, 'a ready session whose broker stopped re-checking releases its slot');
  late.advance(31); assert.equal(late.authorized(ready), false, 'a stale host ends it');

  const restarted = fixture(t), g = restarted.create(); restarted.attach(g, 'host'); restarted.attach(g, 'consumer'); restarted.restart();
  assert.equal(restarted.authorized(g), false); assert.throws(() => restarted.attach(g, 'host'), status(410));

  const closed = fixture(t), h = closed.create();
  assert.equal(closed.call('POST', `/v1/machines/${closed.machine.id}/display-sessions/${h.id}/close`).state, 'disconnected');
  assert.equal(closed.authorized(h), false);
});

test('a create and close loop is bounded, and closed rows are pruned after five minutes', t => {
  const f = fixture(t);
  for (let i = 0; i < 64; i++) { const s = f.create(); f.call('POST', `/v1/machines/${f.machine.id}/display-sessions/${s.id}/close`); }
  assert.throws(() => f.create(), status(429));
  f.advance(301); f.heartbeat();
  assert.equal(f.create().state, 'pending');
});

test('a lapsed per-message check records the disconnect at once', t => {
  const f = fixture(t), s = f.create(); f.attach(s, 'host'); f.attach(s, 'consumer');
  f.revoke(f.ownerToken); assert.equal(f.authorized(s), false);
  assert.equal(f.store.transaction(db => db.prepare('SELECT state FROM owner_display_sessions WHERE id=?').get(s.id))!.state, 'disconnected');
});

test('per-message re-checks of a ready session do not each commit, and continuous re-checks keep it live', t => {
  const f = fixture(t), s = f.create(); f.attach(s, 'host'); f.attach(s, 'consumer');
  // Another connection's data_version changes only when some connection commits a change.
  const observer = new DatabaseSync(f.store.path, { readOnly: true }); t.after(() => observer.close());
  const version = () => Number((observer.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  const before = version();
  // A burst of relayed input within one second: every message is still checked, none writes.
  for (let i = 0; i < 50; i++) { f.advance(0.01); assert.equal(f.authorized(s), true); }
  assert.equal(version(), before, 'a burst of per-message checks commits no write');
  // A broker re-checking at its 250 ms monitor cadence keeps the session past the liveness window.
  for (let i = 0; i < 80; i++) { f.advance(0.25); assert.equal(f.authorized(s), true, 'a continuously re-checked session never lapses'); }
  assert.notEqual(version(), before, 'continuous re-checks still refresh liveness');
  f.heartbeat(); f.advance(10);
  assert.equal(f.authorized(s), false, 'once re-checks stop, the session releases its slot within the liveness window');
});

test('one owner cannot hold more than eight live viewers on a shared host, across credentials', t => {
  const f = fixture(t);
  // Eight live viewers held under the owner's second credential on their other machine.
  f.store.transaction(db => {
    const m = db.prepare('SELECT * FROM machines WHERE id=?').get(f.plain.id) as Record<string, unknown>;
    const bound = machineDigest([m.id, m.host, m.owner, m.template, m.request]);
    for (let i = 0; i < 8; i++)
      db.prepare("INSERT INTO owner_display_sessions (id,machine,host,binding,generation,credential,host_credential,state,created,host_attached,consumer_attached,seen) VALUES (?,?,?,?,?,?,NULL,'ready',?,1,1,?)")
        .run(randomUUID(), String(m.id), String(m.host), bound, randomUUID(), tokenHash(f.secondToken), 1000, 1000);
  });
  assert.throws(() => f.create(), status(429), 'the per-owner host limit applies before the shared host limit');
});
