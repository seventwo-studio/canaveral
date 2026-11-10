import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { canonicalManifest, MAX_MANIFEST_BYTES, parseManifest, parseSignedRelease, releasePath, verifyRelease } from '../../src/updates/protocol.ts';
import type { Manifest, SignedRelease } from '../../src/updates/protocol.ts';

const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest: Manifest = {
  schema: 'canaveral-update-v1', releaseId: '4f240f23-c541-4811-8adf-14728b2d81bd', version: '1.2.3-rc.1+build.7', sequence: 9,
  createdAt: 1_800_000_000, target: { os: 'linux', arch: 'amd64' }, minimumLauncherVersion: 1, entrypoint: 'host/main.js',
  files: [{ path: 'host/main.js', sha256: createHash('sha256').update('test').digest('hex'), bytes: 4, executable: false, component: 'host' }],
};
function envelope(m: Manifest = manifest): SignedRelease {
  return { manifest: m, keyId: 'test-key', signature: sign(null, canonicalManifest(m), pair.privateKey).toString('base64') };
}
function copy(): Manifest { return structuredClone(manifest); }

test('canonical bytes independently match sorted JSON and Ed25519 signatures', () => {
  const expected = '{"createdAt":1800000000,"entrypoint":"host/main.js","files":[{"bytes":4,"component":"host","executable":false,"path":"host/main.js","sha256":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}],"minimumLauncherVersion":1,"releaseId":"4f240f23-c541-4811-8adf-14728b2d81bd","schema":"canaveral-update-v1","sequence":9,"target":{"arch":"amd64","os":"linux"},"version":"1.2.3-rc.1+build.7"}';
  assert.equal(canonicalManifest(manifest).toString(), expected);
  const shuffled = Object.fromEntries(Object.entries(manifest).reverse()) as Manifest;
  assert.deepEqual(canonicalManifest(shuffled), Buffer.from(expected));
  const release = envelope();
  assert.ok(verify(null, Buffer.from(expected), pair.publicKey, Buffer.from(release.signature, 'base64')));
  assert.deepEqual(verifyRelease(release, { 'test-key': pem }, manifest.target), release);
  const parsed = parseSignedRelease(release); parsed.manifest.files[0]!.bytes = 999;
  assert.equal(release.manifest.files[0]!.bytes, 4);
});

test('canonicalization preserves well-formed Unicode and array order without normalization', () => {
  const m = copy(); m.entrypoint = 'host/é😀.js'; m.files[0]!.path = m.entrypoint;
  assert.match(canonicalManifest(m).toString(), /é😀/u);
  assert.deepEqual(verifyRelease(envelope(m), { 'test-key': pem }).manifest, m);
  const second = { ...m.files[0]!, path: 'guest/core', component: 'guest' as const };
  m.files.push(second);
  assert.notDeepEqual(canonicalManifest(m), canonicalManifest({ ...m, files: [...m.files].reverse() }));
});

