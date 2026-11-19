import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseControllerConfig } from "../src/main.ts";
import { ConsumerClient } from "../src/consumer-client.ts";

type Body = Record<string, unknown>;
type Reply = { status: number; body: Body };
type Binding = { controllerId: string; runnerId: string; generation: number; incarnationId: string };
type Runner = { binding: Binding; credential: string };
const main = new URL("../src/main.js", import.meta.url).pathname;
const key = () => randomBytes(32).toString("base64url");
const MODEL = "fixture-model:1", DIGEST = "sha256:" + "ab".repeat(32);
const JOB_RESOURCES = { cpu: 4, memoryMiB: 8192, diskGiB: 10 };

function call(port: number, method: "GET" | "POST", route: string, body?: unknown, token?: string): Promise<Reply> {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: route, agent: false, timeout: 10_000, headers: {
      ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Body }); } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("fixture timeout")));
    request.end(data);
  });
}

/** Forwards a request, lets the controller finish, then drops the whole reply. */
async function lossyProxy(target: () => number) {
  let forwarded = 0;
  const server = net.createServer(client => {
    const upstream = net.connect(target(), "127.0.0.1");
    client.pipe(upstream);
    upstream.on("data", () => {});
    upstream.on("end", () => { forwarded++; client.destroy(); });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get forwarded() { return forwarded; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

class Controller {
  constructor(readonly child: ChildProcess, readonly port: number) {}
  static async start(config: string): Promise<Controller> {
    const child = spawn(process.execPath, [main, config], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout!.on("data", chunk => {
        output += String(chunk);
        const line = output.split("\n")[0];
        if (output.includes("\n")) resolve((JSON.parse(line!) as { listening: { port: number } }).listening.port);
      });
      child.once("exit", code => reject(new Error(`controller exited ${code}: ${errors}`)));
    });
    return new Controller(child, port);
  }
  /** Simulated crash: no graceful close, no flush beyond committed SQLite transactions. */
  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await exited;
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-model-controller-"));
  const statePath = join(dir, "controller.sqlite"), admin = key(), controllerId = randomUUID();
  writeFileSync(join(dir, "admin.token"), admin + "\n", { mode: 0o600 });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ statePath, adminTokenFile: join(dir, "admin.token"), controllerId, listen: { host: "127.0.0.1", port: 0 } }));
  // Retained legacy rows that this slice must neither adopt nor alter.
  const legacy = new DatabaseSync(statePath);
  legacy.exec(`CREATE TABLE hosts (id TEXT PRIMARY KEY, credential TEXT, offer TEXT, seen REAL, enabled INTEGER);
    CREATE TABLE inference_jobs (id TEXT PRIMARY KEY, host TEXT, state TEXT, definition TEXT);
    INSERT INTO hosts VALUES ('legacy-host','legacy-hash','{}',1,1);
    INSERT INTO inference_jobs VALUES ('legacy-job','legacy-host','unknown','{}');`);
  legacy.close();
  const controllers: Controller[] = [];
  const start = async () => { const c = await Controller.start(config); controllers.push(c); return c; };
  t.after(async () => { await Promise.all(controllers.map(c => c.kill())); rmSync(dir, { recursive: true, force: true }); });
  let primary = await start();
  const port = () => primary.port;
  const post = (route: string, body: unknown, token?: string, via = port()) => call(via, "POST", route, body, token);
  const get = (route: string, token?: string) => call(port(), "GET", route, undefined, token);

  async function application(limits: Body = {}, id: string = randomUUID()): Promise<{ id: string; credential: string }> {
    const created = await post("/v1/consumers", { id, name: "fixture", templates: [], limits: { resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 }, activeLeases: 1, ...limits } }, admin);
    assert.equal(created.status, 200);
    return { id, credential: created.body.credential as string };
  }
  async function enroll(runnerId: string = randomUUID(), generation = 1): Promise<Runner> {
    const binding = { controllerId, runnerId, generation, incarnationId: randomUUID() }, id = randomUUID(), credential = key();
    const issued = await post("/v1/runner-enrollments", { id, ...binding, ttlSeconds: 60 }, admin);
    assert.equal(issued.status, 200);
    assert.equal((await post("/v1/runner-enrollments/consume", { id, ...binding, credential }, issued.body.enrollmentToken as string)).status, 200);
    return { binding, credential };
  }
  async function domain(capacity: { cpu: number; memoryMiB: number; diskGiB: number }): Promise<string> {
    const id = randomUUID();
    assert.equal((await post("/v1/resource-domains", { id, name: "shared physical host", capacity }, admin)).status, 200);
    return id;
  }
  async function approve(runner: Runner, domainId: string): Promise<void> {
    assert.equal((await post("/v1/model-runner-approvals", { binding: runner.binding, domainId, models: [{ model: MODEL, digest: DIGEST }] }, admin)).status, 200);
  }
  async function grant(applicationId: string, maxUnfinished = 8): Promise<void> {
    assert.equal((await post("/v1/model-grants", { applicationId, model: MODEL, digest: DIGEST, maxUnfinished }, admin)).status, 200);
  }
  const submission = (applicationId: string, id: string = randomUUID(), prompt = "Summarize the fixture.") =>
    ({ version: 1, applicationId, id, message: { type: "submit", adapter: "ollama", model: MODEL, digest: DIGEST, prompt, maxTokens: 64 } });
  const receipt = (job: { applicationId: string; id: string }, state: string, extra: Body = {}) => ({ version: 1, applicationId: job.applicationId, id: job.id,
    message: { type: "receipt", state, cancelRequested: false, stopped: false, cleanup: "pending", ...extra } });
  const success = { model: MODEL, text: "fixture output", usage: { inputTokens: 5, outputTokens: 2 } };
  const claim = (runner: Runner, claimId = randomUUID(), via = port()) => post("/v1/runners/model-jobs/claim", { binding: runner.binding, claimId }, runner.credential, via);
  const report = (runner: Runner, assignmentId: string, sequence: number, value: unknown, via = port()) =>
    post("/v1/runners/model-jobs/report", { binding: runner.binding, assignmentId, sequence, receipt: value }, runner.credential, via);
  const inspectDomain = async (id: string) => (await get(`/v1/resource-domains/${id}`, admin)).body as { reserved: { cpu: number }; reservations: number };
  function rows(sql: string): Body[] {
    const db = new DatabaseSync(statePath);
    try { return db.prepare(sql).all().map(row => ({ ...row })) as Body[]; } finally { db.close(); }
  }
  /** Seeds rows directly in one transaction; used where the HTTP path would take minutes. */
  function seed(work: (db: DatabaseSync) => void): void {
    const db = new DatabaseSync(statePath, { timeout: 15000 });
    try { db.exec("BEGIN IMMEDIATE"); work(db); db.exec("COMMIT"); } finally { db.close(); }
  }
  assert.equal((await post("/v1/model-catalog", { model: MODEL, digest: DIGEST, adapter: "ollama", resources: JOB_RESOURCES }, admin)).status, 200);
  return {
    admin, controllerId, start, port, post, get, application, enroll, domain, approve, grant, submission, receipt, success, claim, report, inspectDomain, rows, seed,
    async restart() { await primary.kill(); primary = await start(); },
  };
}

