import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { StateLock } from '../runtime-process.ts';
import { UpdateStore, atomicUpdateJSON, readUpdateJSON, updateObject, updateUUID } from './manager.ts';
import type { ActivationDriver, ActivationReceipt, ActivationRequest, IdleReceipt, QuiesceReceipt, UpdateStoreOptions } from './manager.ts';

export interface StableLauncherOptions extends UpdateStoreOptions {
  hostConfigPath: string; hostStateDirectory: string;
  readinessTimeoutMs?: number; stopTimeoutMs?: number;
}
interface Launched {
  child: ChildProcess; native: boolean; releaseId: string; ready: Promise<void>; exited: Promise<void>; messages: EventEmitter;
  committed: boolean; send(value: object): Promise<void>;
}
interface LaunchTransaction extends ActivationRequest {
  previousReleaseId?: string; phase: 'stopping' | 'starting' | 'restoring' | 'committing' | 'finished' | 'unknown'; receipt?: ActivationReceipt;
}
export interface ReadyMessage { type: 'canaveral-update-ready'; version: 1; releaseId: string; installationId: string }
const MAX_HANDSHAKE_BYTES = 4096;
function matches(message: unknown, type: string, releaseId: string, installationId: string): boolean {
  try { const v = updateObject(message); return Object.keys(v).length === 4 && v.type === type && v.version === 1 && v.releaseId === releaseId && v.installationId === installationId; } catch { return false; }
}
function same(a: ActivationRequest, b: ActivationRequest): boolean { return a.jobId === b.jobId && a.attemptId === b.attemptId && a.releaseId === b.releaseId && a.installationId === b.installationId; }
function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error(message)), ms); promise.then(value => { clearTimeout(timer); accept(value); }, error => { clearTimeout(timer); reject(error); }); });
}

