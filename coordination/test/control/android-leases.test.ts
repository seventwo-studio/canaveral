import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../../src/main.ts";
import { HostRunner, hostOffer } from "../../src/host.ts";
import { AndroidProvider, LEASE_ISOLATION_ARGUMENTS } from "../../src/providers/android.ts";
import { nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import { SUPERVISOR_REFUSED, SupervisorLaunchError } from "../../src/providers/mobile.ts";
import type { LeaseSupervisorTransport, RecordValue } from "../../src/providers/mobile.ts";
import { normalizeOperatorTemplate } from "../../src/control/templates.ts";
import { LeaseClient } from "../../src/sdk.ts";
import { MP4, acquire, alive, arch, cleaned, emulators, groupAlive, harness, helper, operate, ready, skip, supervised, systemImage, unix, until, watchReceipt } from "./android-lease-fixture.ts";
import type { Harness } from "./android-lease-fixture.ts";

/** Android lease behaviour against the shared disposable harness (android-lease-fixture.ts). */
test("leases are gated to supervised Android emulators with a native clock", () => {
  const image = { id: "phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage, profile: "pixel_8" } };
  const base = { name: "h", provider: "android", capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, templates: [image] };
  const lease = { leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "android" }] };
  if (unix) assert.deepEqual(hostOffer({ ...base, ...lease, leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }).leaseImages, lease.leaseImages);
  for (const config of [{ ...base, ...lease, leaseSupervisor: "/opt/helper" }, { ...base, ...lease, leaseClockHelper: "/opt/helper" }, { ...base, ...lease, leaseClockHelper: "relative", leaseSupervisor: "/opt/helper" },
    { ...base, leaseProtocol: 1, leaseImages: [{ ...lease.leaseImages[0], runtime: "apple" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" },
    { ...base, provider: "ios", templates: [], leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "ios" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" },
    { ...base, provider: "libvirt", templates: [], ...lease, leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }])
    assert.throws(() => hostOffer(config), /cannot advertise lease execution/);
  assert.throws(() => hostOffer({ ...base, ...lease, leaseImages: [{ ...lease.leaseImages[0], id: "other" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }), unix ? /offered Android templates/ : /cannot advertise/);
});

test("two agents share a one-emulator host: ready only when checked, scoped control, waiting, expiry in use, proven cleanup, clean hand-over", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 15);
  assert.ok(h.counters.get(`cvm-${a.machineId}:shell pm path android`), "readiness checked the package manager");
  assert.ok(h.counters.get(`cvm-${a.machineId}:shell getprop sys.boot_completed`), "readiness checked boot completion");
  // Readiness also proved the guest cannot reach the host: adb, its own ports and the controller.
  const isolation = JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-isolation.json"), "utf8")), launched = JSON.parse(readFileSync(join(h.storage(a.machineId), "launch.json"), "utf8"));
  assert.equal(isolation.isolated, true); assert.equal(isolation.target, "10.0.2.2"); assert.equal(isolation.bootId, launched.bootId);
  for (const port of [5037, Number(new URL(h.url).port)]) assert.ok(isolation.ports.includes(port), `probe covered ${port}`);
  assert.deepEqual(launched.argv.slice(-LEASE_ISOLATION_ARGUMENTS.length), LEASE_ISOLATION_ARGUMENTS);
  assert.ok(LEASE_ISOLATION_ARGUMENTS.join(" ").includes("-network-user-mode-options restrict=on,ipv6=off -wifi-user-mode-options restrict=on,ipv6=off"));
  const first = supervised(h, a.machineId), receipt = watchReceipt(t, join(h.storage(a.machineId), "lease-stopped.json"));
  assert.ok(alive(first.childPid) && groupAlive(first.childPid));
  // Scoped control: screenshot, input, launch and logs through A's lease key only.
  const shot = await operate(h, a.id, a.key, "screenshot");
  assert.equal(shot.body.state, "succeeded"); assert.equal(Buffer.from(shot.body.result.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await operate(h, a.id, a.key, "tap", { x: 10, y: 20 })).body.state, "succeeded");
  assert.equal((await operate(h, a.id, a.key, "launch", { app: "test.canaveral.trial/.TrialActivity" })).body.state, "succeeded");
  assert.equal((await operate(h, a.id, a.key, "logs")).body.state, "succeeded");
  // The application key cannot act as the lease key.
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, app)).status, 401);
  // Agent B queues while the host is full; nothing is reserved for it.
  const b = await acquire(h, app, 60, false);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await h.api("GET", `/v1/requests/${b.id}`, undefined, app)).body.state, "waiting");
  assert.equal(emulators(h.registry).length, 1);
  // A keeps sending input until its lease expires; the old key is refused immediately afterwards.
  let refused: { status: number; body: any } | undefined;
  await until(async () => { const reply = await operate(h, a.id, a.key, "tap", { x: 5, y: 5 }); if (reply.status === 200 && reply.body.state === "succeeded") return false; refused = reply; return true; }, "expiry while in use", 40000);
  // A tap still in flight at expiry ends unknown (never replayed); later ones are refused or failed.
  assert.ok([401, 409, 410].includes(refused!.status) || ["failed", "unknown"].includes(refused!.body.state), JSON.stringify(refused));
  // The host fences conservatively, slightly before the controller's expiry (409 member_not_ready meanwhile).
  // A fence report that lands first ends the lease as failed rather than expired; both are terminal.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 410);
  // The supervisor stops the whole group, then cleanup proves removal and releases the reservation.
  await until(() => !alive(first.childPid) && !groupAlive(first.childPid), "supervised group stop");
  await until(() => receipt() !== undefined, "stop receipt"); const stopped = receipt();
  assert.equal(stopped.groupAbsent, true); assert.equal(stopped.childPid, first.childPid);
  await cleaned(h, app, a.id);
  assert.equal(existsSync(h.storage(a.machineId)), false);
  assert.equal(existsSync(join(h.root, "devices", "avds", `cvm-${a.machineId}.ini`)), false);
  // B is admitted to a clean, distinct emulator; A's key cannot reach it.
  const second = await ready(h, app, b.id);
  assert.notEqual(second.machineId, a.machineId);
  assert.equal(emulators(h.registry).length, 1); assert.equal(emulators(h.registry)[0]!.name, `cvm-${second.machineId}`);
  assert.equal((await operate(h, b.id, second.key, "tap", { x: 3, y: 4 })).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 401);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/release`, { id: randomUUID() }, second.key)).status, 200);
  await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("controller loss: the host enforces the deadline alone, then reports proven cleanup when the controller returns", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 8), group = supervised(h, a.machineId);
  await h.stopController();
  assert.ok(alive(group.childPid));
  await until(() => !groupAlive(group.childPid), "host-local deadline stop without the controller", 30000);
  assert.ok(existsSync(join(h.storage(a.machineId), "lease-fenced.json")));
  await h.startController();
  // The local fence is conservative and may precede the controller's own expiry slightly.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 410);
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("host loss: the native supervisor stops the emulator at the deadline with no runner; recovery proves cleanup", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 8), group = supervised(h, a.machineId), receipt = watchReceipt(t, join(h.storage(a.machineId), "lease-stopped.json"));
  await h.stopRunner();
  assert.ok(alive(group.childPid) && alive(group.supervisorPid), "the emulator outlives the runner process");
  await until(() => !groupAlive(group.childPid) && !alive(group.supervisorPid), "native deadline stop without runner or controller", 30000);
  await until(() => receipt() !== undefined, "stop receipt"); assert.equal(receipt().reason, "expired");
  // While the runner is gone the controller keeps the reservation; its restart proves cleanup.
  // The native deadline is conservative: it falls slightly before the controller's expiry.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  await h.restartRunner();
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("renewal extends the native deadline; lost replies replay by UUID; runner and controller restarts neither relaunch nor replay", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 6), group = supervised(h, a.machineId);
  // Renewal publishes a newer revision and a later native deadline before the original expires.
  const before = JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8"));
  const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body;
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/renew`, { id: randomUUID(), expectedRevision: lease.revision, ttlSeconds: 90 }, app)).status, 200);
  await until(() => { const now = JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8")); return now.revision > before.revision && now.deadline > before.deadline + 30 && now.fenced === false; }, "renewed native deadline");
  await new Promise(resolve => setTimeout(resolve, 7000));
  assert.ok(alive(group.childPid), "renewal kept the emulator past its original deadline");
  const operation = randomUUID();
  assert.equal((await operate(h, a.id, a.key, "tap", { x: 7, y: 8 }, operation)).body.state, "succeeded");
  const taps = h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '7' '8'`);
  assert.equal(taps, 1);
  // A lost operation reply: the same UUID returns the receipt without running again.
  const replay = await h.api("POST", `/v1/leases/${a.id}/operations`, { id: operation, member: "primary", action: "tap", arguments: { x: 7, y: 8 } }, a.key);
  assert.equal(replay.body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: operation, member: "primary", action: "tap", arguments: { x: 9, y: 9 } }, a.key)).status, 409);
  // A lost credential reply: exchange again; the earlier key is revoked.
  const rotated = (await h.api("POST", `/v1/leases/${a.id}/credential`, {}, app)).body.credential as string;
  assert.equal((await h.api("GET", `/v1/leases/${a.id}/operations/${operation}`, undefined, a.key)).status, 401);
  assert.equal((await h.api("GET", `/v1/leases/${a.id}/operations/${operation}`, undefined, rotated)).body.state, "succeeded");
  // Runner restart: the same supervised emulator is recovered, never relaunched.
  await h.restartRunner();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(supervised(h, a.machineId).childPid, group.childPid); assert.ok(alive(group.childPid));
  assert.equal(emulators(h.registry).length, 1);
  assert.equal(h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '7' '8'`), taps);
  // Controller restart keeps the lease and its device.
  await h.stopController(); await h.startController();
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state, "ready");
  assert.equal((await operate(h, a.id, rotated, "screenshot")).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, rotated)).status, 200);
  await until(() => !groupAlive(group.childPid), "release stops the group");
  await cleaned(h, app, a.id);
});

