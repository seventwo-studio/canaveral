import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConsumerClient, ConsumerServiceError, LeaseClient } from "../src/consumer-client.ts";
import type { AcquireRequest, Lease } from "../src/consumer-client.ts";

type Body = Record<string, unknown>;
type Reply = { status: number; body: Body };
type Binding = { controllerId: string; runnerId: string; generation: number; incarnationId: string };
type Runner = { binding: Binding; credential: string };
type Assignment = { id: string; claimId: string; leaseId: string; memberId: string; sequence: number; closed: boolean; stopRequested: boolean;
  image: { backend: string; digest: string }; lease: { state: string; revision: number; expiresAt: number; controllerNow: number } };
const main = new URL("../src/main.js", import.meta.url).pathname;
const clockModule = new URL("./fixture-clock.js", import.meta.url).pathname;
const key = () => randomBytes(32).toString("base64url");
const T0 = 1_800_000_000;
const DIGEST = "sha256:" + "cd".repeat(32), OTHER_DIGEST = "sha256:" + "ef".repeat(32);
const VM = { cpu: 4, memoryMiB: 8192, diskGiB: 20 };
const IMAGE = { id: "linux-dev", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "appleVirtualization", digest: DIGEST, resources: VM, capabilities: ["command", "files", "pty"] };
const APPLE = { ...IMAGE, id: "linux-dev-apple", arch: "arm64", backend: "appleVirtualization", digest: OTHER_DIGEST };
const MODEL = "fixture-model:1", MODEL_DIGEST = "sha256:" + "ab".repeat(32);

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

/** Forwards a request, lets the controller commit, then drops the whole reply. */
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
  return { port: (server.address() as AddressInfo).port, get forwarded() { return forwarded; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

class Controller {
  constructor(readonly child: ChildProcess, readonly port: number) {}
  static async start(config: string, clockFile: string): Promise<Controller> {
    const child = spawn(process.execPath, ["--import", clockModule, main, config], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CANAVERAL_FIXTURE_CLOCK_FILE: clockFile } });
    let output = "", errors = "";
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout!.on("data", chunk => {
        output += String(chunk);
        if (output.includes("\n")) resolve((JSON.parse(output.split("\n")[0]!) as { listening: { port: number } }).listening.port);
      });
      child.once("exit", code => reject(new Error(`controller exited ${code}: ${errors}`)));
    });
    return new Controller(child, port);
  }
  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGKILL");
    await exited;
  }
}

