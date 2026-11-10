import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ServiceError, object } from "../errors.ts";
import { assignmentFingerprint, command, legacyDigest, list, present, readRecord, safePath, saveRecord, string, uuid, verifyAssignment } from "./apple.ts";
import type { Data } from "./apple.ts";

const MACHINE = "canaveral.io/machine";
const CREATION = "canaveral.io/creation-id";
const ASSIGNMENT = "canaveral.io/assignment";
const VERSION = "kubevirt.io/v1";
function dict(value: unknown): Data { return value === undefined ? {} : object(value); }
function meta(value: Data): Data { return object(value.metadata); }
function labels(value: Data): Data { return dict(meta(value).labels); }
function annotations(value: Data): Data { return dict(meta(value).annotations); }
function validName(value: unknown): string { const name = string(value); if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) throw new ServiceError("KubeVirt requires valid namespace and PVC names."); return name; }
function desired(machine: Data): string { if (machine.desired !== "running" && machine.desired !== "stopped") throw new ServiceError("Invalid desired state.", 400); return machine.desired; }
export function manifest(machine: Data, image: Data, namespace: string): Data {
  const id = uuid(machine.id); validName(namespace); validName(image.pvc); const size = object(machine.resources);
  for (const key of ["cpu", "memoryMiB", "diskGiB"]) if (!Number.isSafeInteger(size[key]) || Number(size[key]) <= 0) throw new ServiceError("Invalid KubeVirt resources.", 400);
  if (!["linux", "windows"].includes(string(image.os)) || !["amd64", "arm64"].includes(string(image.arch))) throw new ServiceError("Unsupported KubeVirt template.");
  const name = `cvm-${id}`; const identity = id.replaceAll("-", "").slice(0, 10);
  const disks: Data[] = [{ name: "root", disk: { bus: image.os === "windows" ? "sata" : "virtio" } }];
  const devices: Data = { disks, interfaces: [{ name: "default", masquerade: {}, macAddress: `02:${identity.match(/../g)!.join(":")}` }], autoattachGraphicsDevice: image.mode === "desktop" };
  const domain: Data = { cpu: { cores: size.cpu }, resources: { requests: { cpu: String(size.cpu), memory: `${size.memoryMiB}Mi` } }, devices };
  if (image.os === "windows") { domain.firmware = { bootloader: { efi: { secureBoot: true } } }; domain.features = { smm: { enabled: true } }; devices.tpm = { persistent: true }; }
  const storage: Data = { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${size.diskGiB}Gi` } } };
  if (image.storageClass) storage.storageClassName = string(image.storageClass);
  const volumes: Data[] = [{ name: "root", dataVolume: { name } }];
  if (image._userData) {
    disks.push({ name: "preparation", disk: { bus: image.os === "windows" ? "sata" : "virtio" } });
    const kind = dict(image.prepare).driver === "cloudbase-init" ? "cloudInitConfigDrive" : "cloudInitNoCloud";
    volumes.push({ name: "preparation", [kind]: { secretRef: { name: `${name}-preparation` } } });
  }
  return { apiVersion: VERSION, kind: "VirtualMachine", metadata: { name, namespace, labels: { [MACHINE]: id } }, spec: {
    runStrategy: desired(machine) === "running" ? "Always" : "Halted",
    dataVolumeTemplates: [{ metadata: { name }, spec: { source: { pvc: { namespace, name: image.pvc } }, storage } }],
    template: { metadata: { labels: { [MACHINE]: id } }, spec: { architecture: image.arch, domain, networks: [{ name: "default", pod: {} }], volumes } },
  } };
}
export function ownershipBinding(machine: Data, namespace: string): Data { return { version: 1, machineId: uuid(machine.id), namespace, name: `cvm-${uuid(machine.id)}`, leaseId: machine.lease ? uuid(object(machine.lease).id) : null, fingerprint: assignmentFingerprint(machine) }; }
export function creationAnnotations(identity: Data): Data { return { [CREATION]: identity.creationId, [ASSIGNMENT]: identity.fingerprint }; }
function checked(machine: Data, namespace: string, value: Data, owner = false): Data {
  const expected = ownershipBinding(machine, namespace); const keys = [...Object.keys(expected), "creationId", ...(owner ? ["uid"] : [])].sort();
  if (Object.keys(value).sort().join() !== keys.join() || Object.keys(expected).some(key => value[key] !== expected[key])) throw new ServiceError("KubeVirt ownership receipt differs from its assignment.");
  uuid(value.creationId); if (owner && (typeof value.uid !== "string" || value.uid.length < 1 || value.uid.length > 128)) throw new ServiceError("KubeVirt object UID is unavailable."); return value;
}
export function matchesVM(vm: Data, identity: Data): boolean {
  try { const m = meta(vm); const a = annotations(vm); return vm.kind === "VirtualMachine" && vm.apiVersion === VERSION && m.namespace === identity.namespace && m.name === identity.name && labels(vm)[MACHINE] === identity.machineId && a[CREATION] === identity.creationId && a[ASSIGNMENT] === identity.fingerprint && typeof m.uid === "string" && m.uid.length > 0 && m.uid.length <= 128 && (identity.uid === undefined || m.uid === identity.uid); } catch { return false; }
}
export function ensureUncreated(folder: string): void { safePath(folder); for (const file of ["kubevirt-create.json", "kubevirt-owner.json"]) if (present(join(folder, file))) throw new ServiceError("KubeVirt creation outcome requires inspection; automatic recreation is blocked."); }
export function beginCreation(machine: Data, namespace: string, folder: string): Data {
  ensureUncreated(folder); const identity = { ...ownershipBinding(machine, namespace), creationId: randomUUID() }; saveRecord(join(folder, "kubevirt-create.json"), identity, true); return identity;
}
export function rememberCreation(machine: Data, namespace: string, folder: string, vm: Data): Data {
  safePath(folder); const pending = checked(machine, namespace, readRecord(join(folder, "kubevirt-create.json")));
  if (!matchesVM(vm, pending)) throw new ServiceError("KubeVirt object differs from its recorded creation.");
  const owner = { ...pending, uid: meta(vm).uid }; const path = join(folder, "kubevirt-owner.json");
  if (present(path)) { if (legacyDigest(checked(machine, namespace, readRecord(path), true)) !== legacyDigest(owner)) throw new ServiceError("KubeVirt object UID changed; refusing another incarnation."); }
  else saveRecord(path, owner, true);
  return owner;
}
export function verifyExisting(machine: Data, namespace: string, folder: string, vm: Data): Data | null {
  safePath(folder); if (present(join(folder, "kubevirt-owner.json"))) { const owner = checked(machine, namespace, readRecord(join(folder, "kubevirt-owner.json")), true); if (!matchesVM(vm, owner)) throw new ServiceError("KubeVirt object differs from its saved ownership."); return owner; }
  if (present(join(folder, "kubevirt-create.json"))) return rememberCreation(machine, namespace, folder, vm);
  return null; // Legacy labels may be observed, but never authorize a new mutation.
}
export function loadOwnership(machine: Data, namespace: string, folder: string): Data { const identity = checked(machine, namespace, readRecord(join(safePath(folder), "kubevirt-owner.json")), true); verifyAssignment(machine, folder); return identity; }
export function assignmentKey(assignments: Data[]): string { return legacyDigest(assignments.map(m => ({ id: m.id, template: m.template ?? null, resources: m.resources ?? null, leaseId: m.lease ? object(m.lease).id : null, desired: m.desired ?? null, observed: m.observed ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id)))); }

export class KubevirtProvider {
  readonly kind = "kubevirt";
  constructor(readonly config: Data, readonly state: string) {}
  name(machine: Data): string { return `cvm-${uuid(machine.id)}`; }
  async kubectl(args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
    const base = ["kubectl"]; if (this.config.context) base.push("--context", string(this.config.context));
    return command(this.config, [...base, "--cache-dir", join(this.state, "kubectl-cache"), "--namespace", validName(this.config.namespace), ...args], options);
  }
  async check(): Promise<unknown> {
    validName(this.config.namespace); for (const value of list(this.config.templates)) { const image = object(value); if (image.os === "macos") throw new ServiceError("macOS guests must run on Apple hosts."); await this.kubectl(["get", "pvc", validName(image.pvc), "-o", "name"]); }
    return this.kubectl(["get", "virtualmachines.kubevirt.io", "-o", "name"]);
  }
  async reconcile(machine: Data, image: Data, folder: string): Promise<Data> {
    safePath(folder); desired(machine); if (present(join(folder, "deletion.json"))) throw new ServiceError("Deletion intent blocks KubeVirt reconciliation.");
    const namespace = validName(this.config.namespace); const name = this.name(machine);
    const raw = await this.kubectl(["get", "virtualmachine", name, "--ignore-not-found", "-o", "json"]);
    if (!raw) {
      if (machine.desired === "stopped") {
        if (present(join(folder, "kubevirt-create.json")) && !present(join(folder, "kubevirt-owner.json"))) return { state: "unknown", detail: "KubeVirt creation outcome is unconfirmed; inspect its recorded request." };
        const instance = await this.kubectl(["get", "virtualmachineinstance", name, "--ignore-not-found", "-o", "json"]); return { state: instance ? "unknown" : "stopped" };
      }
      if (machine.lease) throw new ServiceError("Production KubeVirt leased creation is disabled pending independent native fencing.", 503);
      ensureUncreated(folder); const value = manifest(machine, image, namespace);
      // Save before any Secret or VM mutation; lost replies never replay preparation.
      const identity = beginCreation(machine, namespace, folder); meta(value).annotations = creationAnnotations(identity);
      if (image._userData) {
        const secretName = `${name}-preparation`; const existing = await this.kubectl(["get", "secret", secretName, "--ignore-not-found", "-o", "json"]);
        const payload: Data = { apiVersion: "v1", kind: "Secret", metadata: { name: secretName, namespace, labels: { [MACHINE]: machine.id }, annotations: creationAnnotations(identity) }, type: "Opaque", data: { userdata: Buffer.from(string(image._userData)).toString("base64") } };
        if (existing) {
          const previous = object(JSON.parse(existing)); if (labels(previous)[MACHINE] !== machine.id || legacyDigest(previous.data) !== legacyDigest(payload.data) || annotations(previous)[CREATION] !== identity.creationId) throw new ServiceError("Existing preparation Secret has different ownership/content.");
        } else await this.kubectl(["create", "-f", "-"], { input: JSON.stringify(payload) });
      }
      const created = await this.kubectl(["create", "-f", "-", "-o", "json"], { input: JSON.stringify(value) }); rememberCreation(machine, namespace, folder, object(JSON.parse(created)));
      return { state: "starting", detail: "Cloning the template PVC and starting the guest." };
    }
    const vm = object(JSON.parse(raw)); if (labels(vm)[MACHINE] !== machine.id) throw new ServiceError("Existing Kubernetes VM is not owned by this assignment.");
    const owner = verifyExisting(machine, namespace, folder, vm); const strategy = machine.desired === "running" ? "Always" : "Halted";
    if (object(vm.spec).runStrategy !== strategy) {
      if (!owner) throw new ServiceError("Legacy labels cannot authorize lifecycle changes without a pinned ownership receipt.");
      if (machine.lease && strategy === "Always") throw new ServiceError("Leased restart is disabled pending independent KubeVirt fencing.", 503);
      // JSON Patch tests make a concurrent same-name replacement fail atomically.
      await this.kubectl(["patch", "virtualmachine", name, "--type=json", "-p", JSON.stringify([{ op: "test", path: "/metadata/uid", value: owner.uid }, { op: "test", path: "/metadata/annotations/canaveral.io~1creation-id", value: owner.creationId }, { op: "test", path: "/metadata/annotations/canaveral.io~1assignment", value: owner.fingerprint }, { op: "add", path: "/spec/runStrategy", value: strategy }])]);
    }
    const instance = await this.kubectl(["get", "virtualmachineinstance", name, "--ignore-not-found", "-o", "json"]);
    if (instance && owner) { const vmi = object(JSON.parse(instance)); const ref = controller(vmi); if (meta(vmi).namespace !== namespace || meta(vmi).name !== name || !ref || ref.uid !== owner.uid || ref.name !== name || ref.kind !== "VirtualMachine" || ref.apiVersion !== VERSION) throw new ServiceError("VMI differs from the owned VM incarnation."); }
    if (machine.desired === "stopped") return { state: instance ? "stopping" : "stopped" };
    const phase = instance ? dict(object(JSON.parse(instance)).status).phase : null;
    return { state: phase === "Running" ? "running" : phase === "Failed" ? "error" : "starting", detail: `Use virtctl console/vnc ${name} -n ${namespace}` };
  }
  async resourceReport(assignments?: Data[]): Promise<Data> { return collectResources(this, assignments); }
}

function controller(value: Data): Data | null { const refs = (meta(value).ownerReferences === undefined ? [] : list(meta(value).ownerReferences)).map(object).filter(r => r.controller === true); return refs.length === 1 ? refs[0]! : null; }
function selectedMetadata(value: Data): Data { const m = meta(value); return Object.fromEntries(["name", "namespace", "uid", "creationTimestamp", "labels", "annotations", "ownerReferences"].filter(k => k in m).map(k => [k, m[k]])); }
function index(values: Data[], namespace: string): Map<string, Data> {
  const names = new Map<string, Data>(); const uids = new Set<string>();
  for (const value of values) { const m = meta(value); const name = string(m.name); const uid = string(m.uid); if (m.namespace !== namespace || names.has(name) || uids.has(uid)) throw new ServiceError("Cluster object identity is ambiguous."); names.set(name, value); uids.add(uid); }
  return names;
}
export function ownershipSnapshot(provider: KubevirtProvider, assignments: Data[], pods: Data[], vms: Data[], vmis: Data[]): { snapshot: Data; selected: Data[] } {
  const namespace = string(provider.config.namespace); const machines = new Map<string, Data>(); const proofs: Data = {}; const vmState: Data = {};
  for (const machine of assignments) { const id = uuid(machine.id); if (machines.has(id)) throw new ServiceError("Duplicate assigned cluster machine."); machines.set(id, machine); proofs[id] = loadOwnership(machine, namespace, join(provider.state, "machines", id)); }
  const vmIndex = index(vms, namespace); const vmiIndex = index(vmis, namespace); const podIndex = index(pods, namespace);
  const assignedNames = new Map(Object.entries(proofs).map(([id, proof]) => [string(object(proof).name), id]));
  for (const [id, proofValue] of Object.entries(proofs)) { const proof = object(proofValue); const vm = vmIndex.get(string(proof.name));
    if (!vm) { if (machines.get(id)!.observed !== "stopped") throw new ServiceError("Assigned VM is absent without a stopped observation."); vmState[id] = null; }
    else { if (!matchesVM(vm, proof)) throw new ServiceError("Assigned VM incarnation differs from saved ownership."); vmState[id] = selectedMetadata(vm); }
  }
  const vmiOwners = new Map<string, [string, string]>(); const vmiState: Data = {};
  for (const [name, vmi] of vmiIndex) { const ref = controller(vmi); const label = labels(vmi)[MACHINE]; const id = assignedNames.get(name);
    if (!id) { if (machines.has(String(label))) throw new ServiceError("VMI label contradicts the assigned VM name."); continue; }
    const proof = object(proofs[id]); if (!vmState[id] || !ref || ref.kind !== "VirtualMachine" || ref.apiVersion !== VERSION || ref.uid !== proof.uid || ref.name !== proof.name || label != null && label !== id) throw new ServiceError("VMI does not reference the pinned VM UID.");
    const uid = string(meta(vmi).uid); vmiOwners.set(uid, [id, name]); vmiState[uid] = { metadata: selectedMetadata(vmi), phase: dict(vmi.status).phase ?? null };
  }
  const podUids = new Map(pods.map(p => [string(meta(p).uid), p])); const resolved = new Map<string, string | null>();
  function owner(pod: Data, trail = new Set<string>()): string | null {
    const uid = string(meta(pod).uid); if (resolved.has(uid)) return resolved.get(uid)!; if (trail.has(uid)) throw new ServiceError("Pod ownership cycle is ambiguous.");
    const ref = controller(pod); let id: string | null = null; const label = labels(pod)[MACHINE];
    if (ref?.kind === "VirtualMachineInstance" && ref.apiVersion === VERSION) { const match = vmiOwners.get(String(ref.uid)); if (match) { if (ref.name !== match[1]) throw new ServiceError("Pod VMI name differs from its UID."); id = match[0]; } else if (assignedNames.has(String(ref.name))) throw new ServiceError("Pod references an unverified VMI incarnation."); }
    else if (ref?.kind === "Pod" && ref.apiVersion === "v1") { const parent = podUids.get(String(ref.uid)); if (parent) { if (ref.name !== meta(parent).name) throw new ServiceError("Pod owner name differs from its UID."); id = owner(parent, new Set([...trail, uid])); } else if (Object.values(annotations(pod)).some(v => typeof v === "string" && vmiOwners.has(v))) throw new ServiceError("Owned support pod has no verified parent."); }
    if (machines.has(String(label)) && id !== label) throw new ServiceError("Pod label alone does not establish assigned ownership."); resolved.set(uid, id); return id;
  }
  const selected: Data[] = []; const podState: Data = {}; const running = new Map([...vmiOwners.keys()].map(uid => [uid, 0]));
  for (const [name, pod] of podIndex) {
    const id = owner(pod); if (!id) continue;
    const containers = list(object(pod.spec).containers).map(v => string(object(v).name)).sort(); const extras = runningExtras(pod).sort(); const phase = dict(pod.status).phase ?? null;
    podState[name] = { metadata: selectedMetadata(pod), containers, runningExtras: extras, phase }; selected.push(pod);
    if (phase !== "Succeeded" && phase !== "Failed") { const ref = controller(pod); if (ref && running.has(String(ref.uid))) running.set(String(ref.uid), running.get(String(ref.uid))! + 1); }
  }
  for (const [uid, value] of Object.entries(vmiState)) if (["Running", "Scheduled"].includes(String(object(value).phase)) && !running.get(uid)) throw new ServiceError("Active VMI has no verified active launcher pod.");
  return { snapshot: { proofs, vms: vmState, vmis: vmiState, pods: podState }, selected };
}
function runningExtras(pod: Data): string[] { const result: string[] = []; for (const key of ["initContainerStatuses", "ephemeralContainerStatuses"]) for (const c of dict(pod.status)[key] === undefined ? [] : list(dict(pod.status)[key])) if ("running" in dict(object(c).state)) result.push(string(object(c).name)); return result; }
function unavailableMetrics(): Data { return { status: "unavailable", coverage: { status: "unavailable" } }; }
export function unavailableOwnership(): Data { return { scope: "assigned-vm-pods", ownership: { status: "unavailable" }, metrics: unavailableMetrics() }; }
function numeric(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
export function quantity(value: unknown): number | null {
  const match = /^([+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)([numkKMGTEP]|[KMGTPE]i)?$/.exec(String(value)); if (!match) return null;
  const suffix = match[2] ?? ""; let scale = ({ "": 1, n: 1e-9, u: 1e-6, m: .001, k: 1000, K: 1000 } as Record<string, number>)[suffix];
  if (scale === undefined) scale = suffix.endsWith("i") ? 1024 ** ("KMGTPE".indexOf(suffix[0]!) + 1) : 1000 ** ("MGTPE".indexOf(suffix) + 2);
  const amount = Number(match[1]) * scale; return numeric(amount) ? amount : null;
}
export function duration(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value)) return null;
  const units: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: .001, s: 1, m: 60, h: 3600 };
  const amount = [...value.matchAll(/([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)/g)].reduce((n, m) => n + Number(m[1]) * units[m[2]!]!, 0); return numeric(amount) ? amount : null;
}
function timestamp(value: unknown): number { if (typeof value !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new ServiceError("Missing qualified metrics timestamp."); const t = Date.parse(value) / 1000; if (!Number.isFinite(t)) throw new ServiceError("Malformed metrics timestamp."); return t; }
export function podUsage(namespace: string, now: number, inventory: Data[] | null, metrics: Data[] | null, strict = false): Data {
  try {
    if (!inventory) return unavailableMetrics(); const active = new Map<string, { names: Set<string>; created: number; uid: unknown }>();
    for (const pod of inventory) { if (["Succeeded", "Failed"].includes(String(dict(pod.status).phase))) continue;
      const name = string(meta(pod).name); if (meta(pod).namespace !== namespace || active.has(name)) throw new ServiceError("Duplicate pod identity.");
      const names = list(object(pod.spec).containers).map(v => string(object(v).name)); if (!names.length || new Set(names).size !== names.length) throw new ServiceError("Invalid container inventory.");
      active.set(name, { names: new Set([...names, ...runningExtras(pod)]), created: timestamp(meta(pod).creationTimestamp), uid: meta(pod).uid });
    }
    const measured = new Map<string, [number, number, number]>(); let metricsOk = false;
    try {
      if (!metrics) throw new ServiceError("Missing Metrics API."); const seen = new Set<string>();
      for (const pod of metrics) { const name = string(meta(pod).name); if (seen.has(name)) throw new ServiceError("Duplicate metrics identity."); seen.add(name); const expected = active.get(name); if (!expected) continue;
        if (meta(pod).namespace !== namespace) throw new ServiceError("Different namespace."); const sampled = timestamp(pod.timestamp);
        if (sampled < expected.created || sampled < now - 120 || sampled > now + 5) continue;
        if (strict) { const window = duration(pod.window); if ((meta(pod).uid ?? expected.uid) !== expected.uid || window === null || window <= 0 || window > 120 || sampled - window < expected.created) continue; }
        const containers = list(pod.containers).map(object); const names = containers.map(c => string(c.name)); if (new Set(names).size !== names.length || [...expected.names].some(n => !names.includes(n))) continue;
        let cpu = 0; let memory = 0; for (const c of containers) { const usage = object(c.usage); const cores = quantity(usage.cpu); const bytes = quantity(usage.memory); if (cores === null || bytes === null) throw new ServiceError("Unknown resource quantity."); cpu += cores; memory += bytes / 1048576; }
        if (!numeric(cpu) || !numeric(memory)) throw new ServiceError("Unbounded metrics aggregate."); measured.set(name, [cpu, memory, sampled]);
      }
      metricsOk = true;
    } catch { measured.clear(); }
    const coverage = { status: metricsOk ? measured.size === active.size ? "complete" : "incomplete" : "unavailable", activePods: active.size, measuredPods: measured.size };
    if (coverage.status !== "complete") return { status: "unavailable", coverage };
    let cpu = 0; let memory = 0; let sampledAt = measured.size ? Infinity : now; for (const [cores, mib, sampled] of measured.values()) { cpu += cores; memory += mib; sampledAt = Math.min(sampledAt, sampled); }
    if (!numeric(cpu) || !numeric(memory)) return unavailableMetrics();
    return { status: "available", cpuCores: Number(cpu.toFixed(6)), memoryMiB: Number(memory.toFixed(2)), podCount: measured.size, sampledAt, coverage };
  } catch { return unavailableMetrics(); }
}
async function items(provider: KubevirtProvider, resource: string): Promise<Data[]> { const value = object(JSON.parse(await provider.kubectl(["get", resource, "-o", "json"], { timeoutMs: 5000 }))); if (dict(value.metadata).continue) throw new ServiceError("Cluster inventory is incomplete."); return list(value.items).map(object); }
export async function collectResources(provider: KubevirtProvider, assignments?: Data[]): Promise<Data> {
  const namespace = validName(provider.config.namespace); const now = typeof provider.config.now === "function" ? Number(provider.config.now()) : Date.now() / 1000;
  const result: Data = { namespace, sampledAt: now, metrics: unavailableMetrics(), quotas: { status: "unavailable", items: [] }, canaveral: unavailableOwnership() };
  let pods: Data[] | null = null; let measurements: Data[] | null = null;
  try { pods = await items(provider, "pods"); } catch { /* Missing inventory stays unknown. */ }
  try { const value = object(JSON.parse(await provider.kubectl(["get", "--raw", `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`], { timeoutMs: 5000 }))); if (dict(value.metadata).continue) throw new ServiceError("Incomplete metrics inventory."); measurements = list(value.items).map(object); } catch { /* Missing Metrics API never means zero. */ }
  result.metrics = podUsage(namespace, now, pods, measurements);
  if (assignments && pods) {
    const assignmentsBefore = assignmentKey(assignments);
    try {
      const before = ownershipSnapshot(provider, assignments, pods, await items(provider, "virtualmachines.kubevirt.io"), await items(provider, "virtualmachineinstances.kubevirt.io"));
      const selectedNames = new Set(before.selected.map(p => meta(p).name)); const selectedMetrics = measurements?.filter(p => selectedNames.has(meta(p).name)) ?? null;
      const observed = podUsage(namespace, now, before.selected, selectedMetrics, true);
      const after = ownershipSnapshot(provider, assignments, await items(provider, "pods"), await items(provider, "virtualmachines.kubevirt.io"), await items(provider, "virtualmachineinstances.kubevirt.io"));
      if (legacyDigest(before.snapshot) !== legacyDigest(after.snapshot) || assignmentsBefore !== assignmentKey(assignments)) throw new ServiceError("Owned inventory changed during measurement.");
      result.canaveral = { scope: "assigned-vm-pods", ownership: { status: "complete", assignedMachines: assignments.length, verifiedMachines: assignments.length }, metrics: observed };
    } catch { /* Never publish a partial owned total. */ }
  }
  try {
    const values = await items(provider, "resourcequotas"); const allowed = new Set(["requests.cpu", "limits.cpu", "requests.memory", "limits.memory", "requests.storage", "persistentvolumeclaims"]);
    const quotas = values.slice(0, 50).map(item => { const quota: Data = { name: string(meta(item).name), hard: {}, used: {} }; for (const section of ["hard", "used"]) for (const [key, value] of Object.entries(dict(dict(item.status)[section]))) { if (!allowed.has(key)) continue; const amount = quantity(value); if (amount !== null) object(quota[section])[key] = Number((amount / (key.includes("memory") ? 1048576 : key.includes("storage") ? 1073741824 : 1)).toFixed(6)); } return quota; });
    result.quotas = { status: "available", items: quotas, truncated: values.length > 50 };
  } catch { /* Namespace quotas remain separate from owned workloads. */ }
  return result;
}

export function validateMetrics(value: unknown): boolean {
  try {
    const m = object(value); if (m.status !== "available" && m.status !== "unavailable") return false;
    const allowed = new Set(["status", "cpuCores", "memoryMiB", "podCount", "sampledAt", "coverage"]);
    if (Object.keys(m).some(k => !allowed.has(k) || k !== "status" && k !== "coverage" && (typeof m[k] !== "number" || !numeric(m[k] as number)))) return false;
    if (m.status === "available" && ["cpuCores", "memoryMiB", "podCount"].some(k => !(k in m))) return false;
    if (m.coverage !== undefined) {
      const c = object(m.coverage); if (!["complete", "incomplete", "unavailable"].includes(String(c.status))) return false;
      if (Object.keys(c).some(k => !["status", "activePods", "measuredPods"].includes(k))) return false;
      if (Object.keys(c).length === 1) { if (c.status !== "unavailable") return false; }
      else {
        if (Object.keys(c).length !== 3 || !Number.isSafeInteger(c.activePods) || !Number.isSafeInteger(c.measuredPods) || Number(c.measuredPods) < 0 || Number(c.activePods) < Number(c.measuredPods)) return false;
        if (c.status === "complete" && c.activePods !== c.measuredPods || c.status === "incomplete" && c.activePods === c.measuredPods) return false;
      }
      if (m.status === "available" && (c.status !== "complete" || m.podCount !== c.measuredPods)) return false;
    }
    return true;
  } catch { return false; }
}
export function validateClusterReport(value: unknown): boolean {
  try {
    const r = object(value); validName(r.namespace); if (typeof r.sampledAt !== "number" || !numeric(r.sampledAt) || !validateMetrics(r.metrics) || Object.keys(r).some(k => !["namespace", "sampledAt", "metrics", "quotas", "canaveral"].includes(k))) return false;
    if (r.canaveral !== undefined) {
      const c = object(r.canaveral); const ownership = object(c.ownership);
      if (Object.keys(c).sort().join() !== "metrics,ownership,scope" || c.scope !== "assigned-vm-pods" || !validateMetrics(c.metrics) || !object(c.metrics).coverage) return false;
      if (ownership.status === "unavailable") { if (Object.keys(ownership).length !== 1 || legacyDigest(c.metrics) !== legacyDigest(unavailableMetrics())) return false; }
      else if (ownership.status === "complete") {
        if (Object.keys(ownership).sort().join() !== "assignedMachines,status,verifiedMachines" || !Number.isSafeInteger(ownership.assignedMachines) || Number(ownership.assignedMachines) < 0 || ownership.assignedMachines !== ownership.verifiedMachines) return false;
      } else return false;
      if (object(c.metrics).status === "available" && !("sampledAt" in object(c.metrics))) return false;
    }
    const q = object(r.quotas); if (!["available", "unavailable"].includes(String(q.status)) || Object.keys(q).some(k => !["status", "items", "truncated"].includes(k)) || list(q.items).length > 50) return false;
    const keys = new Set(["requests.cpu", "limits.cpu", "requests.memory", "limits.memory", "requests.storage", "persistentvolumeclaims"]);
    for (const value of list(q.items)) {
      const quota = object(value); if (Object.keys(quota).sort().join() !== "hard,name,used" || typeof quota.name !== "string" || quota.name.length > 253) return false;
      for (const section of ["hard", "used"]) for (const [key, amount] of Object.entries(object(quota[section]))) if (!keys.has(key) || typeof amount !== "number" || !numeric(amount)) return false;
    }
    return true;
  } catch { return false; }
}
