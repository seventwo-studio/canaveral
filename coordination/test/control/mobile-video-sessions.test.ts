import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenHash } from '../../src/accounts.ts';
import { CliClient } from '../../src/account-cli.ts';
import { MachineStore, machineDigest } from '../../src/control/machines.ts';
import { MobileVideoSessions } from '../../src/control/mobile-video-sessions.ts';
import { SessionConnection } from '../../src/control/sessions.ts';
import type { ControlRequest, Principal } from '../../src/control/contracts.ts';
import { object, ServiceError } from '../../src/errors.ts';
import { startController } from '../../src/main.ts';
import { SqliteStore } from '../../src/sqlite.ts';

type View = { id: string; generation: string; state: string; capability: string };
const key = () => randomBytes(32).toString('base64url');
const status = (code: number) => (error: unknown) => error instanceof ServiceError && error.status === code;
const request = () => ({ id: randomUUID(), fps: 30, durationSeconds: 1, bitRate: 2000000 });
const image = { id: 'video-phone', revision: '1', os: 'android', arch: 'arm64', mode: 'device', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 },
  device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-video-sessions-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite'), options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  let now = 1000, revoked = false;
  let owner: Principal = { kind: 'token', user: { id: randomUUID(), username: 'owner', role: 'user', status: 'active' }, scopes: ['machines:read','machines:write','machines:access'] };
  const other: Principal = { ...owner, user: { ...owner.user!, id: randomUUID() } }, token = key(), host = randomUUID(), hostToken = key();
  let store = new SqliteStore(file, () => now), machines = new MachineStore(store, options);
  const principalHash = (_db: unknown, hash: string) => { if (hash !== tokenHash(token) || revoked) throw new ServiceError('Credential revoked.',401); return owner; };
  let sessions = new MobileVideoSessions(store, machines, principalHash);
  const offer = { name: 'portable-video-fixture', provider: 'android', capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 32 }, templates: [image] };
  machines.enroll({ id: host, credential: hostToken, offer }, options.enrollmentToken);
  const req = (method: string, path: string, body = {}, principal?: Principal, auth = token): ControlRequest => ({ method, path, parts: path.split('/').filter(Boolean), body, token: auth, query: new URLSearchParams(),
    principal: () => { if (principal) return principal; return principalHash(undefined, tokenHash(token)); } });
  const machine = machines.create({ id: randomUUID(), name: 'video-phone', templateId: image.id, resources: {} }, req('POST','/v1/machines'));
  machines.heartbeat(host, hostToken, { offer, reports: { [machine.id]: { state: 'running' } } });
  const path = `/v1/machines/${machine.id}/video-sessions`;
  const call = (method: string, route: string, body = {}, principal?: Principal, auth = token) => {
    const response = sessions.handle(req(method, route, body, principal, auth)); assert.ok(response); return object(response.body);
  };
  const create = (body = request(), principal?: Principal) => call('POST',path,body,principal) as unknown as View;
  const attach = (session: View, side: 'host' | 'consumer', patch = {}) => sessions.command({ type: 'video-sessions.attach', sessionId: session.id, generation: session.generation,
    side, ownerId: side === 'host' ? host : String(machine.id), token: side === 'host' ? hostToken : token, ...patch }) as View;
  return { get store() { return store; }, host, hostToken, machine, token, other, path, call, create, attach,
    available: () => store.transaction(db => machines.remainingCapacity(db,host)),
    authorized: (session: View) => sessions.command({ type: 'video-sessions.authorized', sessionId: session.id, generation: session.generation, ready: true }),
    disconnect: (session: View) => sessions.command({ type: 'video-sessions.disconnect', sessionId: session.id, generation: session.generation }),
    restrict: () => { owner = { ...owner, scopes: ['machines:read'] }; }, revoke: () => { revoked = true; },
    advance: (seconds: number) => { now += seconds; },
    restart: () => { store = new SqliteStore(file, () => now); machines = new MachineStore(store,options); sessions = new MobileVideoSessions(store,machines,principalHash); },
  };
}

