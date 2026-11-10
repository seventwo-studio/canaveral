/** Native snapshots: full verified transfer, preserved provider fields, no UI actions. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { checked, identifier, record, SessionError } from './sdk.ts';
import type { SessionChannel } from './sdk.ts';
export const SNAPSHOT_SCHEMA = 'canaveral-accessibility-v1';
export const MAX_SNAPSHOT_BYTES = 6 * 1048576;
export interface Bounds extends Record<string, unknown> { x: number; y: number; width: number; height: number }
export interface AccessibilityNode extends Record<string, unknown> {
  id: string; parentId: string | null; depth: number; role: string; name: string; identifier: string;
  states: Record<string, unknown> | string[]; actions: string[]; bounds: Bounds | null; properties: Record<string, unknown>;
}
export interface AccessibilitySnapshot extends Record<string, unknown> {
  snapshotId: string; capturedAt: number; source: string; coordinateSpace: 'screen-pixels' | 'screen-points';
  nodes: AccessibilityNode[]; truncated: boolean; coverage: string;
}
/** Canonical artifact stays in canaveral/schemas; returns a fresh object. */
export function snapshotSchema(): Record<string, unknown> {
  // Both source and coordination/dist/src invocation layouts are supported.
  for (const relative of ['../../canaveral/schemas/accessibility-snapshot.schema.json', '../../../canaveral/schemas/accessibility-snapshot.schema.json']) {
    try { return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Record<string, unknown>; } catch {}
  }
  throw new SessionError('The canonical accessibility schema is unavailable.', 'capability_unsupported', undefined, false);
}
function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }
export function validateSnapshot(value: unknown): AccessibilitySnapshot {
  const invalid = (): never => { throw new SessionError('Malformed native accessibility snapshot.'); };
  if (!record(value) || Object.hasOwn(value, 'frame')) return invalid();
  try { identifier(value.snapshotId); } catch { return invalid(); }
  if (!finite(value.capturedAt) || value.capturedAt < 0 || typeof value.source !== 'string' || !value.source ||
      !['screen-points', 'screen-pixels'].includes(String(value.coordinateSpace)) || typeof value.truncated !== 'boolean' ||
      typeof value.coverage !== 'string' || !value.coverage || !Array.isArray(value.nodes) || value.nodes.length > 2000 ||
      (Object.hasOwn(value, 'unavailableNodes') && (!Number.isSafeInteger(value.unavailableNodes) || Number(value.unavailableNodes) < 0))) return invalid();
  const seen = new Map<string, number>();
  for (const node of value.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !node.id || seen.has(node.id) || !Object.hasOwn(node, 'parentId') ||
        (node.parentId !== null && (typeof node.parentId !== 'string' || !seen.has(node.parentId))) ||
        !Number.isInteger(node.depth) || Number(node.depth) < 0 || Number(node.depth) > 30 ||
        node.depth !== (node.parentId === null ? 0 : seen.get(String(node.parentId))! + 1) ||
        !['role', 'name', 'identifier'].every(k => typeof node[k] === 'string') ||
        !(record(node.states) || (Array.isArray(node.states) && node.states.every(s => typeof s === 'string'))) ||
        !Array.isArray(node.actions) || !node.actions.every(a => typeof a === 'string') || !record(node.properties) || !Object.hasOwn(node, 'bounds')) return invalid();
    const bounds = node.bounds;
    if (bounds !== null && (!record(bounds) || !['x', 'y', 'width', 'height'].every(k => finite(bounds[k])) ||
        Number(bounds.width) < 0 || Number(bounds.height) < 0)) return invalid();
    seen.set(node.id, Number(node.depth));
  }
  return value as AccessibilitySnapshot;
}
export async function receiveSnapshot(connection: SessionChannel, requestId: string, limit = MAX_SNAPSHOT_BYTES): Promise<AccessibilitySnapshot> {
  await connection.sendControl({ type: 'begin' });
  const meta = checked(await connection.receive(), requestId);
  if (!record(meta) || Object.keys(meta).sort().join(',') !== 'schema,size,type' || meta.type !== 'begin' || meta.schema !== SNAPSHOT_SCHEMA ||
      !Number.isInteger(meta.size) || Number(meta.size) < 1 || Number(meta.size) > limit) throw new SessionError('Accessibility metadata exceeds its envelope.', 'session_protocol_error', requestId);
  const size = Number(meta.size), chunks: Buffer[] = []; let received = 0; const hash = createHash('sha256');
  while (received < size) {
    const data = checked(await connection.receive(), requestId);
    if (!Buffer.isBuffer(data) || !data.length || data.length > Math.min(65536, size - received)) throw new SessionError('Accessibility snapshot is incomplete.', 'session_incomplete', requestId);
    chunks.push(data); received += data.length; hash.update(data);
  }
  const finish = checked(await connection.receive(), requestId);
  if (!record(finish) || Object.keys(finish).sort().join(',') !== 'bytes,sha256,type' || finish.type !== 'finish' || finish.bytes !== size || finish.sha256 !== hash.digest('hex')) throw new SessionError('Accessibility completion digest was not confirmed.', 'session_incomplete', requestId);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new SessionError('Accessibility snapshot is not valid UTF-8 JSON.', 'session_protocol_error', requestId); }
  return validateSnapshot(value);
}
/** Bounded normalization of native iOS JSON and Android UI Automator XML.
 * Snapshot identity is generated for a newly captured observation, never a mutation.
 */
