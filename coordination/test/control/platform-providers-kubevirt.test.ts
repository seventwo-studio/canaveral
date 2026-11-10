import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assignmentFingerprint, readRecord, saveRecord } from "../../src/providers/apple.ts";
import type { Data } from "../../src/providers/apple.ts";
import { beginCreation, creationAnnotations, KubevirtProvider, loadOwnership, manifest, podUsage, quantity, rememberCreation, unavailableOwnership, validateClusterReport } from "../../src/providers/kubevirt.ts";
import { object } from "../../src/errors.ts";

const image: Data = { os: "linux", arch: "arm64", mode: "headless", pvc: "base" };
const now = Date.parse("2026-11-03T00:01:00Z") / 1000;
function machine(): Data { return { id: randomUUID(), name: "fixture", template: { id: "base", revision: "1" }, resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 }, desired: "running", observed: "running" }; }
function reference(kind: string, name: unknown, uid: unknown, apiVersion = "kubevirt.io/v1"): Data { return { kind, name, uid, apiVersion, controller: true }; }
function pod(name: string, ref?: Data): Data { return { metadata: { name, namespace: "guests", uid: randomUUID(), creationTimestamp: "2026-11-03T00:00:00Z", ...(ref ? { ownerReferences: [ref] } : {}) }, spec: { containers: [{ name: "guest" }] }, status: { phase: "Running" } }; }
function metric(name: string): Data { return { metadata: { name, namespace: "guests" }, timestamp: "2026-11-03T00:01:00Z", window: "30s", containers: [{ name: "guest", usage: { cpu: "100m", memory: "64Mi" } }] }; }
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "platform-kubevirt-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = machine(); const folder = join(root, "machines", String(m.id)); mkdirSync(folder, { recursive: true }); saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m) });
  const provider = new KubevirtProvider({ namespace: "guests", now: () => now }, root);
  const identity = beginCreation(m, "guests", folder); const vm = manifest(m, image, "guests"); Object.assign(object(vm.metadata), { uid: randomUUID(), annotations: creationAnnotations(identity) }); rememberCreation(m, "guests", folder, vm);
  const name = object(vm.metadata).name; const vmi: Data = { metadata: { namespace: "guests", name, uid: randomUUID(), ownerReferences: [reference("VirtualMachine", name, object(vm.metadata).uid)] }, status: { phase: "Running" } };
  const launcher = pod("launcher", reference("VirtualMachineInstance", name, object(vmi.metadata).uid)); const other = pod("unrelated");
  const inventory: Record<string, Data[]> = { pods: [launcher, other], "virtualmachines.kubevirt.io": [vm], "virtualmachineinstances.kubevirt.io": [vmi], resourcequotas: [] };
  let measurements = [metric("launcher"), metric("unrelated")]; let hook: ((args: string[]) => string | undefined) | undefined;
  provider.kubectl = async (args, options) => { assert.equal(options?.timeoutMs, 5000); const override = hook?.(args); if (override !== undefined) return override; if (args.includes("--raw")) return JSON.stringify({ items: measurements }); return JSON.stringify({ items: inventory[args[1]!] }); };
  return { root, m, folder, provider, vm, vmi, launcher, other, inventory, get measurements() { return measurements; }, set measurements(v: Data[]) { measurements = v; }, set hook(v: ((args: string[]) => string | undefined) | undefined) { hook = v; }, report: () => provider.resourceReport([m]) };
}

test("KubeVirt manifest clones disks, has stable MAC, Windows TPM and cloudbase-init volume", () => {
  const m = machine(); const a = manifest(m, image, "guests"); const spec = object(a.spec); const template = object(object(spec.template).spec); const devices = object(object(template.domain).devices);
  assert.deepEqual(object(object((spec.dataVolumeTemplates as Data[])[0]!.spec).source).pvc, { namespace: "guests", name: "base" });
  const mac = object((devices.interfaces as Data[])[0]).macAddress; assert.match(String(mac), /^02(?::[0-9a-f]{2}){5}$/); assert.equal(devices.autoattachGraphicsDevice, false);
  m.desired = "stopped"; const stopped = manifest(m, image, "guests"); assert.equal(object(stopped.spec).runStrategy, "Halted");
  const windows = manifest(m, { ...image, os: "windows", mode: "desktop", _userData: "private", prepare: { driver: "cloudbase-init" } }, "guests"); const guest = object(object(object(windows.spec).template).spec); const domain = object(guest.domain);
  assert.deepEqual(object(domain.devices).tpm, { persistent: true }); assert.deepEqual((guest.volumes as Data[])[1], { name: "preparation", cloudInitConfigDrive: { secretRef: { name: `cvm-${m.id}-preparation` } } });
});

