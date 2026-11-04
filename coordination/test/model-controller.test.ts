import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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

  async function application(): Promise<{ id: string; credential: string }> {
    const id = randomUUID();
    const created = await post("/v1/consumers", { id, name: "fixture", templates: [], limits: { resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 }, activeLeases: 1 } }, admin);
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
  const submission = (applicationId: string, id = randomUUID(), prompt = "Summarize the fixture.") =>
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
  assert.equal((await post("/v1/model-catalog", { model: MODEL, digest: DIGEST, adapter: "ollama", resources: JOB_RESOURCES }, admin)).status, 200);
  return {
    admin, controllerId, start, port, post, get, application, enroll, domain, approve, grant, submission, receipt, success, claim, report, inspectDomain, rows,
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