export function snapshot(system: 'android' | 'ios', native: unknown): AccessibilitySnapshot {
  const nodes: AccessibilityNode[] = []; let truncated = false;
  const add = (props: Record<string, unknown>, parentId: string | null, depth: number): string | null => {
    if (nodes.length >= 2000 || depth > 30) { truncated = true; return null; }
    const id = 'ax-' + (nodes.length + 1); let node: AccessibilityNode;
    if (system === 'android') {
      const matches = String(props.bounds ?? '').match(/-?\d+/g)?.map(Number) ?? [];
      const bounds = matches.length === 4 ? { x: matches[0]!, y: matches[1]!, width: matches[2]! - matches[0]!, height: matches[3]! - matches[1]! } : null;
      const password = props.password === 'true';
      node = { id, parentId, depth, role: String(props.class ?? ''), name: String(props['content-desc'] || (password ? '' : props.text ?? '')), identifier: String(props['resource-id'] ?? ''), bounds,
        states: Object.fromEntries(['enabled', 'focused', 'focusable', 'selected', 'checked', 'checkable', 'clickable', 'scrollable', 'password'].filter(k => Object.hasOwn(props, k)).map(k => [k, props[k] === 'true'])),
        actions: props.clickable === 'true' ? ['click'] : [], properties: { ...props, text: password ? '[redacted]' : props.text ?? '' } };
    } else {
      let frame = props.frame || props.bounds;
      if (record(frame) && record(frame.origin)) frame = { ...frame.origin, ...(record(frame.size) ? frame.size : {}) };
      node = { id, parentId, depth, role: String(props.role || props.type || props.AXType || 'unknown'), name: String(props.label || props.AXLabel || props.title || ''), identifier: String(props.identifier || props.AXIdentifier || ''),
        bounds: (frame ?? null) as Bounds | null, states: Object.fromEntries(['enabled', 'focused', 'selected', 'isEnabled', 'isFocused'].filter(k => Object.hasOwn(props, k)).map(k => [k, props[k]])),
        actions: record(frame) && ['x', 'y', 'width', 'height'].every(k => Object.hasOwn(frame, k)) ? ['click'] : [], properties: props };
    }
    nodes.push(node); return id;
  };
  if (system === 'android') {
    const raw = typeof native === 'string' ? native : record(native) ? String(native.output ?? '') : '';
    // No DTD/entities: UI Automator emits only hierarchy/node elements and quoted attributes.
    if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new SessionError('Invalid Android hierarchy.');
    const start = raw.indexOf('<hierarchy'); if (start < 0) throw new SessionError('Android hierarchy unavailable.');
    const stack: Array<string | null> = []; let hierarchy = false, rootSeen = false, consumed = 0;
    for (const token of raw.slice(start).matchAll(/<[^>]*>|[^<]+/g)) {
      const text = token[0]; consumed += text.length; if (!text.startsWith('<')) { if (text.trim()) throw new SessionError('Invalid Android hierarchy.'); continue; }
      if (/^<hierarchy(?:\s[^<>]*)?\/>$/.test(text)) { if (rootSeen) throw new SessionError('Invalid hierarchy.'); rootSeen = true; continue; }
      if (/^<hierarchy(?:\s[^<>]*)?>$/.test(text)) { if (rootSeen) throw new SessionError('Invalid hierarchy.'); rootSeen = true; hierarchy = true; continue; }
      if (text === '</hierarchy>') { if (stack.length) throw new SessionError('Unclosed hierarchy node.'); hierarchy = false; continue; }
      if (text === '</node>') { if (!stack.length) throw new SessionError('Invalid hierarchy nesting.'); stack.pop(); continue; }
      const tag = /^<node\s+([\s\S]*?)(\/?)>$/.exec(text); if (!hierarchy || !tag) throw new SessionError('Invalid hierarchy tag.');
      const props: Record<string, unknown> = {}; let attributes = tag[1]!;
      const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
        const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
        if (named[entity]) return named[entity]!;
        const n = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
        if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new SessionError('Invalid XML character.'); return String.fromCodePoint(n);
      });
      while (attributes.trim()) {
        const match = /^\s*([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(attributes);
        if (!match || Object.hasOwn(props, match[1]!)) throw new SessionError('Invalid XML attribute.');
        const v = match[2] ?? match[3]!; if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(v)) throw new SessionError('Invalid XML entity.');
        props[match[1]!] = decode(v); attributes = attributes.slice(match[0].length);
      }
      const parent = stack.length ? stack[stack.length - 1]! : null;
      const id = stack.length && parent === null ? null : add(props, parent, stack.length);
      if (!tag[2]) stack.push(id);
    }
    if (!rootSeen || hierarchy || stack.length || consumed !== raw.length - start) throw new SessionError('Incomplete Android hierarchy.');
  } else {
    let raw = record(native) ? native.output ?? native : native;
    if (typeof raw === 'string') { const text = raw; try { raw = JSON.parse(text); } catch { raw = text.split('\n').filter(s => s.trim()).map(s => JSON.parse(s) as unknown); } }
    const walk = (value: unknown, parent: string | null = null, depth = 0): void => {
      if (Array.isArray(value)) { for (const child of value) walk(child, parent, depth); }
      else if (record(value)) { const { children, AXChildren, ...props } = value; const id = add(props, parent, depth); if (id) walk(children ?? AXChildren ?? [], id, depth + 1); }
    }; walk(raw);
  }
  return validateSnapshot({ snapshotId: randomUUID(), capturedAt: Date.now() / 1000, source: system === 'android' ? 'android-uiautomator' : 'ios-accessibility',
    coordinateSpace: system === 'android' ? 'screen-pixels' : 'screen-points', nodes, truncated,
    coverage: 'Native accessibility only; custom-rendered or inaccessible controls may be absent.' });
}
/** Private immutable observations with a suspend-aware elapsed clock (15 seconds).
 * Linux /proc/uptime includes suspend; other hosts must inject a suspend-aware clock.
 */