test("controller config is explicit: loopback plain HTTP only, absolute paths, exact fields", () => {
  const base = { statePath: "/s/state.sqlite", adminTokenFile: "/s/admin.token", controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } };
  assert.equal(parseControllerConfig(base).listen.host, "127.0.0.1");
  for (const bad of [{ ...base, listen: { host: "0.0.0.0", port: 0 } }, { ...base, statePath: "state.sqlite" }, { ...base, extra: 1 },
    { ...base, controllerId: "x" }, { ...base, listen: { host: "localhost", port: 0 } }]) assert.throws(() => parseControllerConfig(bad));
  assert.equal(parseControllerConfig({ ...base, listen: { host: "0.0.0.0", port: 8443 }, tls: { certFile: "/c.pem", keyFile: "/k.pem" } }).tls?.certFile, "/c.pem");
});

test("catalog binds adapters and claims filter incompatible backends before reservation", async t => {
  const f = await fixture(t), app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain(JOB_RESOURCES), runner = await f.enroll();
  await f.approve(runner, domain);
  const wrong = f.submission(app.id); wrong.message.adapter = "llama.cpp";
  assert.equal((await f.post("/v1/model-jobs", wrong, app.credential)).status, 409);
  const job = f.submission(app.id);
  assert.equal((await f.post("/v1/model-jobs", job, app.credential)).status, 201);
  const claimId = randomUUID();
  assert.equal((await f.post("/v1/runners/model-jobs/claim", { binding: runner.binding, claimId, adapter: "llama.cpp" }, runner.credential)).body.assignment, null);
  assert.equal((await f.inspectDomain(domain)).reservations, 0);
  assert.equal((await f.claim(runner, claimId)).status, 200);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  assert.equal((await f.post("/v1/runners/model-jobs/claim", { binding: runner.binding, claimId, adapter: "llama.cpp" }, runner.credential)).status, 409);
  for (const adapter of ["llama.cpp", "vllm", "mlx"]) {
    const model = `fixture-${adapter.replace(".", "-")}:1`;
    assert.equal((await f.post("/v1/model-catalog", { model, digest: DIGEST, adapter, resources: JOB_RESOURCES }, f.admin)).status, 200);
    assert.equal((await f.post("/v1/model-grants", { applicationId: app.id, model, digest: DIGEST, maxUnfinished: 1 }, f.admin)).status, 200);
    const submission = f.submission(app.id); submission.message.adapter = adapter; submission.message.model = model;
    assert.equal((await f.post("/v1/model-jobs", submission, app.credential)).status, 201);
  }
});

test("two runners on one physical domain contend transactionally across independent controller processes", async t => {
  const f = await fixture(t), second = await f.start();
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 6, memoryMiB: 12288, diskGiB: 30 });
  const runners = [await f.enroll(), await f.enroll()];
  for (const runner of runners) await f.approve(runner, domain);
  const jobs = [f.submission(app.id), f.submission(app.id)];
  const submitted = await Promise.all(jobs.map((job, i) => f.post("/v1/model-jobs", job, app.credential, i ? second.port : f.port())));
  assert.deepEqual(submitted.map(r => r.status), [201, 201]);
  // Eight independent claims, split across both runners and both controller processes; one job fits.
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => f.claim(runners[i % 2]!, randomUUID(), i % 4 < 2 ? f.port() : second.port)));
  assert.ok(claims.every(r => r.status === 200));
  const won = claims.filter(r => r.body.assignment !== null);
  assert.equal(won.length, 1);
  assert.deepEqual((await f.inspectDomain(domain)).reservations, 1);
  const winner = runners[claims.indexOf(won[0]!) % 2]!, loser = runners.find(r => r !== winner)!;
  const assignment = won[0]!.body.assignment as { id: string; job: { id: string; applicationId: string; message: Body } };
  assert.equal(assignment.job.message.prompt, "Summarize the fixture.");
  const first = assignment.job;
  const waiting = (await f.get(`/v1/model-jobs/${jobs.find(j => j.id !== first.id)!.id}`, app.credential)).body;
  assert.equal(waiting.state, "waitingForResources");
  assert.equal(waiting.reservationHeld, false);

  assert.equal((await f.report(winner, assignment.id, 1, f.receipt(first, "running"))).status, 200);
  // A successful result alone is not stop or cleanup evidence.
  const done = await f.report(winner, assignment.id, 2, f.receipt(first, "succeeded", { result: f.success }), second.port);
  assert.deepEqual([done.body.state, done.body.released], ["succeeded", false]);
  assert.equal((await f.claim(loser)).body.assignment, null);
  const stopped = await f.report(winner, assignment.id, 3, f.receipt(first, "succeeded", { result: f.success, stopped: true }));
  assert.equal(stopped.body.released, false);
  assert.equal((await f.inspectDomain(domain)).reserved.cpu, 4);
  const cleaned = await f.report(winner, assignment.id, 4, f.receipt(first, "succeeded", { result: f.success, stopped: true, cleanup: "complete" }));
  assert.equal(cleaned.body.released, true);
  assert.deepEqual((await f.inspectDomain(domain)).reservations, 0);
  const view = (await f.get(`/v1/model-jobs/${first.id}`, app.credential)).body;
  assert.deepEqual([view.state, view.stopped, view.cleanup, view.assignment, view.result], ["succeeded", true, "complete", "released", f.success]);
  const next = await f.claim(loser, randomUUID(), second.port);
  assert.notEqual(next.body.assignment, null);
  assert.deepEqual(f.rows("SELECT id,credential FROM hosts"), [{ id: "legacy-host", credential: "legacy-hash" }]);
  assert.deepEqual(f.rows("SELECT id,state FROM inference_jobs"), [{ id: "legacy-job", state: "unknown" }]);
});

