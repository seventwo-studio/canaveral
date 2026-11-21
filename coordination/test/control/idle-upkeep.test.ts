import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createAppArtifactsModule } from "../../src/control/app-artifacts.ts";
import type { ControlModule, ControlRequest } from "../../src/control/contracts.ts";
import { createModule as devicesModule } from "../../src/control/devices.ts";
import { createModule as lifecycleModule } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { MobileVideoSessions } from "../../src/control/mobile-video-sessions.ts";
import { createModule as upkeepModule, IDLE_STOP_MINIMUM_SECONDS } from "../../src/control/upkeep.ts";
import { hostOffer, upkeepPolicy } from "../../src/host.ts";
import { loadHostConfig } from "../../src/control/templates.ts";
import { pressureConfig } from "../../src/pressure.ts";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../../src/sqlite.ts";
import { leaseFixture } from "./leases-fixture.test.ts";
import { failure, operator, upkeepHarness } from "./upkeep-fixture.test.ts";

/** Idle upkeep is a controller rule, so most cases drive heartbeats directly with a fixture
 * clock; the last test runs the stop through a real HostRunner and the Android provider. */
const key = () => randomBytes(32).toString("base64url");
interface Policy { defaultSeconds: number | null; templates: Record<string, number | null> }
function idleFixture(t: TestContext, initial: Policy = { defaultSeconds: null, templates: {} }) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-idle-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  let now = 50_000, policy = initial, busy: string[] = [];
  const store = new SqliteStore(join(dir, "controller.sqlite"), () => now);
  const options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  const machines = new MachineStore(store, options);
  const principal = () => operator;
  const modules: ControlModule[] = [machines, lifecycleModule(store, options), devicesModule(store, options), createAppArtifactsModule(store, machines), new MobileVideoSessions(store, machines, principal), upkeepModule(store, options)];
  const template = (id: string) => ({ id, revision: "1", arch: "arm64", os: "android", mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } });
  const host = randomUUID(), token = key(), offer = { name: "idle fixture", provider: "android", capacity: { cpu: 64, memoryMiB: 65536, diskGiB: 512 }, templates: ["phone", "tablet", "kiosk"].map(template) };
  machines.enroll({ id: host, credential: token, offer }, options.enrollmentToken);
  async function request(method: string, target: string, body: Record<string, unknown> = {}): Promise<any> {
    const url = new URL(target, "http://fixture.invalid");
    const req: ControlRequest = { method, path: url.pathname, parts: url.pathname.split("/").filter(Boolean), query: url.searchParams, body, token: options.adminToken, principal };
    for (const module of modules) { const reply = await module.handle(req); if (reply !== undefined) return reply.body; }
    return assert.fail(`No controller route for ${method} ${target}`);
  }
  const running = new Set<string>();
  /** One heartbeat carrying the host's current policy, busy devices and every running device. */
  function beat(extra: Record<string, unknown> = {}): Map<string, string> {
    const reply = machines.heartbeat(host, token, { offer, upkeep: { version: 1, platforms: ["android"], idleStop: policy, busy }, reports: Object.fromEntries([...running].map(id => [id, { state: "running" }])), ...extra });
    return new Map((reply.machines as { id: string; desired: string }[]).map(machine => [machine.id, machine.desired]));
  }
  async function device(templateId = "phone"): Promise<string> {
    const machine = await request("POST", "/v1/machines", { id: randomUUID(), name: templateId, templateId });
    running.add(machine.id); beat(); return machine.id as string;
  }
  const preview = async (query = ""): Promise<any> => request("GET", `/v1/hosts/${host}/upkeep${query}`);
  const candidate = async (id: string, query = ""): Promise<any> => (await preview(query)).idleStop.devices.find((entry: any) => entry.machineId === id);
  return { store, machines, host, token, offer, request, beat, device, preview, candidate, running, now: () => now, advance(seconds: number) { now += seconds; },
    setPolicy(value: Policy) { policy = value; }, setBusy(value: string[]) { busy = value; } };
}