test("a lease key reaches only its own emulator, and the provider refuses a foreign serial", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 2), app = await h.application();
  const [a, b] = await Promise.all([acquire(h, app, 60), acquire(h, app, 60)]);
  assert.notEqual(a.machineId, b.machineId);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 401);
  assert.equal((await h.api("GET", `/v1/leases/${b.id}`, undefined, a.key)).status, 401);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "other", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 404);
  // Point A's reserved endpoint at B's console port: the launch binding no longer matches, so
  // the provider refuses every command instead of driving B.
  const endpoint = join(h.storage(a.machineId), "endpoint.json"), original = readFileSync(endpoint, "utf8");
  const foreign = JSON.parse(readFileSync(join(h.storage(b.machineId), "endpoint.json"), "utf8"));
  writeFileSync(endpoint, JSON.stringify(foreign));
  const before = readdirSync(h.events).length;
  const refused = await operate(h, a.id, a.key, "tap", { x: 2, y: 2 });
  assert.notEqual(refused.body.state, "succeeded");
  const touched = readdirSync(h.events).slice(before).map(name => JSON.parse(readFileSync(join(h.events, name), "utf8")));
  assert.ok(!touched.some(event => event.name === `cvm-${b.machineId}` && event.args.join(" ").includes("'input' 'tap' '2' '2'")), "A's input never reached the other emulator");
  writeFileSync(endpoint, original);
  for (const lease of [a, b]) assert.equal((await h.api("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() }, lease.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
});

test("supervisor loss mid-lease ends device access at once, fails the lease and holds the reservation until operator recovery", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 120), group = supervised(h, a.machineId);
  assert.equal((await operate(h, a.id, a.key, "tap", { x: 4, y: 4 })).body.state, "succeeded");
  const taps = h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '4' '4'`);
  // The supervisor is lost abruptly, leaving its emulator group orphaned and unsupervised.
  process.kill(group.supervisorPid, "SIGKILL");
  await until(() => !alive(group.supervisorPid), "supervisor loss");
  assert.ok(alive(group.childPid));
  // Its lifetime lock is free, so the provider refuses device access immediately, whatever the runner believes.
  const provider = h.runner().runtimes.get("android") as unknown as AndroidProvider;
  await assert.rejects(provider.endpoint({ id: a.machineId, lease: { id: a.id } }, h.storage(a.machineId)), (error: any) => error.status === 410);
  // The runner reports the loss and the lease fails long before its 120-second TTL.
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "failed lease", 15000);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 4, y: 4 } }, a.key)).status, 410);
  assert.equal(h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '4' '4'`), taps);
  assert.equal(JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8")).fenced, true);
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body; return lease.cleanup.state === "blocked" && lease.members[0].cleanup.reason === "execution_pending"; }, "blocked cleanup");
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.cleanup.state, "blocked");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  assert.ok(existsSync(h.storage(a.machineId)) && alive(group.childPid));
  // Documented recovery: the operator stops the process group named in lease-supervisor.json.
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

