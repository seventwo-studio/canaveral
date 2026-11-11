import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHelperAdoptionDriver } from '../../src/updates/native-helper.ts';
import { UpdateStore } from '../../src/updates/manager.ts';
import { canonicalManifest } from '../../src/updates/protocol.ts';
import type { Manifest } from '../../src/updates/protocol.ts';
import { createNodeMobileTransport, mobileNativeHelper, NodeNativeHelperSelection, nativeContainerFiles, nativeShells } from '../../src/providers/mobile-native.ts';

async function fixture(t: test.TestContext, bad = '', stop = '') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canaveral-helper-')), log = join(root, 'events');
  const keys = generateKeyPairSync('ed25519');
  const helper = `#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, 'spawn\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const v=JSON.parse(line); let body={};
 if(v.op==='updateIdentity') { fs.appendFileSync(${JSON.stringify(log)}, 'identity\\n'); body={protocol:v.protocol,nonce:v.nonce,binding:v.binding,pid:process.pid}; ${bad} }
 if(v.op==='syncDirectory' || v.op==='closeDirectory') body={};
 if(v.op==='directory') body={id:1};
 if(v.op==='ptyRead') body={data:'',exited:false,exitCode:null};
 if(v.op==='shutdown') { ${stop} }
 process.stdout.write(JSON.stringify({seq:v.seq,ok:true,body})+'\\n');
 if(v.op==='shutdown') { fs.appendFileSync(${JSON.stringify(log)}, 'stop\\n'); break; }
}
`;
  const source = join(root, 'source'); mkdirSync(source, { mode: 0o700 }); mkdirSync(join(source, 'native'), { mode: 0o700 });
  writeFileSync(join(source, 'host.mjs'), '', { mode: 0o600 }); writeFileSync(join(source, 'native/canaveral-mobile-native'), helper, { mode: 0o700 });
  const manifest: Manifest = { schema: 'canaveral-update-v1', releaseId: randomUUID(), version: '1.0.0', sequence: 1, createdAt: 1, target: { os: process.platform === 'darwin' ? 'darwin' : 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' }, minimumLauncherVersion: 1, entrypoint: 'host.mjs', files: [
    { path: 'host.mjs', sha256: createHash('sha256').update('').digest('hex'), bytes: 0, executable: false, component: 'host' },
    { path: 'native/canaveral-mobile-native', sha256: createHash('sha256').update(helper).digest('hex'), bytes: Buffer.byteLength(helper), executable: true, component: 'native-helper' },
  ] };
  const envelope = { manifest, keyId: 'test', signature: sign(null, canonicalManifest(manifest), keys.privateKey).toString('base64') };
  const store = new UpdateStore({ installationRoot: join(root, 'code'), stateDirectory: join(root, 'state'), protectedPaths: [log], trustedKeys: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, target: manifest.target, minimumFreeBytes: 0 });
  await store.installInitial(envelope, source);
  const legacy = join(store.releasePath(manifest.releaseId), 'native/canaveral-mobile-native');
  const selection = new NodeNativeHelperSelection(legacy), driver = new NativeHelperAdoptionDriver(store, selection);
  const context = { jobId: randomUUID(), attemptId: randomUUID(), installationId: store.installationId, releaseId: manifest.releaseId };
  const [target] = await driver.targets(context, envelope);
  const { componentFileSetDigest } = await import('../../src/updates/components.ts');
  const request = { ...context, target: target!, fileSetDigest: componentFileSetDigest(manifest, 'native-helper') };
  t.after(async () => { driver.close(); await selection.close().catch(() => {}); const writable = (p: string): void => { chmodSync(p, 0o700); for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) writable(join(p,e.name)); }; writable(root); rmSync(root, { recursive: true, force: true }); });
  const events = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
  return { root, store, selection, driver, context, envelope, request, legacy, events };
}

test('legacy discovery and scoped files work without update configuration', async t => {
  const f = await fixture(t);
  assert.equal(mobileNativeHelper({ nativeHelper: f.legacy }), f.legacy);
  const transport = createNodeMobileTransport({ nativeHelper: f.legacy });
  const dir = await transport.files!.openRoot(f.root); await dir.close();
  assert.equal(f.events(), 'spawn\nstop\n');
});

test('signed helper adoption binds live owned transport and recovers a lost response without replay', async t => {
  const f = await fixture(t), r = await f.driver.adopt(f.request);
  assert.equal(r.state, 'adopted'); assert.ok(r.evidence);
  assert.equal(f.driver.verifyAcknowledgement(f.request, r.evidence!.acknowledgement), true);
  assert.equal(f.driver.verifyAcknowledgement({ ...f.request, attemptId: randomUUID() }, r.evidence!.acknowledgement), false);
  assert.equal(f.driver.verifyAcknowledgement({ ...f.request, target: { ...f.request.target, instanceId: randomUUID() } as typeof f.request.target }, r.evidence!.acknowledgement), false);
  assert.deepEqual(await f.driver.recover(f.request), r);
  assert.deepEqual(await f.driver.adopt(f.request), r);
  assert.equal(f.events(), 'spawn\nidentity\n');
  const dir = await nativeContainerFiles(f.selection).openRoot(f.root); await dir.close();
  assert.equal(f.events(), 'spawn\nidentity\nspawn\nstop\n');
});

