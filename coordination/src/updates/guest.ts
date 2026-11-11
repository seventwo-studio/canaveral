/** Signed Linux cloud-init provisioning and owned-transport acknowledgement; never live replacement. */
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { noLinks, present, readRecord, saveRecord } from '../runtime-process.ts';
import type { HelperArtifact, GuestAccess } from '../guest/access.ts';
import { componentFileSetDigest, componentTargetKey, parseComponentReport, parseComponentTarget } from './components.ts';
import type { ComponentAdoptionDriver, ComponentAdoptionRequest, ComponentAdoptionReceipt, ComponentContext, ComponentTarget } from './components.ts';
import { verifyRelease } from './protocol.ts';
import type { SignedRelease, TrustedKeys } from './protocol.ts';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const GUEST_PROVISION_FILE = 'guest/bundle.json';
export const GUEST_PROVISION_BINDING = '/opt/canaveral/update/provision.json';
export interface SignedGuestPreparation {
  release: SignedRelease; trustedKeys: TrustedKeys; directory: string; context: ComponentContext;
  identity: { machineId: string; assignmentId: string; generation: number };
}
interface Provision { context: ComponentContext; machineId: string; assignmentId: string; generation: number; fileSetDigest: string; bundleHash: string }
function artifacts(bytes: Buffer): HelperArtifact[] {
  const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(values) || !values.length || values.length > 4096) throw new Error('Invalid guest bundle');
  const seen = new Set<string>();
  const result = values.map((v): HelperArtifact => {
    if (!v || Object.keys(v).sort().join() !== 'content,mode,path' || typeof v.path !== 'string' || !/^\/opt\/canaveral\/(?:server\.mjs|install\.mjs|modules\/[a-zA-Z0-9_./-]+\.mjs|payload\/[a-zA-Z0-9_.-]+\.b64|schemas\/(?:consumer-api\.openapi|session-control\.schema|accessibility-snapshot\.schema)\.json)$/.test(v.path) || v.path.split('/').some((p: string) => p === '.' || p === '..') || typeof v.content !== 'string' || !['0644', '0755'].includes(v.mode) || seen.has(v.path)) throw new Error('Unsupported guest bundle artifact');
    seen.add(v.path); return { path: v.path, content: v.content, mode: v.mode };
  });
  if (!seen.has('/opt/canaveral/server.mjs') || !seen.has('/opt/canaveral/install.mjs')) throw new Error('Incomplete Linux provisioning bundle');
  return result;
}
/** Call ONLY within the existing fresh/stopped cloud-init provisioning path, after durable host intent.
 * Supports the existing build_guest_bundle JSON format as one signed guest file; other layouts stay pending.
 * The stable token, launcher, trust configuration and mutable state are never supplied by the bundle.
 */
