import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ControlRequest, ControlResponse, Principal } from "../../src/control/contracts.ts";
import { createModule as devicesModule } from "../../src/control/devices.ts";
import { createModule as lifecycleModule } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { InfrastructureStore } from "../../src/control/infrastructure.ts";
import { LegacyLeases } from "../../src/control/leases.ts";
import { ModelJobs } from "../../src/model-jobs.ts";
import { initializeUpdates } from "../../src/control/updates.ts";
import { PhysicalDomains } from "../../src/physical-domains.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import type { ControlReply } from "../../src/control/client.ts";
import { ControlClient } from "../../src/control/client.ts";
import { main } from "../../src/cli.ts";
import { startController } from "../../src/main.ts";
import { createLocalConnectors } from "../../src/local.ts";
import type { LocalAttachedHost } from "../../src/local.ts";
import { initializeInference } from "../../src/control/inference.ts";
import { ImagesController } from "../../src/control/images.ts";
import { leaseFixture, failure, key } from "./leases-fixture.test.ts";

type Json = Record<string, any>;
const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
function request(method: string, path: string, body: Json = {}, principal = operator): ControlRequest {
  return { method, path, body, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), token: "", principal: () => principal };
}
function fixture(t: TestContext, system = "linux", provider: string | undefined = undefined) {
  const f = leaseFixture(t, system, system === "android" ? "device" : "headless");
  if (provider !== undefined) {
    // A provider is immutable once enrolled, so use a separate enrolled fixture host.
    f.changeOffer({ provider, leaseProtocol: undefined, leaseImages: undefined });
  }
  const host = provider === undefined ? f.host : randomUUID();
  if (provider !== undefined) f.leases.machines.enroll({ id: host, credential: f.hostToken, offer: f.offer() }, f.options.enrollmentToken);
  const path = `/v1/hosts/${host}/maintenance`;
  let machines = f.leases.machines, store = f.store;
  function send(method: string, url: string, body: Json = {}) {
    const reply: ControlResponse | undefined = machines.handle(request(method, url, body));
    assert.ok(reply); return { status: reply.status ?? 200, body: reply.body as Json };
  }
  const beat = (reports: Json = {}, maintenance: Json | undefined = { version: 1 }, extra: Json = {}) =>
    machines.heartbeat(host, f.hostToken, { offer: f.offer(), reports, ...(maintenance ? { maintenance } : {}), ...extra });
  const begin = (id = randomUUID(), reason?: string) => send("POST", path, { id, ...(reason === undefined ? {} : { reason }) });
  const state = () => send("GET", path).body;
  const resume = (id: string, requestId = randomUUID()) => send("POST", `${path}/${id}/resume`, { requestId });
  const create = (extra: Json = {}) => send("POST", "/v1/machines", { id: randomUUID(), name: "fixture", templateId: f.image.id, hostId: host, ...extra }).body;
  const desired = (id: string, state: string) => send("POST", `/v1/machines/${id}/desired`, { state }).body;
  return { ...f, host, path, beat, begin, resume, state, send, create, desired,
    devices: () => devicesModule(store, f.options),
    lifecycle: () => lifecycleModule(store, f.options),
    restart() { store = new SqliteStore(store.path, f.now); machines = new MachineStore(store, f.options); },
  };
}
function proof(challenge: Json, assignments: Json[] = [], extra: Json = {}): Json {
  return { version: 1, proof: { drainId: challenge.drainId, challenge: challenge.challenge, idle: true, workloadsStopped: true,
    inventory: { complete: true, assignments, unexpected: [] }, issues: [], ...extra } };
}
const inventory = (id: string, storage = "present", stopProof = "native") => ({ id, storage, stopProof });
const blocked = (status: Json, kind: string, id: string) => status.blockers.some((b: Json) => b.kind === kind && b.id === id);