async function rejectsWith(promise: Promise<unknown>, status: number, code?: string): Promise<ConsumerServiceError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ConsumerServiceError, String(error));
    assert.equal(error.status, status, error.message);
    if (code) assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${status}`);
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-linux-lease-"));
  const statePath = join(dir, "controller.sqlite"), clockFile = join(dir, "clock"), admin = key(), controllerId = randomUUID();
  writeFileSync(join(dir, "admin.token"), admin + "\n", { mode: 0o600 });
  writeFileSync(clockFile, String(T0));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ statePath, adminTokenFile: join(dir, "admin.token"), controllerId, listen: { host: "127.0.0.1", port: 0 } }));
  // Retained Python lease rows that this slice must neither adopt nor alter.
  const legacy = new DatabaseSync(statePath);
  legacy.exec(`CREATE TABLE leases (id TEXT PRIMARY KEY, consumer TEXT, request TEXT, state TEXT, revision INTEGER, created REAL, expires REAL, provision_deadline REAL, credential TEXT, cleanup TEXT);
    INSERT INTO leases VALUES ('legacy-lease','legacy-app','{}','ready',3,1,2,2,'legacy-hash','notRequested');`);
  legacy.close();
  const controllers: Controller[] = [];
  const start = async () => { const c = await Controller.start(config, clockFile); controllers.push(c); return c; };
  t.after(async () => { await Promise.all(controllers.map(c => c.kill())); rmSync(dir, { recursive: true, force: true }); });
  let primary = await start();
  const port = () => primary.port;
  const post = (route: string, body: unknown, token?: string, via = port()) => call(via, "POST", route, body, token);
  const get = (route: string, token?: string, via = port()) => call(via, "GET", route, undefined, token);
  const ok = async (reply: Promise<Reply>) => { const r = await reply; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

  async function application(limits: Body = {}) {
    const id = randomUUID();
    const created = await ok(post("/v1/consumers", { id, name: "fixture", templates: [],
      limits: { resources: { cpu: 64, memoryMiB: 131072, diskGiB: 1000 }, activeLeases: 8, defaultTTLSeconds: 100, maxTTLSeconds: 300, maxLifetimeSeconds: 300, provisioningTimeoutSeconds: 250, ...limits } }, admin));
    const credential = created.credential as string;
    const client = (via = port()) => new ConsumerClient({ baseUrl: `http://127.0.0.1:${via}`, applicationKey: credential, allowLoopbackHttp: true });
    return { id, credential, client };
  }
  async function enroll(runnerId: string = randomUUID(), generation = 1): Promise<Runner> {
    const binding = { controllerId, runnerId, generation, incarnationId: randomUUID() }, id = randomUUID(), credential = key();
    const issued = await ok(post("/v1/runner-enrollments", { id, ...binding, ttlSeconds: 60 }, admin));
    await ok(post("/v1/runner-enrollments/consume", { id, ...binding, credential }, issued.enrollmentToken as string));
    return { binding, credential };
  }
  async function domain(capacity: Body): Promise<string> {
    const id = randomUUID();
    await ok(post("/v1/resource-domains", { id, name: "physical host", capacity }, admin));
    return id;
  }
  const grant = (applicationId: string, image = IMAGE) => ok(post("/v1/linux-lease-grants", { applicationId, imageId: image.id, revision: image.revision, arch: image.arch, digest: image.digest }, admin));
  const approve = (runner: Runner, domainId: string, image = IMAGE) => post("/v1/linux-lease-runner-approvals",
    { binding: runner.binding, domainId, backend: image.backend, images: [{ id: image.id, revision: image.revision, arch: image.arch, digest: image.digest }] }, admin);
  const claim = async (runner: Runner, claimId = randomUUID(), via = port()) => {
    const r = await post("/v1/runners/linux-leases/claim", { binding: runner.binding, claimId }, runner.credential, via);
    return { ...r, assignment: r.body.assignment as Assignment | null };
  };
  const receipt = (a: Assignment, extra: Body = {}) => ({ leaseId: a.leaseId, memberId: a.memberId, backend: a.image.backend, imageDigest: a.image.digest,
    observedRevision: a.lease.revision, runtimeState: "starting", ready: { command: false, pty: false, files: false }, failure: null,
    executionStopped: false, storageRemoved: false, credentialsErased: false, cleanup: "pending", ...extra });
  const report = (runner: Runner, assignmentId: string, sequence: number, value: unknown, via = port()) =>
    post("/v1/runners/linux-leases/report", { binding: runner.binding, assignmentId, sequence, receipt: value }, runner.credential, via);
  const running = { runtimeState: "running", ready: { command: true, pty: true, files: true } };
  const stoppedClean = { runtimeState: "stopped", executionStopped: true, storageRemoved: true, credentialsErased: true, cleanup: "complete" };
  const inspectDomain = async (id: string) => (await ok(get(`/v1/resource-domains/${id}`, admin))) as { reserved: { cpu: number }; reservations: number };
  const acquire = (extra: Partial<AcquireRequest> = {}): AcquireRequest => ({ id: randomUUID(), templateId: IMAGE.id, templateRevision: IMAGE.revision, arch: "amd64", ...extra });
  function rows(sql: string): Body[] {
    const db = new DatabaseSync(statePath);
    try { return db.prepare(sql).all().map(row => ({ ...row })) as Body[]; } finally { db.close(); }
  }
  await ok(post("/v1/linux-lease-images", IMAGE, admin));
  return {
    admin, controllerId, statePath, start, port, post, get, ok, application, enroll, domain, grant, approve, claim, receipt, report, running, stoppedClean,
    inspectDomain, acquire, rows,
    clock(seconds: number) { writeFileSync(clockFile, String(seconds)); },
    leaseClient(leaseId: string, leaseKey: string) { return new LeaseClient({ baseUrl: `http://127.0.0.1:${port()}`, leaseId, leaseKey, allowLoopbackHttp: true }); },
    async restart() { await primary.kill(); primary = await start(); },
  };
}

