import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ControlRequest } from "../../src/control/contracts.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { PRESSURE_STALE_SECONDS } from "../../src/control/pressure.ts";
import { object, ServiceError } from "../../src/errors.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig, HostDependencies, HostTransport } from "../../src/host.ts";
import { DEFAULT_PRESSURE, PressureMonitor, parseDarwinPressureLevel, parseLinuxPsi, parseMeminfoAvailable, pressureConfig, validatePressureReport } from "../../src/pressure.ts";
import type { MemoryLevel, PressureSample } from "../../src/pressure.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";

/** Scripted host samples only: no test here reads this machine's memory or disk. */
const roomy = { freeGiB: 100, totalGiB: 500 };
const mac = (level: MemoryLevel, disk = roomy): PressureSample => ({ memory: { source: "darwin-pressure-level", level }, disk });
const linux = (psiSomeAvg10: number, availablePercent: number): PressureSample => ({ memory: { source: "linux-psi-meminfo", psiSomeAvg10, availablePercent }, disk: roomy });
/** A report as a host would send it, decided at once so a test controls the state directly. */
function report(sample: PressureSample, sampledAt: number) {
  return new PressureMonitor({ ...DEFAULT_PRESSURE, enterSeconds: 0, clearSeconds: 0 }).observe(sample, 0, sampledAt);
}

test("macOS memory pressure enters after its hold, ignores a spike and leaves only after the clear hold", () => {
  const monitor = new PressureMonitor(DEFAULT_PRESSURE), at = (elapsed: number, level: MemoryLevel) => monitor.observe(mac(level), elapsed, 1000 + elapsed);
  assert.equal(at(0, "normal").state, "normal");
  assert.equal(at(5, "warning").state, "normal");
  // One sample back to normal resets the hold: a spike never flips the state.
  assert.equal(at(10, "normal").state, "normal");
  assert.equal(at(15, "warning").state, "normal");
  assert.equal(at(20, "critical").state, "normal");
  const entered = at(25, "warning");
  assert.equal(entered.state, "pressured"); assert.deepEqual(entered.reasons, ["memory"]); assert.equal(entered.since, 1025);
  assert.equal(entered.memory?.level, "warning"); assert.equal(entered.disk?.state, "normal");
  assert.equal(at(30, "normal").state, "pressured");
  assert.equal(at(60, "normal").state, "pressured");
  // A relapse inside the clear hold starts it again.
  assert.equal(at(65, "warning").state, "pressured");
  assert.equal(at(70, "normal").state, "pressured");
  assert.equal(at(125, "normal").state, "pressured");
  const left = at(130, "normal");
  assert.equal(left.state, "normal"); assert.deepEqual(left.reasons, []); assert.equal(left.since, 1130);
});

test("Linux PSI and available memory, and free disk, hold between their enter and exit thresholds", () => {
  const monitor = new PressureMonitor(DEFAULT_PRESSURE);
  assert.equal(monitor.observe(linux(1, 40), 0, 0).state, "normal");
  assert.equal(monitor.observe(linux(12, 40), 5, 5).state, "normal");
  assert.equal(monitor.observe(linux(12, 40), 15, 15).state, "pressured");
  // Between the exit (5%) and enter (10%) thresholds the state holds, however long.
  for (const elapsed of [20, 200, 2000]) assert.equal(monitor.observe(linux(7, 40), elapsed, elapsed).state, "pressured");
  // Stalls have stopped, but available memory is still under its exit threshold.
  assert.equal(monitor.observe(linux(2, 8), 2100, 2100).state, "pressured");
  assert.equal(monitor.observe(linux(2, 8), 2400, 2400).state, "pressured");
  assert.equal(monitor.observe(linux(2, 30), 2405, 2405).state, "pressured");
  assert.equal(monitor.observe(linux(2, 30), 2465, 2465).state, "normal");
  // Low available memory alone enters, without any stall.
  assert.equal(monitor.observe(linux(0, 4), 2470, 2470).state, "normal");
  assert.equal(monitor.observe(linux(0, 4), 2480, 2480).memory?.state, "pressured");

  const disk = new PressureMonitor(DEFAULT_PRESSURE), free = (elapsed: number, freeGiB: number) => disk.observe(mac("normal", { freeGiB, totalGiB: 500 }), elapsed, elapsed);
  assert.equal(free(0, 50).state, "normal");
  assert.equal(free(5, 4).state, "normal");
  const full = free(15, 4);
  assert.equal(full.state, "pressured"); assert.deepEqual(full.reasons, ["disk"]); assert.equal(full.memory?.state, "normal");
  assert.equal(free(100, 7).state, "pressured");
  assert.equal(free(105, 12).state, "pressured");
  assert.equal(free(165, 12).state, "normal");
});