test("drain commit orders fence create, restart, device and lease admission without withholding precommitted work", async t => {
  const f = fixture(t, "android"), devices = f.devices();
  const existing = f.create(), restart = f.create(), parked = f.create();
  f.desired(restart.id, "stopped"); f.desired(parked.id, "stopped");
  f.beat({ [existing.id]: { state: "running" }, [restart.id]: { state: "stopped" }, [parked.id]: { state: "stopped" } });
  const op = (id = randomUUID()) => ({ id, action: "apps", arguments: {} });
  const submit = (body: Json) => devices.handle(request("POST", `/v1/machines/${existing.id}/operations`, body));
  const preCreateId = randomUUID(), preOp = op(), preLease = f.acquire();
  f.create({ id: preCreateId }); f.desired(restart.id, "running"); await submit(preOp);
  const lease = await f.request("POST", "/v1/leases", preLease);
  const { body: draining } = f.begin();
  assert.ok(draining.admissionClosed);
  assert.throws(() => f.create(), failure(409, "host_draining"));
  assert.throws(() => f.desired(parked.id, "running"), failure(409, "host_draining"));
  assert.throws(() => submit(op()), failure(409, "host_draining"));
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire()), failure(503, "capacity_unavailable"));
  const { id, ...intent } = f.acquire();
  const waiting = await f.request("POST", "/v1/requests", { id, kind: "lease", intent });
  assert.equal(waiting.state, "waiting");
  f.leases.requests.pass();
  assert.equal((await f.request("GET", `/v1/requests/${id}`)).state, "waiting");
  assert.equal(f.create({ id: preCreateId }).hostId, f.host);
  assert.equal(((await submit(preOp))!.body as Json).id, preOp.id);
  assert.equal((await f.request("POST", "/v1/leases", preLease)).id, lease.id);

  const delivered = f.beat({ [existing.id]: { state: "running" }, [restart.id]: { state: "starting" }, [parked.id]: { state: "stopped" } });
  assert.ok(delivered.machines.some((m: Json) => m.id === preCreateId && m.desired === "running"));
  assert.ok(delivered.machines.some((m: Json) => m.id === restart.id && m.desired === "running"));
  assert.ok(delivered.machines.some((m: Json) => m.id === lease.members[0].machineId && m.lease.id === lease.id));
  assert.equal(delivered.deviceOperations[0].id, preOp.id);
  const state = f.state();
  assert.ok(blocked(state, "assignment", preCreateId) && blocked(state, "assignment", restart.id));
  assert.ok(blocked(state, "operation", preOp.id) && blocked(state, "lease", lease.id));

  const other = randomUUID();
  f.leases.machines.enroll({ id: other, credential: key(), offer: f.offer() }, f.options.enrollmentToken);
  assert.equal(f.create({ hostId: undefined }).hostId, other);
  f.leases.requests.pass();
  assert.equal((await f.request("GET", `/v1/requests/${id}`)).state, "admitted");
});

test("independent SQLite writers serialize competing drain and machine commits", async t => {
  const f = fixture(t), worker = new Worker(new URL("../../src/control/worker.js", import.meta.url), {
    workerData: { ...f.options, path: f.store.path },
  });
  t.after(async () => { await worker.terminate(); });
  assert.equal((await once(worker, "message"))[0].kind, "ready");
  let sequence = 0;
  function post(path: string, body: Json): Promise<ControlReply> {
    const id = ++sequence;
    return new Promise(resolve => {
      function replied(reply: ControlReply) {
        if (reply.kind === "ready" || reply.kind === "accepted" || reply.id !== id) return;
        worker.off("message", replied); resolve(reply);
      }
      worker.on("message", replied);
      worker.postMessage({ id, command: { type: "http", method: "POST", path, body, query: "", token: f.options.adminToken } });
    });
  }
  // Send the competing mutation while the first writer still owns BEGIN IMMEDIATE.
  const before = randomUUID(), firstDrain = randomUUID();
  const drainReply = f.store.transaction(() => {
    f.create({ id: before });
    return { receipt: post(f.path, { id: firstDrain }) };
  }).receipt;
  assert.equal((await drainReply).kind, "result");
  assert.equal(f.beat({ [before]: { state: "running" } }).machines[0].id, before);
  assert.ok(blocked(f.state(), "assignment", before));

  const other = randomUUID();
  f.leases.machines.enroll({ id: other, credential: key(), offer: f.offer() }, f.options.enrollmentToken);
  const createReply = f.store.transaction(() => {
    f.send("POST", `/v1/hosts/${other}/maintenance`, { id: randomUUID() });
    return { receipt: post("/v1/machines", { id: randomUUID(), name: "late", templateId: f.image.id, hostId: other }) };
  }).receipt;
  const refused = await createReply;
  assert.equal(refused.kind, "error");
  assert.equal(refused.kind === "error" && refused.error.code, "host_draining");
});

test("challenges rotate, expire and cannot be replayed across drains or controller runs", t => {
  const f = fixture(t);
  assert.deepEqual(f.beat().maintenance, { version: 1, phase: "open", drainId: null });
  const id = f.begin().body.id, first = f.beat().maintenance;
  assert.match(first.challenge, /^[a-f0-9]{64}$/);
  const next = f.beat({}, proof(first)).maintenance;
  assert.notEqual(next.challenge, first.challenge);
  const ackAt = f.state().lastRunnerConfirmedAt;
  assert.equal(f.state().safeToPowerOff, true);
  f.advance(19);
  assert.equal(f.state().safeToPowerOff, true);
  f.advance(2);
  f.beat({}, proof(first));
  assert.equal(f.state().lastRunnerConfirmedAt, ackAt);
  assert.equal(f.state().safeToPowerOff, false);
  assert.equal(f.resume(id).status, 409);
  const previousRun = f.beat().maintenance;
  f.restart();
  const fresh = f.beat({}, proof(previousRun)).maintenance;
  assert.equal(f.state().blockers[0].state, "previousRun");
  assert.equal(f.state().safeToPowerOff, false);
  f.beat({}, proof(fresh));
  assert.equal(f.state().safeToPowerOff, true);
  assert.equal(f.resume(id).body.phase, "resumed");
  assert.deepEqual(f.beat().maintenance, { version: 1, phase: "resumed", drainId: id });
  f.begin();
  f.beat({}, proof(fresh));
  assert.equal(f.state().lastRunnerConfirmedAt, null);
});

