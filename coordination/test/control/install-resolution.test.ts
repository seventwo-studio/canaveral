import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { SqliteStore } from '../../src/sqlite.ts';
import { MachineStore } from '../../src/control/machines.ts';
import { createModule as devicesModule, assignedDeviceOperations, reportDeviceOperations } from '../../src/control/devices.ts';
import { createModule as lifecycleModule } from '../../src/control/lifecycle.ts';
import { createAppArtifactsModule, APP_CHUNK_BYTES } from '../../src/control/app-artifacts.ts';
import type { ControlRequest, Principal } from '../../src/control/contracts.ts';
import { AndroidProvider } from '../../src/providers/android.ts';
import { IosProvider } from '../../src/providers/ios.ts';
import { digest, saveJson } from '../../src/providers/mobile.ts';
import type { MobileProvider, RecordValue } from '../../src/providers/mobile.ts';
import { ServiceError, object } from '../../src/errors.ts';
import { CliClient } from '../../src/account-cli.ts';
import { main as cli } from '../../src/cli.ts';
import { uploadAppArtifactFile } from '../../src/app-artifact-client.ts';
import { startController } from '../../src/main.ts';
import { HostRunner, hostTransport } from '../../src/host.ts';
import type { HostConfig } from '../../src/host.ts';