test("an unreadable signal is unknown at once and cannot shorten a pressured host's hold", () => {
  const monitor = new PressureMonitor(DEFAULT_PRESSURE);
  // A host that starts under pressure has no normal state to hold; its first sample decides.
  assert.equal(monitor.observe(mac("critical"), 0, 0).state, "pressured");
  const unreadable = monitor.observe({ memory: null, disk: roomy }, 5, 5);
  assert.equal(unreadable.state, "unknown"); assert.equal(unreadable.memory?.state, "unknown"); assert.deepEqual(unreadable.reasons, []);
  assert.equal(monitor.observe({ memory: null, disk: null }, 10, 10).disk?.state, "unknown");
  // Readable again: still pressured, and the whole clear hold is owed from here.
  assert.equal(monitor.observe(mac("normal"), 15, 15).state, "pressured");
  assert.equal(monitor.observe(mac("normal"), 70, 70).state, "pressured");
  assert.equal(monitor.observe(mac("normal"), 75, 75).state, "normal");
  // A platform without a memory signal still reports disk.
  const windows = new PressureMonitor(DEFAULT_PRESSURE).observe({ memory: "unsupported", disk: roomy }, 0, 0);
  assert.equal(windows.state, "normal"); assert.equal(windows.memory?.state, "unsupported");
});

test("thresholds are validated and platform signals are parsed strictly", () => {
  assert.deepEqual(pressureConfig(undefined), { enabled: true, thresholds: DEFAULT_PRESSURE });
  assert.equal(pressureConfig({ enabled: false }).enabled, false);
  assert.equal(pressureConfig({ memory: { darwinEnterLevel: "critical" }, clearSeconds: 300 }).thresholds.memory.darwinEnterLevel, "critical");
  // Exit thresholds must be more relaxed than their enter thresholds, or the state would flap.
  for (const invalid of [{ disk: { enterFreeGiB: 10, exitFreeGiB: 10 } }, { memory: { psiEnterPercent: 5, psiExitPercent: 5 } }, { memory: { availableEnterPercent: 10, availableExitPercent: 5 } },
    { memory: { darwinEnterLevel: "normal" } }, { enterSeconds: -1 }, { unknown: true }]) assert.throws(() => pressureConfig(invalid), failure(400));
  assert.equal(parseDarwinPressureLevel("1\n"), "normal"); assert.equal(parseDarwinPressureLevel("2"), "warning"); assert.equal(parseDarwinPressureLevel("4"), "critical");
  assert.throws(() => parseDarwinPressureLevel("3")); assert.throws(() => parseDarwinPressureLevel(""));
  assert.equal(parseLinuxPsi("some avg10=12.50 avg60=3.10 avg300=0.80 total=123456\nfull avg10=1.00 avg60=0.20 avg300=0.05 total=2345\n"), 12.5);
  assert.throws(() => parseLinuxPsi("full avg10=1.00 avg60=0.20 avg300=0.05 total=2345\n"));
  assert.equal(parseMeminfoAvailable("MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    4000000 kB\n"), 25);
  assert.throws(() => parseMeminfoAvailable("MemTotal:       16000000 kB\n"));

  const sent = report(mac("warning"), 50);
  assert.deepEqual(validatePressureReport(JSON.parse(JSON.stringify(sent))), sent);
  assert.deepEqual(validatePressureReport({ version: 1, state: "disabled", sampledAt: 5 }), { version: 1, state: "disabled", sampledAt: 5 });
  // The overall state is derived from the dimensions: a report cannot claim normal beside a pressured one.
  assert.throws(() => validatePressureReport({ ...sent, state: "normal", reasons: [] }), failure(400));
  assert.throws(() => validatePressureReport({ ...sent, reasons: ["disk"] }), failure(400));
  assert.throws(() => validatePressureReport({ ...sent, version: 2 }), failure(400));
  assert.throws(() => validatePressureReport({ ...sent, extra: true }), failure(400));
});

