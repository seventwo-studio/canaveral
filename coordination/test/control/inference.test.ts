import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { Accounts, tokenHash } from "../../src/accounts.ts";
import { CapacityLedger } from "../../src/capacity.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { assignedInferenceJobs, createModule, inferenceOffer, inferenceRequest, inferenceUsed, initializeInference, reportInferenceJobs } from "../../src/control/inference.ts";
import type { InferenceJob } from "../../src/control/inference.ts";
import type { ControlModule, ControlRequest, ControlResponse, Principal } from "../../src/control/contracts.ts";

const size = { cpu: 2, memoryMiB: 2048, diskGiB: 1 };
const capacity = { cpu: 4, memoryMiB: 4096, diskGiB: 10 };
const model = () => ({ id: "fixture:latest", digest: `sha256:${"a".repeat(64)}`, capability: "generation" as const, resources: { ...size } });
const result = () => ({ model: "fixture:latest", text: "Hello", usage: { inputTokens: 1, outputTokens: 1 } });
const submit = (changes = {}) => ({ id: randomUUID(), model: model().id, prompt: "Say hello", ...changes });
const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
const options = { adminToken: "o".repeat(43), controllerId: "11111111-1111-1111-1111-111111111111" };
function request(method: string, path: string, body: Record<string, unknown> = {}, principal: () => Principal = () => operator, token = options.adminToken): ControlRequest {
  return { method, path, parts: path.split("/").filter(Boolean), body, token, query: new URLSearchParams(), principal };
}
function call(module: ControlModule, method: string, path: string, body: Record<string, unknown> = {}): ControlResponse {
  const response = module.handle(request(method, path, body));
  assert.ok(response && !(response instanceof Promise));
  return response;
}
function status(code: number): (error: unknown) => boolean { return error => error instanceof ServiceError && error.status === code; }
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-inference-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const store = new SqliteStore(join(directory, "controller.sqlite"), () => now);
  // Real capacity table shapes, with no Python reference process or native provider.
  store.transaction(db => db.exec(`
    CREATE TABLE hosts (id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE retired_runners (id TEXT PRIMARY KEY);
    CREATE TABLE machines (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE images (id TEXT PRIMARY KEY,host TEXT NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE image_tasks (id TEXT PRIMARY KEY,host TEXT NOT NULL,reserved_disk INTEGER NOT NULL,state TEXT NOT NULL);
    CREATE TABLE machine_deletions (machine TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE lease_cleanup_members (machine TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE lease_members (machine TEXT PRIMARY KEY);
    CREATE TABLE machine_power_offs (machine TEXT PRIMARY KEY,state TEXT NOT NULL);`));
  let module = createModule(store, options);
  const ledger = new CapacityLedger(store);
  function host(digest = model().digest, budget = capacity, extra: Record<string, unknown> = {}) {
    const id = randomUUID(), offer = { provider: "native", capacity: budget, templates: [], inference: { runtime: "ollama", models: [{ ...model(), digest }] }, ...extra };
    store.transaction(db => db.prepare("INSERT INTO hosts VALUES (?,'synthetic',?,?,1)").run(id, JSON.stringify(offer), now));
    return id;
  }
  const hostId = host();
  const create = (value = submit()) => call(module, "POST", "/v1/jobs", value).body as InferenceJob;
  const get = (id: string) => call(module, "GET", `/v1/jobs/${id}`).body as InferenceJob;
  const cancel = (id: string) => call(module, "POST", `/v1/jobs/${id}/cancel`).body as InferenceJob;
  const reports = (value: Record<string, unknown>, id = hostId) => store.transaction(db => reportInferenceJobs(db, id, value, now));
  const used = () => store.transaction(db => ledger.used(db, hostId));
  const assigned = () => store.transaction(db => assignedInferenceJobs(db, hostId, now));
  return { directory, store, ledger, hostId, host, create, get, cancel, reports, used, assigned,
    module, advance: (seconds: number) => { now += seconds; }, reload: () => { module = createModule(new SqliteStore(store.path, () => now), options); return module; } };
}

