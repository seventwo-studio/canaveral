import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assignmentAccess, assignmentFingerprint, contactFresh, currentAssignment, helpersClosed, LeaseGuard, privateDirectory, ProcessSupervisor, publishNativeLease, readRecord, removeAppleStorage, saveRecord, ShellSessions, StateLock } from "../../src/runtime-process.ts";
import type { ExecutionClock, PtyHandle, RecordValue } from "../../src/runtime-process.ts";
import { ServiceError } from "../../src/errors.ts";
function fixture(t: { after(fn: () => void): void }): string { const p = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-host-"))); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }
function lease(): RecordValue { return { id: randomUUID(), desired: "running", template: { id: "fixture" }, resources: { cpu: 1 }, lease: { id: randomUUID(), revision: 1, state: "ready", controllerNow: 1000, authorizationDeadline: 1060 } }; }
function clock(): ExecutionClock & { wallTime: number; mono: number } { return { wallTime: 1000, mono: 10, suspendAware: true, now() { return this.mono; }, wall() { return this.wallTime; } }; }

test("private synchronized records reject links, nonregular files and oversized observations", t => {
  const root = fixture(t), file = join(root, "record.json"); saveRecord(file, { value: 1 }); assert.equal(statSync(file).mode & 0o777, 0o600); assert.deepEqual(readRecord(file), { value: 1 });
  symlinkSync(file, join(root, "link")); assert.throws(() => readRecord(join(root, "link"))); assert.throws(() => saveRecord(join(root, "link"), {}));
  assert.throws(() => readRecord(root)); assert.throws(() => readRecord(file, 1));
});
test("contact freshness rejects rollback, exact expiry and invalid dispatch", () => {
  assert.equal(contactFresh(10, 29.99), true); for (const [last, now] of [[10, 30], [10, 9], [0, 1], [NaN, 12]]) assert.equal(contactFresh(last!, now!), false);
});
test("lease replay, wall rollback, exact deadline and late renewal retain sticky fencing", t => {
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), m = lease(); guard.observe([m], 2);
  c.mono = 67; c.wallTime = 500; assert.equal(guard.allowed(String(m.id)), true);
  c.mono = 68; assert.equal(guard.allowed(String(m.id)), false);
  const renewed = { ...m, lease: { ...(m.lease as RecordValue), revision: 2, controllerNow: 1010, authorizationDeadline: 1200 } };
  c.wallTime = 1010; guard.observe([renewed], 0); assert.equal(guard.allowed(String(m.id)), false);
  assert.equal(new LeaseGuard(root, c).allowed(String(m.id)), false);
});

test('restored lease deadlines bind the host boot and refuse unbound history', t => {
  const root = fixture(t), original = { ...clock(), bootId: randomUUID() }, m = lease(), id = String(m.id);
  new LeaseGuard(root, original).observe([m], 0);
  assert.equal(readRecord(join(root, 'lease-execution.json'))[id] && new LeaseGuard(root, original).allowed(id), true);
  const rebooted = { ...original, bootId: randomUUID() }, restored = new LeaseGuard(root, rebooted);
  assert.equal(restored.allowed(id), false);
  restored.observe([{ ...m, lease: { ...(m.lease as RecordValue), revision: 2, authorizationDeadline: 1200 } }], 0);
  assert.equal(restored.allowed(id), false);
  const old = fixture(t), unbound = lease(); new LeaseGuard(old, clock()).observe([unbound], 0);
  assert.equal(new LeaseGuard(old, original).allowed(String(unbound.id)), false);
});

test('clock failure fences every retained lease durably and yields zero native authorization', t => {
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), one = lease(), two = lease();
  guard.observe([one, two], 0);
  c.now = () => { throw new Error('Clock lost'); };
  assert.equal(guard.allowed(String(one.id)), false);
  assert.equal(guard.authorization(String(two.id), String((two.lease as RecordValue).id)).remainingSeconds, 0);
  for (const value of Object.values(readRecord(join(root, 'lease-execution.json')))) assert.equal((value as RecordValue).fenced, true);
  c.now = () => 11;
  const restarted = new LeaseGuard(root, c);
  assert.equal(restarted.allowed(String(one.id)), false);
  assert.equal(restarted.allowed(String(two.id)), false);
});