const owner: Principal = { kind: 'token', user: { id: randomUUID(), username: 'owner', role: 'user', status: 'active' }, scopes: ['machines:read', 'machines:write', 'machines:access'] };
const other: Principal = { ...owner, user: { ...owner.user!, id: randomUUID(), username: 'other' } };
const admin: Principal = { kind: 'token', user: { id: randomUUID(), username: 'admin', role: 'admin', status: 'active' }, scopes: ['admin'] };
const status = (n: number) => (e: unknown) => e instanceof ServiceError && e.status === n;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'install-resolution-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(path.join(root, 'state.sqlite'), () => 1000), options = { adminToken: 'a'.repeat(43), enrollmentToken: 'e'.repeat(43), controllerId: randomUUID() };
  const machines = new MachineStore(store, options), devices = devicesModule(store, options), lifecycle = lifecycleModule(store, options), artifacts = createAppArtifactsModule(store, machines);
  const host = randomUUID(), credential = 'h'.repeat(43), image = { id: 'phone', revision: '1', os: 'android', arch: 'arm64', mode: 'device', device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' }, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const offer = { name: 'fixture', provider: 'android', capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 100 }, templates: [image] };
  machines.enroll({ id: host, credential, offer }, options.enrollmentToken);
  const req = (method: string, p: string, body = {}, principal = owner): ControlRequest => ({ method, path: p, parts: p.split('/').filter(Boolean), body, principal: () => principal, token: '', query: new URLSearchParams() });
  const machine = machines.create({ id: randomUUID(), name: 'phone', templateId: 'phone', resources: {} }, req('POST', '/v1/machines'));
  const observe = (state: string) => machines.heartbeat(host, credential, { offer, reports: { [machine.id]: { state } } });
  observe('running');
  const call = async (method: string, p: string, body = {}, principal = owner) => {
    const request = req(method, p, body, principal), result = await artifacts.handle(request) ?? await devices.handle(request) ?? await lifecycle.handle(request);
    assert.ok(result); return result.body as Record<string, any>;
  };
  const available = () => store.transaction(db => machines.remainingCapacity(db, host).diskGiB);
  const bytes = Buffer.alloc(APP_CHUNK_BYTES + 17, 42), artifact = randomUUID();
  const install = { id: randomUUID(), action: 'install-uploaded', arguments: { artifact } };
  const ops = `/v1/machines/${machine.id}/operations`, resolve = `/v1/operations/${install.id}/resolve`;
  const report = (id: string, state: string, result: unknown) => store.transaction(db => {
    assert.equal(assignedDeviceOperations(db, host, 1000)[0]?.id, id);
    reportDeviceOperations(db, host, { [id]: { state, result } }, 1000);
  });
  /** The observed case: the install was dispatched and its outcome became unknown. */
  const uncertainInstall = async () => {
    const initial = available();
    await call('POST', `/v1/machines/${machine.id}/app-artifacts`, { id: artifact, format: 'apk', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await call('POST', `/v1/app-artifacts/${artifact}/chunks`, { offset: 0, data: bytes.subarray(0, APP_CHUNK_BYTES).toString('base64') });
    await call('POST', `/v1/app-artifacts/${artifact}/chunks`, { offset: APP_CHUNK_BYTES, data: bytes.subarray(APP_CHUNK_BYTES).toString('base64') });
    await call('POST', `/v1/app-artifacts/${artifact}/complete`);
    await call('POST', ops, install);
    report(install.id, 'unknown', { detail: 'Dispatched work outcome requires inspection; it is not replayed.' });
    return initial;
  };
  const inspection = (id = randomUUID(), args: Record<string, unknown> = { operation: install.id, artifact }) => ({ id, action: 'inspect-install', arguments: args });
  return { store, machine, artifact, install, ops, resolve, call, report, available, observe, uncertainInstall, inspection };
}

test('install inspection and resolution are owner-scoped and hide another account\'s operations', async t => {
  const f = fixture(t); await f.uncertainInstall();
  const look = f.inspection();
  await assert.rejects(f.call('POST', f.ops, look, other), status(404));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleanup-confirmed', inspection: look.id, reason: 'x' }, other), status(404));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'abandoned', inspection: null, reason: 'x' }, other), status(404));
  await assert.rejects(f.call('GET', `/v1/operations/${f.install.id}`, {}, other), status(404));
  await assert.rejects(f.call('POST', f.ops, look, { ...owner, scopes: ['machines:read'] }), status(403));
  // Once ownership moves to another account, the former owner cannot inspect.
  f.store.transaction(db => db.prepare('UPDATE machines SET owner=? WHERE id=?').run(other.user!.id, f.machine.id));
  await assert.rejects(f.call('POST', f.ops, look), status(404));
});

test('positive runner evidence plus an owner decision releases the reservation; retries and lost responses are idempotent', async t => {
  const f = fixture(t), initial = await f.uncertainInstall(), reserved = f.available();
  assert.ok(reserved < initial);
  await assert.rejects(f.call('POST', `/v1/app-artifacts/${f.artifact}/delete`), status(409));
  // Wrong targets and decisions without evidence are refused.
  await assert.rejects(f.call('POST', f.ops, f.inspection(randomUUID(), { operation: f.install.id, artifact: randomUUID() })), status(409));
  await assert.rejects(f.call('POST', f.ops, f.inspection(randomUUID(), { operation: randomUUID(), artifact: f.artifact })), status(409));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleanup-confirmed', inspection: null, reason: 'looks clean' }), status(409));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'abandoned', inspection: null, reason: 'owner gives up' }), status(403));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleaned', inspection: null, reason: 'x' }), status(400));
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleanup-confirmed', inspection: null, reason: ' ' }), status(400));

  // First inspection: the runner cannot prove cleanup. Its evidence cannot confirm.
  const first = f.inspection(), queued = await f.call('POST', f.ops, first);
  assert.equal(queued.state, 'queued'); assert.deepEqual(await f.call('POST', f.ops, first), queued);
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleanup-confirmed', inspection: first.id, reason: 'pending' }), status(409));
  f.report(first.id, 'succeeded', { operation: f.install.id, artifact: f.artifact, providerReceipt: 'started', stagedArtifacts: 'not-inspectable', artifactCleaned: false });
  await assert.rejects(f.call('POST', f.resolve, { id: randomUUID(), decision: 'cleanup-confirmed', inspection: first.id, reason: 'no' }), status(409));
  assert.equal(f.available(), reserved);

  // Second inspection reports positive evidence (e.g. the provider journal never started).
  const second = f.inspection(); await f.call('POST', f.ops, second);
  f.report(second.id, 'succeeded', { operation: f.install.id, artifact: f.artifact, providerReceipt: 'absent', stagedArtifacts: 'absent', artifactCleaned: true });
  assert.equal(f.available(), reserved);
  const decision = { id: randomUUID(), decision: 'cleanup-confirmed', inspection: second.id, reason: 'Provider journal has no receipt; no stage remains.' };
  await f.call('POST', f.resolve, decision); // Response lost: the client retries the same body.
  const record = await f.call('POST', f.resolve, decision);
  assert.deepEqual(record, { id: decision.id, operationId: f.install.id, decision: 'cleanup-confirmed', inspectionId: second.id, reason: decision.reason,
    decidedBy: { kind: 'token', userId: owner.user!.id, username: 'owner' }, decidedAt: 1000 });
  await assert.rejects(f.call('POST', f.resolve, { ...decision, reason: 'changed' }), status(409));
  await assert.rejects(f.call('POST', f.resolve, { ...decision, id: randomUUID() }), status(409));
  await assert.rejects(f.call('POST', f.resolve, decision, other), status(404));
  await assert.rejects(f.call('POST', f.ops, f.inspection()), status(409));

  // The install outcome stays unknown; the decision is attached as an audit record.
  const receipt = await f.call('GET', `/v1/operations/${f.install.id}`);
  assert.equal(receipt.state, 'unknown'); assert.deepEqual(receipt.resolution, record);
  assert.equal(f.available(), reserved);
  assert.equal((await f.call('POST', `/v1/app-artifacts/${f.artifact}/delete`)).state, 'deleted');
  assert.equal(f.available(), initial);
});