test("lost submit, claim and report replies replay exactly across a controller crash", async t => {
  const f = await fixture(t), proxy = await lossyProxy(f.port);
  t.after(proxy.close);
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 8, memoryMiB: 16384, diskGiB: 40 });
  const runner = await f.enroll();
  await f.approve(runner, domain);
  const job = f.submission(app.id);
  await assert.rejects(f.post("/v1/model-jobs", job, app.credential, proxy.port));
  assert.equal(proxy.forwarded, 1);
  const reordered = { message: { ...job.message }, id: job.id, applicationId: app.id, version: 1 };
  const replay = await f.post("/v1/model-jobs", reordered, app.credential);
  assert.deepEqual([replay.status, replay.body.created], [200, false]);
  const changed = await f.post("/v1/model-jobs", f.submission(app.id, job.id, "A different prompt."), app.credential);
  assert.equal(changed.status, 409);
  assert.equal(f.rows("SELECT count(*) AS n FROM model_jobs")[0]!.n, 1);

  const claimId = randomUUID();
  await assert.rejects(f.claim(runner, claimId, proxy.port));
  await f.restart();
  const recovered = await f.claim(runner, claimId);
  const assignment = recovered.body.assignment as { id: string; claimId: string };
  assert.equal(assignment.claimId, claimId);
  assert.equal((await f.claim(runner)).body.assignment, null);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  const listed = await f.post("/v1/runners/model-jobs/assignments", { binding: runner.binding }, runner.credential);
  assert.deepEqual((listed.body.assignments as Array<{ id: string }>).map(a => a.id), [assignment.id]);

  const running = f.receipt(job, "running");
  await assert.rejects(f.report(runner, assignment.id, 1, running, proxy.port));
  await f.restart();
  const replayed = await f.report(runner, assignment.id, 1, { message: { ...running.message }, id: job.id, applicationId: app.id, version: 1 });
  assert.deepEqual([replayed.status, replayed.body.sequence, replayed.body.state], [200, 1, "running"]);
  assert.equal((await f.report(runner, assignment.id, 1, f.receipt(job, "unknown"))).status, 409);
  assert.equal((await f.report(runner, assignment.id, 3, f.receipt(job, "running"))).status, 409);
  const final = f.receipt(job, "failed", { stopped: true, cleanup: "complete" });
  await assert.rejects(f.report(runner, assignment.id, 2, final, proxy.port));
  await f.restart();
  assert.equal((await f.inspectDomain(domain)).reservations, 0);
  assert.equal((await f.report(runner, assignment.id, 2, final)).body.released, true);
  assert.equal((await f.report(runner, assignment.id, 3, final)).status, 409);
  assert.equal(f.rows("SELECT count(*) AS n FROM model_assignments")[0]!.n, 1);
});

test("cancellation and unknown outcomes retain reservations until bound positive stop and cleanup", async t => {
  const f = await fixture(t);
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 8, memoryMiB: 16384, diskGiB: 40 });
  const runners = [await f.enroll(), await f.enroll()];
  for (const runner of runners) await f.approve(runner, domain);
  const [r1, r2] = runners as [Runner, Runner];
  const cancel = (job: { id: string }) => f.post(`/v1/model-jobs/${job.id}/cancel`, { version: 1, applicationId: app.id, id: job.id, message: { type: "cancel" } }, app.credential);

  const unclaimed = f.submission(app.id);
  await f.post("/v1/model-jobs", unclaimed, app.credential);
  const cancelled = await cancel(unclaimed);
  assert.deepEqual([cancelled.body.state, cancelled.body.stopped, cancelled.body.cleanup], ["cancelled", true, "complete"]);
  assert.equal((await f.claim(r1)).body.assignment, null);

  const active = f.submission(app.id);
  await f.post("/v1/model-jobs", active, app.credential);
  const a = (await f.claim(r1)).body.assignment as { id: string };
  assert.equal((await f.report(r1, a.id, 1, f.receipt(active, "running", { cancelRequested: true }))).status, 409);
  const requested = await cancel(active);
  assert.deepEqual([requested.body.state, requested.body.cancelRequested, requested.body.reservationHeld], ["queued", true, true]);
  assert.deepEqual(((await cancel(active)).body as Body).cancelRequested, true);
  const delivered = await f.post("/v1/runners/model-jobs/assignments", { binding: r1.binding }, r1.credential);
  assert.equal((delivered.body.assignments as Array<{ cancelRequested: boolean }>)[0]!.cancelRequested, true);
  const pending = await f.report(r1, a.id, 1, f.receipt(active, "cancelled", { cancelRequested: true, stopped: true }));
  assert.deepEqual([pending.body.state, pending.body.released], ["cancelled", false]);
  assert.equal((await f.report(r1, a.id, 2, f.receipt(active, "failed", { stopped: true, cleanup: "complete" }))).status, 409);
  assert.equal((await f.report(r1, a.id, 2, f.receipt(active, "cancelled", { cancelRequested: true, stopped: true, cleanup: "complete" }))).body.released, true);

  const uncertain = f.submission(app.id);
  await f.post("/v1/model-jobs", uncertain, app.credential);
  const u = (await f.claim(r1)).body.assignment as { id: string };
  await f.report(r1, u.id, 1, f.receipt(uncertain, "running"));
  assert.equal((await f.report(r1, u.id, 2, f.receipt(uncertain, "unknown"))).body.state, "unknown");
  assert.equal((await f.report(r1, u.id, 3, f.receipt(uncertain, "running"))).status, 409);
  assert.equal((await f.report(r1, u.id, 3, f.receipt(uncertain, "succeeded", { result: { ...f.success, model: "other-model:1" }, stopped: true, cleanup: "complete" }))).status, 409);
  await f.restart();
  assert.equal((await f.claim(r2)).body.assignment, null);
  const held = (await f.get(`/v1/model-jobs/${uncertain.id}`, app.credential)).body;
  assert.deepEqual([held.state, held.reservationHeld, held.assignment], ["unknown", true, "current"]);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  // Only positive evidence from the bound runner reconciles the uncertain job.
  assert.equal((await f.report(r2, u.id, 3, f.receipt(uncertain, "failed", { stopped: true, cleanup: "complete" }))).status, 403);
  assert.equal((await f.report(r1, u.id, 3, f.receipt(uncertain, "failed", { stopped: true, cleanup: "complete" }))).body.released, true);
  assert.equal((await f.inspectDomain(domain)).reservations, 0);
});