test("durable admission shares VM, inference, image and configured host budgets", t => {
  const f = fixture(t);
  f.store.transaction(db => db.prepare("INSERT INTO machines VALUES (?,?,?,'{}','running','unknown','',1000)").run(randomUUID(), JSON.stringify({ resources: size }), f.hostId));
  const first = f.create();
  assert.equal(first.state, "queued");
  assert.deepEqual(f.used(), { cpu: 4, memoryMiB: 4096, diskGiB: 2 });
  assert.deepEqual(f.store.transaction(db => inferenceUsed(db, f.hostId)), size);
  assert.throws(() => f.create(), status(409));
  f.reload();
  assert.throws(() => f.create(), status(409));
  f.cancel(first.id);
  assert.deepEqual(f.used(), { cpu: 4, memoryMiB: 4096, diskGiB: 2 });
  f.reports({ [first.id]: { state: "cancelled", stopped: true, cleanup: "complete" } });
  f.ledger.save(f.hostId, { limits: { ...capacity, memoryMiB: 2048 } });
  assert.throws(() => f.create(), status(409));
  f.ledger.save(f.hostId, { limits: capacity });
  f.store.transaction(db => db.prepare("INSERT INTO image_tasks VALUES (?, ?, 9, 'unknown')").run(randomUUID(), f.hostId));
  assert.throws(() => f.create(), status(409));
});

test("request replay survives restart, cancellation and stale hosts without releasing capacity", t => {
  const f = fixture(t), value = submit(), first = f.create(value);
  assert.deepEqual(f.create(value), first);
  assert.throws(() => f.create({ ...value, prompt: "Different" }), status(409));
  f.reload(); f.cancel(first.id); f.advance(31);
  assert.equal(f.get(first.id).state, "unknown");
  assert.equal(f.create(value).desired, "cancelled");
  assert.deepEqual(f.used(), size);
  assert.equal(f.assigned()[0]!.request.prompt, "Say hello");
  assert.equal(f.assigned()[0]!.desired, "cancelled");
  assert.throws(() => f.reports({ [first.id]: { state: "cancelled" } }), status(400));
  f.reports({ [first.id]: { state: "unknown" } });
  assert.throws(() => f.reports({ [first.id]: { state: "running" } }), status(409));
  f.reports({ [first.id]: { state: "cancelled", stopped: true, cleanup: "complete" } });
  assert.deepEqual(f.used(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  assert.equal(f.get(first.id).state, "cancelled");
  assert.equal(f.create(value).state, "cancelled");
});

test("digest ambiguity, pinned placement, draining, retirement and freshness", t => {
  const f = fixture(t);
  const second = f.host(`sha256:${"b".repeat(64)}`);
  assert.throws(() => f.create(), /Multiple model digests/);
  assert.equal(f.create(submit({ digest: model().digest })).hostId, f.hostId);
  f.store.transaction(db => db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.hostId));
  assert.throws(() => f.create(submit({ hostId: f.hostId })), status(409));
  assert.equal(f.create(submit({ hostId: second })).hostId, second);
  f.store.transaction(db => db.prepare("INSERT INTO retired_runners VALUES (?)").run(second));
  assert.throws(() => f.create(), status(409));
  f.store.transaction(db => db.prepare("UPDATE hosts SET enabled=1 WHERE id=?").run(f.hostId));
  f.advance(30);
  assert.throws(() => f.create(), status(409));
});

test("report ownership, measured result validation and whole-heartbeat rollback", t => {
  const f = fixture(t), job = f.create();
  const other = f.host();
  assert.throws(() => f.reports({ [job.id]: { state: "failed", stopped: true, cleanup: "complete" } }, other), status(403));
  assert.throws(() => f.store.transaction(db => {
    db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.hostId);
    reportInferenceJobs(db, f.hostId, { [job.id]: { state: "succeeded", result: {}, stopped: true, cleanup: "complete" } }, f.store.clock());
  }), status(400));
  assert.equal(f.store.transaction(db => db.prepare("SELECT enabled FROM hosts WHERE id=?").get(f.hostId)!.enabled), 1);
  for (const invalid of [{ ...result(), model: "other:latest" }, { ...result(), usage: {} }, { ...result(), usage: { inputTokens: true, outputTokens: 1 } }]) {
    assert.throws(() => f.reports({ [job.id]: { state: "succeeded", result: invalid, stopped: true, cleanup: "complete" } }), status(400));
  }
  for (const invalid of [{ state: "running", detail: null }, { state: "running", stopped: null }, { state: "failed", stopped: true, cleanup: null }]) assert.throws(() => f.reports({ [job.id]: invalid }), status(400));
  assert.throws(() => f.reports({ [job.id]: { state: "cancelled", stopped: true, cleanup: "complete" } }), status(409));
  f.reports({ [job.id]: { state: "succeeded", result: result(), stopped: true, cleanup: "complete" } });
  f.reports({ [job.id]: { cleanup: "complete", stopped: true, result: { usage: { outputTokens: 1, inputTokens: 1 }, text: "Hello", model: model().id }, state: "succeeded" } });
  assert.throws(() => f.reports({ [job.id]: { state: "failed", stopped: true, cleanup: "complete" } }), status(409));
  assert.deepEqual(f.get(job.id).result, result());
  const listing = call(f.module, "GET", "/v1/jobs").body as { jobs: InferenceJob[] };
  assert.ok(!JSON.stringify(listing).includes("Say hello"));
  assert.ok(!Object.hasOwn(listing.jobs[0]!, "result"));
});

