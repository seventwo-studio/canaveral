import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHost, HostRunner, hostOffer, hostTransport, startHost } from "../../src/host.ts";
import type { HostConfig, HostDependencies, HostTransport } from "../../src/host.ts";
import { normalizeTemplate } from "../../src/control/templates.ts";
import { validateOffer } from "../../src/control/machines.ts";
import { assignmentFingerprint, readRecord, saveRecord, StateLock } from "../../src/runtime-process.ts";
import type { ExecutionClock, RecordValue } from "../../src/runtime-process.ts";
import { ServiceError } from "../../src/errors.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import { digest } from "../../src/providers/mobile.ts";
const token = "a".repeat(43);
function setup(t: { after(fn: () => void | Promise<void>): void }): { config: HostConfig; image: RecordValue; clock: ExecutionClock & { mono: number; wallTime: number } } {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-host-runner-"))); t.after(() => rmSync(state, { recursive: true, force: true }));
  const image = { id: "fixture", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, image: "/private/local/disk.img" };
  const config: HostConfig = { name: "fixture", provider: "libvirt", templates: [image], storage: join(state, "disks"), capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 128 }, url: "http://127.0.0.1:1", stateDir: state, enrollmentToken: token, pollIntervalSeconds: .25 };
  const clock = { mono: 10, wallTime: 1000, suspendAware: true, now() { return this.mono; }, wall() { return this.wallTime; } };
  return { config, image, clock };
}
function machine(image: RecordValue): RecordValue { return { id: randomUUID(), templateId: image.id, template: normalizeTemplate(image), resources: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, desired: "running", observed: "unknown" }; }
function fakeTransport(reply: () => RecordValue = () => ({ machines: [] })): HostTransport { return { request: async (_method, path) => path.endsWith("heartbeat") ? reply() : {} }; }
const providerFactory: NonNullable<HostDependencies["providerFactory"]> = () => ({ kind: "libvirt", check: async () => ({}), reconcile: async m => ({ state: m.desired }) });
async function drain(): Promise<void> { await new Promise(r => setTimeout(r, 20)); }

function maintenanceReplies() {
  const drainId = randomUUID();
  let response: RecordValue = { machines: [] }, challenge = 0, lastChallenge: string | undefined;
  let request: RecordValue = {};
  const transport: HostTransport = { request: async (_method, path, body) => {
    if (!path.endsWith("heartbeat")) return {};
    request = body.maintenance as RecordValue;
    assert.equal(request.version, 1);
    if (request.proof) assert.equal((request.proof as RecordValue).challenge, lastChallenge, "proof must answer only the preceding response");
    lastChallenge = (response.maintenance as RecordValue | undefined)?.challenge as string | undefined;
    return response;
  } };
  return {
    transport, set: (body: RecordValue) => { response = body; }, get request() { return request; },
    draining: () => ({ version: 1, phase: "draining", drainId, challenge: (++challenge).toString(16).padStart(64, "0") }),
    resumed: { version: 1, phase: "resumed", drainId }, open: { version: 1, phase: "open", drainId: null },
  };
}
const drainingError = (error: unknown) => error instanceof ServiceError && error.code === "host_draining";

test("maintenance fences local access independently of updates and survives older replies", async t => {
  const { config, image, clock } = setup(t), m = machine(image), fixture = maintenanceReplies();
  let controls = 0;
  const runner = new HostRunner(config, { clock, transport: fixture.transport, providerFactory, guest: { control: async () => ({ controls: ++controls }) } });
  t.after(() => runner.close());
  const operation = { action: "health", arguments: {} };
  await runner.initializeProviders(); await runner.connect();
  fixture.set({ machines: [m] }); await runner.poll();
  assert.deepEqual(fixture.request, { version: 1 });
  await runner.accessControl(String(m.id), operation);
  fixture.set({ machines: [m], maintenance: fixture.draining(), deviceOperations: [{}] });
  clock.mono++; await assert.rejects(runner.poll()); assert.equal(runner.lastContact, 10);
  await runner.accessControl(String(m.id), operation);
  fixture.set({ machines: [m], maintenance: fixture.draining() }); await runner.poll();
  assert.equal(runner.updateAdmissionFenced, false);
  runner.fenceUpdateAdmission(); runner.resumeUpdateAdmission();
  const folder = runner.context(m).folder;
  await assert.rejects(runner.accessControl(String(m.id), operation), drainingError);
  await assert.rejects(runner.guestAccess.control(m, image, folder, operation), drainingError);
  await assert.rejects(runner.guestAccess.streamUpload!(m, image, folder, "/", undefined, { read: () => Buffer.alloc(0) }, 0, () => true), drainingError);
  await assert.rejects(runner.guestAccess.streamDownload!(m, image, folder, "/"), drainingError);
  await assert.rejects(runner.guestAccess.desktop!(m, image, folder), drainingError);
  await assert.rejects(runner.importImage({}, { read: () => Buffer.alloc(0) }, 0, () => true), drainingError);
  assert.throws(() => runner.beginLocalWork(), drainingError);
  fixture.set({ machines: [m], maintenance: { ...fixture.open, version: 2 } }); clock.mono++;
  await assert.rejects(runner.poll()); assert.equal(runner.lastContact, 11);
  fixture.set({ machines: [m] }); await runner.poll(); await runner.poll();
  assert.deepEqual(fixture.request, { version: 1 });
  await assert.rejects(runner.accessControl(String(m.id), operation), drainingError);
  runner.fenceUpdateAdmission();
  fixture.set({ machines: [m], maintenance: fixture.resumed }); await runner.poll();
  assert.equal(runner.updateAdmissionFenced, true);
  await assert.rejects(runner.accessControl(String(m.id), operation), /update admission/);
  runner.resumeUpdateAdmission();
  await runner.accessControl(String(m.id), operation);
  fixture.set({ machines: [m], maintenance: fixture.draining() }); await runner.poll();
  fixture.set({ machines: [m], maintenance: fixture.open }); await runner.poll();
  await runner.accessControl(String(m.id), operation);
  assert.equal(controls, 4);
});

