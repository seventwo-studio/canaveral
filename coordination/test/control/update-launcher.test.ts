import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedUpdater, UpdateStore, atomicUpdateJSON } from '../../src/updates/manager.ts';
import { StableLauncher } from '../../src/updates/launcher.ts';
import { fixture, controller } from './update-manager-fixtures.test.ts';

function candidate(mode: 'ready' | 'fail' | 'silent' = 'ready'): string {
  return `import {readFileSync} from 'node:fs';
const configPath=process.argv[process.argv.indexOf('--config')+1];
const config=()=>JSON.parse(readFileSync(configPath,'utf8'));
const identity={version:1,releaseId:process.env.CANAVERAL_UPDATE_RELEASE,installationId:process.env.CANAVERAL_UPDATE_INSTALLATION};
let committed=false;
process.on('SIGTERM',()=>{if(config().stop!==false)process.exit(0)});
process.on('message',m=>{
 if(m.type==='canaveral-update-activate') { ${mode === 'fail' ? 'process.exit(17);' : mode === 'silent' ? '' : "process.send({type:'canaveral-update-started',...identity});"} }
 else if(m.type==='canaveral-update-committed') {committed=true; if(config().dropAck!==identity.releaseId)process.send({type:'canaveral-update-committed-ack',...identity});}
 else if(m.type==='canaveral-update-status'||m.type==='canaveral-update-quiesce') {const idle=committed&&!config().active&&config().activeRelease!==identity.releaseId; process.send({type:'canaveral-update-status',requestId:m.requestId,idle,workloadsStopped:idle,quiesced:idle&&m.type==='canaveral-update-quiesce'});}
});
process.send({type:'canaveral-update-ready',...identity});
setInterval(()=>{},1000);
`;
}
async function managed(t: import('node:test').TestContext, mode: 'ready' | 'fail' | 'silent' = 'ready') {
  const f = fixture(); const store = new UpdateStore(f.options), baseline = f.release(1, candidate()); await f.bootstrap(store, baseline);
  const launcher = new StableLauncher({ ...f.options, hostConfigPath: f.config, hostStateDirectory: f.hostState, readinessTimeoutMs: 1500, stopTimeoutMs: 200 });
  t.after(async () => { writeFileSync(f.config, JSON.stringify({ active: false, stop: true }), { mode: 0o600 }); await launcher.close({ idle: true, workloadsStopped: true, quiesced: true }); });
  await launcher.start();
  const next = f.release(2, candidate(mode)), c = controller(next);
  const updater = new ManagedUpdater({ ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle: { idle: () => launcher.idle(), quiesce: () => launcher.quiesce(), activation: launcher } });
  t.after(async () => { await updater.close(); f.cleanup(); });
  await updater.poll(); await updater.step(); await updater.step();
  return { f, store, baseline, next, c, launcher, updater };
}

test('real Node candidate starts through readiness, atomically commits, then reports ordered success', async t => {
  const { store, next, c, updater, launcher, f } = await managed(t);
  const job = await updater.step(); assert.equal(job?.phase, 'succeeded'); assert.equal(store.active(), next.envelope.manifest.releaseId);
  assert.deepEqual(c.reports.map(r => r.state), ['draining', 'downloading', 'staged', 'activating', 'verifying', 'succeeded']);
  assert.equal(c.reports.at(-1)?.installedReleaseId, next.envelope.manifest.releaseId); assert.equal(store.highwater().sequence, 2);
  assert.equal(readFileSync(join(f.hostState, 'identity.json'), 'utf8'), '{"retained":true}'); assert.equal((await launcher.idle()).idle, true);
});

