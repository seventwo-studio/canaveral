#!/usr/bin/env node
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareNative(root, profile = 'debug') {
  if (!['debug', 'release'].includes(profile)) throw new Error('Choose a compiled native profile.');
  const directory = join(root, 'native');
  mkdirSync(directory, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const names = ['canaveral-mobile-native', 'apple-native-helper'];
  const artifacts = {};
  for (const name of names) {
    const source = join(root, 'target', profile, name + suffix);
    const bytes = readFileSync(source);
    const target = join(directory, name + suffix);
    copyFileSync(source, target); chmodSync(target, 0o755);
    artifacts[name] = { file: name + suffix, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (name === 'apple-native-helper') {
      const providers = join(root, 'coordination/dist/src/providers');
      mkdirSync(providers, { recursive: true });
      copyFileSync(source, join(providers, name + suffix)); chmodSync(join(providers, name + suffix), 0o755);
    }
  }
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, artifacts }, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareNative(fileURLToPath(new URL('../', import.meta.url)), process.argv[2]);