test("idle stop is off by default, and the dry run previews a policy without acting", async t => {
  const f = idleFixture(t), id = await f.device();
  f.advance(10 * 86_400);
  assert.equal(f.beat().get(id), "running");
  const idle = await f.candidate(id);
  assert.deepEqual([idle.idleStopSeconds, idle.wouldStop, idle.reason, idle.idleSeconds, idle.leased], [null, false, "policy_off", 864_000, false]);
  // What a ten-minute policy would do, before anyone configures it.
  const view = await f.preview("?idleStopSeconds=600");
  assert.equal(view.idleStop.previewSeconds, 600); assert.deepEqual(view.idleStop.policy, { defaultSeconds: null, templates: {} });
  assert.deepEqual([view.idleStop.devices[0].wouldStop, view.idleStop.devices[0].reason, view.idleStop.devices[0].idleStopSeconds], [true, "idle", 600]);
  // Reading the preview, any number of times, stops nothing.
  assert.equal(f.beat().get(id), "running");
  assert.equal((await f.request("GET", `/v1/machines/${id}`)).desired, "running");
  await assert.rejects(f.preview(`?idleStopSeconds=${IDLE_STOP_MINIMUM_SECONDS - 1}`), failure(400));
  await assert.rejects(f.preview("?idleStopSeconds=600&force=1"), failure(400));
});

test("a configured idle stop requests stopped through desired state and deletes nothing; a template overrides its host", async t => {
  const f = idleFixture(t, { defaultSeconds: 600, templates: { tablet: 1800, kiosk: null } });
  const phone = await f.device("phone"), tablet = await f.device("tablet"), kiosk = await f.device("kiosk");
  f.advance(599);
  assert.deepEqual([...f.beat().values()], ["running", "running", "running"]);
  assert.deepEqual([(await f.candidate(phone)).reason, (await f.candidate(tablet)).idleStopSeconds, (await f.candidate(kiosk)).reason], ["active", 1800, "policy_off"]);
  f.advance(1);
  const delivered = f.beat();
  assert.deepEqual([delivered.get(phone), delivered.get(tablet), delivered.get(kiosk)], ["stopped", "running", "running"]);
  // The host performs and proves the stop as for any owner stop; compute is released only then.
  const reserved = () => f.machines.hosts({ principal: () => operator }).find(entry => entry.id === f.host)!.reserved;
  assert.deepEqual(reserved(), { cpu: 3, memoryMiB: 3072, diskGiB: 12 });
  f.running.delete(phone); f.beat({ reports: { [phone]: { state: "stopped" }, [tablet]: { state: "running" }, [kiosk]: { state: "running" } } });
  assert.deepEqual(reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 12 });
  // Nothing was deleted: the device, its disk reservation and its identity remain.
  const stopped = await f.candidate(phone);
  assert.deepEqual([stopped.desired, stopped.reason, stopped.lastIdleStop.idleSeconds, stopped.lastIdleStop.idleStopSeconds], ["stopped", "not_running", 600, 600]);
  assert.equal((await f.request("GET", `/v1/machines/${phone}`)).observed, "stopped");
  f.store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM machine_deletions").get()!.n, 0));
  f.advance(1200);
  assert.deepEqual([f.beat().get(tablet), f.beat().get(kiosk)], ["stopped", "running"]);
  // The owner starts it again, and the idle clock starts with that run.
  assert.equal((await f.request("POST", `/v1/machines/${phone}/desired`, { state: "running" })).desired, "running");
  f.running.add(phone); f.running.delete(tablet); f.beat({ reports: { [phone]: { state: "running" }, [tablet]: { state: "stopped" }, [kiosk]: { state: "running" } } });
  f.advance(599); assert.equal(f.beat().get(phone), "running");
  f.advance(1); assert.equal(f.beat().get(phone), "stopped");
  f.advance(30 * 86_400); assert.equal(f.beat().get(kiosk), "running");
});

