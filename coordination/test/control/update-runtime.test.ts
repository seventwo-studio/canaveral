import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { chmodSync, readdirSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { HostRunner, hostTransport } from '../../src/host.ts';
import type { HostConfig } from '../../src/host.ts';
import { normalizeTemplate } from '../../src/control/templates.ts';
import { saveRecord } from '../../src/runtime-process.ts';
import { UpdateStore } from '../../src/updates/manager.ts';
import { canonicalManifest } from '../../src/updates/protocol.ts';
import type { Manifest, SignedRelease } from '../../src/updates/protocol.ts';
import { preflightManagedHost, startManagedUpdateRuntime } from '../../src/updates/runtime.ts';
const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const token = 'a'.repeat(43);
const no = { idle: false, workloadsStopped: false };
function setup(t: { after(fn: () => unknown): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-update-runtime-')));
  t.after(() => { const unseal = (path: string): void => { if (!existsSync(path)) return; if (lstatSync(path).isDirectory()) { chmodSync(path, 0o700); for (const name of readdirSync(path)) unseal(join(path, name)); } }; unseal(dir); rmSync(dir, { recursive: true, force: true }); });
  const state = join(dir, 'host'); mkdirSync(state, { mode: 0o700 });
  const config: HostConfig = { url: 'http://127.0.0.1:1', stateDir: state, name: 'fixture', provider: 'native', templates: [], capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 128 }, updates: { trustedKeys: { fixture: pem } } };
  const store = new UpdateStore({ installationRoot: join(dir, 'installation'), stateDirectory: join(dir, 'updates'), trustedKeys: { fixture: pem }, target: { os: 'linux', arch: 'amd64' }, protectedPaths: [state], minimumFreeBytes: 0 });
  const identity = { id: randomUUID(), credential: token, orchestrator: config.url };
  saveRecord(join(state, 'identity.json'), identity);
  return { dir, config, store, identity };
}
function release(sequence: number, data = Buffer.from('signed fixture')): SignedRelease {
  const manifest: Manifest = { schema: 'canaveral-update-v1', releaseId: randomUUID(), version: `1.0.${sequence}`, sequence, createdAt: 1800000000, target: { os: 'linux', arch: 'amd64' }, minimumLauncherVersion: 1, entrypoint: 'main.js', files: [{ path: 'main.js', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, executable: false, component: 'host' }] };
  return { manifest, keyId: 'fixture', signature: sign(null, canonicalManifest(manifest), keys.privateKey).toString('base64') };
}
async function install(store: UpdateStore, value = release(1)) {
  await store.stage(value, randomUUID(), async (_file, offset, length) => Buffer.from('signed fixture').subarray(offset, offset + length)); store.setActive(value.manifest.releaseId); return value;
}
function next(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('fixture IPC deadline')), 5000);
    const message = (v: unknown) => finish(undefined, v as Record<string, unknown>);
    const exit = () => finish(new Error('child exited before reply'));
    function finish(error?: Error, value?: Record<string, unknown>) { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exit); error ? reject(error) : resolve(value!); }
    child.once('message', message); child.once('exit', exit);
  });
}
async function listen(t: { after(fn: () => unknown): void }, handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const addr = server.address(); assert.ok(addr && typeof addr === 'object'); return `http://127.0.0.1:${addr.port}`;
}

test('readonly candidate preflight validates saved identity and pinned release without creating runtime state', async t => {
  const { config, store } = setup(t), value = await install(store);
  const env = { CANAVERAL_UPDATE_CANDIDATE: '1', CANAVERAL_UPDATE_RELEASE: value.manifest.releaseId, CANAVERAL_UPDATE_INSTALLATION: store.installationId, CANAVERAL_UPDATE_ROOT: store.installationRoot, CANAVERAL_UPDATE_STATE: store.stateDirectory };
  assert.deepEqual(preflightManagedHost(config, env), { releaseId: value.manifest.releaseId, installationId: store.installationId });
  assert.equal(existsSync(join(config.stateDir, 'host-runner.sqlite')), false);
  assert.throws(() => preflightManagedHost({ ...config, url: 'http://127.0.0.1:2' }, env), /another controller/);
  assert.throws(() => preflightManagedHost(config, { ...env, CANAVERAL_UPDATE_RELEASE: randomUUID() }));
  const path = join(config.stateDir, 'identity.json'), saved = readFileSync(path);
  rmSync(path); assert.throws(() => preflightManagedHost(config, env)); assert.equal(existsSync(path), false);
  writeFileSync(path, saved, { mode: 0o600 });
});