test("a committed image import remains accounted for during maintenance", async t => {
  const { config, clock } = setup(t), fixture = maintenanceReplies();
  const runner = new HostRunner(config, { clock, transport: fixture.transport, providerFactory });
  t.after(() => runner.close());
  await runner.initializeProviders(); await runner.connect();
  fixture.set({ machines: [], maintenance: fixture.draining() }); await runner.poll();
  assert.equal((await runner.updateIdle()).idle, true);
  const metadata = { id: randomUUID(), name: "fixture import", os: "linux", arch: process.arch === "arm64" ? "arm64" : "amd64",
    mode: "headless", mediaType: "disk", format: "raw", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
  const work = runner.importImage(metadata, { async read(n) { started(); await hold; return Buffer.alloc(n); } }, 512, () => true, true);
  try {
    await Promise.race([reading, work]);
    assert.equal((await runner.updateIdle()).idle, false);
  } finally { release(); }
  assert.equal((await work).id, metadata.id);
  assert.equal((await runner.updateIdle()).idle, true);
});

test("maintenance preserves active and queued controller work including delivered machine starts", async t => {
  const { config, image, clock } = setup(t), m = machine(image), fixture = maintenanceReplies();
  const first = { id: randomUUID() }, second = { id: randomUUID() }, imageTask = { id: randomUUID() };
  const device = { id: randomUUID(), machineId: m.id, action: "health", arguments: {}, expiresAt: 1100 };
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { started = resolve; });
  const ran = new Set<string>(); let aborted = false;
  const runner = new HostRunner(config, {
    clock, transport: fixture.transport,
    providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async current => { ran.add(String(current.id)); return { state: "running" }; }, operate: async () => { ran.add(device.id); return { state: "succeeded" }; } }),
    inference: { execute: async (task, context) => {
      if (task.id === first.id) { context.signal.addEventListener("abort", () => { aborted = true; }); started(); await hold; assert.ok(context.authorized()); }
      ran.add(String(task.id)); return { state: "succeeded", stopped: true };
    } },
    images: { execute: async () => { ran.add(imageTask.id); return { state: "succeeded" }; } },
  });
  t.after(async () => { release(); await runner.close(); });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment();
  fixture.set({ machines: [], inferenceJobs: [first] }); await runner.poll(); await runner.step(); await running;
  fixture.set({ machines: [m], deviceOperations: [device], inferenceJobs: [first, second], imageTasks: [imageTask], maintenance: fixture.draining() });
  await runner.poll(); await runner.step(); await drain(); assert.equal(aborted, false);
  release();
  for (let i = 0; i < 3; i++) { await runner.step(); await drain(); }
  assert.deepEqual(ran, new Set([first.id, second.id, imageTask.id, device.id, String(m.id)]));
  assert.equal(aborted, false);
});

async function inventoryProof(runner: HostRunner, fixture: ReturnType<typeof maintenanceReplies>, machines: RecordValue[]): Promise<RecordValue> {
  for (let i = 0; i < 50; i++) {
    fixture.set({ machines, maintenance: fixture.draining() });
    await runner.poll();
    if (fixture.request.proof) return fixture.request.proof as RecordValue;
    await drain();
  }
  assert.fail("Maintenance proof never became ready");
}

test("maintenance proof cannot stall heartbeats, replay a superseded probe, or send a failed probe", async t => {
  const { config, image, clock } = setup(t), m: RecordValue = { ...machine(image), desired: "stopped" }, fixture = maintenanceReplies();
  let release!: () => void, started!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { started = resolve; });
  let probes = 0, fail = true, onFailed!: () => void;
  const failed = new Promise<void>(resolve => { onFailed = resolve; });
  const provider = { kind: "libvirt", check: async () => ({}), reconcile: async () => assert.fail("Inspection must not reconcile"),
    maintenanceStorage: async () => "present" as const,
    updateStopped: async () => { assert.deepEqual(runner.assignments, [m]); if (++probes === 1) { started(); await hold; } if (fail) throw new Error("inspection failure"); return true; } };
  const runner = new HostRunner(config, { clock, transport: fixture.transport, providerFactory: () => provider, log: onFailed });
  t.after(async () => { release(); await runner.close(); });
  saveRecord(join(config.stateDir, "machines", String(m.id), "assignment.json"), { fingerprint: assignmentFingerprint(m) });
  await runner.initializeProviders(); await runner.connect();
  fixture.set({ machines: [m], maintenance: fixture.draining() });
  await runner.poll(); assert.deepEqual(fixture.request, { version: 1 }); await running;
  fixture.set({ machines: [m], maintenance: fixture.draining() });
  await runner.poll(); assert.deepEqual(fixture.request, { version: 1 });
  release(); await failed;
  fixture.set({ machines: [m], maintenance: fixture.draining() });
  await runner.poll(); assert.deepEqual(fixture.request, { version: 1 });
  fail = false;
  const proof = await inventoryProof(runner, fixture, [m]);
  assert.equal(proof.idle, true); assert.equal(proof.workloadsStopped, true);
});

test("maintenance inventories stopped backing storage after runner restart and reports missing and unsafe paths", async t => {
  const { config, image, clock } = setup(t), fixture = maintenanceReplies();
  const stopped = (): RecordValue => ({ ...machine(image), desired: "stopped", observed: "stopped" });
  const stored = stopped(), missing = stopped(), linked = stopped(), uncreated = stopped(), machines = [stored, missing, linked, uncreated];
  const deletion = { id: randomUUID() }, retired: RecordValue = { ...stopped(), deletion };
  let reconciles = 0;
  const runtime = { kind: "apple", config, check: async () => ({}), reconcile: async () => { reconciles++; return { state: "stopped" }; }, updateStopped: async () => true };
  const stateDir = config.stateDir, storage = String(config.storage);
  const disk = (m: RecordValue) => join(storage, String(m.id), String(m.id).toUpperCase(), "disk.img");
  const dependencies = { clock, transport: fixture.transport, providerFactory: () => runtime };
  const first = new HostRunner(config, dependencies);
  await first.initializeProviders(); await first.connect();
  for (const m of machines) {
    saveRecord(join(stateDir, "machines", String(m.id), "assignment.json"), { fingerprint: assignmentFingerprint(m) });
    saveRecord(join(storage, String(m.id), "canaveral-owner.json"), { fingerprint: assignmentFingerprint(m) });
    if (m === uncreated) continue;
    mkdirSync(join(storage, String(m.id), String(m.id).toUpperCase()));
    writeFileSync(disk(m), "persistent fixture disk", { mode: 0o600 });
  }
  const retiredFolder = join(stateDir, "machines", String(retired.id));
  saveRecord(join(retiredFolder, "assignment.json"), { fingerprint: assignmentFingerprint(retired) });
  saveRecord(join(retiredFolder, "deletion.json"), { id: deletion.id, machineId: retired.id, fingerprint: assignmentFingerprint(retired), state: "complete" });
  fixture.set({ machines: [...machines, retired], maintenance: fixture.draining() }); await first.poll(); await first.close();
  assert.equal((readRecord(join(stateDir, "update-assignments.json")).machines as unknown[]).length, 5);
  const restarted = { ...config }; delete restarted.enrollmentToken;
  const runner = new HostRunner(restarted, dependencies);
  t.after(() => runner.close());
  await runner.initializeProviders(); await runner.connect(); await runner.step();
  assert.deepEqual(runner.identity, first.identity);
  assert.deepEqual(runner.assignments, []); assert.equal(reconciles, 0);
  const expected = (storage: string) => machines.map(m => ({ id: m.id, storage, stopProof: "native" }));
  let proof = await inventoryProof(runner, fixture, machines);
  assert.deepEqual(proof.inventory, { complete: true, unexpected: [], assignments: expected("present").map(a => a.id === uncreated.id ? { ...a, storage: "notMaterialized" } : a) });
  const orphan = stopped();
  saveRecord(join(storage, String(orphan.id), "canaveral-owner.json"), { fingerprint: assignmentFingerprint(orphan) });
  mkdirSync(join(storage, String(orphan.id), String(orphan.id).toUpperCase()));
  writeFileSync(disk(orphan), "orphaned fixture disk", { mode: 0o600 });
  fixture.set({ machines, maintenance: fixture.draining() }); await runner.poll();
  proof = await inventoryProof(runner, fixture, machines);
  assert.deepEqual((proof.inventory as RecordValue).unexpected, [orphan.id]);
  assert.equal(proof.idle, false);
  rmSync(join(storage, String(orphan.id)), { recursive: true });
  rmSync(disk(missing)); rmSync(disk(linked)); symlinkSync(disk(stored), disk(linked));
  const unexpected = randomUUID();
  mkdirSync(join(stateDir, "machines", unexpected)); writeFileSync(join(stateDir, "machines", "unrelated-file"), "");
  // Changing the challenge drops the previously collected sample.
  fixture.set({ machines, maintenance: fixture.draining() }); await runner.poll();
  proof = await inventoryProof(runner, fixture, machines);
  assert.deepEqual(proof.inventory, { complete: true, unexpected: [unexpected], assignments: expected("present").map((a, i) => ({ ...a, storage: ["present", "absent", "unknown", "notMaterialized"][i] })) });
  assert.equal(proof.idle, false); assert.equal(reconciles, 0);
});

