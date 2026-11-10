import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { WindowsProcessWorker, type WorkerTransport } from "./ipc.ts";
import { CHUNK, ServiceError, base64, integer, object, unsupported, type Authority } from "./common.ts";
import { component, type DirectoryEntry, type FileIdentity, type Handle, type WindowsFileAPI } from "./files.ts";
import { type Bounds, type InputEvent } from "./input.ts";
import { type WindowsKeyAPI, type Layout } from "./keys.ts";
import { type UIADetails, type WindowsUIAAPI } from "./accessibility.ts";
export function nativeTransport(authorized: Authority, cleanupAuthorized = authorized, timeoutMs = 5000): WindowsProcessWorker {
  if (process.platform !== "win32" || process.arch !== "x64") unsupported("Native helpers require a 64-bit Windows guest.");
  let script = fileURLToPath(new URL("./native.ps1", import.meta.url));
  if (!existsSync(script)) script = fileURLToPath(new URL("../../../../src/guest/windows/native.ps1", import.meta.url));
  if (!existsSync(script)) unsupported("Windows native helper assets are not installed.");
  // Fixed internal script only; guest executables travel as framed JSON, never shell text.
  return new WindowsProcessWorker({ command: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-NonInteractive", "-Mta", "-File", script], authorized, cleanupAuthorized, timeoutMs });
}
export class Win32Files implements WindowsFileAPI {
  cleanupUncertain = false;
  constructor(readonly transport: WorkerTransport) {}
  private async call(action: string, args: Record<string, unknown>, effect = false, cleanup = false): Promise<unknown> {
    try { return await this.transport.request(`files.${action}`, args, { effect, cleanup }); }
    catch (error) { if (["drive", "open", "create", "journal", "exists"].includes(action) && error instanceof ServiceError && error.outcome === "unknown") this.cleanupUncertain = true; throw error; }
  }
  private async handle(action: string, args: Record<string, unknown>): Promise<Handle> { const result = await this.call(action, args, true); if (typeof result !== "string" || !result) throw new ServiceError("Native handle identity is malformed.", 409, { outcome: "unknown" }); return result; }
  drive(drive: string): Promise<Handle> { return this.handle("drive", { drive }); }
  open(parent: Handle, name: string, directory: boolean): Promise<Handle> { return this.handle("open", { parent, name, directory }); }
  async info(handle: Handle): Promise<FileIdentity> { return object(await this.call("info", { handle })) as unknown as FileIdentity; }
  async read(handle: Handle, offset: number, count: number): Promise<Buffer> { if (!integer(offset) || !integer(count, 0, CHUNK)) throw new ServiceError("Invalid native read bounds.", 400); return base64(await this.call("read", { handle, offset, count }), count); }
  async *entries(handle: Handle): AsyncIterable<DirectoryEntry> {
    let first = true;
    for (;;) { const result = object(await this.call("entries", { handle, first })); first = false; if (!Array.isArray(result.entries) || typeof result.done !== "boolean" || result.entries.length > 1000) throw new ServiceError("Native directory page is malformed.", 409); for (const entry of result.entries) yield entry as DirectoryEntry; if (result.done) break; }
  }
  async close(handle: Handle): Promise<void> { if (await this.call("close", { handle }, false, true) !== true) throw new ServiceError("Native handle release is unconfirmed.", 409); }
  create(parent: Handle, name: string): Promise<Handle> { return this.handle("create", { parent, name }); }
  journal(parent: Handle, name: string): Promise<Handle> { return this.handle("journal", { parent, name }); }
  async write(handle: Handle, offset: number, data: Buffer): Promise<number> { return await this.call("write", { handle, offset, data: data.toString("base64") }, true) as number; }
  async flush(handle: Handle): Promise<void> { if (await this.call("flush", { handle }, true) !== true) throw new ServiceError("Native file flush is unconfirmed.", 409); }
  async discard(handle: Handle): Promise<void> { if (await this.call("discard", { handle }, true, true) !== true) throw new ServiceError("Owned stage disposition is unconfirmed.", 409); }
  async publish(handle: Handle, name: string): Promise<boolean> { return await this.call("publish", { handle, name }, true) === true; }
  async exists(parent: Handle, name: string): Promise<boolean> {
    component(name); const result = await this.call("exists", { parent, name }, true);
    if (typeof result !== "boolean") throw new ServiceError("Native occupancy acknowledgement differs.", 409, { outcome: "unknown", retryable: false });
    return result;
  }
  async publishOwned(handle: Handle, parent: Handle, name: string, replace = false): Promise<"published" | "exists"> {
    component(name); if (typeof replace !== "boolean") throw new ServiceError("Invalid native replacement policy.", 400);
    const result = await this.call("publishOwned", { handle, parent, name, replace }, true);
    if (result !== "published" && result !== "exists") throw new ServiceError("Native owned publication acknowledgement differs.", 409, { outcome: "unknown", retryable: false });
    return result;
  }
}
export class NativeKeys implements WindowsKeyAPI {
  constructor(readonly transport: WorkerTransport) {}
  async layout(): Promise<Layout> { return await this.transport.request("keys.layout", {}) as Layout; }
  async scan(vk: number, layout: string): Promise<number> { return await this.transport.request("keys.scan", { vk, layout }) as number; }
  async map(character: string, layout: string): Promise<number> { return await this.transport.request("keys.map", { character, layout }) as number; }
  async translate(vk: number, scan: number, modifiers: number, layout: string): Promise<string> { return await this.transport.request("keys.translate", { vk, scan, modifiers, layout }) as string; }
}
export class NativeUIA implements WindowsUIAAPI<string> {
  constructor(readonly transport: WorkerTransport) {}
  async root(): Promise<string | null> { return await this.transport.request("uia.root", {}) as string | null; }
  async firstChild(element: string): Promise<string | null> { return await this.transport.request("uia.first", { element }) as string | null; }
  async nextSibling(element: string): Promise<string | null> { return await this.transport.request("uia.next", { element }) as string | null; }
  async describe(element: string): Promise<UIADetails> { return await this.transport.request("uia.describe", { element }) as UIADetails; }
  async same(a: string, b: string): Promise<boolean> { return await this.transport.request("uia.same", { a, b }) === true; }
  async invoke(element: string): Promise<void> { if (await this.transport.request("uia.invoke", { element }, { effect: true }) !== true) throw new ServiceError("Native invocation is unconfirmed.", 409, { outcome: "unknown" }); }
  async clear(): Promise<void> { await this.transport.request("uia.clear", {}); }
}
export class NativeDesktop {
  constructor(readonly transport: WorkerTransport) {}
  async capture(): Promise<{ bounds: Bounds; png: Buffer }> { const result = object(await this.transport.request("desktop.capture", {})); return { bounds: result.bounds as Bounds, png: base64(result.png, 4194303) }; }
  async geometry(): Promise<Bounds> { return await this.transport.request("desktop.geometry", {}) as Bounds; }
  async post(events: InputEvent[], bounds: Bounds | null, cleanup: boolean): Promise<number> { return await this.transport.request("desktop.post", { events, bounds, cleanup }, { effect: true, cleanup }) as number; }
  async close(): Promise<boolean> { return await this.transport.request("desktop.close", {}, { cleanup: true }) === true; }
}
