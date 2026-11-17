import { createHash } from 'node:crypto';
import { ServiceError, object } from './errors.ts';
import { APP_CHUNK_BYTES, appArtifactMetadata } from './app-artifact-contract.ts';
export { appArtifactMetadata } from './app-artifact-contract.ts';
export type { AppArtifactMetadata } from './app-artifact-contract.ts';
import { decodeData } from './control/transfers.ts';
import type { Download } from './providers/mobile.ts';

/** Only reads the controller-selected artifact for this exact pending operation. */
export async function appArtifactSource(
  request: (path: string) => Promise<Record<string, unknown>>, prefix: string,
  expected: { artifact: string; machine: string; format: 'apk' | 'ios-app-tar' },
  authorized: () => boolean,
): Promise<{ source: Download; sha256: string }> {
  const check = () => { if (!authorized()) throw new ServiceError('App artifact authorization ended.', 401); };
  check(); const metadata = appArtifactMetadata(await request(prefix)); check();
  if (metadata.id !== expected.artifact || metadata.machineId !== expected.machine || metadata.format !== expected.format || metadata.state !== 'ready' || metadata.received !== metadata.bytes) throw new ServiceError('App artifact assignment differs.', 409);
  let offset = 0, buffered: Buffer = Buffer.alloc(0), closed = false;
  const hash = createHash('sha256'); let digest: string | undefined;
  const source: Download = {
    size: metadata.bytes,
    async read(count) {
      check(); if (closed || !Number.isSafeInteger(count) || count < 1 || count > 65536) throw new ServiceError('Invalid app artifact read.', 400);
      if (!buffered.length && offset < metadata.bytes) {
        const chunk = object(await request(`${prefix}/chunks/${offset}`)); check();
        const data = decodeData(chunk.data, APP_CHUNK_BYTES);
        if (chunk.offset !== offset || data.length !== Math.min(APP_CHUNK_BYTES, metadata.bytes - offset)) throw new ServiceError('App artifact chunk differs.', 409);
        buffered = data;
      }
      if (offset === metadata.bytes) return Buffer.alloc(0);
      const part = buffered.subarray(0, count); buffered = buffered.subarray(part.length); offset += part.length; hash.update(part); return part;
    },
    async verify() {
      check(); if (closed) return false;
      const current = appArtifactMetadata(await request(prefix)); check();
      if (JSON.stringify(current) !== JSON.stringify(metadata)) return false;
      // Before the first byte this checks immutable source identity; after EOF it also checks content.
      if (offset === 0) return true;
      if (offset !== metadata.bytes || buffered.length) return false;
      digest ??= hash.digest('hex'); return digest === metadata.sha256;
    },
    async close() { closed = true; buffered = Buffer.alloc(0); },
  };
  return { source, sha256: metadata.sha256 };
}