test('only an administrator can abandon unproven cleanup, and machine deletion waits for that decision', async t => {
  const f = fixture(t), initial = await f.uncertainInstall(), reserved = f.available();
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(f.machine.id)); f.observe('stopped');
  const deletion = { id: randomUUID() };
  await assert.rejects(f.call('POST', `/v1/machines/${f.machine.id}/delete`, deletion), (e: unknown) => e instanceof ServiceError && e.status === 409 && /resolve the uncertain app installation/.test(e.message));
  const decision = { id: randomUUID(), decision: 'abandoned', inspection: null, reason: 'Simulator removed out of band; operator accepts residue.' };
  await assert.rejects(f.call('POST', f.resolve, decision), status(403));
  await assert.rejects(f.call('POST', f.resolve, decision, { ...admin, scopes: ['machines:access'] }), status(403));
  assert.equal(f.available(), reserved);
  const record = await f.call('POST', f.resolve, decision, admin);
  assert.deepEqual(record.decidedBy, { kind: 'token', userId: admin.user!.id, username: 'admin' });
  assert.deepEqual(await f.call('POST', f.resolve, decision, admin), record);
  assert.equal((await f.call('GET', `/v1/operations/${f.install.id}`)).resolution.decision, 'abandoned');
  assert.equal(f.available(), reserved);
  assert.equal((await f.call('POST', `/v1/app-artifacts/${f.artifact}/delete`)).state, 'deleted');
  assert.equal(f.available(), initial);
  assert.equal((await f.call('POST', `/v1/machines/${f.machine.id}/delete`, deletion)).state, 'queued');
});

