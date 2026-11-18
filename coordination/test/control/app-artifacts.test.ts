import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { SqliteStore } from '../../src/sqlite.ts';
import { ServiceError } from '../../src/errors.ts';
import { MachineStore } from '../../src/control/machines.ts';
import { createModule as devicesModule, assignedDeviceOperations, reportDeviceOperations } from '../../src/control/devices.ts';
import { createAppArtifactsModule, APP_CHUNK_BYTES } from '../../src/control/app-artifacts.ts';
import { appArtifactSource } from '../../src/app-artifact-source.ts';
import { uploadAppArtifactFile } from '../../src/app-artifact-client.ts';
import type { ControlRequest, Principal } from '../../src/control/contracts.ts';
const owner: Principal = { kind: 'token', user: { id: randomUUID(), username: 'owner', role: 'user', status: 'active' }, scopes: ['machines:read','machines:write','machines:access'] };
const other: Principal = { ...owner, user: { ...owner.user!, id: randomUUID() } };
const status = (n: number) => (e: unknown) => e instanceof ServiceError && e.status === n;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'app-artifacts-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, 'state.sqlite'), () => 1000), options = { adminToken: 'a'.repeat(43), enrollmentToken: 'e'.repeat(43), controllerId: randomUUID() };
  const machines = new MachineStore(store, options), devices = devicesModule(store, options), artifacts = createAppArtifactsModule(store, machines);
  const host = randomUUID(), credential = 'h'.repeat(43), image = { id: 'phone', revision: '1', os: 'android', arch: 'arm64', mode: 'device', device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' }, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const offer = { name: 'fixture', provider: 'android', capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 100 }, templates: [image] };
  machines.enroll({ id: host, credential, offer }, options.enrollmentToken);
  const req = (method: string, path: string, body = {}, principal = owner, token = ''): ControlRequest => ({ method, path, parts: path.split('/').filter(Boolean), body, principal: () => principal, token, query: new URLSearchParams() });
  const machine = machines.create({ id: randomUUID(), name: 'phone', templateId: 'phone', resources: {} }, req('POST', '/v1/machines'));
  machines.heartbeat(host, credential, { offer, reports: { [machine.id]: { state: 'running' } } });
  const call = async (method: string, path: string, body = {}, principal = owner, token = '') => {
    const request = req(method, path, body, principal, token), result = await artifacts.handle(request) ?? await devices.handle(request);
    assert.ok(result); return result.body as Record<string, any>;
  };
  const bytes = Buffer.alloc(APP_CHUNK_BYTES + 17, 42), hash = createHash('sha256').update(bytes).digest('hex'), id = randomUUID();
  const metadata = { id, format: 'apk', bytes: bytes.length, sha256: hash };
  const create = (body = metadata, principal = owner) => call('POST', `/v1/machines/${machine.id}/app-artifacts`, body, principal);
  const chunk = (offset: number, value: Buffer) => call('POST', `/v1/app-artifacts/${id}/chunks`, { offset, data: value.toString('base64') });
  const complete = () => call('POST', `/v1/app-artifacts/${id}/complete`);
  const upload = async () => { await create(); await chunk(0, bytes.subarray(0, APP_CHUNK_BYTES)); await chunk(APP_CHUNK_BYTES, bytes.subarray(APP_CHUNK_BYTES)); return complete(); };
  const operation = { id: randomUUID(), action: 'install-uploaded', arguments: { artifact: id } };
  const submit = () => call('POST', `/v1/machines/${machine.id}/operations`, operation);
  return { root, store, machines, machine, host, credential, call, bytes, hash, id, metadata, create, chunk, complete, upload, operation, submit };
}

test('artifact chunks resume immutably, require a complete digest, and reserve host scratch', async t => {
  const f = fixture(t), before = f.machines.remainingCapacity;
  const available = () => f.store.transaction(db => before.call(f.machines, db, f.host).diskGiB);
  const initial = available(); await f.create(); assert.equal(available(), initial - 2);
  await f.create(); assert.equal(available(), initial - 2);
  await assert.rejects(f.create({ ...f.metadata, sha256: '0'.repeat(64) }), status(409));
  await assert.rejects(f.chunk(APP_CHUNK_BYTES, f.bytes.subarray(APP_CHUNK_BYTES)), status(409));
  await f.chunk(0, f.bytes.subarray(0, APP_CHUNK_BYTES)); await f.chunk(0, f.bytes.subarray(0, APP_CHUNK_BYTES));
  await assert.rejects(f.chunk(0, Buffer.alloc(APP_CHUNK_BYTES, 1)), status(409)); await assert.rejects(f.complete(), status(409));
  await f.chunk(APP_CHUNK_BYTES, f.bytes.subarray(APP_CHUNK_BYTES)); assert.equal((await f.complete()).state, 'ready');
  assert.equal((await f.complete()).state, 'ready');
  await f.call('POST', `/v1/app-artifacts/${f.id}/delete`); assert.equal(available(), initial);
});