test("maintenance rejects delayed proofs and ages accepted proofs from challenge issuance", t => {
  const f = fixture(t), m = f.create(), id = f.begin().body.id;
  f.desired(m.id, "stopped");
  const reports = { [m.id]: { state: "stopped" } }, items = [inventory(m.id)];
  const expired = f.beat(reports).maintenance;
  f.advance(60);
  let challenge = f.beat(reports, proof(expired, items)).maintenance;
  assert.equal(f.state().lastRunnerConfirmedAt, null);
  assert.equal(f.resume(id).status, 409);
  f.advance(20);
  challenge = f.beat(reports, proof(challenge, items)).maintenance;
  assert.equal(f.state().lastRunnerConfirmedAt, null);
  const issued = f.now();
  f.advance(19);
  f.beat(reports, proof(challenge, items));
  assert.equal(f.state().lastRunnerConfirmedAt, issued);
  assert.equal(f.state().safeToPowerOff, true);
  f.advance(1);
  assert.equal(f.state().blockers[0].state, "stale");
  assert.equal(f.state().readyToResume, false);
  f.advance(19);
  assert.ok(blocked(f.state(), "unknownState", m.id));
});

test("maintenance bounds the raw proof drain UUID before normalization", t => {
  const f = fixture(t);
  f.begin();
  const challenge = f.beat().maintenance;
  assert.throws(() => f.beat({}, proof(challenge, [], { drainId: "-".repeat(200) + challenge.drainId })), failure(400));
  f.beat({}, proof(challenge));
  assert.equal(f.state().safeToPowerOff, true);
});

test("maintenance status and resume refresh legacy leases inside nested transactions", async t => {
  for (const route of ["status", "resume"]) await t.test(route, async t => {
    const f = fixture(t), lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 10 }));
    const reports = { [lease.members[0].machineId]: { state: "running" } };
    const id = f.begin().body.id;
    f.beat(reports, proof(f.beat(reports).maintenance, [inventory(lease.members[0].machineId)]));
    assert.equal(f.state().readyToResume, true);
    f.store.transaction(() => {
      f.advance(10);
      const reply = route === "status" ? { status: 200, body: f.state() } : f.resume(id);
      assert.equal(reply.status, route === "status" ? 200 : 409);
      const status = route === "status" ? reply.body : reply.body.status;
      assert.equal(status.readyToResume, false);
      assert.equal(status.blockers.find((b: Json) => b.kind === "lease" && b.id === lease.id)?.state, "expired");
    });
  });
});

test("restart retains the admission fence and work while requiring a fresh receipt", t => {
  const f = fixture(t), m = f.create(), id = f.begin().body.id;
  const reports = { [m.id]: { state: "running" } }, first = f.beat(reports).maintenance;
  f.beat(reports, proof(first, [inventory(m.id)], { idle: false, workloadsStopped: false }));
  assert.equal(f.state().readyToResume, true);
  f.restart();
  assert.throws(() => f.create(), failure(409, "host_draining"));
  assert.ok(blocked(f.state(), "assignment", m.id));
  assert.ok(blocked(f.state(), "acknowledgement", id));
  assert.equal(f.state().readyToResume, false);
  const fresh = f.beat(reports).maintenance;
  f.beat(reports, proof(fresh, [inventory(m.id)], { idle: false, workloadsStopped: false }));
  assert.equal(f.state().readyToResume, true);
  assert.equal(f.state().safeToPowerOff, false);
});

test("receipt application changes the ledger before evaluating proof", async t => {
  const f = fixture(t, "android"), m = f.create(), devices = f.devices();
  const reports = { [m.id]: { state: "running" } }, op = { id: randomUUID(), action: "apps", arguments: {} };
  f.beat(reports);
  await devices.handle(request("POST", `/v1/machines/${m.id}/operations`, op));
  f.begin();
  const challenge = f.beat(reports).maintenance;
  const next = f.beat(reports, proof(challenge, [inventory(m.id)]), { deviceReports: { [op.id]: { state: "succeeded", result: {} } } }).maintenance;
  assert.equal(f.state().lastRunnerConfirmedAt, null);
  assert.equal(blocked(f.state(), "operation", op.id), false);
  f.beat(reports, proof(next, [inventory(m.id)]));
  assert.equal(f.state().readyToResume, true);
  f.desired(m.id, "stopped");
  assert.equal(f.state().blockers[0].state, "ledgerChanged");
});

test("cycling assignment and deletion reports cannot restore a maintenance verdict", async t => {
  const f = fixture(t, "linux", "apple"), m = f.create(), deletion = randomUUID();
  f.desired(m.id, "stopped");
  f.beat({ [m.id]: { state: "stopped" } });
  await f.lifecycle().handle(request("POST", `/v1/machines/${m.id}/delete`, { id: deletion }));
  f.begin();
  const reports = (state: string, receipt: string) => ({ [m.id]: { state, deletion: { id: deletion, state: receipt } } });
  const stopped = reports("stopped", "running");
  f.beat(stopped, proof(f.beat(stopped).maintenance, [inventory(m.id)]));
  assert.equal(f.state().readyToResume, true);
  f.beat(reports("unknown", "blocked"));
  assert.equal(f.state().readyToResume, false);
  const next = f.beat(stopped).maintenance;
  assert.equal(f.state().readyToResume, false);
  f.beat(stopped, proof(next, [inventory(m.id)]));
  assert.equal(f.state().readyToResume, true);
});