test("partial terminal proof remains charged across restarts; sequences and immutable results fence stale reports", t => {
  const f = fixture(t), job = f.create();
  f.reports({ [job.id]: { state: "running", sequence: 1 } });
  f.reports({ [job.id]: { state: "running", sequence: 1 } });
  assert.throws(() => f.reports({ [job.id]: { state: "unknown", sequence: 1 } }), status(409));
  assert.throws(() => f.reports({ [job.id]: { state: "unknown", sequence: 3 } }), status(409));
  const completed = { state: "succeeded", result: result(), stopped: false, cleanup: "pending", sequence: 2 };
  f.reports({ [job.id]: completed });
  assert.equal(f.get(job.id).reservationHeld, true);
  assert.equal(f.get(job.id).state, "succeeded");
  assert.deepEqual(f.used(), size);
  f.reload();
  assert.equal(f.assigned().length, 1);
  f.reports({ [job.id]: { ...completed, stopped: true, sequence: 3 } });
  assert.deepEqual(f.used(), size);
  assert.throws(() => f.reports({ [job.id]: { ...completed, result: { ...result(), text: "Changed" }, sequence: 4 } }), status(409));
  f.reports({ [job.id]: { ...completed, stopped: true, cleanup: "complete", sequence: 4 } });
  assert.equal(f.get(job.id).reservationHeld, false);
  assert.equal(f.assigned().length, 0);
});

test("FIFO blocks later execution while queued cancellation can be acknowledged first", t => {
  const f = fixture(t), first = f.create(), second = f.create();
  assert.deepEqual(f.assigned().map(job => job.id), [first.id, second.id]);
  assert.throws(() => f.reports({ [second.id]: { state: "running" } }), status(409));
  f.cancel(second.id);
  f.reports({ [second.id]: { state: "cancelled", stopped: true, cleanup: "complete" } });
  assert.deepEqual(f.assigned().map(job => job.id), [first.id]);
  f.reports({ [first.id]: { state: "unknown" } });
  const third = f.create();
  assert.throws(() => f.reports({ [third.id]: { state: "running" } }), status(409));
});

test("public offers strip local paths and request validation preserves byte, encoded and token limits", t => {
  fixture(t);
  const publicOffer = inferenceOffer({ runtime: "ollama", models: [model()], executable: "/private/ollama", modelsDirectory: "/private/models" });
  assert.ok(!JSON.stringify(publicOffer).includes("private"));
  for (const invalid of [{ ...model(), id: "cloud-model" }, { ...model(), digest: "unknown" }, { ...model(), capability: "decision" }]) {
    assert.throws(() => inferenceOffer({ runtime: "ollama", models: [invalid] }), status(400));
  }
  assert.throws(() => inferenceOffer({ runtime: "ollama", models: [model(), model()] }), status(400));
  for (const invalid of [submit({ maxTokens: true }), submit({ maxTokens: 0 }), submit({ prompt: "\0".repeat(65536) }), submit({ prompt: "é".repeat(12000) }), submit({ prompt: "\ud800" }), submit({ other: "field" })]) assert.throws(() => inferenceRequest(invalid), status(400));
  assert.equal(inferenceRequest(submit({ maxTokens: 4096 })).maxTokens, 4096);
});