test("KubeVirt creation response loss recovers only recorded identity and never repeats create", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "platform-create-")); t.after(() => rmSync(root, { recursive: true, force: true })); const m = machine(); let vm: Data | null = null; let creates = 0;
  const provider = new KubevirtProvider({ namespace: "guests" }, root);
  provider.kubectl = async (args, options) => {
    if (args[0] === "create") { creates++; vm = JSON.parse(options!.input!) as Data; object(vm.metadata).uid = randomUUID(); throw new Error("lost response"); }
    if (args[1] === "virtualmachine") return vm ? JSON.stringify(vm) : "";
    if (args[1] === "virtualmachineinstance") return "";
    throw new Error(`Unexpected command ${args}`);
  };
  await assert.rejects(provider.reconcile(m, image, root), /lost response/);
  assert.equal((await provider.reconcile(m, image, root)).state, "starting"); assert.equal(creates, 1); assert.equal(loadReceipt().uid, object(vm!.metadata).uid);
  object(vm!.metadata).uid = randomUUID(); await assert.rejects(provider.reconcile(m, image, root), /saved ownership/);
  function loadReceipt() { return readRecord(join(root, "kubevirt-owner.json")); }
});

test("failed creation retains intent and prevents Secret mutation or same-name adoption", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "platform-create-failed-")); t.after(() => rmSync(root, { recursive: true, force: true })); const m = machine(); let mutations = 0; let foreign = "";
  const provider = new KubevirtProvider({ namespace: "guests" }, root); provider.kubectl = async args => { if (args[0] === "create") { mutations++; throw new Error("uncertain"); } return foreign; };
  await assert.rejects(provider.reconcile(m, image, root), /uncertain/);
  await assert.rejects(provider.reconcile(m, { ...image, _userData: "private", prepare: { driver: "cloud-init" } }, root), /automatic recreation/); assert.equal(mutations, 1);
  foreign = JSON.stringify(manifest(m, image, "guests")); await assert.rejects(provider.reconcile(m, image, root), /recorded creation/);
  foreign = ""; m.desired = "stopped"; assert.equal((await provider.reconcile(m, image, root)).state, "unknown");
});

test("lifecycle patch atomically tests VM UID and creation annotations; labels never authorize restart", async t => {
  const f = fixture(t); f.m.desired = "stopped"; const patches: Data[][] = [];
  f.provider.kubectl = async args => { if (args[0] === "patch") { assert.ok(args.includes("--type=json")); patches.push(JSON.parse(args.at(-1)!) as Data[]); return ""; } return args[1] === "virtualmachine" ? JSON.stringify(f.vm) : ""; };
  assert.equal((await f.provider.reconcile(f.m, image, f.folder)).state, "stopped"); assert.equal(patches[0]![0]!.value, object(f.vm.metadata).uid);
  unlinkSync(join(f.folder, "kubevirt-owner.json")); unlinkSync(join(f.folder, "kubevirt-create.json")); await assert.rejects(f.provider.reconcile(f.m, image, f.folder), /Legacy labels/); assert.equal(patches.length, 1);
});

test("absent VM with VMI or unresolved creation is unknown, with complete absence is stopped", async t => {
  const f = fixture(t); f.m.desired = "stopped"; let instance = JSON.stringify(f.vmi); f.provider.kubectl = async args => args[1] === "virtualmachine" ? "" : instance;
  assert.equal((await f.provider.reconcile(f.m, image, f.folder)).state, "unknown"); instance = ""; assert.equal((await f.provider.reconcile(f.m, image, f.folder)).state, "stopped");
  unlinkSync(join(f.folder, "kubevirt-owner.json")); assert.equal((await f.provider.reconcile(f.m, image, f.folder)).state, "unknown");
});