test("work in flight holds a device, and finished work restarts its idle clock", async t => {
  const f = idleFixture(t, { defaultSeconds: 600, templates: {} }), id = await f.device();
  f.advance(595); f.beat();
  const operation = await f.request("POST", `/v1/machines/${id}/operations`, { id: randomUUID(), action: "screenshot", arguments: {} });
  assert.equal(operation.state, "queued");
  f.advance(5);
  assert.equal(f.beat().get(id), "running");
  assert.deepEqual([(await f.candidate(id)).reason, (await f.candidate(id)).blockers], ["work_in_flight", ["operation_in_flight"]]);
  f.advance(10); f.beat({ deviceReports: { [operation.id]: { state: "succeeded", result: {} } } });
  // The finished operation is the last activity.
  f.advance(599); assert.equal(f.beat().get(id), "running"); assert.equal((await f.candidate(id)).idleSeconds, 599);
  f.advance(1); assert.equal(f.beat().get(id), "stopped");

  // Work only the host can see, such as a local viewer, holds the device the same way.
  const local = await f.device();
  f.setBusy([local]); f.advance(5000);
  assert.equal(f.beat().get(local), "running");
  assert.deepEqual([(await f.candidate(local)).reason, (await f.candidate(local)).blockers], ["work_in_flight", ["host_work_in_flight"]]);
  // The viewer closes. Its end is activity, so the device is not stopped on the next heartbeat;
  // it gets a full idle time from the moment it was last held.
  f.setBusy([]);
  assert.equal(f.beat().get(local), "running");
  assert.deepEqual([(await f.candidate(local)).reason, (await f.candidate(local)).idleSeconds], ["active", 0]);
  f.advance(599); assert.equal(f.beat().get(local), "running");
  f.advance(1); assert.equal(f.beat().get(local), "stopped");

  // A recording and an upload are work too. Without them both devices would be idle here.
  const recorded = await f.device(), uploading = await f.device();
  f.advance(590); f.beat();
  const recording = await f.request("POST", `/v1/machines/${recorded}/video-sessions`, { id: randomUUID(), fps: 30, durationSeconds: 60, bitRate: 4_000_000 });
  f.store.transaction(db => db.prepare("INSERT INTO app_artifacts (id,machine,host,binding,format,bytes,sha256,received,state,reserved_disk) VALUES (?,?,?,'{}','apk',1024,?,0,'uploading',1)").run(randomUUID(), uploading, f.host, "0".repeat(64)));
  f.advance(20);
  const held = f.beat();
  assert.deepEqual([held.get(recorded), held.get(uploading)], ["running", "running"]);
  assert.deepEqual([(await f.candidate(recorded)).blockers, (await f.candidate(uploading)).blockers], [["video_session"], ["upload_in_flight"]]);
  assert.equal((await f.candidate(uploading)).reason, "work_in_flight");
  await f.request("POST", `/v1/machines/${recorded}/video-sessions/${recording.id}/close`, {});
  f.store.transaction(db => db.exec("UPDATE app_artifacts SET state='ready'"));
  // The upload has no timestamp of its own. Its end still counts: the build that was just
  // published can be installed without the device being stopped under it first.
  const after = f.beat();
  assert.deepEqual([after.get(recorded), after.get(uploading)], ["running", "running"]);
  assert.deepEqual([(await f.candidate(uploading)).blockers, (await f.candidate(uploading)).reason, (await f.candidate(uploading)).idleSeconds], [[], "active", 0]);
  f.advance(599);
  const waiting = f.beat();
  assert.deepEqual([waiting.get(recorded), waiting.get(uploading)], ["running", "running"]);
  f.advance(1); assert.equal(f.beat().get(uploading), "stopped");
  // A recording counts as activity up to its authorization deadline, then the idle time runs.
  f.advance(700); assert.equal(f.beat().get(recorded), "stopped");
});

test("an owner's start is activity: a device started right after an idle stop is not stopped again", async t => {
  const f = idleFixture(t, { defaultSeconds: 600, templates: {} }), id = await f.device();
  f.advance(600);
  assert.equal(f.beat().get(id), "stopped");
  // The owner starts it again before the host has reported the stop, so the host still says running.
  assert.equal((await f.request("POST", `/v1/machines/${id}/desired`, { state: "running" })).desired, "running");
  for (let heartbeat = 0; heartbeat < 3; heartbeat++) { f.advance(5); assert.equal(f.beat().get(id), "running"); }
  assert.deepEqual([(await f.candidate(id)).reason, (await f.candidate(id)).idleSeconds], ["active", 15]);
  // It is stopped again only after a whole idle time from that start.
  f.advance(584); assert.equal(f.beat().get(id), "running");
  f.advance(1); assert.equal(f.beat().get(id), "stopped");
  // The same holds for a start that follows the owner's own stop.
  const other = await f.device();
  f.advance(595); f.beat();
  await f.request("POST", `/v1/machines/${other}/desired`, { state: "stopped" });
  await f.request("POST", `/v1/machines/${other}/desired`, { state: "running" });
  f.advance(10);
  assert.equal(f.beat().get(other), "running");
  f.advance(589); assert.equal(f.beat().get(other), "running");
  f.advance(1); assert.equal(f.beat().get(other), "stopped");
});

