import { GuestChunkFiles as TransferFiles } from "../control/transfers.ts";
import type { ByteReader, TransferGuard, VerifiedDownload } from "../control/transfers.ts";
import { authorized } from "./https.ts";
import type { Authority, GuestRequest } from "./https.ts";

// The portable transfer implementation is shared with controller/Android workers.
// Keep one digest, cursor, durability and pinned-publication contract.
export { GUEST_CHUNK as CHUNK } from "../control/transfers.ts";
export type { ByteReader, VerifiedDownload } from "../control/transfers.ts";
export class GuestChunkFiles {
  private readonly files: TransferFiles;
  constructor(request: GuestRequest) { this.files = new TransferFiles(request); }
  private guard(check: Authority): TransferGuard { return { authorized: () => authorized(check) }; }
  list(path: string, check: Authority = () => true): Promise<Record<string, unknown>> { return this.files.list(path, this.guard(check)); }
  upload(path: string, reader: ByteReader, size: number, check: Authority = () => true): Promise<{ uploaded: number; durable: true }> { return this.files.upload(path, reader, size, this.guard(check)); }
  download(path: string, check: Authority = () => true): Promise<VerifiedDownload> { return this.files.download(path, this.guard(check)); }
}