test('video admission binds immutable identity, owner, scope, generation and peer claims', t => {
  const f = fixture(t), body = request(), first = f.create(body), initial = f.available();
  assert.equal(first.capability,'video'); assert.deepEqual(f.create(body),first); assert.deepEqual(f.available(),initial);
  assert.throws(() => f.create({ ...body, bitRate: 3000000 }),status(409));
  assert.throws(() => f.create(request(),f.other),status(404));
  assert.throws(() => f.attach(first,'host',{ ownerId: randomUUID() }),status(403));
  assert.throws(() => f.attach(first,'host',{ token: key() }),status(401));
  assert.throws(() => f.attach(first,'consumer',{ generation: randomUUID() }),status(403));
  assert.equal(f.attach(first,'host').state,'attaching'); assert.throws(() => f.attach(first,'host'),status(409));
  assert.equal(f.attach(first,'consumer').state,'ready'); assert.throws(() => f.attach(first,'consumer'),status(403));
  assert.deepEqual(f.authorized(first),{ authorized: true });
  f.restrict(); assert.deepEqual(f.authorized(first),{ authorized: false }); assert.throws(() => f.create(),status(403));
});

test('video capacity survives uncertain disconnect and is released only by positive bound host cleanup', t => {
  const f = fixture(t), initial = f.available(), session = f.create();
  assert.equal(f.available().cpu,initial.cpu - 1); assert.equal(f.available().memoryMiB,initial.memoryMiB - 256);
  assert.throws(() => f.create(),status(409)); f.attach(session,'host'); f.attach(session,'consumer'); f.disconnect(session);
  assert.equal(f.available().cpu,initial.cpu - 1); assert.throws(() => f.create(),status(409));
  const finish = `/v1/hosts/${f.host}/video-sessions/${session.id}/finish`;
  assert.throws(() => f.call('POST',finish,{ generation: session.generation, cleaned: false },undefined,f.hostToken),status(403));
  assert.throws(() => f.call('POST',finish,{ generation: randomUUID(), cleaned: true },undefined,f.hostToken),status(403));
  assert.equal(f.call('POST',finish,{ generation: session.generation, cleaned: true },undefined,f.hostToken).state,'finished');
  assert.deepEqual(f.available(),initial);
  const pending = f.create(); f.disconnect(pending); assert.deepEqual(f.available(),initial);
});

test('video token revocation and controller restart fence old generations without replay or guessed cleanup', t => {
  const f = fixture(t), initial = f.available(), body = request(), active = f.create(body);
  f.attach(active,'host'); f.attach(active,'consumer'); f.restart();
  assert.equal(f.create(body).state,'disconnected'); assert.equal(f.create(body).generation,active.generation);
  assert.deepEqual(f.authorized(active),{ authorized: false }); assert.throws(() => f.attach(active,'host'),status(410));
  assert.equal(f.available().cpu,initial.cpu - 1); assert.throws(() => f.create(),status(409));
  const clean = fixture(t), session = clean.create(); clean.attach(session,'host'); clean.attach(session,'consumer'); clean.revoke();
  assert.deepEqual(clean.authorized(session),{ authorized: false });
  const unstarted = fixture(t), pendingBody = request(), pending = unstarted.create(pendingBody), reserved = unstarted.available().cpu;
  unstarted.restart(); assert.equal(unstarted.create(pendingBody).generation,pending.generation); assert.equal(unstarted.available().cpu,reserved + 1);
});

test('host credential rotation fences capture but permits saved positive cleanup under the current key', t => {
  const f = fixture(t), initial = f.available(), session = f.create(); f.attach(session, 'host'); f.attach(session, 'consumer');
  const rotated = key(); f.store.transaction(db => db.prepare('UPDATE hosts SET credential=? WHERE id=?').run(machineDigest(rotated), f.host));
  assert.deepEqual(f.authorized(session), { authorized: false }); assert.equal(f.available().cpu, initial.cpu - 1);
  const path = `/v1/hosts/${f.host}/video-sessions/${session.id}/finish`, body = { generation: session.generation, cleaned: true };
  assert.throws(() => f.call('POST', path, body, undefined, f.hostToken), status(401));
  assert.equal(f.call('POST', path, body, undefined, rotated).state, 'finished'); assert.deepEqual(f.available(), initial);
});

