import { createLinuxServices } from "../../src/guest/linux-services.ts";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { signedGuestProvision, createGuestAdoptionService, createGuestAdoptionDriver } from '../../src/updates/guest.ts';
import { canonicalManifest } from '../../src/updates/protocol.ts';
import type { SignedRelease } from '../../src/updates/protocol.ts';
import { componentFileSetDigest } from '../../src/updates/components.ts';
import { GuestAccess } from '../../src/guest/access.ts';
import { createGuestServer } from '../../src/guest/server.ts';
const hash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-update-guest-')));
  const source = join(root, 'source'), guest = join(root, 'guest'); mkdirSync(join(source, 'guest'), { recursive: true });
  const artifacts = [
    { path: '/opt/canaveral/server.mjs', content: 'server', mode: '0644' },
    { path: '/opt/canaveral/install.mjs', content: 'installer', mode: '0644' },
    ...['canaveral-mobile-native', 'canaveral-guest-agent'].map(name => ({ path: `/opt/canaveral/payload/${name}.0000.b64`, content: Buffer.from(name).toString('base64'), mode: '0644' })),
  ];
  const bytes = Buffer.from(JSON.stringify(artifacts)); writeFileSync(join(source, 'guest/bundle.json'), bytes);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const context = { jobId: randomUUID(), attemptId: randomUUID(), installationId: randomUUID(), releaseId: randomUUID() };
  const manifest: SignedRelease['manifest'] = { schema: 'canaveral-update-v1', releaseId: context.releaseId, version: '1.0.0', sequence: 1, createdAt: 1, target: { os: 'linux', arch: 'arm64' }, minimumLauncherVersion: 1, entrypoint: 'host/main.js', files: [ { path: 'host/main.js', bytes: 0, sha256: hash(Buffer.alloc(0)), executable: false, component: 'host' }, { path: 'guest/bundle.json', bytes: bytes.length, sha256: hash(bytes), executable: false, component: 'guest' } ] };
  const release = { manifest, keyId: 'test', signature: sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64') };
  const keys = { test: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const identity = { machineId: randomUUID(), assignmentId: 'assignment-1', generation: 1 };
  const target = { component: 'guest' as const, ...identity, bootId: randomUUID() };
  const helpers = signedGuestProvision(release, keys, source, context, identity);
  for (const f of helpers) { const p = join(guest, f.path.slice('/opt/canaveral/'.length)); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, f.content, { mode: parseInt(f.mode, 8) }); }
  mkdirSync(join(guest, 'bin')); for (const name of ['canaveral-mobile-native', 'canaveral-guest-agent']) writeFileSync(join(guest, 'bin', name), name, { mode: 0o755 });
  const request = { ...context, fileSetDigest: componentFileSetDigest(manifest, 'guest'), target };
  return { root, source, guest, request, target, release, keys, context, identity, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('real authenticated loopback acknowledges current provision; recovery never dispatches', async () => {
  const f = fixture(); const adoption = createGuestAdoptionService(f.guest, f.target.bootId, () => true)!;
  let dispatches = 0;
  const server = createGuestServer({ token: 's'.repeat(32), mode: 'headless', services: { ready: () => true, adoption, control: async () => { dispatches++; return {}; }, upload: async () => { throw Error(); }, download: async () => { throw Error(); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const access = new GuestAccess(async () => ({ port, credential: 's'.repeat(32), authorized: () => true, close: async () => {} }));
  const driver = createGuestAdoptionDriver(access, async () => [{ target: f.target, machine: { id: f.identity.machineId }, image: { os: 'linux', guestAccess: true }, folder: f.guest }]);
  try {
    const fenced = await fetch('http://127.0.0.1:' + port + '/control', { method: 'POST', headers: { Authorization: 'Bearer ' + 's'.repeat(32) }, body: JSON.stringify({ action: 'shell-open', arguments: { session: randomUUID() } }) });
    assert.equal(fenced.status, 409); assert.equal(dispatches, 0);
    assert.equal(await driver.recover(f.request), undefined);
    const receipt = await driver.adopt(f.request); assert.equal(receipt.state, 'adopted'); assert.equal(adoption.admitted(), true);
    assert.deepEqual(await driver.recover(f.request), receipt); assert.equal(dispatches, 0);
    const restarted = createGuestAdoptionService(f.guest, f.target.bootId, () => false)!;
    assert.deepEqual(await restarted.acknowledge(f.request, true), receipt); assert.equal(restarted.admitted(), true);
    await assert.rejects(restarted.acknowledge({ ...f.request, target: { ...f.target, generation: 2 } }, true));
    await assert.rejects(createGuestAdoptionService(f.guest, randomUUID(), () => true)!.acknowledge(f.request, true));
    assert.equal(readFileSync(join(f.guest, 'update/provision.json'), 'utf8').includes('s'.repeat(32)), false);
  } finally { await access.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});
test('active sessions refuse adoption; hash failure retains durable intent and no replay', async () => {
  const f = fixture(); try {
    const active = createGuestAdoptionService(f.guest, f.target.bootId, () => false)!;
    assert.equal((await active.acknowledge(f.request, false))!.state, 'unknown');
    const service = createGuestAdoptionService(f.guest, f.target.bootId, () => true)!;
    writeFileSync(join(f.guest, 'server.mjs'), 'changed');
    await assert.rejects(service.acknowledge(f.request, false));
    writeFileSync(join(f.guest, 'server.mjs'), 'server');
    const restarted = createGuestAdoptionService(f.guest, f.target.bootId, () => true)!;
    assert.equal((await restarted.acknowledge(f.request, true))!.state, 'unknown');
    assert.equal((await restarted.acknowledge(f.request, false))!.state, 'unknown');
    assert.equal(restarted.admitted(), false);
  } finally { f.cleanup(); }
});
test('signed subset and binding mismatch fail without changing rollback files or secrets', async () => {
  const f = fixture(); try {
    await assert.rejects(createGuestAdoptionService(f.guest, f.target.bootId, () => true)!.acknowledge({ ...f.request, fileSetDigest: '0'.repeat(64) }, false));
    const old = readFileSync(join(f.guest, 'server.mjs'));
    writeFileSync(join(f.source, 'guest/bundle.json'), 'tamper');
    assert.throws(() => signedGuestProvision(f.release, f.keys, f.source, f.context, f.identity));
    assert.deepEqual(readFileSync(join(f.guest, 'server.mjs')), old);
  } finally { f.cleanup(); }
});

test('lost authenticated acknowledgement is recovered by inspection of original attempt', async () => {
  const f = fixture(); let authorized = true, acknowledgements = 0;
  const original = createGuestAdoptionService(f.guest, f.target.bootId, () => true)!;
  const adoption = { admitted: original.admitted, async acknowledge(value: unknown, inspect: boolean) {
    const result = await original.acknowledge(value, inspect);
    if (!inspect) { acknowledgements++; authorized = false; }
    return result;
  } };
  const server = createGuestServer({ token: 'z'.repeat(32), mode: 'headless', services: { ready: () => true, adoption, control: async () => ({}), upload: async () => { throw Error(); }, download: async () => { throw Error(); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const access = new GuestAccess(async () => ({ port, credential: 'z'.repeat(32), authorized: () => authorized, close: async () => {} }));
  try {
    await assert.rejects(access.adoption({ id: f.identity.machineId }, { os: 'linux' }, f.guest, f.request, false));
    authorized = true;
    const recovered = await access.adoption({ id: f.identity.machineId }, { os: 'linux' }, f.guest, f.request, true);
    assert.equal(recovered!.state, 'adopted'); assert.equal(acknowledgements, 1);
    assert.equal(JSON.stringify(recovered).includes('z'.repeat(32)), false);
  } finally { authorized = true; await access.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); f.cleanup(); }
});

test('Linux composition refuses desktop and live PTYs at the real service boundary', async () => {
  const f = fixture();
  const services = createLinuxServices({ stateDirectory: join(f.guest, 'state'), adoptionRoot: f.guest, bootId: f.target.bootId, mode: 'headless', ready: () => true, clock: () => 1, shells: { async open() { return { write: async text => ({ written: Buffer.byteLength(text) }), resize: async (rows, cols) => ({ rows, cols }), read: async () => ({ data: '', offset: 0, truncated: false, exited: false, exitCode: null }), close: async () => {} }; } } });
  try {
    const session = randomUUID(); await services.control('shell-open', { session });
    assert.equal((await services.adoption!.acknowledge(f.request, false))!.state, 'unknown');
    await services.control('shell-close', { session });
    // Closing a PTY does not prove detached child workloads ended.
    assert.equal((await services.adoption!.acknowledge(f.request, false))!.state, 'unknown');
  } finally { await services.close?.(); f.cleanup(); }
  const d = fixture();
  const desktop = createLinuxServices({ stateDirectory: join(d.guest, 'state'), adoptionRoot: d.guest, bootId: d.target.bootId, mode: 'desktop', ready: () => true, clock: () => 1 });
  try { assert.equal((await desktop.adoption!.acknowledge(d.request, false))!.state, 'unknown'); }
  finally { await desktop.close?.(); d.cleanup(); }
});
