#!/usr/bin/env node
/** Offline assembly of managed engine assets; never executes or installs the engine. */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

async function trusted(path, directory = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || (info.uid !== 0 && info.uid !== process.getuid()) ||
        ((info.mode & 0o022) && !(info.isDirectory() && info.uid === 0 && (info.mode & 0o1000)))) {
      throw new Error('Unsafe runtime package path.');
    }
  }
  if (directory && !(await fs.lstat(absolute)).isDirectory()) throw new Error('Runtime package directory required.');
  return absolute;
}
function relative(path) {
  const parts = path.split('/');
  if (!path || Buffer.byteLength(path) > 1024 || parts.length > 32 || parts.some(part =>
    !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || /[\\\x00-\x1f\x7f]/.test(part))) {
    throw new Error('Unsafe runtime asset name.');
  }
}
export async function packageModelRuntime({ inputs, output, os, arch, entrypoint, baseUrl }) {
  if (!['macos', 'linux'].includes(os) || !['aarch64', 'x86_64'].includes(arch)) throw new Error('Unsupported runtime target.');
  relative(entrypoint);
  if (baseUrl !== undefined) {
    const url = new URL(baseUrl);
    const authority = baseUrl.split('://')[1]?.split('/')[0] ?? '';
    if (Buffer.byteLength(baseUrl) > 4096 || authority.includes('@') || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error('Use a credential-free HTTPS release directory.');
    }
  }
  const source = await trusted(inputs, true), destination = resolve(output);
  if (Buffer.byteLength(join(destination, 'assets')) > 4096) throw new Error('Runtime package root exceeds bounds.');
  if (destination === source || destination.startsWith(source + sep)) throw new Error('Output must be outside the input tree.');
  await trusted(dirname(destination), true);
  const listed = [], pending = [''];
  let total = 0, pathBytes = 0, entries = 0;
  while (pending.length) {
    const prefix = pending.pop();
    for (const name of (await fs.readdir(join(source, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      relative(path);
      if (++entries > 8192) throw new Error('Runtime package has too many entries.');
      const info = await fs.lstat(join(source, path));
      if (info.isSymbolicLink() || (info.uid !== 0 && info.uid !== process.getuid()) || info.mode & 0o6022) throw new Error('Unsafe runtime input.');
      if (info.isDirectory()) { pending.push(path); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 ** 3) throw new Error('Runtime input must be a bounded, single-linked file.');
      listed.push({ path, info });
      total += info.size; pathBytes += Buffer.byteLength(path);
      if (listed.length > 4096 || total > 8 * 1024 ** 3 || pathBytes > 1024 ** 2) throw new Error('Runtime package exceeds bounds.');
    }
  }
  if (!listed.some(file => file.path === entrypoint && (file.info.mode & 0o111))) throw new Error('List an executable package entrypoint.');
  listed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await fs.mkdir(destination, { mode: 0o700 });
  const identity = await fs.lstat(destination);
  try {
    const assets = join(destination, 'assets');
    await fs.mkdir(assets, { mode: 0o700 });
    const files = Object.create(null), executables = [], buffer = Buffer.alloc(65536);
    const directories = new Set([assets, destination]);
    let actualTotal = 0;
    for (const { path, info } of listed) {
      await trusted(join(source, path));
      const input = await fs.open(join(source, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await input.stat();
        if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.nlink !== 1 ||
            before.size !== info.size || before.mode !== info.mode || before.mtimeMs !== info.mtimeMs || before.ctimeMs !== info.ctimeMs) throw new Error('Runtime input changed.');
        if (path === entrypoint) {
          const header = Buffer.alloc(4);
          const read = await input.read(header, 0, header.length, 0);
          const magic = header.toString('hex');
          const allowed = os === 'linux' ? ['7f454c46'] : ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca'];
          if (read.bytesRead !== 4 || !allowed.includes(magic)) throw new Error('Package entrypoint must be a native engine or hermetic native launcher.');
        }
        await fs.mkdir(dirname(join(assets, path)), { recursive: true, mode: 0o700 });
        for (let directory = dirname(join(assets, path)); directory !== destination; directory = dirname(directory)) directories.add(directory);
        const target = await fs.open(join(assets, path), 'wx', 0o600);
        const hash = createHash('sha256'); let bytes = 0;
        try {
          for (;;) {
            const read = await input.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            bytes += read.bytesRead;
            actualTotal += read.bytesRead;
            if (bytes > before.size || bytes > 2 * 1024 ** 3 || actualTotal > 8 * 1024 ** 3) throw new Error('Runtime input grew or exceeded package bounds.');
            const chunk = buffer.subarray(0, read.bytesRead);
            hash.update(chunk); await target.writeFile(chunk);
          }
          const after = await input.stat();
          if (bytes !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Runtime input changed during assembly.');
          const executable = (before.mode & 0o111) !== 0;
          await target.chmod(executable ? 0o500 : 0o400); await target.sync();
          if (executable) executables.push(path);
          files[path] = hash.digest('hex');
        } finally { await target.close(); }
      } finally { await input.close(); }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const runtimePackage = { os, arch, ...(baseUrl ? { baseUrl } : { root: assets }), entrypoint, files, executables };
    const marker = await fs.open(join(destination, 'runtime-package.json'), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify(runtimePackage, null, 2) + '\n'); await marker.sync(); }
    finally { await marker.close(); }
    for (const directory of [destination, dirname(destination)]) {
      const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return runtimePackage;
  } catch (error) {
    const current = await fs.lstat(destination);
    if (current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink()) await fs.rm(destination, { recursive: true });
    throw error;
  }
}
async function main(args) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true,
    options: Object.fromEntries(['inputs', 'output', 'os', 'arch', 'entrypoint', 'base-url'].map(key => [key, { type: 'string' }])) });
  if (positionals.length || ['inputs', 'output', 'os', 'arch', 'entrypoint'].some(key => !values[key])) {
    throw new Error('Usage: package_model_runtime.mjs --inputs DIR --output NEW_DIR --os macos|linux --arch aarch64|x86_64 --entrypoint PATH [--base-url HTTPS_DIRECTORY]');
  }
  const result = await packageModelRuntime({ ...values, baseUrl: values['base-url'] });
  console.log(JSON.stringify({ os: result.os, arch: result.arch, files: Object.keys(result.files).length }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