test("a power-off completed in one heartbeat invalidates earlier maintenance proof", async t => {
  const f = fixture(t, "linux", "apple"), m = f.create(), powerOffId = randomUUID();
  f.desired(m.id, "stopped");
  f.begin();
  const reports = { [m.id]: { state: "stopped" } };
  const before = f.beat(reports, proof(f.beat(reports).maintenance, [inventory(m.id)])).maintenance;
  assert.equal(f.state().safeToPowerOff, true);
  await f.lifecycle().handle(request("POST", `/v1/machines/${m.id}/power-off`, { id: powerOffId }));
  const next = f.beat({ [m.id]: { state: "stopped", powerOffId } }, proof(before, [inventory(m.id)])).maintenance;
  assert.equal(f.state().safeToPowerOff, false);
  f.beat(reports, proof(next, [inventory(m.id)]));
  assert.equal(f.state().safeToPowerOff, true);
});

test("lost contact during start and stop preserves named blockers and reservations until positive reports", async t => {
  for (const observed of ["starting", "stopping"]) await t.test(observed, async t => {
    const f = fixture(t, "linux", "apple"), m = f.create(), lifecycle = f.lifecycle();
    const op = randomUUID();
    f.beat({ [m.id]: { state: observed === "starting" ? "starting" : "running" } });
    if (observed === "stopping") {
      await lifecycle.handle(request("POST", `/v1/machines/${m.id}/power-off`, { id: op }));
      f.beat({ [m.id]: { state: "stopping" } });
    }
    const id = f.begin().body.id, reserved = f.send("GET", "/v1/hosts").body.hosts.find((h: Json) => h.id === f.host).reserved;
    assert.equal(reserved.cpu, m.resources.cpu);
    f.advance(31); f.restart();
    assert.deepEqual(f.send("GET", "/v1/hosts").body.hosts.find((h: Json) => h.id === f.host).reserved, reserved);
    assert.ok(blocked(f.state(), "unknownState", m.id));
    if (observed === "stopping") assert.ok(blocked(f.state(), "operation", op));
    const incomplete = f.beat().maintenance;
    f.beat({}, proof(incomplete, [inventory(m.id)]));
    assert.equal(f.resume(id).body.code, "maintenance_blocked");
    const reports = { [m.id]: { state: observed === "starting" ? "running" : "stopped", ...(observed === "stopping" ? { powerOffId: op } : {}) } };
    const current = f.beat(reports).maintenance;
    f.beat(reports, proof(current, [inventory(m.id)], { idle: observed === "stopping", workloadsStopped: observed === "stopping" }));
    assert.equal(blocked(f.state(), "unknownState", m.id), false);
    assert.equal(f.state().readyToResume, true);
    assert.equal(f.state().safeToPowerOff, observed === "stopping");
    assert.equal(f.send("GET", "/v1/hosts").body.hosts.find((h: Json) => h.id === f.host).reserved.cpu, observed === "stopping" ? 0 : reserved.cpu);
  });
});

test("admin routes enforce idempotency, operator authority and complete inventory", t => {
  const f = fixture(t), m = f.create(), reports = { [m.id]: { state: "stopped" } };
  f.desired(m.id, "stopped");
  assert.equal(f.state(), null);
  const id = randomUUID();
  assert.equal(f.begin(id, "scheduled").status, 201);
  assert.equal(f.begin(id, "scheduled").status, 200);
  assert.throws(() => f.begin(id, "changed"), failure(409));
  assert.throws(() => f.begin(), failure(409));
  assert.throws(() => f.send("GET", `/v1/hosts/${randomUUID()}/maintenance`), failure(404));
  const user: Principal = { kind: "token", user: { id: randomUUID(), username: "fixture", status: "active", role: "user" }, scopes: ["machines:write"] };
  assert.throws(() => f.leases.machines.handle(request("GET", f.path, {}, user)), failure(403));
  let challenge = f.beat(reports).maintenance;
  assert.throws(() => f.beat(reports, { version: 1, proof: { inventory: {} } }), failure(400));
  challenge = f.beat(reports, proof(challenge, [inventory(m.id, "absent")])).maintenance;
  assert.equal(f.resume(id).status, 409);
  assert.ok(blocked(f.state(), "missingResource", m.id));
  challenge = f.beat(reports, proof(challenge, [], { inventory: { complete: false, assignments: [], unexpected: ["extra"] } })).maintenance;
  assert.ok(blocked(f.state(), "incompleteInventory", m.id));
  assert.ok(blocked(f.state(), "unexpectedResource", "extra"));
  f.beat(reports, proof(challenge, [inventory(m.id)]));
  assert.deepEqual(f.send("GET", "/v1/hosts").body.hosts[0].maintenance, { id, phase: "draining", safeToPowerOff: true, readyToResume: true });
  const requestId = randomUUID(), receipt = f.resume(id, requestId);
  assert.equal(receipt.body.phase, "resumed");
  assert.deepEqual(f.resume(id, requestId), receipt);
  assert.throws(() => f.resume(id), failure(409));
  assert.equal(f.begin(id, "scheduled").body.phase, "resumed");
  assert.equal(f.create().hostId, f.host);
});