test("cross-application, cross-runner, role and stale-generation authority are denied", async t => {
  const f = await fixture(t);
  const [a, b] = [await f.application(), await f.application()];
  await f.grant(a.id, 2);
  const domain = await f.domain({ cpu: 8, memoryMiB: 16384, diskGiB: 40 });
  const [r1, r2, unapproved] = [await f.enroll(), await f.enroll(), await f.enroll()];
  await f.approve(r1, domain); await f.approve(r2, domain);
  const job = f.submission(a.id);
  assert.equal((await f.post("/v1/model-jobs", f.submission(b.id), b.credential)).status, 403);
  const unlisted = f.submission(b.id);
  unlisted.message.model = "unlisted-model:1";
  assert.equal((await f.post("/v1/model-jobs", unlisted, b.credential)).status, 403);
  assert.equal((await f.post("/v1/model-jobs", job, b.credential)).status, 403);
  assert.equal((await f.post("/v1/model-jobs", job, f.admin)).status, 401);
  assert.equal((await f.post("/v1/model-jobs", job, a.credential)).status, 201);
  assert.equal((await f.get(`/v1/model-jobs/${job.id}`, b.credential)).status, 404);
  assert.equal((await f.post(`/v1/model-jobs/${job.id}/cancel`, { version: 1, applicationId: b.id, id: job.id, message: { type: "cancel" } }, b.credential)).status, 404);
  assert.equal((await f.post(`/v1/model-jobs/${job.id}/cancel`, { version: 1, applicationId: a.id, id: job.id, message: { type: "cancel" } }, b.credential)).status, 403);
  await f.post("/v1/model-jobs", f.submission(a.id), a.credential);
  assert.equal((await f.post("/v1/model-jobs", f.submission(a.id), a.credential)).status, 429);

  assert.equal((await f.claim({ ...r1, credential: a.credential })).status, 401);
  assert.equal((await f.claim({ ...r1, credential: r2.credential })).status, 401);
  assert.equal((await f.claim(unapproved)).status, 403);
  assert.equal((await f.post("/v1/model-catalog", { model: "x:1", digest: DIGEST, adapter: "ollama", resources: JOB_RESOURCES }, r1.credential)).status, 401);
  assert.equal((await f.post("/v1/model-grants", { applicationId: b.id, model: MODEL, digest: DIGEST, maxUnfinished: 1 }, a.credential)).status, 401);
  const claimId = randomUUID();
  const assignment = (await f.claim(r1, claimId)).body.assignment as { id: string };
  assert.equal((await f.claim(r2, claimId)).status, 409);
  assert.equal((await f.report(r2, assignment.id, 1, f.receipt(job, "running"))).status, 403);
  assert.equal((await f.post("/v1/runners/model-jobs/assignments", { binding: r2.binding }, r2.credential)).body.assignments instanceof Array, true);
  assert.deepEqual((await f.post("/v1/runners/model-jobs/assignments", { binding: r2.binding }, r2.credential)).body.assignments, []);

  // Revoke and reenroll r1: the old generation loses authority; the new one inherits none.
  assert.equal((await f.post("/v1/runners/revoke", r1.binding, f.admin)).status, 200);
  assert.equal((await f.report(r1, assignment.id, 1, f.receipt(job, "running"))).status, 401);
  assert.equal((await f.post("/v1/model-runner-approvals", { binding: r1.binding, domainId: domain, models: [{ model: MODEL, digest: DIGEST }] }, f.admin)).status, 409);
  const r1next = await f.enroll(r1.binding.runnerId, 2);
  assert.equal((await f.report(r1next, assignment.id, 1, f.receipt(job, "running"))).status, 403);
  assert.equal((await f.claim(r1next)).status, 403);
  const stale = (await f.get(`/v1/model-jobs/${job.id}`, a.credential)).body;
  assert.deepEqual([stale.state, stale.assignment, stale.reservationHeld], ["unknown", "revoked", true]);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  assert.equal((await f.post("/v1/model-runner-approvals", { binding: { ...r1.binding, generation: 3, incarnationId: randomUUID() }, domainId: domain, models: [{ model: MODEL, digest: DIGEST }] }, f.admin)).status, 409);
  assert.equal((await f.post("/v1/model-runner-approvals/revoke", { binding: r2.binding }, f.admin)).status, 200);
  assert.equal((await f.claim(r2)).status, 403);
  assert.equal((await f.post("/v1/resource-domains", { id: domain, name: "shared physical host", capacity: { cpu: 99, memoryMiB: 16384, diskGiB: 40 } }, f.admin)).status, 409);
  assert.equal((await f.post("/v1/model-grants/revoke", { applicationId: a.id, model: MODEL, digest: DIGEST }, f.admin)).status, 200);
  await f.post(`/v1/model-jobs/${job.id}/cancel`, { version: 1, applicationId: a.id, id: job.id, message: { type: "cancel" } }, a.credential);
  assert.equal((await f.post("/v1/model-jobs", f.submission(a.id), a.credential)).status, 403);
});