/** A supervisor stand-in that fails its launch, optionally after starting the emulator itself. */
function failingSupervisor(spawned: boolean): LeaseSupervisorTransport {
  return { ...nativeLeaseSupervisor, async supervise(_helper, _storage, request) {
    if (spawned) {
      const child = spawn(String(request.executable), request.args as string[], { cwd: String(request.cwd), env: {}, detached: true, stdio: "ignore" });
      child.unref();
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // An ordinary non-zero exit (or none observed) is never the dedicated refusal status.
    throw new SupervisorLaunchError(spawned ? 1 : undefined);
  } };
}

test("an ordinary supervisor failure is not proof that nothing spawned: a surviving emulator holds the reservation", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { leases: failingSupervisor(true) }), app = await h.application();
  const { id } = await acquire(h, app, 60, false);
  await until(() => emulators(h.registry).length === 1, "the unrecorded emulator");
  const orphan = emulators(h.registry)[0]!;
  await until(async () => (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body.state === "failed", "failed lease", 30000);
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; return lease.cleanup.state === "blocked" && lease.members[0].cleanup.reason === "execution_pending"; }, "blocked cleanup");
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  assert.ok(alive(orphan.pid));
  // Once the emulator is gone, the process inventory proves it and cleanup completes on its own.
  process.kill(-orphan.pid, "SIGKILL");
  await cleaned(h, app, id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a launch that left only its intent is recovered automatically from the supervisor lock and process inventory", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { leases: failingSupervisor(false) }), app = await h.application();
  const { id } = await acquire(h, app, 60, false);
  await until(async () => (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body.state === "failed", "failed lease", 30000);
  await cleaned(h, app, id);
  assert.equal(emulators(h.registry).length, 0);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a guest that reaches the host loopback is fenced and never handed out", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { guest: "leaky" }), app = await h.application();
  const { id } = await acquire(h, app, 60, false);
  let machineId = "";
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; machineId = lease.members?.[0]?.machineId ?? ""; return !!machineId; }, "admitted member");
  const fenced = watchReceipt(t, join(h.storage(machineId), "lease-fenced.json"));
  const views: string[] = [];
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; views.push(lease.state); return lease.state === "failed"; }, "failed lease", 30000);
  assert.ok(!views.includes("ready"), "the lease never became ready");
  assert.equal((await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).status >= 400, true);
  await until(() => fenced() !== undefined, "the supervisor stopped the leaky guest");
  assert.equal(existsSync(join(h.storage(machineId), "lease-isolation.json")), false);
  await cleaned(h, app, id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a debuggable guest image is fenced and never handed out", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { guest: "debuggable" }), app = await h.application();
  const { id } = await acquire(h, app, 60, false);
  const views: string[] = [];
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; views.push(lease.state); return lease.state === "failed"; }, "failed lease", 30000);
  assert.ok(!views.includes("ready"), "the lease never became ready");
  await cleaned(h, app, id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("the host refuses leased execution outside its advertised Android lease images", { skip, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-lease-gate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const leased = { id: "lease-phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage, profile: "pixel_8" } };
  const other = { ...leased, id: "plain-phone" };
  const calls: RecordValue[] = [];
  let kind = "android";
  const runtime = { get kind() { return kind; }, reconcile: async (machine: RecordValue) => { calls.push(machine); return { state: machine.desired === "running" ? "starting" : "stopped" }; },
    refreshExecution: async () => null, check: async () => ({ ready: true }) };
  const runner = new HostRunner({ url: "http://127.0.0.1:9", stateDir: join(root, "runner"), name: "gate", provider: "android", storage: join(root, "devices"), androidSDK: "/nonexistent",
    templates: [leased, other], capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1,
    leaseImages: [{ id: leased.id, revision: "1", arch, runtime: "android" }] }, { providerFactory: () => runtime as any });
  await runner.initializeProviders();
  const now = (runner as any).clock.wall() as number;
  const machine = (image: RecordValue): RecordValue => ({ id: randomUUID(), templateId: image.id, template: normalizeOperatorTemplate(image), desired: "running",
    resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, lease: { id: randomUUID(), state: "ready", revision: 1, authorizationDeadline: now + 600, controllerNow: now } });
  const eligible = machine(leased), unlisted = machine(other);
  runner.guard.observe([eligible, unlisted], 0);
  assert.equal(runner.leaseEligible(eligible), true);
  assert.equal((await runner.reconcile(eligible)).state, "starting");
  assert.equal(calls.at(-1)!.desired, "running");
  // A template outside leaseImages is never started, even though the controller asked and the guard allows it.
  assert.equal(runner.leaseEligible(unlisted), false);
  const refused = await runner.reconcile(unlisted);
  assert.equal(refused.state, "error"); assert.match(String(refused.detail), /does not offer leased execution/);
  assert.equal(calls.at(-1)!.desired, "stopped"); assert.equal(calls.at(-1)!.id, unlisted.id);
  // Nor is an advertised template on a runtime that is not Android.
  kind = "ios";
  assert.equal(runner.leaseEligible(eligible), false);
  assert.equal((await runner.reconcile(eligible)).state, "error");
  assert.equal(calls.at(-1)!.desired, "stopped");
  await runner.close();
});

test("the native supervisor refuses ended authorization and never relaunches an assignment", { skip, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-supervisor-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { machineId: randomUUID(), leaseId: randomUUID(), bootId: randomUUID() };
  const clock = await nativeLeaseSupervisor.clock(helper);
  const authorize = (deadline: number, fenced = false, revision = 1) => writeFileSync(join(root, "lease-authorization.json"), JSON.stringify({ version: 1, ...identity, bootSessionID: clock.bootSessionID, revision, deadline, fenced }));
  const request = { version: 1, ...identity, executable: "/bin/sh", args: ["-c", "sleep 30 & sleep 30"], env: {}, cwd: root };
  authorize(clock.continuous - 1);
  await assert.rejects(nativeLeaseSupervisor.supervise(helper, root, request), (error: any) => error.supervisorExit === SUPERVISOR_REFUSED);
  assert.equal(existsSync(join(root, "lease-supervisor.json")), false);
  authorize(clock.continuous + 120);
  const child = await nativeLeaseSupervisor.supervise(helper, root, request);
  assert.ok(groupAlive(child.pid));
  // A stale revision cannot extend; a fence stops the group and leaves a sticky marker.
  authorize(clock.continuous + 120, true);
  await until(() => existsSync(join(root, "lease-stopped.json")), "fenced stop");
  assert.equal(groupAlive(child.pid), false); await until(() => child.supervisorExited(), "supervisor exit");
  assert.equal(JSON.parse(readFileSync(join(root, "lease-stopped.json"), "utf8")).reason, "fenced");
  authorize(clock.continuous + 120);
  await assert.rejects(nativeLeaseSupervisor.supervise(helper, root, request));
});

/** Lease-key capture and large installs for CI and marketing capture: a job leases an emulator,
 * installs its real build, drives screens and records verified MP4 through its own key only. */
function leaseClient(h: Harness, lease: { id: string; key: string }): LeaseClient {
  return new LeaseClient({ baseUrl: h.url, leaseId: lease.id, leaseKey: lease.key, allowLoopbackHttp: true, timeoutMs: 20000 });
}
function apk(h: Harness, bytes: number): { file: string; payload: Buffer; sha256: string } {
  const payload = randomBytes(bytes), file = join(h.root, `build-${randomUUID()}.apk`);
  writeFileSync(file, payload, { mode: 0o600 });
  return { file, payload, sha256: createHash("sha256").update(payload).digest("hex") };
}
async function receipt(client: LeaseClient, id: string): Promise<any> {
  let current: any;
  await until(async () => { current = await client.operation(id); return current.state !== "queued"; }, "operation receipt", 30000);
  return current;
}
function sink(): { chunks: Buffer[]; write(bytes: Uint8Array): number } {
  const chunks: Buffer[] = [];
  return { chunks, write(bytes) { chunks.push(Buffer.from(bytes)); return bytes.length; } };
}
const VIDEO = { fps: 30 as const, bitRate: 4_000_000 };

test("a lease key installs a large APK and records verified MP4 of its own emulator; other keys are refused and replays are exact", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 2, { extra: { cpu: 2, memoryMiB: 1024, diskGiB: 16 } }), app = await h.application();
  const a = await acquire(h, app, 300), lease = leaseClient(h, a);
  const build = apk(h, 1_300_000); // three chunks, over the 512 KiB single-push limit
  // Upload through the lease key, resumable by UUID; the upload reserves host scratch until released.
  const artifact = randomUUID(), uploaded = await lease.uploadApp({ id: artifact, member: "primary", file: build.file });
  assert.deepEqual([uploaded.state, uploaded.bytes, uploaded.sha256, uploaded.leaseId, uploaded.machineId], ["ready", build.payload.length, build.sha256, a.id, a.machineId]);
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 10 });
  // Lost replies: the same intent, an identical chunk and completion all replay without change.
  const intent = { id: artifact, member: "primary", format: "apk", bytes: build.payload.length, sha256: build.sha256 };
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, intent, a.key)).status, 200);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { ...intent, bytes: 7 }, a.key)).status, 409);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts/${artifact}/chunks`, { offset: 0, data: build.payload.subarray(0, 524288).toString("base64") }, a.key)).status, 409, "a published upload takes no chunks");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts/${artifact}/complete`, {}, a.key)).body.state, "ready");
  // Install through the durable lease operation: streamed into one package session, digest-checked, committed once.
  const install = randomUUID();
  assert.equal((await lease.installApp({ id: install, member: "primary", artifact })).created, true);
  const installed = await receipt(lease, install);
  assert.equal(installed.state, "succeeded", JSON.stringify(installed));
  assert.deepEqual(installed.result, { installed: true, sha256: build.sha256, bytes: build.payload.length, artifactCleaned: true });
  assert.deepEqual(Buffer.concat(h.media.installs.get(`cvm-${a.machineId}`)!), build.payload);
  assert.equal(h.media.commits, 1);
  const replay = await lease.installApp({ id: install, member: "primary", artifact });
  assert.equal(replay.created, false); assert.equal(replay.operation.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: install, member: "primary", action: "install-uploaded", arguments: { artifact: randomUUID() } }, a.key)).status, 409);
  await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(h.media.commits, 1, "a replayed install never commits again");
  // Drive named screens.
  assert.equal((await operate(h, a.id, a.key, "launch", { app: "test.canaveral.trial/.TrialActivity" })).body.state, "succeeded");
  const shot = await operate(h, a.id, a.key, "screenshot");
  assert.equal(Buffer.from(shot.body.result.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  // Record through the lease key: the host's finish receipt carries bytes, SHA-256 and positive cleanup.
  const video = randomUUID(), out = sink();
  const finish = await lease.video.record({ id: video, member: "primary", durationSeconds: 2, ...VIDEO }, out, { timeoutMs: 20000 });
  assert.deepEqual(Buffer.concat(out.chunks), MP4);
  assert.deepEqual(finish, { type: "finish", bytes: MP4.length, sha256: createHash("sha256").update(MP4).digest("hex"), cleaned: true });
  await until(async () => (await lease.video.inspect(video)).cleaned === true, "positive recording cleanup");
  const saved = await lease.video.inspect(video);
  assert.deepEqual([saved.state, saved.leaseId, saved.member, saved.hostCleaned], ["finished", a.id, "primary", true]);
  assert.equal(h.media.encodersOpen, 0); assert.equal(h.media.recorders.get(`cvm-${a.machineId}`)!.running, false);
  // A replayed session intent returns the same session and never records again.
  const encoders = h.media.encoders, again = await lease.video.create({ id: video, member: "primary", durationSeconds: 2, ...VIDEO });
  assert.equal(again.generation, saved.generation); assert.equal(again.state, "finished");
  await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(h.media.encoders, encoders);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: video, member: "primary", durationSeconds: 3, ...VIDEO }, a.key)).status, 409);
  // Another lease's key, the application key and the operator credential reach none of it.
  const b = await acquire(h, app, 300);
  for (const token of [b.key, app, h.admin]) {
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/app-artifacts/${artifact}`, undefined, token)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", durationSeconds: 2, ...VIDEO }, token)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { ...intent, id: randomUUID() }, token)).status, 401);
  }
  assert.equal((await h.api("GET", `/v1/leases/${b.id}/app-artifacts/${artifact}`, undefined, b.key)).status, 404);
  assert.equal((await h.api("GET", `/v1/leases/${b.id}/video-sessions/${video}`, undefined, b.key)).status, 404);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "install-uploaded", arguments: { artifact } }, b.key)).status, 409);
  assert.equal((await h.api("GET", `/v1/app-artifacts/${artifact}`, undefined, h.admin)).status, 404, "lease uploads are not on the administrative routes");
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/app-artifacts`, { id: randomUUID(), format: "apk", bytes: 10, sha256: build.sha256 }, h.admin)).status, 409);
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/video-sessions`, { id: randomUUID(), durationSeconds: 2, ...VIDEO }, h.admin)).status, 409);
  // A lease holds at most four uploads at once; deleting a clean upload releases its scratch.
  const small = apk(h, 4096), extra: string[] = [];
  for (let i = 0; i < 3; i++) { const id = randomUUID(); extra.push(id); assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id, member: "primary", format: "apk", bytes: 4096, sha256: small.sha256 }, a.key)).status, 201); }
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "apk", bytes: 4096, sha256: small.sha256 }, a.key)).status, 429);
  for (const id of [artifact, ...extra]) assert.equal((await lease.deleteAppArtifact(id)).state, "deleted");
  // One application's lease uploads share at most 2 GiB of the controller-wide pool by declared size.
  const big = randomUUID(), declared = 1536 * 1024 ** 2;
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: big, member: "primary", format: "apk", bytes: declared, sha256: small.sha256 }, a.key)).status, 201);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "apk", bytes: 600 * 1024 ** 2, sha256: small.sha256 }, a.key)).status, 429, "the application share is exhausted");
  assert.equal((await lease.deleteAppArtifact(big)).state, "deleted");
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  // Rotating the key revokes it for recording too.
  const rotated = (await h.api("POST", `/v1/leases/${a.id}/credential`, {}, app)).body.credential as string;
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", durationSeconds: 2, ...VIDEO }, a.key)).status, 401);
  assert.equal((await h.api("GET", `/v1/leases/${a.id}/video-sessions/${video}`, undefined, rotated)).body.cleaned, true);
  for (const l of [{ id: a.id, key: rotated }, b]) assert.equal((await h.api("POST", `/v1/leases/${l.id}/release`, { id: randomUUID() }, l.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("expiry mid-recording ends the capture, and the reservation is released only after the lease proves its emulator gone", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 } }), app = await h.application();
  const a = await acquire(h, app, 12), lease = leaseClient(h, a), video = randomUUID();
  const recording = lease.video.record({ id: video, member: "primary", durationSeconds: 60, ...VIDEO }, sink(), { timeoutMs: 40000 });
  void recording.catch(() => {});
  await until(() => h.media.recorders.get(`cvm-${a.machineId}`)?.running === true, "recording started");
  assert.deepEqual(await h.reserved(), { cpu: 3, memoryMiB: 2304, diskGiB: 8 });
  // The lease expires during the recording: the stream ends without a completion proof.
  await assert.rejects(recording, (error: any) => ["video_incomplete", "session_incomplete", "session_disconnected"].includes(error.code));
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.ok(Date.now() - h.media.recorders.get(`cvm-${a.machineId}`)!.started < 30000, "the capture ended with the lease, not at its time limit");
  // The host encoder exited; the guest recorder's own stop is not provable once the emulator is fenced.
  await until(async () => (await lease.video.inspect(video)).hostCleaned === true, "host encoder cleanup", 30000);
  assert.equal(h.media.encodersOpen, 0);
  // The lease's positive cleanup (group gone, storage removed) is the guest's proof; then the reservation is released.
  await cleaned(h, app, a.id);
  await until(async () => (await lease.video.inspect(video)).cleaned === true, "recording settled by lease cleanup");
  assert.equal((await lease.video.inspect(video)).state, "disconnected");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  // The ended lease cannot record again.
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", durationSeconds: 2, ...VIDEO }, a.key)).status, 410);
});

test("key rotation and release each end an in-progress recording; the runner's exact-recorder proof or the lease's cleanup releases it", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 } }), app = await h.application();
  const a = await acquire(h, app, 120), name = `cvm-${a.machineId}`;
  // Rotation: the old key's recording ends while the lease and emulator stay live, so the runner
  // stops and proves the exact guest recorder itself.
  const first = randomUUID(), rotating = leaseClient(h, a).video.record({ id: first, member: "primary", durationSeconds: 60, ...VIDEO }, sink(), { timeoutMs: 40000 });
  void rotating.catch(() => {});
  await until(() => h.media.recorders.get(name)?.running === true, "first recording started");
  const key = (await h.api("POST", `/v1/leases/${a.id}/credential`, {}, app)).body.credential as string, lease = leaseClient(h, { id: a.id, key });
  await assert.rejects(rotating);
  await until(async () => (await lease.video.inspect(first)).cleaned === true, "runner recorder proof");
  assert.equal(h.media.recorders.get(name)!.running, false);
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  // Release: the lease ends, the recording with it, and the reservation follows the cleanup proof.
  const second = randomUUID(), releasing = lease.video.record({ id: second, member: "primary", durationSeconds: 60, ...VIDEO }, sink(), { timeoutMs: 40000 });
  void releasing.catch(() => {});
  await until(() => h.media.recorders.get(name)?.running === true, "second recording started");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, key)).status, 200);
  await assert.rejects(releasing);
  await cleaned(h, app, a.id);
  await until(async () => (await lease.video.inspect(second)).cleaned === true, "recording released after proof");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("supervisor loss mid-recording ends the capture, fails the lease and holds the recording reservation until operator recovery", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 } }), app = await h.application();
  const a = await acquire(h, app, 120), group = supervised(h, a.machineId), lease = leaseClient(h, a), video = randomUUID();
  const recording = lease.video.record({ id: video, member: "primary", durationSeconds: 90, ...VIDEO }, sink(), { timeoutMs: 40000 });
  void recording.catch(() => {});
  await until(() => h.media.recorders.get(`cvm-${a.machineId}`)?.running === true, "recording started");
  process.kill(group.supervisorPid, "SIGKILL");
  // The capture's native check sees the free supervisor lock and ends promptly.
  await assert.rejects(recording);
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "failed lease", 15000);
  await until(async () => (await lease.video.inspect(video)).hostCleaned === true || (await lease.video.inspect(video)).cleaned === true, "capture teardown", 30000);
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.cleanup.state === "blocked", "blocked cleanup");
  // Unless the runner proved the exact recorder stopped, the session and the emulator stay reserved.
  const held = await lease.video.inspect(video);
  assert.deepEqual(await h.reserved(), held.cleaned ? { cpu: 2, memoryMiB: 2048, diskGiB: 8 } : { cpu: 3, memoryMiB: 2304, diskGiB: 8 });
  assert.ok(alive(group.childPid));
  // Documented recovery: the operator stops the process group named in lease-supervisor.json.
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, a.id);
  await until(async () => (await lease.video.inspect(video)).cleaned === true, "recording settled");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("an unconfirmed encoder exit keeps the recording reserved after lease cleanup until an administrator abandons it", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "stuck" }), app = await h.application();
  const a = await acquire(h, app, 10), lease = leaseClient(h, a), video = randomUUID();
  const recording = lease.video.record({ id: video, member: "primary", durationSeconds: 1, ...VIDEO }, sink(), { timeoutMs: 40000 });
  void recording.catch(() => {});
  await assert.rejects(recording);
  await cleaned(h, app, a.id);
  await new Promise(resolve => setTimeout(resolve, 2000));
  const held = await lease.video.inspect(video);
  assert.deepEqual([held.cleaned, held.hostCleaned], [false, false]);
  assert.deepEqual(await h.reserved(), { cpu: 1, memoryMiB: 256, diskGiB: 0 });
  // The application's limits keep counting it.
  assert.equal(held.state, "disconnected");
  // Abandonment needs administrator authority and the session deadline; then lease cleanup releases it.
  await until(async () => (await h.api("POST", `/v1/machines/${a.machineId}/video-sessions/${video}/abandon`, { reason: "encoder wedged; host inspected" }, h.admin)).status === 200, "abandonment after the deadline", 90000);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("expiry mid-upload and mid-install: chunks are refused, and each upload is released only on proof", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { diskGiB: 8 }, installStall: true }), app = await h.application();
  const a = await acquire(h, app, 14), lease = leaseClient(h, a), build = apk(h, 1_100_000);
  // One upload stops after its first chunk.
  const partial = randomUUID();
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: partial, member: "primary", format: "apk", bytes: build.payload.length, sha256: build.sha256 }, a.key)).status, 201);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts/${partial}/chunks`, { offset: 0, data: build.payload.subarray(0, 524288).toString("base64") }, a.key)).body.received, 524288);
  // Another is published and its install stalls mid-transfer.
  const full = randomUUID(); await lease.uploadApp({ id: full, member: "primary", file: build.file });
  const install = randomUUID(); await lease.installApp({ id: install, member: "primary", artifact: full });
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 12 });
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease", 30000);
  // The ended lease refuses further chunks and publication; the saved receipt stays readable.
  const refused = await h.api("POST", `/v1/leases/${a.id}/app-artifacts/${partial}/chunks`, { offset: 524288, data: build.payload.subarray(524288, 1048576).toString("base64") }, a.key);
  assert.equal(refused.status, 410); assert.equal(refused.body.code, "lease_ended");
  // The never-installed upload has no native stage and is released at once.
  await until(async () => (await lease.appArtifact(partial)).state === "deleted", "release of the never-installed upload");
  // The interrupted install is never replayed; its upload is held until the emulator is proven gone.
  const interrupted = await receipt(lease, install);
  assert.ok(["unknown", "failed"].includes(interrupted.state), JSON.stringify(interrupted));
  assert.equal(h.media.commits, 0);
  await cleaned(h, app, a.id);
  await until(async () => (await lease.appArtifact(full)).state === "deleted", "release after lease cleanup proof");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("recording and upload reservations count against the application's limits", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 2, memoryMiB: 1024, diskGiB: 8 } }), app = await h.application({ cpu: 2, memoryMiB: 4096, diskGiB: 8 });
  const a = await acquire(h, app, 120), build = apk(h, 4096);
  // The lease already uses the application's two CPUs and eight GiB: a recording or an upload would exceed them.
  const video = await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", durationSeconds: 2, ...VIDEO }, a.key);
  assert.equal(video.status, 429);
  const upload = await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "apk", bytes: 4096, sha256: build.sha256 }, a.key);
  assert.equal(upload.status, 429);
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  // A member without the capability or another member name is refused before any reservation.
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "other", durationSeconds: 2, ...VIDEO }, a.key)).status, 404);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
});