test("a device with an uncertain operation is never stopped until that operation is resolved", async t => {
  const f = idleFixture(t, { defaultSeconds: 600, templates: {} }), installing = await f.device(), recording = await f.device();
  // An uploaded-app install whose outcome and cleanup are unknown: stopping would remove the inspection path.
  const install = randomUUID();
  f.store.transaction(db => {
    db.prepare("INSERT INTO device_operations(id,machine,host,request,state,result,updated,created) VALUES (?,?,?,?,'unknown',?,?,?)")
      .run(install, installing, f.host, JSON.stringify({ id: install, action: "install-uploaded", arguments: { artifact: randomUUID() } }), JSON.stringify({ detail: "fixture" }), f.now(), f.now());
    db.prepare("INSERT INTO control_device_dispatch VALUES (?,?)").run(install, f.now());
    // A recording that ended without the runner's positive cleanup.
    db.prepare(`INSERT INTO mobile_video_sessions (id,machine,host,binding,generation,credential,request,state,created,deadline,host_attached,consumer_attached,cleaned)
      VALUES (?,?,?,'{}',?,'fixture','{}','closed',?,?,1,1,0)`).run(randomUUID(), recording, f.host, randomUUID(), f.now(), f.now() + 30);
  });
  for (const days of [1, 30]) {
    f.advance(days * 86_400);
    const delivered = f.beat();
    assert.deepEqual([delivered.get(installing), delivered.get(recording)], ["running", "running"]);
  }
  assert.deepEqual([(await f.candidate(installing)).reason, (await f.candidate(installing)).blockers], ["uncertain_operation", ["uncertain_install"]]);
  assert.deepEqual([(await f.candidate(recording)).reason, (await f.candidate(recording)).blockers], ["uncertain_operation", ["video_cleanup_unconfirmed"]]);
  // An administrator's resolution, or the runner's cleanup receipt, releases the hold.
  f.store.transaction(db => {
    db.prepare("INSERT INTO device_operation_resolutions VALUES (?,?,'abandoned',NULL,'fixture','{}',?)").run(randomUUID(), install, f.now());
    db.exec("UPDATE mobile_video_sessions SET cleaned=1");
  });
  // The hold itself counted as activity, so each gets a whole idle time from its end.
  const released = f.beat();
  assert.deepEqual([released.get(installing), released.get(recording)], ["running", "running"]);
  assert.deepEqual([(await f.candidate(installing)).blockers, (await f.candidate(installing)).reason], [[], "active"]);
  f.advance(600);
  const idle = f.beat();
  assert.deepEqual([idle.get(installing), idle.get(recording)], ["stopped", "stopped"]);
});