// Queued model calls: /v1/requests kind "model-job", admitted by a runner claim on the shared ledger.

type Queued = { id: string; kind: "model-job"; intent: Body; priority?: number; deadline?: string; source?: Body };
const intent = (prompt = "Summarize the fixture.") => ({ adapter: "ollama", model: MODEL, digest: DIGEST, prompt, maxTokens: 64 });
const queued = (extra: Partial<Queued> = {}): Queued => ({ id: randomUUID(), kind: "model-job", intent: intent(), ...extra });
async function modelQueue(t: { after: (fn: () => Promise<void>) => void }, capacity = JOB_RESOURCES) {
  const f = await fixture(t), domain = await f.domain(capacity), runner = await f.enroll();
  await f.approve(runner, domain);
  const app = async (limits: Body = {}, maxUnfinished = 8) => { const a = await f.application(limits); await f.grant(a.id, maxUnfinished); return a; };
  const submit = (request: Queued, credential: string, via?: number) => f.post("/v1/requests", request, credential, via);
  const request = async (id: string, credential: string) => (await f.get(`/v1/requests/${id}`, credential)).body;
  const job = async (id: string, credential: string) => (await f.get(`/v1/model-jobs/${id}`, credential)).body;
  /** Claims once and returns the admitted job UUID, or null. */
  const admit = async () => {
    const reply = await f.claim(runner);
    assert.equal(reply.status, 200);
    const assignment = reply.body.assignment as { id: string; job: { id: string; applicationId: string } } | null;
    return assignment ? { assignment: assignment.id, id: assignment.job.id, applicationId: assignment.job.applicationId } : null;
  };
  const finish = async (admitted: { assignment: string; id: string; applicationId: string }, sequence = 1) => {
    const done = await f.report(runner, admitted.assignment, sequence, f.receipt(admitted, "failed", { stopped: true, cleanup: "complete" }));
    assert.equal(done.body.released, true);
  };
  return { ...f, domain, runner, app, submit, request, job, admit, finish };
}

test("model calls wait when full, are admitted when capacity frees and never displace running work", async t => {
  const q = await modelQueue(t), a = await q.app({ maxRequestPriority: 10 });
  const first = queued(), second = queued(), urgent = queued({ priority: 10 });
  const created = await q.submit(first, a.credential);
  assert.deepEqual([created.status, created.body.state, created.body.kind, created.body.target], [201, "waiting", "model-job", null]);
  assert.deepEqual(created.body.resources, JOB_RESOURCES);
  // The job exists at submission without a reservation.
  const before = await q.job(first.id, a.credential);
  assert.deepEqual([before.state, before.assignment, before.reservationHeld, (before.request as Body).state], ["queued", "none", false, "waiting"]);
  assert.equal((await q.submit(second, a.credential)).status, 201);
  const running = (await q.admit())!;
  assert.equal(running.id, first.id);
  const admitted = await q.request(first.id, a.credential);
  assert.deepEqual([admitted.state, admitted.target, typeof admitted.admittedAt], ["admitted", first.id, "string"]);
  assert.equal((await q.report(q.runner, running.assignment, 1, q.receipt(running, "running"))).status, 200);

  // Higher priority only orders admission: it neither preempts nor shrinks the running job's reservation.
  assert.equal((await q.submit(urgent, a.credential)).status, 201);
  assert.equal(await q.admit(), null);
  const domain = await q.inspectDomain(q.domain);
  assert.deepEqual([domain.reservations, domain.reserved.cpu], [1, JOB_RESOURCES.cpu]);
  const still = await q.job(first.id, a.credential);
  assert.deepEqual([still.state, still.reservationHeld, still.cancelRequested], ["running", true, false]);
  const blocked = await q.job(urgent.id, a.credential);
  assert.deepEqual([blocked.state, (blocked.request as Body).reason], ["waitingForResources", "capacity_unavailable"]);
  assert.deepEqual(q.rows("SELECT count(*) AS n FROM model_assignments"), [{ n: 1 }]);

  await q.finish(running, 2);
  const next = (await q.admit())!;
  assert.equal(next.id, urgent.id);
  assert.equal((await q.request(urgent.id, a.credential)).state, "admitted");
  assert.equal((await q.request(second.id, a.credential)).state, "waiting");
});

test("model calls follow request priority, FIFO and include direct submissions at priority 0", async t => {
  const q = await modelQueue(t, { cpu: 64, memoryMiB: 131072, diskGiB: 400 }), a = await q.app({ maxRequestPriority: 10 });
  const direct = q.submission(a.id);
  assert.equal((await q.post("/v1/model-jobs", direct, a.credential)).status, 201);
  const low = queued({ priority: -5 }), plain = queued(), high = queued({ priority: 5 }), highLater = queued({ priority: 5 });
  for (const r of [low, plain, high, highLater]) assert.equal((await q.submit(r, a.credential)).status, 201);
  assert.equal((await q.submit(queued({ priority: 11 }), a.credential)).status, 400);
  const order: string[] = [];
  for (let i = 0; i < 5; i++) order.push((await q.admit())!.id);
  assert.deepEqual(order, [high.id, highLater.id, direct.id, plain.id, low.id]);
  // Direct submissions keep their API: no request record is listed for them.
  const listed = (await q.get("/v1/requests", a.credential)).body.requests as Body[];
  assert.deepEqual(listed.map(r => r.id).sort(), [low.id, plain.id, high.id, highLater.id].sort());
  assert.equal((await q.job(direct.id, a.credential)).request, undefined);
});

