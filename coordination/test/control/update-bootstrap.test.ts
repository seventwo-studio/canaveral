import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapInstall, unixBootstrapPlatform, MAX_ARTIFACT_BYTES } from '../../src/updates/bootstrap.ts';
import { UpdateStore } from '../../src/updates/manager.ts';
import { canonicalManifest } from '../../src/updates/protocol.ts';
import type { Manifest, SignedRelease } from '../../src/updates/protocol.ts';

export function bootstrapFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-bootstrap-')));
  const bundle = join(root, 'bundle'); mkdirSync(bundle, { mode: 0o700 }); mkdirSync(join(bundle, 'artifacts'), { mode: 0o700 });
  const key = generateKeyPairSync('ed25519'), publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const data = Buffer.from('throw new Error("packaged code must never execute");\n');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const manifest: Manifest = { schema: 'canaveral-update-v1', releaseId: randomUUID(), version: '1.0.0', sequence: 1, createdAt: 1, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' }, minimumLauncherVersion: 1, entrypoint: 'src/main.mjs', files: [{ path: 'src/main.mjs', sha256, bytes: data.length, executable: false, component: 'host' }] };
  const envelope = (): SignedRelease => ({ manifest, keyId: 'test', signature: sign(null, canonicalManifest(manifest), key.privateKey).toString('base64') });
  const save = () => writeFileSync(join(bundle, 'release.json'), JSON.stringify(envelope()), { mode: 0o600 }); save();
  const artifact = join(bundle, 'artifacts', sha256); writeFileSync(artifact, data, { mode: 0o600 });
  const hostState = join(root, 'host'); mkdirSync(hostState, { mode: 0o700 }); writeFileSync(join(hostState, 'identity'), 'unchanged', { mode: 0o600 });
  const options = { bundleDirectory: bundle, installationRoot: join(root, 'installation'), stateDirectory: join(root, 'state'), trustedKeys: { test: publicKey }, target: manifest.target, protectedPaths: [hostState], minimumFreeBytes: 0 };
  return { root, bundle, artifact, data, manifest, options, save, envelope, hostState, privateKey: key.privateKey, cleanup: () => { const writable = (path: string): void => { if (!lstatSync(path).isDirectory()) return; chmodSync(path, 0o700); for (const name of readdirSync(path)) { const child = join(path, name); if (!lstatSync(child).isSymbolicLink()) writable(child); } }; writable(root); rmSync(root, { recursive: true, force: true }); } };
}

test('offline real bundle expansion installs exact bytes without execution and repeat preserves identity', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const installed = await bootstrapInstall(f.options), store = new UpdateStore(f.options);
  assert.equal(installed.installationId, store.installationId); assert.equal(store.active(), f.manifest.releaseId);
  assert.deepEqual(readFileSync(join(store.releasePath(f.manifest.releaseId), 'src/main.mjs')), f.data);
  assert.equal(readFileSync(join(f.hostState, 'identity'), 'utf8'), 'unchanged');
  const identity = readFileSync(join(f.options.stateDirectory, 'installation.json'));
  await assert.rejects(bootstrapInstall(f.options), /already exists/);
  assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'installation.json')), identity);
  assert.equal(store.verifyInstalled(f.manifest.releaseId).manifest.releaseId, f.manifest.releaseId);
});

test('tamper, truncated/oversized artifacts and input links fail closed and retain identity', async t => {
  for (const mode of ['tamper', 'truncated', 'oversized', 'symlink', 'hardlink'] as const) {
    const f = bootstrapFixture(); t.after(f.cleanup);
    if (mode === 'tamper') writeFileSync(f.artifact, Buffer.alloc(f.data.length, 88));
    if (mode === 'truncated') writeFileSync(f.artifact, f.data.subarray(1));
    if (mode === 'oversized') writeFileSync(f.artifact, Buffer.concat([f.data, Buffer.from('x')]));
    if (mode === 'symlink') { rmSync(f.artifact); symlinkSync(join(f.hostState, 'identity'), f.artifact); }
    if (mode === 'hardlink') { rmSync(f.artifact); linkSync(join(f.hostState, 'identity'), f.artifact); }
    await assert.rejects(bootstrapInstall(f.options));
    const identity = readFileSync(join(f.options.stateDirectory, 'installation.json'));
    assert.equal(existsSync(join(f.options.stateDirectory, 'active.json')), false);
    await assert.rejects(bootstrapInstall(f.options), /already exists/);
    assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'installation.json')), identity);
  }
});