test('signature, trust-root type, target and post-signing changes fail closed', () => {
  const release = envelope();
  assert.throws(() => verifyRelease(release, {}), /untrusted/);
  assert.throws(() => verifyRelease(release, Object.create({ 'test-key': pem }) as Record<string, string>), /untrusted/);
  assert.throws(() => verifyRelease(release, { 'test-key': pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), /public PEM/);
  assert.throws(() => verifyRelease(release, { 'test-key': generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }), /verification failed/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyRelease(release, { 'test-key': rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), /Ed25519/);
  assert.throws(() => verifyRelease(release, { 'test-key': pem }, { os: 'darwin', arch: 'arm64' }), /target mismatch/);
  assert.throws(() => verifyRelease({ ...release, manifest: { ...manifest, version: '1.2.4' } }, { 'test-key': pem }), /verification failed/);
  const signature = Buffer.from(release.signature, 'base64'); signature[0] = signature[0]! ^ 1;
  assert.throws(() => verifyRelease({ ...release, signature: signature.toString('base64') }, { 'test-key': pem }), /verification failed/);
  for (const signature of [release.signature + '\n', release.signature.slice(0, -2), 'A'.repeat(85) + 'B==', Buffer.alloc(63).toString('base64'), '', '💣']) {
    assert.throws(() => parseSignedRelease({ ...release, signature }));
  }
});

test('every protocol object rejects unknown fields, hooks and untrusted origins', () => {
  const m = copy(), release = envelope();
  for (const value of [null, [], 'json', 1, true, { ...release, trustedKeys: { evil: pem } }, { ...release, artifactUrl: 'https://evil.invalid/' }]) assert.throws(() => parseSignedRelease(value));
  for (const extra of ['install', 'postInstall', 'hooks', 'url', 'symlink', 'trustRoots']) assert.throws(() => parseManifest({ ...m, [extra]: 'unused' }));
  assert.throws(() => parseManifest({ ...m, target: { ...m.target, unknown: 1 } }));
  assert.throws(() => parseManifest({ ...m, files: [{ ...m.files[0], url: 'https://example.invalid' }] }));
  assert.throws(() => parseSignedRelease({ manifest: m, keyId: 'test-key' }));
  assert.throws(() => parseManifest({ ...m, schema: 'v2' }));
  assert.throws(() => parseManifest({ ...m, target: { os: 'linux', arch: 'x64' } }));
  assert.throws(() => parseManifest({ ...m, files: [{ ...m.files[0], component: 'controller' }] }));
  const getter = Object.defineProperty({ ...m }, 'version', { get() { throw new Error('Getter must not execute'); }, enumerable: true });
  assert.throws(() => parseManifest(getter), /JSON data/);
});

test('relative path validation rejects traversal, aliases, links and executable tricks', () => {
  for (const path of ['', '/abs', '../a', 'a/../b', './a', 'a/.', 'a//b', 'a/', 'C:/x', 'a\\b', '\\server\\x', 'a\0b', 'a\nb', 'file:stream', 'NUL', 'a/COM1.txt', 'a.','a ', 'e\u0301', '\ud800', '\udfff']) {
    assert.throws(() => releasePath(path), path);
  }
  const m = copy();
  assert.throws(() => parseManifest({ ...m, entrypoint: 'host/other.js' }));
  assert.throws(() => parseManifest({ ...m, files: [{ ...m.files[0], component: 'guest' }] }));
  assert.throws(() => parseManifest({ ...m, files: [...m.files, m.files[0]] }), /duplicate/);
  assert.throws(() => parseManifest({ ...m, files: [...m.files, { ...m.files[0], path: 'HOST/main.js' }] }), /duplicate/);
  assert.throws(() => parseManifest({ ...m, files: [...m.files, { ...m.files[0], path: 'host' }] }), /collision/);
  assert.throws(() => parseManifest({ ...m, files: [{ ...m.files[0], executable: 'false' }] }));
  assert.throws(() => parseManifest({ ...m, files: [{ ...m.files[0], symlink: 'target' }] }));
});

test('numeric, UUID, semver, encoding and resource bounds reject ambiguous inputs', () => {
  for (const sequence of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']) assert.throws(() => parseManifest({ ...manifest, sequence }));
  for (const bytes of [-0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseManifest({ ...manifest, files: [{ ...manifest.files[0], bytes }] }));
  for (const minimumLauncherVersion of [0, -1, NaN, '1']) assert.throws(() => parseManifest({ ...manifest, minimumLauncherVersion }));
  for (const createdAt of [-1, NaN, Infinity, 1.5]) assert.throws(() => parseManifest({ ...manifest, createdAt }));
  for (const version of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+', '1.2.3\ud800']) assert.throws(() => parseManifest({ ...manifest, version }));
  for (const version of ['0.0.0', '1.2.3', '1.2.3-0', '1.2.3-0alpha', '1.2.3+001']) assert.doesNotThrow(() => parseManifest({ ...manifest, version }));
  for (const releaseId of ['', '00000000-0000-0000-0000-000000000000', manifest.releaseId.toUpperCase()]) assert.throws(() => parseManifest({ ...manifest, releaseId }));
  for (const sha256 of ['A'.repeat(64), '0'.repeat(63), 'x'.repeat(64)]) assert.throws(() => parseManifest({ ...manifest, files: [{ ...manifest.files[0], sha256 }] }));
  assert.throws(() => parseManifest({ ...manifest, files: [] }));
  assert.throws(() => parseManifest({ ...manifest, files: new Array(10_001).fill(manifest.files[0]) }));
  const large = copy();
  large.files = Array.from({ length: 1000 }, (_, i) => ({ ...manifest.files[0]!, path: `${i}/` + 'a'.repeat(500) }));
  large.entrypoint = large.files[0]!.path;
  assert.ok(JSON.stringify(large).length > MAX_MANIFEST_BYTES);
  assert.throws(() => parseManifest(large), /too large/);
});
