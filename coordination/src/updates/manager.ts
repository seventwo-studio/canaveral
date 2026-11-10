import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StateLock } from '../runtime-process.ts';
import { parseTarget, verifyRelease } from './protocol.ts';
import type { ReleaseFile, SignedRelease, Target, TrustedKeys } from './protocol.ts';

export const LAUNCHER_VERSION = 1;
export const ARTIFACT_CHUNK_BYTES = 524288;
export type UpdatePhase = 'draining' | 'downloading' | 'staged' | 'activating' | 'verifying' | 'succeeded' | 'rolledBack' | 'failed' | 'unknown' | 'cancelled';
export interface RunnerUpdateBinding { controllerId: string; runnerId: string; generation: number; incarnationId: string }
export interface HostIdentity { id: string; credential: string; binding?: RunnerUpdateBinding }
export type ControllerRequest = (method: string, path: string, body: Record<string, unknown>, credential: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
/** Both observations must be positive; unavailable inspection is never idle. */
export interface IdleReceipt { idle: boolean; workloadsStopped: boolean }
/** Quiesce fences new local work and waits for in-flight host operations to finish. */
export interface QuiesceReceipt extends IdleReceipt { quiesced: boolean }
export interface ActivationRequest { jobId: string; attemptId: string; releaseId: string; installationId: string }
export interface ActivationReceipt extends ActivationRequest {
  state: 'succeeded' | 'rolledBack' | 'unknown'; installedReleaseId?: string;
}
export interface ActivationDriver {
  activate(request: ActivationRequest): Promise<ActivationReceipt>;
  recover(request: ActivationRequest): Promise<ActivationReceipt | undefined>;
}
export interface UpdateLifecycle {
  idle(): Promise<IdleReceipt>;
  quiesce(): Promise<QuiesceReceipt>;
  activation: ActivationDriver;
}
export interface UpdateStoreOptions {
  installationRoot: string; stateDirectory: string; trustedKeys: TrustedKeys; target: Target;
  /** Identity, disks and all mutable provider roots must be listed here. */
  protectedPaths: readonly string[];
  maxReleaseBytes?: number; minimumFreeBytes?: number;
}
export interface ManagedUpdaterOptions extends UpdateStoreOptions {
  targetKind?: 'host' | 'runner';
  request: ControllerRequest; identity(): HostIdentity | Promise<HostIdentity>; lifecycle: UpdateLifecycle;
}
export interface UpdateReport {
  jobId: string; attemptId: string; sequence: number; state: UpdatePhase; installedReleaseId?: string; detail?: string;
}
export interface UpdateJob {
  id: string; attemptId: string; installationId: string; hostId: string; credentialHash: string;
  release: SignedRelease; previousReleaseId?: string; targetKind?: 'host' | 'runner'; binding?: RunnerUpdateBinding; activationReported?: boolean; phase: 'queued' | UpdatePhase;
  sequence: number; pending?: UpdateReport; gate?: QuiesceReceipt;
  componentStatus: { host: 'pending' | 'ready'; guest: 'pendingGuestReceipt'; 'native-helper': 'pendingNativeReceipt' };
}
const TERMINAL = new Set(['succeeded', 'rolledBack', 'failed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function updateUUID(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) throw new Error('Invalid update UUID');
  return value;
}
export function updateObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update record');
  return value as Record<string, unknown>;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function contained(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
export function noUpdateLinks(path: string): void {
  const absolute = resolve(path), parent = dirname(absolute);
  if (parent !== absolute) noUpdateLinks(parent);
  try { if (lstatSync(absolute).isSymbolicLink()) throw new Error('Update paths may not contain symlinks'); } catch (error) { if (!missing(error)) throw error; }
}
function owned(info: Stats): void {
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error('Update storage must be private and owned by this user');
}
export function updateDirectory(path: string, create = true): void {
  noUpdateLinks(path);
  if (!existsSync(path) && create) mkdirSync(path, { mode: 0o700 });
  const info = lstatSync(path); if (!info.isDirectory()) throw new Error('Update root must be a directory'); owned(info);
}
function syncDirectory(path: string): void {
  // Windows does not expose directory fsync. Atomic rename remains required there.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function readUpdateJSON(path: string): unknown {
  noUpdateLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); owned(info);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('Invalid private update state file');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { closeSync(fd); }
}
export function atomicUpdateJSON(path: string, value: unknown): void {
  updateDirectory(dirname(path), false); noUpdateLinks(path);
  if (existsSync(path)) readUpdateJSON(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); syncDirectory(dirname(path));
}
function digestFile(path: string, expected: ReleaseFile, immutable: boolean): void {
  noUpdateLinks(path);
  const info = lstatSync(path); owned(info);
  if (!info.isFile() || info.nlink !== 1 || info.size !== expected.bytes || (immutable && process.platform !== 'win32' && (info.mode & 0o222) !== 0)) throw new Error('Release file is linked, writable, missing or has the wrong size');
  if (process.platform !== 'win32' && Boolean(info.mode & 0o100) !== expected.executable) throw new Error('Release executable mode does not match manifest');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let size = 0, count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) !== 0) { size += count; if (size > expected.bytes) throw new Error('Release file grew during verification'); hash.update(chunk.subarray(0, count)); }
    if (size !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('Release file digest mismatch');
  } finally { closeSync(fd); }
}

