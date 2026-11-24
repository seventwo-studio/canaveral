import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LibvirtProvider, libvirtLeaseTemplate } from "../../src/providers/libvirt.ts";
import type { LeaseFence, LibvirtLeaseNative, ProcessBirth } from "../../src/providers/libvirt.ts";
import { libvirtLeaseHelper, libvirtLeaseKernelSupported, productionLibvirtAdapters } from "../../src/providers/libvirt-native.ts";
import { canonical, fingerprint, validateDomainXML, LibvirtLeaseBinding } from "../../src/providers/libvirt-ownership.ts";
import type { RecordValue } from "../../src/providers/libvirt-ownership.ts";
import { hostOffer, leaseOffer } from "../../src/host.ts";

const vmGid = process.getgid!();
const read = (path: string): RecordValue => JSON.parse(fs.readFileSync(path, "utf8")) as RecordValue;
const save = (path: string, value: unknown): void => fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

/** Stands in for the Rust guardian and its fence and erase commands. Each proof it reports is
 * the one the native helper must establish: a stopped receipt only after the domain is gone. */
class FakeNative implements LibvirtLeaseNative {
  readonly helper = { path: "/fixture/canaveral-libvirt-native", sha256: "a".repeat(64) };
  readonly guardians = new Map<string, { pid: number; createdAt: number; alive: boolean }>();
  readonly domains = new Map<string, { xml: string; state: string }>();
  launches = 0; erases = 0; eraseFailures = 0; libvirtDown = false;
  readonly fences: string[] = [];
  launch(folder: string): { pid: number; createdAt: number } {
    this.launches++;
    const guardian = { pid: 40000 + this.launches, createdAt: 1000 + this.launches, alive: true };
    this.guardians.set(folder, guardian);
    return { pid: guardian.pid, createdAt: guardian.createdAt };
  }
  arguments(folder: string, parent: number): string[] { return [this.helper.path, "guard", folder, String(parent)]; }
  birth(pid: number): ProcessBirth | "gone" | "unknown" {
    for (const [folder, g] of this.guardians) {
      if (g.pid === pid) return g.alive ? { pid, createdAt: g.createdAt, parentPid: process.pid, uid: process.getuid!(), executable: this.helper.path, argv: this.arguments(folder, process.pid), zombie: false } : "gone";
    }
    return "gone";
  }
  spec(folder: string): RecordValue { return read(join(folder, "libvirt-native-spec.json")); }
  uuid(folder: string): string { return String((this.spec(folder).identity as RecordValue).machineId); }
  receipt(folder: string, value: RecordValue): void { save(join(folder, "libvirt-native-execution.json"), value); }
  /** The guardian created and resumed the transient domain. */
  run(folder: string): void {
    const spec = this.spec(folder);
    this.domains.set(this.uuid(folder), { xml: String(spec.xml), state: "running" });
    this.receipt(folder, { identity: spec.identity, phase: "running", domain: { id: 7, birth: { pid: 9, start: 9 } } });
  }
  /** The guardian fenced on its own: the domain is gone and it recorded the proof. */
  guardianFenced(folder: string, reason = "fenced"): void {
    this.domains.delete(this.uuid(folder));
    const old = read(join(folder, "libvirt-native-execution.json"));
    this.receipt(folder, { ...old, phase: "stopped", reason });
    this.guardians.get(folder)!.alive = false;
  }
  /** SIGKILL or OOM: the guardian vanished without a stop receipt. */
  kill(folder: string): void { this.guardians.get(folder)!.alive = false; }
  async fence(folder: string): Promise<LeaseFence> {
    this.fences.push(folder);
    if (this.guardians.get(folder)?.alive) return "busy";
    if (this.libvirtDown) return "unconfirmed";
    this.domains.delete(this.uuid(folder));
    const path = join(folder, "libvirt-native-execution.json");
    const old = fs.existsSync(path) ? read(path) : { identity: this.spec(folder).identity, phase: "unused" };
    this.receipt(folder, { ...old, phase: "stopped", reason: old.reason ?? "guardian-ended" });
    return "stopped";
  }
  async erase(folder: string, quarantine: string): Promise<boolean> {
    this.erases++;
    if (this.eraseFailures > 0) { this.eraseFailures--; return false; }
    const intent = read(join(folder, "libvirt-native-removal.json"));
    assert.equal(intent.quarantine, quarantine);
    assert.ok(!this.domains.has(this.uuid(folder)), "erasure only after the domain is gone");
    fs.rmSync(quarantine, { recursive: true });
    save(join(folder, "libvirt-native-erased.json"), { cleanupId: intent.cleanupId, phase: "removed" });
    return true;
  }
}

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "canaveral-libvirt-lease-")));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = join(root, "disks"), folder = join(root, "assignment");
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.mkdirSync(storage, { mode: 0o700 }); fs.chownSync(storage, process.getuid!(), vmGid); fs.chmodSync(storage, 0o2750);
  const base = join(storage, "base.qcow2");
  fs.writeFileSync(base, "base"); fs.chownSync(base, process.getuid!(), vmGid); fs.chmodSync(base, 0o640);
  const machine: RecordValue = { id: randomUUID(), desired: "running", template: { id: "linux" }, resources: { cpu: 1, memoryMiB: 512, diskGiB: 4 }, lease: { id: randomUUID(), state: "ready" } };
  save(join(folder, "assignment.json"), { fingerprint: fingerprint(machine), leaseId: (machine.lease as RecordValue).id });
  let auth: RecordValue = { leaseID: (machine.lease as RecordValue).id, revision: 1, remainingSeconds: 30, fenced: false };
  const image: RecordValue = { os: "linux", arch: "amd64", mode: "headless", firmware: "bios", image: base, network: "default", _leaseAuthorization: () => ({ ...auth }) };
  const native = new FakeNative(), commands: string[][] = [];
  let now = 100, boot: string = randomUUID();
  const adapters = {
    fixture: true, platform: "linux" as const, arch: "amd64", clock: () => now, hostBoot: () => boot, lease: native,
    run: async (argv: readonly string[]) => {
      commands.push([...argv]);
      if (argv[0] === "qemu-img") return argv[1] === "info" ? JSON.stringify({ "virtual-size": 1024, format: "qcow2" }) : "";
      const domain = native.domains.get(String(machine.id));
      if (argv[3] === "list") return "";
      if (argv[3] === "dumpxml") { if (!domain) throw Error("no domain"); return domain.xml; }
      if (argv[3] === "domstate") { if (!domain) throw Error("no domain"); return domain.state; }
      throw Error(`unexpected ${argv.join(" ")}`);
    },
  };
  const provider = new LibvirtProvider({ storage, vmGroupId: vmGid, templates: [], adapters }, root);
  const disk = join(storage, String(machine.id), "disk.qcow2");
  const terminal = (state = "released") => {
    machine.desired = "stopped"; (machine.lease as RecordValue).state = state; auth = { ...auth, fenced: true };
    machine.leaseCleanup = { id: randomUUID(), leaseId: (machine.lease as RecordValue).id };
    return String((machine.leaseCleanup as RecordValue).id);
  };
  return {
    root, storage, folder, machine, image, native, commands, provider, disk, terminal,
    get now() { return now; }, set now(v: number) { now = v; },
    get boot() { return boot; }, set boot(v: string) { boot = v; },
    get auth() { return auth; }, set auth(v: RecordValue) { auth = v; },
  };
}
type Fixture = ReturnType<typeof fixture>;
/** Prepare, launch the guardian and let it bring the domain up. */
async function running(f: Fixture): Promise<void> {
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "starting");
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "starting");
  f.native.run(f.folder);
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "running");
}