test("model calls are fair per application and bounded by grant, waiting and priority limits", async t => {
  const q = await modelQueue(t, { cpu: 64, memoryMiB: 131072, diskGiB: 400 });
  const busy = await q.app(), quiet = await q.app(), limited = await q.app({ maxWaitingRequests: 2 }, 1);
  const busyIds: string[] = [];
  for (let i = 0; i < 3; i++) { const r = queued(); busyIds.push(r.id); await q.submit(r, busy.credential); }
  const quietRequest = queued(); await q.submit(quietRequest, quiet.credential);
  const first = await q.admit(), second = await q.admit();
  // A busy application cannot monopolize admission: the other application takes the next turn.
  assert.deepEqual(new Set([first!.applicationId, second!.applicationId]), new Set([busy.id, quiet.id]));
  assert.equal([first, second].find(x => x!.applicationId === busy.id)!.id, busyIds[0]);

  // Grant maxUnfinished bounds admitted work; excess waits instead of failing, and does not block others.
  const held = queued(), over = queued();
  assert.equal((await q.submit(held, limited.credential)).status, 201);
  assert.equal((await q.submit(over, limited.credential)).status, 201);
  const waitingCap = await q.submit(queued(), limited.credential);
  assert.deepEqual([waitingCap.status, waitingCap.body.code], [429, "request_waiting_limit"]);
  const admitted: string[] = [];
  for (let i = 0; i < 4; i++) admitted.push((await q.admit())?.id ?? "none");
  assert.ok(admitted.includes(held.id));
  assert.ok(!admitted.includes(over.id));
  assert.ok(busyIds.slice(1).every(id => admitted.includes(id)));
  const limitedView = await q.request(over.id, limited.credential);
  assert.deepEqual([limitedView.state, limitedView.reason], ["waiting", "model_job_limit"]);
  // Direct submission keeps its unfinished-job 429 contract.
  assert.equal((await q.post("/v1/model-jobs", q.submission(limited.id), limited.credential)).status, 429);
});

test("waiting model calls expire at their deadline and cancel without execution", async t => {
  const q = await modelQueue(t), a = await q.app();
  const blocker = queued(); await q.submit(blocker, a.credential);
  const running = (await q.admit())!;
  const soon = queued({ deadline: new Date(Date.now() + 1500).toISOString() });
  const viaRequest = queued(), viaJob = queued(), viaAdmin = queued();
  for (const r of [soon, viaRequest, viaJob, viaAdmin]) assert.equal((await q.submit(r, a.credential)).status, 201);

  const cancelled = await q.post(`/v1/requests/${viaRequest.id}/cancel`, {}, a.credential);
  assert.deepEqual([cancelled.body.state, cancelled.body.reason], ["cancelled", "consumer_cancelled"]);
  const closed = await q.job(viaRequest.id, a.credential);
  assert.deepEqual([closed.state, closed.cancelRequested, closed.stopped, closed.cleanup, closed.assignment, closed.reservationHeld], ["cancelled", true, true, "complete", "none", false]);
  const jobCancel = await q.post(`/v1/model-jobs/${viaJob.id}/cancel`, { version: 1, applicationId: a.id, id: viaJob.id, message: { type: "cancel" } }, a.credential);
  assert.deepEqual([jobCancel.body.state, (jobCancel.body.request as Body).state], ["cancelled", "cancelled"]);
  const queue = (await q.get("/v1/admin/model-jobs", q.admin)).body.jobs as Body[];
  // Open jobs list oldest first, so long-waiting work stays visible.
  assert.deepEqual(queue.filter(j => !["cancelled", "failed", "succeeded"].includes(String(j.state))).map(j => j.id),
    [blocker.id, soon.id, viaAdmin.id]);
  const listed = queue.find(j => j.id === viaAdmin.id)!;
  assert.deepEqual([listed.applicationId, listed.state, listed.assigned, (listed.request as Body).state], [a.id, "queued", false, "waiting"]);
  assert.equal(JSON.stringify(queue).includes("Summarize"), false);
  const adminCancel = await q.post(`/v1/admin/jobs/${viaAdmin.id}/cancel`, { id: randomUUID(), applicationId: a.id }, q.admin);
  assert.deepEqual([adminCancel.status, adminCancel.body.state], [200, "cancelled"]);
  assert.equal((await q.request(viaAdmin.id, a.credential)).reason, "administrator_cancelled");

  await new Promise(resolve => setTimeout(resolve, 1700));
  const expired = await q.request(soon.id, a.credential);
  assert.deepEqual([expired.state, expired.reason, expired.target], ["expired", "deadline", null]);
  const expiredJob = await q.job(soon.id, a.credential);
  assert.deepEqual([expiredJob.state, expiredJob.cancelRequested, expiredJob.reservationHeld, expiredJob.assignment], ["failed", false, false, "none"]);
  // Cancelling admitted work keeps the request admitted and the reservation held until the runner confirms.
  const admittedCancel = await q.post(`/v1/requests/${blocker.id}/cancel`, {}, a.credential);
  assert.equal(admittedCancel.body.state, "admitted");
  const requested = await q.job(blocker.id, a.credential);
  assert.deepEqual([requested.cancelRequested, requested.reservationHeld], [true, true]);
  assert.equal((await q.post(`/v1/requests/${blocker.id}/cancel`, {}, a.credential)).body.state, "admitted");
  await q.report(q.runner, running.assignment, 1, q.receipt(running, "cancelled", { cancelRequested: true, stopped: true, cleanup: "complete" }));
  assert.equal(await q.admit(), null);
  assert.deepEqual(q.rows("SELECT count(*) AS n FROM model_assignments"), [{ n: 1 }]);
});