test("legacy human routes reject applications, runners, enrollment, ordinary users and narrow admin tokens", t => {
  const f = fixture(t), accounts = new Accounts(f.store);
  const uid = randomUUID(), token = "h".repeat(43), session = "s".repeat(43), tokenId = randomUUID();
  f.store.transaction(db => {
    db.prepare("INSERT INTO users VALUES (?,?,'admin','active',1000,NULL,NULL,NULL)").run(uid, "admin");
    db.prepare("INSERT INTO user_sessions VALUES (?,?,2000)").run(tokenHash(session), uid);
    db.prepare("INSERT INTO api_tokens VALUES (?,?,?,'[\"machines:read\"]',1000,2000,NULL,NULL,'fixture',?)").run(tokenId, uid, "read", tokenHash(token));
  });
  for (const [method, path, body] of [["GET", "/v1/models", {}], ["GET", "/v1/jobs", {}], ["POST", "/v1/jobs", submit()]] as const) {
    assert.throws(() => f.module.handle(request(method, path, body, () => accounts.principal(token), token)), status(403));
    for (const scoped of ["application", "runner", "enrollment"]) {
      assert.throws(() => f.module.handle(request(method, path, body, () => accounts.principal(scoped.repeat(7)), scoped.repeat(7))), status(401));
    }
  }
  assert.ok(f.module.handle(request("GET", "/v1/models", {}, () => accounts.principal(session), session)));
  const demoteBeforeTransaction = () => {
    const principal = accounts.principal(session);
    f.store.transaction(db => db.prepare("UPDATE users SET role='user' WHERE id=?").run(uid));
    return principal;
  };
  assert.throws(() => f.module.handle(request("POST", "/v1/jobs", submit(), demoteBeforeTransaction, session)), status(403));
  assert.throws(() => f.module.handle(request("GET", "/v1/models", {}, () => accounts.principal(session), session)), status(403));
  f.store.transaction(db => db.prepare("UPDATE users SET role='admin' WHERE id=?").run(uid));
  const revokeBeforeTransaction = () => {
    const principal = accounts.principal(session);
    f.store.transaction(db => db.prepare("DELETE FROM user_sessions WHERE token_hash=?").run(tokenHash(session)));
    return principal;
  };
  assert.throws(() => f.module.handle(request("POST", "/v1/jobs", submit(), revokeBeforeTransaction, session)), status(401));
  assert.equal(f.module.handle(request("GET", "/v1/not-inference")), undefined);
});

test("unproven legacy terminal rows are quarantined rather than silently releasing reservations", t => {
  const f = fixture(t), id = randomUUID();
  f.store.transaction(db => {
    db.prepare("INSERT INTO inference_jobs VALUES (?,?,?,?,'running','succeeded','',?,1000,1000)").run(id, JSON.stringify(inferenceRequest(submit({ id }))), f.hostId, JSON.stringify(model()), JSON.stringify(result()));
    initializeInference(db);
  });
  assert.equal(f.get(id).state, "unknown");
  assert.deepEqual(f.used(), size);
  assert.equal(f.get(id).result, undefined);
});