test("leased devices and devices that are not confirmed running are never stopped by upkeep", async t => {
  const f = leaseFixture(t, "android", "device"), upkeep = upkeepModule(f.store, f.options);
  const report = { version: 1, platforms: ["android"], idleStop: { defaultSeconds: 300, templates: {} }, busy: [] };
  const lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 })), machine = lease.members[0].machineId as string;
  f.beat({ upkeep: report, reports: { [machine]: { state: "running", accessReady: true } } });
  f.advance(3000);
  const delivered = f.beat({ upkeep: report, reports: { [machine]: { state: "running", accessReady: true } } }).machines as { id: string; desired: string }[];
  assert.deepEqual(delivered.map(entry => [entry.id, entry.desired]), [[machine, "running"]]);
  const req: ControlRequest = { method: "GET", path: `/v1/hosts/${f.host}/upkeep`, parts: ["v1", "hosts", f.host, "upkeep"], query: new URLSearchParams(), body: {}, token: f.options.adminToken, principal: () => operator };
  const devices = ((await upkeep.handle(req))!.body as any).idleStop.devices;
  assert.deepEqual(devices.map((entry: any) => [entry.machineId, entry.leased, entry.wouldStop, entry.reason]), [[machine, true, false, "leased"]]);
  assert.equal((await f.request("GET", `/v1/leases/${lease.id}`)).state, "ready");

  // Unleased, but never confirmed running: there is no run to measure, so nothing is stopped.
  const g = idleFixture(t, { defaultSeconds: 600, templates: {} }), starting = await g.device();
  g.running.delete(starting);
  g.beat({ reports: { [starting]: { state: "starting" } } });
  g.advance(5000);
  assert.equal(g.beat({ reports: { [starting]: { state: "starting" } } }).get(starting), "running");
  assert.equal((await g.candidate(starting)).reason, "not_running");
  // Its idle clock starts when it is next seen running.
  g.running.add(starting); g.beat(); g.advance(599);
  assert.equal(g.beat().get(starting), "running");
  g.advance(1);
  assert.equal(g.beat().get(starting), "stopped");
});

test("upkeep policy is validated on the host and on the controller", async t => {
  assert.deepEqual(upkeepPolicy(undefined, []), { defaultSeconds: null, templates: {} });
  assert.deepEqual(upkeepPolicy({ idleStopSeconds: 3600, templates: { phone: { idleStopSeconds: 900 }, kiosk: { idleStopSeconds: 0 } } }, ["phone", "kiosk"]), { defaultSeconds: 3600, templates: { phone: 900, kiosk: null } });
  for (const invalid of [{ idleStopSeconds: 60 }, { idleStopSeconds: "600" }, { idleStopSeconds: 600.5 }, { deleteAfterSeconds: 600 }, { templates: { unknown: { idleStopSeconds: 600 } } }, { templates: { phone: { idleStopSeconds: 600, delete: true } } }])
    assert.throws(() => upkeepPolicy(invalid, ["phone"]), failure(400), JSON.stringify(invalid));
  // The shipped example host files stay valid: idle stop off for the Android host except one template.
  const example = (name: string) => loadHostConfig(fileURLToPath(new URL(`../../../../examples/${name}`, import.meta.url)));
  const android = example("host-android.json"), ios = example("host-ios.json");
  assert.deepEqual(upkeepPolicy(android.upkeep, android.templates.map(template => String(template.id))), { defaultSeconds: null, templates: { "android-phone": 3600 } });
  assert.deepEqual(upkeepPolicy(ios.upkeep, ios.templates.map(template => String(template.id))), { defaultSeconds: 7200, templates: {} });
  assert.deepEqual([pressureConfig(android.pressure).enabled, pressureConfig(ios.pressure).thresholds.disk], [true, { enterFreeGiB: 10, exitFreeGiB: 20 }]);
  // The examples report pressure and gate nothing on it.
  for (const config of [android, ios]) assert.deepEqual(pressureConfig(config.pressure).gates, { placement: false, restart: false });
  assert.deepEqual([hostOffer(android).provider, hostOffer(ios, "darwin").provider], ["android", "ios"]);
  const f = idleFixture(t), id = await f.device();
  for (const upkeep of [{ version: 1, platforms: ["android"], idleStop: { defaultSeconds: 10, templates: {} }, busy: [] }, { version: 2, platforms: [], idleStop: { defaultSeconds: null, templates: {} }, busy: [] },
    { version: 1, platforms: ["tvos"], idleStop: { defaultSeconds: null, templates: {} }, busy: [] }, { version: 1, platforms: [], idleStop: { defaultSeconds: null, templates: {} }, busy: ["not-a-uuid"] },
    { version: 1, platforms: [], idleStop: { defaultSeconds: null, templates: {}, deleteAfterSeconds: 60 }, busy: [] }])
    assert.throws(() => f.beat({ upkeep }), failure(400), JSON.stringify(upkeep));
  // A runner that reports no upkeep (an older one) is never subject to idle stops.
  f.setPolicy({ defaultSeconds: 600, templates: {} }); f.beat(); f.advance(5000);
  const reply = f.machines.heartbeat(f.host, f.token, { offer: f.offer, reports: { [id]: { state: "running" } } });
  assert.equal((reply.machines as { desired: string }[])[0]!.desired, "running");
});