test("model-call replay is exact, changed intent conflicts and lost responses recover", async t => {
  const q = await modelQueue(t), proxy = await lossyProxy(q.port), a = await q.app({ maxRequestPriority: 3 });
  t.after(proxy.close);
  const request = queued({ priority: 2, source: { repository: "team/project", run: "7" } });
  await assert.rejects(q.submit(request, a.credential, proxy.port));
  assert.equal(proxy.forwarded, 1);
  const reordered = { source: { run: "7", repository: "team/project" }, priority: 2, intent: { maxTokens: 64, prompt: "Summarize the fixture.", digest: DIGEST, model: MODEL, adapter: "ollama" }, kind: "model-job", id: request.id };
  const replay = await q.submit(reordered as Queued, a.credential);
  assert.deepEqual([replay.status, replay.body.state, replay.body.sequence], [200, "waiting", 1]);
  // The request stores and returns only the prompt digest; the job keeps the prompt for the runner.
  const promptDigest = "sha256:" + createHash("sha256").update("Summarize the fixture.").digest("hex");
  assert.deepEqual(replay.body.intent, { adapter: "ollama", model: MODEL, digest: DIGEST, promptDigest, maxTokens: 64 });
  for (const echoed of [replay.body, await q.request(request.id, a.credential), (await q.get("/v1/requests", a.credential)).body]) assert.equal(JSON.stringify(echoed).includes("Summarize"), false);
  assert.deepEqual(q.rows(`SELECT count(*) AS n FROM requests WHERE intent LIKE '%Summarize%'`), [{ n: 0 }]);
  for (const changed of [{ ...request, intent: intent("Another prompt.") }, { ...request, priority: 1 }, { ...request, source: { run: "8" } },
    { ...request, deadline: new Date(Date.now() + 60_000).toISOString() }]) {
    const conflict = await q.submit(changed, a.credential);
    assert.deepEqual([conflict.status, conflict.body.code], [409, "request_conflict"]);
  }
  // The queued intent owns its UUID on the direct path too: an identical submission replays, a change conflicts.
  const asJob = q.submission(a.id, request.id);
  assert.deepEqual([(await q.post("/v1/model-jobs", asJob, a.credential)).status], [200]);
  assert.equal((await q.post("/v1/model-jobs", q.submission(a.id, request.id, "Different."), a.credential)).status, 409);
  const direct = q.submission(a.id);
  await q.post("/v1/model-jobs", direct, a.credential);
  assert.equal((await q.submit(queued({ id: direct.id }), a.credential)).body.code, "request_conflict");
  // Malformed intent and a missing grant are refused without consuming the UUID.
  const malformed = queued(); (malformed.intent as Body).extra = 1;
  assert.equal((await q.submit(malformed, a.credential)).status, 400);
  const ungranted = await q.app(); await q.post("/v1/model-grants/revoke", { applicationId: ungranted.id, model: MODEL, digest: DIGEST }, q.admin);
  assert.equal((await q.submit(queued({ id: malformed.id }), ungranted.credential)).status, 403);
  assert.equal((await q.submit(queued({ id: malformed.id }), a.credential)).status, 201);
  assert.deepEqual(q.rows(`SELECT count(*) AS n FROM requests WHERE id='${request.id}'`), [{ n: 1 }]);
  assert.deepEqual(q.rows(`SELECT count(*) AS n FROM model_jobs WHERE id='${request.id}'`), [{ n: 1 }]);
  // Another application cannot see or claim the UUID.
  const other = await q.app();
  assert.equal((await q.submit({ ...request, priority: 0 }, other.credential)).status, 404);
  assert.equal((await q.get(`/v1/requests/${request.id}`, other.credential)).status, 404);
});

test("waiting model calls, their order and deadlines survive a controller restart", async t => {
  const q = await modelQueue(t), a = await q.app({ maxRequestPriority: 5 });
  const blocker = queued(); await q.submit(blocker, a.credential);
  const running = (await q.admit())!;
  const low = queued(), high = queued({ priority: 5 }), bounded = queued({ deadline: new Date(Date.now() + 60_000).toISOString() });
  for (const r of [low, high, bounded]) await q.submit(r, a.credential);
  assert.equal(await q.admit(), null);
  await q.restart();
  for (const r of [low, high, bounded]) assert.equal((await q.request(r.id, a.credential)).state, "waiting");
  assert.equal((await q.request(bounded.id, a.credential)).deadline, bounded.deadline);
  assert.equal((await q.job(running.id, a.credential)).reservationHeld, true);
  await q.finish(running);
  const next = (await q.admit())!;
  assert.equal(next.id, high.id);
  await q.restart();
  await q.finish(next);
  assert.equal((await q.admit())!.id, low.id);
});