/** State and manifests live outside replaceable code; no identity or disk files are touched. */
export class UpdateStore {
  readonly installationRoot: string; readonly stateDirectory: string; readonly target: Target;
  readonly trustedKeys: TrustedKeys; readonly installationId: string; readonly maxReleaseBytes: number; readonly minimumFreeBytes: number;
  constructor(options: UpdateStoreOptions) {
    this.installationRoot = resolve(options.installationRoot); this.stateDirectory = resolve(options.stateDirectory);
    if (!isAbsolute(options.installationRoot) || !isAbsolute(options.stateDirectory) || contained(this.installationRoot, this.stateDirectory) || contained(this.stateDirectory, this.installationRoot)) throw new Error('Installation and update state must be separate absolute roots');
    for (const path of options.protectedPaths) {
      if (!isAbsolute(path) || contained(this.installationRoot, resolve(path)) || contained(resolve(path), this.installationRoot) || contained(this.stateDirectory, resolve(path)) || contained(resolve(path), this.stateDirectory)) throw new Error('Credentials and workload storage must be separate from update roots');
      noUpdateLinks(path);
    }
    this.target = parseTarget(options.target); this.trustedKeys = Object.freeze({ ...options.trustedKeys });
    this.maxReleaseBytes = options.maxReleaseBytes ?? 4 * 1024 ** 3; this.minimumFreeBytes = options.minimumFreeBytes ?? 128 * 1024 ** 2;
    if (!Number.isSafeInteger(this.maxReleaseBytes) || this.maxReleaseBytes < 1 || !Number.isSafeInteger(this.minimumFreeBytes) || this.minimumFreeBytes < 0) throw new Error('Invalid release space bounds');
    updateDirectory(this.installationRoot); updateDirectory(this.stateDirectory);
    for (const path of [this.releases, this.staging, join(this.stateDirectory, 'manifests'), join(this.stateDirectory, 'jobs')]) updateDirectory(path);
    const allowed = new Set(['releases', 'staging']);
    if (readdirSync(this.installationRoot).some(name => !allowed.has(name))) throw new Error('Unexpected entries in installation root');
    for (const root of [this.releases, this.staging]) for (const name of readdirSync(root)) { updateUUID(name); updateDirectory(join(root, name), false); }
    // The SQLite lock releases on process loss and serializes first initialization.
    const lock = new StateLock(join(this.stateDirectory, 'initialize.sqlite'));
    try {
      const path = join(this.stateDirectory, 'installation.json');
      if (!existsSync(path)) {
        if (readdirSync(this.releases).length || existsSync(join(this.stateDirectory, 'active.json')) || existsSync(join(this.stateDirectory, 'highwater.json'))) throw new Error('Installation identity is missing from existing update state');
        atomicUpdateJSON(path, { installationId: randomUUID(), installationRoot: this.installationRoot, target: this.target });
      }
      const saved = updateObject(readUpdateJSON(path));
      if (saved.installationRoot !== this.installationRoot || JSON.stringify(saved.target) !== JSON.stringify(this.target)) throw new Error('Installation identity binding mismatch');
      this.installationId = updateUUID(saved.installationId);
    } finally { lock.close(); }
  }
  get releases(): string { return join(this.installationRoot, 'releases'); }
  get staging(): string { return join(this.installationRoot, 'staging'); }
  releasePath(id: string): string { return join(this.releases, updateUUID(id)); }
  validate(value: unknown): SignedRelease {
    const release = verifyRelease(value, this.trustedKeys, this.target);
    if (release.manifest.minimumLauncherVersion > LAUNCHER_VERSION) throw new Error('Release needs a newer stable launcher');
    let size = 0; for (const file of release.manifest.files) { size += file.bytes; if (!Number.isSafeInteger(size) || size > this.maxReleaseBytes) throw new Error('Release exceeds installation space bound'); }
    return release;
  }
  active(): string | undefined {
    const path = join(this.stateDirectory, 'active.json'); if (!existsSync(path)) return undefined;
    const value = updateObject(readUpdateJSON(path)); if (value.installationId !== this.installationId) throw new Error('Active pointer installation mismatch');
    return updateUUID(value.releaseId);
  }
  setActive(id: string): void { this.verifyInstalled(id); atomicUpdateJSON(join(this.stateDirectory, 'active.json'), { installationId: this.installationId, releaseId: id }); }
  highwater(): { sequence: number; releaseId?: string } {
    const path = join(this.stateDirectory, 'highwater.json'); if (!existsSync(path)) {
      if (this.active() || readdirSync(this.releases).length) throw new Error('Anti-downgrade state is missing');
      return { sequence: 0 };
    }
    const value = updateObject(readUpdateJSON(path));
    if (value.installationId !== this.installationId || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1) throw new Error('Invalid anti-downgrade state');
    return { sequence: Number(value.sequence), releaseId: updateUUID(value.releaseId) };
  }
  advance(release: SignedRelease): void {
    const m = this.validate(release).manifest, floor = this.highwater();
    if (m.sequence < floor.sequence || (m.sequence === floor.sequence && m.releaseId !== floor.releaseId)) throw new Error('Release sequence would downgrade installation');
    atomicUpdateJSON(join(this.stateDirectory, 'highwater.json'), { installationId: this.installationId, sequence: m.sequence, releaseId: m.releaseId });
  }
  verifyDirectory(folder: string, release: SignedRelease, immutable: boolean): void {
    const expected = new Map(release.manifest.files.map(file => [file.path, file])); const dirs = new Set(['']);
    for (const file of expected.values()) { let parent = dirname(file.path); while (parent !== '.') { dirs.add(parent); parent = dirname(parent); } }
    let seen = 0;
    const walk = (prefix: string): void => {
      const path = prefix ? join(folder, prefix) : folder; updateDirectory(path, false);
      const info = lstatSync(path); if (immutable && process.platform !== 'win32' && (info.mode & 0o222)) throw new Error('Published release directory is writable');
      for (const name of readdirSync(path)) {
        const rel = prefix ? `${prefix}/${name}` : name, file = expected.get(rel);
        if (file) { digestFile(join(folder, rel), file, immutable); seen++; }
        else if (dirs.has(rel)) walk(rel);
        else throw new Error('Unexpected entry in release directory');
      }
    };
    walk(''); if (seen !== expected.size) throw new Error('Release files are missing');
  }
  verifyInstalled(id: string): SignedRelease {
    const release = this.validate(readUpdateJSON(join(this.stateDirectory, 'manifests', `${updateUUID(id)}.json`)));
    if (release.manifest.releaseId !== id) throw new Error('Manifest release identity mismatch');
    this.verifyDirectory(this.releasePath(id), release, true); return release;
  }
  ensureSpace(bytes: number): void {
    const stats = statfsSync(this.installationRoot, { bigint: true });
    if (stats.bavail * stats.bsize < BigInt(bytes) + BigInt(this.minimumFreeBytes)) throw new Error('Insufficient private installation space');
  }
  /** Fresh directory only. A partial prior attempt is retained for inspection, never resumed as new code. */
  async stage(releaseValue: SignedRelease, attemptId: string, read: (file: ReleaseFile, offset: number, length: number) => Promise<Buffer>): Promise<void> {
    const release = this.validate(releaseValue), id = release.manifest.releaseId;
    updateDirectory(this.releases, false); updateDirectory(this.staging, false);
    if (existsSync(this.releasePath(id))) throw new Error('Release directory already exists; refusing replacement');
    const folder = join(this.staging, updateUUID(attemptId)); noUpdateLinks(folder); mkdirSync(folder, { mode: 0o700 }); syncDirectory(this.staging);
    const total = release.manifest.files.reduce((n, f) => n + f.bytes, 0); this.ensureSpace(total);
    for (const file of release.manifest.files) {
      const path = join(folder, file.path); let parent = dirname(path); const parents: string[] = [];
      while (parent !== folder) { parents.unshift(parent); parent = dirname(parent); }
      for (const path of parents) updateDirectory(path);
      noUpdateLinks(path);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const hash = createHash('sha256'); let offset = 0;
        while (offset < file.bytes) {
          const length = Math.min(ARTIFACT_CHUNK_BYTES, file.bytes - offset); this.ensureSpace(length);
          const chunk = await read(file, offset, length);
          if (!Buffer.isBuffer(chunk) || chunk.length !== length) throw new Error('Artifact chunk size mismatch');
          writeFileSync(fd, chunk); hash.update(chunk); offset += chunk.length;
        }
        if (hash.digest('hex') !== file.sha256) throw new Error('Artifact digest mismatch');
        fchmodSync(fd, file.executable ? 0o500 : 0o400); fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    this.verifyDirectory(folder, release, false);
    const seal = (path: string): void => { for (const name of readdirSync(path)) { const entry = join(path, name); if (lstatSync(entry).isDirectory()) seal(entry); } const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fchmodSync(fd, 0o500); if (process.platform !== 'win32') fsyncSync(fd); } finally { closeSync(fd); } };
    // Darwin requires the moved directory itself to be writable for rename. Seal
    // descendants first; the root stays private and unreachable from active.json.
    for (const name of readdirSync(folder)) { const child = join(folder, name); if (lstatSync(child).isDirectory()) seal(child); }
    this.verifyDirectory(folder, release, false);
    atomicUpdateJSON(join(this.stateDirectory, 'manifests', `${id}.json`), release);
    // Reserve the sequence before publishing code. Even failed activation cannot lower it.
    this.advance(release); renameSync(folder, this.releasePath(id));
    // A crash here leaves an unsealed candidate, never an active release. Recovery
    // retains the same job/attempt and cannot activate it without full verification.
    seal(this.releasePath(id)); this.verifyInstalled(id); syncDirectory(this.releases); syncDirectory(this.staging);
  }
  /** Operator bootstrap imports only signed files from a local, private, link-free bundle. */
  async installInitial(releaseValue: SignedRelease, sourceDirectory: string): Promise<void> {
    const lock = new StateLock(join(this.stateDirectory, 'manager.sqlite'));
    try {
      if (this.active() || this.highwater().sequence !== 0 || readdirSync(this.releases).length) throw new Error('Initial release already provisioned');
      const release = this.validate(releaseValue); noUpdateLinks(sourceDirectory); const source = realpathSync(sourceDirectory);
      this.verifyDirectory(source, release, false);
      await this.stage(release, release.manifest.releaseId, async (file, offset, length) => {
        noUpdateLinks(join(source, file.path)); const fd = openSync(join(source, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const bytes = Buffer.alloc(length); if (readSync(fd, bytes, 0, length, offset) !== length) throw new Error('Initial bundle changed'); return bytes; } finally { closeSync(fd); }
      });
      this.setActive(release.manifest.releaseId);
    } finally { lock.close(); }
  }
  job(): UpdateJob | undefined {
    const current = join(this.stateDirectory, 'current-job.json'); if (!existsSync(current)) return undefined;
    const key = updateObject(readUpdateJSON(current)), id = updateUUID(key.id), attempt = updateUUID(key.attemptId);
    const value = updateObject(readUpdateJSON(join(this.stateDirectory, 'jobs', `${id}-${attempt}.json`)));
    if (value.id !== id || value.attemptId !== attempt || value.installationId !== this.installationId || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw new Error('Invalid saved update job');
    updateUUID(value.hostId); if (typeof value.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.credentialHash)) throw new Error('Invalid saved credential binding');
    if (!['queued', 'draining', 'downloading', 'staged', 'activating', 'verifying', 'succeeded', 'rolledBack', 'failed', 'unknown', 'cancelled'].includes(String(value.phase))) throw new Error('Invalid saved update phase');
    if (value.previousReleaseId !== undefined) updateUUID(value.previousReleaseId);
    return { ...value, release: this.validate(value.release) } as unknown as UpdateJob;
  }
  saveJob(job: UpdateJob): void {
    if (job.installationId !== this.installationId) throw new Error('Job installation mismatch');
    atomicUpdateJSON(join(this.stateDirectory, 'jobs', `${updateUUID(job.id)}-${updateUUID(job.attemptId)}.json`), job);
    atomicUpdateJSON(join(this.stateDirectory, 'current-job.json'), { id: job.id, attemptId: job.attemptId });
  }
}
function credentialHash(value: string): string { return createHash('sha256').update('canaveral-managed-update\0').update(value).digest('hex'); }
function positive(value: IdleReceipt): boolean { return value?.idle === true && value.workloadsStopped === true; }

/** One saved job/attempt; transport errors replay the exact durable report before further effects. */
export class ManagedUpdater {
  readonly store: UpdateStore;
  private readonly lock: StateLock; private readonly abort = new AbortController();
  private busy = false; private closed = false;
  constructor(readonly options: ManagedUpdaterOptions) { this.store = new UpdateStore(options); this.lock = new StateLock(join(this.store.stateDirectory, 'manager.sqlite')); }
  private async identity(job?: UpdateJob): Promise<HostIdentity> {
    const identity = await this.options.identity(); updateUUID(identity.id);
    if (typeof identity.credential !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(identity.credential)) throw new Error('Invalid host update credential');
    if (this.options.targetKind === 'runner') {
      const b = identity.binding;
      if (!b || updateUUID(b.runnerId) !== identity.id || !Number.isSafeInteger(b.generation) || b.generation < 1) throw new Error('Current registered runner binding is required');
      updateUUID(b.controllerId); updateUUID(b.incarnationId);
    } else if (identity.binding) throw new Error('Runner binding cannot authorize host updates');
    if (job && JSON.stringify(job.binding) !== JSON.stringify(identity.binding)) throw new Error('Update runner binding changed');
    if (job && (job.hostId !== identity.id || job.credentialHash !== credentialHash(identity.credential))) throw new Error('Update is bound to a different host credential; retain job and drain');
    return identity;
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.busy) throw new Error('Updater is closed or already processing'); this.busy = true;
    try { return await work(); } finally { this.busy = false; if (this.closed) this.lock.close(); }
  }
  private async flush(job: UpdateJob): Promise<void> {
    if (!job.pending) return;
    const identity = await this.identity(job);
    const response = await this.options.request('POST', `/v1/${this.options.targetKind === 'runner' ? 'runners' : 'hosts'}/${identity.id}/updates/report`, { ...job.pending, ...(identity.binding ? { binding: identity.binding } : {}) }, identity.credential, this.abort.signal);
    if (response.accepted !== true) throw new Error('Controller did not acknowledge saved update report');
    delete job.pending; this.store.saveJob(job);
  }
  private async report(job: UpdateJob, state: UpdatePhase, installedReleaseId?: string, detail?: string): Promise<void> {
    if (job.pending) await this.flush(job);
    job.phase = state; job.sequence++;
    job.pending = { jobId: job.id, attemptId: job.attemptId, sequence: job.sequence, state, ...(installedReleaseId ? { installedReleaseId } : {}), ...(detail ? { detail: detail.slice(0, 2000) } : {}) };
    this.store.saveJob(job); await this.flush(job);
  }
  async poll(): Promise<UpdateJob | undefined> {
    return this.exclusive(async () => {
      const existing = this.store.job(); if (existing?.pending) await this.flush(existing);
      // An unknown operation is never replaced or repolled into a fresh attempt.
      if (existing && !TERMINAL.has(existing.phase)) return existing;
      const identity = await this.identity(), currentReleaseId = this.store.active(); if (currentReleaseId) this.store.verifyInstalled(currentReleaseId);
      const reply = await this.options.request('POST', `/v1/${this.options.targetKind === 'runner' ? 'runners' : 'hosts'}/${identity.id}/updates/poll`, { ...(identity.binding ? { binding: identity.binding } : {}), installationId: this.store.installationId, target: this.store.target, launcherVersion: LAUNCHER_VERSION, ...(currentReleaseId ? { currentReleaseId } : {}) }, identity.credential, this.abort.signal);
      if (reply.job === null) return undefined;
      const value = updateObject(reply.job), id = updateUUID(value.id), attemptId = updateUUID(value.attemptId);
      if (existing?.id === id) { if (existing.attemptId !== attemptId) throw new Error('Controller changed update attempt'); return existing; }
      const release = this.store.validate(value.release), floor = this.store.highwater();
      if (release.manifest.sequence <= floor.sequence) throw new Error('Release sequence must exceed installation high-water mark');
      const job: UpdateJob = { id, attemptId, installationId: this.store.installationId, hostId: identity.id, credentialHash: credentialHash(identity.credential), release, targetKind: this.options.targetKind ?? 'host', ...(identity.binding ? { binding: { ...identity.binding } } : {}), ...(currentReleaseId ? { previousReleaseId: currentReleaseId } : {}), phase: 'queued', sequence: 0, componentStatus: { host: 'pending', guest: 'pendingGuestReceipt', 'native-helper': 'pendingNativeReceipt' } };
      this.store.saveJob(job); return job;
    });
  }
  async step(): Promise<UpdateJob | undefined> {
    return this.exclusive(async () => {
      const job = this.store.job(); if (!job) return undefined; await this.identity(job); await this.flush(job);
      if (TERMINAL.has(job.phase)) return job;
      if (job.phase === 'unknown') {
        if (job.activationReported) {
          const receipt = await this.options.lifecycle.activation.recover(this.activation(job));
          if (receipt && receipt.state !== 'unknown') await this.complete(job, receipt);
        }
        return job;
      }
      if (job.phase === 'queued') { await this.report(job, 'draining'); return job; }
      if (job.phase === 'draining') {
        if (!positive(await this.options.lifecycle.idle())) return job;
        await this.report(job, 'downloading');
        try {
          await this.store.stage(job.release, job.attemptId, async (file, offset, length) => {
            if (this.abort.signal.aborted) throw new Error('Updater closed');
            const identity = await this.identity(job);
            // Only a fixed relative controller path. Manifest values never supply origins or credentials.
            const reply = await this.options.request('GET', `/v1/updates/artifacts/${file.sha256}?jobId=${job.id}&offset=${offset}&length=${length}`, {}, identity.credential, this.abort.signal);
            if (reply.offset !== offset || reply.totalBytes !== file.bytes || typeof reply.data !== 'string' || reply.data.length !== 4 * Math.ceil(length / 3)) throw new Error('Invalid artifact chunk envelope');
            const data = Buffer.from(reply.data, 'base64'); if (data.length !== length || data.toString('base64') !== reply.data) throw new Error('Invalid artifact chunk encoding'); return data;
          });
        } catch {
          // No launcher effect was requested. Only a verified unchanged baseline permits undrain.
          if (job.previousReleaseId && this.store.active() === job.previousReleaseId) {
            try { this.store.verifyInstalled(job.previousReleaseId); } catch { await this.report(job, 'unknown', undefined, 'Baseline verification failed; retain drain.'); return job; }
            await this.report(job, 'failed', job.previousReleaseId, 'noActivation: true; staging failed; guest/native-helper remain inactive.');
          } else await this.report(job, 'unknown', undefined, 'Staging failed without a verified baseline; retain drain.');
          return job;
        }
        await this.report(job, 'staged'); return job;
      }
      if (job.phase === 'downloading') { await this.report(job, 'unknown', undefined, 'Interrupted staging; saved attempt retained, no new candidate.'); return job; }
      if (job.phase === 'staged') {
        if (job.gate) { await this.report(job, 'unknown', undefined, 'Interrupted quiesce intent; retain drain without repeating effects.'); return job; }
        this.store.verifyInstalled(job.release.manifest.releaseId);
        if (!positive(await this.options.lifecycle.idle())) return job;
        // Persist intent before quiesce, whose completion may itself be uncertain.
        job.gate = { idle: false, workloadsStopped: false, quiesced: false }; this.store.saveJob(job);
        let gate: QuiesceReceipt;
        try { gate = await this.options.lifecycle.quiesce(); } catch { await this.report(job, 'unknown', undefined, 'Quiesce was not confirmed; no process was terminated.'); return job; }
        if (!positive(gate) || gate.quiesced !== true) { await this.report(job, 'unknown', undefined, 'Positive idle and quiesce proof is unavailable; retain drain.'); return job; }
        job.gate = { idle: true, workloadsStopped: true, quiesced: true }; this.store.saveJob(job);
        job.activationReported = true;
        await this.report(job, 'activating');
        let receipt: ActivationReceipt;
        try { receipt = await this.options.lifecycle.activation.activate(this.activation(job)); }
        catch { await this.report(job, 'unknown', undefined, 'Launcher outcome is uncertain; do not create another attempt.'); return job; }
        await this.complete(job, receipt); return job;
      }
      if (job.phase === 'activating' || job.phase === 'verifying') {
        const receipt = await this.options.lifecycle.activation.recover(this.activation(job));
        if (!receipt) { await this.report(job, 'unknown', undefined, 'No positive launcher receipt; retain saved attempt and drain.'); return job; }
        await this.complete(job, receipt); return job;
      }
      return job;
    });
  }
  private activation(job: UpdateJob): ActivationRequest { return { jobId: job.id, attemptId: job.attemptId, releaseId: job.release.manifest.releaseId, installationId: job.installationId }; }
  private async complete(job: UpdateJob, receipt: ActivationReceipt): Promise<void> {
    const expected = this.activation(job);
    if (Object.entries(expected).some(([key, value]) => receipt[key as keyof ActivationRequest] !== value)) throw new Error('Launcher receipt identity mismatch');
    const installed = receipt.installedReleaseId;
    if (receipt.state === 'unknown' || !installed || (receipt.state === 'succeeded' ? installed !== expected.releaseId : installed !== job.previousReleaseId) || this.store.active() !== installed) { await this.report(job, 'unknown', undefined, 'Launcher did not confirm the exact candidate or baseline.'); return; }
    this.store.verifyInstalled(installed);
    if (job.phase !== 'verifying') await this.report(job, 'verifying');
    job.componentStatus.host = 'ready'; this.store.saveJob(job);
    await this.report(job, receipt.state, installed, 'Host readiness confirmed; guest and native-helper files remain inactive pending separate owned stopped-guest receipts.');
  }
  async close(): Promise<void> { this.closed = true; this.abort.abort(); if (!this.busy) this.lock.close(); }
}