export class Inspections {
  #records = new Map<string, { value: AccessibilitySnapshot; stamp: number }>();
  #clock: () => number;
  constructor(clock?: () => number) {
    this.#clock = clock ?? (() => {
      if (process.platform !== 'linux') throw new SessionError('Inject a suspend-aware accessibility clock on this platform.', 'capability_unsupported', undefined, false);
      const now = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]); if (!Number.isFinite(now)) throw new SessionError('Elapsed clock unavailable.'); return now;
    });
  }
  save(machine: string, value: AccessibilitySnapshot, started = this.#clock()): AccessibilitySnapshot {
    const now = this.#clock(); for (const [key, entry] of this.#records) if (now < entry.stamp || now - entry.stamp >= 15) this.#records.delete(key);
    const { frame: _frame, ...observation } = value;
    this.#records.set(machine + ':' + value.snapshotId, { value: structuredClone(validateSnapshot(observation)), stamp: started }); return value;
  }
  get(machine: string, snapshotId: string): AccessibilitySnapshot {
    const key = machine + ':' + snapshotId, entry = this.#records.get(key), now = this.#clock();
    if (!entry || now < entry.stamp || now - entry.stamp >= 15) { this.#records.delete(key); throw new SessionError('Accessibility target is stale. Inspect again.', 'input_rejected', undefined, false); }
    return structuredClone(entry.value);
  }
  discard(machine: string, snapshotId: string): void { this.#records.delete(machine + ':' + snapshotId); }
  actionContext(machine: string, snapshotId: string) { const value = this.get(machine, snapshotId), stamp = this.#records.get(machine + ':' + snapshotId)!.stamp; return { value, context: { startedAt: stamp, expiresAt: stamp + 15 } }; }
  static lineage(value: AccessibilitySnapshot, nodeId: string): AccessibilityNode[] {
    validateSnapshot(value); const nodes = new Map(value.nodes.map(n => [n.id, n])), chain: AccessibilityNode[] = []; let id: string | null = nodeId;
    while (id !== null) { const node = nodes.get(id); if (!node || chain.includes(node)) throw new SessionError('Accessibility parent context is unavailable.'); chain.push(node); id = node.parentId; } return chain;
  }
  target(machine: string, args: { snapshotId: string; nodeId: string }, current: AccessibilitySnapshot): { x: number; y: number } {
    const old = this.get(machine, args.snapshotId), chain = Inspections.lineage(old, args.nodeId), node = chain[0]!;
    if (!node.actions.includes('click') || old.source !== current.source || old.coordinateSpace !== current.coordinateSpace || !isDeepStrictEqual(chain, Inspections.lineage(current, args.nodeId)) || !node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) throw new SessionError('Accessibility target changed or has no usable bounds.', 'input_rejected', undefined, false);
    const rounded = (n: number) => { const lower = Math.floor(n); return n - lower === 0.5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(n); };
    return { x: rounded(node.bounds.x + node.bounds.width / 2), y: rounded(node.bounds.y + node.bounds.height / 2) };
  }
}

export interface InspectionBackend {
  readonly inspectionSystems: ReadonlySet<string>;
  inspect(machine: Record<string, unknown>, image: Record<string, unknown>, folder: unknown, includeFrame: boolean): Promise<AccessibilitySnapshot> | AccessibilitySnapshot;
}
export interface InspectionProvider {
  access?: InspectionBackend;
  inspections?: Inspections;
  control(machine: Record<string, unknown>, image: Record<string, unknown>, folder: unknown, request: Record<string, unknown>): Promise<unknown> | unknown;
}
const providerLocks = new WeakMap<InspectionProvider, import('./sdk.ts').Serial>();
export function nativeInspector(provider: InspectionProvider, image: Record<string, unknown>): InspectionBackend | undefined {
  const backend = provider.access;
  return backend && typeof backend.inspect === 'function' && backend.inspectionSystems.has(String(image.os)) ? backend : undefined;
}
export function inspectionSupported(provider: InspectionProvider, image: Record<string, unknown>): boolean {
  return ['linux', 'android', 'ios'].includes(String(image.os)) || nativeInspector(provider, image) !== undefined;
}
/** Provider dispatch is injected. This function never constructs a production native binding.
 * Non-Linux providers must supply a suspend-aware clock for semantic-action freshness.
 */
export async function inspectProvider(provider: InspectionProvider, machine: Record<string, unknown>, image: Record<string, unknown>, folder: unknown, includeFrame = false, clock?: () => number): Promise<AccessibilitySnapshot> {
  if (image.mode === 'headless') throw new SessionError('A headless guest has no native graphical accessibility service.', 'capability_unsupported', undefined, false);
  // Dynamic import avoids initializing the SDK through the accessibility import cycle.
  const { Serial } = await import('./sdk.ts');
  let lock = providerLocks.get(provider); if (!lock) { lock = new Serial(); providerLocks.set(provider, lock); }
  return lock.run(async () => {
    const backend = nativeInspector(provider, image);
    if (backend) return backend.inspect(machine, image, folder, includeFrame);
    if (image.os === 'linux') return await provider.control(machine, image, folder, { action: 'accessibility', arguments: { includeFrame } }) as AccessibilitySnapshot;
    if (image.os !== 'android' && image.os !== 'ios') throw new SessionError('Native inspection backend is unavailable.', 'capability_unsupported', undefined, false);
    const cache = provider.inspections ??= new Inspections(clock);
    if (!clock && process.platform !== 'linux') throw new SessionError('A suspend-aware inspection clock is required.', 'capability_unsupported', undefined, false);
    const elapsed = clock ?? (() => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]));
    const started = elapsed(), requestId = randomUUID();
    const value = snapshot(image.os, await provider.control(machine, image, folder, { id: requestId, action: 'hierarchy', arguments: {} }));
    if (includeFrame) value.frame = await provider.control(machine, image, folder, { id: requestId, action: 'screenshot', arguments: {} });
    return cache.save(String(machine.id), value, started);
  });
}
