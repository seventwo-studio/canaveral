import { createPublicKey, verify } from 'node:crypto';

export type Target = { os: 'linux' | 'darwin' | 'win32'; arch: 'amd64' | 'arm64' };
export type ReleaseFile = { path: string; sha256: string; bytes: number; executable: boolean; component: 'host' | 'guest' | 'native-helper' };
export type Manifest = {
  schema: 'canaveral-update-v1'; releaseId: string; version: string; sequence: number;
  createdAt: number; target: Target; minimumLauncherVersion: number; entrypoint: string; files: ReleaseFile[];
};
export type SignedRelease = { manifest: Manifest; keyId: string; signature: string };
export type TrustedKeys = Readonly<Record<string, string>>;
export const MAX_RELEASE_FILES = 10_000;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function fail(message: string): never { throw new Error(`Invalid update release: ${message}`); }
function object(value: unknown, fields: readonly string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${at} must be an object`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${at} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key))) fail(`${at} has missing or unknown fields`);
  for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor) || !descriptor.enumerable) fail(`${at} must contain JSON data`);
  return value as Record<string, unknown>;
}
function string(value: unknown, at: string, max = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail(`${at} must be bounded well-formed Unicode`);
  return value;
}
function integer(value: unknown, at: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) fail(`${at} must be a safe integer >= ${minimum}`);
  return value;
}
/** Portable relative paths: no aliases that Windows or Unicode filesystems can collapse. */
export function releasePath(value: unknown): string {
  const path = string(value, 'file path');
  if (path !== path.normalize('NFC') || /[\\\x00-\x1f\x7f:<>"|?*]/u.test(path)) fail('unsafe file path');
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('unsafe file path component');
  }
  return path;
}
export function parseTarget(value: unknown): Target {
  const target = object(value, ['os', 'arch'], 'target');
  if (target.os !== 'linux' && target.os !== 'darwin' && target.os !== 'win32') fail('unsupported target OS');
  if (target.arch !== 'amd64' && target.arch !== 'arm64') fail('unsupported target architecture');
  return { os: target.os, arch: target.arch };
}
export function parseManifest(value: unknown): Manifest {
  const m = object(value, ['schema', 'releaseId', 'version', 'sequence', 'createdAt', 'target', 'minimumLauncherVersion', 'entrypoint', 'files'], 'manifest');
  if (m.schema !== 'canaveral-update-v1') fail('unsupported schema');
  const releaseId = string(m.releaseId, 'releaseId');
  if (!UUID.test(releaseId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(releaseId)) fail('releaseId must be a canonical nonnil UUID');
  const version = string(m.version, 'version', 256);
  if (!SEMVER.test(version)) fail('version must be semver');
  const target = parseTarget(m.target);
  const entrypoint = releasePath(m.entrypoint);
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > MAX_RELEASE_FILES) fail('files must be a bounded nonempty array');
  const paths = new Set<string>();
  const files = Array.from(m.files, (value): ReleaseFile => {
    const file = object(value, ['path', 'sha256', 'bytes', 'executable', 'component'], 'file');
    const path = releasePath(file.path);
    const folded = path.toLowerCase();
    if (paths.has(folded)) fail('duplicate file path');
    paths.add(folded);
    const sha256 = string(file.sha256, 'sha256');
    if (!HASH.test(sha256)) fail('sha256 must be lowercase hex');
    if (typeof file.executable !== 'boolean') fail('executable must be boolean');
    if (file.component !== 'host' && file.component !== 'guest' && file.component !== 'native-helper') fail('unsupported component');
    return { path, sha256, bytes: integer(file.bytes, 'bytes'), executable: file.executable, component: file.component };
  });
  // A file cannot also be the parent directory of another file.
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (paths.has(parts.join('/'))) fail('file/directory path collision'); parts.pop(); }
  }
  if (!files.some(file => file.path === entrypoint && file.component === 'host')) fail('entrypoint must name a host file');
  const result: Manifest = { schema: m.schema, releaseId, version, sequence: integer(m.sequence, 'sequence', 1), createdAt: integer(m.createdAt, 'createdAt'), target, minimumLauncherVersion: integer(m.minimumLauncherVersion, 'minimumLauncherVersion', 1), entrypoint, files };
  if (Buffer.byteLength(canonical(result)) > MAX_MANIFEST_BYTES) fail('manifest too large');
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
/** Sorted object keys recursively, array order preserved; UTF-8, no BOM/newline. */
export function canonicalManifest(manifest: Manifest): Buffer { return Buffer.from(canonical(parseManifest(manifest)), 'utf8'); }
export function parseSignedRelease(value: unknown): SignedRelease {
  const envelope = object(value, ['manifest', 'keyId', 'signature'], 'envelope');
  const keyId = string(envelope.keyId, 'keyId', 128);
  if (!/^[A-Za-z0-9._-]+$/.test(keyId)) fail('invalid keyId');
  const signature = string(envelope.signature, 'signature', 88);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || Buffer.from(signature, 'base64').length !== 64 || Buffer.from(signature, 'base64').toString('base64') !== signature) fail('signature must be canonical base64 Ed25519');
  return { manifest: parseManifest(envelope.manifest), keyId, signature };
}
/** Returns a validated detached copy. Trust comes only from the caller's pinned PEM map. */
export function verifyRelease(envelope: unknown, trustedKeys: TrustedKeys, target?: Target): SignedRelease {
  const release = parseSignedRelease(envelope);
  if (!Object.hasOwn(trustedKeys, release.keyId) || typeof trustedKeys[release.keyId] !== 'string') fail('untrusted signing key');
  if (!trustedKeys[release.keyId]!.trim().startsWith('-----BEGIN PUBLIC KEY-----')) fail('trust roots must be public PEM keys');
  const key = createPublicKey(trustedKeys[release.keyId]!);
  if (key.asymmetricKeyType !== 'ed25519') fail('signing key must be Ed25519');
  if (!verify(null, canonicalManifest(release.manifest), key, Buffer.from(release.signature, 'base64'))) fail('signature verification failed');
  if (target) {
    const expected = parseTarget(target);
    if (expected.os !== release.manifest.target.os || expected.arch !== release.manifest.target.arch) fail('target mismatch');
  }
  return release;
}
