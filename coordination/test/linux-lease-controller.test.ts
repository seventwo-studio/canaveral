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
const IMAGE = { id: "linux-dev", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "kubevirt", digest: DIGEST, resources: VM, capabilities: ["command", "files", "pty"] };
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

test("catalog, grants and approvals pin headless Linux images per backend and deny unsupported capabilities", async t => {
  const f = await fixture(t);
  const [a, b] = [await f.application(), await f.application()];
  await f.grant(a.id);
  assert.equal((await f.post("/v1/linux-lease-images", IMAGE, f.admin)).status, 200);
  for (const [bad, status] of [[{ ...IMAGE, digest: OTHER_DIGEST }, 409], [{ ...IMAGE, mode: "desktop" }, 400], [{ ...IMAGE, os: "windows" }, 400],
    [{ ...IMAGE, id: "x", backend: "libvirt" }, 400], [{ ...IMAGE, id: "x", capabilities: ["command", "displayStream"] }, 409],
    [{ ...IMAGE, id: "x", digest: "latest" }, 400]] as Array<[Body, number]>) {
    assert.equal((await f.post("/v1/linux-lease-images", bad, f.admin)).status, status, JSON.stringify(bad));
  }
  assert.equal((await f.post("/v1/linux-lease-images", { ...IMAGE, id: "x" }, a.credential)).status, 401);
  assert.equal((await f.post("/v1/linux-lease-grants", { applicationId: b.id, imageId: IMAGE.id, revision: "1", arch: "amd64", digest: OTHER_DIGEST }, f.admin)).status, 404);
  await f.ok(f.post("/v1/linux-lease-images", APPLE, f.admin));

  const domain = await f.domain({ cpu: 16, memoryMiB: 32768, diskGiB: 200 });
  const [kube, apple] = [await f.enroll(), await f.enroll()];
  // A binding serves one backend: an Apple Virtualization runner cannot serve a kubevirt image.
  assert.equal((await f.approve(apple, domain, { ...APPLE, backend: "appleVirtualization", digest: DIGEST, id: IMAGE.id, arch: "amd64" })).status, 409);
  assert.equal((await f.post("/v1/linux-lease-runner-approvals", { binding: kube.binding, domainId: domain, backend: "kubevirt", images: [{ id: IMAGE.id, revision: "1", arch: "amd64", digest: OTHER_DIGEST }] }, f.admin)).status, 404);
  assert.equal((await f.approve(apple, domain, APPLE)).status, 200);

  // Catalogue: granted image visible but unavailable until a kubevirt binding serves it.
  let catalogue = await a.client().catalogue();
  assert.deepEqual(catalogue.templates.map(i => [i.id, i.available, i.runtime, i.mode, i.capabilities.displayStream, i.capabilities.pty]), [[IMAGE.id, false, "kubevirt", "headless", false, true]]);
  assert.equal((await b.client().catalogue()).templates.length, 0);
  await rejectsWith(a.client().acquireLease(f.acquire()), 503, "capacity_unavailable");
  assert.equal((await f.approve(kube, domain)).status, 200);
  assert.equal((await f.approve(kube, domain)).status, 200);
  catalogue = await a.client().catalogue();
  assert.equal(catalogue.templates[0]!.available, true);
  assert.equal(catalogue.limits.maxLifetimeSeconds, 300);

  await rejectsWith(a.client().acquireLease(f.acquire({ requiredCapabilities: ["screenshot"] })), 409, "capability_unsupported");
  await rejectsWith(b.client().acquireLease(f.acquire()), 403);
  await rejectsWith(a.client().acquireLease(f.acquire({ resources: { cpu: 1 } })), 400);
  await rejectsWith(a.client().acquireLease(f.acquire({ ttlSeconds: 301 })), 400);
  assert.equal((await f.inspectDomain(domain)).reservations, 0);

  const kubeLease = await a.client().acquireLease(f.acquire({ requiredCapabilities: ["command", "files"] }));
  assert.equal(kubeLease.lease.capabilities.displayStream, false);
  const assignment = (await f.claim(kube)).assignment!;
  assert.deepEqual([assignment.image.backend, assignment.image.digest, assignment.leaseId], ["kubevirt", DIGEST, kubeLease.lease.id]);
  assert.equal((await f.claim(apple)).assignment, null);
  assert.equal((await f.report(kube, assignment.id, 1, f.receipt(assignment, { imageDigest: OTHER_DIGEST }))).body.code, "image_mismatch");
  assert.equal((await f.report(kube, assignment.id, 1, f.receipt(assignment, { backend: "appleVirtualization" }))).status, 409);
  // Graphics cannot be reported ready on a headless lease; readiness needs explicit capability evidence.
  assert.equal((await f.report(kube, assignment.id, 1, f.receipt(assignment, { ready: { command: true, pty: false, files: false } }))).status, 409);
  await f.ok(f.report(kube, assignment.id, 1, f.receipt(assignment, { runtimeState: "running", ready: { command: true, pty: false, files: false } })));
  assert.equal((await a.client().inspectLease(kubeLease.lease.id)).state, "provisioning");
  await f.ok(f.report(kube, assignment.id, 2, f.receipt(assignment, f.running)));
  const ready = await a.client().inspectLease(kubeLease.lease.id);
  assert.deepEqual([ready.state, ready.runtimeState, ready.revision, ready.members[0]!.ready], ["ready", "running", 2, true]);
  // Lifecycle stays ready, but the current member signal follows fresh capability evidence.
  const unready = { command: false, pty: false, files: false };
  for (const [sequence, runtimeState, capabilityReady, expectedReady] of [
    [3, "running", unready, false],
    [4, "running", f.running.ready, true],
    [5, "unknown", unready, false],
    [6, "running", unready, false],
    [7, "running", f.running.ready, true],
  ] as const) {
    await f.ok(f.report(kube, assignment.id, sequence, f.receipt(assignment, { runtimeState, ready: capabilityReady })));
    const current = await a.client().inspectLease(kubeLease.lease.id);
    assert.deepEqual([current.state, current.runtimeState, current.revision, current.members[0]!.ready],
      ["ready", runtimeState, 2, expectedReady]);
  }

});