test("legacy agent reports unsupported and legacy accepting cannot bypass a manual drain", t => {
  const f = fixture(t), id = f.begin().body.id;
  assert.equal(f.leases.machines.heartbeat(f.host, f.hostToken, { offer: f.offer() }).maintenance.drainId, id);
  assert.ok(blocked(f.state(), "agentUnsupported", f.host));
  f.send("POST", `/v1/hosts/${f.host}/accepting`, { enabled: false });
  assert.deepEqual(f.state().owners, ["manual", "legacy"]);
  f.send("POST", `/v1/hosts/${f.host}/accepting`, { enabled: true });
  assert.deepEqual(f.state().owners, ["manual"]);
  assert.throws(() => f.create(), failure(409, "host_draining"));
});

test("update and manual fences clear independently", t => {
  const f = fixture(t);
  const addUpdate = () => f.store.transaction(db => {
    initializeUpdates(db);
    db.prepare(`INSERT INTO host_update_jobs(id,rollout,host,target_kind,release,attempt,installation,credential,phase,components,created,updated)
      VALUES (?,?,?,'host',?,?,?,?,'draining','[]',?,?)`).run(randomUUID(), randomUUID(), f.host, randomUUID(), randomUUID(), randomUUID(), key(), f.now(), f.now());
  });
  const finishUpdate = () => f.store.transaction(db => db.exec("UPDATE host_update_jobs SET phase='succeeded'"));
  const id = f.begin().body.id;
  addUpdate(); assert.deepEqual(f.state().owners, ["manual", "update"]);
  finishUpdate(); assert.deepEqual(f.state().owners, ["manual"]);
  assert.throws(() => f.create(), failure(409, "host_draining"));
  addUpdate();
  f.beat({}, proof(f.beat().maintenance));
  assert.equal(f.state().readyToResume, true);
  assert.equal(f.state().safeToPowerOff, false);
  assert.deepEqual(f.resume(id).body.owners, ["update"]);
  assert.throws(() => f.create(), failure(409, "host_draining"));
  finishUpdate(); assert.equal(f.create().hostId, f.host);
});

test("a completed update requires a new maintenance heartbeat", t => {
  const f = fixture(t);
  f.store.transaction(initializeUpdates);
  f.begin();
  f.beat({}, proof(f.beat().maintenance));
  assert.equal(f.state().safeToPowerOff, true);
  const update = randomUUID();
  f.store.transaction(db => db.prepare(`INSERT INTO host_update_jobs(id,rollout,host,target_kind,release,attempt,installation,credential,phase,components,created,updated)
    VALUES (?,?,?,'host',?,?,?,?,'draining','[]',?,?)`).run(update, randomUUID(), f.host, randomUUID(), randomUUID(), randomUUID(), key(), f.now(), f.now()));
  assert.ok(blocked(f.state(), "update", update));
  f.store.transaction(db => db.prepare("UPDATE host_update_jobs SET phase='succeeded' WHERE id=?").run(update));
  assert.equal(f.state().safeToPowerOff, false);
  assert.equal(f.state().blockers[0].state, "ledgerChanged");
  f.beat({}, proof(f.beat().maintenance));
  assert.equal(f.state().safeToPowerOff, true);
});

test("unsupported backing storage permits resume; absent and unknown storage block it", t => {
  const f = fixture(t, "linux", "libvirt"), m = f.create(), reports = { [m.id]: { state: "stopped" } };
  f.desired(m.id, "stopped");
  f.begin();
  let challenge = f.beat(reports).maintenance;
  for (const storage of ["absent", "unknown", "unsupported"]) {
    challenge = f.beat(reports, proof(challenge, [inventory(m.id, storage)])).maintenance;
    const status = f.state();
    const blocker = status.blockers.find((b: Json) => b.id === m.id);
    assert.equal(status.safeToPowerOff, false);
    assert.equal(status.readyToResume, storage === "unsupported");
    assert.deepEqual([blocker.kind, blocker.state, blocker.blocks], storage === "unsupported" ?
      ["unsupportedProof", storage, ["powerOff"]] : ["missingResource", storage, ["powerOff", "resume"]]);
  }
});

test("stopped assignments with unmaterialized storage permit explicit resume", t => {
  const f = fixture(t, "linux", "libvirt"), m = f.create(), reports = { [m.id]: { state: "stopped" } };
  f.desired(m.id, "stopped");
  f.begin();
  f.beat(reports, proof(f.beat(reports).maintenance, [inventory(m.id, "notMaterialized")]));
  const status = f.state();
  assert.equal(status.readyToResume, true);
  assert.deepEqual(status.blockers, []);
});