/** Real HTTP workers and WebSocket broker; bytes are synthetic, with no capture or encoder. */
test('real mobile-video broker relays encoded bytes and controls, rejects consumer binary and retains unknown reservations', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(),'mobile-video-broker-')), admin = key(), enrollment = key();
  const adminFile = join(directory,'admin.token'), enrollmentFile = join(directory,'enrollment.token');
  writeFileSync(adminFile,admin,{mode:0o600}); writeFileSync(enrollmentFile,enrollment,{mode:0o600});
  const config = { statePath: join(directory,'controller.sqlite'), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } };
  let service = await startController(config);
  const peers: SessionConnection[] = [];
  t.after(async () => { peers.forEach(peer => peer.close()); await service.close(); rmSync(directory,{recursive:true,force:true}); });
  let origin = `http://127.0.0.1:${service.address.port}`, client = new CliClient(origin,admin);
  const hostId = randomUUID(), hostToken = key(), machineId = randomUUID();
  const offer = { name: 'video-websocket-fixture', provider: 'android', capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 32 }, templates: [image] };
  await new CliClient(origin,enrollment).request('POST','/v1/hosts/enroll',{id:hostId,credential:hostToken,offer});
  await client.request('POST','/v1/machines',{id:machineId,name:'video-phone',templateId:image.id,resources:{}});
  await new CliClient(origin,hostToken).request('POST',`/v1/hosts/${hostId}/heartbeat`,{offer,reports:{[machineId]:{state:'running'}}});
  const path = `/v1/machines/${machineId}/video-sessions`;
  const reserved = async () => Number(object(((await client.request('GET','/v1/hosts')).hosts as Record<string,unknown>[]).find(host => host.id === hostId)!.reserved).cpu);
  const initial = await reserved();
  async function pair(session: View) {
    const consumerPath = `${path}/${session.id}/${session.generation}`, hostPath = `/v1/hosts/${hostId}/video-sessions/${session.id}/${session.generation}`;
    const consumer = await SessionConnection.connect(origin,consumerPath,admin), host = await SessionConnection.connect(origin,hostPath,hostToken); peers.push(consumer,host);
    for (const peer of [consumer,host]) assert.deepEqual(await peer.receive(2),{type:'ready',sessionId:session.id,generation:session.generation,capability:'video'});
    return {consumer,host,consumerPath,hostPath};
  }
  const session = await client.request('POST',path,request()) as unknown as View;
  await assert.rejects(SessionConnection.connect(origin,`/v1/hosts/${randomUUID()}/video-sessions/${session.id}/${session.generation}`,hostToken));
  const first = await pair(session), metadata = {type:'video',mediaType:'video/mp4',codec:'avc1',fps:30};
  await first.host.sendControl(metadata); assert.deepEqual(await first.consumer.receive(2),metadata);
  const bytes = Buffer.from('synthetic fragmented MP4 payload'); await first.host.sendBytes(bytes); assert.deepEqual(await first.consumer.receive(2),bytes);
  const finish = {type:'finish',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),cleaned:true};
  await first.host.sendControl(finish); assert.deepEqual(await first.consumer.receive(2),finish);
  await first.consumer.sendControl({type:'ack'}); assert.deepEqual(await first.host.receive(2),{type:'ack'});
  assert.equal(await reserved(),initial + 1,'relay finish alone cannot release native reservations');
  await new CliClient(origin,hostToken).request('POST',`/v1/hosts/${hostId}/video-sessions/${session.id}/finish`,{generation:session.generation,cleaned:true});
  assert.equal(await reserved(),initial); first.host.close(); first.consumer.close();
  const nextBody = request(), next = await client.request('POST',path,nextBody) as unknown as View, second = await pair(next);
  await second.consumer.sendBytes(Buffer.from('forbidden')); await assert.rejects(second.host.receive(2));
  assert.equal(await reserved(),initial + 1); await assert.rejects(client.request('POST',path,request()),/HTTP 409/);
  await assert.rejects(new CliClient(origin,hostToken).request('POST',`/v1/hosts/${hostId}/video-sessions/${next.id}/finish`,{generation:next.generation,cleaned:false}),/HTTP 403/);
  await service.close(); service = await startController(config); origin = `http://127.0.0.1:${service.address.port}`; client = new CliClient(origin,admin);
  const replay = await client.request('POST',path,nextBody);
  assert.equal(replay.state,'disconnected'); assert.equal(replay.generation,next.generation); assert.equal(await reserved(),initial + 1);
  await assert.rejects(SessionConnection.connect(origin,second.hostPath,hostToken));
});
