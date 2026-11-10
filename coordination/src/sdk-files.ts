/** Local download publication adapters. No process or file opens at module load.
 * Directory/stage handles remain scoped to one transfer; publication is never retried.
 */
import { constants } from 'node:fs';
import { open, lstat, link, rename, unlink, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, isAbsolute, win32 } from 'node:path';
import type { ContainerDirectory, ContainerFiles } from './providers/mobile.ts';
import { WindowsRoot, component, directoryStamp, safeIdentity } from './guest/windows/files.ts';
import type { FileIdentity, Handle, WindowsFileAPI } from './guest/windows/files.ts';
import { isDeepStrictEqual } from 'node:util';

export type PublishResult = 'published' | 'exists';
export interface DownloadStage {
  /** Partial writes are allowed; the caller advances the exact returned count. */
  write(data: Uint8Array): Promise<number>;
  sync(): Promise<void>;
  /** Flushes/closes the writer; the adapter may retain the owned inode until cleanup. */
  close(): Promise<void>;
}
export interface DownloadDirectory {
  /** Exact no-follow existence, including dangling symlinks; no bounded directory listing. */
  exists(name: string): Promise<boolean>;
  createExclusive(name: string): Promise<DownloadStage>;
  /** 'exists' confirms no publication. Every thrown/lost publication reply is uncertain. */
  publishOwned(from: string, to: string, replace: boolean): Promise<PublishResult>;
  /** Removes only this directory's exclusively created stage, never a foreign entry or target. */
  removeOwned(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface DownloadFiles { openDirectory(path: string): Promise<DownloadDirectory> }
export class FilePublicationError extends Error {
  constructor(readonly reason: 'unavailable' | 'ownership' | 'temporary_unknown' | 'publication_unknown' | 'cleanup', message: string) {
    super(message); this.name = 'FilePublicationError';
  }
}
function filename(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new FilePublicationError('ownership', 'Use one relative filename component.');
}
interface PublicationContainer extends ContainerDirectory {
  exists(name: string): Promise<boolean>;
  publishOwned(from: string, to: string, replace: boolean): Promise<PublishResult>;
}
/** Production POSIX path: the helper uses openat/linkat/renameat on retained descriptors.
 * An initial realpath permits ordinary user-selected directory aliases (e.g. /tmp on Darwin);
 * after openRoot no pathname-based traversal, publication or cleanup is performed.
 */
export function containerDownloadFiles(files: ContainerFiles): DownloadFiles {
  return { async openDirectory(path) {
    const root = await files.openRoot(await realpath(path));
    if (typeof (root as Partial<PublicationContainer>).exists !== 'function' || typeof (root as Partial<PublicationContainer>).publishOwned !== 'function') {
      await root.close(); throw new FilePublicationError('unavailable', 'The scoped filesystem helper lacks publication operations.');
    }
    const bound = root as PublicationContainer;
    return { exists: name => bound.exists(name), createExclusive: name => bound.createExclusive(name),
      publishOwned: (from, to, replace) => bound.publishOwned(from, to, replace),
      removeOwned: name => bound.removeOwned(name), sync: () => bound.sync(), close: () => bound.close() };
  } };
}
interface NodeStage { file: FileHandle; name: string; published: boolean; writerClosed: boolean }
function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean { return a.dev === b.dev && a.ino === b.ino; }
/** Linux-only standard-library adapter. All child operations resolve via the retained
 * descriptor namespace, so renaming/replacing the originally selected path cannot redirect them.
 */
export function linuxDownloadFiles(): DownloadFiles {
  return { async openDirectory(path) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY), stages = new Map<string, NodeStage>();
    const parent = `/proc/self/fd/${directory.fd}`; let closed = false;
    try { if (!sameFile(await directory.stat(), await lstat(parent + '/.'))) throw new Error('binding'); }
    catch (error) { await directory.close(); throw error; }
    const check = () => { if (closed) throw new FilePublicationError('ownership', 'Download directory is closed.'); };
    const owned = async (name: string): Promise<NodeStage> => {
      check(); filename(name); const stage = stages.get(name); if (!stage) throw new FilePublicationError('ownership', 'Unknown owned stage.');
      if (!stage.published) {
        const actual = await lstat(join(parent, name)), retained = await stage.file.stat();
        if (!actual.isFile() || !retained.isFile() || !sameFile(actual, retained)) throw new FilePublicationError('ownership', 'The staged directory entry changed identity.');
      }
      return stage;
    };
    return {
      async exists(name) { check(); filename(name); try { await lstat(join(parent, name)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } },
      async createExclusive(name) {
        check(); filename(name); if (stages.has(name)) throw new FilePublicationError('ownership', 'Stage already belongs to this transfer.');
        const file = await open(join(parent, name), 'wx', 0o600), stage = { file, name, published: false, writerClosed: false }; stages.set(name, stage);
        return {
          async write(data) { if (stage.writerClosed) throw new FilePublicationError('ownership', 'The stage writer is closed.'); await owned(name); return (await file.write(data.subarray(0, 65536))).bytesWritten; },
          async sync() { await owned(name); await file.sync(); },
          async close() { stage.writerClosed = true; },
        };
      },
      async publishOwned(from, to, replace) {
        filename(to); const stage = await owned(from); if (stage.published || from === to || !stage.writerClosed) throw new FilePublicationError('ownership', 'The stage cannot be published in this phase.');
        try { if (replace) { await rename(join(parent, from), join(parent, to)); stage.published = true; } else await link(join(parent, from), join(parent, to)); }
        catch (error) { if (!replace && (error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'; throw error; }
        const destination = await lstat(join(parent, to));
        if (!destination.isFile() || !sameFile(destination, await stage.file.stat())) throw new FilePublicationError('publication_unknown', 'Published identity was not confirmed.');
        return 'published';
      },
      async removeOwned(name) {
        const stage = await owned(name);
        if (!stage.published) await unlink(join(parent, name));
        await stage.file.close(); stages.delete(name);
      },
      async sync() { check(); await directory.sync(); },
      async close() {
        if (closed) return; closed = true; let failure: unknown;
        for (const stage of stages.values()) try { await stage.file.close(); } catch (error) { failure ??= error; }
        try { await directory.close(); } catch (error) { failure ??= error; }
        if (failure) throw failure;
      },
    };
  } };
}

export interface WindowsPublicationAPI extends WindowsFileAPI {
  exists?(parent: Handle, name: string): Promise<boolean> | boolean;
  publishOwned?(handle: Handle, parent: Handle, name: string, replace?: boolean): Promise<PublishResult> | PublishResult;
}
export interface WindowsPublicationBridge { api: WindowsPublicationAPI; close(): Promise<boolean> }
interface WindowsLocalStage { handle: Handle; info: FileIdentity; offset: number; writerClosed: boolean; publication: 'staged' | 'attempted' | 'published' }
/** Injectable Win32 bridge. Exclusive stage handles deny foreign access; root and
 * ancestor volume/file IDs are revalidated around work. Rename uses RootDirectory,
 * never a concatenated destination or an overwrite fallback after a collision.
 */
export function windowsDownloadFiles(connect: () => Promise<WindowsPublicationBridge>): DownloadFiles {
  return { async openDirectory(path) {
    const resolved = win32.resolve(path), parsed = win32.parse(resolved);
    if (!/^[A-Za-z]:\\$/.test(parsed.root)) throw new FilePublicationError('ownership', 'Select a local Windows drive directory.');
    const prefix = resolved.slice(parsed.root.length).split('\\').filter(Boolean); prefix.forEach(component);
    const bridge = await connect(), api = bridge.api;
    if (!api.create || !api.write || !api.flush || !api.discard || !api.exists || !api.publishOwned) {
      await bridge.close(); throw new FilePublicationError('unavailable', 'The Windows bridge lacks owned publication operations.');
    }
    const root = new WindowsRoot(parsed.root.slice(0, 2), prefix, api), stages = new Map<string, WindowsLocalStage>();
    try { await root.start(); } catch (error) { await bridge.close(); throw error; }
    let closed = false;
    const parents: Array<[Handle, unknown]> = [];
    try { for (const h of root.handles) parents.push([h, directoryStamp(await api.info(h))]); }
    catch (error) { await root.close(); await bridge.close(); throw error; }
    const guard = async () => {
      if (closed) throw new FilePublicationError('ownership', 'The Windows publication directory is closed.');
      for (const [h, stamp] of parents) if (!isDeepStrictEqual(stamp, directoryStamp(await api.info(h)))) throw new FilePublicationError('ownership', 'The bound directory changed identity.');
    };
    const regular = (actual: FileIdentity, prior?: FileIdentity, size?: number) => {
      safeIdentity(actual);
      if (actual.directory || actual.volume !== root.identity.volume || actual.links !== 1 ||
          (prior && (actual.fileId !== prior.fileId || actual.volume !== prior.volume)) || (size !== undefined && actual.size !== size)) throw new FilePublicationError('ownership', 'The private stage changed identity or length.');
    };
    const owned = async (name: string) => {
      component(name); await guard(); const stage = stages.get(name); if (!stage) throw new FilePublicationError('ownership', 'Unknown private Windows stage.');
      const actual = await api.info(stage.handle); regular(actual, stage.info, stage.offset);
      if (!isDeepStrictEqual(actual, stage.info)) throw new FilePublicationError('ownership', 'Stage metadata changed outside an owned operation.');
      return stage;
    };
    return {
      async exists(name) { component(name); await guard(); const result = await api.exists!(root.handle, name); if (typeof result !== 'boolean') throw new Error('Invalid existence reply'); await guard(); return result; },
      async createExclusive(name) {
        component(name); await guard(); if (stages.has(name)) throw new FilePublicationError('ownership', 'Duplicate stage.');
        const handle = await api.create!(root.handle, name);
        const stage: WindowsLocalStage = { handle, info: {} as FileIdentity, offset: 0, writerClosed: false, publication: 'staged' };
        stages.set(name, stage); // Retain every acquired handle even if validation fails.
        try { stage.info = await api.info(handle); regular(stage.info, undefined, 0); await guard(); }
        catch (error) { throw new FilePublicationError('temporary_unknown', 'Private stage setup needs inspection.'); }
        return {
          async write(data) {
            if (stage.writerClosed || stage.publication !== 'staged') throw new FilePublicationError('ownership', 'The stage writer is closed.');
            await owned(name); const count = await api.write!(handle, stage.offset, Buffer.from(data.subarray(0, 65536)));
            if (!Number.isSafeInteger(count) || count < 1 || count > Math.min(data.length, 65536)) throw new Error('Invalid stage write count');
            stage.offset += count; const next = await api.info(handle); regular(next, stage.info, stage.offset); stage.info = next; await guard(); return count;
          },
          async sync() { await owned(name); await api.flush!(handle); const next = await api.info(handle); regular(next, stage.info, stage.offset); stage.info = next; await guard(); },
          async close() { stage.writerClosed = true; },
        };
      },
      async publishOwned(from, to, replace) {
        component(to); const stage = await owned(from);
        if (from.toLowerCase() === to.toLowerCase() || !stage.writerClosed || stage.publication !== 'staged') throw new FilePublicationError('ownership', 'The stage cannot publish in this phase.');
        stage.publication = 'attempted';
        const result = await api.publishOwned!(stage.handle, root.handle, to, replace);
        if (result === 'exists') { stage.publication = 'staged'; return result; }
        if (result !== 'published') throw new FilePublicationError('publication_unknown', 'The native rename reply is unconfirmed.');
        stage.publication = 'published'; const actual = await api.info(stage.handle); regular(actual, stage.info, stage.offset); stage.info = actual; await guard(); return result;
      },
      async removeOwned(name) {
        const stage = stages.get(name); if (!stage) return;
        if (stage.publication === 'attempted') throw new FilePublicationError('publication_unknown', 'Do not discard a potentially published file.');
        await owned(name); if (stage.publication === 'staged') await api.discard!(stage.handle);
        await api.close(stage.handle); stages.delete(name);
      },
      async sync() { await guard(); /* Windows has no portable directory fsync; the private file was flushed. */ },
      async close() {
        if (closed) return; let failure: unknown;
        for (const stage of stages.values()) try { await api.close(stage.handle); } catch (error) { failure ??= error; }
        closed = true; const released = await root.close(), stopped = await bridge.close();
        if (failure || !released || !stopped) throw new FilePublicationError('cleanup', 'Windows file handle release is unconfirmed.');
      },
    };
  } };
}
/** Platform bridge selection is lazy and injectable. Darwin uses the installed scoped
 * Rust helper; Windows uses the shipped supervised Win32 bridge; Linux uses Node fs.
 */
export function scopedDownloadFiles(options: { helperPath?: string } = {}): DownloadFiles {
  if (options.helperPath !== undefined && !isAbsolute(options.helperPath)) throw new FilePublicationError('unavailable', 'Use an absolute filesystem-helper path.');
  if (process.platform === 'linux') return linuxDownloadFiles();
  if (process.platform === 'win32') return windowsDownloadFiles(async () => {
    const { nativeTransport, Win32Files } = await import('./guest/windows/native.ts');
    const worker = nativeTransport(() => true, () => true, 30_000);
    return { api: new Win32Files(worker), close: () => worker.close() };
  });
  return { async openDirectory(path) {
    const { nativeContainerFiles, mobileNativeHelper } = await import('./providers/mobile-native.ts');
    const helper = mobileNativeHelper(options.helperPath === undefined ? {} : { mobileNativeHelper: options.helperPath });
    return containerDownloadFiles(nativeContainerFiles(helper)).openDirectory(path);
  } };
}
