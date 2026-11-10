import { createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { hostOffer, hostTransport, HostRunner } from '../host.ts';
import type { HostConfig } from '../host.ts';
import { identifier } from '../consumers.ts';
import { secret } from '../errors.ts';
import { ManagedUpdater, readUpdateJSON, updateObject, updateUUID } from './manager.ts';
import type { ActivationDriver, IdleReceipt, QuiesceReceipt, UpdateStore, ControllerRequest, HostIdentity, RunnerUpdateBinding } from './manager.ts';
import { noLinks } from '../runtime-process.ts';
import { verifyRelease } from './protocol.ts';

export interface ManagedRuntimeOptions {
  config: HostConfig;
  launcher: ActivationDriver & { store: UpdateStore; idle(): Promise<IdleReceipt>; quiesce(): Promise<QuiesceReceipt> };
  intervalMs?: number;
  log?(message: string): void;
}
/** Parent-owned polling survives replacing the host child. Identity is reread for rotation. */
export function startManagedUpdateRuntime(options: ManagedRuntimeOptions): { updater: ManagedUpdater; close(): Promise<void>; wait(): Promise<void> } {
  const { config, launcher } = options;
  const interval = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60_000) throw new Error('Invalid managed update interval');
  const settings = config.updates === undefined ? {} : updateObject(config.updates);
  const runner = settings.targetKind === 'runner';
  if (settings.targetKind !== undefined && !['host', 'runner'].includes(String(settings.targetKind))) throw new Error('Invalid managed target kind');
  const native = runner ? nativeRunnerConfig(config) : undefined;
  const caFile = native?.caFile ?? native?.ca;
  const transport = hostTransport({ ...config, ...(typeof caFile === 'string' ? { caFile } : {}) });
  const identity = (): HostIdentity => {
    if (runner) return readManagedRunnerIdentity(config);
    const saved = updateObject(readUpdateJSON(join(resolve(config.stateDir), 'identity.json')));
    if (saved.orchestrator !== config.url.replace(/\/+$/, '')) throw new Error('Managed identity belongs to another controller');
    return { id: identifier(saved.id), credential: secret(saved.credential) };
  };
  identity();
  const request: ControllerRequest = (method, path, body, credential, signal) => transport.request(method, path, body, credential, signal);
  const updater = new ManagedUpdater({
    installationRoot: launcher.store.installationRoot, stateDirectory: launcher.store.stateDirectory,
    trustedKeys: launcher.store.trustedKeys, target: launcher.store.target,
    protectedPaths: [resolve(config.stateDir)], maxReleaseBytes: launcher.store.maxReleaseBytes, minimumFreeBytes: launcher.store.minimumFreeBytes,
    targetKind: runner ? 'runner' : 'host', request, identity, lifecycle: { idle: () => launcher.idle(), quiesce: () => launcher.quiesce(), activation: launcher },
  });
  let closed = false, wake: (() => void) | undefined;
  const work = (async (): Promise<void> => {
    while (!closed) {
      try { await updater.poll(); if (!closed) await updater.step(); }
      catch { options.log?.('Managed update awaits controller contact or retained-state inspection.'); }
      if (!closed) await new Promise<void>(done => { const timer = setTimeout(() => { wake = undefined; done(); }, interval); wake = () => { clearTimeout(timer); wake = undefined; done(); }; });
    }
  })();
  return { updater, wait: () => work, close: async () => { closed = true; wake?.(); await updater.close(); await work; } };
}