test("leased creation fails closed before any mutation", async t => {
  const f = fixture(t); let calls = 0; f.provider.kubectl = async () => { calls++; return ""; }; f.m.lease = { id: randomUUID() };
  await assert.rejects(f.provider.reconcile(f.m, image, join(f.root, "fresh")), /independent native fencing/); assert.equal(calls, 1);
});

test("owned usage stays separate from namespace totals and observation never writes receipts", async t => {
  const f = fixture(t); const before = readFileSync(join(f.folder, "kubevirt-owner.json")); const report = await f.report(); assert.ok(validateClusterReport(report));
  assert.equal(object(report.metrics).cpuCores, .2); assert.equal(object(object(report.canaveral).metrics).cpuCores, .1); assert.deepEqual(readFileSync(join(f.folder, "kubevirt-owner.json")), before);
  unlinkSync(join(f.folder, "kubevirt-owner.json")); assert.deepEqual((await f.report()).canaveral, unavailableOwnership()); assert.throws(() => loadOwnership(f.m, "guests", f.folder));
});

test("migration and recursive support pods count once and require complete container coverage", async t => {
  const f = fixture(t); const target = pod("target", reference("VirtualMachineInstance", object(f.vmi.metadata).name, object(f.vmi.metadata).uid)); const support = pod("support", reference("Pod", "target", object(target.metadata).uid, "v1"));
  f.inventory.pods!.push(target, support); f.measurements.push(metric("target"), metric("support")); const owned = object(object((await f.report()).canaveral).metrics); assert.equal(owned.podCount, 3); assert.equal(owned.cpuCores, .3);
  f.measurements = f.measurements.filter(m => object(m.metadata).name !== "support"); const incomplete = object(object((await f.report()).canaveral).metrics); assert.equal(incomplete.status, "unavailable"); assert.equal(incomplete.cpuCores, undefined);
});

test("spoofed labels, multiple controllers, wrong UIDs, cycles and missing parents withhold owned totals", async t => {
  for (const variant of ["labels", "controllers", "uid", "cycle", "parent"]) {
    const f = fixture(t); const metadata = object(f.launcher.metadata);
    if (variant === "labels") { metadata.ownerReferences = []; metadata.labels = { "canaveral.io/machine": f.m.id }; }
    if (variant === "controllers") (metadata.ownerReferences as Data[]).push(reference("Pod", "another", "other", "v1"));
    if (variant === "uid") object((metadata.ownerReferences as Data[])[0]).uid = randomUUID();
    if (variant === "cycle") metadata.ownerReferences = [reference("Pod", metadata.name, metadata.uid, "v1")];
    if (variant === "parent") { metadata.ownerReferences = [reference("Pod", "missing", "unknown", "v1")]; metadata.annotations = { "kubevirt.io/created-by": object(f.vmi.metadata).uid }; }
    assert.deepEqual((await f.report()).canaveral, unavailableOwnership(), variant);
  }
});

test("changed VM/VMI identities, receipt or pod inventory churn never produce owned totals", async t => {
  for (const variant of ["vm", "vmi", "receipt", "churn", "duplicate", "incomplete"]) {
    const f = fixture(t);
    if (variant === "vm") object(f.vm.metadata).uid = randomUUID();
    if (variant === "vmi") object((object(f.vmi.metadata).ownerReferences as Data[])[0]).uid = randomUUID();
    if (variant === "receipt") saveRecord(join(f.folder, "assignment.json"), { fingerprint: "wrong" });
    if (variant === "duplicate") object(f.other.metadata).uid = object(f.launcher.metadata).uid;
    let reads = 0; if (variant === "churn") f.hook = args => { if (args[1] === "pods" && ++reads === 2) object(f.launcher.metadata).uid = randomUUID(); return undefined; };
    if (variant === "incomplete") f.hook = args => args[1] === "pods" ? JSON.stringify({ items: f.inventory.pods, metadata: { continue: "next" } }) : undefined;
    assert.deepEqual((await f.report()).canaveral, unavailableOwnership(), variant);
  }
});