test("revoked grants reject waiting model calls and revoked applications cancel them", async t => {
  const q = await modelQueue(t), a = await q.app(), b = await q.app();
  const blocker = queued(); await q.submit(blocker, a.credential);
  await q.admit();
  const ungranted = queued(), revoked = queued();
  await q.submit(ungranted, a.credential); await q.submit(revoked, b.credential);
  assert.equal((await q.post("/v1/model-grants/revoke", { applicationId: a.id, model: MODEL, digest: DIGEST }, q.admin)).status, 200);
  const rejected = await q.request(ungranted.id, a.credential);
  assert.deepEqual([rejected.state, rejected.reason], ["rejected", "model_grant_revoked"]);
  const failed = await q.job(ungranted.id, a.credential);
  assert.deepEqual([failed.state, failed.reservationHeld, failed.assignment], ["failed", false, "none"]);
  // Admitted work keeps its reservation and report authority after the grant is revoked.
  assert.deepEqual([(await q.request(blocker.id, a.credential)).state, (await q.job(blocker.id, a.credential)).reservationHeld], ["admitted", true]);
  assert.equal((await q.post(`/v1/consumers/${b.id}/revoke`, {}, q.admin)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual(q.rows(`SELECT state,reason FROM requests WHERE id='${revoked.id}'`), [{ state: "cancelled", reason: "application_revoked" }]);
  assert.deepEqual(q.rows(`SELECT state,closed FROM model_jobs WHERE id='${revoked.id}'`), [{ state: "cancelled", closed: 1 }]);
});

test("the consumer SDK submits, lists, inspects and cancels queued model calls", async t => {
  const q = await modelQueue(t), a = await q.app();
  const client = new ConsumerClient({ baseUrl: `http://127.0.0.1:${q.port()}`, applicationKey: a.credential, allowLoopbackHttp: true });
  const id = randomUUID(), input = { id, kind: "model-job" as const, intent: { adapter: "ollama" as const, model: MODEL, digest: DIGEST, prompt: "SDK prompt.", maxTokens: 32 } };
  const first = await client.submitRequest(input);
  assert.deepEqual([first.created, first.request.kind, first.request.state], [true, "model-job", "waiting"]);
  assert.equal((await client.submitRequest(input)).created, false);
  assert.deepEqual((await client.listRequests()).requests.map(r => r.id), [id]);
  assert.equal((await client.cancelRequest(id)).state, "cancelled");
  assert.equal((await client.inspectRequest(id)).reason, "consumer_cancelled");
  await assert.rejects(client.submitRequest({ ...input, id: randomUUID(), intent: { ...input.intent, extra: 1 } as typeof input.intent }));
});

// Fairness and eligibility across runners serving different models.

const OTHER_MODEL = "fixture-other:1", WIDE = { cpu: 64, memoryMiB: 131072, diskGiB: 400 };
/** Fixed application UUIDs make the round-robin order deterministic (first < second < third). */
const ORDERED = ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003"];
async function twoModels(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture(t);
  assert.equal((await f.post("/v1/model-catalog", { model: OTHER_MODEL, digest: DIGEST, adapter: "ollama", resources: JOB_RESOURCES }, f.admin)).status, 200);
  const grantOther = async (applicationId: string) =>
    assert.equal((await f.post("/v1/model-grants", { applicationId, model: OTHER_MODEL, digest: DIGEST, maxUnfinished: 8 }, f.admin)).status, 200);
  const approveOther = async (runner: Runner) => assert.equal((await f.post("/v1/model-runner-approvals",
    { binding: runner.binding, domainId: await f.domain(WIDE), models: [{ model: OTHER_MODEL, digest: DIGEST }] }, f.admin)).status, 200);
  const other = (applicationId: string, id: string = randomUUID()) => {
    const s = f.submission(applicationId, id); s.message.model = OTHER_MODEL; return s;
  };
  const claimed = async (runner: Runner) => {
    const reply = await f.claim(runner);
    assert.equal(reply.status, 200);
    return (reply.body.assignment as { job: { applicationId: string; id: string } } | null)?.job ?? null;
  };
  return { ...f, grantOther, approveOther, other, claimed };
}

test("each runner keeps its own application turn, so admissions elsewhere cannot starve an application", async t => {
  const f = await twoModels(t);
  const a = await f.application({}, ORDERED[0]), b = await f.application({}, ORDERED[1]), c = await f.application({}, ORDERED[2]);
  await f.grant(a.id); await f.grant(b.id); await f.grantOther(c.id);
  const r1 = await f.enroll(), r2 = await f.enroll();
  await f.approve(r1, await f.domain(WIDE)); await f.approveOther(r2);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.post("/v1/model-jobs", f.submission(a.id), a.credential)).status, 201);
    assert.equal((await f.post("/v1/model-jobs", f.other(c.id), c.credential)).status, 201);
  }
  assert.equal((await f.post("/v1/model-jobs", f.submission(b.id), b.credential)).status, 201);
  // Interleaved claims: r2's admissions of c must not reset r1's rotation between a and b.
  const first: string[] = [];
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.claimed(r2))?.applicationId, c.id);
    first.push((await f.claimed(r1))?.applicationId ?? "none");
  }
  assert.deepEqual(first, [a.id, b.id, a.id]);
});

test("claims consider only eligible queue heads, however many unservable jobs wait ahead", async t => {
  const f = await twoModels(t);
  const c = await f.application({}, ORDERED[0]), a = await f.application({}, ORDERED[1]);
  await f.grantOther(c.id); await f.grant(a.id);
  const runner = await f.enroll();
  await f.approve(runner, await f.domain(WIDE));
  // More than 4,096 open jobs for a model this runner does not serve, submitted before the servable one.
  f.seed(db => {
    const insert = db.prepare("INSERT INTO model_jobs VALUES (?,?,?,?,?,'queued',0,0,'pending',NULL,0,?,?)");
    for (let i = 0; i < 4200; i++) {
      const job = f.other(c.id);
      insert.run(c.id, job.id, JSON.stringify(job), OTHER_MODEL, DIGEST, 1, 1);
    }
  });
  const servable = f.submission(a.id);
  assert.equal((await f.post("/v1/model-jobs", servable, a.credential)).status, 201);
  const job = await f.claimed(runner);
  assert.deepEqual([job?.applicationId, job?.id], [a.id, servable.id]);
  assert.deepEqual(f.rows(`SELECT count(*) AS n FROM model_jobs WHERE application='${c.id}' AND closed=0`), [{ n: 4200 }]);
});

test("revoking an application or grant closes its unclaimed direct model jobs without execution", async t => {
  const f = await fixture(t), a = await f.application(), b = await f.application();
  await f.grant(a.id); await f.grant(b.id);
  const runner = await f.enroll();
  await f.approve(runner, await f.domain(WIDE));
  const claimedJob = f.submission(a.id);
  assert.equal((await f.post("/v1/model-jobs", claimedJob, a.credential)).status, 201);
  assert.notEqual((await f.claim(runner)).body.assignment, null);
  const waiting = f.submission(a.id), other = f.submission(b.id);
  for (const [job, app] of [[waiting, a], [other, b]] as const) assert.equal((await f.post("/v1/model-jobs", job, app.credential)).status, 201);

  assert.equal((await f.post("/v1/model-grants/revoke", { applicationId: a.id, model: MODEL, digest: DIGEST }, f.admin)).status, 200);
  const failed = (await f.get(`/v1/model-jobs/${waiting.id}`, a.credential)).body;
  assert.deepEqual([failed.state, failed.cancelRequested, failed.stopped, failed.cleanup, failed.assignment, failed.reservationHeld],
    ["failed", false, true, "complete", "none", false]);
  // Claimed work keeps its reservation and report authority.
  const held = (await f.get(`/v1/model-jobs/${claimedJob.id}`, a.credential)).body;
  assert.deepEqual([held.state, held.assignment, held.reservationHeld], ["queued", "current", true]);

  assert.equal((await f.post(`/v1/consumers/${b.id}/revoke`, {}, f.admin)).status, 200);
  assert.deepEqual(f.rows(`SELECT state,cancel_requested,stopped,cleanup,closed FROM model_jobs WHERE id='${other.id}'`),
    [{ state: "cancelled", cancel_requested: 1, stopped: 1, cleanup: "complete", closed: 1 }]);
  assert.equal((await f.claim(runner)).body.assignment, null);
});