test('signature/key/target/bounds and protected overlaps reject before reservation', async t => {
  for (const mode of ['signature', 'key', 'target', 'bound', 'overlap', 'bundle-link', 'manifest-hardlink'] as const) {
    const f = bootstrapFixture(); t.after(f.cleanup);
    if (mode === 'signature') { f.manifest.version = '2.0.0'; writeFileSync(join(f.bundle, 'release.json'), JSON.stringify({ ...f.envelope(), signature: Buffer.alloc(64).toString('base64') })); }
    if (mode === 'key') f.options.trustedKeys = { test: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    if (mode === 'target') { f.manifest.target = { ...f.manifest.target, arch: f.manifest.target.arch === 'arm64' ? 'amd64' : 'arm64' }; f.save(); }
    if (mode === 'bound') { f.manifest.files[0]!.bytes = MAX_ARTIFACT_BYTES + 1; f.save(); }
    if (mode === 'overlap') f.options.protectedPaths.push(join(f.options.installationRoot, 'credentials'));
    if (mode === 'bundle-link') { const alias = join(f.root, 'alias'); symlinkSync(f.bundle, alias); f.options.bundleDirectory = alias; }
    if (mode === 'manifest-hardlink') linkSync(join(f.bundle, 'release.json'), join(f.root, 'manifest-alias'));
    await assert.rejects(bootstrapInstall(f.options)); assert.equal(existsSync(f.options.installationRoot), false);
  }
});

test('existing empty roots, partial crash reservations and nonprivate parents are never adopted', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  mkdirSync(f.options.installationRoot, { mode: 0o700 });
  await assert.rejects(bootstrapInstall(f.options), /already exists/);
  assert.equal(existsSync(f.options.stateDirectory), false);
  rmSync(f.options.installationRoot, { recursive: true }); chmodSync(f.root, 0o755);
  await assert.rejects(bootstrapInstall(f.options), /private/);
  assert.throws(() => unixBootstrapPlatform('win32'), /Windows ACL.*unproven/);
});

test('actual offline builder output expands and installs with signed build evidence', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const inputs = join(f.root, 'inputs'); mkdirSync(inputs, { mode: 0o700 });
  writeFileSync(join(inputs, 'main.mjs'), f.data, { mode: 0o600 });
  const key = join(f.root, 'signing.pem'); writeFileSync(key, f.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const recipe = join(f.root, 'recipe.json');
  const { files: _files, schema: _schema, ...header } = f.manifest;
  writeFileSync(recipe, JSON.stringify({ ...header, schema: 'canaveral-runtime-build-v1', toolchain: { node: '24.11.0', rust: '1.99.1' }, sourceRevision: '1'.repeat(40), files: [{ source: 'main.mjs', path: 'src/main.mjs', component: 'host', executable: false }] }));
  const built = join(f.root, 'built');
  const builder = fileURLToPath(new URL('../../../../script/build_runtime_release.mjs', import.meta.url));
  // The builder must work independently of the test runner's working directory.
  const build = spawnSync(process.execPath, [builder, '--recipe', recipe, '--inputs', inputs, '--output', built, '--key-file', key, '--key-id', 'test'], { cwd: f.root, encoding: 'utf8', timeout: 10000 });
  assert.equal(build.status, 0, build.stderr);
  const result = await bootstrapInstall({ ...f.options, bundleDirectory: built });
  const store = new UpdateStore(f.options);
  assert.equal(store.active(), result.releaseId); assert.equal(store.verifyInstalled(result.releaseId).manifest.files.length, 2);
});

test('process loss before installation retains the reserved identity and refuses automatic replay', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const bootstrapURL = new URL('../../src/updates/bootstrap.js', import.meta.url).href;
  const managerURL = new URL('../../src/updates/manager.js', import.meta.url).href;
  const source = `import { bootstrapInstall } from ${JSON.stringify(bootstrapURL)}; import { UpdateStore } from ${JSON.stringify(managerURL)}; UpdateStore.prototype.installInitial = async () => { process.exit(17); }; await bootstrapInstall(${JSON.stringify(f.options)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 17, child.stderr);
  const identity = readFileSync(join(f.options.stateDirectory, 'installation.json'));
  assert.equal(existsSync(join(f.options.stateDirectory, 'active.json')), false);
  await assert.rejects(bootstrapInstall(f.options), /already exists/);
  assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'installation.json')), identity);
});