test("owned windows and optional metrics UID cannot cross a pod incarnation", async t => {
  const f = fixture(t);
  for (const window of [null, "bad", "-1s", "0s", "121s", "2m1s"]) { f.measurements[0]!.window = window; assert.equal(object(object((await f.report()).canaveral).metrics).status, "unavailable", String(window)); }
  f.measurements[0]!.window = "0m30000ms"; assert.equal(object(object((await f.report()).canaveral).metrics).status, "available");
  object(f.launcher.metadata).creationTimestamp = "2026-11-03T00:00:45Z"; assert.equal(object(object((await f.report()).canaveral).metrics).status, "unavailable");
  object(f.launcher.metadata).creationTimestamp = "2026-11-03T00:00:00Z"; object(f.measurements[0]!.metadata).uid = randomUUID(); assert.equal(object(object((await f.report()).canaveral).metrics).status, "unavailable");
});

test("finished pods do not consume usage; empty scope requires successful inventory and metrics", async t => {
  const f = fixture(t); f.m.observed = "stopped"; f.inventory["virtualmachineinstances.kubevirt.io"] = []; f.inventory["virtualmachines.kubevirt.io"] = []; f.inventory.pods = [f.other]; f.measurements = [metric("unrelated")];
  assert.equal(object(object((await f.report()).canaveral).metrics).cpuCores, 0);
  assert.equal(object(object((await f.provider.resourceReport([])).canaveral).metrics).cpuCores, 0);
  f.hook = args => { if (args.includes("--raw")) throw new Error("PRIVATE cluster connection"); return undefined; };
  const missing = await f.provider.resourceReport([]); assert.equal(object(object(missing.canaveral).metrics).status, "unavailable"); assert.ok(!JSON.stringify(missing).includes("PRIVATE"));
});

test("symlink, nonregular and oversized receipts are never accepted", async t => {
  const f = fixture(t); const receipt = join(f.folder, "kubevirt-owner.json"); const saved = readFileSync(receipt); unlinkSync(receipt); const target = join(f.root, "copy.json"); writeFileSync(target, saved); symlinkSync(target, receipt);
  assert.deepEqual((await f.report()).canaveral, unavailableOwnership()); unlinkSync(receipt); writeFileSync(receipt, "x".repeat(65537)); assert.deepEqual((await f.report()).canaveral, unavailableOwnership());
});

test("metrics reject stale, future, duplicate and missing containers while preserving fractional CPU", () => {
  assert.equal(quantity("500000n"), .0005); assert.equal(quantity("NaN"), null); assert.equal(quantity("1e999"), null);
  const p = pod("p"); const m = metric("p"); assert.equal(podUsage("guests", now, [p], [m]).cpuCores, .1);
  for (const stamp of ["2026-11-02T23:58:59Z", "2026-11-03T00:01:06Z", "2026-11-03T00:01:00", null]) { m.timestamp = stamp; assert.equal(podUsage("guests", now, [p], [m]).status, "unavailable"); }
  m.timestamp = "2026-11-03T00:01:00Z"; assert.equal(podUsage("guests", now, [p], [m, m]).status, "unavailable");
  object(p.status).initContainerStatuses = [{ name: "init", state: { running: {} } }]; assert.equal(podUsage("guests", now, [p], [m]).status, "unavailable");
  (m.containers as Data[]).push({ name: "init", usage: { cpu: "50m", memory: "32Mi" } }); assert.equal(podUsage("guests", now, [p], [m]).cpuCores, .15);
});

test("report validation accepts legacy reports and rejects contradictory owned accounting", async t => {
  const f = fixture(t); const report = await f.report(); const legacy = structuredClone(report); delete legacy.canaveral; assert.equal(validateClusterReport(legacy), true);
  for (const variant of ["partial", "scope", "boolean", "unknown", "extra"]) {
    const invalid = structuredClone(report); const owned = object(invalid.canaveral); const ownership = object(owned.ownership);
    if (variant === "partial") ownership.verifiedMachines = 0;
    if (variant === "scope") owned.scope = "namespace";
    if (variant === "boolean") ownership.assignedMachines = true;
    if (variant === "unknown") owned.ownership = { status: "unavailable" };
    if (variant === "extra") owned.credential = "private";
    assert.equal(validateClusterReport(invalid), false, variant);
  }
});