test("lease preparation records a transient spec, defines nothing and launches one guardian", async t => {
  const f = fixture(t);
  await running(f);
  assert.equal(f.native.launches, 1);
  assert.ok(!f.commands.some(c => ["define", "start", "create", "undefine"].includes(c[3]!)), "no persistent definition or virsh start");
  const spec = read(join(f.folder, "libvirt-binding.json"));
  assert.equal(spec.executionMode, "transient");
  assert.deepEqual(spec.library, f.native.helper);
  assert.deepEqual(spec.storageAccess, { gid: vmGid, label: "libvirt-qemu:canaveral-vm" });
  const native = f.native.spec(f.folder), xml = String(native.xml);
  assert.equal(native.cluster, false);
  assert.match(xml, /<os><type arch="x86_64">hvm<\/type><boot dev="hd"\/><\/os>/);
  assert.doesNotMatch(xml, /nvram|tpm|firmware=/);
  assert.match(xml, /<seclabel type="static" model="dac" relabel="no"><label>libvirt-qemu:canaveral-vm<\/label><\/seclabel>/);
  // The per-launch nonce is the binding's boot ID in the owner metadata.
  const binding = new LibvirtLeaseBinding(spec.binding as never);
  validateDomainXML(xml, binding, "libvirt-qemu:canaveral-vm");
  assert.deepEqual(native.identity, binding.identity());
  assert.ok(!fs.existsSync(join(dirname(f.disk), "domain.xml")));
  const disk = fs.lstatSync(f.disk);
  assert.deepEqual([disk.gid, disk.mode & 0o7777], [vmGid, 0o660]);
  // The guardian's deadline authority exists before it starts.
  assert.equal(read(join(f.folder, "libvirt-authorization.json")).fenced, false);
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "running");
  assert.equal(f.native.launches, 1, "a running lease never relaunches");
});