test("maintenance and update idle verify assignment bookkeeping before excluding it", async t => {
  const { config, clock } = setup(t), fixture = maintenanceReplies();
  const runner = new HostRunner(config, { clock, transport: fixture.transport, providerFactory });
  t.after(() => runner.close());
  const root = join(config.stateDir, "machines"), locks = join(root, ".assignment-locks"), cleanups = join(root, ".lease-cleanup");
  const id = randomUUID(), receipt = join(cleanups, `${id}.json`);
  const proof = { id: randomUUID(), machineId: id, leaseId: randomUUID(), attempt: 1, phase: "complete", fingerprint: "f".repeat(64) };
  const lockPath = join(locks, `${id}.sqlite`);
  new StateLock(lockPath).close();
  new StateLock(`${receipt}.sqlite`).close();
  saveRecord(receipt, proof);
  await runner.initializeProviders(); await runner.connect();

  const inventory = async (unexpected: string[]) => {
    fixture.set({ machines: [], maintenance: fixture.draining() }); await runner.poll();
    const report = await inventoryProof(runner, fixture, []);
    assert.deepEqual(report.inventory, { complete: true, assignments: [], unexpected });
    const idle = unexpected.length === 0;
    assert.equal(report.idle, idle);
    assert.deepEqual(await runner.updateIdle(true), { idle, workloadsStopped: idle });
  };

  await inventory([]);
  assert.deepEqual(readRecord(receipt), proof, "inspection leaves the cleanup receipt intact");

  for (const phase of ["planned", "unstarted", "preboot", "storageRemoved", "erasing", "removing"]) {
    saveRecord(receipt, { ...proof, phase });
    await inventory([".lease-cleanup"]);
  }
  saveRecord(receipt, proof);
  await inventory([]);

  chmodSync(locks, 0o755);
  saveRecord(receipt, { ...proof, machineId: randomUUID() });
  await inventory([".assignment-locks", ".lease-cleanup"]);

  chmodSync(locks, 0o700);
  rmSync(lockPath);
  const unrelated = new DatabaseSync(lockPath);
  try { unrelated.exec("CREATE TABLE foreign_data (id INTEGER PRIMARY KEY)"); } finally { unrelated.close(); }
  await inventory([".assignment-locks", ".lease-cleanup"]);

  rmSync(locks, { recursive: true });
  rmSync(cleanups, { recursive: true });
  const foreign = join(config.stateDir, "foreign");
  mkdirSync(foreign, { mode: 0o700 });
  symlinkSync(foreign, locks);
  writeFileSync(cleanups, "foreign entry", { mode: 0o600 });
  await inventory([".assignment-locks", ".lease-cleanup"]);
});

test("maintenance reports unexplained removal quarantines in Apple and libvirt storage", async t => {
  for (const kind of ["apple", "libvirt"]) await t.test(kind, async t => {
    const { config, image, clock } = setup(t), fixture = maintenanceReplies(), storage = String(config.storage);
    const deletion = { id: randomUUID(), state: "complete" }, cleanup = { id: randomUUID(), state: "blocked" };
    const removed = { ...machine(image), desired: "stopped", deletion } as RecordValue;
    const cleaning = { ...machine(image), desired: "stopped", leaseCleanup: cleanup } as RecordValue;
    const quarantine = (machineId: unknown, requestId: string) => `.removing-${machineId}-${requestId}`;
    const leftover = quarantine(removed.id, deletion.id), active = quarantine(cleaning.id, cleanup.id);
    const wrongRequest = quarantine(cleaning.id, randomUUID()), orphan = quarantine(randomUUID(), randomUUID());
    for (const name of [leftover, active, wrongRequest, orphan]) mkdirSync(join(storage, name), { recursive: true });
    const runtime = { kind, config, check: async () => ({}), reconcile: async () => assert.fail("Inspection must not reconcile") };
    const runner = new HostRunner(config, { clock, transport: fixture.transport, providerFactory: () => runtime });
    t.after(() => runner.close());
    await runner.initializeProviders(); await runner.connect();
    let proof = await inventoryProof(runner, fixture, [removed, cleaning]);
    assert.deepEqual((proof.inventory as RecordValue).unexpected, [leftover, wrongRequest, orphan].sort());
    fixture.set({ machines: [{ ...removed, deletion: { ...deletion, state: "running" } }], maintenance: fixture.draining() });
    await runner.poll();
    proof = await inventoryProof(runner, fixture, [{ ...removed, deletion: { ...deletion, state: "running" } }]);
    assert.deepEqual((proof.inventory as RecordValue).unexpected, [active, wrongRequest, orphan].sort());
  });
});