const key = () => randomBytes(32).toString("base64url");
function placement(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-pressure-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  let now = 1000;
  const store = new SqliteStore(join(dir, "controller.sqlite"), () => now);
  const options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  const machines = new MachineStore(store, options);
  const image = { id: "phone", revision: "1", arch: "arm64", os: "android", mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } };
  const request = (method: string, path: string, body: Record<string, unknown> = {}): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: options.adminToken,
    principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) });
  function host(name: string, devices: number) {
    const id = randomUUID(), token = key(), offer = { name, provider: "android", capacity: { cpu: 2 * devices, memoryMiB: 2048 * devices, diskGiB: 8 * devices }, templates: [image] };
    machines.enroll({ id, credential: token, offer }, options.enrollmentToken);
    return { id, beat: (extra: Record<string, unknown> = {}) => machines.heartbeat(id, token, { offer, ...extra }),
      view: () => machines.hosts(request("GET", "/v1/hosts")).find(entry => entry.id === id)! };
  }
  const create = () => machines.create({ id: randomUUID(), name: "phone", templateId: image.id }, request("POST", "/v1/machines"));
  const desired = (id: string, state: string) => machines.desired(id, state, request("POST", `/v1/machines/${id}/desired`));
  return { machines, host, create, desired, request, now: () => now, advance(seconds: number) { now += seconds; } };
}

test("placement skips a pressured host, waits when every host is pressured and never stops running work", t => {
  const f = placement(t), large = f.host("large", 8), small = f.host("small", 1);
  large.beat({ pressure: report(mac("normal"), f.now()) }); small.beat({ pressure: report(mac("normal"), f.now()) });
  // The larger host ranks first by reservation share.
  const first = f.create();
  assert.equal(first.hostId, large.id);
  large.beat({ reports: { [first.id]: { state: "running" } }, pressure: report(mac("warning"), f.now() + 1) });
  assert.equal(large.view().placementReady, false);
  assert.deepEqual({ state: large.view().pressure.state, blocked: large.view().pressure.placementBlocked, reasons: large.view().pressure.reasons }, { state: "pressured", blocked: true, reasons: ["memory"] });
  assert.equal(large.view().pressure.memory.level, "warning");
  assert.equal(small.view().placementReady, true);
  assert.equal(f.create().hostId, small.id);
  // The small host is full and the large one pressured: the refusal names the pressure, not capacity.
  assert.throws(() => f.create(), failure(409, "host_pressure"));
  // The device already running on the pressured host keeps its desired state and its reservation.
  const delivered = large.beat({ reports: { [first.id]: { state: "running" } }, pressure: report(mac("critical"), f.now() + 2) }).machines as { id: string; desired: string }[];
  assert.deepEqual(delivered.map(machine => [machine.id, machine.desired]), [[first.id, "running"]]);
  assert.equal(large.view().reserved.cpu, 2);
  // Pressure also refuses a restart there; a stop is always allowed.
  assert.equal(f.desired(first.id, "stopped").desired, "stopped");
  large.beat({ reports: { [first.id]: { state: "stopped" } }, pressure: report(mac("critical"), f.now() + 3) });
  assert.throws(() => f.desired(first.id, "running"), failure(409, "host_pressure"));
  large.beat({ pressure: report(mac("normal"), f.now() + 4) });
  assert.equal(f.desired(first.id, "running").desired, "running");
  assert.equal(f.create().hostId, large.id);
});

