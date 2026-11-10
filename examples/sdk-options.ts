/** Shared options for portable SDK examples. No live operation runs on --help. */
import { parseArgs } from 'node:util';
import { writeFile, lstat, open } from 'node:fs/promises';
import { ConsumerError, LeaseClient } from '../coordination/dist/src/sdk.js';
import type { ClientOptions } from '../coordination/dist/src/sdk.js';
export function options(description: string, fields: string[], booleans: string[] = []) {
  const definitions = Object.fromEntries([...new Set(['url', 'ca-file', 'credential-file', ...fields])].map(key => [key, { type: 'string' as const }]));
  const { values } = parseArgs({ options: { ...definitions, ...Object.fromEntries(['help', 'allow-loopback-http', ...booleans].map(key => [key, { type: 'boolean' as const }])) }, strict: true });
  if (values.help) { console.log(description + '\n' + Object.keys(definitions).map(key => '--' + key + ' VALUE').join('\n') + '\n--help\n--allow-loopback-http\n' + booleans.map(key => '--' + key).join('\n')); return null; }
  const required = (key: string): string => { const value = values[key]; if (typeof value !== 'string' || !value) throw new Error('Missing --' + key); return value; };
  const base: ClientOptions = { baseUrl: required('url'), ...(typeof values['ca-file'] === 'string' ? { caFile: values['ca-file'] } : {}), allowLoopbackHttp: values['allow-loopback-http'] === true };
  return { values, required, base, lease: () => LeaseClient.fromCredentialFile({ ...base, leaseId: required(typeof values.lease === 'string' ? 'lease' : 'lease-id'), credentialFile: required('credential-file') }) };
}
export async function privateOutput(path: string, data: string | Uint8Array): Promise<void> { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
export async function ensureNewOutput(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('The output already exists.');
}
export async function readRequestFile(path: string): Promise<unknown> {
  const input = await open(path, 'r');
  try {
    if (!(await input.stat()).isFile()) throw new Error('A regular request file is required.');
    const buffer = Buffer.alloc(1048577); let used = 0;
    while (used < buffer.length) { const { bytesRead } = await input.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > 1048576) throw new Error('Request too large.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used))) as unknown;
  } finally { await input.close(); }
}
export function failure(error: unknown): void {
  console.log(JSON.stringify(error instanceof ConsumerError ? { state: error.outcome === 'unknown' ? 'needs-inspection' : 'incomplete', code: error.code, requestId: error.requestId } : { state: 'incomplete', code: 'local_configuration_or_io_failed' }));
  process.exitCode = 1;
}
