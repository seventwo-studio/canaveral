#!/usr/bin/env node
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fresh inodes prevent Cargo hardlinks or an old packaged inode from sharing writes.
function publish(file, bytes, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), '.package-' + randomUUID());
  try { writeFileSync(temporary, bytes, { flag: 'wx', mode }); chmodSync(temporary, mode); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export function prepareNative(root, profile = 'debug') {
  if (!['debug', 'release'].includes(profile)) throw new Error('Choose a compiled native profile.');
  const directory = join(root, 'native');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const names = ['canaveral-mobile-native', 'apple-native-helper'];
  // Read all inputs before changing the package; these bytes are never executed.
  const inputs = names.map(name => {
    const source = join(root, 'target', profile, name + suffix), info = lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 512 * 1024 ** 2) throw new Error('Supply bounded regular compiled native helpers.');
    const bytes = readFileSync(source);
    if (bytes.length !== info.size) throw new Error('Native input changed while packaging.');
    return { name, bytes };
  });
  const artifacts = {};
  for (const { name, bytes } of inputs) {
    publish(join(directory, name + suffix), bytes, 0o755);
    artifacts[name] = { file: name + suffix, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (name === 'apple-native-helper') publish(join(root, 'coordination/dist/src/providers', name + suffix), bytes, 0o755);
  }
  publish(join(directory, 'runtime.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, artifacts }, null, 2) + '\n', 0o644);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareNative(fileURLToPath(new URL('../', import.meta.url)), process.argv[2]);