test('same-boot restart cannot extend the native deadline when wall time lags elapsed time', t => {
  const root = fixture(t), c = { ...clock(), bootId: randomUUID() }, m = lease(), id = String(m.id);
  new LeaseGuard(root, c).observe([m], 0);
  c.mono = 65; c.wallTime = 1000;
  const restored = new LeaseGuard(root, c);
  assert.equal(restored.authorization(id, String((m.lease as RecordValue).id)).remainingSeconds, 5);
  c.mono = 70;
  assert.equal(new LeaseGuard(root, c).allowed(id), false);
  const earlier = { ...c, mono: 66 };
  assert.equal(new LeaseGuard(root, earlier).allowed(id), false);
});

test('expiry between authorization observations produces a durable fence rather than a zero-length grant', t => {
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), m = lease();
  guard.observe([m], 0);
  let observations = 0; c.now = () => ++observations === 1 ? 69 : 70;
  const auth = guard.authorization(String(m.id), String((m.lease as RecordValue).id));
  assert.equal(auth.fenced, true); assert.equal(auth.remainingSeconds, 0);
  assert.equal(new LeaseGuard(root, clock()).allowed(String(m.id)), false);
});
test("lease ownership change and omission fence while ordinary machines remain separate", t => {
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), m = lease(); guard.observe([m], 0);
  assert.equal(guard.neverStarted(String(m.id), String((m.lease as RecordValue).id)), true);
  assert.throws(() => guard.observe([{ ...m, lease: { ...(m.lease as RecordValue), id: randomUUID() } }], 0));
  const ordinary = { id: randomUUID(), desired: "running" }, assignments = guard.assignments([ordinary]);
  assert.equal(assignments.find(x => x.id === ordinary.id)?.desired, "running"); assert.equal(assignments.find(x => x.id === m.id)?.desired, "stopped");
});
test("native duration publication never extends same revision and keeps stop sticky", async t => {
  const root = fixture(t), c = clock(), m = lease(), bootSessionID = randomUUID(); saveRecord(join(root, "runner-launch.json"), { attemptedAt: 1000 });
  let authorization = { leaseID: String((m.lease as RecordValue).id), revision: 1, remainingSeconds: 10, fenced: false };
  const sample = async () => { c.mono++; return { version: 1, bootSessionID, continuous: 500 }; };
  const first = await publishNativeLease(m, root, () => authorization, sample, c); assert.equal(first.deadline, 508.75);
  authorization.remainingSeconds = 100; assert.equal((await publishNativeLease(m, root, () => authorization, sample, c)).deadline, first.deadline);
  authorization.revision++; assert.equal((await publishNativeLease(m, root, () => authorization, sample, c, true)).fenced, true);
  authorization.revision++; assert.equal((await publishNativeLease(m, root, () => authorization, sample, c)).fenced, true);
});
test("shared assignment access restores nested context; durable cleanup denies ordinary work", async t => {
  const root = fixture(t), m = lease(), folder = join(root, "machines", String(m.id));
  await assignmentAccess(m, folder, async () => {
    const first = currentAssignment(); await assignmentAccess(m, folder, async () => { assert.notEqual(currentAssignment(), first); }); assert.equal(currentAssignment(), first);
    assert.throws(() => new StateLock(join(root, "machines", ".assignment-locks", `${m.id}.sqlite`)));
  }); assert.equal(currentAssignment(), undefined);
  saveRecord(join(root, "machines", ".lease-cleanup", `${m.id}.json`), { id: randomUUID() });
  await assert.rejects(assignmentAccess(m, folder, async () => {}));
  await assignmentAccess(m, folder, async () => {}, { exclusive: true });
});
test("recovered launching or uncertain helper records block cleanup without signalling", t => {
  const root = fixture(t), m = lease(), folder = join(root, "machines", String(m.id)), helpers = join(root, "machines", ".assignment-helpers", String(m.id));
  saveRecord(join(helpers, "helper.json"), { version: 2, machineId: m.id, leaseId: (m.lease as RecordValue).id, state: "launching" }); assert.equal(helpersClosed(m, folder), false);
});
test("owned removal is idempotent, protects foreign trees and refuses unexplained absence", async t => {
  const root = fixture(t), storage = join(root, "storage"), folder = join(root, "assignment"), m: RecordValue = { ...lease(), desired: "stopped" }, request = randomUUID(); privateDirectory(storage); privateDirectory(folder);
  const owned = join(storage, String(m.id)), native = join(owned, String(m.id).toUpperCase()); privateDirectory(native);
  saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m) }); saveRecord(join(owned, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(m) });
  writeFileSync(join(native, "disk.img"), "owned"); const foreign = join(root, "foreign"); writeFileSync(foreign, "keep"); symlinkSync(foreign, join(native, "external"));
  const checks = { pidExists: async () => false, diskClosed: async () => true, confirmedStopped: async () => true, withRuntimeLock: async <T>(_path: string, work: () => Promise<T>) => work() };
  assert.equal((await removeAppleStorage(storage, m, folder, request, checks)).state, "complete"); assert.equal((await removeAppleStorage(storage, m, folder, request, checks)).state, "complete");
  assert.equal(readRecord(join(folder, "deletion.json")).state, "complete"); assert.equal(statSync(foreign).size, 4);
  mkdirSync(owned); await assert.rejects(removeAppleStorage(storage, m, folder, request, checks));
});
test("supervised process bounds output and cancellation without shell interpolation", async t => {
  fixture(t); const supervisor = new ProcessSupervisor();
  const result = await supervisor.run([process.execPath, "-e", "process.stdin.on('data',b=>process.stdout.write(b.toString().toUpperCase()))"], { input: "fixture", timeoutMs: 2000 });
  assert.equal(result.code, 0); assert.equal(result.stdout.toString(), "FIXTURE");
  await assert.rejects(supervisor.run([process.execPath, "-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }));
  await assert.rejects(supervisor.run([process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"], { maxOutputBytes: 100 }));
  await supervisor.close();
});
test("PTY rings preserve independent identity, truncation and uncertain close tracking", async () => {
  const handles: Array<PtyHandle & { data?: (data: Uint8Array) => void; closeOK: boolean }> = [];
  const shells = new ShellSessions({ open: async () => { const h: (typeof handles)[number] = { closeOK: false, onData(fn) { this.data = fn; }, onExit() {}, write: async () => {}, resize: async () => {}, close: async () => h.closeOK }; handles.push(h); return h; } });
  const machine = randomUUID(), other = randomUUID(), session = randomUUID(); await shells.open(machine, session, ["shell"]); await shells.open(other, randomUUID(), ["shell"]);
  handles[0]!.data!(Buffer.alloc(70000, 97)); const output = await shells.control(machine, "shell-read", { session, offset: 0 }); assert.equal(output.truncated, true); assert.equal(Buffer.from(String(output.data), "base64").length, 65536);
  await assert.rejects(shells.control(machine, "shell-close", { session })); assert.equal(await shells.revoke(new Set([machine])), false);
  await assert.rejects(shells.open(machine, randomUUID(), ["shell"])); handles[0]!.closeOK = true; assert.equal(await shells.revoke(new Set([machine])), true);
  await assert.rejects(shells.open(machine, session, ["shell"])); handles[1]!.closeOK = true; await shells.sweep(new Set());
});

test("never-started lease cleanup erases only its owned empty storage and credentials with restart receipt", async t => {
  const { cleanupLease } = await import("../../src/runtime-process.ts");
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), m = lease(), id = String(m.id), leaseId = String((m.lease as RecordValue).id), request = randomUUID(); guard.observe([m], 0);
  const terminal: RecordValue = { ...m, desired: "stopped", lease: { ...(m.lease as RecordValue), state: "released" }, leaseCleanup: { id: request, leaseId, attempts: 0 } }; guard.observe([terminal], 0);
  const folder = join(root, "machines", id), storageRoot = join(root, "storage"), storage = join(storageRoot, id); privateDirectory(storage); privateDirectory(folder);
  saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m), leaseId }); saveRecord(join(folder, "access-token.json"), { token: "private" }); saveRecord(join(storage, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(m) });
  const options = { state: root, storageRoot, machine: terminal, folder, guard, now: 1000, closeSessions: async () => {} };
  const result = await cleanupLease(options), receipt = result.leaseCleanup as RecordValue; assert.equal(receipt.state, "complete"); assert.equal(receipt.executionStopped, true); assert.equal(receipt.storageRemoved, true); assert.equal(receipt.credentialsErased, true);
  assert.equal((await cleanupLease(options)).state, "stopped"); assert.throws(() => statSync(folder)); assert.throws(() => statSync(storage));
  guard.retire(id, leaseId, request); assert.deepEqual(guard.assignments([terminal]), []);
  privateDirectory(storage); assert.equal(((await cleanupLease(options)).leaseCleanup as RecordValue).state, "blocked");
});
test("never-started cleanup refuses runtime content and missing helper identity", async t => {
  const { cleanupLease } = await import("../../src/runtime-process.ts");
  const root = fixture(t), c = clock(), guard = new LeaseGuard(root, c), m = lease(), id = String(m.id), leaseId = String((m.lease as RecordValue).id); guard.observe([m], 0);
  const terminal = { ...m, desired: "stopped", lease: { ...(m.lease as RecordValue), state: "expired" }, leaseCleanup: { id: randomUUID(), leaseId, attempts: 0 } }; guard.observe([terminal], 0);
  const folder = join(root, "machines", id), storageRoot = join(root, "storage"), storage = join(storageRoot, id); privateDirectory(storage); privateDirectory(folder);
  saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m), leaseId }); saveRecord(join(storage, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(m) }); writeFileSync(join(storage, "disk.img"), "unknown disk");
  const options = { state: root, storageRoot, machine: terminal, folder, guard, now: 1000, closeSessions: async () => {} };
  const blocked = await cleanupLease(options); assert.equal((blocked.leaseCleanup as RecordValue).state, "blocked"); assert.equal(statSync(join(storage, "disk.img")).size, 12);
  saveRecord(join(root, "machines", ".assignment-helpers", id, "helper.json"), { state: "launching", machineId: id, leaseId });
  assert.equal(((await cleanupLease(options)).leaseCleanup as RecordValue).reason, "operations_pending");
});
test("retired assignments never revive through stale delivery after restart", t => {
  const root = fixture(t), c = clock(), m = lease(), guard = new LeaseGuard(root, c), leaseId = String((m.lease as RecordValue).id), cleanupId = randomUUID();
  const completed = { ...m, leaseCleanup: { id: cleanupId, leaseId } }; guard.observe([completed], 0); guard.retire(String(m.id), leaseId, cleanupId);
  const restored = new LeaseGuard(root, c); restored.observe([m], 0); assert.deepEqual(restored.assignments([m]), []); assert.equal(restored.allowed(String(m.id)), false);
});

