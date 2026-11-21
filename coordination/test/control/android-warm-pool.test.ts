import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { HostRunner, hostOffer } from "../../src/host.ts";
import { normalizeOperatorTemplate } from "../../src/control/templates.ts";
import { LEASE_ISOLATION_ARGUMENTS } from "../../src/providers/android.ts";
import { memberSource } from "../../src/consumer-client.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";
import { acquire, alive, arch, cleaned, emulators, groupAlive, harness, helper, operate, ready, skip, sleep, supervised, systemImage, unix, until, watchReceipt } from "./android-fixture.ts";
import type { Harness, HarnessOptions } from "./android-fixture.ts";

/** Warm pool fixtures: the real controller, HostRunner, lease supervisor and SDK types with stand-in
 * emulator, adb and avdmanager processes. They prove the ledger, the hand-over and the cleanup
 * contracts. They do not show that a real emulator stays healthy while idle, or how long a real
 * adoption takes; no real emulator is started here. */
const POOL = { maxDevices: 2, maxAgeSeconds: 600 }, SLOT = { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, NONE = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
const tablet: RecordValue = { id: "lease-tablet", revision: "1", os: "android", arch, mode: "device", minimum: SLOT, device: { systemImage, profile: "pixel_tablet" } };
const target = (count: number, templateId = "lease-phone", maxAgeSeconds?: number) => ({ templateId, templateRevision: "1", arch, count, ...(maxAgeSeconds ? { maxAgeSeconds } : {}) });
async function pool(h: Harness): Promise<any> {
  const reply = await h.api("GET", `/v1/hosts/${h.hostId()}/warm-pool`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body;
}
async function configure(h: Harness, targets: unknown[], headroom?: RecordValue): Promise<any> {
  const reply = await h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets, ...(headroom ? { headroom } : {}) });
  assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body;
}
/** Waits until `count` warm devices of one image are booted, checked and offered. */
async function warm(h: Harness, count = 1, templateId = "lease-phone", ms = 40000): Promise<any[]> {
  let devices: any[] = [];
  await until(async () => { devices = (await pool(h)).devices.filter((d: any) => d.state === "ready" && d.templateId === templateId); return devices.length >= count; }, `${count} ready warm device(s)`, ms);
  return devices;
}
const record = (h: Harness, machineId: string, name: string): any => JSON.parse(readFileSync(join(h.storage(machineId), name), "utf8"));
const lease = async (h: Harness, app: string, id: string): Promise<any> => (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body;
const emulator = (h: Harness, machineId: string) => emulators(h.registry).find(e => e.name === `cvm-${machineId}`);
/** No warm device, no waiting work and nothing left reserved. */
async function drained(h: Harness): Promise<void> {
  await configure(h, []);
  await until(async () => (await pool(h)).devices.length === 0 && JSON.stringify(await h.reserved()) === JSON.stringify(NONE), "an empty pool and a released ledger", 40000);
}

test("warm devices are an explicit host opt-in with the host's own bounds", () => {
  const image = { id: "phone", revision: "1", os: "android", arch, mode: "device", minimum: SLOT, device: { systemImage, profile: "pixel_8" } };
  const base = { name: "h", provider: "android", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 16 }, templates: [image] };
  const leased = { ...base, leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "android" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" };
  if (unix) {
    assert.equal(hostOffer(leased).warmPool, undefined);
    assert.deepEqual(hostOffer({ ...leased, leaseWarmPool: { maxDevices: 2, maxAgeSeconds: 3600 } }).warmPool, { maxDevices: 2, maxAgeSeconds: 3600 });
    for (const bounds of [{ maxDevices: 0, maxAgeSeconds: 3600 }, { maxDevices: 2, maxAgeSeconds: 59 }, { maxDevices: 65, maxAgeSeconds: 3600 }, { maxDevices: 2 }, { maxDevices: 2, maxAgeSeconds: 3600, renew: true }])
      assert.throws(() => hostOffer({ ...leased, leaseWarmPool: bounds }), /leaseWarmPool/);
  }
  // Without supervised lease execution there is nothing that could bound or adopt a warm device.
  assert.throws(() => hostOffer({ ...base, leaseWarmPool: { maxDevices: 2, maxAgeSeconds: 3600 } }), /Warm devices need supervised Android lease execution/);
});

test("a lease takes over a ready warm device without another boot; its capacity is counted once; release proves cleanup", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 2, { warmPool: POOL }), app = await h.application();
  // Only an administrator sets targets, and only for a lease image the host advertises, within its bounds.
  const set = (body: unknown, token?: string) => h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, body, token);
  assert.ok([401, 403].includes((await set({ targets: [target(1)] }, app)).status), "an application key cannot change the pool");
  assert.ok([401, 403].includes((await h.api("GET", "/v1/warm-pool", undefined, app)).status), "an application key cannot read the pool");
  assert.equal((await set({ targets: [target(1, "unknown-image")] })).status, 409);
  assert.equal((await set({ targets: [target(3)] })).status, 400, "a target above the host's own device limit");
  assert.equal((await set({ targets: [target(1, "lease-phone", 601)] })).status, 400, "an age above the host's own maximum");
  assert.equal((await set({ targets: [target(1), target(1)] })).status, 400);
  assert.deepEqual(await h.reserved(), NONE);
  const configured = await configure(h, [target(1)]);
  assert.deepEqual(configured.limits, POOL); assert.equal(configured.targets[0].count, 1); assert.equal(configured.targets[0].maxAgeSeconds, 600);
  const [device] = await warm(h);
  const state = await pool(h);
  assert.deepEqual([state.targets[0].ready, state.targets[0].booting, state.targets[0].failed, state.targets[0].lastError], [1, 0, 0, null]);
  // The warm device is on the one ledger like any machine, before any lease exists.
  assert.deepEqual(await h.reserved(), SLOT);
  // It runs under the native supervisor as a warm hold, isolated and checked like a leased device.
  const hold = record(h, device.machineId, "lease-supervisor.json"), launched = record(h, device.machineId, "launch.json"), held = record(h, device.machineId, "lease-authorization.json");
  assert.ok(hold.warmId && hold.leaseId === undefined, "the supervisor owns a warm hold, not a lease");
  assert.equal(launched.leaseId, null); assert.equal(launched.warmId, hold.warmId); assert.equal(held.warmId, hold.warmId); assert.equal(held.fenced, false);
  assert.deepEqual(launched.argv.slice(-LEASE_ISOLATION_ARGUMENTS.length), LEASE_ISOLATION_ARGUMENTS);
  const isolation = record(h, device.machineId, "lease-isolation.json");
  assert.equal(isolation.isolated, true); assert.equal(isolation.bootId, launched.bootId);
  assert.ok(h.counters.get(`cvm-${device.machineId}:shell getprop ro.debuggable`), "the image check ran on the warm device");
  const running = emulator(h, device.machineId)!;
  assert.ok(alive(running.pid) && groupAlive(hold.childPid));
  // No owner, no lease key and no machine action reaches it.
  for (const [route, body] of [[`/v1/machines/${device.machineId}/operations`, { id: randomUUID(), action: "screenshot", arguments: {} }], [`/v1/machines/${device.machineId}/desired`, { state: "stopped" }],
    [`/v1/machines/${device.machineId}/delete`, { id: randomUUID() }], [`/v1/machines/${device.machineId}/baselines`, { id: randomUUID(), name: "warm", revision: "1" }]] as const)
    assert.equal((await h.api("POST", route, body)).status, 409, route);
  await assert.rejects(h.provider().endpoint({ id: device.machineId, lease: { id: randomUUID() }, warm: { id: hold.warmId } }, h.storage(device.machineId)), "a lease that has not adopted the device cannot address it");
  // A lease for the same image and size takes the device over.
  const a = await acquire(h, app, 120), view = await lease(h, app, a.id);
  assert.equal(a.machineId, device.machineId, "the lease's member is the warm device's own machine");
  assert.equal(memberSource(view), "warm");
  // The consumer sees where its device came from and nothing about the host or the pool.
  assert.deepEqual(Object.keys(view.members[0]).sort(), ["capabilities", "machineId", "name", "ready", "resources", "source", "state"]);
  // Same emulator process, same boot, same supervisor: nothing was booted for this lease.
  const adopted = record(h, a.machineId, "lease-supervisor.json"), bound = record(h, a.machineId, "launch.json");
  assert.deepEqual([adopted.leaseId, adopted.adoptedFrom, adopted.childPid, adopted.supervisorPid, adopted.bootId], [a.id, hold.warmId, hold.childPid, hold.supervisorPid, hold.bootId]);
  assert.equal(adopted.warmId, undefined);
  assert.deepEqual([bound.leaseId, bound.adoptedFrom, bound.warmId, bound.bootId], [a.id, hold.warmId, undefined, launched.bootId]);
  assert.equal(emulator(h, a.machineId)!.pid, running.pid);
  assert.equal(record(h, a.machineId, "lease-adoption.json").state, "complete");
  // The supervisor now enforces the lease's own deadline, and the isolation proof is this boot's.
  const leased = record(h, a.machineId, "lease-authorization.json");
  assert.equal(leased.leaseId, a.id); assert.equal(leased.warmId, undefined); assert.equal(leased.fenced, false);
  assert.equal(record(h, a.machineId, "lease-isolation.json").bootId, adopted.bootId);
  // The adopted machine holds one reservation; the pool's replacement is a second, separate one.
  const allocations = ((await h.api("GET", `/v1/hosts/${h.hostId()}/resources`)).body.allocations as any[]).filter(entry => entry.id === a.machineId);
  assert.equal(allocations.length, 1);
  const [replacement] = await warm(h);
  assert.notEqual(replacement.machineId, a.machineId);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  // Scoped control works through the lease key; the application key still cannot act as it.
  assert.equal((await operate(h, a.id, a.key, "screenshot")).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, app)).status, 401);
  // Release: the usual stop proof, storage removal and credential erasure, then the reservation.
  const stopped = watchReceipt(t, join(h.storage(a.machineId), "lease-stopped.json"));
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await until(() => !groupAlive(hold.childPid), "release stops the adopted device");
  await until(() => stopped() !== undefined, "stop receipt");
  assert.deepEqual([stopped().leaseId, stopped().adoptedFrom, stopped().groupAbsent], [a.id, hold.warmId, true]);
  await cleaned(h, app, a.id);
  assert.equal(existsSync(h.storage(a.machineId)), false);
  assert.equal(existsSync(join(h.root, "devices", "avds", `cvm-${a.machineId}.ini`)), false);
  assert.equal(existsSync(join(h.root, "runner", "machines", a.machineId)), false, "the assignment's credential directory is erased");
  assert.deepEqual(await h.reserved(), SLOT, "only the replacement warm device remains reserved");
  // The device served one lease and is gone; it never returns to the pool.
  assert.ok(!(await pool(h)).devices.some((d: any) => d.machineId === a.machineId));
  await drained(h);
  assert.equal(emulators(h.registry).length, 0);
  assert.equal(existsSync(h.storage(replacement.machineId)), false);
  await until(() => !existsSync(join(h.root, "runner", "machines", replacement.machineId)), "a retired warm device leaves no local journal");
});

