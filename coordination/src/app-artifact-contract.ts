import { ServiceError, object } from './errors.ts';
import { uuid } from './control/transfers.ts';
export const APP_CHUNK_BYTES = 512 * 1024;
export const APP_ARTIFACT_BYTES = 2 * 1024 ** 3;
export interface AppArtifactMetadata { id: string; machineId: string; leaseId?: string; format: 'apk' | 'ios-app-tar'; bytes: number; sha256: string; received: number; state: string; chunkBytes: number }
export function appArtifactMetadata(value: unknown): AppArtifactMetadata {
  const a = object(value);
  uuid(a.id); uuid(a.machineId); if (a.leaseId !== undefined) uuid(a.leaseId);
  if (!['apk','ios-app-tar'].includes(String(a.format)) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 1 || Number(a.bytes) > APP_ARTIFACT_BYTES || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) || !Number.isSafeInteger(a.received) || Number(a.received) < 0 || Number(a.received) > Number(a.bytes) || !['uploading','ready','deleted'].includes(String(a.state)) || a.chunkBytes !== APP_CHUNK_BYTES) throw new ServiceError('Invalid app artifact metadata.', 409);
  return a as unknown as AppArtifactMetadata;
}

