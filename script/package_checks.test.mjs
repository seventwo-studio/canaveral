import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkModuleClosure, moduleReferences } from './package_checks.mjs';
import { buildGuestBundle } from './build_guest_bundle.mjs';
import { buildRuntimeRelease } from './build_runtime_release.mjs';
import { prepareNative } from './prepare_native.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
function directory(t) { const root = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-package-'))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function run(command, args, cwd = ROOT) { const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_PATH: '' } }); assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout; }
function tree(root, current = root, files = new Map()) { for (const name of readdirSync(current)) { const path = join(current, name); if (lstatSync(path).isDirectory()) tree(root, path, files); else files.set(relative(root, path).replaceAll('\\', '/'), /\.(?:mjs|cjs|js)$/.test(name) ? readFileSync(path, 'utf8') : ''); } return files; }
function helpers(root) { const target = join(root, 'target/debug'); mkdirSync(target, { recursive: true }); for (const name of ['canaveral-mobile-native', 'apple-native-helper']) writeFileSync(join(target, name + (process.platform === 'win32' ? '.exe' : '')), 'inert packaging fixture: ' + name); prepareNative(root); }

test('module checks parse imports, reexports and literal dynamic imports without matching comments', () => {
  const source = `// import './absent.js';\nexport { x } from './dependency.js';\nconst x = import('./lazy.js');\nimport 'node:fs';`;
  assert.equal(moduleReferences(source).length, 3);
  const files = new Map([['main.js', source], ['dependency.js', 'export const x=1;'], ['lazy.js', '']]);
  checkModuleClosure(files); files.delete('lazy.js'); assert.throws(() => checkModuleClosure(files), /Missing module/);
  assert.throws(() => checkModuleClosure(new Map([['x.js', "import 'unlisted-package';"]])), /Unpackaged/);
  assert.throws(() => checkModuleClosure(new Map([['x.js', 'import(name);']]), { rejectComputed: true }), /Computed/);
});

test('actual emitted npm and signed release trees close imports and ship helper locations offline', async t => {
  assert.ok(existsSync(join(ROOT, 'coordination/dist/src/cli.js')), 'Run npm --prefix coordination run build first.');
  const root = directory(t), stage = join(root, 'stage'); mkdirSync(stage);
  // Ask npm for the real allowlist, with all lifecycle hooks disabled.
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--dry-run', '--json']))[0];
  for (const { path } of packed.files) { const target = join(stage, path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(ROOT, path), target); }
  helpers(stage); // Delivery-only bytes; never pretend these are native builds.
  const archive = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], stage))[0];
  run('tar', ['-xzf', join(root, archive.filename), '-C', root]);
  const installed = join(root, 'package'), files = tree(installed);
  checkModuleClosure(files);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
  const imports = [...new Set(Object.values(manifest.exports).map(value => value.default))];
  imports.push('./coordination/dist/src/updates/launcher.js', './coordination/dist/src/updates/cli.js', './coordination/dist/src/host.js', './coordination/dist/src/guest/windows/native.js');
  const program = `import assert from 'node:assert/strict';\nfor(const path of ${JSON.stringify(imports)}) await import(new URL(path, import.meta.url));\nconst c=await import('./coordination/dist/src/contracts.js'); assert.ok(c.consumerApiSchema().openapi); assert.ok(c.sessionProtocolSchema());\nconst a=await import('./coordination/dist/src/accessibility-sdk.js'); assert.ok(a.snapshotSchema());\nconst m=await import('./coordination/dist/src/providers/mobile-native.js'); assert.equal(m.mobileNativeHelper({}),new URL('./native/canaveral-mobile-native', import.meta.url).pathname);`;
  writeFileSync(join(installed, 'smoke.mjs'), program);
  if (process.platform !== 'win32') run(process.execPath, ['smoke.mjs'], installed);
  assert.match(run(process.execPath, [join(installed, manifest.bin.canaveral), '--help'], root), /Canaveral/);
  for (const name of ['native.ps1', 'native.cs']) assert.ok(files.has('coordination/dist/src/guest/windows/' + name));
  const native = JSON.parse(readFileSync(join(installed, 'native/runtime.json')));
  for (const item of Object.values(native.artifacts)) { const bytes = readFileSync(join(installed, 'native', item.file)); assert.equal(bytes.length, item.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256); }
  assert.deepEqual(readFileSync(join(installed, 'coordination/dist/src/providers', native.artifacts['apple-native-helper'].file)), readFileSync(join(installed, 'native', native.artifacts['apple-native-helper'].file)));
  // Sign the actual emitted tree and expand its content-addressed artifacts as an installer does.
  const key = generateKeyPairSync('ed25519'), keyFile = join(root, 'signing.pem');
  writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const recipe = { schema: 'canaveral-runtime-build-v1', releaseId: '2b31b466-4d1f-4d62-9104-6a890fb4811a', version: '1.0.0', sequence: 1, createdAt: 1800000000, target: { os: process.platform, arch: process.arch === 'arm64' ? 'arm64' : 'amd64' }, minimumLauncherVersion: 1, entrypoint: manifest.bin.canaveral, toolchain: { node: '24.11.0', rust: '1.99.1' }, sourceRevision: 'a'.repeat(40), files: [...files.keys()].map(path => ({ source: path, path, component: path.startsWith('native/') || path.includes('/apple-native-helper') ? 'native-helper' : 'host', executable: !!(lstatSync(join(installed, path)).mode & 0o111) })) };
  const recipeFile = join(root, 'recipe.json'); writeFileSync(recipeFile, JSON.stringify(recipe));
  const bundlePath = join(root, 'release');
  const release = await buildRuntimeRelease({ recipe: recipeFile, inputs: installed, output: bundlePath, keyFile, keyId: 'fixture' });
  const expanded = join(root, 'expanded');
  for (const file of release.manifest.files) { const path = join(expanded, file.path); mkdirSync(dirname(path), { recursive: true }); cpSync(join(bundlePath, 'artifacts', file.sha256), path); }
  writeFileSync(join(expanded, 'smoke.mjs'), program);
  if (process.platform !== 'win32') run(process.execPath, ['smoke.mjs'], expanded);
  assert.match(run(process.execPath, [join(expanded, manifest.bin.canaveral), '--help'], root), /Canaveral/);
  // Source examples intentionally import emitted SDKs; --help performs no requests.
  assert.match(run(process.execPath, ['examples/lease_lifecycle.ts', '--help']), /Acquire, inspect and release/);
});

