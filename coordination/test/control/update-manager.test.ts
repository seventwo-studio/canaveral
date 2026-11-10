import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ManagedUpdater, UpdateStore, atomicUpdateJSON } from '../../src/updates/manager.ts';
import type { ControllerRequest, UpdateLifecycle, UpdateStoreOptions } from '../../src/updates/manager.ts';
import { canonicalManifest } from '../../src/updates/protocol.ts';
import type { Manifest, SignedRelease } from '../../src/updates/protocol.ts';

import { fixture, controller } from './update-manager-fixtures.test.ts';

const unused: UpdateLifecycle = { idle: async () => ({ idle: true, workloadsStopped: true }), quiesce: async () => ({ idle: true, workloadsStopped: true, quiesced: true }), activation: { activate: async () => { throw new Error('must not activate'); }, recover: async () => undefined } };

test('bounded controller-only download verifies signed files, stages inactive components and rejects old sequences', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options), baseline = f.release(1); await f.bootstrap(store, baseline);
  const bundle = f.release(2, `/*${'x'.repeat(700000)}*/`, { 'guest/agent': 'guest', 'native/helper': 'helper' }), c = controller(bundle);
  const updater = new ManagedUpdater({ ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle: unused }); t.after(() => updater.close());
  await updater.poll(); await updater.step(); const staged = await updater.step(); assert.equal(staged?.phase, 'staged');
  assert.equal(c.downloads.length, 4); assert.equal(store.active(), baseline.envelope.manifest.releaseId); assert.equal(store.highwater().sequence, 2);
  assert.equal(store.verifyInstalled(bundle.envelope.manifest.releaseId).manifest.files.length, 3);
  assert.equal(staged?.componentStatus.guest, 'pendingGuestReceipt'); assert.equal(staged?.componentStatus['native-helper'], 'pendingNativeReceipt');
  assert.equal(readFileSync(join(f.hostState, 'identity.json'), 'utf8'), '{"retained":true}');
  assert.equal(existsSync(join(f.options.installationRoot, 'releases', bundle.envelope.manifest.releaseId)), true);
  await updater.close();
  const old = controller(f.release(1)); const otherOptions = { ...f.options, stateDirectory: join(f.root, 'other-state'), installationRoot: join(f.root, 'other-installation'), request: old.request, identity: () => ({ id: old.hostId, credential: old.credential }), lifecycle: unused };
  await f.bootstrap(new UpdateStore(otherOptions), f.release(3)); const other = new ManagedUpdater(otherOptions); t.after(() => other.close()); await assert.rejects(other.poll(), /high-water/);
});

test('lost report replies replay exact saved sequence and attempt across manager restart', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1)); const c = controller(f.release(2));
  const options = { ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle: unused };
  let updater = new ManagedUpdater(options); await updater.poll(); c.lose(); await assert.rejects(updater.step(), /lost reply/);
  assert.equal(store.job()?.pending?.sequence, 1); await updater.close(); updater = new ManagedUpdater(options); t.after(() => updater.close());
  await updater.step(); assert.deepEqual(c.reports[0], c.reports[1]); assert.equal(store.job()?.attemptId, c.attemptId); assert.equal(store.job()?.phase, 'staged');
  assert.deepEqual(c.reports.map(r => r.sequence), [1, 1, 2, 3]);
});

test('digest failure keeps exact verified baseline and never requests activation', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options), baseline = f.release(1); await f.bootstrap(store, baseline); const c = controller(f.release(2)); c.corrupt();
  const updater = new ManagedUpdater({ ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle: unused }); t.after(() => updater.close());
  await updater.poll(); await updater.step(); const job = await updater.step(); assert.equal(job?.phase, 'failed');
  assert.equal(c.reports.at(-1)?.installedReleaseId, baseline.envelope.manifest.releaseId); assert.match(String(c.reports.at(-1)?.detail), /noActivation/);
  assert.equal(store.active(), baseline.envelope.manifest.releaseId);
});