test("provisioning phase stays sticky and contradictory launch metadata blocks preboot erasure", async t => {
  const { prebootStorage, recordPreparation } = await import("../../src/runtime-process.ts");
  const root = fixture(t), m = lease(), folder = join(root, "machines", String(m.id)), storage = join(root, "storage", String(m.id)); privateDirectory(folder); privateDirectory(storage);
  saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m), leaseId: (m.lease as RecordValue).id }); saveRecord(join(storage, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(m) });
  const journal = recordPreparation(m, folder, true); assert.equal(journal.phase, "preparing"); assert.equal(prebootStorage(m, folder, storage), true);
  const native = join(storage, String(m.id).toUpperCase()); saveRecord(join(native, "runner-launch.json"), { attemptedAt: 1000 }); assert.throws(() => prebootStorage(m, folder, storage));
  saveRecord(join(folder, "provisioning.json"), { ...journal, phase: "bootRequested" }); assert.equal(recordPreparation(m, folder, true).phase, "bootRequested"); assert.equal(prebootStorage(m, folder, storage), false);
});
test("native fence requires process absence, closed handles and runtime lock proof", async t => {
  const { confirmFenced } = await import("../../src/runtime-process.ts");
  const root = fixture(t), m = lease(); saveRecord(join(root, "runner-launch.json"), { attemptedAt: 1000 }); saveRecord(join(root, "lease-fenced.json"), { machineID: m.id, leaseID: (m.lease as RecordValue).id, boot: 1000, pid: 12345 });
  let alive = true, diskClosed = false; const checks = { pidExists: async () => alive, diskClosed: async () => diskClosed, withRuntimeLock: async <T>(_path: string, work: () => Promise<T>) => work() };
  assert.equal(await confirmFenced(m, root, checks), false); alive = false; assert.equal(await confirmFenced(m, root, checks), false); diskClosed = true; assert.equal(await confirmFenced(m, root, checks), true);
  assert.equal(readRecord(join(root, "fenced-stop.json")).leaseID, (m.lease as RecordValue).id);
  saveRecord(join(root, "lease-fenced.json"), { machineID: m.id, leaseID: randomUUID(), boot: 1000, pid: 12345 }); await assert.rejects(confirmFenced(m, root, checks));
});