function providerFixture(t: TestContext, platform: 'ios' | 'android') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'install-inspect-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image: RecordValue = platform === 'ios'
    ? { id: 'ios-phone', revision: '1', os: 'ios', arch: 'arm64', mode: 'device', device: { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' } }
    : { id: 'android', revision: '1', os: 'android', arch: 'arm64', mode: 'device', device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
  const machine: RecordValue = { id: randomUUID(), template: image, desired: 'running', resources: { cpu: 2, memoryMiB: 4096, diskGiB: 12 } };
  const transport = { run: async () => { throw new Error('Inspection must not run native commands.'); } };
  const provider: MobileProvider = platform === 'ios' ? new IosProvider({ storage: path.join(root, 'storage'), transport }, root) : new AndroidProvider({ storage: path.join(root, 'storage'), androidSDK: '/fixture/sdk', transport }, root);
  const dir = provider.storage(machine, image), install = { id: randomUUID(), action: 'install-uploaded', arguments: { artifact: randomUUID() } };
  fs.mkdirSync(path.join(dir, 'operations'), { recursive: true, mode: 0o700 });
  const fingerprint = digest({ binding: provider.binding(machine, image), ...install });
  const inspect = async (args = { operation: install.id, artifact: install.arguments.artifact }) => {
    const operation = { id: randomUUID(), action: 'inspect-install', arguments: args, expiresAt: Date.now() / 1000 + 60 };
    return provider.operate(machine, image, root, operation, () => true, request => provider.inspectInstall(machine, image, request.arguments));
  };
  return { provider, dir, install, fingerprint, inspect, receipt: path.join(dir, 'operations', install.id + '.json') };
}

test('iOS inspection proves cleanup only from an absent journal, a cleaned receipt or no remaining stage', async t => {
  const f = providerFixture(t, 'ios');
  const absent = await f.inspect();
  assert.deepEqual(absent, { state: 'succeeded', result: { operation: f.install.id, artifact: f.install.arguments.artifact, providerReceipt: 'absent', stagedArtifacts: 'absent', artifactCleaned: true } });
  saveJson(f.receipt, { fingerprint: f.fingerprint, started: true });
  fs.mkdirSync(path.join(f.dir, '.artifact-leftover'), { mode: 0o700 });
  const present = await f.inspect();
  assert.equal(present.state, 'succeeded'); assert.deepEqual([present.result.providerReceipt, present.result.stagedArtifacts, present.result.artifactCleaned], ['started', 'present', false]);
  assert.ok(fs.existsSync(path.join(f.dir, '.artifact-leftover')), 'inspection never removes evidence');
  fs.rmdirSync(path.join(f.dir, '.artifact-leftover'));
  const cleaned = await f.inspect();
  assert.deepEqual([cleaned.result.providerReceipt, cleaned.result.stagedArtifacts, cleaned.result.artifactCleaned], ['started', 'absent', true]);
  saveJson(f.receipt, { fingerprint: 'foreign', started: true });
  const foreign = await f.inspect();
  assert.equal(foreign.state, 'unknown');
  // A busy assignment lock is not evidence; the caller's durable journal records the uncertainty.
  fs.writeFileSync(path.join(f.dir, 'assignment.lock'), '');
  await assert.rejects(f.inspect(), (e: unknown) => e instanceof ServiceError && e.code === 'assignment_busy');
});

test('Android inspection cannot see package-session staging and confirms only unstarted or cleaned installs', async t => {
  const f = providerFixture(t, 'android');
  assert.equal((await f.inspect()).result.artifactCleaned, true);
  fs.writeFileSync(f.receipt + '.' + randomUUID() + '.tmp', '{}');
  const partial = await f.inspect();
  assert.deepEqual([partial.result.providerReceipt, partial.result.stagedArtifacts, partial.result.artifactCleaned], ['partial', 'not-inspectable', false]);
  saveJson(f.receipt, { fingerprint: f.fingerprint, report: { state: 'unknown', result: { detail: 'commit unconfirmed' } } });
  const uncertain = await f.inspect();
  assert.deepEqual([uncertain.result.providerReceipt, uncertain.result.artifactCleaned], ['unknown', false]);
  saveJson(f.receipt, { fingerprint: f.fingerprint, report: { state: 'succeeded', result: { installed: true, artifactCleaned: true } } });
  assert.equal((await f.inspect()).result.artifactCleaned, true);
});

/** Real loopback controller, runner, journals and CLI; no native SDK or device. */
test('runner inspection resolves the observed busy-lock unknown install end to end', { timeout: 30000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'install-resolution-runner-')));
  const adminToken = randomBytes(32).toString('base64url'), enrollment = randomBytes(32).toString('base64url');
  const adminFile = path.join(root, 'admin.token'), enrollmentFile = path.join(root, 'enrollment.token');
  fs.writeFileSync(adminFile, adminToken, { mode: 0o600 }); fs.writeFileSync(enrollmentFile, enrollment, { mode: 0o600 });
  let runner: HostRunner | undefined;
  const controller = await startController({ statePath: path.join(root, 'controller.sqlite'), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  t.after(async () => { await runner?.close(); await controller.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${controller.address.port}`, client = new CliClient(url, adminToken);
  const image: RecordValue = { id: 'android-fixture', revision: '1', os: 'android', arch: 'arm64', mode: 'device',
    minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
  const config: HostConfig = { url, stateDir: path.join(root, 'runner'), enrollmentToken: enrollment, name: 'inspection-runner', provider: 'android',
    storage: path.join(root, 'devices'), templates: [image], capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 }, pollIntervalSeconds: .25, concurrency: 3 };
  let installs = 0;
  class FixtureMobileProvider extends AndroidProvider {
    override async check() { return { ready: true, nativeAcceptance: false }; }
    override async reconcile(machine: RecordValue, image: RecordValue) { this.storage(machine, image); return { state: machine.desired }; }
    override async installArtifact(): Promise<RecordValue> { installs++; throw new Error('The busy lock must prevent provider dispatch.'); }
  }
  const clock = { suspendAware: true, now: () => performance.now() / 1000, wall: () => Date.now() / 1000 };
  runner = new HostRunner(config, { transport: hostTransport(config), clock, providerFactory: (settings, state) => new FixtureMobileProvider({ ...settings,
    transport: { run: async () => { throw new Error('Native commands are forbidden in this fixture.'); }, elapsed: clock.now } }, state) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  const hostId = runner.identity!.id, machineId = randomUUID();
  await client.request('POST', '/v1/machines', { id: machineId, name: 'inspection-phone', templateId: image.id, resources: image.minimum });
  async function settle(check: () => boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!check() && performance.now() < deadline) { await runner!.poll(); await runner!.step(); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(check(), JSON.stringify({ reports: [...runner!.reports], operations: [...runner!.deviceReports] })); await runner!.poll();
  }
  await settle(() => runner!.reports.get(machineId)?.state === 'running');
  const reservedDisk = async () => Number(object(((await client.request('GET', '/v1/hosts')).hosts as RecordValue[]).find(h => h.id === hostId)!.reserved).diskGiB);
  const initial = await reservedDisk(), artifactId = randomUUID(), file = path.join(root, 'build.apk');
  fs.writeFileSync(file, Buffer.alloc(70000, 9), { mode: 0o600 });
  await uploadAppArtifactFile(client, { machineId, id: artifactId, format: 'apk', file });
  const reserved = await reservedDisk(); assert.ok(reserved > initial);

  // Reproduce the observed race: the provider's assignment lock is busy at dispatch.
  const lock = path.join(config.storage as string, machineId, 'assignment.lock'); fs.writeFileSync(lock, '');
  const installId = randomUUID();
  await client.request('POST', `/v1/machines/${machineId}/operations`, { id: installId, action: 'install-uploaded', arguments: { artifact: artifactId } });
  await settle(() => runner!.deviceReports.get(installId)?.state === 'unknown');
  const unknown = await client.request('GET', `/v1/operations/${installId}`);
  assert.equal(unknown.state, 'unknown'); assert.match(String(object(unknown.result).detail), /requires inspection/);
  assert.equal(installs, 0); assert.ok(!fs.existsSync(path.join(config.storage as string, machineId, 'operations', installId + '.json')));
  await assert.rejects(client.request('POST', `/v1/app-artifacts/${artifactId}/delete`, {}), /HTTP 409/);
  fs.unlinkSync(lock);

  const inspectionId = randomUUID();
  await client.request('POST', `/v1/machines/${machineId}/operations`, { id: inspectionId, action: 'inspect-install', arguments: { operation: installId, artifact: artifactId } });
  await settle(() => runner!.deviceReports.get(inspectionId)?.state === 'succeeded');
  const inspected = await client.request('GET', `/v1/operations/${inspectionId}`);
  assert.deepEqual(inspected.result, { operation: installId, artifact: artifactId, providerReceipt: 'absent', stagedArtifacts: 'not-inspectable', artifactCleaned: true });
  assert.equal(await reservedDisk(), reserved);

  const decisionFile = path.join(root, 'resolve.json');
  fs.writeFileSync(decisionFile, JSON.stringify({ id: randomUUID(), decision: 'cleanup-confirmed', inspection: inspectionId, reason: 'Provider journal has no receipt; dispatch never reached the provider.' }), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    let output = '', errors = '';
    assert.equal(await cli(['--url', url, '--token-file', adminFile, 'operation', installId, '--resolve-file', decisionFile], { stdout: s => { output += s; }, stderr: s => { errors += s; } }), 0, errors);
    assert.deepEqual(JSON.parse(output).decidedBy, { kind: 'operator', userId: null, username: null });
  }
  assert.equal((await client.request('GET', `/v1/operations/${installId}`)).state, 'unknown');
  assert.equal(await reservedDisk(), reserved);
  assert.equal((await client.request('POST', `/v1/app-artifacts/${artifactId}/delete`, {})).state, 'deleted');
  assert.equal(await reservedDisk(), initial);
  assert.equal(installs, 0);
});
