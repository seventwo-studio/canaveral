import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ManagedUpdater, UpdateStore } from '../../src/updates/manager.ts';
import type { ControllerRequest, UpdateLifecycle } from '../../src/updates/manager.ts';
import type { ComponentAdoptionDriver, ComponentReport, ComponentTarget } from '../../src/updates/components.ts';
import { fixture, controller } from './update-manager-fixtures.test.ts';

const lifecycle: UpdateLifecycle = { idle: async () => ({ idle: true, workloadsStopped: true }), quiesce: async () => ({ idle: true, workloadsStopped: true, quiesced: true }), activation: { activate: async () => { throw new Error('Host activation is outside this component fixture'); }, recover: async () => undefined } };
async function setup(t: TestContext) {
  const f = fixture(); t.after(f.cleanup);
  const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1));
  const bundle = f.release(2, 'host', { 'guest/agent': 'agent' }), c = controller(bundle);
  const targets: ComponentTarget[] = [0, 1].map(() => ({ component: 'guest', machineId: randomUUID(), assignmentId: randomUUID(), bootId: randomUUID(), generation: 1 }));
  let adopted = 0, recovered = 0, uncertain = false, lost: string | undefined, allowed = true;
  const reports: ComponentReport[] = [];
  const driver: ComponentAdoptionDriver = { targets: async () => targets, adopt: async request => { adopted++; if (uncertain) throw new Error('Lost transport acknowledgement'); return { ...request, state: 'adopted', evidence: { boundary: 'idle-closed', acknowledgement: 'a'.repeat(64) } }; }, recover: async request => { recovered++; return uncertain ? undefined : { ...request, state: 'adopted', evidence: { boundary: 'idle-closed', acknowledgement: 'a'.repeat(64) } }; } };
  const request: ControllerRequest = async (method, path, body, credential, signal) => {
    assert.equal(credential, c.credential);
    if (path.endsWith('/component-plan')) return { accepted: allowed };
    if (path.endsWith('/component-report')) { reports.push(structuredClone(body) as unknown as ComponentReport); if (lost === body.state) { lost = undefined; throw new Error('lost component reply'); } return { accepted: true }; }
    return c.request(method, path, body, credential, signal);
  };
  let credential = c.credential;
  const options = { ...f.options, request, identity: () => ({ id: c.hostId, credential }), lifecycle, components: driver };
  let updater = new ManagedUpdater(options); await updater.poll();
  await store.stage(bundle.envelope, c.attemptId, async (file, offset, length) => Buffer.from(bundle.bytes[file.path as keyof typeof bundle.bytes]!).subarray(offset, offset + length));
  store.setActive(bundle.envelope.manifest.releaseId);
  const job = store.job()!; job.phase = 'succeeded'; job.componentStatus.host = 'ready'; store.saveJob(job);
  t.after(() => updater.close());
  return { store, reports, targets, step: () => updater.step(), poll: () => updater.poll(), count: () => ({ adopted, recovered }), allow: (v: boolean) => { allowed = v; }, uncertain: (v: boolean) => { uncertain = v; }, lose: (v: string) => { lost = v; }, revoke: () => { credential = 'x'.repeat(43); }, restart: async () => { await updater.close(); updater = new ManagedUpdater(options); } };
}

test('component adoption remains inactive without controller evidence and advances targets independently', async t => {
  const f = await setup(t); f.allow(false); await f.step(); assert.equal(f.count().adopted, 0);
  f.allow(true); await f.step(); assert.equal(f.count().adopted, 1); assert.deepEqual(f.store.job()!.adoption!.entries.map(e => e.state), ['adopted']);
  assert.equal((await f.poll())!.id, f.store.job()!.id);
  await f.step(); assert.equal(f.count().adopted, 2); await f.step(); assert.equal(f.count().adopted, 2);
});

test('lost component ACK replays exact durable report after restart without redispatch', async t => {
  const f = await setup(t); f.lose('adopted'); await assert.rejects(f.step(), /lost component reply/);
  const saved = structuredClone(f.store.job()!.adoption!.pending!); await f.restart(); await f.step();
  assert.deepEqual(f.reports[2], saved); assert.equal(f.count().adopted, 2); assert.equal(f.count().recovered, 0);
});

test('uncertain dispatch and lost intent replies recover the same target without replay', async t => {
  for (const mode of ['dispatch', 'intent']) {
    const f = await setup(t);
    if (mode === 'dispatch') { f.uncertain(true); await f.step(); } else { f.lose('intent'); await assert.rejects(f.step(), /lost component reply/); }
    const request = structuredClone(f.store.job()!.adoption!.entries[0]!.request); await f.restart(); f.uncertain(true); await f.step();
    assert.equal(f.count().adopted, mode === 'dispatch' ? 1 : 0); assert.deepEqual(f.store.job()!.adoption!.entries[0]!.request, request);
    f.uncertain(false); await f.step(); assert.equal(f.store.job()!.adoption!.entries[0]!.state, 'adopted');
  }
});

test('component journal refuses changed current credentials before any effect', async t => {
  const f = await setup(t); f.revoke(); await assert.rejects(f.step(), /credential/); assert.equal(f.count().adopted, 0); assert.equal(f.reports.length, 0);
});