test('active workloads block downloads and activation; uncertain quiesce is retained across restart', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1)); const c = controller(f.release(2)); let active = true, quiesces = 0;
  const lifecycle: UpdateLifecycle = { ...unused, idle: async () => ({ idle: !active, workloadsStopped: !active }), quiesce: async () => { quiesces++; throw new Error('uncertain'); } };
  const options = { ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle };
  let updater = new ManagedUpdater(options); await updater.poll(); await updater.step(); await updater.step(); assert.equal(c.downloads.length, 0); assert.equal(quiesces, 0);
  active = false; await updater.step(); await updater.step(); assert.equal(store.job()?.phase, 'unknown'); await updater.close();
  updater = new ManagedUpdater(options); t.after(() => updater.close()); await updater.poll(); await updater.step(); assert.equal(quiesces, 1); assert.equal(store.job()?.attemptId, c.attemptId);
});

test('interrupted stage and quiesce intents never create fresh candidates', async t => {
  for (const phase of ['downloading', 'staged'] as const) {
    const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1)); const c = controller(f.release(2));
    const updater = new ManagedUpdater({ ...f.options, request: c.request, identity: () => ({ id: c.hostId, credential: c.credential }), lifecycle: unused }); t.after(() => updater.close());
    await updater.poll(); await updater.step(); if (phase === 'staged') await updater.step();
    const job = store.job()!; job.phase = phase; if (phase === 'staged') job.gate = { idle: false, workloadsStopped: false, quiesced: false }; store.saveJob(job);
    const before = c.downloads.length; await updater.step(); assert.equal(store.job()?.phase, 'unknown'); assert.equal(c.downloads.length, before);
  }
});

test('private roots, signed tree integrity, links, extra entries and space bounds fail closed', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options), bundle = f.release(1); await f.bootstrap(store, bundle);
  const path = join(store.releasePath(bundle.envelope.manifest.releaseId), 'host.mjs'); chmodSync(path, 0o600); writeFileSync(path, 'tamper'); chmodSync(path, 0o400); assert.throws(() => store.verifyInstalled(bundle.envelope.manifest.releaseId), /size|digest/);
  const alias = join(f.root, 'alias'); symlinkSync(f.hostState, alias); assert.throws(() => new UpdateStore({ ...f.options, installationRoot: alias }), /symlink/);
  assert.throws(() => new UpdateStore({ ...f.options, installationRoot: f.hostState }), /separate/);
  const hard = join(f.root, 'hard.json'); linkSync(f.config, hard); assert.throws(() => atomicUpdateJSON(hard, {}), /state file/);
  const extra = fixture(); t.after(extra.cleanup); mkdirSync(extra.options.installationRoot, { mode: 0o700 }); writeFileSync(join(extra.options.installationRoot, 'identity.json'), 'unexpected'); assert.throws(() => new UpdateStore(extra.options), /Unexpected/);
  const bounded = new UpdateStore({ ...extra.options, installationRoot: join(extra.root, 'safe'), stateDirectory: join(extra.root, 'safe-state'), maxReleaseBytes: 1 }); assert.throws(() => bounded.validate(extra.release(2).envelope), /space bound/);
  const noSpace = new UpdateStore({ ...extra.options, installationRoot: join(extra.root, 'space'), stateDirectory: join(extra.root, 'space-state'), minimumFreeBytes: Number.MAX_SAFE_INTEGER }); await assert.rejects(noSpace.stage(extra.release(1).envelope, randomUUID(), async () => Buffer.alloc(0)), /space/);
});

test('runner requests pin current binding and refuse credential or incarnation changes', async t => {
  const f = fixture(); t.after(f.cleanup); const store = new UpdateStore(f.options); await f.bootstrap(store, f.release(1)); const c = controller(f.release(2));
  const binding = { controllerId: randomUUID(), runnerId: c.hostId, generation: 1, incarnationId: randomUUID() }; let token = c.credential;
  const request: ControllerRequest = async (method, path, body, credential, signal) => { if (path.endsWith('/poll') || path.endsWith('/report')) { assert.match(path, /^\/v1\/runners\//); assert.deepEqual(body.binding, binding); } return c.request(method, path, body, credential, signal); };
  const updater = new ManagedUpdater({ ...f.options, targetKind: 'runner', request, identity: () => ({ id: c.hostId, credential: token, binding: { ...binding } }), lifecycle: unused }); t.after(() => updater.close());
  await updater.poll(); await updater.step(); token = 'b'.repeat(43); await assert.rejects(updater.step(), /credential/); assert.equal(c.downloads.length, 0);
});
