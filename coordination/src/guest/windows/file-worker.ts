import { WindowsRoot, type WindowsFileAPI } from "./files.ts";
import { WindowsDownloads, validateFileRequest } from "./downloads.ts";
import { nativeTransport, Win32Files } from "./native.ts";
import { type WorkerTransport } from "./ipc.ts";
import { type Authority } from "./common.ts";
export interface WindowsFileWorkerOptions {
  drive: string; prefix: readonly string[]; resolve(path: string): readonly string[];
  authorized: Authority; cleanupAuthorized?: Authority; transport?: WorkerTransport; api?: WindowsFileAPI;
}
/** One root generation; validated requests lazily pin once and never reopen after failure. */
export class WindowsFileWorker {
  readonly root: WindowsRoot; readonly downloads: WindowsDownloads; readonly transport?: WorkerTransport;
  private started?: Promise<void>; private nativeReleased = false; cleanupConfirmed = false;
  constructor(options: WindowsFileWorkerOptions) {
    const transport = options.transport ?? (options.api ? undefined : nativeTransport(options.authorized, options.cleanupAuthorized ?? options.authorized));
    if (transport) this.transport = transport;
    this.root = new WindowsRoot(options.drive, options.prefix, options.api ?? new Win32Files(transport!));
    this.downloads = new WindowsDownloads(this.root, options.resolve, options.authorized, options.cleanupAuthorized ?? options.authorized);
  }
  async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    const request = validateFileRequest(path, body); this.downloads.authorize(request.route === "abort");
    this.started ??= this.root.start().then(() => {}); await this.started;
    return this.downloads.request(path, body);
  }
  async shutdown(): Promise<boolean> {
    if (this.cleanupConfirmed) return true;
    if (!this.nativeReleased) this.nativeReleased = await this.downloads.close();
    if (!this.nativeReleased) return false;
    this.cleanupConfirmed = this.transport ? await this.transport.close() : true; return this.cleanupConfirmed;
  }
  async close(): Promise<boolean> { this.downloads.fenced = true; return this.transport ? this.transport.close() : this.root.close(); }
}