test("opaque legacy inference schema remains untouched and cannot disable independent controller slices", t => {
  const f = fixture(t);
  f.store.transaction(db => db.exec(`DROP TABLE inference_jobs; DROP TABLE inference_control_receipts;
    CREATE TABLE inference_jobs (id TEXT PRIMARY KEY,host TEXT,state TEXT,definition TEXT);
    INSERT INTO inference_jobs VALUES ('legacy-job','legacy-host','unknown','{}');
    INSERT INTO hosts VALUES ('legacy-host','legacy-hash','{}',1,1);`));
  const module = f.reload();
  for (const [method, path, body] of [["GET", "/v1/models", {}], ["GET", "/v1/jobs", {}], ["POST", "/v1/jobs", submit()], ["GET", `/v1/jobs/${randomUUID()}`, {}], ["POST", `/v1/jobs/${randomUUID()}/cancel`, {}]] as const) {
    assert.throws(() => call(module, method, path, body), status(503));
  }
  assert.equal(module.handle(request("POST", "/v1/model-jobs", {})), undefined);
  assert.equal(module.handle(request("POST", "/v1/linux-leases", {})), undefined);
  f.store.transaction(db => {
    assert.equal(initializeInference(db), false);
    assert.deepEqual(db.prepare("PRAGMA table_info(inference_jobs)").all().map(column => column.name), ["id", "host", "state", "definition"]);
    assert.deepEqual(db.prepare("SELECT * FROM inference_jobs").all().map(row => ({ ...row })), [{ id: "legacy-job", host: "legacy-host", state: "unknown", definition: "{}" }]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='inference_control_receipts'").get(), undefined);
    assert.equal(db.prepare("SELECT offer FROM hosts WHERE id='legacy-host'").get()!.offer, "{}");
    assert.deepEqual(assignedInferenceJobs(db, f.hostId, 1000), []);
    reportInferenceJobs(db, f.hostId, {}, 1000);
    assert.throws(() => reportInferenceJobs(db, f.hostId, { [randomUUID()]: { state: "running" } }, 1000), status(503));
    assert.throws(() => inferenceUsed(db, f.hostId), status(503));
  });
});

test("32 unfinished placements cap a host even when capacity remains", t => {
  const f = fixture(t);
  f.store.transaction(db => db.prepare("UPDATE hosts SET offer=? WHERE id=?").run(JSON.stringify({ provider: "native", templates: [], capacity: { cpu: 1000, memoryMiB: 1_000_000, diskGiB: 1000 }, inference: { runtime: "ollama", models: [model()] } }), f.hostId));
  for (let i = 0; i < 32; i++) f.create();
  assert.throws(() => f.create(), status(409));
  assert.equal(f.assigned().length, 32);
});

test("two independent SQLite admission workers cannot spend one remaining budget", { timeout: 20000 }, async t => {
  const f = fixture(t); f.create();
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const moduleUrl = new URL(`../../src/control/inference.${extension}`, import.meta.url).href;
  const sqliteUrl = new URL(`../../src/sqlite.${extension}`, import.meta.url).href;
  const readyWorkers: Worker[] = [];
  const runs = Array.from({ length: 2 }, () => new Promise<number>((resolve, reject) => {
    const value = submit();
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      Promise.all([import(workerData.moduleUrl),import(workerData.sqliteUrl)]).then(([{createModule},{SqliteStore}])=>{
        const module=createModule(new SqliteStore(workerData.path,()=>1000),workerData.options);
        parentPort.postMessage('ready'); parentPort.once('message',()=>{
          const req={method:'POST',path:'/v1/jobs',parts:['v1','jobs'],body:workerData.body,token:workerData.options.adminToken,query:new URLSearchParams(),principal:()=>({kind:'operator',user:null,scopes:['admin']})};
          try { module.handle(req); parentPort.postMessage(200); } catch(error) { parentPort.postMessage(error.status); }
        });
      }).catch(error=>{throw error;});`, { eval: true, workerData: { path: f.store.path, moduleUrl, sqliteUrl, options, body: value } });
    t.after(() => { void worker.terminate(); });
    worker.on("error", reject);
    worker.on("message", (message: string | number) => {
      if (message === "ready") {
        readyWorkers.push(worker);
        if (readyWorkers.length === 2) for (const ready of readyWorkers) ready.postMessage("admit");
      }
      else resolve(Number(message));
    });
  }));
  assert.deepEqual((await Promise.all(runs)).sort(), [200, 409]);
  assert.deepEqual(f.used(), { cpu: 4, memoryMiB: 4096, diskGiB: 2 });
});