test("a stale or unreadable sample blocks placement; an unreported or disabled one does not", t => {
  const f = placement(t), host = f.host("only", 8);
  // An older runner never reports pressure and stays placeable.
  host.beat();
  assert.deepEqual(host.view().pressure, { state: "unreported", placementBlocked: false, reasons: [] });
  assert.equal(f.create().hostId, host.id);
  const sample = report(mac("normal"), f.now());
  host.beat({ pressure: sample });
  // Sending the same sample again does not refresh its age.
  f.advance(PRESSURE_STALE_SECONDS - 1); host.beat({ pressure: sample });
  assert.equal(host.view().pressure.state, "normal");
  assert.equal(f.create().hostId, host.id);
  f.advance(1); host.beat({ pressure: sample });
  assert.deepEqual({ state: host.view().pressure.state, blocked: host.view().pressure.placementBlocked, fresh: host.view().pressure.fresh, ready: host.view().placementReady },
    { state: "stale", blocked: true, fresh: false, ready: false });
  assert.throws(() => f.create(), failure(409, "host_pressure_unknown"));
  // A new sample restores placement.
  host.beat({ pressure: report(mac("normal"), f.now()) });
  assert.equal(f.create().hostId, host.id);
  // A host that cannot read its signal says so, and that blocks too.
  host.beat({ pressure: report({ memory: null, disk: roomy }, f.now() + 1) });
  assert.equal(host.view().pressure.state, "unknown");
  assert.throws(() => f.create(), failure(409, "host_pressure_unknown"));
  host.beat({ pressure: { version: 1, state: "disabled", sampledAt: f.now() + 2 } });
  f.advance(10 * PRESSURE_STALE_SECONDS); host.beat();
  assert.deepEqual({ state: host.view().pressure.state, blocked: host.view().pressure.placementBlocked }, { state: "disabled", blocked: false });
  assert.equal(f.create().hostId, host.id);
  // A contradictory report is refused with the heartbeat that carried it.
  assert.throws(() => host.beat({ pressure: { ...report(mac("warning"), f.now() + 3), state: "normal", reasons: [] } }), failure(400));
});

test("a waiting lease request names the pressure as its reason and is admitted when it clears", async t => {
  const f = leaseFixture(t, "android", "device");
  f.beat({ pressure: report(mac("normal"), f.now()) });
  const held = await f.request("POST", "/v1/leases", f.acquire());
  f.beat({ pressure: report(mac("warning"), f.now() + 1) });
  // Direct acquisition is refused as retryable, with the same code.
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire()), (error: unknown) => error instanceof ServiceError && error.status === 503 && error.code === "host_pressure" && error.retryable);
  const { id, ...intent } = f.acquire();
  const waiting = await f.request("POST", "/v1/requests", { id, kind: "lease", intent });
  assert.deepEqual({ state: waiting.state, reason: waiting.reason, target: waiting.target }, { state: "waiting", reason: "host_pressure", target: null });
  assert.equal((await f.request("GET", "/v1/environments/templates")).templates[0].available, false);
  // The lease acquired before the pressure is untouched.
  assert.equal((await f.request("GET", `/v1/leases/${held.id}`)).state, "provisioning");
  // A host whose samples stop is as unusable as a pressured one, and says which it is.
  f.advance(PRESSURE_STALE_SECONDS); f.beat(); f.leases.requests.pass();
  assert.equal((await f.request("GET", `/v1/requests/${id}`)).reason, "host_pressure_unknown");
  f.beat({ pressure: report(mac("normal"), f.now()) }); f.leases.requests.pass();
  const admitted = await f.request("GET", `/v1/requests/${id}`);
  assert.deepEqual({ state: admitted.state, reason: admitted.reason, target: admitted.target }, { state: "admitted", reason: null, target: id });
});

