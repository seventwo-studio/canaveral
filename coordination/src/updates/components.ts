import { createHash } from 'node:crypto';
import { parseManifest, releasePath } from './protocol.ts';
import type { Manifest, SignedRelease } from './protocol.ts';

export type AdoptableComponent = 'guest' | 'native-helper';
export type ComponentTarget =
  | { component: 'guest'; machineId: string; assignmentId: string; bootId: string; generation: number }
  | { component: 'native-helper'; helperId: string; executable: string; instanceId: string; generation: number };
export interface ComponentContext { jobId: string; attemptId: string; installationId: string; releaseId: string }
export interface ComponentAdoptionRequest extends ComponentContext { fileSetDigest: string; target: ComponentTarget }
/** Evidence is obtained from the owned transport, never from spawn or host readiness. */
export interface ComponentAdoptionReceipt extends ComponentAdoptionRequest {
  state: 'adopted' | 'unknown';
  evidence: { boundary: 'idle-closed'; acknowledgement: string } | null;
}
export interface ComponentReport extends ComponentAdoptionRequest {
  sequence: number; state: 'intent' | 'adopted' | 'unknown';
  evidence: ComponentAdoptionReceipt['evidence'];
}
/** Drivers must recheck current ownership and a positive idle/closed boundary before effects. */
export interface ComponentAdoptionDriver {
  targets(context: ComponentContext, release: SignedRelease): Promise<readonly ComponentTarget[]>;
  adopt(request: ComponentAdoptionRequest): Promise<ComponentAdoptionReceipt>;
  /** Inspection only: an uncertain dispatch must never be repeated. */
  recover(request: ComponentAdoptionRequest): Promise<ComponentAdoptionReceipt | undefined>;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid component record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) throw new Error('Invalid component fields');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 1024 || /[^\x21-\x7e]/.test(value)) throw new Error('Invalid component identity'); return value;
}
function uuid(value: unknown): string {
  const s = text(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(s)) throw new Error('Invalid component UUID'); return s;
}
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid component sequence'); return value; }
function hash(value: unknown): string { const s = text(value); if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('Invalid component digest'); return s; }
export function parseComponentTarget(value: unknown): ComponentTarget {
  const component = (value as { component?: unknown } | null)?.component;
  if (component === 'guest') {
    const v = record(value, ['component', 'machineId', 'assignmentId', 'bootId', 'generation']);
    return { component, machineId: uuid(v.machineId), assignmentId: text(v.assignmentId), bootId: uuid(v.bootId), generation: integer(v.generation) };
  }
  if (component === 'native-helper') {
    const v = record(value, ['component', 'helperId', 'executable', 'instanceId', 'generation']);
    return { component, helperId: text(v.helperId), executable: releasePath(v.executable), instanceId: text(v.instanceId), generation: integer(v.generation) };
  }
  throw new Error('Invalid adoption component');
}
export function parseComponentReport(value: unknown): ComponentReport {
  const v = record(value, ['jobId', 'attemptId', 'installationId', 'releaseId', 'fileSetDigest', 'target', 'sequence', 'state', 'evidence']);
  if (!['intent', 'adopted', 'unknown'].includes(String(v.state))) throw new Error('Invalid component state');
  let evidence: ComponentReport['evidence'] = null;
  if (v.evidence !== null) { const e = record(v.evidence, ['boundary', 'acknowledgement']); if (e.boundary !== 'idle-closed') throw new Error('Missing closed boundary'); evidence = { boundary: 'idle-closed', acknowledgement: hash(e.acknowledgement) }; }
  if ((v.state === 'adopted') !== (evidence !== null)) throw new Error('Invalid adoption evidence');
  return { jobId: uuid(v.jobId), attemptId: uuid(v.attemptId), installationId: uuid(v.installationId), releaseId: uuid(v.releaseId), fileSetDigest: hash(v.fileSetDigest), target: parseComponentTarget(v.target), sequence: integer(v.sequence), state: v.state as ComponentReport['state'], evidence };
}
/** The complete signed subset, including names, modes and byte counts, independent of manifest order. */
export function componentFileSetDigest(manifest: Manifest, component: AdoptableComponent): string {
  const files = parseManifest(manifest).files.filter(f => f.component === component).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.length) throw new Error('Release has no files for component');
  return createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.sha256, f.bytes, f.executable, f.component]))).digest('hex');
}
export function componentTargetKey(target: ComponentTarget): string { return JSON.stringify(parseComponentTarget(target)); }