test("release publishes a fence and reports stopped only after the guardian's proof", async t => {
  const f = fixture(t);
  await running(f);
  f.machine.desired = "stopped";
  const stopping = await f.provider.reconcile(f.machine, f.image, f.folder);
  assert.deepEqual([stopping.state, stopping.leaseFenced], ["stopping", true]);
  assert.equal(read(join(f.folder, "libvirt-authorization.json")).fenced, true);
  assert.deepEqual(f.native.fences, [f.folder], "the live guardian holds the lock");
  assert.equal(await f.provider.updateStopped(f.machine, f.image, f.folder), false);
  f.native.guardianFenced(f.folder);
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "stopped");
  assert.equal(await f.provider.updateStopped(f.machine, f.image, f.folder, true), true);
  assert.equal(f.native.fences.length, 1, "a durable stopped receipt needs no second fence");
});

for (const end of ["expiry", "revocation"] as const) test(`${end} fences through the independent refresh`, async t => {
  const f = fixture(t);
  await running(f);
  assert.equal(await f.provider.refreshExecution(f.machine, f.image, f.folder), null);
  if (end === "expiry") { f.now = 131; f.auth = { ...f.auth, remainingSeconds: 0 }; }
  if (end === "revocation") f.auth = { ...f.auth, fenced: true };
  const report = await f.provider.refreshExecution(f.machine, f.image, f.folder);
  assert.deepEqual(report, { state: "stopping", leaseFenced: true, detail: "The lease fence is not proven yet; its reservation is retained." });
  f.native.guardianFenced(f.folder, "deadline");
  assert.deepEqual(await f.provider.refreshExecution(f.machine, f.image, f.folder), { state: "stopped", leaseFenced: true });
});

for (const loss of ["daemon crash", "guardian OOM kill", "guardian killed mid-fence"] as const) test(`${loss}: the reconciler fences under the guardian's lock`, async t => {
  const f = fixture(t);
  await running(f);
  if (loss === "guardian killed mid-fence") {
    // The guardian recorded why the lease ended but not its proof.
    f.native.receipt(f.folder, { ...read(join(f.folder, "libvirt-native-execution.json")), reason: "deadline", fence: "libvirt-unconfirmed" });
  }
  f.native.kill(f.folder);
  const report = await f.provider.refreshExecution(f.machine, f.image, f.folder);
  assert.deepEqual(report, { state: "stopped", leaseFenced: true });
  assert.equal(f.native.domains.size, 0);
  assert.equal(read(join(f.folder, "libvirt-native-execution.json")).phase, "stopped");
  // The published fence latches: the assignment reports its proof and never relaunches.
  assert.deepEqual(await f.provider.reconcile(f.machine, f.image, f.folder), { state: "stopped", leaseFenced: true });
  assert.equal(f.native.launches, 1, "a launch is never replayed");
});