test('real startup failure and readiness deadline restore only the exact verified baseline', async t => {
  for (const mode of ['fail', 'silent'] as const) {
    await t.test(mode, async sub => {
      const { store, baseline, c, updater, launcher } = await managed(sub, mode);
      const job = await updater.step(); assert.equal(job?.phase, 'rolledBack'); assert.equal(store.active(), baseline.envelope.manifest.releaseId);
      assert.deepEqual(c.reports.map(r => r.state), ['draining', 'downloading', 'staged', 'activating', 'verifying', 'rolledBack']);
      assert.equal(c.reports.at(-1)?.installedReleaseId, baseline.envelope.manifest.releaseId); assert.equal(store.highwater().sequence, 2);
      assert.equal((await launcher.idle()).idle, true);
    });
  }
});

test('uncertain old-child stop retains baseline, highwater and attempt without launching candidate', async t => {
  const { f, store, baseline, next, updater, c, launcher } = await managed(t);
  writeFileSync(f.config, JSON.stringify({ active: false, stop: false }), { mode: 0o600 });
  await updater.step(); assert.equal(store.job()?.phase, 'unknown'); assert.equal(store.active(), baseline.envelope.manifest.releaseId);
  assert.equal(store.job()?.attemptId, c.attemptId); const request = { jobId: c.id, attemptId: c.attemptId, releaseId: next.envelope.manifest.releaseId, installationId: store.installationId };
  assert.equal((await launcher.activate(request)).state, 'unknown'); await updater.step(); assert.equal(store.job()?.phase, 'unknown');
  assert.equal(store.highwater().sequence, 2); assert.equal(store.verifyInstalled(next.envelope.manifest.releaseId).manifest.sequence, 2);
});

test('positive local workload gate is required again immediately before process activation', async t => {
  const { f, store, baseline, updater, c, launcher } = await managed(t);
  writeFileSync(f.config, JSON.stringify({ active: true, stop: true }), { mode: 0o600 });
  await updater.step(); assert.equal(store.job()?.phase, 'staged'); assert.equal(store.active(), baseline.envelope.manifest.releaseId); assert.equal(c.reports.length, 3);
  await assert.rejects(launcher.close(), /idle\/quiesce/);
});

test('candidate tamper cannot change active pointer or terminate the baseline', async t => {
  const { store, next, baseline, updater, launcher } = await managed(t);
  const path = join(store.releasePath(next.envelope.manifest.releaseId), 'host.mjs'); chmodSync(path, 0o600); writeFileSync(path, 'process.exit(0)'); chmodSync(path, 0o400);
  await assert.rejects(updater.step(), /size|digest/); assert.equal(store.active(), baseline.envelope.manifest.releaseId); assert.equal((await launcher.idle()).idle, true);
});

test('durable uncertain launch/spawn records prevent fresh children after parent crash', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1, candidate()));
  atomicUpdateJSON(join(store.stateDirectory, 'launcher-runtime.json'), { installationId: store.installationId, state: 'running', pid: 999999 });
  const launcher = new StableLauncher({ ...f.options, hostConfigPath: f.config, hostStateDirectory: f.hostState }); t.after(() => launcher.close());
  await assert.rejects(launcher.start(), /stop is uncertain/);
  atomicUpdateJSON(join(store.stateDirectory, 'launcher-runtime.json'), { installationId: store.installationId, state: 'stopped' });
  atomicUpdateJSON(join(store.stateDirectory, 'launcher-transaction.json'), { installationId: store.installationId, jobId: randomUUID(), attemptId: randomUUID(), releaseId: randomUUID(), phase: 'starting' });
  await assert.rejects(launcher.start(), /Uncertain prior activation/);
});