test("trusted mapping fences Linux reservations and requires unsupported peer proof only for power-off", t => {
  const f = fixture(t), domain = randomUUID(), runners = f.leases.linux.runners!;
  const binding = { controllerId: f.options.controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const id = randomUUID(), credential = key();
  const issued = runners.issue({ id, ...binding, ttlSeconds: 60 }) as { enrollmentToken: string };
  runners.consume(issued.enrollmentToken, { id, ...binding, credential });
  const image = { id: "runner-linux", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "appleVirtualization",
    digest: "sha256:" + "ab".repeat(32), resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, capabilities: ["command"] };
  f.leases.linux.image(image);
  f.leases.linux.grant({ applicationId: f.app.id, imageId: image.id, revision: "1", arch: "amd64", digest: image.digest });
  f.store.transaction(db => {
    f.leases.linux.domains.define(db, { id: domain, name: "fixture", capacity: image.resources }, f.now());
    new PhysicalDomains().map(db, f.host, domain);
  });
  f.leases.linux.approve({ binding, domainId: domain, backend: "appleVirtualization", images: [{ id: image.id, revision: "1", arch: "amd64", digest: image.digest }] });
  const drain = f.begin().body.id;
  assert.throws(() => f.leases.linux.acquire(f.app.credential, { id: randomUUID(), templateId: image.id, templateRevision: "1", arch: "amd64" }),
    failure(503, "capacity_unavailable"));
  assert.deepEqual(f.leases.linux.claim(credential, { binding, claimId: randomUUID() }), { assignment: null });
  f.beat({}, proof(f.beat().maintenance));
  const state = f.state();
  assert.equal(state.readyToResume, true);
  assert.equal(state.safeToPowerOff, false);
  assert.deepEqual(state.blockers.map((b: Json) => [b.kind, b.id, b.blocks]), [["unsupportedProof", binding.runnerId, ["powerOff"]]]);
  assert.equal(f.resume(drain).body.admissionClosed, false);
});


test("revoked mapped model and Linux assignments block maintenance resume", async t => {
  const f = fixture(t), domain = randomUUID(), linux = f.leases.linux, runners = linux.runners!;
  const models = new ModelJobs(f.store, f.apps, runners);
  const binding = { controllerId: f.options.controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const id = randomUUID(), credential = key();
  const { enrollmentToken } = runners.issue({ id, ...binding, ttlSeconds: 60 }) as { enrollmentToken: string };
  runners.consume(enrollmentToken, { id, ...binding, credential });
  const resources = { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, digest = "sha256:" + "ab".repeat(32), model = "fixture-model:1";
  const image = { id: "runner-linux", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "appleVirtualization", digest, resources, capabilities: ["command"] };
  f.store.transaction(db => {
    linux.domains.define(db, { id: domain, name: "fixture", capacity: f.offer().capacity }, f.now());
    new PhysicalDomains().map(db, f.host, domain);
  });
  linux.image(image);
  linux.grant({ applicationId: f.app.id, imageId: image.id, revision: "1", arch: "amd64", digest });
  linux.approve({ binding, domainId: domain, backend: "appleVirtualization", images: [{ id: image.id, revision: "1", arch: "amd64", digest }] });
  const leaseId = randomUUID();
  linux.acquire(f.app.credential, { id: leaseId, templateId: image.id, templateRevision: "1", arch: "amd64" });
  const { assignment: lease } = linux.claim(credential, { binding, claimId: randomUUID() }) as Json;
  const linuxReport = (sequence: number, runtimeState: string) => linux.report(credential, { binding, assignmentId: lease.id, sequence, receipt: {
    leaseId, memberId: lease.memberId, backend: image.backend, imageDigest: digest, observedRevision: lease.lease.revision,
    runtimeState, ready: { command: runtimeState === "running", pty: false, files: false }, failure: null,
    executionStopped: false, storageRemoved: false, credentialsErased: false, cleanup: "pending",
  } });
  linuxReport(1, "running");
  models.catalog({ model, digest, adapter: "ollama", resources });
  models.grant({ applicationId: f.app.id, model, digest, maxUnfinished: 1 });
  models.approve({ binding, domainId: domain, models: [{ model, digest }] });
  const job = { version: 1, applicationId: f.app.id, id: randomUUID() };
  models.submit(f.app.credential, { ...job, message: { type: "submit", adapter: "ollama", model, digest, prompt: "Fixture", maxTokens: 64 } });
  const { assignment } = models.claim(credential, { binding, claimId: randomUUID() }) as Json;
  models.report(credential, { binding, assignmentId: assignment.id, sequence: 1,
    receipt: { ...job, message: { type: "receipt", state: "running", cancelRequested: false, stopped: false, cleanup: "pending" } } });
  const drain = f.begin().body.id;
  f.beat({}, proof(f.beat().maintenance));
  assert.equal(f.state().readyToResume, true);
  await t.test("cycling mapped Linux receipts require fresh maintenance proof", () => {
    linuxReport(2, "unknown");
    assert.equal(f.state().readyToResume, false);
    linuxReport(3, "running");
    assert.equal(f.state().readyToResume, false);
    f.beat({}, proof(f.beat().maintenance));
    assert.equal(f.state().readyToResume, true);
  });
  runners.manage(binding, true);
  assert.equal((models.inspect(f.app.credential, job.id) as Json).state, "unknown");
  assert.equal((linux.inspect(f.app.credential, leaseId) as Json).runtimeState, "unknown");
  f.beat({}, proof(f.beat().maintenance));
  const status = f.state();
  assert.deepEqual(status.blockers.filter((b: Json) => b.kind === "unknownState").map((b: Json) => b.id).sort(), [lease.id, assignment.id].sort());
  assert.equal(status.readyToResume, false);
  assert.equal(f.resume(drain).status, 409);
});

test("browser gateway admission records a launch and only permits receipt lookup during the drain", async t => {
  const f = fixture(t), host = randomUUID();
  f.leases.machines.enroll({ id: host, credential: key(), offer: { name: "browser fixture", provider: "macos", runtimes: ["apple"], templates: [], capacity: f.offer().capacity } }, f.options.enrollmentToken);
  f.store.transaction(db => db.prepare("UPDATE hosts SET seen=? WHERE id=?").run(Date.now() / 1000, host));
  const client = new ControlClient({ ...f.options, path: f.store.path, browserHosts: [host] });
  t.after(() => client.close());
  const path = `/v1/hosts/${host}/maintenance`, id = randomUUID(), intent = { id, engine: "chromium", ttlSeconds: 60 };
  const launch = (body: Json) => client.request({ type: "browsers.launch", hostId: host, intent: body, adminToken: f.options.adminToken });
  assert.equal(await launch(intent), true);
  const reply = await client.request({ type: "http", method: "POST", path, body: { id: randomUUID() }, query: "", token: f.options.adminToken });
  assert.ok(blocked(reply!.body as Json, "session", id));
  assert.ok(blocked(reply!.body as Json, "unsupportedProof", host));
  assert.equal(await launch(intent), "inspect");
  await assert.rejects(launch({ ...intent, ttlSeconds: 90 }), failure(409));
  await assert.rejects(launch({ ...intent, id: randomUUID() }), failure(409, "host_draining"));
  await client.request({ type: "browsers.receipt", hostId: host, id, state: "closed" });
  const status = await client.request({ type: "http", method: "GET", path, body: {}, query: "", token: f.options.adminToken });
  assert.equal(blocked(status!.body as Json, "session", id), false);
});

test("maintenance CLI handles null status, generated UUIDs and explicit resume over HTTP", async t => {
  const f = fixture(t), admin = join(dirname(f.store.path), "admin.token"), enrollment = join(dirname(f.store.path), "enrollment.token");
  writeFileSync(admin, f.options.adminToken, { mode: 0o600 });
  writeFileSync(enrollment, f.options.enrollmentToken, { mode: 0o600 });
  const controller = await startController({ statePath: f.store.path, adminTokenFile: admin, enrollmentTokenFile: enrollment,
    controllerId: f.options.controllerId, listen: { host: "127.0.0.1", port: 0 } });
  t.after(() => controller.close());
  const url = `http://127.0.0.1:${controller.address.port}`;
  async function cli(...args: string[]) {
    let stdout = "", stderr = "";
    assert.equal(await main(["--url", url, "--token-file", admin, "maintenance", ...args], {
      stdout: line => { stdout += line; }, stderr: line => { stderr += line; },
    }), 0, stderr);
    return { body: JSON.parse(stdout), stderr };
  }
  assert.equal((await cli("status", f.host)).body, null);
  const begun = await cli("begin", f.host, "--reason", "fixture");
  assert.ok(begun.stderr.includes(begun.body.id));
  assert.equal(begun.body.reason, "fixture");
  async function beat(maintenance: Json) {
    const response = await fetch(url + `/v1/hosts/${f.host}/heartbeat`, { method: "POST",
      headers: { authorization: `Bearer ${f.hostToken}`, "content-type": "application/json" },
      body: JSON.stringify({ offer: f.offer(), reports: {}, maintenance }) });
    assert.equal(response.status, 200); return (await response.json() as Json).maintenance;
  }
  const challenge = await beat({ version: 1 });
  await beat(proof(challenge));
  assert.equal((await cli("status", f.host)).body.safeToPowerOff, true);
  const requestId = randomUUID(), resume = await cli("resume", f.host, begun.body.id, "--request-id", requestId);
  assert.equal(resume.body.phase, "resumed");
  assert.deepEqual(await cli("resume", f.host, begun.body.id, "--request-id", requestId), resume);
});


test("fenced local image retries continue running tasks and replay completed receipts", async t => {
  const f = fixture(t);
  let imports = 0;
  const host: LocalAttachedHost = {
    state: dirname(f.store.path), config: f.offer(), offer: f.offer(),
    identity: { id: f.host, credential: f.hostToken, orchestrator: "http://127.0.0.1" }, assignments: [], lastContact: f.now(),
    clock: { now: f.now }, guard: { allowed: () => true, beginExecution() {} },
    context() { throw new Error("No fixture VM"); }, refreshImages() {}, close() {},
    async importImage(metadata, source, size) {
      imports++;
      const data = await source.read(size);
      return { ...metadata, bytes: size, sha256: createHash("sha256").update(data).digest("hex"), kind: "base", revision: "1" };
    },
  };
  f.store.transaction(initializeInference);
  const images = new ImagesController(f.store);
  const connector = createLocalConnectors({ hosts: () => [host], machine: () => undefined, store: f.store, signal: new AbortController().signal }).imageImport!;
  const spec = { id: randomUUID(), name: "fixture image", os: "linux", arch: "amd64", mode: "headless",
    mediaType: "disk", format: "raw", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const write = async (metadata = spec, fill = 0) => connector.write({ hostId: f.host, metadata, size: 512,
    reader: { async read(n: number) { return Buffer.alloc(n, fill); } } as never, authorized: async () => true });
  const receipt = await write(), pending = { ...spec, id: randomUUID() };
  images.reserveImageImport(f.host, pending, 512);
  f.begin();
  await t.test("authorization loss cannot fail a committed image import retry", async () => {
    let authorized = true;
    const stored = () => f.store.transaction(db => db.prepare("SELECT * FROM image_tasks WHERE id=?").get(pending.id));
    const before = stored();
    await assert.rejects(async () => connector.write({ hostId: f.host, metadata: pending, size: 512,
      reader: { async read(n: number) { authorized = false; return Buffer.alloc(n); } } as never,
      authorized: async () => authorized }), { status: 403 });
    assert.deepEqual(stored(), before);
  });
  assert.deepEqual(await write(), receipt);
  await assert.rejects(write(spec, 1), { status: 409 });
  assert.equal(((await write(pending)) as Json).id, pending.id);
  assert.equal(((await write(pending)) as Json).id, pending.id);
  await assert.rejects(write({ ...spec, id: randomUUID() }), { status: 409, code: "host_draining" });
  assert.equal(imports, 3);
});

test("attached image imports require authorization before admission", async t => {
  const f = fixture(t), id = randomUUID();
  f.store.transaction(initializeInference);
  const host: LocalAttachedHost = {
    state: dirname(f.store.path), config: f.offer(), offer: f.offer(),
    identity: { id: f.host, credential: f.hostToken, orchestrator: "http://127.0.0.1" }, assignments: [], lastContact: f.now(),
    clock: { now: f.now }, guard: { allowed: () => true, beginExecution() {} },
    context() { throw new Error("No fixture VM"); }, close() {},
    async importImage(_metadata, source, size) { await source.read(size); return assert.fail("Import must not read with expired authority"); },
  };
  const connector = createLocalConnectors({ hosts: () => [host], machine: () => undefined, store: f.store, signal: new AbortController().signal }).imageImport!;
  const metadata = { id, name: "fixture image", os: "linux", arch: "amd64", mode: "headless", mediaType: "disk", format: "raw",
    minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  await assert.rejects(async () => connector.write({ hostId: f.host, metadata, size: 512, authorized: async () => false,
    reader: { async read() { return assert.fail("Import must not read with expired authority"); } } as never }), { status: 403 });
  assert.equal(f.store.transaction(db => db.prepare("SELECT state FROM image_tasks WHERE id=?").get(id)), undefined);
});

test("a persisted retired provider stays offline and keeps its lease cleanup reservation across restart", async t => {
  const f = fixture(t);
  const lease = await f.request("POST", "/v1/leases", f.acquire());
  const machineId = lease.members[0].machineId;
  f.ready(lease);
  const retiredImage = { ...f.image, runtime: "kubevirt" };
  const retiredOffer = { ...f.offer(), provider: "kubevirt", templates: [retiredImage] };
  assert.throws(() => f.leases.machines.enroll({ id: randomUUID(), credential: key(), offer: retiredOffer }, f.options.enrollmentToken), failure(400, "unsupported_host_provider"));
  f.store.transaction(db => {
    db.prepare("UPDATE hosts SET offer=? WHERE id=?").run(JSON.stringify(retiredOffer), f.host);
    db.prepare("UPDATE machines SET template=? WHERE id=?").run(JSON.stringify(retiredImage), machineId);
    db.prepare("UPDATE templates SET definition=? WHERE id=?").run(JSON.stringify(retiredImage), f.image.id);
  });
  const restarted = new SqliteStore(f.store.path, f.now);
  const leases = new LegacyLeases(restarted, f.options);
  const host = leases.machines.hosts({ principal: () => operator }).find(h => h.id === f.host)!;
  assert.deepEqual([host.online, host.placementReady, host.invalidOffer], [false, false, true]);
  assert.equal(host.reserved.diskGiB, f.image.minimum.diskGiB);
  assert.throws(() => leases.machines.heartbeat(f.host, f.hostToken, { offer: retiredOffer }), failure(400, "unsupported_host_provider"));
  new ImagesController(restarted);
  restarted.transaction(initializeInference);
  const resources = new InfrastructureStore(restarted).hostResources(f.host);
  assert.equal((resources.allocations as Json[])[0]!.observed, "unknown");
  const current = await f.request("GET", `/v1/leases/${lease.id}`);
  assert.deepEqual([current.state, current.members[0].state, current.cleanup.state], ["failed", "unknown", "pending"]);
  assert.equal(restarted.transaction(db => db.prepare("SELECT template FROM machines WHERE id=?").get(machineId)?.template), JSON.stringify(retiredImage));
});