test("maintenance accounts for mobile removal quarantine and verifies completed mobile deletion journals", async t => {
  for (const kind of ["android", "ios"]) await t.test(kind, async t => {
    const { config, image, clock } = setup(t), fixture = maintenanceReplies();
    const mobile = { id: image.id, revision: "1", os: kind, mode: "device", arch: "arm64", minimum: image.minimum,
      device: kind === "android" ? { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } :
        { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" } };
    const deletion = { id: randomUUID(), state: "queued" };
    const m = { ...machine(mobile), desired: "stopped", observed: "stopped", deletion } as RecordValue;
    const runtime = new (kind === "android" ? AndroidProvider : IosProvider)({ storage: config.storage }, config.stateDir);
    const runner = new HostRunner({ ...config, provider: kind, templates: [mobile] }, { clock, transport: fixture.transport, providerFactory: () => runtime });
    t.after(() => runner.close());
    await runner.initializeProviders(); await runner.connect();
    const folder = join(config.stateDir, "machines", String(m.id)), receipt = join(folder, "deletion.json");
    saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(m) });
    if (kind === "android") {
      const quarantine = join(String(config.storage), `.removing-${m.id}-${deletion.id}`);
      mkdirSync(quarantine, { recursive: true });
      const active = await inventoryProof(runner, fixture, [m]);
      assert.deepEqual((active.inventory as RecordValue).unexpected, []);
      rmSync(quarantine, { recursive: true });
    } else {
      fixture.set({ machines: [m], maintenance: fixture.draining() }); await runner.poll();
    }
    const complete = { id: deletion.id, machineId: m.id, state: "complete", fingerprint: "wrong" };
    saveRecord(receipt, complete);
    const wrong = await inventoryProof(runner, fixture, []);
    assert.deepEqual((wrong.inventory as RecordValue).unexpected, [m.id]);
    saveRecord(receipt, { ...complete, fingerprint: digest(runtime.binding(m, { ...mobile, ...normalizeTemplate(mobile) })) });
    fixture.set({ machines: [], maintenance: fixture.draining() }); await runner.poll();
    const retired = await inventoryProof(runner, fixture, []);
    assert.deepEqual(retired.inventory, { complete: true, unexpected: [], assignments: [] });
  });
});

test("a failed runtime sweep does not stop Linux scheduling and remains a shutdown failure", async t => {
  const {config,image,clock} = setup(t), running = machine(image), stopped = {...machine(image),desired:"stopped"};
  let reconciled=0, shells=0, sweeps=0;
  const runner = new HostRunner(config,{clock,transport:fakeTransport(()=>({machines:[running,stopped]})),providerFactory:()=>({kind:"libvirt",check:async()=>({}),
    reconcile:async m=>{reconciled++;return {state:m.desired};},sweep:async()=>{sweeps++;throw Error("fixture sweep failure");},closeShells:async()=>{shells++;}})});
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  await runner.step(); await drain(); assert.equal(reconciled,2); assert.ok(shells>0);
  await runner.step(); await drain(); assert.ok(reconciled>=4); assert.ok(sweeps>=2);
  await assert.rejects(runner.close(),(error:unknown)=>error instanceof ServiceError && error.code==="host_shutdown_incomplete");
});

test('physical Linux and Mac offers include models beside VM and simulator runtimes', t => {
  const { config } = setup(t);
  const inference = { runtime: 'ollama', executable: '/private/ollama', modelsDirectory: '/private/models', models: [{ id: 'fixture:1', digest: 'sha256:' + 'a'.repeat(64), resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }] };
  for (const [provider, runtimes] of [['macos', { apple: {}, android: {}, ios: {} }], ['linux', { libvirt: {}, android: {} }]] as const) {
    const offer = hostOffer({ ...config, provider, templates: [], runtimes, inference });
    assert.deepEqual(validateOffer(offer), offer);
    assert.deepEqual((offer.inference as { models: unknown[] }).models, inference.models.map(model => ({ ...model, capability: 'generation' })));
    assert.equal(JSON.stringify(offer).includes('/private/'), false);
    assert.throws(() => hostOffer({ ...config, provider, templates: [], runtimes, inference, leaseProtocol: 1 }));
  }
  assert.throws(() => hostOffer({ ...config, provider: 'windows', templates: [], runtimes: { hyperv: {} }, inference }));
});

