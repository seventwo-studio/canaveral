/** CI-side uploads use the same header-authenticated client as the CLI. */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { ServiceError } from './errors.ts';
import { appArtifactMetadata } from './app-artifact-contract.ts';
import type { AppArtifactMetadata } from './app-artifact-contract.ts';
import { APP_CHUNK_BYTES, APP_ARTIFACT_BYTES } from './app-artifact-contract.ts';
import { uuid } from './control/transfers.ts';

export interface AppArtifactClient { request(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> }
/** Reusing the UUID resumes confirmed chunks of the same immutable file, never installation. */
export async function uploadAppArtifactFile(client: AppArtifactClient, options: {
  machineId: string; id: string; format: 'apk' | 'ios-app-tar'; file: string;
}): Promise<AppArtifactMetadata> {
  const machine = uuid(options.machineId), id = uuid(options.id);
  if (!['apk','ios-app-tar'].includes(options.format)) throw new ServiceError('Invalid app artifact format.', 400);
  const file = await fs.open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat({ bigint: true }), size = Number(initial.size);
    if (!initial.isFile() || !Number.isSafeInteger(size) || size < 1 || size > APP_ARTIFACT_BYTES) throw new ServiceError('App artifact must be a bounded regular file.', 400);
    const unchanged = async () => {
      const now = await file.stat({ bigint: true });
      if (['dev','ino','size','mtimeNs','ctimeNs'].some(key => now[key as keyof typeof now] !== initial[key as keyof typeof initial])) throw new ServiceError('App artifact changed during upload.', 409);
    };
    const hash = createHash('sha256'), buffer = Buffer.alloc(APP_CHUNK_BYTES);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new ServiceError('App artifact ended during hashing.', 409);
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    await unchanged(); const sha256 = hash.digest('hex');
    const metadata = { id, format: options.format, bytes: size, sha256 };
    let current = appArtifactMetadata(await client.request('POST', `/v1/machines/${machine}/app-artifacts`, metadata));
    const validate = () => {
      if (current.id !== id || current.machineId !== machine || current.bytes !== size || current.sha256 !== sha256 || current.format !== options.format || current.state === 'deleted') throw new ServiceError('App artifact upload identity differs.', 409);
    };
    validate();
    if (current.state === 'ready') return current;
    for (let offset = current.received; offset < size;) {
      await unchanged(); const wanted = Math.min(APP_CHUNK_BYTES, size - offset); let length = 0;
      while (length < wanted) {
        const { bytesRead } = await file.read(buffer, length, wanted - length, offset + length);
        if (!bytesRead) throw new ServiceError('App artifact ended during upload.', 409); length += bytesRead;
      }
      await unchanged();
      current = appArtifactMetadata(await client.request('POST', `/v1/app-artifacts/${id}/chunks`, { offset, data: buffer.subarray(0, length).toString('base64') }));
      validate(); offset += length;
      if (current.received !== offset || current.state !== 'uploading') throw new ServiceError('App artifact cursor differs.', 409);
    }
    await unchanged();
    current = appArtifactMetadata(await client.request('POST', `/v1/app-artifacts/${id}/complete`, {})); validate();
    if (current.state !== 'ready') throw new ServiceError('App artifact publication was not confirmed.', 409);
    return current;
  } finally { await file.close(); }
}