test('owner scope, platform, digest and assignment changes refuse artifacts before dispatch', async t => {
  const f = fixture(t);
  await assert.rejects(f.create(f.metadata, other), status(404));
  await assert.rejects(f.create({ ...f.metadata, format: 'ios-app-tar' }), status(400));
  await assert.rejects(f.create(f.metadata, { ...owner, scopes: ['machines:read'] }), status(403));
  await f.create({ ...f.metadata, sha256: '0'.repeat(64) });
  await f.chunk(0, f.bytes.subarray(0, APP_CHUNK_BYTES)); await f.chunk(APP_CHUNK_BYTES, f.bytes.subarray(APP_CHUNK_BYTES));
  await assert.rejects(f.complete(), status(409)); await assert.rejects(f.submit(), status(409));
  f.store.transaction(db => db.prepare('UPDATE machines SET owner=? WHERE id=?').run(other.user!.id, f.machine.id));
  await assert.rejects(f.call('GET', `/v1/app-artifacts/${f.id}`, {}, other), status(409));
});

test('only the owner can upload, submit install-uploaded and inspect its receipt', async t => {
  const f = fixture(t), item = `/v1/app-artifacts/${f.id}`;
  await f.create();
  await assert.rejects(f.call('GET', item, {}, other), status(404));
  await assert.rejects(f.call('POST', item + '/chunks', { offset: 0, data: f.bytes.subarray(0, APP_CHUNK_BYTES).toString('base64') }, other), status(404));
  await f.chunk(0, f.bytes.subarray(0, APP_CHUNK_BYTES));
  await f.chunk(APP_CHUNK_BYTES, f.bytes.subarray(APP_CHUNK_BYTES));
  await assert.rejects(f.call('POST', item + '/complete', {}, other), status(404));
  assert.equal((await f.complete()).state, 'ready');
  await assert.rejects(f.call('POST', `/v1/machines/${f.machine.id}/operations`, f.operation, other), status(404));
  const submitted = await f.submit(), receipt = `/v1/operations/${f.operation.id}`;
  assert.equal(submitted.state, 'queued');
  assert.deepEqual(await f.call('GET', receipt), submitted);
  await assert.rejects(f.call('GET', receipt, {}, other), status(404));
});

test('outbound host download is bound to the exact operation and source digest', async t => {
  const f = fixture(t); await f.upload(); await f.submit();
  f.store.transaction(db => assert.equal(assignedDeviceOperations(db, f.host, 1000)[0]!.expiresAt, 2800));
  const prefix = `/v1/hosts/${f.host}/app-artifacts/${f.id}/operations/${f.operation.id}`;
  await assert.rejects(f.call('GET', prefix, {}, owner, 'x'.repeat(43)), status(401));
  await assert.rejects(f.call('GET', prefix.replace(f.operation.id, randomUUID()), {}, owner, f.credential), status(403));
  await assert.rejects(f.call('POST', `/v1/app-artifacts/${f.id}/delete`), status(409));
  await assert.rejects(f.call('POST', `/v1/machines/${f.machine.id}/operations`, { ...f.operation, id: randomUUID() }), status(409));
  let allowed = true;
  const { source, sha256 } = await appArtifactSource(path => f.call('GET', path, {}, owner, f.credential), prefix, { artifact: f.id, machine: f.machine.id, format: 'apk' }, () => allowed);
  assert.equal(sha256, f.hash); assert.equal(await source.verify(), true);
  const parts: Buffer[] = []; for (;;) { const b = Buffer.from(await source.read(65536)); if (!b.length) break; parts.push(b); }
  assert.deepEqual(Buffer.concat(parts), f.bytes); assert.equal(await source.verify(), true); assert.equal((await source.read(1)).length, 0);
  allowed = false; await assert.rejects(source.verify(), status(401)); await source.close();
  f.store.transaction(db => reportDeviceOperations(db, f.host, { [f.operation.id]: { state: 'succeeded', result: { artifactCleaned: true } } }, 1000));
  await assert.rejects(f.call('GET', prefix, {}, owner, f.credential), status(403));
  assert.equal((await f.call('POST', `/v1/app-artifacts/${f.id}/delete`)).state, 'deleted');
});

test('unknown installation preserves uploaded bytes and host reservations', async t => {
  const f = fixture(t); await f.upload(); await f.submit();
  f.store.transaction(db => { assignedDeviceOperations(db, f.host, 1000); reportDeviceOperations(db, f.host, { [f.operation.id]: { state: 'unknown', result: {} } }, 1000); });
  await assert.rejects(f.call('POST', `/v1/app-artifacts/${f.id}/delete`), status(409));
  await assert.rejects(f.call('POST', `/v1/machines/${f.machine.id}/operations`, { ...f.operation, id: randomUUID() }), status(409));
  assert.equal((await f.call('GET', `/v1/app-artifacts/${f.id}`)).state, 'ready');
});

test('CI file helper resumes confirmed chunks without installing or buffering the whole build', async t => {
  const f = fixture(t), file = join(f.root, 'ci.apk'); writeFileSync(file, f.bytes);
  await f.create(); await f.chunk(0, f.bytes.subarray(0, APP_CHUNK_BYTES));
  const calls: string[] = [], client = { request: async (method: string, path: string, body = {}) => { calls.push(path); return f.call(method, path, body); } };
  const ready = await uploadAppArtifactFile(client, { id: f.id, machineId: f.machine.id, format: 'apk', file });
  assert.equal(ready.state, 'ready'); assert.equal(calls.filter(p => p.endsWith('/chunks')).length, 1);
  assert.ok(!calls.some(p => p.endsWith('/operations')));
  calls.length = 0; await uploadAppArtifactFile(client, { id: f.id, machineId: f.machine.id, format: 'apk', file }); assert.equal(calls.length, 1);
});