test("a runner turns scripted samples into a held state; the controller withholds placement and leaves running work alone", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-pressure-runner-")));
  const runners: HostRunner[] = [];
  t.after(async () => { await Promise.all(runners.map(runner => runner.close().catch(() => {}))); rmSync(root, { force: true, recursive: true }); });
  let now = 1_700_000_000, next: PressureSample | Error = mac("normal"), lastBeat: Record<string, unknown> = {};
  const clock = { now: () => now, wall: () => now, suspendAware: true };
  const options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  const machines = new MachineStore(new SqliteStore(join(root, "controller.sqlite"), clock.wall), options);
  const request = (method: string, path: string, body: Record<string, unknown> = {}): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: options.adminToken, principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) });
  const transport: HostTransport = { async request(method, path, body, token) {
    if (path.endsWith("/heartbeat")) lastBeat = structuredClone(body);
    const reply = await machines.handle({ ...request(method, path, JSON.parse(JSON.stringify(body)) as Record<string, unknown>), token, principal: () => { throw new ServiceError("Host credentials are not accounts.", 401); } });
    return object(JSON.parse(JSON.stringify(reply!.body)));
  } };
  const image = { id: "phone", revision: "1", arch: "arm64", os: "android", mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } };
  const config: HostConfig = { name: "pressure-host", provider: "android", storage: join(root, "devices"), stateDir: join(root, "state"), capacity: { cpu: 16, memoryMiB: 16384, diskGiB: 64 }, templates: [image],
    url: "http://127.0.0.1:1", enrollmentToken: options.enrollmentToken, pollIntervalSeconds: 0.25, pressure: { clearSeconds: 30 } };
  const dependencies: HostDependencies = { clock, transport, pressureSample: () => { if (next instanceof Error) throw next; return next; },
    providerFactory: settings => ({ kind: "android", config: settings, check: async () => ({}), reconcile: async machine => ({ state: machine.desired === "stopped" ? "stopped" : "running" }) }) };
  const runner = new HostRunner(config, dependencies); runners.push(runner);
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment();
  // One five-second sample and the heartbeat that carries it.
  const tick = async (sample: PressureSample | Error): Promise<string | undefined> => { next = sample; now += 5; await runner.samplePressure(); await runner.checkEnvironment(); await runner.poll(); return runner.pressureReport?.state; };
  const view = () => machines.hosts(request("GET", "/v1/hosts"))[0]!;
  const create = () => machines.create({ id: randomUUID(), name: "phone", templateId: "phone" }, request("POST", "/v1/machines"));
  assert.equal(await tick(mac("normal")), "normal");
  assert.deepEqual([(lastBeat.pressure as any).state, (lastBeat.pressure as any).thresholds.clearSeconds, view().pressure.state, view().placementReady], ["normal", 30, "normal", true]);
  const running = create();
  await runner.poll();
  // A warning that lasts one sample changes nothing.
  assert.equal(await tick(mac("warning")), "normal"); assert.equal(await tick(mac("normal")), "normal");
  assert.equal(await tick(mac("warning")), "normal"); assert.equal(await tick(mac("warning")), "normal");
  assert.equal(await tick(mac("warning")), "pressured");
  assert.deepEqual([view().pressure.state, view().pressure.reasons, view().placementReady], ["pressured", ["memory"], false]);
  assert.throws(() => create(), failure(409, "host_pressure"));
  // The device assigned before the pressure is still assigned, and still wanted running.
  assert.deepEqual(runner.assignments.map(machine => [machine.id, machine.desired]), [[running.id, "running"]]);
  // A sample this host cannot take is unknown, and unknown blocks placement too.
  assert.equal(await tick(new Error("signal unavailable")), "unknown");
  assert.throws(() => create(), failure(409, "host_pressure_unknown"));
  // Readable and normal again, the host still serves its whole clear hold.
  for (let sample = 0; sample < 6; sample++) assert.equal(await tick(mac("normal")), "pressured", `sample ${sample}`);
  assert.throws(() => create(), failure(409, "host_pressure"));
  assert.equal(await tick(mac("normal")), "normal");
  assert.equal(create().hostId, runner.identity!.id);
  // Heartbeats that carry no new sample let the last one go stale.
  for (let beat = 0; beat < 12; beat++) { now += 5; await runner.checkEnvironment(); await runner.poll(); }
  assert.deepEqual([view().pressure.state, view().pressure.reported, view().online], ["stale", "normal", true]);
  assert.throws(() => create(), failure(409, "host_pressure_unknown"));
  assert.equal(await tick(mac("normal")), "normal");
  assert.equal(create().hostId, runner.identity!.id);

  // An operator can switch the report off; a KubeVirt pool runner never reports its own pod as the pool.
  const disabled = new HostRunner({ ...config, stateDir: join(root, "disabled-state"), pressure: { enabled: false } }, dependencies); runners.push(disabled);
  await disabled.samplePressure();
  assert.deepEqual(disabled.pressureReport, { version: 1, state: "disabled", sampledAt: now });
  const pool = new HostRunner({ ...config, provider: "kubevirt", templates: [], stateDir: join(root, "pool-state") }, dependencies); runners.push(pool);
  await pool.samplePressure();
  assert.equal(pool.pressureReport, undefined);
  assert.throws(() => new HostRunner({ ...config, stateDir: join(root, "invalid-state"), pressure: { disk: { enterFreeGiB: 20, exitFreeGiB: 10 } } }, dependencies), failure(400));
});