test("application/lease roles, ownership and opaque lease credentials through the public SDK", async t => {
  const f = await fixture(t);
  const [a, b] = [await f.application({ activeLeases: 2 }), await f.application()];
  await f.grant(a.id); await f.grant(b.id);
  const domain = await f.domain({ cpu: 16, memoryMiB: 32768, diskGiB: 200 });
  const runner = await f.enroll();
  await f.approve(runner, domain);
  const request = f.acquire({ name: "job", ttlSeconds: 200, requiredCapabilities: ["command"] });
  const first = await a.client().acquireLease(request);
  assert.deepEqual([first.created, first.lease.state, first.lease.runtimeState, first.lease.cleanup.state, first.lease.revision], [true, "provisioning", "pending", "notRequested", 1]);
  assert.equal(first.lease.expiresAt, new Date((T0 + 200) * 1000).toISOString());
  const replay = await a.client().acquireLease({ ...request });
  assert.deepEqual([replay.created, replay.lease.id], [false, request.id]);
  await rejectsWith(a.client().acquireLease({ ...request, ttlSeconds: 201 }), 409);
  await rejectsWith(b.client().acquireLease({ ...request }), 409);
  await rejectsWith(b.client().inspectLease(request.id), 404);
  await rejectsWith(b.client().releaseLease(request.id, { id: randomUUID() }), 404);
  assert.equal((await f.get(`/v1/leases/${request.id}`, f.admin)).status, 401);
  assert.equal((await f.get(`/v1/leases/${request.id}`, runner.credential)).status, 401);

  const second = await a.client().acquireLease(f.acquire());
  await rejectsWith(a.client().acquireLease(f.acquire()), 429);
  const page = await a.client().listLeases();
  assert.deepEqual(page.leases.map(l => l.id), [request.id, second.lease.id].sort());
  assert.equal((await b.client().listLeases()).leases.length, 0);

  // Explicit owner-only exchange; rotation revokes the previous key.
  const k1 = await a.client().rotateLeaseCredential(request.id);
  const scoped = f.leaseClient(request.id, k1.credential);
  assert.equal((await scoped.inspect()).id, request.id);
  await rejectsWith(f.leaseClient(second.lease.id, k1.credential).inspect(), 401);
  assert.equal((await f.post(`/v1/leases/${request.id}/credential`, {}, k1.credential)).status, 403);
  assert.equal((await f.get("/v1/leases", k1.credential)).status, 401);
  await rejectsWith(b.client().rotateLeaseCredential(request.id), 404);
  const k2 = await a.client().rotateLeaseCredential(request.id);
  await rejectsWith(scoped.inspect(), 401);
  const renewed = await f.leaseClient(request.id, k2.credential).renew({ id: randomUUID(), expectedRevision: 1, ttlSeconds: 100 });
  assert.equal(renewed.lease.revision, 2);
  // No secret appears in stored rows, mutation bodies or anywhere in the database file.
  const db = readFileSync(f.statePath);
  for (const secret of [k1.credential, k2.credential]) assert.equal(db.includes(Buffer.from(secret)), false);
  assert.ok(f.rows("SELECT request,result FROM linux_lease_mutations").every(row => !JSON.stringify(row).includes("credential")));
  const released = await f.leaseClient(request.id, k2.credential).release({ id: randomUUID() });
  assert.deepEqual([released.lease.state, released.lease.cleanup.state], ["released", "complete"]);
  await rejectsWith(a.client().rotateLeaseCredential(request.id), 410);
  assert.deepEqual(f.rows("SELECT id,state,credential FROM leases"), [{ id: "legacy-lease", state: "ready", credential: "legacy-hash" }]);
});