test("unconfirmed native proof keeps the reservation through cleanup", async t => {
  const f = fixture(t);
  await running(f);
  f.native.kill(f.folder);
  f.native.libvirtDown = true;
  const id = f.terminal();
  assert.equal((await f.provider.stopForCleanup(f.machine, f.image, f.folder)).state, "stopping");
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, f.image, f.folder, id), (e: { code?: string }) => e.code === "execution_pending");
  assert.ok(fs.existsSync(f.disk), "storage stays until the stop is proven");
  assert.equal(f.native.erases, 0);
  f.native.libvirtDown = false;
  assert.equal((await f.provider.stopForCleanup(f.machine, f.image, f.folder)).state, "stopped");
});

test("removal quarantines, erases through the helper once and completes repeatably", async t => {
  const f = fixture(t);
  await running(f);
  f.native.guardianFenced(f.folder, "released");
  const id = f.terminal();
  assert.equal((await f.provider.stopForCleanup(f.machine, f.image, f.folder)).state, "stopped");
  f.native.eraseFailures = 1;
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, f.image, f.folder, id), /unconfirmed/);
  const quarantine = join(f.storage, `.removing-${f.machine.id}-${id}`);
  assert.ok(fs.existsSync(quarantine) && !fs.existsSync(dirname(f.disk)), "an interrupted erasure resumes from the quarantine");
  const intent = read(join(f.folder, "libvirt-native-removal.json"));
  assert.deepEqual([intent.cleanupId, intent.quarantine, intent.storageGid], [id, quarantine, vmGid]);
  const proof = await f.provider.removeOwnedStorage(f.machine, f.image, f.folder, id);
  assert.deepEqual([proof.state, proof.id, proof.machineId, proof.storageRemoved, proof.executionStopped], ["complete", id, f.machine.id, true, true]);
  assert.ok(!fs.existsSync(quarantine) && !fs.existsSync(dirname(f.disk)));
  assert.deepEqual(await f.provider.removeOwnedStorage(f.machine, f.image, f.folder, id), proof);
  assert.equal(f.native.erases, 2);
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, f.image, f.folder, randomUUID()), /intent differs/);
});

test("a failed guardian spawn is fenced and never retried", async t => {
  const f = fixture(t);
  f.native.launch = () => { throw Error("spawn failed before any record"); };
  await assert.rejects(f.provider.reconcile(f.machine, f.image, f.folder));
  // The attempt was recorded before the spawn, so it is fenced, never retried.
  assert.ok(fs.existsSync(join(f.folder, "libvirt-launch.json")));
  f.machine.desired = "stopped";
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "stopped");
  assert.deepEqual(f.native.fences, [f.folder]);
});

test("a lease fenced before its launch retires the preparation without native calls", async t => {
  const f = fixture(t);
  // Positive before preparation, but expired once the deadline is published.
  f.auth = { ...f.auth, remainingSeconds: 0.1 };
  const report = await f.provider.reconcile(f.machine, f.image, f.folder);
  assert.deepEqual([report.state, report.leaseFenced], ["stopped", true]);
  assert.ok(fs.existsSync(f.disk));
  assert.equal(read(join(f.folder, "libvirt-execution.json")).stopEvidence, "never-launched");
  f.auth = { ...f.auth, remainingSeconds: 30 };
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "stopped", "a retired preparation never launches");
  assert.deepEqual([f.native.launches, f.native.fences.length], [0, 0]);
  const id = f.terminal();
  assert.equal((await f.provider.stopForCleanup(f.machine, f.image, f.folder)).state, "stopped");
  assert.equal((await f.provider.removeOwnedStorage(f.machine, f.image, f.folder, id)).state, "complete");
  assert.ok(!fs.existsSync(dirname(f.disk)));
});

test("a host reboot fences without publishing an old-boot deadline", async t => {
  const f = fixture(t);
  await running(f);
  f.native.kill(f.folder);
  const before = fs.readFileSync(join(f.folder, "libvirt-authorization.json"), "utf8");
  f.boot = randomUUID();
  assert.deepEqual(await f.provider.refreshExecution(f.machine, f.image, f.folder), { state: "stopped", leaseFenced: true });
  assert.equal(fs.readFileSync(join(f.folder, "libvirt-authorization.json"), "utf8"), before);
});

