import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LAUNCHER_VERSION, UpdateStore, noUpdateLinks, updateDirectory } from './manager.ts';
import type { UpdateStoreOptions } from './manager.ts';
import { MAX_MANIFEST_BYTES, verifyRelease } from './protocol.ts';
import type { SignedRelease } from './protocol.ts';

export const MAX_ARTIFACT_BYTES = 512 * 1024 ** 2;
export const MAX_BUNDLE_BYTES = 2 * 1024 ** 3;
const CHUNK_BYTES = 256 * 1024;
export function unixBootstrapPlatform(platform: string = process.platform): void {
  if (platform !== 'linux' && platform !== 'darwin') throw new Error('Unsupported bootstrap platform: Unix ownership and directory durability required; Windows ACL support is unproven.');
}
export function absoluteBootstrapPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Use normalized absolute paths without control characters.');
  noUpdateLinks(path); return path;
}
export function pathsOverlap(a: string, b: string): boolean {
  const contains = (root: string, path: string): boolean => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  return contains(a, b) || contains(b, a);
}
/** Bounded reads even if an untrusted input grows after stat. No FIFO, device or link inputs. */
export async function openBootstrapFile(path: string, maximum: number): Promise<FileHandle> {
  absoluteBootstrapPath(path);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('Bootstrap input must be a bounded regular file with one link.');
    return file;
  } catch (error) { await file.close(); throw error; }
}
export async function readBootstrapJSON(path: string, maximum: number): Promise<unknown> {
  const file = await openBootstrapFile(path, maximum);
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maximum + 1 - bytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead; if (bytes > maximum) throw new Error('Bootstrap JSON exceeds its bound.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function boundedNames(path: string, maximum: number): Promise<string[]> {
  const names: string[] = [];
  const directory = await fs.opendir(path);
  for await (const entry of directory) {
    if (names.length >= maximum) throw new Error('Bundle directory exceeds its entry bound.');
    names.push(entry.name);
  }
  return names.sort();
}
async function assertAbsent(path: string): Promise<void> {
  try { await fs.lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('Bootstrap destination already exists; retain and inspect it, never overwrite or adopt it.');
}
export interface BootstrapOptions extends UpdateStoreOptions { bundleDirectory: string }
export interface BootstrapResult { installationId: string; releaseId: string; installationRoot: string; stateDirectory: string }

/** Offline content-addressed bundle expansion. Never executes a packaged file or hook.
 * Fresh roots are the no-replace reservation. Once reserved, all failures retain
 * them for inspection, including the original installation identity and journal.
 */
export async function bootstrapInstall(options: BootstrapOptions): Promise<BootstrapResult> {
  unixBootstrapPlatform();
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  if (options.target.os !== process.platform || options.target.arch !== arch) throw new Error('Unsupported bootstrap target: it must match this Unix host.');
  const installation = absoluteBootstrapPath(options.installationRoot), state = absoluteBootstrapPath(options.stateDirectory);
  const bundle = absoluteBootstrapPath(options.bundleDirectory);
  const protectedPaths = [...options.protectedPaths, bundle].map(absoluteBootstrapPath);
  if (pathsOverlap(installation, state) || protectedPaths.some(path => pathsOverlap(path, installation) || pathsOverlap(path, state))) throw new Error('Protected paths must not overlap bootstrap roots.');
  // Parents must already be private and operator-owned. No recursive adoption.
  updateDirectory(dirname(installation), false); updateDirectory(dirname(state), false);
  await assertAbsent(installation); await assertAbsent(state);
  if (!(await fs.lstat(bundle)).isDirectory() || (await boundedNames(bundle, 2)).join(',') !== 'artifacts,release.json') throw new Error('Bundle must contain exactly artifacts and release.json.');
  absoluteBootstrapPath(join(bundle, 'artifacts'));
  if (!(await fs.lstat(join(bundle, 'artifacts'))).isDirectory()) throw new Error('Artifacts must be a directory.');
  const release = verifyRelease(await readBootstrapJSON(join(bundle, 'release.json'), MAX_MANIFEST_BYTES + 4096), options.trustedKeys, options.target);
  if (release.manifest.minimumLauncherVersion > LAUNCHER_VERSION) throw new Error('Release needs a newer stable launcher.');
  const sizes = new Map<string, number>(); let total = 0;
  const maximum = Math.min(MAX_BUNDLE_BYTES, options.maxReleaseBytes ?? MAX_BUNDLE_BYTES);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid release bound.');
  for (const file of release.manifest.files) {
    total += file.bytes;
    if (file.bytes > MAX_ARTIFACT_BYTES || !Number.isSafeInteger(total) || total > maximum) throw new Error('Bundle exceeds bootstrap artifact/release bounds.');
    if (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.bytes) throw new Error('Conflicting artifact sizes.');
    sizes.set(file.sha256, file.bytes);
  }
  if ((await boundedNames(join(bundle, 'artifacts'), sizes.size)).join(',') !== [...sizes.keys()].sort().join(',')) throw new Error('Artifacts must exactly match the signed release.');
  // Exclusive mkdir prevents concurrent bootstrap from adopting or replacing roots.
  await fs.mkdir(installation, { mode: 0o700 }); await syncDirectory(dirname(installation));
  await fs.mkdir(state, { mode: 0o700 }); await syncDirectory(dirname(state));
  const store = new UpdateStore({ ...options, protectedPaths, maxReleaseBytes: maximum });
  store.validate(release); store.ensureSpace(total * 2);
  const expanded = join(state, 'bootstrap-source');
  await fs.mkdir(expanded, { mode: 0o700 }); await syncDirectory(state);
  await expand(bundle, expanded, release);
  await store.installInitial(release, expanded);
  return { installationId: store.installationId, releaseId: release.manifest.releaseId, installationRoot: installation, stateDirectory: state };
}
async function expand(bundle: string, destination: string, release: SignedRelease): Promise<void> {
  for (const entry of release.manifest.files) {
    const input = await openBootstrapFile(join(bundle, 'artifacts', entry.sha256), entry.bytes);
    try {
      const before = await input.stat(); if (before.size !== entry.bytes) throw new Error('Artifact size mismatch.');
      const outputPath = join(destination, entry.path);
      await fs.mkdir(dirname(outputPath), { mode: 0o700, recursive: true });
      const output = await fs.open(outputPath, 'wx', entry.executable ? 0o700 : 0o600);
      try {
        const hash = createHash('sha256'), chunk = Buffer.alloc(CHUNK_BYTES); let bytes = 0;
        while (true) {
          const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, entry.bytes - bytes + 1), null);
          if (!bytesRead) break;
          bytes += bytesRead; if (bytes > entry.bytes) throw new Error('Artifact grew during expansion.');
          const data = chunk.subarray(0, bytesRead); hash.update(data); await output.writeFile(data);
        }
        const after = await input.stat();
        if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256 || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Artifact digest mismatch or input changed.');
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
  }
  // Flush nested directory entries before handing the verified tree to the store.
  const syncTree = async (path: string): Promise<void> => { for (const entry of await fs.readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await syncTree(join(path, entry.name)); await syncDirectory(path); };
  await syncTree(destination);
}