async function ready(t: Parameters<typeof fixture>[0], ttlSeconds = 300) {
  const f = await fixture(t), app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 32, memoryMiB: 65536, diskGiB: 200 }), runner = await f.enroll();
  await f.ok(f.approve(runner, domain));
  const { lease } = await app.client().acquireLease(f.acquire({ ttlSeconds, requiredCapabilities: ["command"] }));
  const a = (await f.claim(runner)).assignment!;
  await f.ok(f.report(runner, a.id, 1, f.receipt(a, f.running)));
  const credential = (await app.client().rotateLeaseCredential(lease.id)).credential;
  const client = f.leaseClient(lease.id, credential), route = `/v1/leases/${lease.id}/operations`;
  const boot = { binding: runner.binding, assignmentId: a.id, bootAttempt: randomUUID(), bundleDigest: DIGEST.slice(7) };
  const pollBody = { ...boot, pollId: randomUUID() };
  const poll = (body: Body = pollBody, who = runner) => f.post("/v1/runners/linux-leases/operations/poll", body, who.credential);
  const reportOp = (id: string, receipt: Body, extra: Body = {}, who = runner) => f.post("/v1/runners/linux-leases/operations/report", { ...boot, operationId: id, receipt, ...extra }, who.credential);
  return { f, app, domain, runner, lease, a, credential, client, route, boot, pollBody, poll, reportOp };
}
const intent = () => ({ id: randomUUID(), member: "primary" as const, action: "shell" as const, arguments: { argv: ["printf", "private argument"] } });
const success = { stdoutBase64: "b2s=", stderrBase64: "", exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 2, stderrBytes: 0, truncated: false, terminationConfirmed: true };

test("operation roles, canonical replay, bound handoff, terminal replay and result checks", async t => {
  const x = await ready(t), { f, client, app, runner, route, credential } = x;
  const req = intent();
  for (const key of [f.admin, app.credential, runner.credential]) {
    assert.equal((await f.post(route, req, key)).status, 401);
    assert.equal((await f.get(`${route}/${req.id}`, key)).status, 401);
  }
  const first = await client.createOperation(req);
  assert.equal(first.created, true); assert.equal(first.operation.state, "queued");
  assert.equal((await client.createOperation({ arguments: req.arguments, action: "shell", member: "primary", id: req.id })).created, false);
  await rejectsWith(client.createOperation({ ...req, arguments: { argv: ["false"] } }), 409);
  await rejectsWith(client.createOperation(intent()), 429);
  await rejectsWith(client.operation(randomUUID()), 404);
  assert.equal((await f.post(route, { ...req, id: randomUUID(), extra: true }, credential)).status, 400);
  const handoff = await f.ok(x.poll());
  assert.deepEqual(Object.keys(handoff).sort(), ["cancelRequested", "command", "lease", "stopRequested"]);
  assert.deepEqual(handoff.command, { id: req.id, leaseId: x.lease.id, memberId: x.a.memberId, assignmentId: x.a.id, bootAttempt: x.boot.bootAttempt,
    bundleDigest: x.boot.bundleDigest, arguments: req.arguments, startBefore: T0 + 120, timeoutMs: 30000, state: "queued" });
  assert.equal((await f.ok(x.poll({ ...x.pollBody, pollId: randomUUID() }))).command, null);
  assert.equal((await x.poll({ ...x.pollBody, bootAttempt: randomUUID() })).status, 409);
  assert.equal((await x.poll({ ...x.pollBody, bundleDigest: "00".repeat(32) })).status, 409);
  const other = await f.enroll();
  assert.equal((await x.poll({ ...x.pollBody, binding: other.binding }, other)).status, 403);
  assert.equal((await x.reportOp(req.id, { state: "succeeded", result: success }, { binding: other.binding }, other)).status, 403);
  for (const receipt of [
    { state: "unknown", result: success }, { state: "succeeded" },
    ...[{ stdoutBase64: "b2s" }, { stdoutBytes: 1 }, { stderrBytes: 1 }, { timedOut: true }, { terminationConfirmed: false },
      { extra: 1 }, { durationMs: -1 }, { stdoutBase64: Buffer.alloc(262145).toString("base64"), stdoutBytes: 262145 }].map(change => ({ state: "succeeded", result: { ...success, ...change } })),
    { state: "failed", result: success },
  ]) assert.equal((await x.reportOp(req.id, receipt)).status, 400);
  assert.equal((await f.ok(x.reportOp(req.id, { state: "succeeded", result: success }))).state, "succeeded");
  assert.equal((await f.ok(x.reportOp(req.id, { state: "failed" }))).state, "succeeded");
  assert.equal((await client.operation(req.id)).result?.stdoutBase64, "b2s=");
  const next = intent(); await client.createOperation(next);
  const replay = await f.ok(x.poll());
  assert.equal((replay.command as Body).id, req.id); assert.equal((replay.command as Body).state, "succeeded");
  assert.equal((await f.ok(x.poll({ ...x.pollBody, pollId: randomUUID() }))).command !== null, true);
  assert.equal((await f.inspectDomain(x.domain)).reservations, 1);
});