export function signedGuestProvision(release: SignedRelease, keys: TrustedKeys, directory: string, context: ComponentContext, identity: { machineId: string; assignmentId: string; generation: number }): HelperArtifact[] {
  const verified = verifyRelease(release, keys), digest = componentFileSetDigest(verified.manifest, 'guest');
  parseComponentReport({ ...context, fileSetDigest: digest, target: { component: 'guest', ...identity, bootId: context.attemptId }, sequence: 1, state: 'intent', evidence: null });
  if (context.releaseId !== verified.manifest.releaseId) throw new Error('Guest release binding differs');
  const subset = verified.manifest.files.filter(f => f.component === 'guest');
  if (subset.length !== 1 || subset[0]!.path !== GUEST_PROVISION_FILE || subset[0]!.executable) throw new Error('Unsupported signed Linux guest layout');
  const path = join(directory, GUEST_PROVISION_FILE); noLinks(path);
  const info = lstatSync(path), bytes = readFileSync(path), file = subset[0]!;
  if (!info.isFile() || info.nlink !== 1 || bytes.length > 128 * 1048576 || bytes.length !== file.bytes || hash(bytes) !== file.sha256 || (info.mode & 0o111)) throw new Error('Signed guest bundle differs');
  const files = artifacts(bytes), provision: Provision = { context, ...identity, fileSetDigest: digest, bundleHash: file.sha256 };
  return [...files, { path: '/opt/canaveral/update/bundle.json', mode: '0644', content: bytes.toString('utf8') }, { path: GUEST_PROVISION_BINDING, mode: '0644', content: JSON.stringify(provision) }];
}
export interface GuestAdoptionService { acknowledge(value: unknown, inspect: boolean): Promise<ComponentAdoptionReceipt | undefined>; admitted(): boolean }
/** Starts fenced. Only current provisioned bytes can be acknowledged; this service installs nothing. */
export function createGuestAdoptionService(root: string, bootId: string, idle: () => boolean): GuestAdoptionService | undefined {
  const binding = join(root, 'update/provision.json'); if (!present(binding)) return undefined;
  const p = readRecord(binding) as unknown as Provision;
  const target = parseComponentTarget({ component: 'guest', machineId: p.machineId, assignmentId: p.assignmentId, generation: p.generation, bootId });
  const receiptFile = join(root, 'state/update-adoption.json'); let admitted = false;
  const verify = () => {
    const bundlePath = join(root, 'update/bundle.json'); noLinks(bundlePath);
    const bytes = readFileSync(bundlePath); if (hash(bytes) !== p.bundleHash) throw new Error('Provisioned bundle changed');
    const expanded = artifacts(bytes);
    for (const f of expanded) {
      const path = join(root, f.path.slice('/opt/canaveral/'.length)); noLinks(path);
      const st = lstatSync(path), content = readFileSync(path);
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== parseInt(f.mode, 8) || !content.equals(Buffer.from(f.content))) throw new Error('Provisioned guest file changed');
    }
    // The existing installer decodes these fixed native helpers before service startup.
    for (const name of ['canaveral-mobile-native', 'canaveral-guest-agent']) {
      const parts = expanded.filter(f => f.path.startsWith('/opt/canaveral/payload/' + name + '.')).sort((a,b) => a.path.localeCompare(b.path));
      if (!parts.length) throw new Error('Missing native guest payload');
      const expected = Buffer.from(parts.map(f => f.content).join(''), 'base64');
      const path = join(root, 'bin', name); noLinks(path); const st = lstatSync(path);
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o755 || !readFileSync(path).equals(expected)) throw new Error('Installed native guest helper differs');
    }
  };
  // A completed same-boot receipt restores normal admission on service restart. An intent never does.
  if (present(receiptFile)) {
    const saved = readRecord(receiptFile);
    if (saved.receipt) {
      const r = parseComponentReport({ ...(saved.receipt as ComponentAdoptionReceipt), sequence: 1 });
      if (r.state === 'adopted' && componentTargetKey(r.target) === componentTargetKey(target) && r.fileSetDigest === p.fileSetDigest && Object.entries(p.context).every(([k,v]) => r[k as keyof ComponentContext] === v)) { verify(); admitted = true; }
    }
  }
  return { admitted: () => admitted, async acknowledge(value, inspect) {
    const report = parseComponentReport({ ...(value as ComponentAdoptionRequest), sequence: 1, state: 'intent', evidence: null });
    const { sequence: _s, state: _t, evidence: _e, ...request } = report;
    if (componentTargetKey(request.target) !== componentTargetKey(target) || request.fileSetDigest !== p.fileSetDigest || Object.entries(p.context).some(([k, v]) => request[k as keyof ComponentContext] !== v)) throw new Error('Guest adoption binding differs');
    if (present(receiptFile)) {
      const saved = readRecord(receiptFile);
      if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw new Error('Guest original attempt differs');
      if (!saved.receipt) return { ...request, state: 'unknown', evidence: null };
      verify(); return saved.receipt as unknown as ComponentAdoptionReceipt;
    }
    if (inspect) return undefined;
    if (admitted || !idle()) return { ...request, state: 'unknown', evidence: null };
    // Durable intent precedes any admission effect. Crash recovery only inspects this attempt.
    saveRecord(receiptFile, { request, receipt: null }); verify();
    const receipt: ComponentAdoptionReceipt = { ...request, state: 'adopted', evidence: { boundary: 'idle-closed', acknowledgement: hash(JSON.stringify(request)) } };
    saveRecord(receiptFile, { request, receipt }); admitted = true; return receipt;
  } };
}
export interface GuestUpdateTarget { target: Extract<ComponentTarget, { component: 'guest' }>; machine: Record<string, unknown>; image: Record<string, unknown>; folder: string }
/** Inventory must independently prove current assignment, boot and generation; absent proof means no target. */
export function createGuestAdoptionDriver(access: GuestAccess, inventory: () => Promise<readonly GuestUpdateTarget[]>): ComponentAdoptionDriver {
  const find = async (request: ComponentAdoptionRequest) => (await inventory()).find(v => componentTargetKey(v.target) === componentTargetKey(request.target));
  return {
    async targets() { return (await inventory()).filter(v => v.image.os === 'linux' && v.image.guestAccess === true).map(v => parseComponentTarget(v.target)); },
    async adopt(request) { const v = await find(request); if (!v) return { ...request, state: 'unknown', evidence: null }; return await access.adoption(v.machine, v.image, v.folder, request, false) ?? { ...request, state: 'unknown', evidence: null }; },
    async recover(request) { const v = await find(request); return v ? access.adoption(v.machine, v.image, v.folder, request, true) : undefined; },
  };
}