test("guest shutdown or a foreign domain ends the launch; an unobservable one is kept", async t => {
  const f = fixture(t);
  await running(f);
  f.commands.length = 0;
  f.native.domains.get(String(f.machine.id))!.state = "shut off";
  f.native.guardians.get(f.folder)!.alive = true;
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "stopping");
  const g = fixture(t);
  await running(g);
  const domain = g.native.domains.get(String(g.machine.id))!;
  domain.xml = domain.xml.replace(/bootId="[^"]+"/, `bootId="${randomUUID()}"`);
  assert.equal((await g.provider.reconcile(g.machine, g.image, g.folder)).state, "stopping");
  const h = fixture(t);
  await running(h);
  h.native.domains.clear();
  const unknown = await h.provider.reconcile(h.machine, h.image, h.folder);
  assert.equal(unknown.state, "unknown");
  assert.equal(h.native.fences.length, 0, "an observation failure alone does not fence; the guardian still enforces the lease");
});

test("lease preparation refuses unqualified templates and a missing helper before provisioning", async t => {
  for (const change of [{ firmware: "efi" }, { firmware: undefined }, { tpm: true }, { secureBoot: true }, { mode: "desktop" }, { guestAccess: true }]) {
    const f = fixture(t);
    await assert.rejects(f.provider.reconcile(f.machine, { ...f.image, ...change }, f.folder));
    assert.ok(!f.commands.some(c => c[0] === "qemu-img"), JSON.stringify(change));
    assert.ok(!fs.existsSync(f.disk));
  }
  const f = fixture(t);
  const bare = new LibvirtProvider({ ...f.provider.config, adapters: { ...(f.provider.config.adapters as object), lease: undefined } }, f.root);
  await assert.rejects(bare.reconcile(f.machine, f.image, f.folder), (e: { code?: string }) => e.code === "libvirt_lease_helper_unverified");
  assert.equal(f.commands.length, 0);
  assert.equal(libvirtLeaseTemplate(f.image), true);
  for (const change of [{ arch: "arm64" }, { os: "windows" }, { firmware: "efi" }, { prepare: {} }]) assert.equal(libvirtLeaseTemplate({ ...f.image, ...change }), false);
});

test("a helper change after preparation or a foreign receipt is never adopted", async t => {
  const f = fixture(t);
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "starting");
  // Prepared with the original helper; the pinned digest changes before the launch.
  const g = fixture(t), original = g.native.helper;
  let reads = 0;
  Object.defineProperty(g.native, "helper", { get: () => reads++ === 0 ? original : { ...original, sha256: "b".repeat(64) } });
  await assert.rejects(g.provider.reconcile(g.machine, g.image, g.folder), /helper changed/);
  assert.equal(g.native.launches, 0);
  assert.ok(!fs.existsSync(join(g.folder, "libvirt-launch.json")));
  f.native.receipt(f.folder, { identity: { ...f.native.spec(f.folder).identity as RecordValue, bootId: randomUUID() }, phase: "stopped" });
  await assert.rejects(f.provider.reconcile(f.machine, f.image, f.folder), /another launch/);
  assert.equal(await f.provider.updateStopped({ ...f.machine, desired: "stopped" }, f.image, f.folder), false);
});

