import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberSource } from "../../src/consumer-client.ts";
import { nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import { NOTHING, WARM_SLOT, acquire, alive, cleaned, configurePool, emulators, groupAlive, harness, helper, operate, poolState, ready, skip, sleep, stored, supervised, until, warmReady, warmTarget } from "./android-fixture.ts";
import type { Harness, HarnessOptions } from "./android-fixture.ts";

/** What the warm pool does when something goes wrong with one device: a creation that never
 * completes, an emulator that stops answering, and a runner lost in the middle of a hand-over.
 * Real controller, HostRunner and lease supervisor; stand-in emulator, adb and avdmanager. */
const POOL = { maxDevices: 2, maxAgeSeconds: 600 };
const lease = async (h: Harness, app: string, id: string): Promise<any> => (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body;

test("an AVD creation that never completes costs one slot, pauses that image's pool with a visible reason, and resumes after the operator clears it", { skip, timeout: 240000 }, async t => {
  const options: HarnessOptions = { avdmanager: "fail", warmPool: POOL }, h = await harness(t, 2, options);
  // Two devices are wanted and the host has room for both.
  await configurePool(h, [warmTarget(2)]);
  let state: any;
  await until(async () => { state = await poolState(h); return state.targets[0].failed >= 1; }, "the failed creation", 40000);
  assert.match(state.targets[0].lastError, /AVD creation did not complete and its outcome is unconfirmed/);
  const failedAt = state.targets[0].lastErrorAt as number;
  // Well past the first back-off (15 s): nothing more was created, because the first device's
  // removal cannot be proven. An image that has never booted here gets one device at a time.
  await sleep(21000);
  state = await poolState(h);
  assert.equal(state.devices.length, 1);
  const stuck = state.devices[0];
  assert.deepEqual([stuck.state, stuck.reason], ["retiring", "boot_failed"]);
  assert.deepEqual([state.targets[0].failed, state.targets[0].proven, state.targets[0].booting, state.targets[0].ready], [1, false, 0, 0]);
  assert.equal(state.targets[0].lastErrorAt, failedAt, "no second attempt was made");
  // The administrator sees why the image is paused and which machine to inspect.
  assert.deepEqual([state.targets[0].paused.reason, state.targets[0].paused.machineId, state.targets[0].paused.removal, state.targets[0].paused.givenUpFor], ["removal_unproven", stuck.machineId, "blocked", "boot_failed"]);
  // One reservation is held, not one per retry, and nothing runs.
  assert.deepEqual(await h.reserved(), WARM_SLOT);
  assert.equal(emulators(h.registry).length, 0);
  const machines = ((await h.api("GET", "/v1/machines")).body.machines as any[]).filter(machine => machine.warm);
  assert.deepEqual(machines.map(machine => machine.id), [stuck.machineId]);
  // The rule for an unconfirmed AVD is unchanged: the host does not remove it on its own.
  const storage = h.storage(stuck.machineId);
  assert.ok(existsSync(join(storage, "avd-create-started.json")) && !existsSync(join(storage, "avd-created.json")) && existsSync(join(storage, "device.avd")));
  // Documented recovery: the operator confirms the partial AVD is this machine's and removes it.
  options.avdmanager = "ok";
  rmSync(join(storage, "device.avd"), { recursive: true }); rmSync(join(storage, "avd-create-started.json"));
  // The removal is then proven, the slot is released, and the pool resumes: one device first, the
  // second once the image has booted and passed its checks here.
  await warmReady(h, 2, "lease-phone", 90000);
  assert.equal(existsSync(storage), false);
  state = await poolState(h);
  assert.deepEqual([state.targets[0].paused, state.targets[0].proven, state.targets[0].failed], [null, true, 0]);
  assert.ok(!state.devices.some((d: any) => d.machineId === stuck.machineId));
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  await configurePool(h, []);
  await until(async () => (await poolState(h)).devices.length === 0 && JSON.stringify(await h.reserved()) === JSON.stringify(NOTHING), "an empty pool", 40000);
});

test("a ready warm device that stops answering does not block a waiting request, and is recycled after a bounded time", { skip, timeout: 300000 }, async t => {
  const options: HarnessOptions = { warmPool: { maxDevices: 1, maxAgeSeconds: 3600 }, hung: new Set<string>() }, h = await harness(t, 1, options), app = await h.application();
  await configurePool(h, [warmTarget(1)]);
  const [first] = await warmReady(h), one = supervised(h, first.machineId);
  // The emulator hangs: adb still lists it, but it answers nothing. Its age is an hour away.
  options.hung!.add(`cvm-${first.machineId}`);
  await until(async () => (await poolState(h)).devices[0].unreadySince !== null, "the host's report that the device stopped answering");
  assert.deepEqual((await poolState(h)).devices.map((d: any) => [d.machineId, d.state]), [[first.machineId, "ready"]]);
  // A request for the same image cannot adopt it. It must not wait for it either: the full host's
  // only capacity is given back, with proof, and the request boots its own device.
  const started = Date.now(), waiting = await acquire(h, app, 120, false), a = await ready(h, app, waiting.id);
  assert.ok(Date.now() - started < 45000, "admitted long before the hung device's age or the unready bound");
  assert.notEqual(a.machineId, first.machineId);
  assert.equal(memberSource(await lease(h, app, a.id)), "cold");
  assert.ok(!groupAlive(one.childPid));
  assert.equal(existsSync(h.storage(first.machineId)), false);
  assert.deepEqual(await h.reserved(), WARM_SLOT);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  // With nobody waiting, a hung device is still not kept until its age: after 60 seconds without a
  // running, checked report it is given up and replaced.
  const [second] = await warmReady(h, 1, "lease-phone", 40000, [first.machineId]), two = supervised(h, second.machineId);
  options.hung!.add(`cvm-${second.machineId}`);
  const hungAt = Date.now();
  await sleep(20000);
  let state = await poolState(h);
  assert.deepEqual(state.devices.map((d: any) => [d.machineId, d.state]), [[second.machineId, "ready"]], "a short silence is tolerated");
  const [third] = await warmReady(h, 1, "lease-phone", 90000, [first.machineId, second.machineId]);
  assert.ok(Date.now() - hungAt >= 55000, "recycled at the bound, not before");
  assert.ok(!groupAlive(two.childPid));
  assert.equal(existsSync(h.storage(second.machineId)), false);
  state = await poolState(h);
  assert.match(state.targets[0].lastError, /not running and checked for 60 seconds/);
  assert.equal(state.targets[0].failed, 0, "an unresponsive ready device is replaced, not counted as a failed boot");
  assert.ok(alive(supervised(h, third.machineId).childPid));
  await configurePool(h, []);
  await until(async () => (await poolState(h)).devices.length === 0 && JSON.stringify(await h.reserved()) === JSON.stringify(NOTHING), "an empty pool", 40000);
});

test("a runner lost between publishing the adoption and rebinding its own records resumes the hand-over without another boot", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 1, { warmPool: POOL }), app = await h.application();
  await configurePool(h, [warmTarget(1)]);
  const [device] = await warmReady(h), hold = stored(h, device.machineId, "lease-supervisor.json"), launched = stored(h, device.machineId, "launch.json");
  const before = emulators(h.registry).find(e => e.name === `cvm-${device.machineId}`)!;
  await h.stopRunner();
  const claimed = await acquire(h, app, 120, false);
  await until(async () => (await h.api("GET", `/v1/requests/${claimed.id}`, undefined, app)).body.state === "admitted", "admission by claiming the warm device");
  // Exactly what the runner leaves on disk when it dies right after publishing: its adoption
  // journal and the lease's authorization that names the hold. The launch record is not rebound.
  const storage = h.storage(device.machineId), clock = await nativeLeaseSupervisor.clock(helper);
  const publish = (name: string, value: unknown) => { writeFileSync(join(storage, `${name}.tmp`), JSON.stringify(value)); renameSync(join(storage, `${name}.tmp`), join(storage, name)); };
  publish("lease-adoption.json", { version: 1, machineId: device.machineId, leaseId: claimed.id, warmId: hold.warmId, bootId: launched.bootId, state: "publishing" });
  publish("lease-authorization.json", { version: 1, machineId: device.machineId, leaseId: claimed.id, adoptedFrom: hold.warmId, bootId: launched.bootId, bootSessionID: clock.bootSessionID, revision: 1, deadline: clock.continuous + 100, fenced: false });
  // The supervisor adopts on its own; the device now belongs to the lease although no runner is alive.
  await until(() => stored(h, device.machineId, "lease-supervisor.json").leaseId === claimed.id, "the supervisor's adoption record");
  assert.equal(stored(h, device.machineId, "lease-supervisor.json").adoptedFrom, hold.warmId);
  assert.deepEqual([stored(h, device.machineId, "launch.json").leaseId, stored(h, device.machineId, "launch.json").warmId], [null, hold.warmId]);
  assert.equal((await lease(h, app, claimed.id)).state, "provisioning", "not ready before a runner proves the hand-over");
  // The returning runner finishes the rebinding from the supervisor's record. Nothing is relaunched.
  await h.restartRunner();
  const a = await ready(h, app, claimed.id);
  assert.equal(a.machineId, device.machineId); assert.equal(memberSource(await lease(h, app, a.id)), "warm");
  const bound = stored(h, a.machineId, "launch.json"), supervisor = stored(h, a.machineId, "lease-supervisor.json");
  assert.deepEqual([bound.leaseId, bound.adoptedFrom, bound.warmId, bound.bootId], [a.id, hold.warmId, undefined, launched.bootId]);
  assert.deepEqual([supervisor.childPid, supervisor.supervisorPid], [hold.childPid, hold.supervisorPid]);
  assert.equal(stored(h, a.machineId, "lease-adoption.json").state, "complete");
  assert.equal(emulators(h.registry).length, 1); assert.equal(emulators(h.registry)[0]!.pid, before.pid);
  assert.equal(stored(h, a.machineId, "lease-isolation.json").bootId, launched.bootId);
  assert.equal((await operate(h, a.id, a.key, "screenshot")).body.state, "succeeded");
  await configurePool(h, []);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), NOTHING);
});