test('active file handles block switch and retain admission fence without stopping work', async t => {
  const f = await fixture(t), dir = await nativeContainerFiles(f.selection).openRoot(f.root);
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal(f.events(), 'spawn\n');
  await assert.rejects(nativeContainerFiles(f.selection).openRoot(f.root), /fenced/);
  await dir.close();
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal(f.events(), 'spawn\nstop\n');
});

test('foreign attempt/path/digest rejected before candidate execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.driver.adopt({ ...f.request, attemptId: randomUUID() }), /mismatch/);
  await assert.rejects(f.driver.adopt({ ...f.request, fileSetDigest: '0'.repeat(64) }), /mismatch/);
  await assert.rejects(f.driver.adopt({ ...f.request, target: { ...f.request.target, executable: 'native/other' } as typeof f.request.target }), /mismatch/);
  assert.equal(f.events(), '');
});

for (const bad of ['body.pid++;', 'body.binding="0".repeat(64);', 'body.nonce="0".repeat(64);', 'process.exit(0);']) test(`invalid or lost identity retains uncertainty: ${bad}`, async t => {
  const f = await fixture(t, bad);
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  const before = f.events();
  assert.equal((await f.driver.recover(f.request))?.state, 'unknown');
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal(f.events(), before);
  await assert.rejects(nativeContainerFiles(f.selection).openRoot(f.root), /fenced/);
});

test('durable receipt cannot prove a current helper after owner restart', async t => {
  const f = await fixture(t); assert.equal((await f.driver.adopt(f.request)).state, 'adopted');
  await f.selection.close(); f.driver.close();
  const selection = new NodeNativeHelperSelection(f.legacy), driver = new NativeHelperAdoptionDriver(f.store, selection);
  t.after(() => driver.close());
  assert.equal((await driver.recover(f.request))?.state, 'unknown');
  assert.equal((await driver.adopt(f.request)).state, 'unknown');
  await assert.rejects(nativeContainerFiles(selection).openRoot(f.root), /fenced/);
  assert.equal(f.events(), 'spawn\nidentity\nstop\n');
});

test('sealed executable mutation is rejected before execution', async t => {
  const f = await fixture(t); chmodSync(f.legacy, 0o700); writeFileSync(f.legacy, 'changed'); chmodSync(f.legacy, 0o500);
  await assert.rejects(f.driver.adopt(f.request), /size|digest/);
  assert.equal(f.events(), '');
});

test('retained child directory blocks adoption even after its root closes', async t => {
  const f = await fixture(t), root = await nativeContainerFiles(f.selection).openRoot(f.root), child = await root.directory('child');
  await root.close();
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal(f.events(), 'spawn\n');
  await child.close();
  assert.equal(f.events(), 'spawn\nstop\n');
});

test('live PTY handle blocks switch without stopping the scoped helper', async t => {
  const f = await fixture(t), shell = await nativeShells(f.selection).open(['/fixture/workload'], {});
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal(f.events(), 'spawn\n');
  await shell.close();
  assert.equal(f.events(), 'spawn\nstop\n');
});

test('old idle instance is confirmed stopped before selecting a new instance', async t => {
  const f = await fixture(t), first = await f.driver.adopt(f.request);
  const context = { ...f.context, jobId: randomUUID(), attemptId: randomUUID() };
  const [target] = await f.driver.targets(context, f.envelope);
  const next = { ...f.request, ...context, target: target! };
  assert.equal((await f.driver.adopt(next)).state, 'adopted');
  assert.equal(f.events(), 'spawn\nidentity\nstop\nspawn\nidentity\n');
  assert.equal(f.driver.verifyAcknowledgement(f.request, first.evidence!.acknowledgement), false);
});

test('unconfirmed old probe shutdown never starts a candidate or baseline', async t => {
  const f = await fixture(t, '', 'process.exit(9);');
  assert.equal((await f.driver.adopt(f.request)).state, 'adopted');
  const context = { ...f.context, jobId: randomUUID(), attemptId: randomUUID() };
  const [target] = await f.driver.targets(context, f.envelope);
  const next = { ...f.request, ...context, target: target! };
  assert.equal((await f.driver.adopt(next)).state, 'unknown');
  assert.equal((await f.driver.recover(next))?.state, 'unknown');
  assert.equal(f.events(), 'spawn\nidentity\n');
});

test('handshake without committed selection cannot be recovered as adopted', async t => {
  const f = await fixture(t), acknowledge = f.selection.acknowledge.bind(f.selection);
  f.selection.acknowledge = async (executable, key) => { await acknowledge(executable, key); throw new Error('interrupted before selection commit'); };
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  assert.equal((await f.driver.recover(f.request))?.state, 'unknown');
  assert.equal(f.events(), 'spawn\nidentity\n');
});

test('uncertain dispatch survives driver restart and cannot be replaced by another attempt', async t => {
  const f = await fixture(t, 'process.exit(0);');
  assert.equal((await f.driver.adopt(f.request)).state, 'unknown');
  const before = f.events(); f.driver.close();
  const selection = new NodeNativeHelperSelection(f.legacy), driver = new NativeHelperAdoptionDriver(f.store, selection);
  t.after(() => driver.close());
  assert.equal((await driver.recover(f.request))?.state, 'unknown');
  assert.equal((await driver.adopt(f.request)).state, 'unknown');
  await assert.rejects(driver.targets({ ...f.context, attemptId: randomUUID() }, f.envelope), /without replay/);
  assert.equal(f.events(), before);
});