/** Stable parent owns only its child host/runner. It never signals or stops a VM. */
export class StableLauncher implements ActivationDriver {
  readonly store: UpdateStore;
  readonly nativeConfigFile: string | undefined;
  private readonly lock: StateLock; private current: Launched | undefined; private pending: Launched | undefined;
  private busy = false; private closed = false; private readonly events = new EventEmitter();
  readonly readinessTimeoutMs: number; readonly stopTimeoutMs: number;
  constructor(readonly options: StableLauncherOptions) {
    if (!isAbsolute(options.hostConfigPath) || !isAbsolute(options.hostStateDirectory)) throw new Error('Launcher config and host state paths must be absolute');
    const config = updateObject(readUpdateJSON(options.hostConfigPath));
    const nativeConfig = config.updates && updateObject(config.updates).nativeConfigFile;
    if (nativeConfig !== undefined && (typeof nativeConfig !== 'string' || !isAbsolute(nativeConfig))) throw new Error('Native config path must be absolute');
    this.nativeConfigFile = nativeConfig as string | undefined;
    if (this.nativeConfigFile) readUpdateJSON(this.nativeConfigFile);
    this.store = new UpdateStore({ ...options, protectedPaths: [...options.protectedPaths, options.hostConfigPath, options.hostStateDirectory, ...(this.nativeConfigFile ? [this.nativeConfigFile] : [])] });
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000; this.stopTimeoutMs = options.stopTimeoutMs ?? 20_000;
    for (const ms of [this.readinessTimeoutMs, this.stopTimeoutMs]) if (!Number.isSafeInteger(ms) || ms < 1 || ms > 300_000) throw new Error('Invalid launcher deadline');
    this.lock = new StateLock(join(this.store.stateDirectory, 'launcher.sqlite'));
  }
  private get journalPath(): string { return join(this.store.stateDirectory, 'launcher-transaction.json'); }
  private get runtimePath(): string { return join(this.store.stateDirectory, 'launcher-runtime.json'); }
  private transaction(): LaunchTransaction | undefined {
    if (!existsSync(this.journalPath)) return undefined;
    const saved = updateObject(readUpdateJSON(this.journalPath));
    for (const key of ['jobId', 'attemptId', 'releaseId', 'installationId']) updateUUID(saved[key]);
    if (saved.installationId !== this.store.installationId || !['stopping', 'starting', 'restoring', 'committing', 'finished', 'unknown'].includes(String(saved.phase))) throw new Error('Invalid launcher transaction');
    return saved as unknown as LaunchTransaction;
  }
  private save(tx: LaunchTransaction): void { atomicUpdateJSON(this.journalPath, tx); }
  private launch(releaseId: string): Launched {
    const release = this.store.verifyInstalled(releaseId), file = release.manifest.files.find(f => f.path === release.manifest.entrypoint)!;
    const entry = join(this.store.releasePath(releaseId), release.manifest.entrypoint), node = /\.(?:[cm]?js)$/.test(entry);
    if (!node && !this.nativeConfigFile) throw new Error('Native entrypoint needs updates.nativeConfigFile');
    if (!node && !file.executable) throw new Error('Native entrypoint must be signed executable code');
    const bootId = randomUUID();
    // Intent survives a parent crash even in the gap before spawn returns a PID.
    atomicUpdateJSON(this.runtimePath, { installationId: this.store.installationId, bootId, releaseId, state: 'starting' });
    const child = spawn(node ? process.execPath : entry, [...(node ? [entry] : ['--update-managed']), '--config', node ? this.options.hostConfigPath : this.nativeConfigFile!, '--state', this.options.hostStateDirectory], {
      cwd: this.store.releasePath(releaseId), shell: false,
      stdio: node ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CANAVERAL_UPDATE_INSTALLATION: this.store.installationId,
        CANAVERAL_UPDATE_RELEASE: releaseId, CANAVERAL_UPDATE_CANDIDATE: '1', CANAVERAL_UPDATE_ROOT: this.store.installationRoot,
        CANAVERAL_UPDATE_STATE: this.store.stateDirectory, ...(node ? {} : { CANAVERAL_UPDATE_READY_FD: '3', CANAVERAL_UPDATE_COMMIT_FD: '4' }) },
    });
    let observedExit = false;
    const exited = new Promise<void>(done => {
      const stopped = (): void => {
        if (observedExit) return; observedExit = true;
        try { const saved = updateObject(readUpdateJSON(this.runtimePath)); if (saved.bootId === bootId) atomicUpdateJSON(this.runtimePath, { ...saved, state: 'stopped' }); } catch { /* Preserve uncertain runtime state on storage failure. */ }
        done();
      };
      child.once('exit', stopped); child.once('error', () => { if (!child.pid) stopped(); });
    });
    const messages = new EventEmitter();
    const send = (value: object): Promise<void> => timeout(new Promise<void>((accept, reject) => {
      if (node) { if (!child.connected) { reject(new Error('Launcher IPC disconnected')); return; } child.send(value, error => error ? reject(error) : accept()); }
      else { const pipe = child.stdio[4] as Writable; pipe.write(JSON.stringify(value) + '\n', error => error ? reject(error) : accept()); }
    }), this.readinessTimeoutMs, 'Launcher command delivery deadline ended');
    if (node) child.on('message', value => messages.emit('message', value));
    else {
      const stream = child.stdio[3] as Readable; let buffer = Buffer.alloc(0);
      // Each native record is bounded independently; the channel remains available for status.
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.includes(10)) {
          const end = buffer.indexOf(10), line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          if (line.length > MAX_HANDSHAKE_BYTES) { messages.emit('invalid'); return; }
          try { const text = line.toString('utf8'); if (!Buffer.from(text).equals(line)) throw new Error(); messages.emit('message', JSON.parse(text) as unknown); } catch { messages.emit('invalid'); }
        }
        if (buffer.length > MAX_HANDSHAKE_BYTES) { buffer = Buffer.alloc(0); messages.emit('invalid'); }
      });
      stream.on('error', () => messages.emit('invalid')); (child.stdio[4] as Writable).on('error', () => messages.emit('invalid'));
    }
    let cleanup = (): void => {};
    const rawReady = new Promise<void>((accept, reject) => {
      let phase = 'preflight', finished = false;
      const finish = (error?: Error): void => { if (finished) return; finished = true; cleanup(); error ? reject(error) : accept(); };
      const invalid = (): void => finish(new Error('Invalid candidate readiness record'));
      const message = (value: unknown): void => {
        if (phase === 'preflight' && matches(value, 'canaveral-update-ready', releaseId, this.store.installationId)) {
          phase = 'starting'; void send({ type: 'canaveral-update-activate', version: 1, releaseId, installationId: this.store.installationId }).catch(error => finish(error as Error));
        } else if (phase === 'starting' && matches(value, 'canaveral-update-started', releaseId, this.store.installationId)) finish();
        else invalid();
      };
      const failed = (): void => finish(new Error('Candidate exited before readiness'));
      cleanup = () => { messages.removeListener('message', message); messages.removeListener('invalid', invalid); child.removeListener('exit', failed); child.removeListener('error', failed); };
      messages.on('message', message); messages.on('invalid', invalid); child.once('exit', failed); child.once('error', failed);
    });
    const ready = timeout(rawReady, this.readinessTimeoutMs, 'Candidate startup readiness deadline ended').finally(() => cleanup());
    void ready.catch(() => {});
    const launched: Launched = { child, native: !node, releaseId, ready, exited, messages, send, committed: false };
    // Retain ownership before the first post-spawn filesystem operation. If it
    // fails, callers still receive the owned child and must prove its exit.
    this.pending = launched;
    try { atomicUpdateJSON(this.runtimePath, { installationId: this.store.installationId, bootId, releaseId, state: 'running', pid: child.pid ?? null }); }
    catch (error) { cleanup(); launched.ready = Promise.reject(error); void launched.ready.catch(() => {}); }
    return launched;
  }
  private async commit(process: Launched): Promise<void> {
    if (!process.child.pid || process.child.exitCode !== null || process.child.signalCode !== null) throw new Error('Ready candidate exited');
    let cleanup = (): void => {};
    const acknowledged = new Promise<void>((accept, reject) => {
      const message = (value: unknown): void => {
        if (matches(value, 'canaveral-update-committed-ack', process.releaseId, this.store.installationId)) accept();
      };
      const exited = (): void => reject(new Error('Candidate exited before commit acknowledgement'));
      cleanup = () => { process.messages.removeListener('message', message); process.child.removeListener('exit', exited); };
      process.messages.on('message', message); process.child.once('exit', exited);
    });
    void acknowledged.catch(() => {});
    // Admission may be live after this send. A missing ACK must not stop or
    // replace this process, even if command delivery itself appears to fail.
    process.committed = true;
    try {
      await process.send({ type: 'canaveral-update-committed', version: 1, releaseId: process.releaseId, installationId: this.store.installationId });
      await timeout(acknowledged, this.readinessTimeoutMs, 'Candidate commit acknowledgement deadline ended');
    } finally { cleanup(); }
  }
  private async status(quiesce: boolean): Promise<QuiesceReceipt> {
    const active = this.current;
    if (this.busy || this.closed || !active || !active.committed) return { idle: false, workloadsStopped: false, quiesced: false };
    if (active.child.exitCode !== null || active.child.signalCode !== null) return active.native ? this.nativeGate(active.releaseId) : { idle: false, workloadsStopped: false, quiesced: false };
    const requestId = randomUUID(); let remove = (): void => {};
    const result = new Promise<QuiesceReceipt>((accept, reject) => {
      const message = (raw: unknown): void => {
        try { const v = updateObject(raw); if (v.type !== 'canaveral-update-status' || v.requestId !== requestId) return;
          if (typeof v.idle !== 'boolean' || typeof v.workloadsStopped !== 'boolean' || typeof v.quiesced !== 'boolean') throw new Error('Invalid workload gate');
          accept({ idle: v.idle, workloadsStopped: v.workloadsStopped, quiesced: v.quiesced });
        } catch { reject(new Error('Invalid host status receipt')); }
      };
      const exit = (): void => reject(new Error('Host exited without a workload gate'));
      remove = () => { active.messages.removeListener('message', message); active.child.removeListener('exit', exit); };
      active.messages.on('message', message); active.child.once('exit', exit);
    });
    // Attach rejection handling before command delivery can fail.
    void result.catch(() => {});
    try { await active.send({ type: quiesce ? 'canaveral-update-quiesce' : 'canaveral-update-status', requestId }); return await timeout(result, this.stopTimeoutMs, 'Positive host status deadline ended'); }
    finally { remove(); }
  }
  private async nativeGate(releaseId: string): Promise<QuiesceReceipt> {
    const negative = { idle: false, workloadsStopped: false, quiesced: false };
    if (!this.nativeConfigFile) return negative;
    try {
      const release = this.store.verifyInstalled(releaseId), config = updateObject(readUpdateJSON(this.nativeConfigFile));
      const binding = updateObject(config.binding), entry = join(this.store.releasePath(releaseId), release.manifest.entrypoint);
      const job = this.store.job();
      if (job?.binding && ['controllerId', 'runnerId', 'generation', 'incarnationId'].some(key => job.binding![key as keyof typeof job.binding] !== binding[key])) return negative;
      const raw = await new Promise<Buffer>((accept, reject) => {
        const probe = spawn(entry, ['--update-status', this.nativeConfigFile!], { cwd: this.store.releasePath(releaseId), shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
        const chunks: Buffer[] = []; let bytes = 0, failed = false;
        const timer = setTimeout(() => { failed = true; probe.kill('SIGTERM'); reject(new Error('Native status deadline ended')); }, this.stopTimeoutMs);
        probe.stdout!.on('data', (data: Buffer) => { bytes += data.length; if (bytes > MAX_HANDSHAKE_BYTES) { failed = true; probe.kill('SIGTERM'); reject(new Error('Native status exceeds bound')); } else chunks.push(data); });
        probe.once('error', error => { clearTimeout(timer); reject(error); });
        probe.once('exit', (code, signal) => { clearTimeout(timer); if (!failed && code === 0 && signal === null) accept(Buffer.concat(chunks)); else reject(new Error('Native status was not positively completed')); });
      });
      const text = raw.toString('utf8'); if (!Buffer.from(text).equals(raw)) return negative;
      const receipt = updateObject(JSON.parse(text) as unknown), b = updateObject(receipt.binding);
      if (receipt.type !== 'canaveral-update-status' || receipt.version !== 1 || Object.keys(b).length !== 4 || ['controllerId', 'runnerId', 'generation', 'incarnationId'].some(key => b[key] !== binding[key])) return negative;
      if (receipt.idle !== true || receipt.workloadsStopped !== true || receipt.quiesced !== true) return negative;
      return { idle: true, workloadsStopped: true, quiesced: true };
    } catch { return negative; }
  }
  async idle(): Promise<IdleReceipt> { return this.status(false); }
  async quiesce(): Promise<QuiesceReceipt> { return this.status(true); }
  private async stop(process: Launched): Promise<boolean> {
    if (process.child.exitCode !== null || process.child.signalCode !== null || !process.child.pid) { await process.exited; return true; }
    // Committed hosts reach this only with positive quiesce. No SIGKILL escalation.
    process.child.kill('SIGTERM');
    try { await timeout(process.exited, this.stopTimeoutMs, 'Host process did not stop'); return true; } catch { return false; }
  }
  async start(): Promise<void> {
    if (this.closed || this.busy || this.current) throw new Error('Launcher is closed or already started');
    const tx = this.transaction(); if (tx && tx.phase !== 'finished') throw new Error('Uncertain prior activation; retain saved process ownership');
    if (existsSync(this.runtimePath) && updateObject(readUpdateJSON(this.runtimePath)).state !== 'stopped') throw new Error('Prior child stop is uncertain; no replacement will be launched');
    const id = this.store.active(); if (!id) throw new Error('Bootstrap a verified initial release before launching');
    const floor = this.store.highwater(), release = this.store.verifyInstalled(id), job = this.store.job();
    const baseline = (tx?.receipt?.state === 'rolledBack' && tx.receipt.installedReleaseId === id) || (job?.previousReleaseId === id && !job.activationReported);
    if (release.manifest.sequence !== floor.sequence && !baseline) throw new Error('Active release differs from high-water mark and verified baseline');
    this.busy = true;
    try { this.pending = this.launch(id); await this.pending.ready; this.current = this.pending; this.pending = undefined; await this.commit(this.current); }
    catch (error) { if (this.pending) { if (!await this.stop(this.pending)) throw new Error('Startup process stop uncertain'); this.pending = undefined; } throw error; }
    finally { this.busy = false; this.events.emit('settled'); }
  }
  async recover(request: ActivationRequest): Promise<ActivationReceipt | undefined> {
    const tx = this.transaction(); if (!tx || !same(tx, request)) return undefined;
    return tx.receipt ?? { ...request, state: 'unknown' };
  }
  async activate(request: ActivationRequest): Promise<ActivationReceipt> {
    if (this.closed || this.busy) throw new Error('Launcher is closed or already activating');
    for (const id of [request.jobId, request.attemptId, request.releaseId, request.installationId]) updateUUID(id);
    const prior = this.transaction(); if (prior && same(prior, request)) return prior.receipt ?? { ...request, state: 'unknown' };
    if (prior && prior.phase !== 'finished') throw new Error('Previous activation is uncertain');
    const job = this.store.job();
    if (!job || job.id !== request.jobId || job.attemptId !== request.attemptId || job.installationId !== request.installationId || job.release.manifest.releaseId !== request.releaseId || job.phase !== 'activating' || job.pending || job.gate?.idle !== true || job.gate.workloadsStopped !== true || job.gate.quiesced !== true) throw new Error('Activation requires an acknowledged job and positive idle/quiesce receipts');
    const previousReleaseId = this.store.active();
    if (!previousReleaseId || previousReleaseId !== job.previousReleaseId || this.current?.releaseId !== previousReleaseId) throw new Error('Exact verified baseline must run under this launcher');
    this.store.verifyInstalled(previousReleaseId); const candidate = this.store.verifyInstalled(request.releaseId), floor = this.store.highwater();
    if (candidate.manifest.sequence !== floor.sequence || floor.releaseId !== request.releaseId) throw new Error('Candidate differs from reserved high-water release');
    // Read again through the current child, after the caller's quiesce and before any signal.
    const gate = await this.status(true); if (gate.idle !== true || gate.workloadsStopped !== true || gate.quiesced !== true) throw new Error('Current child did not positively confirm quiesce');
    const tx: LaunchTransaction = { ...request, previousReleaseId, phase: 'stopping' }; this.save(tx); this.busy = true;
    try {
      if (!await this.stop(this.current!)) return this.finish(tx, 'unknown');
      this.current = undefined; tx.phase = 'starting'; this.save(tx);
      try { this.pending = this.launch(request.releaseId); await this.pending.ready; }
      catch {
        if (this.pending && !await this.stop(this.pending)) return this.finish(tx, 'unknown');
        this.pending = undefined; tx.phase = 'restoring'; this.save(tx);
        try { this.store.verifyInstalled(previousReleaseId); this.pending = this.launch(previousReleaseId); await this.pending.ready; }
        catch { if (this.pending) await this.stop(this.pending); return this.finish(tx, 'unknown'); }
        this.store.setActive(previousReleaseId); tx.phase = 'committing'; this.save(tx);
        this.current = this.pending; this.pending = undefined;
        try { await this.commit(this.current); } catch { return this.finish(tx, 'unknown'); }
        return this.finish(tx, 'rolledBack', previousReleaseId);
      }
      this.store.setActive(request.releaseId); tx.phase = 'committing'; this.save(tx);
      this.current = this.pending; this.pending = undefined;
      try { await this.commit(this.current); } catch { return this.finish(tx, 'unknown'); }
      return this.finish(tx, 'succeeded', request.releaseId);
    } finally { this.busy = false; this.events.emit('settled'); }
  }
  private finish(tx: LaunchTransaction, state: ActivationReceipt['state'], installedReleaseId?: string): ActivationReceipt {
    const receipt: ActivationReceipt = { jobId: tx.jobId, attemptId: tx.attemptId, releaseId: tx.releaseId, installationId: tx.installationId, state, ...(installedReleaseId ? { installedReleaseId } : {}) };
    tx.phase = state === 'unknown' ? 'unknown' : 'finished'; tx.receipt = receipt; this.save(tx); return receipt;
  }
  /** Service shutdown is gated separately; stopping the service never authorizes VM termination. */
  async close(gate?: QuiesceReceipt): Promise<void> {
    if (this.busy) throw new Error('Cannot close during activation');
    const live = this.current && this.current.child.exitCode === null && this.current.child.signalCode === null;
    if (live && (!gate || !gate.idle || !gate.workloadsStopped || !gate.quiesced)) throw new Error('Closing a live host requires positive idle/quiesce');
    if (this.pending && !await this.stop(this.pending)) throw new Error('Candidate stop uncertain');
    if (this.current && !await this.stop(this.current)) throw new Error('Host stop uncertain');
    this.current = undefined; this.pending = undefined; this.closed = true; this.lock.close(); this.events.emit('settled');
  }
  async wait(): Promise<void> {
    while (this.current) {
      const active = this.current; await active.exited;
      if (this.busy) await once(this.events, 'settled');
      if (this.current === active) { if (active.native && !this.closed) await once(this.events, 'settled'); else return; }
    }
  }
}

/** Convenience handshake for Node entrypoints; start must retain admission fencing. */
export async function announceUpdateReady(releaseId = process.env.CANAVERAL_UPDATE_RELEASE, installationId = process.env.CANAVERAL_UPDATE_INSTALLATION, deadlineMs = 30_000, start: () => Promise<void> = async () => {}): Promise<void> {
  updateUUID(releaseId); updateUUID(installationId);
  const phase = async (outgoing: string, incoming: string): Promise<void> => {
    if (!process.send || !process.connected) throw new Error('Managed readiness requires inherited launcher IPC');
    let remove = (): void => {};
    const received = new Promise<void>((accept, reject) => {
      const message = (v: unknown): void => matches(v, incoming, releaseId!, installationId!) ? accept() : reject(new Error('Launcher startup identity mismatch'));
      const disconnected = (): void => reject(new Error('Launcher disconnected before commit'));
      remove = () => { process.removeListener('message', message); process.removeListener('disconnect', disconnected); };
      process.on('message', message); process.once('disconnect', disconnected);
      process.send!({ type: outgoing, version: 1, releaseId, installationId }, error => { if (error) reject(error); });
    });
    try { await timeout(received, deadlineMs, 'Launcher startup deadline ended'); } finally { remove(); }
  };
  await phase('canaveral-update-ready', 'canaveral-update-activate'); await start(); await phase('canaveral-update-started', 'canaveral-update-committed');
  await new Promise<void>((accept, reject) => process.send!({ type: 'canaveral-update-committed-ack', version: 1, releaseId, installationId }, error => error ? reject(error) : accept()));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { const key = args[i], value = args[i + 1]; if (!key || !['--installation', '--host-config', '--state'].includes(key) || !value || values[key]) throw new Error('Usage: launcher --installation /private/root --host-config /absolute/host.json --state /private/update-state'); values[key] = value; }
  const installationRoot = values['--installation'], hostConfigPath = values['--host-config'], stateDirectory = values['--state'];
  if (!installationRoot || !hostConfigPath || !stateDirectory || !isAbsolute(hostConfigPath)) throw new Error('Launcher requires absolute installation, host-config and state paths');
  const config = updateObject(readUpdateJSON(hostConfigPath)), updates = updateObject(config.updates);
  const hostStateDirectory = typeof config.stateDir === 'string' && isAbsolute(config.stateDir) ? config.stateDir : typeof config.agentStateDirectory === 'string' && isAbsolute(config.agentStateDirectory) ? config.agentStateDirectory : undefined;
  if (!hostStateDirectory || typeof config.url !== 'string') throw new Error('Explicit persistent host state and controller URL are required');
  const target = { os: process.platform, arch: process.arch === 'x64' ? 'amd64' : process.arch }, trustedKeys = updateObject(updates.trustedKeys);
  if (!Object.keys(trustedKeys).length || Object.values(trustedKeys).some(key => typeof key !== 'string')) throw new Error('Pinned public keys must be PEM strings');
  if (!Array.isArray(updates.protectedPaths) || updates.protectedPaths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('List persistent credential/provider/disk roots in updates.protectedPaths');
  const launcher = new StableLauncher({ installationRoot, stateDirectory, hostConfigPath, hostStateDirectory, trustedKeys: trustedKeys as Record<string, string>, target: target as StableLauncherOptions['target'], protectedPaths: updates.protectedPaths as string[] });
  const { startManagedUpdateRuntime } = await import('./runtime.ts');
  await launcher.start();
  const runtime = startManagedUpdateRuntime({ config: { ...config, url: config.url, stateDir: hostStateDirectory }, launcher, log: message => process.stderr.write(message + '\n') });
  let stopping = false;
  const stop = (): void => { if (stopping) return; stopping = true; void (async () => {
    // Refusal retains the live host. There is no forced signal escalation.
    const gate = await launcher.quiesce(); if (!gate.idle || !gate.workloadsStopped || !gate.quiesced) throw new Error('Host workloads are not positively idle');
    await runtime.close(); await launcher.close(gate);
  })().catch(() => { stopping = false; process.stderr.write('Launcher stop not confirmed; retaining host, state and ownership.\n'); }); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try { await launcher.wait(); }
  finally { await runtime.close(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await launcher.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => { process.stderr.write('Managed launcher failed; retain installation, workload state and saved receipts for inspection.\n'); process.exitCode = 1; });
