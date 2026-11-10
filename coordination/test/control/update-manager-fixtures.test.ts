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

export function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canaveral-managed-')), keys = generateKeyPairSync('ed25519');
  const hostState = join(root, 'host-state'), config = join(root, 'host.json'); mkdirSync(hostState, { mode: 0o700 });
  writeFileSync(join(hostState, 'identity.json'), '{"retained":true}', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ active: false, stop: true }), { mode: 0o600 });
  const options: UpdateStoreOptions = { installationRoot: join(root, 'installation'), stateDirectory: join(root, 'update-state'), protectedPaths: [hostState, config], target: { os: 'linux', arch: 'amd64' }, trustedKeys: { operator: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, minimumFreeBytes: 0 };
  function release(sequence: number, content = 'setInterval(() => {}, 1000);', extras: Record<string, string> = {}) {
    const bytes = { 'host.mjs': content, ...extras };
    const manifest: Manifest = { schema: 'canaveral-update-v1', releaseId: randomUUID(), version: `1.${sequence}.0`, sequence, createdAt: 1, target: options.target, minimumLauncherVersion: 1, entrypoint: 'host.mjs', files: Object.entries(bytes).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex'), component: path === 'host.mjs' ? 'host' : path.startsWith('guest') ? 'guest' : 'native-helper', executable: false })) };
    const envelope: SignedRelease = { manifest, keyId: 'operator', signature: sign(null, canonicalManifest(manifest), keys.privateKey).toString('base64') };
    return { envelope, bytes };
  }
  async function bootstrap(store: UpdateStore, bundle: ReturnType<typeof release>) {
    const source = join(root, `source-${bundle.envelope.manifest.releaseId}`); mkdirSync(source, { mode: 0o700 });
    for (const [path, value] of Object.entries(bundle.bytes)) { mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(source, path), value, { mode: 0o600 }); }
    await store.installInitial(bundle.envelope, source);
  }
  function cleanup() { const writable = (path: string): void => { try { chmodSync(path, 0o700); for (const name of readdirSync(path, { withFileTypes: true })) if (name.isDirectory() && !name.isSymbolicLink()) writable(join(path, name.name)); } catch {} }; writable(root); rmSync(root, { recursive: true, force: true }); }
  return { root, hostState, config, options, release, bootstrap, cleanup };
}
export function controller(bundle: ReturnType<ReturnType<typeof fixture>['release']>) {
  const id = randomUUID(), attemptId = randomUUID(), hostId = randomUUID(), credential = 'h'.repeat(43), reports: Record<string, unknown>[] = [], downloads: string[] = [];
  let lost = false, corrupt = false, release = bundle.envelope;
  const request: ControllerRequest = async (method, path, body, token) => {
    assert.equal(token, credential); assert.ok(path.startsWith('/v1/')); assert.ok(!path.includes('://'));
    if (path.endsWith('/poll')) return { job: { id, attemptId, release } };
    if (path.endsWith('/report')) { reports.push(structuredClone(body)); if (lost) { lost = false; throw new Error('lost reply'); } return { accepted: true, job: { state: body.state } }; }
    assert.equal(method, 'GET'); downloads.push(path); const url = new URL(path, 'https://controller.invalid');
    assert.equal(url.searchParams.get('jobId'), id);
    const file = bundle.envelope.manifest.files.find(f => url.pathname.endsWith(f.sha256))!;
    const offset = Number(url.searchParams.get('offset')), length = Number(url.searchParams.get('length'));
    assert.ok(length <= 524288); const data = Buffer.from(bundle.bytes[file.path as keyof typeof bundle.bytes]!).subarray(offset, offset + length);
    return { offset, totalBytes: file.bytes, data: (corrupt ? Buffer.alloc(data.length, 42) : data).toString('base64') };
  };
  return { id, attemptId, hostId, credential, request, reports, downloads, lose: () => { lost = true; }, corrupt: () => { corrupt = true; }, changeRelease: (value: SignedRelease) => { release = value; } };
}