test("lost submit, poll and terminal report replies survive controller restart without redispatch", async t => {
  const x = await ready(t), { f } = x, proxy = await lossyProxy(f.port); t.after(proxy.close);
  const req = intent();
  const via = new LeaseClient({ baseUrl: `http://127.0.0.1:${proxy.port}`, leaseId: x.lease.id, leaseKey: x.credential, allowLoopbackHttp: true });
  await assert.rejects(via.createOperation(req), (e: unknown) => (e as { outcome: string }).outcome === "unknown");
  await f.restart(); assert.equal((await f.leaseClient(x.lease.id, x.credential).createOperation(req)).created, false);
  await assert.rejects(f.post("/v1/runners/linux-leases/operations/poll", x.pollBody, x.runner.credential, proxy.port));
  await f.restart(); const command = (await f.ok(x.poll())).command;
  assert.equal((command as Body).id, req.id);
  await assert.rejects(f.post("/v1/runners/linux-leases/operations/report", { ...x.boot, operationId: req.id, receipt: { state: "succeeded", result: success } }, x.runner.credential, proxy.port));
  await f.restart(); assert.equal((await f.ok(x.reportOp(req.id, { state: "succeeded", result: success }))).state, "succeeded");
  assert.equal(((await f.ok(x.poll())).command as Body).state, "succeeded");
  assert.equal(f.rows("SELECT count(*) AS n FROM linux_operations")[0]!.n, 1);
  assert.equal(f.rows("SELECT count(*) AS n FROM linux_operation_polls")[0]!.n, 1);
});

test("server deadline marks unknown and permanently retains the lane; expiry cancels without release", async t => {
  const x = await ready(t), req = intent(); await x.client.createOperation(req); await x.f.ok(x.poll());
  x.f.clock(T0 + 35);
  assert.equal((await x.client.operation(req.id)).state, "unknown");
  await rejectsWith(x.client.createOperation(intent()), 429);
  assert.equal((await x.f.ok(x.poll())).cancelRequested, true);
  assert.equal((await x.f.ok(x.reportOp(req.id, { state: "succeeded", result: success }))).state, "unknown");
  await rejectsWith(x.client.createOperation(intent()), 429);
  x.f.clock(T0 + 300);
  const ended = await x.f.ok(x.poll()); assert.equal(ended.cancelRequested, true);
  assert.equal((ended.lease as Body).state, "expired");
  assert.equal((await x.f.inspectDomain(x.domain)).reservations, 1);
  assert.equal((await x.f.ok(x.poll({ ...x.pollBody, pollId: randomUUID() }))).command, null);
});

test("start window is persisted across renewal and queued expiry is definite failure", async t => {
  const x = await ready(t, 100), req = intent(); await x.client.createOperation(req);
  x.f.clock(T0 + 50); await x.client.renew({ id: randomUUID(), expectedRevision: 2, ttlSeconds: 250 });
  assert.equal(x.f.rows("SELECT start_before FROM linux_operations")[0]!.start_before, T0 + 100);
  x.f.clock(T0 + 100); assert.equal((await x.client.operation(req.id)).state, "failed");
  assert.equal((await x.f.ok(x.poll())).command, null);
  await x.client.createOperation(intent());
});

for (const dispatched of [false, true]) for (const invalidation of ["rotation", "readiness", "approval", "application", "runner", "release"] as const) {
  test(`${dispatched ? "dispatched" : "queued"} work is invalidated by ${invalidation}`, async t => {
    const x = await ready(t), req = intent(); await x.client.createOperation(req);
    if (dispatched) await x.f.ok(x.poll());
    let current = x.client;
    switch (invalidation) {
      case "rotation": current = x.f.leaseClient(x.lease.id, (await x.app.client().rotateLeaseCredential(x.lease.id)).credential); await rejectsWith(x.client.operation(req.id), 401); break;
      case "readiness": await x.f.ok(x.f.report(x.runner, x.a.id, 2, x.f.receipt(x.a, { runtimeState: "running" }))); break;
      case "approval": await x.f.ok(x.f.post("/v1/linux-lease-runner-approvals/revoke", { binding: x.runner.binding }, x.f.admin)); break;
      case "application": await x.f.ok(x.f.post(`/v1/consumers/${x.app.id}/revoke`, {}, x.f.admin)); await rejectsWith(current.operation(req.id), 401); break;
      case "runner": await x.f.ok(x.f.post("/v1/runners/revoke", x.runner.binding, x.f.admin)); assert.equal((await x.poll()).status, 401); break;
      case "release": await x.client.release({ id: randomUUID() }); break;
    }
    if (invalidation !== "application") assert.equal((await current.operation(req.id)).state, dispatched ? "unknown" : "failed");
    if (invalidation !== "runner") {
      const poll = await x.f.ok(x.poll());
      assert.equal(poll.cancelRequested, dispatched || invalidation !== "rotation");
      assert.equal(poll.stopRequested, invalidation !== "rotation");
    }
    assert.equal((await x.f.inspectDomain(x.domain)).reservations, 1);
    if (invalidation === "readiness") {
      await x.f.ok(x.f.report(x.runner, x.a.id, 3, x.f.receipt(x.a, x.f.running)));
      if (dispatched) await rejectsWith(current.createOperation(intent()), 429);
      else assert.equal((await current.createOperation(intent())).created, true);
    }
  });
}