test("VM leases and model jobs contend for one ResourceDomains ledger across concurrent controller processes", async t => {
  const f = await fixture(t), second = await f.start();
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain(VM);
  const runner = await f.enroll();
  await f.approve(runner, domain);
  await f.ok(f.post("/v1/model-catalog", { model: MODEL, digest: MODEL_DIGEST, adapter: "ollama", resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 } }, f.admin));
  await f.ok(f.post("/v1/model-grants", { applicationId: app.id, model: MODEL, digest: MODEL_DIGEST, maxUnfinished: 4 }, f.admin));
  await f.ok(f.post("/v1/model-runner-approvals", { binding: runner.binding, domainId: domain, models: [{ model: MODEL, digest: MODEL_DIGEST }] }, f.admin));
  const job = { version: 1, applicationId: app.id, id: randomUUID(), message: { type: "submit", adapter: "ollama", model: MODEL, digest: MODEL_DIGEST, prompt: "p", maxTokens: 8 } };
  assert.equal((await f.post("/v1/model-jobs", job, app.credential)).status, 201);

  const ports = [f.port(), second.port];
  const attempts = await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => app.client(ports[i % 2]).acquireLease(f.acquire()).then(r => ({ kind: "lease", id: r.lease.id }), (e: unknown) => ({ kind: "denied", e }))),
    ...Array.from({ length: 4 }, (_, i) => f.post("/v1/runners/model-jobs/claim", { binding: runner.binding, claimId: randomUUID() }, runner.credential, ports[i % 2])
      .then(r => (r.body.assignment ? { kind: "model", id: (r.body.assignment as { id: string }).id } : { kind: "none" }))),
  ]);
  const leases = attempts.filter(a => a.kind === "lease"), models = attempts.filter(a => a.kind === "model");
  // The domain fits one VM, or one model job beside nothing else: never both, never double counted.
  assert.equal(leases.length + models.length, 1, JSON.stringify(attempts.map(a => a.kind)));
  for (const denied of attempts.filter(a => a.kind === "denied")) assert.equal(((denied as { e: ConsumerServiceError }).e).code, "capacity_unavailable");
  const view = await f.inspectDomain(domain);
  assert.deepEqual([view.reservations, view.reserved.cpu], [1, leases.length ? 4 : 2]);

  if (leases.length) {
    // An unclaimed lease is reclaimed in its release transaction; the model job can then claim.
    const released = await app.client().releaseLease((leases[0] as { id: string }).id, { id: randomUUID() });
    assert.deepEqual([released.lease.state, released.lease.cleanup.state], ["released", "complete"]);
    assert.notEqual((await f.post("/v1/runners/model-jobs/claim", { binding: runner.binding, claimId: randomUUID() }, runner.credential)).body.assignment, null);
    await rejectsWith(app.client().acquireLease(f.acquire()), 503, "capacity_unavailable");
  } else {
    await rejectsWith(app.client().acquireLease(f.acquire()), 503, "capacity_unavailable");
    const id = (models[0] as { id: string }).id;
    const rec = (extra: Body) => ({ version: 1, applicationId: app.id, id: job.id, message: { type: "receipt", state: "failed", cancelRequested: false, stopped: true, cleanup: "complete", ...extra } });
    assert.equal((await f.post("/v1/runners/model-jobs/report", { binding: runner.binding, assignmentId: id, sequence: 1, receipt: rec({}) }, runner.credential)).body.released, true);
    assert.equal((await app.client().acquireLease(f.acquire())).created, true);
  }
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
});