test("lease offers need Linux, the pinned helper, a 6.5 kernel and a BIOS lease template", () => {
  const helper = { leaseHelper: "/usr/lib/canaveral/canaveral-libvirt-native", leaseHelperSha256: "c".repeat(64) };
  const template = { id: "lease-linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", firmware: "bios", image: "/var/lib/libvirt/images/canaveral/lease.qcow2", minimum: { cpu: 1, memoryMiB: 512, diskGiB: 2 } };
  const base = { name: "vm", provider: "libvirt", storage: "/var/lib/libvirt/images/canaveral", capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 20 }, templates: [template], leaseClockHelper: "/usr/lib/canaveral/canaveral-libvirt-native", leaseProtocol: 1, leaseImages: [{ id: "lease-linux", revision: "1", arch: "amd64", runtime: "libvirt" }], ...helper };
  assert.deepEqual(hostOffer(base, "linux", "6.8.0-1017-azure").leaseImages, base.leaseImages);
  const physical = { ...base, provider: "linux", runtimes: { libvirt: helper } };
  delete (physical as RecordValue).leaseHelper; delete (physical as RecordValue).leaseHelperSha256;
  assert.deepEqual(hostOffer(physical, "linux", "6.5.0").leaseImages, base.leaseImages);
  assert.throws(() => leaseOffer(base, "linux", "6.4.16"), (e: { code?: string }) => e.code === "libvirt_lease_kernel_unsupported");
  assert.throws(() => leaseOffer(base, "darwin", "6.8.0"), /cannot advertise/);
  assert.throws(() => leaseOffer({ ...base, leaseHelperSha256: "short" }, "linux", "6.8.0"), /pinned lease helper/);
  assert.throws(() => leaseOffer({ ...base, leaseImages: [{ ...base.leaseImages[0], isolation: "shared-host" }] }, "linux", "6.8.0"), /cannot advertise/);
  for (const change of [{ firmware: "efi" }, { mode: "desktop" }, { tpm: true }, { guestAccess: true }]) {
    assert.throws(() => hostOffer({ ...base, templates: [{ ...template, ...change }] }, "linux", "6.8.0"), /headless x64 BIOS Linux/, JSON.stringify(change));
  }
  assert.equal(libvirtLeaseKernelSupported("6.5.0-rc1"), true);
  assert.equal(libvirtLeaseKernelSupported("5.15.0-1050-azure"), false);
  assert.equal(libvirtLeaseKernelSupported("garbage"), false);
  assert.deepEqual(libvirtLeaseHelper(helper), { path: helper.leaseHelper, sha256: helper.leaseHelperSha256 });
  assert.equal(libvirtLeaseHelper({}), undefined);
  for (const bad of [{ leaseHelper: "relative" }, { ...helper, leaseHelper: "/a/../b" }, { leaseHelper: helper.leaseHelper }]) assert.throws(() => libvirtLeaseHelper(bad));
  if (process.platform !== "linux") assert.deepEqual(productionLibvirtAdapters(helper), {});
});

test("durable stop evidence is read without locks and belongs to its exact launch", async t => {
  const f = fixture(t);
  await running(f);
  const stopped = { ...f.machine, desired: "stopped" };
  assert.equal(await f.provider.updateStopped(stopped, f.image, f.folder, true), false);
  f.native.guardianFenced(f.folder);
  assert.equal(await f.provider.updateStopped(stopped, f.image, f.folder, true), true);
  assert.equal(await f.provider.updateStopped({ ...stopped, resources: { cpu: 2, memoryMiB: 512, diskGiB: 4 } }, f.image, f.folder, true), false);
  assert.equal(canonical(read(join(f.folder, "libvirt-native-execution.json")).identity), canonical(f.native.spec(f.folder).identity));
});

test("a guardian that is already fencing is never reported running", async t => {
  const f = fixture(t);
  await running(f);
  f.native.receipt(f.folder, { ...read(join(f.folder, "libvirt-native-execution.json")), reason: "deadline" });
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.folder)).state, "stopping");
  assert.deepEqual(f.native.fences, [f.folder], "the live guardian keeps the lock");
});

test("cleanup without an authorization callback still fences a live guardian", async t => {
  const f = fixture(t);
  await running(f);
  const id = f.terminal();
  const { _leaseAuthorization: _, ...original } = f.image;
  assert.equal((await f.provider.stopForCleanup(f.machine, original, f.folder)).state, "stopping");
  const published = read(join(f.folder, "libvirt-authorization.json"));
  assert.equal(published.fenced, true, "the guardian sees a fenced record and stops on its own");
  assert.equal(published.deadline, 129.75, "latching never extends the deadline");
  f.native.guardianFenced(f.folder);
  assert.equal((await f.provider.stopForCleanup(f.machine, original, f.folder)).state, "stopped");
  assert.equal((await f.provider.removeOwnedStorage(f.machine, original, f.folder, id)).state, "complete");
});

test("the independent refresh latches a cleanup fence without waiting for reconciliation", async t => {
  const f = fixture(t);
  await running(f);
  f.terminal();
  const { _leaseAuthorization: _, ...original } = f.image;
  assert.equal(await f.provider.refreshExecution(f.machine, original, f.folder), null);
  assert.equal(read(join(f.folder, "libvirt-authorization.json")).fenced, true);
  assert.equal(f.native.fences.length, 0, "the cleanup pipeline runs the fence itself");
});
