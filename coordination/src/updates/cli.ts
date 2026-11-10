#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CliClient, CliError, metadata, privateInput } from '../account-cli.ts';
import type { RequestClient } from '../account-cli.ts';
import { UUID, MAX_MANIFEST_BYTES, canonicalManifest, parseSignedRelease, verifyRelease } from './protocol.ts';
import type { SignedRelease, TrustedKeys } from './protocol.ts';

export interface UpdateIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  client?: RequestClient;
}
export const ARTIFACT_CHUNK_BYTES = 512 * 1024;
const HELP = `Managed host and guest runtime updates (controller images are updated externally)
Usage: canaveral updates [--url ORIGIN --token-file FILE --ca-file FILE] COMMAND
  releases upload --bundle DIR --trusted-keys FILE
  releases list
  releases status --id UUID
  rollouts create --id UUID --release-id UUID [--host-id UUID ...] [--runner-id UUID ...]
  rollouts list
  rollouts status --id UUID
  rollouts cancel --id UUID

Upload verifies the signed bundle against an operator-pinned JSON keyId-to-public-PEM
map. Repeating upload replays exact chunks; keep the same bundle and signing bytes.
Rollout creation requires your stable UUID; retries retain the exact body and ID.
Cancellation only cancels queued, undelivered jobs. Delivered or uncertain jobs need
positive host receipts; cancellation never forces workloads to stop or frees VM disks.
`;
const OPTIONS = {
  url: { type: 'string' }, 'token-file': { type: 'string' }, 'allow-http': { type: 'boolean' }, 'ca-file': { type: 'string' },
  bundle: { type: 'string' }, 'trusted-keys': { type: 'string' }, id: { type: 'string' },
  'release-id': { type: 'string' }, 'host-id': { type: 'string', multiple: true }, help: { type: 'boolean' },
  'runner-id': { type: 'string', multiple: true },
} as const;
async function noLinks(path: string): Promise<string> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new CliError('Bundle paths must not traverse links. Use real absolute paths.');
  }
  return absolute;
}
async function openFile(path: string): Promise<FileHandle> {
  await noLinks(path);
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new CliError('Use regular bundle files with one link.'); return file; }
  catch (error) { await file.close(); throw error; }
}
async function readJson(path: string, maximum: number): Promise<unknown> {
  const file = await openFile(path);
  try {
    if ((await file.stat()).size > maximum) throw new CliError('Update input exceeds its size limit.');
    const data = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < data.length) { const result = await file.read(data, size, data.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > maximum) throw new CliError('Update input exceeds its size limit.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size))) as unknown;
  } finally { await file.close(); }
}
function keys(value: unknown): TrustedKeys {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('Trusted keys must be an operator-pinned JSON public PEM map.');
  for (const [key, pem] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new CliError('Trusted keys must contain only public PEM keys.');
  }
  return value as TrustedKeys;
}
function uuid(value: string): string {
  if (!UUID.test(value) || value === '00000000-0000-0000-0000-000000000000') throw new CliError('Supply a canonical nonnil UUID.');
  return value;
}
/** Only bounded exact replay is automatic. No new operation identities or requests are invented. */
async function replay(client: RequestClient, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try { return await client.request('POST', path, body); }
  catch (error) {
    if (!(error instanceof CliError) || error.outcome !== 'unknown' || (error.status >= 300 && error.status < 400)) throw error;
    return client.request('POST', path, body);
  }
}
async function bundleRelease(bundle: string, trustFile: string): Promise<SignedRelease> {
  await noLinks(bundle);
  const release = verifyRelease(await readJson(join(bundle, 'release.json'), MAX_MANIFEST_BYTES + 4096), keys(await readJson(trustFile, 1024 * 1024)));
  const entries = (await fs.readdir(bundle)).sort();
  if (entries.join(',') !== 'artifacts,release.json') throw new CliError('Bundle contains unexpected entries.');
  await noLinks(join(bundle, 'artifacts'));
  const expected = [...new Set(release.manifest.files.map(file => file.sha256))].sort();
  if ((await fs.readdir(join(bundle, 'artifacts'))).sort().join(',') !== expected.join(',')) throw new CliError('Artifact directory does not exactly match the signed manifest.');
  const sizes = new Map<string, number>();
  let total = 0;
  for (const file of release.manifest.files) {
    total += file.bytes;
    if (file.bytes > 512 * 1024 ** 2 || total > 2 * 1024 ** 3) throw new CliError('Bundle exceeds controller artifact/release limits.');
    const old = sizes.get(file.sha256);
    if (old !== undefined && old !== file.bytes) throw new CliError('Conflicting artifact sizes.');
    sizes.set(file.sha256, file.bytes);
  }
  // Verify all local bytes before any mutation of controller state.
  for (const [sha256, bytes] of sizes) {
    const file = await openFile(join(bundle, 'artifacts', sha256));
    try {
      if ((await file.stat()).size !== bytes) throw new CliError('Artifact size mismatch.');
      const hash = createHash('sha256'), buffer = Buffer.alloc(ARTIFACT_CHUNK_BYTES); let size = 0;
      while (true) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; size += read.bytesRead; if (size > bytes) throw new CliError('Artifact grew during verification.'); hash.update(buffer.subarray(0, read.bytesRead)); }
      if (size !== bytes || hash.digest('hex') !== sha256) throw new CliError('Artifact SHA256 mismatch.');
    } finally { await file.close(); }
  }
  return release;
}
async function upload(client: RequestClient, bundle: string, release: SignedRelease): Promise<Record<string, unknown>> {
  // Registration before transfer lets controller establish signed size bounds.
  const registered = parseSignedRelease(await replay(client, '/v1/updates/releases', release as unknown as Record<string, unknown>));
  if (!canonicalManifest(registered.manifest).equals(canonicalManifest(release.manifest)) || registered.keyId !== release.keyId || registered.signature !== release.signature) throw new CliError('Release registration was not confirmed.', 502, release.manifest.releaseId, 'unknown');
  const done = new Set<string>();
  for (const artifact of release.manifest.files) {
    if (done.has(artifact.sha256)) continue;
    done.add(artifact.sha256);
    const file = await openFile(join(bundle, 'artifacts', artifact.sha256));
    try {
      if ((await file.stat()).size !== artifact.bytes) throw new CliError('Artifact changed before upload.');
      const hash = createHash('sha256');
      for (let offset = 0; offset < artifact.bytes || (offset === 0 && artifact.bytes === 0); offset += ARTIFACT_CHUNK_BYTES) {
        const data = Buffer.alloc(Math.min(ARTIFACT_CHUNK_BYTES, artifact.bytes - offset));
        let size = 0;
        while (size < data.length) { const read = await file.read(data, size, data.length - size, offset + size); if (!read.bytesRead) throw new CliError('Artifact truncated during upload.'); size += read.bytesRead; }
        hash.update(data);
        const ack = await replay(client, `/v1/updates/artifacts/${artifact.sha256}`, { offset, totalBytes: artifact.bytes, data: data.toString('base64') });
        if (ack.sha256 !== artifact.sha256 || ack.totalBytes !== artifact.bytes || !Number.isSafeInteger(ack.receivedBytes) || Number(ack.receivedBytes) < offset + size || Number(ack.receivedBytes) > artifact.bytes || (offset + size === artifact.bytes && ack.verified !== true)) throw new CliError('Artifact receipt was not confirmed.', 502, release.manifest.releaseId, 'unknown');
      }
      if (hash.digest('hex') !== artifact.sha256 || (await file.stat()).size !== artifact.bytes) throw new CliError('Artifact changed during upload. Inspect controller state before rollout.');
    } finally { await file.close(); }
  }
  return { releaseId: release.manifest.releaseId, uploaded: true, artifacts: done.size };
}
/** argv excludes the parent CLI's `updates` command. Returns process-style status, never prints credentials. */
export async function updateMain(argv: string[], io: UpdateIO = {}): Promise<number> {
  const stdout = io.stdout ?? (text => { process.stdout.write(text); });
  const stderr = io.stderr ?? (text => { process.stderr.write(text); });
  let recovery = '';
  try {
    const { values, positionals, tokens } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true, tokens: true });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option' || ['host-id', 'runner-id'].includes(token.name)) continue;
      if (seen.has(token.name)) throw new CliError('An update option was supplied more than once.');
      seen.add(token.name);
    }
    if (values.help && positionals.length === 0) { stdout(HELP); return 0; }
    const command = positionals.join(' ');
    const allowed: Record<string, string[]> = {
      'releases upload': ['bundle', 'trusted-keys'], 'releases list': [], 'releases status': ['id'],
      'rollouts create': ['id', 'release-id', 'host-id', 'runner-id'], 'rollouts list': [], 'rollouts status': ['id'], 'rollouts cancel': ['id'],
    };
    if (!Object.hasOwn(allowed, command)) throw new CliError('Supply a known updates command; use --help.');
    const required = allowed[command]!;
    for (const key of Object.keys(values)) if (!['url', 'token-file', 'allow-http', 'ca-file'].includes(key) && !required.includes(key)) throw new CliError('Option is not supported by this updates command.');
    for (const key of required) if (!['host-id', 'runner-id'].includes(key) && !values[key as keyof typeof values]) throw new CliError(`Missing --${key}.`);
    const id = values.id === undefined ? undefined : uuid(values.id);
    if (id) recovery = ` Inspect rollout/release ${id}; replay the same ID and exact body after uncertainty.`;
    let body: Record<string, unknown> | undefined;
    if (command === 'rollouts create') {
      const hostIds = (values['host-id'] ?? []).map(uuid);
      const runnerIds = (values['runner-id'] ?? []).map(uuid);
      if (!hostIds.length && !runnerIds.length) throw new CliError('Supply at least one --host-id or --runner-id.');
      if (new Set(hostIds).size !== hostIds.length) throw new CliError('Duplicate host IDs are not allowed.');
      if (new Set(runnerIds).size !== runnerIds.length) throw new CliError('Duplicate runner IDs are not allowed.');
      body = { id: id!, releaseId: uuid(values['release-id']!), hostIds, ...(runnerIds.length ? { runnerIds } : {}) };
    }
    let release: SignedRelease | undefined;
    if (command === 'releases upload') {
      release = await bundleRelease(values.bundle!, values['trusted-keys']!);
      recovery = ` Inspect release ${release.manifest.releaseId}; replay the same bundle after uncertainty.`;
    }
    let client = io.client;
    if (!client) {
      if (!values.url || !values['token-file']) throw new CliError('Supply --url and a private --token-file.');
      const ca = values['ca-file'] ? await fs.readFile(values['ca-file']) : undefined;
      client = new CliClient(values.url, await privateInput(values['token-file']), values['allow-http'] ?? false, ca);
    }
    let result: Record<string, unknown>;
    if (command === 'releases upload') result = await upload(client, values.bundle!, release!);
    else if (command === 'rollouts create') {
      result = await replay(client, '/v1/updates/rollouts', body!);
      if (result.id !== body!.id || result.releaseId !== body!.releaseId || JSON.stringify(result.hostIds) !== JSON.stringify(body!.hostIds) || JSON.stringify(result.runnerIds ?? []) !== JSON.stringify(body!.runnerIds ?? []) || !Array.isArray(result.jobs)) throw new CliError('Rollout creation was not confirmed.', 502, id, 'unknown');
    } else if (command === 'rollouts cancel') {
      result = await replay(client, `/v1/updates/rollouts/${id!}/cancel`, {});
      if (result.id !== id || !Array.isArray(result.jobs)) throw new CliError('Rollout cancellation was not confirmed.', 502, id, 'unknown');
    }
    else {
      const resource = positionals[0]!;
      result = await client.request('GET', `/v1/updates/${resource}${positionals[1] === 'status' ? `/${id!}` : ''}`);
    }
    stdout(JSON.stringify(metadata(result)) + '\n'); return 0;
  } catch (error) {
    // Paths, PEMs, server diagnostics and argv can contain secrets. Do not echo arbitrary errors.
    const uncertain = error instanceof CliError && error.outcome === 'unknown';
    const local = error instanceof CliError && error.status === 400;
    stderr((uncertain ? 'Update response was not confirmed.' : local ? error.message : 'Update command failed. Check local inputs, trust and controller status.') + recovery + '\n');
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void updateMain(process.argv.slice(2)).then(status => { process.exitCode = status; });
}