test('real child waits activation before runtime startup and commit before admission, then answers correlated status', async t => {
  const { config, store, identity } = setup(t);
  config.url = await listen(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"machines":[]}'); });
  saveRecord(join(config.stateDir, 'identity.json'), { ...identity, orchestrator: config.url });
  const value = await install(store), configPath = join(config.stateDir, 'config.json'); saveRecord(configPath, config);
  const entrypoint = new URL('../../src/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [entrypoint, '--config', configPath, '--state', config.stateDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, CANAVERAL_UPDATE_CANDIDATE: '1', CANAVERAL_UPDATE_RELEASE: value.manifest.releaseId, CANAVERAL_UPDATE_INSTALLATION: store.installationId, CANAVERAL_UPDATE_ROOT: store.installationRoot, CANAVERAL_UPDATE_STATE: store.stateDirectory } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const context = { version: 1, releaseId: value.manifest.releaseId, installationId: store.installationId };
  assert.deepEqual(await next(child), { type: 'canaveral-update-ready', ...context });
  assert.equal(existsSync(join(config.stateDir, 'host-runner.sqlite')), false);
  let reply = next(child); child.send({ type: 'canaveral-update-activate', ...context });
  assert.deepEqual(await reply, { type: 'canaveral-update-started', ...context });
  assert.equal(existsSync(join(config.stateDir, 'host-runner.sqlite')), true);
  child.send({ type: 'canaveral-update-committed', ...context });
  await new Promise(resolve => setTimeout(resolve, 50));
  const requestId = randomUUID(); reply = next(child); child.send({ type: 'canaveral-update-quiesce', requestId });
  assert.deepEqual(await reply, { type: 'canaveral-update-status', requestId, idle: true, workloadsStopped: true, quiesced: true });
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited;
});

test('idle requires fresh controller contact, empty work, retained stopped assignments and current native proof', async t => {
  const { config } = setup(t); const image = { id: 'fixture', revision: '1', os: 'linux', arch: 'amd64', mode: 'headless', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 } };
  const machine = { id: randomUUID(), templateId: 'fixture', template: normalizeTemplate(image), resources: image.minimum, desired: 'stopped' };
  let mono = 10, proof = false, reconciles = 0, sweeps = 0;
  let assigned: Record<string, unknown>[] = [machine];
  const runner = new HostRunner({ ...config, provider: 'libvirt', templates: [image] }, { clock: { now: () => mono, wall: () => 1000, suspendAware: true }, transport: { request: async () => ({ machines: assigned }) }, providerFactory: () => ({ kind: 'libvirt', check: async () => ({}), reconcile: async () => { reconciles++; return { state: 'stopped' }; }, updateStopped: async () => proof, sweep: async () => { sweeps++; } }) });
  t.after(() => runner.close()); await runner.initializeProviders(); await runner.connect();
  assert.deepEqual(await runner.updateIdle(), no); await runner.poll();
  assert.deepEqual(await runner.updateIdle(), no); proof = true;
  assert.deepEqual(await runner.updateIdle(), { idle: true, workloadsStopped: true }); assert.equal(reconciles, 0); assert.equal(sweeps, 1);
  mono = 30; assert.deepEqual(await runner.updateIdle(), no); mono = 10;
  runner.reports.set(machine.id, { state: 'unknown' }); assert.deepEqual(await runner.updateIdle(), no); runner.reports.clear();
  assigned = [{ ...machine, desired: 'running' }]; await runner.poll(); assert.deepEqual(await runner.quiesceForUpdate(), { ...no, quiesced: false });
  await runner.step(); await new Promise(resolve => setImmediate(resolve)); assert.equal(reconciles, 0);
  assigned = []; await runner.poll(); assert.deepEqual(await runner.updateIdle(), no); // Missing assignment never proves its VM stopped.
  assigned = [machine]; await runner.poll(); await runner.step(); await new Promise(resolve => setImmediate(resolve)); assert.equal(reconciles, 1); // Already stopped reconciliation remains allowed.
});

test('production parent transport downloads only assigned artifact queries and retains guest components pending', async t => {
  const { config, store, identity } = setup(t), baseline = await install(store), candidate = release(2);
  const jobId = randomUUID(), attemptId = randomUUID(); const reports: string[] = []; let downloads = 0;
  config.url = await listen(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/artifacts/')) { downloads++; assert.match(req.url, new RegExp(`jobId=${jobId}&offset=0&length=14$`)); res.end(JSON.stringify({ offset: 0, totalBytes: 14, data: Buffer.from('signed fixture').toString('base64') })); return; }
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      if (req.url?.endsWith('/poll')) res.end(JSON.stringify({ job: { id: jobId, attemptId, release: candidate } }));
      else { reports.push(JSON.parse(body).state as string); res.end('{"accepted":true}'); }
    });
  });
  saveRecord(join(config.stateDir, 'identity.json'), { ...identity, orchestrator: config.url });
  const runtime = startManagedUpdateRuntime({ config, intervalMs: 10, launcher: { store, idle: async () => ({ idle: true, workloadsStopped: true }), quiesce: async () => ({ idle: true, workloadsStopped: true, quiesced: true }), activate: async request => { store.setActive(request.releaseId); return { ...request, state: 'succeeded', installedReleaseId: request.releaseId }; }, recover: async () => undefined } });
  t.after(() => runtime.close());
  const end = Date.now() + 5000;
  while (store.job()?.phase !== 'succeeded' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  await runtime.close(); assert.equal(store.active(), candidate.manifest.releaseId); assert.notEqual(store.active(), baseline.manifest.releaseId);
  assert.equal(downloads, 1); assert.deepEqual(reports, ['draining', 'downloading', 'staged', 'activating', 'verifying', 'succeeded']);
  assert.equal(store.job()?.componentStatus.guest, 'pendingGuestReceipt'); assert.equal(store.job()?.componentStatus['native-helper'], 'pendingNativeReceipt');
  const transport = hostTransport(config);
  await assert.rejects(transport.request('GET', '/v1/updates/artifacts/' + 'a'.repeat(64) + '?jobId=bad&offset=0&length=1', {}, token));
});