test("foreign lease operation IDs and poll IDs never cross assignments, even after closing", async t => {
  const x = await ready(t), req = intent(); await x.client.createOperation(req); await x.f.ok(x.poll());
  const second = await x.app.client().acquireLease(x.f.acquire({ ttlSeconds: 300 }));
  const a = (await x.f.claim(x.runner)).assignment!;
  await x.f.ok(x.f.report(x.runner, a.id, 1, x.f.receipt(a, x.f.running)));
  const c = x.f.leaseClient(second.lease.id, (await x.app.client().rotateLeaseCredential(second.lease.id)).credential);
  await rejectsWith(c.operation(req.id), 404); await rejectsWith(c.createOperation(req), 404);
  assert.equal((await x.poll({ ...x.pollBody, assignmentId: a.id })).status, 409);
  assert.equal((await x.reportOp(req.id, { state: "failed" }, { assignmentId: a.id })).status, 404);
  await x.client.release({ id: randomUUID() });
  await x.f.ok(x.f.report(x.runner, x.a.id, 2, x.f.receipt(x.a, { ...x.f.stoppedClean, ready: { command: false, files: false, pty: false } })));
  assert.equal((await x.f.ok(x.poll())).cancelRequested, true);
  assert.equal((await x.f.ok(x.reportOp(req.id, { state: "failed" }))).state, "unknown");
  await x.f.ok(x.f.post("/v1/runners/revoke", x.runner.binding, x.f.admin));
  const newer = await x.f.enroll(x.runner.binding.runnerId, 2);
  assert.equal((await x.reportOp(req.id, { state: "failed" }, { binding: newer.binding }, newer)).status, 403);
});

test("null polls can claim later; terminal reports are ownership checked and never release reservations", async t => {
  const x = await ready(t);
  assert.equal((await x.f.ok(x.poll())).command, null);
  assert.equal(x.f.rows("SELECT count(*) AS n FROM linux_operation_polls")[0]!.n, 0);
  const req = intent(); await x.client.createOperation(req);
  assert.equal((await x.reportOp(req.id, { state: "failed" })).status, 409);
  assert.equal(((await x.f.ok(x.poll())).command as Body).id, req.id);
  assert.equal((await x.f.ok(x.reportOp(req.id, { state: "failed" }))).state, "failed");
  assert.equal((await x.f.ok(x.poll())).cancelRequested, true);
  assert.equal((await x.f.ok(x.reportOp(req.id, { state: "succeeded", result: success }))).state, "failed");
  assert.equal((await x.f.inspectDomain(x.domain)).reservations, 1);
  assert.equal((await x.client.createOperation(intent())).created, true);
});

test("SDK validates local intent, response binding and unknown mutation outcomes without retries", async t => {
  let count = 0;
  const id = randomUUID(), req = intent();
  let reply: Body = { id: req.id, leaseId: id, member: "primary", state: "queued", updatedAt: new Date(T0 * 1000).toISOString() };
  const server = http.createServer((request, response) => {
    count++; request.resume();
    assert.equal(request.headers.authorization, "Bearer " + credential);
    response.writeHead(201, { "Content-Type": "application/json" }); response.end(JSON.stringify(reply));
  });
  const credential = key();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = new LeaseClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, leaseId: id, leaseKey: credential, allowLoopbackHttp: true });
  await assert.rejects(client.createOperation({ ...req, arguments: { argv: [] } })); assert.equal(count, 0);
  assert.equal((await client.createOperation(req)).created, true); assert.equal(count, 1);
  for (const change of [{ leaseId: randomUUID() }, { id: randomUUID() }, { member: "other" }, { state: "unknown", result: success }, { state: "succeeded" }]) {
    const previous = reply; reply = { ...reply, ...change };
    await assert.rejects(client.createOperation(req), (e: unknown) => (e as { code: string; outcome: string }).code === "response_invalid" && (e as { outcome: string }).outcome === "unknown");
    reply = previous;
  }
  assert.equal(count, 6);
});