test("a real runner stops an idle device through its provider, holds it during local work and keeps its storage", async t => {
  const f = await upkeepHarness(t, { upkeep: { idleStopSeconds: 300, templates: { "ios-phone": { idleStopSeconds: 0 } } } });
  assert.deepEqual((f.lastBeat.upkeep as any).idleStop, { defaultSeconds: 300, templates: { "ios-phone": null } });
  assert.deepEqual((f.lastBeat.upkeep as any).platforms, ["android", "ios"]);
  const android = await f.createMachine("android-phone"), ios = await f.createMachine("ios-phone");
  const observed = async (id: string): Promise<string> => (await f.request("GET", `/v1/machines/${id}`)).body.observed;
  await f.pump(() => existsSync(join(f.storage.android, android.id, "endpoint.json")), "the emulator launch");
  // The stand-in adb now reports the launched device as booted.
  f.tools.update(tools => { tools.android.devices["emulator-5554"] = `cvm-${android.id}`; });
  await f.pump(async () => await observed(android.id) === "running" && await observed(ios.id) === "running", "both devices to run");
  const devices = (await f.request("GET", f.hostPath + "/upkeep")).body.idleStop.devices as any[];
  assert.deepEqual(devices.map(device => [device.templateId, device.idleStopSeconds, device.reason]).sort(), [["android-phone", 300, "active"], ["ios-phone", null, "policy_off"]]);

  // A local viewer or connector holds every running device: the host says so on its heartbeat.
  const release = f.runner().beginLocalWork();
  f.advance(300); await f.poll();
  assert.deepEqual((f.lastBeat.upkeep as any).busy.sort(), [android.id, ios.id].sort());
  assert.equal((await f.request("GET", `/v1/machines/${android.id}`)).body.desired, "running");
  // The local work ends. Its end starts the idle time over instead of stopping the device at once.
  release(); await f.poll();
  assert.deepEqual((f.lastBeat.upkeep as any).busy, []);
  assert.equal((await f.request("GET", `/v1/machines/${android.id}`)).body.desired, "running");
  // Work that begins and ends between two heartbeats is still reported on the next one.
  f.advance(200); f.runner().beginLocalWork()(); await f.poll();
  assert.deepEqual((f.lastBeat.upkeep as any).busy.sort(), [android.id, ios.id].sort());
  await f.poll();
  assert.deepEqual((f.lastBeat.upkeep as any).busy, []);
  f.advance(299); await f.poll();
  assert.equal((await f.request("GET", `/v1/machines/${android.id}`)).body.desired, "running");
  f.advance(1); await f.poll();
  assert.equal((await f.request("GET", `/v1/machines/${android.id}`)).body.desired, "stopped");
  assert.equal((await f.request("GET", `/v1/machines/${ios.id}`)).body.desired, "running");
  // The provider's ordinary stop: one acknowledged shutdown of the owned serial, then confirmed exit.
  await f.pump(async () => await observed(android.id) === "stopped", "the emulator stop");
  assert.equal(f.tools.calls("adb").filter(call => call.args.slice(2).join(" ") === "emu kill").length, 1);
  // The AVD, its registration and the device itself are all still there.
  for (const kept of [join(f.storage.android, android.id, "device.avd"), join(f.storage.android, "avds", `cvm-${android.id}.ini`), join(f.storage.android, android.id, "canaveral-owner.json")]) assert.ok(existsSync(kept), kept);
  assert.equal((await f.request("GET", "/v1/machines")).body.machines.length, 2);
  assert.ok(!f.tools.calls("xcrun").some(call => ["shutdown", "delete"].includes(call.args[1]!)));
  assert.equal((await f.request("GET", f.hostPath + "/upkeep")).body.idleStop.devices.find((device: any) => device.machineId === android.id).lastIdleStop.idleStopSeconds, 300);
});