test("an empty pool means a cold boot, and one warm device never goes to two leases", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 2, { warmPool: POOL }), app = await h.application();
  // No target: the pool is enabled but empty, so the lease boots its own device.
  const cold = await acquire(h, app, 120);
  assert.equal(memberSource(await lease(h, app, cold.id)), "cold");
  assert.equal(record(h, cold.machineId, "launch.json").adoptedFrom, undefined);
  assert.equal((await h.api("POST", `/v1/leases/${cold.id}/release`, { id: randomUUID() }, cold.key)).status, 200);
  await cleaned(h, app, cold.id);
  // One warm device, two leases admitted at the same time. One slot of headroom keeps the pool
  // from starting a second device, so exactly one lease can be served warm.
  await configure(h, [target(1)], SLOT);
  const [device] = await warm(h);
  const [a, b] = await Promise.all([acquire(h, app, 120), acquire(h, app, 120)]);
  assert.notEqual(a.machineId, b.machineId);
  const sources = [memberSource(await lease(h, app, a.id)), memberSource(await lease(h, app, b.id))];
  assert.deepEqual([...sources].sort(), ["cold", "warm"]);
  const winner = sources[0] === "warm" ? a : b, other = winner === a ? b : a;
  assert.equal(winner.machineId, device.machineId);
  assert.deepEqual([record(h, winner.machineId, "lease-supervisor.json").leaseId, record(h, other.machineId, "lease-supervisor.json").leaseId], [winner.id, other.id]);
  // Each key reaches only its own device.
  assert.equal((await h.api("POST", `/v1/leases/${other.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, winner.key)).status, 401);
  assert.equal(emulators(h.registry).length, 2);
  // The host is full, so the pool cannot refill and nothing is overspent.
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  assert.equal((await pool(h)).devices.length, 0);
  await configure(h, []);
  for (const item of [a, b]) assert.equal((await h.api("POST", `/v1/leases/${item.id}/release`, { id: randomUUID() }, item.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), NONE);
});

test("warm devices respect headroom and capacity, and a waiting request for another image takes a warm device's capacity", { skip, timeout: 240000 }, async t => {
  const h = await harness(t, 2, { warmPool: POOL, templates: [tablet] }), app = await h.application();
  // With one slot of headroom the pool fills only one of two wanted devices.
  await configure(h, [target(2)], SLOT);
  await warm(h);
  await sleep(3000);
  let state = await pool(h);
  assert.deepEqual([state.targets[0].ready, state.targets[0].booting], [1, 0]);
  assert.deepEqual(await h.reserved(), SLOT);
  // Without headroom it fills the host, and never beyond it.
  await configure(h, [target(2)], NONE);
  const filled = (await warm(h, 2)).map(d => d.machineId);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  assert.equal(emulators(h.registry).length, 2);
  // A request for another image cannot use a warm phone. It waits, and wins: one phone is given up.
  const waiting = await acquire(h, app, 120, false, "lease-tablet");
  assert.equal((await h.api("GET", `/v1/requests/${waiting.id}`, undefined, app)).body.state, "waiting");
  const tabletLease = await ready(h, app, waiting.id);
  assert.equal(memberSource(await lease(h, app, tabletLease.id)), "cold");
  assert.ok(!filled.includes(tabletLease.machineId));
  // Its capacity came from a warm device that was stopped and removed with proof first.
  state = await pool(h);
  const survivors = state.devices.filter((d: any) => d.state === "ready").map((d: any) => d.machineId);
  assert.equal(survivors.length, 1);
  const givenUp = filled.find(id => !survivors.includes(id))!;
  assert.equal(existsSync(h.storage(givenUp)), false);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  // A phone request takes the remaining warm device at once.
  const phone = await acquire(h, app, 120);
  assert.equal(phone.machineId, survivors[0]); assert.equal(memberSource(await lease(h, app, phone.id)), "warm");
  // The host is full and the pool is empty: the next request waits, and nothing is created for the pool meanwhile.
  const queued = await acquire(h, app, 120, false);
  await sleep(2500);
  assert.equal((await h.api("GET", `/v1/requests/${queued.id}`, undefined, app)).body.state, "waiting");
  assert.equal((await pool(h)).devices.length, 0);
  // When the tablet lease ends, the waiting request gets its capacity, not a new warm device.
  assert.equal((await h.api("POST", `/v1/leases/${tabletLease.id}/release`, { id: randomUUID() }, tabletLease.key)).status, 200);
  const second = await ready(h, app, queued.id);
  assert.equal(memberSource(await lease(h, app, second.id)), "cold");
  assert.equal((await pool(h)).devices.length, 0);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  await configure(h, []);
  for (const item of [phone, second]) assert.equal((await h.api("POST", `/v1/leases/${item.id}/release`, { id: randomUUID() }, item.key)).status, 200);
  await cleaned(h, app, phone.id); await cleaned(h, app, second.id); await cleaned(h, app, tabletLease.id);
  assert.deepEqual(await h.reserved(), NONE);
});

test("a warm device that fails its isolation or image check is fenced, never offered, and its boots back off", { skip, timeout: 180000 }, async t => {
  const options: HarnessOptions = { guest: "leaky", warmPool: POOL }, h = await harness(t, 1, options), app = await h.application();
  await configure(h, [target(1)]);
  let state: any;
  await until(async () => { state = await pool(h); return state.targets[0].failed >= 1; }, "the first failed warm boot", 40000);
  // The guest reached a host loopback port: fenced before it could ever be offered.
  assert.match(state.targets[0].lastError, /reached a host loopback service/);
  assert.equal(state.targets[0].ready, 0);
  const first = state.targets[0].lastErrorAt as number;
  assert.ok(state.targets[0].nextAttemptAt - first >= 14 && state.targets[0].nextAttemptAt - first <= 16, "the first retry waits about 15 seconds");
  options.guest = "debuggable";
  await until(async () => { state = await pool(h); return state.targets[0].failed >= 2; }, "the second failed warm boot", 60000);
  assert.match(state.targets[0].lastError, /user builds/);
  assert.ok(state.targets[0].lastErrorAt - first >= 14, "the second boot was not attempted before the back-off ended");
  assert.ok(state.targets[0].nextAttemptAt - state.targets[0].lastErrorAt >= 29, "the back-off doubles");
  assert.equal(state.targets[0].ready, 0);
  // Every failed device was stopped by its supervisor and removed with proof; nothing stays reserved.
  await until(async () => (await pool(h)).devices.length === 0 && JSON.stringify(await h.reserved()) === JSON.stringify(NONE), "failed warm devices removed");
  assert.equal(emulators(h.registry).length, 0);
  // Once the image is sound again, the pool recovers after its back-off and the failure count resets.
  options.guest = "isolated";
  await warm(h, 1, "lease-phone", 60000);
  state = await pool(h);
  assert.equal(state.targets[0].failed, 0); assert.equal(state.targets[0].nextAttemptAt, null);
  assert.match(state.targets[0].lastError, /user builds/, "the last error stays visible");
  const a = await acquire(h, app, 60);
  assert.equal(memberSource(await lease(h, app, a.id)), "warm");
  await configure(h, []);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
});

test("a warm device that died before adoption is removed with proof and the lease cold boots under the same reservation", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 1, { warmPool: POOL }), app = await h.application();
  await configure(h, [target(1)]);
  const [device] = await warm(h), hold = supervised(h, device.machineId), before = emulator(h, device.machineId)!;
  const stopped = watchReceipt(t, join(h.storage(device.machineId), "lease-stopped.json"));
  // The runner is away when the emulator dies, so the controller still believes the device is ready.
  await h.stopRunner();
  process.kill(-hold.childPid, "SIGKILL");
  await until(() => stopped() !== undefined && !alive(hold.supervisorPid), "the supervisor's own stop proof");
  assert.equal(stopped().reason, "exited"); assert.ok(stopped().warmId && stopped().leaseId === undefined);
  const claimed = await acquire(h, app, 120, false);
  await until(async () => (await h.api("GET", `/v1/requests/${claimed.id}`, undefined, app)).body.state === "admitted", "admission by claiming the warm device");
  const provisioning = await lease(h, app, claimed.id);
  assert.equal(provisioning.members[0].machineId, device.machineId);
  assert.equal(provisioning.state, "provisioning"); assert.equal(provisioning.members[0].ready, false);
  assert.equal(provisioning.members[0].source, undefined, "no source is claimed before the host proves one");
  // The claim did not reserve anything new: the host has one slot and it is the same one.
  assert.deepEqual(await h.reserved(), SLOT);
  await h.restartRunner();
  const a = await ready(h, app, claimed.id);
  // Never handed out: the dead warm device was removed, and a fresh device booted for this lease.
  assert.equal(a.machineId, device.machineId);
  assert.equal(memberSource(await lease(h, app, a.id)), "cold");
  const fresh = record(h, a.machineId, "launch.json"), supervisor = record(h, a.machineId, "lease-supervisor.json");
  assert.deepEqual([fresh.leaseId, fresh.adoptedFrom, fresh.warmId], [a.id, undefined, undefined]);
  assert.deepEqual([supervisor.leaseId, supervisor.adoptedFrom, supervisor.warmId], [a.id, undefined, undefined]);
  assert.notEqual(supervisor.childPid, hold.childPid); assert.notEqual(emulator(h, a.machineId)!.pid, before.pid);
  assert.equal(existsSync(join(h.storage(a.machineId), "lease-adoption.json")), false);
  assert.equal(JSON.parse(readFileSync(join(h.root, "runner", "machines", a.machineId, "warm-discard.json"), "utf8")).state, "complete");
  assert.equal(record(h, a.machineId, "lease-isolation.json").bootId, fresh.bootId, "readiness and isolation were checked under the new boot");
  assert.deepEqual(await h.reserved(), SLOT);
  assert.equal((await operate(h, a.id, a.key, "screenshot")).body.state, "succeeded");
  await configure(h, []);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  assert.equal(existsSync(h.storage(a.machineId)), false);
  assert.deepEqual(await h.reserved(), NONE);
});

test("runner and controller restarts neither leak nor relaunch a warm device; an adopted device expires with proven cleanup", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 1, { warmPool: POOL }), app = await h.application();
  await configure(h, [target(1)]);
  const [device] = await warm(h), hold = supervised(h, device.machineId);
  // Runner restart: the same supervised emulator is found again, never relaunched, never duplicated.
  await h.restartRunner();
  await sleep(2000);
  assert.equal(supervised(h, device.machineId).childPid, hold.childPid); assert.ok(alive(hold.childPid));
  assert.equal(emulators(h.registry).length, 1);
  let state = await pool(h);
  assert.deepEqual(state.devices.map((d: any) => [d.machineId, d.state]), [[device.machineId, "ready"]]);
  // Controller restart: targets, the device and its reservation are all still there.
  await h.stopController(); await h.startController();
  await sleep(2000);
  state = await pool(h);
  assert.deepEqual(state.devices.map((d: any) => [d.machineId, d.state]), [[device.machineId, "ready"]]);
  assert.equal(state.targets[0].count, 1);
  assert.deepEqual(await h.reserved(), SLOT);
  assert.equal(emulators(h.registry).length, 1); assert.ok(alive(hold.childPid));
  // The survivor is adopted, then its lease expires in use.
  // Removing the target gives the warm device up: stopped and removed with proof, then released.
  await configure(h, []);
  await until(async () => (await pool(h)).devices.length === 0 && JSON.stringify(await h.reserved()) === JSON.stringify(NONE), "the given-up device's reservation");
  assert.ok(!groupAlive(hold.childPid));
  assert.equal(existsSync(h.storage(device.machineId)), false);
  await configure(h, [target(1)]);
  const [next] = await warm(h), group = supervised(h, next.machineId), receipt = watchReceipt(t, join(h.storage(next.machineId), "lease-stopped.json"));
  const a = await acquire(h, app, 8);
  assert.equal(a.machineId, next.machineId); assert.equal(memberSource(await lease(h, app, a.id)), "warm");
  await configure(h, []); // The adopted device is the lease's now; nothing refills the pool afterwards.
  await until(async () => ["expired", "failed"].includes((await lease(h, app, a.id)).state), "terminal lease", 30000);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 410);
  await until(() => !groupAlive(group.childPid), "the supervisor stops the adopted device at the lease's deadline");
  await until(() => receipt() !== undefined, "stop receipt");
  assert.equal(receipt().leaseId, a.id); assert.equal(receipt().groupAbsent, true);
  await cleaned(h, app, a.id);
  assert.equal(existsSync(h.storage(a.machineId)), false);
  assert.deepEqual(await h.reserved(), NONE);
});

test("a claimed warm device whose lease ends before the host adopts it is stopped, removed and released with proof", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 1, { warmPool: POOL }), app = await h.application();
  await configure(h, [target(1)]);
  const [device] = await warm(h), hold = supervised(h, device.machineId), stopped = watchReceipt(t, join(h.storage(device.machineId), "lease-stopped.json"));
  // The runner is away: the lease claims the warm device, then is released before any adoption.
  await h.stopRunner();
  const claimed = await acquire(h, app, 120, false);
  await until(async () => (await h.api("GET", `/v1/requests/${claimed.id}`, undefined, app)).body.state === "admitted", "admission by claiming the warm device");
  assert.equal((await lease(h, app, claimed.id)).members[0].machineId, device.machineId);
  assert.equal((await h.api("POST", `/v1/leases/${claimed.id}/release`, { id: randomUUID() }, app)).status, 200);
  assert.equal((await h.api("POST", `/v1/leases/${claimed.id}/credential`, {}, app)).status, 410, "no key is ever issued for a device that was not handed over");
  await configure(h, []);
  // The device is the lease's to clean up. Its reservation stays held until the runner proves the stop.
  assert.deepEqual(await h.reserved(), SLOT);
  assert.ok(alive(hold.childPid), "the warm device still runs under its own hold");
  await h.restartRunner();
  await cleaned(h, app, claimed.id);
  // It ended as the warm hold it always was: the supervisor never adopted it for the lease.
  assert.ok(stopped() !== undefined); assert.ok(stopped().warmId && stopped().leaseId === undefined); assert.equal(stopped().reason, "fenced");
  assert.ok(!groupAlive(hold.childPid));
  assert.equal(existsSync(h.storage(device.machineId)), false);
  assert.equal(existsSync(join(h.root, "runner", "machines", device.machineId)), false);
  assert.equal(emulators(h.registry).length, 0);
  assert.deepEqual(await h.reserved(), NONE);
  assert.equal((await pool(h)).devices.length, 0);
});

test("the host refuses warm devices it did not opt into, and more of them than its own limit", { skip, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-warm-gate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const image = { id: "lease-phone", revision: "1", os: "android", arch, mode: "device", minimum: SLOT, device: { systemImage, profile: "pixel_8" } };
  const calls: RecordValue[] = [];
  const runtime = { kind: "android", reconcile: async (machine: RecordValue) => { calls.push(machine); return { state: machine.desired === "running" ? "starting" : "stopped" }; }, refreshExecution: async () => null, check: async () => ({ ready: true }) };
  const runner = (name: string, pool?: RecordValue) => new HostRunner({ url: "http://127.0.0.1:9", stateDir: join(root, name), name, provider: "android", storage: join(root, name + "-devices"), androidSDK: "/nonexistent",
    templates: [image], capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 64 }, leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1,
    leaseImages: [{ id: image.id, revision: "1", arch, runtime: "android" }], ...(pool ? { leaseWarmPool: pool } : {}) }, { providerFactory: () => runtime as any });
  const machine = (): RecordValue => ({ id: randomUUID(), templateId: image.id, template: normalizeOperatorTemplate(image), desired: "running", resources: SLOT,
    warm: { id: randomUUID(), state: "booting", authorizationDeadline: Date.now() / 1000 + 600, controllerNow: Date.now() / 1000 } });
  // No opt-in: a warm assignment is never started, whatever the controller sent.
  const plain = runner("plain"); await plain.initializeProviders();
  const unwanted = machine(); plain.assignments = [unwanted];
  const refused = await plain.reconcile(unwanted);
  assert.equal(refused.state, "error"); assert.match(String(refused.detail), /does not offer warm devices/);
  assert.equal(calls.at(-1)!.desired, "stopped");
  await plain.close();
  // Opted in with a limit of one: the second warm assignment is refused by the host itself.
  const limited = runner("limited", { maxDevices: 1, maxAgeSeconds: 600 }); await limited.initializeProviders();
  const [first, second] = [machine(), machine()].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  limited.assignments = [first!, second!];
  (limited as any).observeWarm(limited.assignments, (limited as any).clock.now());
  assert.equal((await limited.reconcile(first!)).state, "starting");
  assert.equal(calls.at(-1)!.desired, "running");
  // The hold travels beside the template as the device's only authorization: bounded and never a lease.
  const authorization = (calls.at(-1) as any) && (limited as any).warmAuthorization(String(first!.id), String((first!.warm as RecordValue).id));
  assert.ok(authorization.remainingSeconds > 590 && authorization.remainingSeconds <= 600);
  const over = await limited.reconcile(second!);
  assert.equal(over.state, "error"); assert.match(String(over.detail), /does not offer warm devices/);
  await limited.close();
});