test('post-spawn runtime journal EIO retains candidate ownership and proves its exit before baseline launch', async t => {
  const { store, baseline, next, updater, launcher } = await managed(t);
  const original = fs.renameSync; let injected = false, candidatePid: number | undefined, observedBeforeRestore = false;
  const restore = (): void => { fs.renameSync = original; syncBuiltinESMExports(); };
  t.after(restore);
  fs.renameSync = ((source, destination) => {
    if (String(destination).endsWith('/launcher-runtime.json')) {
      const record = JSON.parse(readFileSync(source, 'utf8')) as { releaseId: string; state: string; pid?: number };
      if (!injected && record.releaseId === next.envelope.manifest.releaseId && record.state === 'running') {
        injected = true; candidatePid = record.pid; assert.ok(candidatePid); process.kill(candidatePid, 0);
        throw Object.assign(new Error('deterministic post-spawn journal failure'), { code: 'EIO' });
      }
      if (injected && record.releaseId === baseline.envelope.manifest.releaseId && record.state === 'starting') {
        assert.ok(candidatePid); assert.throws(() => process.kill(candidatePid!, 0), { code: 'ESRCH' }); observedBeforeRestore = true;
      }
    }
    return original(source, destination);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    await updater.step(); assert.equal(injected, true); assert.equal(observedBeforeRestore, true);
    assert.equal(store.job()?.phase, 'rolledBack'); assert.equal(store.active(), baseline.envelope.manifest.releaseId); assert.equal((await launcher.idle()).idle, true);
  } finally { restore(); }
});

test('commit intent has no terminal recovery receipt; lost acknowledgement retains the admitted candidate', async t => {
  const { store, next, c, f, updater, launcher } = await managed(t);
  writeFileSync(f.config, JSON.stringify({ active: false, stop: true, dropAck: next.envelope.manifest.releaseId, activeRelease: next.envelope.manifest.releaseId }), { mode: 0o600 });
  const operation = updater.step(); const path = join(store.stateDirectory, 'launcher-transaction.json');
  let phase = ''; const end = Date.now() + 3000;
  while (Date.now() < end) { try { phase = (JSON.parse(readFileSync(path, 'utf8')) as { phase: string }).phase; } catch {} if (phase === 'committing') break; await delay(10); }
  assert.equal(phase, 'committing');
  const request = { jobId: c.id, attemptId: c.attemptId, releaseId: next.envelope.manifest.releaseId, installationId: store.installationId };
  const during = await launcher.recover(request); assert.equal(during?.state, 'unknown'); assert.equal(during?.installedReleaseId, undefined);
  await operation; assert.equal(store.job()?.phase, 'unknown'); assert.equal(store.active(), next.envelope.manifest.releaseId);
  const runtime = JSON.parse(readFileSync(join(store.stateDirectory, 'launcher-runtime.json'), 'utf8')) as { pid: number; state: string };
  assert.equal(runtime.state, 'running'); process.kill(runtime.pid, 0);
  assert.equal((await launcher.idle()).idle, false); await updater.step(); process.kill(runtime.pid, 0);
  assert.equal((await launcher.activate(request)).state, 'unknown'); assert.ok(!c.reports.some(r => r.state === 'succeeded' || r.state === 'rolledBack'));
});

test('crash after durable committing intent but before command delivery never exposes a terminal receipt', async t => {
  const { store, next, c, updater, launcher } = await managed(t);
  const original = fs.renameSync; let injected = false;
  const restore = (): void => { fs.renameSync = original; syncBuiltinESMExports(); };
  t.after(restore);
  fs.renameSync = ((source, destination) => {
    let interrupt = false;
    if (!injected && String(destination).endsWith('/launcher-transaction.json')) {
      const record = JSON.parse(readFileSync(source, 'utf8')) as { phase: string };
      interrupt = record.phase === 'committing';
    }
    original(source, destination);
    if (interrupt) { injected = true; throw Object.assign(new Error('crash after commit intent'), { code: 'EIO' }); }
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    await updater.step(); assert.equal(injected, true); assert.equal(store.job()?.phase, 'unknown');
    const request = { jobId: c.id, attemptId: c.attemptId, releaseId: next.envelope.manifest.releaseId, installationId: store.installationId };
    assert.equal((await launcher.recover(request))?.state, 'unknown');
    const tx = JSON.parse(readFileSync(join(store.stateDirectory, 'launcher-transaction.json'), 'utf8')) as { phase: string; receipt?: unknown };
    assert.equal(tx.phase, 'committing'); assert.equal(tx.receipt, undefined);
    assert.ok(!c.reports.some(r => r.state === 'succeeded' || r.state === 'rolledBack'));
  } finally { restore(); }
});
