#!/usr/bin/env node
/** Offline runtime artifact assembly. No downloads, compilation, hooks or installation. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalManifest, parseManifest, parseSignedRelease, releasePath, verifyRelease } from '../coordination/src/updates/protocol.ts';
import { checkModuleClosure } from './package_checks.mjs';

const METADATA = '.canaveral-build.json';
function exact(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error(`Invalid ${name} fields.`);
  return value;
}
async function noLinks(path, directory = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || ((i < parts.length - 1 || directory) && !info.isDirectory())) throw new Error('Runtime inputs and outputs must not traverse links. Use real absolute paths.');
  }
  return absolute;
}
async function inputFile(path, maximum = Number.MAX_SAFE_INTEGER) {
  await noLinks(path);
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('Input must be a bounded regular file with one link.');
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}
async function jsonFile(path) {
  const { handle } = await inputFile(path, 4 * 1024 * 1024);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile())); }
  finally { await handle.close(); }
}
async function outputFile(path, data) {
  const file = await fs.open(path, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}
function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;
}
/** Recipe toolchain fields are operator evidence; this assembler does not execute or certify toolchains. */
export async function buildRuntimeRelease({ recipe: recipePath, inputs, output, keyFile, keyId }) {
  const recipe = exact(await jsonFile(recipePath), ['schema', 'releaseId', 'version', 'sequence', 'createdAt', 'target', 'minimumLauncherVersion', 'entrypoint', 'files', 'toolchain', 'sourceRevision'], 'recipe');
  if (recipe.schema !== 'canaveral-runtime-build-v1') throw new Error('Unsupported runtime build recipe.');
  const toolchain = exact(recipe.toolchain, ['node', 'rust'], 'toolchain');
  if (typeof toolchain.node !== 'string' || !/^24\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(toolchain.node) || Number(toolchain.node.split('.')[1]) < 11 || toolchain.rust !== '1.99.1') throw new Error('Pin an exact Node 24.11+ version and Rust 1.99.1.');
  if (typeof recipe.sourceRevision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recipe.sourceRevision)) throw new Error('Pin a full source revision.');
  if (!Array.isArray(recipe.files) || recipe.files.length === 0) throw new Error('List every runtime file explicitly.');
  const listed = recipe.files.map(file => {
    exact(file, ['source', 'path', 'executable', 'component'], 'recipe file');
    releasePath(file.source); releasePath(file.path);
    if (file.path.toLowerCase() === METADATA) throw new Error('Reserved build metadata path.');
    return file;
  });
  // Validate every schema/path before creating output or opening signing material.
  const template = { schema: 'canaveral-update-v1', releaseId: recipe.releaseId, version: recipe.version, sequence: recipe.sequence, createdAt: recipe.createdAt, target: recipe.target, minimumLauncherVersion: recipe.minimumLauncherVersion, entrypoint: recipe.entrypoint };
  const placeholders = listed.map(file => ({ path: file.path, executable: file.executable, component: file.component, sha256: '0'.repeat(64), bytes: 0 }));
  const validated = parseManifest({ ...template, files: [...placeholders, { path: METADATA, executable: false, component: 'host', sha256: '0'.repeat(64), bytes: 0 }] });
  // Validate keyId independently without ever placing private material in the bundle.
  parseSignedRelease({ manifest: { ...template, files: placeholders }, keyId, signature: Buffer.alloc(64).toString('base64') });
  const base = await noLinks(inputs, true);
  const key = await inputFile(keyFile, 16_384);
  let privateKey, keyMaterial;
  try {
    if (process.platform !== 'win32' && ((key.info.mode & 0o077) !== 0 || key.info.uid !== process.getuid())) throw new Error('Signing key must be private and owned by the current user.');
    keyMaterial = await key.handle.readFile();
    if (keyMaterial.length > 16_384) throw new Error('Signing key changed while reading.');
    privateKey = createPrivateKey(keyMaterial);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Signing requires an Ed25519 private key.');
  } finally { await key.handle.close(); }
  const destination = resolve(output);
  await noLinks(dirname(destination), true);
  await fs.mkdir(destination, { mode: 0o700 }); // Exclusive reservation; never overwrite or adopt output.
  const artifacts = join(destination, 'artifacts');
  const files = [];
  let releaseBytes = 0;
  try {
    await fs.mkdir(artifacts, { mode: 0o700 });
    for (const file of listed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const input = await inputFile(join(base, file.source));
      let temporary;
      try {
        if (input.info.dev === key.info.dev && input.info.ino === key.info.ino) throw new Error('A signing key cannot be included as a runtime file.');
        releaseBytes += input.info.size;
        if (input.info.size > 512 * 1024 ** 2 || releaseBytes > 2 * 1024 ** 3 - 4096) throw new Error('Runtime artifacts exceed controller release bounds.');
        temporary = join(artifacts, '.copy');
        const staged = await fs.open(temporary, 'wx', 0o600);
        const hash = createHash('sha256'); let bytes = 0, tail = Buffer.alloc(0);
        try {
          const buffer = Buffer.alloc(256 * 1024);
          while (true) {
            const read = await input.handle.read(buffer, 0, buffer.length, null);
            if (read.bytesRead === 0) break;
            bytes += read.bytesRead;
            if (bytes > input.info.size) throw new Error('Runtime input changed during assembly.');
            const chunk = buffer.subarray(0, read.bytesRead);
            const scan = Buffer.concat([tail, chunk]);
            if (scan.includes(keyMaterial)) throw new Error('Signing key material cannot be included in a runtime artifact.');
            tail = Buffer.from(scan.subarray(Math.max(0, scan.length - keyMaterial.length + 1)));
            hash.update(chunk); await staged.writeFile(chunk);
          }
          if (bytes !== input.info.size || !unchanged(input.info, await input.handle.stat())) throw new Error('Runtime input changed during assembly.');
          await staged.sync();
        } finally { await staged.close(); }
        const sha256 = hash.digest('hex');
        const final = join(artifacts, sha256);
        try { await fs.link(temporary, final); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await fs.unlink(temporary); temporary = undefined;
        files.push({ path: file.path, component: file.component, executable: file.executable, bytes, sha256 });
      } finally { await input.handle.close(); if (temporary) await fs.unlink(temporary).catch(() => {}); }
    }
    // Inspect staged bytes rather than changing input paths. No packaged code is run.
    const modules = new Map(files.map(file => [file.path, '']));
    let moduleBytes = 0;
    for (const file of files.filter(file => /\.(?:mjs|cjs|js)$/.test(file.path))) {
      moduleBytes += file.bytes;
      if (file.bytes > 16 * 1024 ** 2 || moduleBytes > 128 * 1024 ** 2) throw new Error('Emitted module source exceeds package-check bounds.');
      modules.set(file.path, new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(join(artifacts, file.sha256))));
    }
    checkModuleClosure(modules);
    const metadata = Buffer.from(JSON.stringify({ schema: 'canaveral-runtime-build-v1', sourceRevision: recipe.sourceRevision, toolchain: { node: toolchain.node, rust: toolchain.rust }, target: validated.target, version: recipe.version }) + '\n');
    const sha256 = createHash('sha256').update(metadata).digest('hex');
    try { await outputFile(join(artifacts, sha256), metadata); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    files.push({ path: METADATA, component: 'host', executable: false, bytes: metadata.length, sha256 });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = parseManifest({ ...template, files });
    const release = { manifest, keyId, signature: sign(null, canonicalManifest(manifest), privateKey).toString('base64') };
    verifyRelease(release, { [keyId]: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() });
    // This is the completion marker. Interrupted bundles without it cannot be uploaded.
    await outputFile(join(destination, 'release.json'), JSON.stringify(release) + '\n');
    return release;
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
  finally { keyMaterial.fill(0); }
}
export async function main(args) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: Object.fromEntries(['recipe', 'inputs', 'output', 'key-file', 'key-id'].map(key => [key, { type: 'string' }])) });
  if (positionals.length || ['recipe', 'inputs', 'output', 'key-file', 'key-id'].some(key => !values[key])) throw new Error('Usage: build_runtime_release.mjs --recipe FILE --inputs DIR --output NEW_DIR --key-file PRIVATE_PEM --key-id ID');
  const release = await buildRuntimeRelease({ recipe: values.recipe, inputs: values.inputs, output: values.output, keyFile: values['key-file'], keyId: values['key-id'] });
  console.log(JSON.stringify({ releaseId: release.manifest.releaseId, files: release.manifest.files.length }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('Runtime release assembly failed. Check the explicit recipe, private signing key and fresh output path.'); process.exitCode = 1; });
}