test("exact expiry boundary, renewal, release replay, provisioning failure and positive cleanup with a fixture clock", async t => {
  const f = await fixture(t);
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 16, memoryMiB: 32768, diskGiB: 200 });
  const runner = await f.enroll();
  await f.approve(runner, domain);
  const c = app.client();
  const { lease } = await c.acquireLease(f.acquire());
  const a = (await f.claim(runner)).assignment!;
  assert.deepEqual([a.lease.expiresAt, a.lease.controllerNow, a.stopRequested], [T0 + 100, T0, false]);
  await f.ok(f.report(runner, a.id, 1, f.receipt(a, f.running)));

  f.clock(T0 + 50);
  const renew = { id: randomUUID(), expectedRevision: 2, ttlSeconds: 100 };
  const renewed = await c.renewLease(lease.id, renew);
  assert.deepEqual([renewed.mutation.revision, renewed.mutation.expiresAt], [3, new Date((T0 + 150) * 1000).toISOString()]);
  await rejectsWith(c.renewLease(lease.id, { ...renew, ttlSeconds: 99 }), 409);
  await rejectsWith(c.renewLease(lease.id, { id: randomUUID(), expectedRevision: 2, ttlSeconds: 100 }), 409);
  // Never shortens; capped by the lifetime fixed at admission (T0 + 300).
  const capped = await c.renewLease(lease.id, { id: randomUUID(), expectedRevision: 3, ttlSeconds: 300 });
  assert.equal(capped.lease.expiresAt, new Date((T0 + 300) * 1000).toISOString());
  f.clock(T0 + 299);
  const replay = await c.renewLease(lease.id, renew);
  assert.deepEqual([replay.mutation.revision, replay.lease.revision, replay.lease.state], [3, 4, "ready"]);
  const listed = await f.post("/v1/runners/linux-leases/assignments", { binding: runner.binding }, runner.credential);
  assert.equal((listed.body.assignments as Assignment[])[0]!.lease.expiresAt, T0 + 300);

  f.clock(T0 + 300);
  // now >= expiresAt: expiry wins over the renewal in the same transaction.
  await rejectsWith(c.renewLease(lease.id, { id: randomUUID(), expectedRevision: 4, ttlSeconds: 10 }), 409);
  const expired = await c.inspectLease(lease.id);
  assert.deepEqual([expired.state, expired.revision, expired.cleanup.state, (expired.members[0]!.cleanup as Body).reason], ["expired", 5, "pending", "execution_pending"]);
  const release = { id: randomUUID() };
  const ended = await c.releaseLease(lease.id, release);
  assert.deepEqual([ended.mutation.state, ended.lease.state], ["expired", "expired"]);
  assert.deepEqual((await c.releaseLease(lease.id, release)).mutation, ended.mutation);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  const stop = (await f.post("/v1/runners/linux-leases/assignments", { binding: runner.binding }, runner.credential)).body.assignments as Assignment[];
  assert.equal(stop[0]!.stopRequested, true);
  // Stop alone, or cleanup without erasure evidence, never releases.
  const stopped = await f.ok(f.report(runner, a.id, 2, f.receipt(a, { runtimeState: "stopped", executionStopped: true, cleanup: "running" })));
  assert.deepEqual([stopped.released, stopped.cleanup], [false, "running"]);
  assert.equal((await f.report(runner, a.id, 3, f.receipt(a, { ...f.stoppedClean, credentialsErased: false }))).status, 409);
  assert.equal((await f.report(runner, a.id, 3, f.receipt(a, { runtimeState: "running" }))).status, 409);
  assert.equal((await f.ok(f.report(runner, a.id, 3, f.receipt(a, f.stoppedClean)))).released, true);
  assert.equal((await f.report(runner, a.id, 4, f.receipt(a, f.stoppedClean))).status, 409);
  assert.equal((await f.inspectDomain(domain)).reservations, 0);
  const reclaimed = await c.inspectLease(lease.id);
  assert.deepEqual([reclaimed.state, reclaimed.cleanup.state, reclaimed.runtimeState], ["expired", "complete", "stopped"]);
  await rejectsWith(c.renewLease(lease.id, { id: randomUUID(), expectedRevision: 5, ttlSeconds: 10 }), 409);

  // Provisioning failure ends the lease but keeps the reservation until positive cleanup.
  const failing = await c.acquireLease(f.acquire());
  const fa = (await f.claim(runner)).assignment!;
  assert.equal((await f.report(runner, fa.id, 1, f.receipt(fa, { runtimeState: "stopped" }))).status, 409);
  const failed = await f.ok(f.report(runner, fa.id, 1, f.receipt(fa, { runtimeState: "stopped", failure: "provisioning", executionStopped: true })));
  assert.deepEqual([failed.released, (failed.lease as Body).state, failed.stopRequested], [false, "failed", true]);
  assert.equal((await c.inspectLease(failing.lease.id)).state, "failed");
  assert.equal((await f.inspectDomain(domain)).reservations, 1);
  await f.ok(f.report(runner, fa.id, 2, f.receipt(fa, f.stoppedClean)));

  // Unclaimed: the provisioning deadline fails it and its reservation is reclaimed at once.
  const unclaimed = await c.acquireLease(f.acquire({ ttlSeconds: 300 }));
  f.clock(T0 + 300 + 250);
  const timedOut = await c.inspectLease(unclaimed.lease.id);
  assert.deepEqual([timedOut.state, timedOut.cleanup.state], ["failed", "complete"]);
  assert.equal((await f.claim(runner)).assignment, null);
  assert.equal((await f.inspectDomain(domain)).reservations, 0);
});

