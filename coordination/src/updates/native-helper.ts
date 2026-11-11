import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NodeNativeHelperSelection } from '../providers/mobile-native.ts';
import { StateLock } from '../runtime-process.ts';
import { atomicUpdateJSON, readUpdateJSON, UpdateStore } from './manager.ts';
import { componentFileSetDigest, parseComponentReport } from './components.ts';
import type { ComponentAdoptionDriver, ComponentAdoptionReceipt, ComponentAdoptionRequest, ComponentContext, ComponentReport, ComponentTarget } from './components.ts';
import type { SignedRelease } from './protocol.ts';

function copyRequest(request: ComponentAdoptionRequest): ComponentAdoptionRequest {
  // The strict parser supplies stable field order and rejects extra caller fields.
  const { sequence: _sequence, state: _state, evidence: _evidence, ...identity } = parseComponentReport({ ...request, sequence: 1, state: 'intent', evidence: null });
  return identity;
}
function binding(request: ComponentAdoptionRequest): string {
  return createHash('sha256').update(JSON.stringify(copyRequest(request))).digest('hex');
}
function receipt(request: ComponentAdoptionRequest, acknowledgement?: string): ComponentAdoptionReceipt {
  return { ...request, state: acknowledgement ? 'adopted' : 'unknown', evidence: acknowledgement ? { boundary: 'idle-closed', acknowledgement } : null };
}
/** Unix process selection only. Share selection with createNodeMobileTransport.
 * verifyAcknowledgement is local inspection; controller evidence requires an
 * independent source for the current helper identity.
 * After process loss a durable receipt alone cannot establish a current instance.
 */
export class NativeHelperAdoptionDriver implements ComponentAdoptionDriver {
  private closed = false;
  private readonly journal: string;
  private readonly lock: StateLock;
  constructor(private readonly store: UpdateStore, readonly selection: NodeNativeHelperSelection,
    private readonly executable = 'native/canaveral-mobile-native') {
    if (process.platform === 'win32' || store.target.os === 'win32') throw new Error('Windows helper admission requires platform acceptance');
    this.journal = join(store.stateDirectory, `helper-${createHash('sha256').update(selection.helperId).digest('hex')}.json`);
    this.lock = new StateLock(`${this.journal}.lock`);
    try { if ((this.saved()?.sequence ?? 0) > 1) selection.block(); }
    catch (error) { selection.block(); this.lock.close(); throw error; }
  }
  private saved(): ComponentReport | undefined { if (this.closed) throw new Error("Native helper driver is closed"); return existsSync(this.journal) ? parseComponentReport(readUpdateJSON(this.journal)) : undefined; }
  private verify(request: ComponentAdoptionRequest): string {
    binding(request);
    if (request.installationId !== this.store.installationId || request.target.component !== 'native-helper' || request.target.helperId !== this.selection.helperId || request.target.executable !== this.executable) throw new Error('Native helper ownership/path mismatch');
    const release = this.store.verifyInstalled(request.releaseId);
    const file = release.manifest.files.find(file => file.path === this.executable && file.component === 'native-helper' && file.executable);
    if (!file || componentFileSetDigest(release.manifest, 'native-helper') !== request.fileSetDigest) throw new Error('Native helper signed file-set mismatch');
    return join(this.store.releasePath(request.releaseId), this.executable);
  }
  async targets(context: ComponentContext, signedRelease: SignedRelease): Promise<readonly ComponentTarget[]> {
    signedRelease = this.store.validate(signedRelease);
    if (context.releaseId !== signedRelease.manifest.releaseId || context.installationId !== this.store.installationId) throw new Error('Native helper release identity mismatch');
    const installed = this.store.verifyInstalled(context.releaseId);
    if (JSON.stringify(installed) !== JSON.stringify(signedRelease)) throw new Error('Native helper release envelope mismatch');
    const old = this.saved();
    if (old && old.jobId === context.jobId && old.attemptId === context.attemptId && old.releaseId === context.releaseId && old.installationId === context.installationId) return [old.target];
    if (old && (old.state !== 'adopted' || !this.selection.inspect(binding(old)))) throw new Error('Uncertain native helper attempt must be recovered without replay');
    const target: ComponentTarget = { component: 'native-helper', helperId: this.selection.helperId, executable: this.executable, instanceId: randomUUID(), generation: old ? old.target.generation + 1 : 1 };
    const request = { ...context, target, fileSetDigest: componentFileSetDigest(installed.manifest, 'native-helper') };
    this.verify(request);
    // Plan/intent is durable before stopping the old idle probe or starting a candidate.
    atomicUpdateJSON(this.journal, { ...request, sequence: 1, state: 'intent', evidence: null });
    return [target];
  }
  async adopt(request: ComponentAdoptionRequest): Promise<ComponentAdoptionReceipt> {
    request = copyRequest(request);
    const executable = this.verify(request), saved = this.saved(), key = binding(request);
    if (!saved || binding(saved) !== key) throw new Error('Native helper attempt/instance mismatch');
    if (saved.sequence > 1) return (await this.recover(request))!;
    // Dispatch marker prevents a retry even if the process or reply disappears.
    atomicUpdateJSON(this.journal, { ...request, sequence: 2, state: 'intent', evidence: null });
    try {
      await this.selection.fence();
      this.verify(request); // Recheck sealed bytes immediately before execution.
      const acknowledgement = await this.selection.acknowledge(executable, key);
      const adopted = receipt(request, acknowledgement);
      atomicUpdateJSON(this.journal, { ...adopted, sequence: 3 });
      this.selection.commit(executable, key);
      return adopted;
    } catch {
      // Keep the fence, owned process and original attempt for inspection.
      return receipt(request);
    }
  }
  async recover(request: ComponentAdoptionRequest): Promise<ComponentAdoptionReceipt | undefined> {
    request = copyRequest(request);
    this.verify(request);
    const saved = this.saved(), key = binding(request);
    if (!saved) return undefined;
    if (binding(saved) !== key) throw new Error('Native helper recovery identity mismatch');
    const acknowledgement = this.selection.inspect(key);
    if (!acknowledgement) return receipt(request);
    // Inspection only: never spawn, stop, resend the handshake or change selection.
    return receipt(request, acknowledgement);
  }
  verifyAcknowledgement(request: ComponentAdoptionRequest, acknowledgement: string): boolean {
    try { this.verify(request); const saved = this.saved(); return !!saved && binding(saved) === binding(request) && this.selection.inspect(binding(request)) === acknowledgement; }
    catch { return false; }
  }
  close(): void { this.closed = true; this.lock.close(); }
}