function nativeRunnerConfig(config: HostConfig): Record<string, unknown> {
  const settings = updateObject(config.updates);
  if (typeof settings.nativeConfigFile !== 'string' || !isAbsolute(settings.nativeConfigFile)) throw new Error('Runner updates require an external nativeConfigFile');
  const native = updateObject(readUpdateJSON(settings.nativeConfigFile));
  if ((native.controller ?? native.origin) !== config.url) throw new Error('Native runner controller differs from managed origin');
  const state = native.state ?? updateObject(native.execution ?? {}).stateDir;
  if (state !== config.stateDir) throw new Error('Native runner state differs from managed state');
  return native;
}
/** Uses the native operator file and saved binding; never enrolls or forwards to another origin. */
export function readManagedRunnerIdentity(config: HostConfig): HostIdentity {
  const native = nativeRunnerConfig(config), raw = updateObject(native.binding);
  const binding: RunnerUpdateBinding = { controllerId: updateUUID(raw.controllerId), runnerId: updateUUID(raw.runnerId), generation: Number(raw.generation), incarnationId: updateUUID(raw.incarnationId) };
  if (!Number.isSafeInteger(raw.generation) || binding.generation < 1) throw new Error('Invalid native generation');
  let credential: string;
  if (typeof native.credentialFile === 'string' && isAbsolute(native.credentialFile)) {
    noLinks(native.credentialFile); const info = lstatSync(native.credentialFile);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o177)) throw new Error('Private native credential required');
    credential = secret(readFileSync(native.credentialFile, 'utf8').trim());
  } else if (typeof native.identity === 'string' && isAbsolute(native.identity)) {
    const envelope = updateObject(readUpdateJSON(join(native.identity, 'identity.json'))), record = updateObject(envelope.record), approval = updateObject(record.approval);
    // Rust validates its typed-envelope checksum at startup and each positive idle probe.
    // Its struct/f64 serialization is not JavaScript JSON canonicalization.
    if (typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256) || record.version !== 1 || !['Consumed', 'Authenticated'].includes(String(record.phase)) || record.credential === approval.enrollmentToken || record.origin !== config.url.replace(/\/+$/, '') || Object.entries(binding).some(([key, value]) => approval[key] !== value)) throw new Error('Saved native identity binding changed');
    credential = secret(record.credential);
  } else throw new Error('Native credential location is unavailable');
  return { id: binding.runnerId, credential, binding };
}