test("lost replies replay across restart; stale bindings keep unknown reservations; fresh leases are isolated", async t => {
  const f = await fixture(t), proxy = await lossyProxy(f.port);
  t.after(proxy.close);
  const app = await f.application();
  await f.grant(app.id);
  const domain = await f.domain({ cpu: 8, memoryMiB: 16384, diskGiB: 40 });
  const runner = await f.enroll();
  await f.approve(runner, domain);
  const request = f.acquire();
  const lost = await app.client(proxy.port).acquireLease(request).then(() => undefined, (e: unknown) => e as { outcome?: string });
  assert.equal(lost?.outcome, "unknown");
  await f.restart();
  const recovered = await app.client().acquireLease(request);
  assert.equal(recovered.created, false);
  assert.equal(f.rows("SELECT count(*) AS n FROM linux_leases")[0]!.n, 1);

  const claimId = randomUUID();
  await assert.rejects(f.claim(runner, claimId, proxy.port));
  await f.restart();
  const a = (await f.claim(runner, claimId)).assignment!;
  assert.equal(a.leaseId, request.id);
  assert.equal((await f.claim(runner)).assignment, null);
  const first = f.receipt(a, f.running);
  await assert.rejects(f.report(runner, a.id, 1, first, proxy.port));
  await f.restart();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal((await f.ok(f.report(runner, a.id, 1, reordered))).sequence, 1);
  assert.equal((await f.report(runner, a.id, 1, f.receipt(a, { runtimeState: "unknown" }))).status, 409);
  assert.equal((await f.report(runner, a.id, 3, f.receipt(a, { runtimeState: "unknown" }))).status, 409);
  const renew = { id: randomUUID(), expectedRevision: 2, ttlSeconds: 100 };
  const lostRenew = await app.client(proxy.port).renewLease(request.id, renew).then(() => undefined, (e: unknown) => e as { outcome?: string });
  assert.equal(lostRenew?.outcome, "unknown");
  await f.restart();
  assert.equal((await app.client().renewLease(request.id, renew)).mutation.revision, 3);
  await f.ok(f.report(runner, a.id, 2, f.receipt(a, { runtimeState: "unknown" })));
  await f.restart();
  assert.equal((await app.client().inspectLease(request.id)).runtimeState, "unknown");
  assert.equal((await f.inspectDomain(domain)).reservations, 1);

  // Revoke and reenroll: the old generation cannot report, the new one inherits nothing; no failover.
  const oldKey = (await app.client().rotateLeaseCredential(request.id)).credential;
  await f.ok(f.post("/v1/runners/revoke", runner.binding, f.admin));
  assert.equal((await f.report(runner, a.id, 3, f.receipt(a, f.stoppedClean))).status, 401);
  const next = await f.enroll(runner.binding.runnerId, 2);
  assert.equal((await f.claim(next)).status, 403);
  await f.ok(f.approve(next, domain));
  assert.equal((await f.claim(next)).assignment, null);
  assert.equal((await f.report(next, a.id, 3, f.receipt(a, { ...f.stoppedClean, observedRevision: 3 }))).status, 403);
  const released = await app.client().releaseLease(request.id, { id: randomUUID() });
  assert.deepEqual([released.lease.state, released.lease.runtimeState, released.lease.cleanup.state, (released.lease.members[0]!.cleanup as Body).reason],
    ["released", "unknown", "pending", "recovery"]);
  assert.equal((await f.inspectDomain(domain)).reservations, 1);

  // A fresh lease gets a new member identity; keys never cross leases.
  const fresh = await app.client().acquireLease(f.acquire());
  const freshKey = (await app.client().rotateLeaseCredential(fresh.lease.id)).credential;
  assert.notEqual((fresh.lease.members[0] as { machineId: string }).machineId, (released.lease.members[0] as { machineId: string }).machineId);
  await rejectsWith(f.leaseClient(request.id, freshKey).inspect(), 401);
  await rejectsWith(f.leaseClient(fresh.lease.id, oldKey).inspect(), 401);
  const b = (await f.claim(next)).assignment!;
  assert.equal(b.leaseId, fresh.lease.id);
  assert.equal((await f.report(next, b.id, 1, f.receipt(b, f.running))).status, 200);
  assert.equal(((await f.leaseClient(fresh.lease.id, freshKey).inspect()) as Lease).state, "ready");
  assert.equal((await f.inspectDomain(domain)).reservations, 2);
  assert.deepEqual(f.rows("SELECT id,state FROM leases"), [{ id: "legacy-lease", state: "ready" }]);
});