test("enrollment persists one private identity before lost response, retries exactly, and reconnects without enrollment", async t => {
  const { config, clock } = setup(t); let attempts = 0; const enrollments: RecordValue[] = [];
  const transport: HostTransport = { request: async (_m, path, body) => { if (path.endsWith("enroll")) { enrollments.push(body); attempts++; if (attempts === 1) throw new Error("lost reply"); } return { machines: [] }; } };
  const first = new HostRunner(config, { transport, clock, providerFactory }); await assert.rejects(first.connect());
  const identity = readRecord(join(config.stateDir, "identity.json")); assert.equal(statSync(join(config.stateDir, "identity.json")).mode & 0o777, 0o600);
  await first.connect(); assert.deepEqual(enrollments[0], enrollments[1]); assert.equal(first.identity?.id, identity.id);
  const restored = new HostRunner({ ...config, enrollmentToken: undefined } as unknown as HostConfig, { transport, clock, providerFactory }); await restored.connect(); assert.equal(attempts, 2); assert.equal(restored.identity?.id, identity.id); await first.close(); await restored.close();
});
test("wrong controller and invalid trust bundle cannot replace a saved host identity", async t => {
  const { config } = setup(t), runner = new HostRunner(config, { transport: fakeTransport() }); await runner.connect(); const before = readRecord(join(config.stateDir, "identity.json"));
  const other = new HostRunner({ ...config, url: "http://127.0.0.1:2" }, { transport: fakeTransport() }); await assert.rejects(other.connect()); assert.deepEqual(readRecord(join(config.stateDir, "identity.json")), before);
  assert.throws(() => new HostRunner({ ...config, caFile: join(config.stateDir, "missing.pem") })); await runner.close(); await other.close();
});
test("heartbeat uses current on-disk credential, dispatch freshness, exact report fields and cached telemetry", async t => {
  const { config, clock } = setup(t); let heartbeatToken = "", body: RecordValue = {};
  const transport: HostTransport = { request: async (_m, path, data, auth) => { if (path.endsWith("heartbeat")) { body = data; heartbeatToken = auth; clock.mono += 21; } return { machines: [] }; } };
  const runner = new HostRunner(config, { transport, clock, providerFactory }); await runner.connect();
  const identity = readRecord(join(config.stateDir, "identity.json")); saveRecord(join(config.stateDir, "identity.json"), { ...identity, credential: "b".repeat(43) });
  await runner.collectResources(); await runner.poll(); assert.equal(heartbeatToken, "b".repeat(43)); assert.equal(runner.lastContact, 10); assert.equal(runner.fresh(), false); assert.equal("sessionReports" in body, false); assert.ok(body.resources); assert.equal(JSON.stringify(body).includes("/private/local"), false); await runner.close();
});
test("bounded reconciliation continues independent heartbeat polling while provider is occupied", async t => {
  const { config, image, clock } = setup(t), assigned = [machine(image), machine(image), machine(image)]; let started = 0, polls = 0; const releases: Array<() => void> = [];
  const runner = new HostRunner({ ...config, concurrency: 2 }, { clock, transport: { request: async (_m, path) => { if (path.endsWith("heartbeat")) polls++; return { machines: assigned }; } }, providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => { started++; await new Promise<void>(r => releases.push(r)); return { state: "running" }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll(); await runner.step(); await drain(); assert.equal(started, 2);
  await runner.poll(); assert.equal(polls, 2); await runner.step(); assert.equal(started, 2);
  releases.forEach(r => r()); await drain(); await runner.close();
});
test("stopped reconciliation bypasses guest preparation and credentials; template and ownership changes are refused", async t => {
  const { config, image } = setup(t), m: RecordValue = { ...machine(image), desired: "stopped" }; let calls = 0;
  const local = { ...image, prepare: { driver: "ssh", commands: ["false"] } }; m.template = normalizeTemplate(local);
  const runner = new HostRunner({ ...config, templates: [local] }, { transport: fakeTransport(), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => { calls++; return { state: "stopped" }; } }) });
  await runner.initializeProviders(); assert.equal((await runner.reconcile(m)).state, "stopped"); assert.equal(calls, 1);
  const folder = join(config.stateDir, "machines", String(m.id)); assert.throws(() => statSync(join(folder, "guest-token.json")));
  saveRecord(join(folder, "assignment.json"), { fingerprint: "foreign" }); await assert.rejects(runner.reconcile(m)); assert.equal(calls, 1); await runner.close();
});
test("durable interrupted device effects become unknown and never replay after restart", async t => {
  const { config, image, clock } = setup(t), m = machine(image), operation = { id: randomUUID(), machineId: m.id, action: "shell", arguments: { argv: ["private-value"] }, expiresAt: 1100 }; let calls = 0;
  const transport = fakeTransport(() => ({ machines: [m], deviceOperations: [operation] }));
  const factory: NonNullable<HostDependencies["providerFactory"]> = () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => ({ state: "running" }), operate: async () => { calls++; throw new Error("response lost"); } });
  const run = async (): Promise<HostRunner> => { const r = new HostRunner(config, { clock, transport, providerFactory: factory }); await r.initializeProviders(); await r.connect(); await r.checkEnvironment(); await r.poll(); r.reports.set(String(m.id), { state: "running" }); return r; };
  const first = await run(); await first.step(); await drain(); assert.equal(first.deviceReports.get(operation.id)?.state, "unknown"); await first.close();
  const second = await run(); await second.step(); await drain(); assert.equal(calls, 1); assert.equal(second.deviceReports.get(operation.id)?.state, "unknown"); await second.close();
});
test("lease configuration cannot enable unaccepted execution; offline only reconciles fenced stops", async t => {
  const { config, image, clock } = setup(t), id = randomUUID(), m: RecordValue = { ...machine(image), lease: { id, revision: 1, state: "ready", controllerNow: 1000, authorizationDeadline: 1060 } };
  assert.throws(() => hostOffer({ ...config, leaseProtocol: 1 })); assert.throws(() => hostOffer({ ...config, leaseImages: [] }));
  const requests: RecordValue[] = [];
  const runner = new HostRunner(config, { clock, transport: fakeTransport(() => ({ machines: [m, machine(image)] })), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async current => { requests.push(current); return { state: "stopped" }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.poll(); clock.mono = 70; await runner.step(); await drain(); assert.equal(requests.length, 1); assert.equal(requests[0]!.desired, "stopped"); assert.equal(requests[0]!.id, m.id); await runner.close();
});

test('failed clock contact denies new work while retained leased stops still reconcile', async t => {
  const { config, image, clock } = setup(t), id = randomUUID();
  const m: RecordValue = { ...machine(image), lease: { id, revision: 1, state: 'ready', controllerNow: 1000, authorizationDeadline: 1060 } };
  const requests: RecordValue[] = [];
  const runner = new HostRunner(config, { clock, transport: fakeTransport(() => ({ machines: [m, machine(image)] })), providerFactory: () => ({ kind: 'libvirt', check: async () => ({}), reconcile: async current => { requests.push(current); return { state: 'stopped' }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.poll();
  clock.now = () => { throw new Error('Clock lost'); };
  assert.equal(runner.fresh(), false);
  await runner.step(); await drain();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.id, m.id); assert.equal(requests[0]!.desired, 'stopped');
  await runner.close();
});

test('invalid native clock configuration is refused before creating runner state', t => {
  const { config } = setup(t), stateDir = join(config.stateDir, 'new-runner');
  assert.throws(() => new HostRunner({ ...config, stateDir, leaseClockHelper: join(config.stateDir, 'missing') }, { transport: fakeTransport() }));
  assert.throws(() => new HostRunner({ ...config, stateDir, leaseClockHelper: process.execPath, leaseProtocol: 1 }, { transport: fakeTransport() }), error => error instanceof ServiceError && error.status === 400 && /cannot advertise lease execution/.test(error.message));
  assert.equal(existsSync(stateDir), false);
});
test("failed provider startup closes earlier providers and releases runner lock", async t => {
  const { config } = setup(t); let closed = 0;
  await assert.rejects(startHost({ ...config, provider: "linux", templates: [], runtimes: { libvirt: {}, android: {} } }, { transport: fakeTransport(), providerFactory: options => { if (options.provider === "android") throw new Error("failure"); return { kind: "libvirt", check: async () => ({}), reconcile: async () => ({}), close: async () => { closed++; } }; } }));
  assert.equal(closed, 1); const lock = new StateLock(join(config.stateDir, "host-runner.sqlite")); lock.close();
});
test("offline environment checks never enroll or create identity", async t => {
  const { config } = setup(t); let contacts = 0; const result = await checkHost(config, { transport: { request: async () => { contacts++; return {}; } }, providerFactory }); assert.equal(result.status, "passed"); assert.equal(contacts, 0); assert.throws(() => statSync(join(config.stateDir, "identity.json")));
});
test("outbound HTTP refuses redirects and never forwards host bearer credentials", async t => {
  const { config } = setup(t); let redirected = false;
  const server = createServer((request, response) => { if (request.url === "/v1/redirected") redirected = true; response.writeHead(302, { Location: "/v1/redirected" }); response.end("{}"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise<void>((r, e) => server.close(error => error ? e(error) : r())));
  const address = server.address(); assert.ok(address && typeof address === "object"); const transport = hostTransport({ ...config, url: `http://127.0.0.1:${address.port}` });
  await assert.rejects(transport.request("POST", "/v1/hosts/enroll", {}, token)); assert.equal(redirected, false);
});

test("consolidated runtime guest callback overrides host URL during preparation", async t => {
  const { config, image, clock } = setup(t), local = { ...image, prepare: { driver: "cloud-init", commands: ["true"] } }, m = machine(local);
  let data = "";
  const runner = new HostRunner({ ...config, templates: [local], guestOrchestratorURL: "https://wrong.invalid" }, { clock, transport: fakeTransport(), providerFactory: () => ({ kind: "libvirt", config: { guestOrchestratorURL: "https://guests.example.test" }, check: async () => ({}), reconcile: async (_m, i) => { data = String(i._userData); return { state: "running" }; } }) });
  await runner.initializeProviders(); runner.assignments = [m]; runner.lastContact = 10;
  await runner.reconcile(m); assert.ok(data.includes("cloud-config")); assert.ok(Buffer.from(data.match(/"content":"([^"]+)"/)![1]!, "base64").toString().includes("https://guests.example.test")); assert.equal(data.includes("wrong.invalid"), false); await runner.close();
});
test("device operations wait for an active reconciliation of the same machine", async t => {
  const { config, image, clock } = setup(t), m = machine(image), operation = { id: randomUUID(), machineId: m.id, action: "shell", arguments: { argv: ["true"] }, expiresAt: 1100 };
  let queued: RecordValue[] = [], reconciling = 0, overlapped = 0, operated = 0; const releases: Array<() => void> = [];
  const runner = new HostRunner(config, { clock, transport: fakeTransport(() => ({ machines: [m], deviceOperations: queued })), providerFactory: () => ({ kind: "libvirt", check: async () => ({}),
    reconcile: async () => { reconciling++; await new Promise<void>(r => releases.push(r)); reconciling--; return { state: "running" }; },
    operate: async () => { if (reconciling) overlapped++; operated++; return { state: "succeeded", result: {} }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll(); runner.reports.set(String(m.id), { state: "running" });
  await runner.step(); await drain(); assert.equal(reconciling, 1);
  queued = [operation]; await runner.poll(); await runner.step(); await drain(); assert.equal(operated, 0);
  releases.forEach(r => r()); await drain(); await runner.step(); await drain();
  assert.equal(operated, 1); assert.equal(overlapped, 0); assert.equal(runner.deviceReports.get(operation.id)?.state, "succeeded"); await runner.close();
});
test("round robin reconciliation and reserved operation slots avoid starvation", async t => {
  const { config, image, clock } = setup(t), machines = [machine(image), machine(image), machine(image)], operation = { id: randomUUID(), machineId: machines[0]!.id, action: "shell", arguments: { argv: ["true"] }, expiresAt: 1100 }; const reconciled = new Set<string>(); let operated = 0;
  const runner = new HostRunner({ ...config, concurrency: 1 }, { clock, transport: fakeTransport(() => ({ machines, deviceOperations: [operation] })), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async m => { reconciled.add(String(m.id)); return { state: "running" }; }, operate: async () => { operated++; return { state: "succeeded", result: {} }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  for (let i = 0; i < 5; i++) { await runner.step(); await drain(); }
  assert.equal(reconciled.size, 3); assert.equal(operated, 1); await runner.close();
});

test("guest preparation receives cloneable data and verified health determines access readiness", async t => {
  const { config, image, clock } = setup(t), local = { ...image, guestAccess: true, prepare: { driver: "cloud-init", commands: ["true"] } }, m = machine(local); let prepared = 0;
  const runner = new HostRunner({ ...config, templates: [local], guestOrchestratorURL: "https://controller.example.test" }, { clock, transport: fakeTransport(), providerFactory,
    guest: { prepare: async (_machine, definition) => { prepared++; return structuredClone(definition); }, control: async () => ({ ready: true, mode: "headless" }) } });
  await runner.initializeProviders(); runner.assignments = [m]; runner.lastContact = 10;
  const report = await runner.reconcile(m); assert.equal(prepared, 1); assert.equal(report.accessReady, true); assert.equal((report.preparation as RecordValue).state, "ready"); await runner.close();
});

test("a macOS desktop is ready only after its verified helper shows a display frame", async t => {
  const { config, clock, image: base } = setup(t);
  const mac = { ...base, id: "mac", os: "macos", mode: "desktop", arch: "arm64", guestAccess: true }, m = machine(mac);
  const { GuestHelperBinding } = await import("../../src/control/session-protocol.ts");
  let frame: RecordValue = {}, reads = 0, resolves = 0, fail = false, cached: InstanceType<typeof GuestHelperBinding> | undefined;
  // Like AppleBindings, the fake keeps one verified binding per live launch.
  const runtime = { kind: "apple", check: async () => ({}), reconcile: async () => ({ state: "running" }),
    guestHelperBinding: async (_m: RecordValue, _i: RecordValue, _f: string, a: import("../../src/providers/apple-binding.ts").OwnedGuestAuthority) => {
      resolves++; if (fail) throw new Error("private resolver detail");
      return cached ??= new GuestHelperBinding(async (path, body) => { assert.equal(path, "/v1/display/frame"); assert.equal(body, null); reads++; return { frame }; }, a.authorized);
    } };
  const runner = new HostRunner({ ...config, provider: "macos", runtimes: { apple: {} }, templates: [mac] }, { clock, transport: fakeTransport(() => ({ machines: [m] })), providerFactory: () => runtime });
  await runner.initializeProviders(); await runner.connect(); await runner.poll();
  // No preparation recipe, no lease: readiness is the helper's own verified frame.
  let report = await runner.reconcile(m); assert.equal(report.accessReady, false); assert.match(String(report.detail), /show the desktop/);
  frame = { pngBase64: "iVBORw0KGgoAAAANSUhEUg", width: 1440, height: 900 };
  // A helper that has not answered is retried after a backoff, not on every poll.
  report = await runner.reconcile(m); assert.equal(report.accessReady, false); assert.equal(reads, 1, "backoff skips the probe");
  clock.mono += 6;
  report = await runner.reconcile(m); assert.equal(report.accessReady, true);
  report = await runner.reconcile(m); assert.equal(report.accessReady, true);
  assert.equal(reads, 2, "a recently confirmed binding is not re-probed for frames");
  // A later probe that sees no frame drops Ready again.
  const access = runner.accessBackend(m) as unknown as { ready(m: RecordValue, i: RecordValue, f: string, now: number): Promise<boolean> };
  frame = {}; assert.equal(await access.ready(m, mac, runner.context(m).folder, performance.now() + 31000), false); assert.equal(reads, 3);
  fail = true; const other = machine(mac);
  report = await runner.reconcile(other); assert.equal(report.accessReady, false); assert.doesNotMatch(String(report.detail), /private/);
  assert.ok(resolves >= 3); await runner.close();
});

test('mixed runtime selection captures macOS authority and retains old backends for shutdown', async t => {
  const {config,clock,image:linux} = setup(t);
  const mac = {...linux,id:'mac',os:'macos',mode:'desktop',arch:'arm64'};
  const lin = {...linux,arch:'arm64',guestAccess:true};
  const m=machine(mac), l=machine(lin); m.lease={id:randomUUID(),revision:1,state:'ready',controllerNow:1000,authorizationDeadline:1060};
  const authorities: Array<import('../../src/providers/apple-binding.ts').OwnedGuestAuthority> = [];
  const {GuestHelperBinding}=await import('../../src/control/session-protocol.ts');
  let closed=0,swept=0,files=0;
  const runtime={kind:'apple',check:async()=>({}),reconcile:async()=>({state:'running'}),guestHelperBinding:async(_m:RecordValue,_i:RecordValue,_f:string,a:import('../../src/providers/apple-binding.ts').OwnedGuestAuthority)=>{authorities.push(a);return new GuestHelperBinding(async(path,body)=>{
    if(path.endsWith("/shell/close"))return {closed:true};
    if(path.endsWith("/upload/begin"))return {id:body!.id,state:"receiving",bytes:0};
    if(path.endsWith("/upload/finish"))return {id:body!.id,state:"committed",bytes:0,sha256:body!.sha256,durable:true};
    if(path.endsWith("/download/begin"))return {id:body!.id,state:"reading",bytes:0};
    if(path.endsWith("/download/finish"))return {id:body!.id,state:"verified",bytes:0,sha256:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"};
    files++;return {path:"/",entries:[],truncated:false};},a.authorized);},close:async()=>{closed++;},sweep:async()=>{swept++;}};
  const runner=new HostRunner({...config,provider:'macos',runtimes:{apple:{}},templates:[mac,lin]}, {clock,transport:fakeTransport(()=>({machines:[m,l]})),providerFactory:()=>runtime});
  await runner.initializeProviders();await runner.connect();await runner.poll();
  const selected=runner.accessBackend(m), linuxBackend=runner.accessBackend(l);
  assert.notEqual(selected,linuxBackend);
  await runner.guestAccess.control(m,mac,runner.context(m).folder,{action:'list-files',arguments:{path:'/'}});
  assert.equal(files,1);assert.equal(authorities[0]!.clock,clock);assert.equal(authorities[0]!.authorized(),true);
  const folder=runner.context(m).folder;
  assert.deepEqual(await runner.guestAccess.streamUpload!(m,mac,folder,'/empty',undefined,{read:()=>Buffer.alloc(0)},0,()=>true),{uploaded:0,durable:true});
  const download=await runner.guestAccess.streamDownload!(m,mac,folder,'/empty',undefined,()=>true);assert.equal(await download.verify(),true);await download.close();
  const desktop=await runner.guestAccess.desktop!(m,mac,folder);await desktop.close();
  const session=(runner as unknown as {sessionBackend(job:import('../../src/control/sessions.ts').RunnerSessionJob):import('../../src/control/sessions.ts').RunnerSessionBackend}).sessionBackend({id:randomUUID(),generation:randomUUID(),leaseId:(m.lease as RecordValue).id as string,machineId:String(m.id),capability:'pty'});
  const originalRuntime=runner.runtimes.get('apple')!;runner.runtimes.clear();
  assert.deepEqual(await session.control!('shell-close',{session:randomUUID()}),{closed:true});runner.runtimes.set('apple',originalRuntime);
  runner.assignments=[{...m,lease:{...m.lease as RecordValue,id:randomUUID()}}];
  assert.equal(authorities[0]!.authorized(),false,'same machine must not authorize a captured old lease');
  runner.assignments=[{...m,resources:{cpu:2,memoryMiB:1024,diskGiB:8}}];
  assert.equal(authorities[0]!.authorized(),false,'current fingerprint is authoritative');
  runner.runtimes.clear();runner.assignments=[];await runner.close();assert.equal(closed,1);assert.ok(swept>0);
});

test("assignment context validates a configured operator recipe once, not on every access", async t => {
  const { config, image } = setup(t);
  let reads = 0;
  const recipe = { driver: "cloud-init", packages: ["curl"], commands: ["true"] };
  // Operator recipes can embed a multi-MiB guest bundle; count how often it is examined.
  Object.defineProperty(image, "prepare", { enumerable: true, get() { reads++; return recipe; } });
  const runner = new HostRunner(config, { transport: fakeTransport(), providerFactory });
  await runner.initializeProviders();
  const m = machine(image), start = reads;
  for (let i = 0; i < 5; i++) assert.equal(runner.context(m).image.id, image.id);
  // One full validation, then only the per-call defensive copy reads the recipe.
  assert.ok(reads - start <= 5 + 2, `recipe reads ${reads - start}`);
  assert.throws(() => runner.context({ ...m, template: normalizeTemplate({ ...image, prepare: { driver: "cloud-init", packages: ["other"] } }) }), /no longer matches/);
});

test("owner display sessions attach once, only for unleased desktop assignments", async t => {
  const { config, image, clock } = setup(t);
  const desktop = { ...image, id: "desktop", mode: "desktop" };
  const unleased = machine(desktop), leased = { ...machine(desktop), lease: { id: randomUUID(), revision: 1, state: "ready", controllerNow: 1000, authorizationDeadline: 1060 } };
  const job = (m: RecordValue) => ({ id: randomUUID(), machineId: m.id, generation: randomUUID(), capability: "display", state: "pending" });
  let sessions = [job(leased), job(unleased)];
  const runner = new HostRunner({ ...config, templates: [desktop] }, { clock, transport: fakeTransport(() => ({ machines: [unleased, leased], displaySessions: sessions })),
    providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async (m: RecordValue) => ({ state: m.desired }), desktop: async () => { throw Error("fixture display is never opened"); } }) });
  t.after(() => runner.close().catch(() => {}));
  await runner.initializeProviders(); await runner.connect(); await runner.poll(); await runner.step(); await drain();
  const attempts = (runner as unknown as { displayAttempts: Set<string> }).displayAttempts;
  assert.deepEqual([...attempts], [`${sessions[1]!.id}:${sessions[1]!.generation}`], "only the unleased desktop is attempted");
  await runner.poll(); await runner.step(); await drain();
  assert.equal(attempts.size, 1, "a refused attach is not retried");
  assert.equal([...(runner as unknown as { active: Map<string, unknown> }).active.keys()].some(key => key.startsWith("display:")), false);
  sessions = []; await runner.poll(); await runner.step();
  assert.equal(attempts.size, 0, "attempts are forgotten once the controller drops the session");
});

test("a finished recording whose receipt the runner repeats does not hold back the device's live capture", async t => {
  const { config, image, clock } = setup(t);
  const m = machine(image), finished = { id: randomUUID(), machineId: m.id, generation: randomUUID(), state: "ready" }, queued = { id: randomUUID(), machineId: m.id, generation: randomUUID(), state: "pending" };
  // The controller's list trails the recording that just ended here: it is still `ready`.
  let videoSessions: RecordValue[] = [finished], receipts = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const transport: HostTransport = { request: async (_method, path) => {
    if (path.endsWith("heartbeat")) return { machines: [m], videoSessions };
    // Hold the repeated receipt, so its `video:` work stays active.
    if (path.endsWith(`/video-sessions/${finished.id}/finish`)) { receipts++; await held; }
    return {};
  } };
  const runner = new HostRunner(config, { clock, transport, providerFactory });
  t.after(() => runner.close().catch(() => {}));
  await runner.initializeProviders(); await runner.connect(); await runner.poll();
  saveRecord(join(config.stateDir, "work", "video", `${m.id}.${finished.id}.json`), { generation: finished.generation, machineId: m.id, state: "finished", cleaned: true });
  const internals = runner as unknown as { stepVideo(): void; recordingPending(machineId: string): boolean; active: Map<string, unknown>; liveRecordings: Map<string, unknown> };
  internals.stepVideo(); await drain();
  assert.equal(receipts, 1); assert.ok(internals.active.has(`video:${finished.id}`), "the receipt repeat is in flight");
  assert.equal(internals.recordingPending(String(m.id)), false, "a recording that ended here does not stop the device's live epoch");
  // A recording the runner has not started yet still keeps live capture off the device.
  videoSessions = [finished, queued]; await runner.poll(); internals.liveRecordings.clear();
  assert.equal(internals.recordingPending(String(m.id)), true);
});

test("an older controller receives live cleanup without fence attribution, including on retry", async t => {
  const { config, image, clock } = setup(t);
  const m = machine(image), capture = { id: randomUUID(), machineId: m.id, generation: randomUUID(), state: "disconnected" };
  const stop = { cause: "fence", leaseId: randomUUID(), leaseRevision: 1 }, reports: RecordValue[] = [];
  const transport: HostTransport = { request: async (_method, route, body) => {
    if (route.endsWith("heartbeat")) return { machines: [m], liveCaptures: [capture] };
    if (route.endsWith(`/video-sessions/${capture.id}/finish`)) {
      reports.push(body);
      if (body.stop) throw new ServiceError("Mobile video session rejected.", 400);
      if (reports.length === 2) throw new ServiceError("Lost response.", 503, { outcome: "unknown" });
    }
    return {};
  } };
  const runner = new HostRunner(config, { clock, transport, providerFactory });
  t.after(() => runner.close());
  await runner.initializeProviders(); await runner.connect(); await runner.poll();
  const path = join(config.stateDir, "work", "live", `${capture.id}.json`);
  saveRecord(path, { generation: capture.generation, machineId: m.id, state: "unknown", cleaned: false, hostCleaned: true, stop });
  const internals = runner as unknown as { stepLive(): void; active: Map<string, { promise: Promise<void> }> };
  const repeat = () => {
    internals.stepLive();
    return internals.active.get(`live-capture:${capture.id}`)!.promise;
  };
  await repeat();
  assert.equal(readRecord(path).legacyReceipt, true);
  assert.deepEqual(readRecord(path).stop, stop);
  await repeat();
  const cleanup = { generation: capture.generation, hostCleaned: true };
  assert.deepEqual(reports, [{ ...cleanup, stop }, cleanup, cleanup]);
});

test("a host-only recording receipt keeps the device held even when a heartbeat omits the recording", async t => {
  const { config, image, clock } = setup(t);
  const m: RecordValue = { ...machine(image), lease: { id: randomUUID(), revision: 1, state: "ready", controllerNow: 1000, authorizationDeadline: 1060 } };
  // The lease recording ended here with only its encoder's exit confirmed; the controller lists it until the lease's cleanup proves the guest recorder gone.
  const unproven = { id: randomUUID(), machineId: m.id, generation: randomUUID(), state: "disconnected" };
  let videoSessions: RecordValue[] = [unproven], receipts = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const transport: HostTransport = { request: async (_method, path) => {
    if (path.endsWith("heartbeat")) return { machines: [m], videoSessions };
    if (path.endsWith(`/video-sessions/${unproven.id}/finish`)) { receipts++; await held; }
    return {};
  } };
  const runner = new HostRunner(config, { clock, transport, providerFactory });
  t.after(() => runner.close().catch(() => {}));
  await runner.initializeProviders(); await runner.connect(); await runner.poll();
  saveRecord(join(config.stateDir, "work", "video", `${m.id}.${unproven.id}.json`), { generation: unproven.generation, machineId: m.id, state: "unknown", cleaned: false, hostCleaned: true });
  const internals = runner as unknown as { stepVideo(): void; recordingPending(machineId: string): boolean };
  internals.stepVideo(); await drain();
  assert.equal(receipts, 1, "the host-only receipt is in flight");
  assert.equal(internals.recordingPending(String(m.id)), true);
  // Acknowledging encoder exit leaves the guest recorder unproven.
  release(); await drain(); await runner.poll();
  assert.equal(internals.recordingPending(String(m.id)), true);
  // A stale queue can omit the recording. Only proof (or removal of this device)
  // clears its durable native reservation.
  videoSessions = []; await runner.poll();
  assert.equal(internals.recordingPending(String(m.id)), true);
  saveRecord(join(config.stateDir, "work", "video", `${m.id}.${unproven.id}.json`), {
    generation: unproven.generation, machineId: m.id, state: "finished", cleaned: true,
  });
  await runner.poll();
  assert.equal(internals.recordingPending(String(m.id)), false);
});

test("legacy live cleanup receipts require TLS or loopback", async t => {
  for (const [url, trusted] of [
    ["http://192.0.2.1:8080", false],
    ["http://127.0.0.1:8080", true],
    ["https://controller.example.test", true],
  ] as const) await t.test(url, async t => {
    const { config, image, clock } = setup(t);
    const m: RecordValue = { ...machine(image), template: { ...image, os: "android" } };
    const id = randomUUID(), generation = randomUUID(), machineId = String(m.id);
    const path = join(config.stateDir, "work", "live", `${id}.json`);
    saveRecord(path, { machineId, generation, state: "unknown", cleaned: false, hostCleaned: true });
    const logs: string[] = [];
    let receiptRequests = 0;
    const transport: HostTransport = { request: async (_method, route) => {
      if (route.endsWith(`/video-sessions/${id}/finish`)) {
        receiptRequests++;
        return { id, generation, machineId, kind: "live", cleaned: true, hostCleaned: true };
      }
      return {};
    } };
    const runner = new HostRunner({ ...config, url, allowHTTP: true }, { clock, transport, providerFactory, log: message => logs.push(message) });
    t.after(() => runner.close());
    await runner.connect();
    const recovery = runner as unknown as {
      recoverAndroidLiveCleanup(machine: RecordValue): Promise<void>;
      capturePending(kind: "live", machineId: string): boolean;
    };
    assert.equal(recovery.capturePending("live", machineId), true);
    await recovery.recoverAndroidLiveCleanup(m);
    assert.equal(receiptRequests, Number(trusted));
    assert.equal(readRecord(path).cleaned, trusted);
    assert.equal(recovery.capturePending("live", machineId), !trusted);
    if (!trusted) assert.ok(logs.some(message => message.includes("remote HTTP")));
  });
});