export interface UpdateContext { releaseId: string; installationId: string }
/** No constructors, enrollment, directories, locks, provider probes or network requests. */
export function preflightManagedHost(config: HostConfig, env: NodeJS.ProcessEnv = process.env): UpdateContext {
  if (env.CANAVERAL_UPDATE_CANDIDATE !== '1') throw new Error('Managed candidate context is required');
  const releaseId = updateUUID(env.CANAVERAL_UPDATE_RELEASE), installationId = updateUUID(env.CANAVERAL_UPDATE_INSTALLATION);
  const root = env.CANAVERAL_UPDATE_ROOT, state = env.CANAVERAL_UPDATE_STATE;
  if (!root || !state || !isAbsolute(root) || !isAbsolute(state) || !isAbsolute(config.stateDir)) throw new Error('Managed candidate paths must be absolute');
  const updates = updateObject(config.updates), keys = updateObject(updates.trustedKeys);
  if (!Object.keys(keys).length || Object.values(keys).some(key => typeof key !== 'string' || createPublicKey(key).asymmetricKeyType !== 'ed25519')) throw new Error('Pinned Ed25519 update trust is required');
  const installation = updateObject(readUpdateJSON(join(state, 'installation.json')));
  if (installation.installationId !== installationId || installation.installationRoot !== root) throw new Error('Managed installation context changed');
  const release = verifyRelease(readUpdateJSON(join(state, 'manifests', `${releaseId}.json`)), keys as Record<string, string>, installation.target as UpdateStore['target']);
  if (release.manifest.releaseId !== releaseId) throw new Error('Managed release identity changed');
  const info = lstatSync(config.stateDir);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Managed host state must already be private');
  hostOffer(config); hostTransport(config);
  const identity = updateObject(readUpdateJSON(join(config.stateDir, 'identity.json')));
  identifier(identity.id); secret(identity.credential);
  if (identity.orchestrator !== config.url.replace(/\/+$/, '')) throw new Error('Saved host identity belongs to another controller');
  return { releaseId, installationId };
}
function send(message: object): Promise<void> {
  return new Promise((accept, reject) => {
    if (!process.send || !process.connected) { reject(new Error('Managed host requires launcher IPC')); return; }
    process.send(message, error => error ? reject(error) : accept());
  });
}
function phase(context: UpdateContext, outgoing: string, incoming: string, timeoutMs: number): Promise<void> {
  return new Promise((accept, reject) => {
    const finish = (error?: Error): void => { clearTimeout(timer); process.removeListener('message', message); process.removeListener('disconnect', disconnect); error ? reject(error) : accept(); };
    const message = (value: unknown): void => {
      try { const record = updateObject(value);
        if (Object.keys(record).length !== 4 || record.type !== incoming || record.version !== 1 || record.releaseId !== context.releaseId || record.installationId !== context.installationId) throw new Error('Unexpected managed startup message');
        finish();
      } catch { finish(new Error('Managed startup identity or phase mismatch')); }
    };
    const disconnect = (): void => finish(new Error('Launcher disconnected before startup commit'));
    const timer = setTimeout(() => finish(new Error('Managed startup deadline ended')), timeoutMs);
    process.on('message', message); process.once('disconnect', disconnect);
    void send({ type: outgoing, version: 1, ...context }).catch(error => finish(error as Error));
  });
}
/** Bind only fixed read/status and admission-fence commands, never remote shell commands. */
export function bindManagedHost(runner: HostRunner): () => void {
  let closed = false, busy = false;
  const message = (raw: unknown): void => {
    let value: Record<string, unknown>;
    try { value = updateObject(raw); if (Object.keys(value).length !== 2 || !['canaveral-update-status', 'canaveral-update-quiesce'].includes(String(value.type))) return; updateUUID(value.requestId); } catch { return; }
    const reply = async (): Promise<void> => {
      let receipt = { idle: false, workloadsStopped: false, quiesced: false };
      if (!busy) {
        busy = true;
        try { receipt = value.type === 'canaveral-update-quiesce' ? await runner.quiesceForUpdate() : { ...await runner.updateIdle(), quiesced: runner.updateAdmissionFenced }; }
        catch { /* A missing observation is never idle. */ }
        finally { busy = false; }
      }
      if (!closed) await send({ type: 'canaveral-update-status', requestId: value.requestId, ...receipt });
    };
    void reply().catch(() => { runner.fenceUpdateAdmission(); });
  };
  process.on('message', message);
  return () => { closed = true; process.removeListener('message', message); };
}
/** Readonly ready -> activate -> fenced startup -> started -> commit -> admit work. */
export async function startManagedHost(config: HostConfig, timeoutMs = 30_000): Promise<HostRunner> {
  const context = preflightManagedHost(config);
  await phase(context, 'canaveral-update-ready', 'canaveral-update-activate', timeoutMs);
  // The saved credential is authoritative. Never reenroll from a retained setup token.
  const active = { ...config }; delete active.enrollmentToken;
  const runner = new HostRunner(active); runner.fenceUpdateAdmission();
  let unbind = (): void => {};
  try {
    await runner.start();
    await phase(context, 'canaveral-update-started', 'canaveral-update-committed', timeoutMs);
    unbind = bindManagedHost(runner); runner.resumeUpdateAdmission();
    // Commit has been processed and admission has an owner before acknowledging it.
    // A lost ACK fences new work but never aborts already authorized operations.
    try { await send({ type: 'canaveral-update-committed-ack', version: 1, ...context }); }
    catch { runner.fenceUpdateAdmission(); }
    const close = runner.close.bind(runner); runner.close = async () => { unbind(); await close(); };
    return runner;
  } catch (error) { unbind(); await runner.close(); throw error; }
}