test('guest module/resource closure imports with schemas from the assembled filesystem', async t => {
  const root = directory(t), elf = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(elf); elf.writeUInt16LE(3, 16); elf.writeUInt16LE(183, 18);
  const helper = join(root, 'helper'); writeFileSync(helper, elf);
  const options = { nativeHelper: helper, atspiHelper: helper, arch: 'arm64' }, bundle = buildGuestBundle(options);
  assert.deepEqual(buildGuestBundle(options), bundle);
  for (const artifact of bundle.artifacts) { const path = join(root, artifact.path.slice(1)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, artifact.content); }
  checkModuleClosure(new Map(bundle.artifacts.map(a => [a.path, a.content])), { rejectComputed: true });
  const base = join(root, 'opt/canaveral');
  const services = await import(pathToFileURL(join(base, 'modules/guest/linux-services.mjs')).href); assert.equal(typeof services.createLinuxServices, 'function');
  const schema = await import(pathToFileURL(join(base, 'modules/accessibility-sdk.mjs')).href); assert.ok(schema.snapshotSchema());
  for (const h of bundle.helpers) { const bytes = Buffer.from(h.parts.map(p => readFileSync(join(root, p.slice(1)), 'utf8')).join(''), 'base64'); assert.deepEqual(bytes, elf); }
});

test('offline release refuses incomplete emitted imports and signs repeatable complete trees', async t => {
  const root = directory(t), inputs = join(root, 'inputs'); mkdirSync(inputs);
  writeFileSync(join(inputs, 'main.mjs'), "import { value } from './dependency.mjs'; export { value };\n");
  writeFileSync(join(inputs, 'dependency.mjs'), 'export const value = 42;\n');
  const key = generateKeyPairSync('ed25519'), keyFile = join(root, 'key.pem'); writeFileSync(keyFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const recipe = { schema: 'canaveral-runtime-build-v1', releaseId: '2b31b466-4d1f-4d62-9104-6a890fb4811a', version: '1.0.0', sequence: 1, createdAt: 1800000000, target: { os: 'linux', arch: 'arm64' }, minimumLauncherVersion: 1, entrypoint: 'host/main.mjs', toolchain: { node: '24.11.0', rust: '1.99.1' }, sourceRevision: 'a'.repeat(40), files: [{ source: 'main.mjs', path: 'host/main.mjs', component: 'host', executable: false }] };
  const recipeFile = join(root, 'recipe.json'), output = join(root, 'incomplete'); writeFileSync(recipeFile, JSON.stringify(recipe));
  const assemble = output => buildRuntimeRelease({ recipe: recipeFile, inputs, output, keyFile, keyId: 'fixture' });
  await assert.rejects(assemble(output), /Missing module/); assert.equal(existsSync(output), false);
  recipe.files.push({ source: 'dependency.mjs', path: 'host/dependency.mjs', component: 'host', executable: false }); writeFileSync(recipeFile, JSON.stringify(recipe));
  const first = await assemble(join(root, 'first')), second = await assemble(join(root, 'second')); assert.deepEqual(first, second);
  const expanded = join(root, 'expanded');
  for (const file of first.manifest.files) { const path = join(expanded, file.path); mkdirSync(dirname(path), { recursive: true }); cpSync(join(root, 'first/artifacts', file.sha256), path); }
  assert.equal((await import(pathToFileURL(join(expanded, first.manifest.entrypoint)).href)).value, 42);
});

test('native input preflight leaves existing package unchanged on missing helper', t => {
  const root = directory(t); helpers(root);
  const before = readFileSync(join(root, 'native/runtime.json'));
  const name = 'apple-native-helper' + (process.platform === 'win32' ? '.exe' : '');
  rmSync(join(root, 'target/debug', name));
  writeFileSync(join(root, 'target/debug', 'canaveral-mobile-native' + (process.platform === 'win32' ? '.exe' : '')), 'new build');
  assert.throws(() => prepareNative(root)); assert.deepEqual(readFileSync(join(root, 'native/runtime.json')), before);
  assert.equal(readFileSync(join(root, 'native', 'canaveral-mobile-native' + (process.platform === 'win32' ? '.exe' : '')), 'utf8'), 'inert packaging fixture: canaveral-mobile-native');
});

test('native repackaging replaces old hardlinked destinations without changing their aliases', t => {
  const root = directory(t); helpers(root);
  const name = 'canaveral-mobile-native' + (process.platform === 'win32' ? '.exe' : '');
  const packaged = join(root, 'native', name), alias = join(root, 'retained-alias'); linkSync(packaged, alias);
  const before = readFileSync(alias); writeFileSync(join(root, 'target/debug', name), 'replacement fixture');
  prepareNative(root);
  assert.deepEqual(readFileSync(alias), before); assert.equal(readFileSync(packaged, 'utf8'), 'replacement fixture');
  assert.equal(lstatSync(packaged).nlink, 1);
});