test("dispatch readiness is explicit and expiry bounds the server deadline", async t => {
  const x = await ready(t, 30);
  await x.f.ok(x.f.report(x.runner, x.a.id, 2, x.f.receipt(x.a, { runtimeState: "running" })));
  await rejectsWith(x.client.createOperation(intent()), 409);
  assert.equal((await x.f.ok(x.poll())).command, null);
  await x.f.ok(x.f.report(x.runner, x.a.id, 3, x.f.receipt(x.a, x.f.running)));
  const req = intent(); await x.client.createOperation(req); await x.f.ok(x.poll());
  const stored = x.f.rows("SELECT start_before,deadline FROM linux_operations")[0]!;
  assert.deepEqual([stored.start_before, stored.deadline], [T0 + 30, T0 + 30]);
  const other = await x.f.enroll();
  assert.equal((await x.reportOp(req.id, { state: "bogus" }, { binding: other.binding }, other)).status, 403);
  x.f.clock(T0 + 30);
  assert.equal((await x.client.operation(req.id)).state, "unknown");
  assert.equal((await x.f.ok(x.poll())).cancelRequested, true);
});

test("backend eligibility denies command admission on KubeVirt", async t => {
  const f = await fixture(t), app = await f.application();
  const image = { ...IMAGE, id: "kube-only", backend: "kubevirt" };
  await f.ok(f.post("/v1/linux-lease-images", image, f.admin)); await f.grant(app.id, image);
  const domain = await f.domain(VM), runner = await f.enroll(); await f.ok(f.approve(runner, domain, image));
  const { lease } = await app.client().acquireLease(f.acquire({ templateId: image.id, requiredCapabilities: ["command"] }));
  const a = (await f.claim(runner)).assignment!; await f.ok(f.report(runner, a.id, 1, f.receipt(a, f.running)));
  const key = (await app.client().rotateLeaseCredential(lease.id)).credential;
  await rejectsWith(f.leaseClient(lease.id, key).createOperation(intent()), 409);
});

for (const reason of ["failed", "unknown", "rotation"] as const) {
  test(`operation-only ${reason} cancellation keeps a ready lease eligible`, async t => {
    const x = await ready(t), req = intent();
    await x.client.createOperation(req); await x.f.ok(x.poll());
    if (reason === "failed") await x.f.ok(x.reportOp(req.id, { state: "failed" }));
    else if (reason === "unknown") x.f.clock(T0 + 35);
    else await x.app.client().rotateLeaseCredential(x.lease.id);
    const poll = await x.f.ok(x.poll());
    assert.equal(poll.cancelRequested, true);
    assert.equal(poll.stopRequested, false);
    assert.equal((poll.lease as Body).state, "ready");
    assert.equal((await x.f.inspectDomain(x.domain)).reservations, 1);
  });
}

test("revoked approval requests a failure-bearing stop and releases only after cleanup", async t => {
  const x = await ready(t), req = intent();
  await x.client.createOperation(req); await x.f.ok(x.poll());
  await x.f.ok(x.f.post("/v1/linux-lease-runner-approvals/revoke", { binding: x.runner.binding }, x.f.admin));
  const poll = await x.f.ok(x.poll());
  assert.equal(poll.cancelRequested, true);
  assert.equal(poll.stopRequested, true);
  assert.equal((poll.lease as Body).state, "ready");
  const stopped = await x.f.ok(x.f.report(x.runner, x.a.id, 2, x.f.receipt(x.a, { runtimeState: "stopped", failure: "runtime" })));
  assert.equal((stopped.lease as Body).state, "failed");
  assert.equal(stopped.released, false);
  assert.equal((await x.f.inspectDomain(x.domain)).reservations, 1);
  const clean = await x.f.ok(x.f.report(x.runner, x.a.id, 3, x.f.receipt(x.a, { ...x.f.stoppedClean, failure: "runtime" })));
  assert.equal(clean.released, true);
  assert.equal((await x.f.inspectDomain(x.domain)).reservations, 0);
});
