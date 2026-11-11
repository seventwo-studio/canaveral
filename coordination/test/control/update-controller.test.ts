import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { SqliteStore } from "../../src/sqlite.ts";
import { Accounts } from "../../src/accounts.ts";
import { RunnerEnrollment } from "../../src/enrollment.ts";
import { ServiceError } from "../../src/errors.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { createModule, updateChunkBytes } from "../../src/control/updates.ts";
import type { UpdateOptions } from "../../src/control/updates.ts";
import type { ControlModule, ControlRequest, Principal } from "../../src/control/contracts.ts";
import { canonicalManifest } from "../../src/updates/protocol.ts";
import type { Manifest, SignedRelease, Target } from "../../src/updates/protocol.ts";

type Json = Record<string, any>;
const token = () => randomBytes(32).toString("base64url");
const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
const platform: Target = { os: "linux", arch: "amd64" };
const keypair = generateKeyPairSync("ed25519");
const publicKey = keypair.publicKey.export({ format: "pem", type: "spki" }).toString();
const status = (n: number) => (error: unknown) => error instanceof ServiceError && error.status === n;
function request(method: string, url: string, body: Json, credential: string, principal = () => operator): ControlRequest {
  const parsed = new URL(url, "http://controller.invalid");
  return { method, path: parsed.pathname, parts: parsed.pathname.split("/").filter(Boolean), query: parsed.searchParams, body, token: credential, principal };
}
async function api(module: ControlModule, method: string, url: string, body: Json = {}, credential = token(), principal = () => operator): Promise<Json> {
  const result = await module.handle(request(method, url, body, credential, principal));
  assert.ok(result); return result.body as Json;
}
function signed(sequence = 2, bytes = Buffer.from("process.send?.({type:'ready'});"), patch: Partial<Manifest> = {}): SignedRelease {
  const manifest: Manifest = { schema: "canaveral-update-v1", releaseId: randomUUID(), version: `1.${sequence}.0`, sequence, createdAt: 1000,
    target: platform, minimumLauncherVersion: 1, entrypoint: "host/main.js", files: [
      { path: "host/main.js", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), executable: false, component: "host" },
      { path: "guest/helper", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), executable: true, component: "guest" },
      { path: "native/helper", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), executable: true, component: "native-helper" },
    ], ...patch };
  return { manifest, keyId: "operator-1", signature: sign(null, canonicalManifest(manifest), keypair.privateKey).toString("base64") };
}
function fixture(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "canaveral-updates-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  let now = 1000;
  const store = new SqliteStore(join(folder, "state.sqlite"), () => now);
  const options: UpdateOptions = { adminToken: token(), enrollmentToken: token(), controllerId: randomUUID(), updatePublicKeys: { "operator-1": publicKey } };
  const machines = new MachineStore(store, options), host = randomUUID(), credential = token(), installationId = randomUUID(), previous = randomUUID();
  const offer = { name: "no architecture inference here", provider: "libvirt", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 40 }, templates: [{ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }] };
  machines.enroll({ id: host, credential, offer }, options.enrollmentToken!);
  let module = createModule(store, options);
  const call = (method: string, url: string, body: Json = {}, key = options.adminToken, principal = () => operator) => api(module, method, url, body, key, principal);
  const poll = (body: Json = {}, key = credential, id = host) => call("POST", `/v1/hosts/${id}/updates/poll`, { installationId, target: platform, launcherVersion: 1, currentReleaseId: previous, ...body }, key);
  const upload = (release: SignedRelease, bytes = Buffer.from("process.send?.({type:'ready'});")) => call("POST", `/v1/updates/artifacts/${release.manifest.files[0]!.sha256}`, { offset: 0, totalBytes: bytes.length, data: bytes.toString("base64") });
  const create = (release: SignedRelease, body: Json = {}) => call("POST", "/v1/updates/rollouts", { id: randomUUID(), releaseId: release.manifest.releaseId, hostIds: [host], ...body });
  async function assigned(release = signed()) {
    await poll(); await call("POST", "/v1/updates/releases", release); await upload(release);
    const rollout = await create(release), polled = await poll();
    return { release, rollout, job: polled.job as Json };
  }
  const report = (job: Json, sequence: number, state: string, extra: Json = {}, key = credential, id = host) => call("POST", `/v1/hosts/${id}/updates/report`, { jobId: job.id, attemptId: job.attemptId, sequence, state, ...extra }, key);
  const phase = (jobId: string) => store.transaction(db => db.prepare("SELECT * FROM host_update_jobs WHERE id=?").get(jobId)!);
  const drainCount = () => store.transaction(db => Number(db.prepare("SELECT COUNT(*) AS n FROM host_update_jobs WHERE phase NOT IN ('succeeded','rolledBack','failed','cancelled')").get()!.n));
  return { store, options, machines, host, credential, installationId, previous, offer, call, poll, upload, create, assigned, report, phase, drainCount,
    restart: () => { module = createModule(new SqliteStore(store.path, () => now), options); }, advance: (seconds: number) => { now += seconds; } };
}

test("signed registration pins operator trust, exact replay and platform sequence", async t => {
  const f = fixture(t), release = signed();
  assert.deepEqual(await f.call("POST", "/v1/updates/releases", release), release);
  assert.deepEqual(await f.call("POST", "/v1/updates/releases", release), release);
  assert.deepEqual(await f.call("GET", `/v1/updates/releases/${release.manifest.releaseId}`), release);
  assert.deepEqual((await f.call("GET", "/v1/updates/releases")).releases, [release]);
  await assert.rejects(f.call("POST", "/v1/updates/releases", signed(2)), status(409));
  const changed = signed(3, undefined, { releaseId: release.manifest.releaseId });
  await assert.rejects(f.call("POST", "/v1/updates/releases", changed), status(409));
  for (const untrusted of [{ ...release, keyId: "manifest-root" }, { ...release, signature: randomBytes(64).toString("base64") }, { ...release, roots: { attacker: publicKey } }, { ...release, manifest: { ...release.manifest, entrypoint: "../state/identity" } }]) {
    await assert.rejects(f.call("POST", "/v1/updates/releases", untrusted));
  }
  const disabled = createModule(f.store, { adminToken: f.options.adminToken, controllerId: f.options.controllerId });
  await assert.rejects(api(disabled, "POST", "/v1/updates/releases", signed(3)), status(503));
  assert.equal(readFileSync(f.store.path).includes(Buffer.from(f.credential)), false);
});

test("artifacts are bounded, contiguous, exact replayable, hash finalized, and cross-chunk readable", async t => {
  const f = fixture(t), bytes = randomBytes(updateChunkBytes + 23), release = signed(2, bytes), sha = release.manifest.files[0]!.sha256;
  await f.poll(); await f.call("POST", "/v1/updates/releases", release);
  const url = `/v1/updates/artifacts/${sha}`, first = { offset: 0, totalBytes: bytes.length, data: bytes.subarray(0, updateChunkBytes).toString("base64") };
  assert.equal((await f.call("POST", url, first)).verified, false);
  assert.equal((await f.call("POST", url, first)).receivedBytes, updateChunkBytes);
  await assert.rejects(f.create(release), status(409));
  await assert.rejects(f.call("POST", url, { ...first, data: Buffer.alloc(updateChunkBytes).toString("base64") }), status(409));
  await assert.rejects(f.call("POST", url, { ...first, offset: 1 }), status(409));
  await assert.rejects(f.call("POST", url, { offset: updateChunkBytes, totalBytes: bytes.length, data: Buffer.alloc(23).toString("base64") }), status(409));
  assert.equal((await f.call("POST", url, { offset: updateChunkBytes, totalBytes: bytes.length, data: bytes.subarray(updateChunkBytes).toString("base64") })).verified, true);
  const rollout = await f.create(release), job = (await f.poll()).job;
  const read = await f.call("GET", `${url}?jobId=${job.id}&offset=${updateChunkBytes - 7}&length=30`, {}, f.credential);
  assert.deepEqual(Buffer.from(read.data, "base64"), bytes.subarray(updateChunkBytes - 7));
  assert.equal(rollout.jobs[0].id, job.id);
  await assert.rejects(f.call("GET", `${url}?jobId=${job.id}&offset=0&length=${updateChunkBytes + 1}`, {}, f.credential), status(400));
  await assert.rejects(f.call("GET", `${url}?jobId=${job.id}&offset=0&offset=1&length=1`, {}, f.credential), status(400));
  for (const data of ["a".repeat(1024 * 1024 + 1), "-_==", "Zh=="]) await assert.rejects(f.call("POST", `/v1/updates/artifacts/${"a".repeat(64)}`, { offset: 0, totalBytes: 1, data }));
  await assert.rejects(f.call("POST", url, { offset: 0, totalBytes: Number.MAX_SAFE_INTEGER, data: "" }), status(400));
});

test("artifact tampering after finalization is refused before rollout and before host delivery", async t => {
  const f = fixture(t), { release, job } = await f.assigned(), sha = release.manifest.files[0]!.sha256;
  f.store.transaction(db => db.prepare("UPDATE update_artifact_chunks SET data=? WHERE sha256=?").run(Buffer.alloc(release.manifest.files[0]!.bytes), sha));
  await assert.rejects(f.call("GET", `/v1/updates/artifacts/${sha}?jobId=${job.id}&offset=0&length=1`, {}, f.credential), status(409));
  const other = randomUUID(), key = token();
  f.machines.enroll({ id: other, credential: key, offer: f.offer }, f.options.enrollmentToken!);
  await f.poll({ installationId: randomUUID() }, key, other);
  await assert.rejects(f.create(release, { hostIds: [other] }), status(409));
  assert.equal(f.drainCount(), 1);
});

test("rollouts require authenticated known target and launcher and are atomic exact receipts", async t => {
  const f = fixture(t), release = signed();
  await f.call("POST", "/v1/updates/releases", release); await f.upload(release);
  await assert.rejects(f.create(release), status(409));
  await f.poll({ target: { os: "darwin", arch: "arm64" } });
  await assert.rejects(f.create(release), status(409));
  await f.poll();
  const id = randomUUID(), created = await f.create(release, { id });
  assert.deepEqual(await f.create(release, { id }), created);
  await assert.rejects(f.create(release, { id, hostIds: [f.host, randomUUID()] }), status(409));
  await assert.rejects(f.create(release), status(409));
  const next = signed(3, undefined, { minimumLauncherVersion: 2 });
  await f.call("POST", "/v1/updates/releases", next);
  const other = randomUUID(), key = token(); f.machines.enroll({ id: other, credential: key, offer: f.offer }, f.options.enrollmentToken!);
  await f.poll({ installationId: randomUUID() }, key, other);
  await assert.rejects(f.create(next, { hostIds: [other] }), status(409));
  await assert.rejects(f.create(release, { hostIds: [other, randomUUID()] }), status(409));
  assert.equal(f.drainCount(), 1); assert.equal((await f.call("GET", "/v1/updates/rollouts")).rollouts.length, 1);
});

test("positive ordered readiness receipts clear only update drain and retain all workload reservations", async t => {
  const f = fixture(t), vm = f.machines.create({ id: randomUUID(), name: "retained", templateId: "linux", resources: {} }, request("POST", "/v1/machines", {}, f.options.adminToken));
  const before = f.store.transaction(db => db.prepare("SELECT * FROM machines WHERE id=?").get(vm.id));
  const { job, release } = await f.assigned();
  await assert.rejects(f.report(job, 1, "succeeded", { installedReleaseId: release.manifest.releaseId }), status(409));
  const first = await f.report(job, 1, "draining");
  await f.report(job, 2, "downloading"); await f.report(job, 3, "staged");
  await assert.rejects(f.report(job, 4, "verifying"), status(409));
  await f.report(job, 4, "activating"); await f.report(job, 5, "verifying");
  await assert.rejects(f.report(job, 6, "succeeded", { installedReleaseId: f.previous }), status(409));
  const done = await f.report(job, 6, "succeeded", { installedReleaseId: release.manifest.releaseId });
  assert.equal(done.job.components.host, "ready"); assert.equal(done.job.components.guest, "pendingGuestReceipt"); assert.equal(done.job.components["native-helper"], "pendingNativeReceipt");
  assert.equal(f.drainCount(), 0);
  assert.deepEqual(f.store.transaction(db => db.prepare("SELECT * FROM machines WHERE id=?").get(vm.id)), before);
  assert.deepEqual(await f.report(job, 1, "draining"), first);
  await assert.rejects(f.report(job, 1, "unknown"), status(409));
  await assert.rejects(f.report(job, 7, "unknown"), status(409));
  await assert.rejects(f.call("GET", `/v1/updates/artifacts/${release.manifest.files[0]!.sha256}?jobId=${job.id}&offset=0&length=1`, {}, f.credential), status(403));
  f.restart(); assert.deepEqual(await f.report(job, 6, "succeeded", { installedReleaseId: release.manifest.releaseId }), done);
  await assert.rejects(f.create(release), status(409));
});

test("unknown persists across restart, never expires or allows safe-failure reinterpretation or new jobs", async t => {
  const f = fixture(t), { job, release } = await f.assigned();
  await f.report(job, 1, "draining"); await f.report(job, 2, "unknown");
  f.advance(8640000); f.restart();
  assert.equal(f.phase(job.id).phase, "unknown"); assert.equal(f.drainCount(), 1);
  assert.equal((await f.poll()).job.id, job.id);
  await assert.rejects(f.report(job, 3, "failed", { installedReleaseId: f.previous }), status(409));
  await assert.rejects(f.report(job, 3, "cancelled", { installedReleaseId: f.previous }), status(409));
  await assert.rejects(f.report(job, 3, "rolledBack", { installedReleaseId: f.previous }), status(409));
  await assert.rejects(f.create(release), status(409));
  await assert.rejects(f.call("POST", `/v1/updates/rollouts/${(await f.call("GET", "/v1/updates/rollouts")).rollouts[0].id}/cancel`), status(409));
});

test("rollback needs exact first delivered baseline and observed activation, with readiness recovery from unknown", async t => {
  const f = fixture(t), release = signed(); await f.poll(); await f.call("POST", "/v1/updates/releases", release); await f.upload(release); await f.create(release);
  const boundBaseline = randomUUID(), job = (await f.poll({ currentReleaseId: boundBaseline })).job;
  assert.equal(f.phase(job.id).previous_release, boundBaseline);
  await f.poll({ currentReleaseId: f.previous }); assert.equal(f.phase(job.id).previous_release, boundBaseline);
  for (const [i, state] of ["draining", "downloading", "staged", "activating", "unknown"].entries()) await f.report(job, i + 1, state);
  await assert.rejects(f.report(job, 6, "rolledBack", { installedReleaseId: f.previous }), status(409));
  await f.report(job, 6, "verifying");
  await f.report(job, 7, "rolledBack", { installedReleaseId: boundBaseline });
  assert.equal(f.drainCount(), 0); assert.equal(f.phase(job.id).previous_release, boundBaseline);
});

test("pre-effect failure requires a positive baseline receipt; unknown and activation make it unsafe", async t => {
  const f = fixture(t), { job } = await f.assigned();
  await f.report(job, 1, "draining");
  await assert.rejects(f.report(job, 2, "failed"), status(409));
  await assert.rejects(f.report(job, 2, "failed", { installedReleaseId: randomUUID() }), status(409));
  await f.report(job, 2, "failed", { installedReleaseId: f.previous }); assert.equal(f.drainCount(), 0);
  const second = await f.assigned(signed(3));
  for (const [i, state] of ["draining", "downloading", "staged", "activating"].entries()) await f.report(second.job, i + 1, state);
  await assert.rejects(f.report(second.job, 5, "cancelled", { installedReleaseId: f.previous }), status(409));
  assert.equal(f.drainCount(), 1);
});

test("initial unmanaged baseline cannot claim rollback, and missing baseline proof never clears drain", async t => {
  const f = fixture(t), release = signed();
  await f.poll({ currentReleaseId: undefined }); await f.call("POST", "/v1/updates/releases", release); await f.upload(release); await f.create(release);
  const job = (await f.poll({ currentReleaseId: undefined })).job;
  await assert.rejects(f.report(job, 1, "failed"), status(409));
  await f.report(job, 1, "failed", { installedReleaseId: null }); assert.equal(f.drainCount(), 0);
  const next = signed(3); await f.call("POST", "/v1/updates/releases", next); await f.create(next);
  const nextJob = (await f.poll({ currentReleaseId: undefined })).job;
  for (const [i, state] of ["draining", "downloading", "staged", "activating"].entries()) await f.report(nextJob, i + 1, state);
  await assert.rejects(f.report(nextJob, 5, "rolledBack", { installedReleaseId: null }), status(409));
  assert.equal(f.drainCount(), 1);
});

test("admin cancellation is an atomic exact replay only for never-delivered jobs", async t => {
  const f = fixture(t), release = signed(); await f.poll(); await f.call("POST", "/v1/updates/releases", release); await f.upload(release);
  const rollout = await f.create(release), url = `/v1/updates/rollouts/${rollout.id}/cancel`;
  assert.equal((await f.call("POST", url)).jobs[0].state, "cancelled");
  assert.equal((await f.call("POST", url)).jobs[0].state, "cancelled"); assert.equal(f.drainCount(), 0);
  const next = await f.create(release); await f.poll();
  await assert.rejects(f.call("POST", `/v1/updates/rollouts/${next.id}/cancel`), status(409)); assert.equal(f.drainCount(), 1);
});

test("host authority, installation, attempt, and job scoped downloads reject cross-host and retired identities", async t => {
  const f = fixture(t), { release, job } = await f.assigned(), other = randomUUID(), otherKey = token();
  f.machines.enroll({ id: other, credential: otherKey, offer: f.offer }, f.options.enrollmentToken!);
  await assert.rejects(f.poll({}, f.options.adminToken), status(401));
  await assert.rejects(f.poll({ installationId: randomUUID() }), status(409));
  await assert.rejects(f.report(job, 1, "draining", {}, otherKey, other), status(404));
  await assert.rejects(f.report(job, 1, "draining", { attemptId: randomUUID() }), status(409));
  await assert.rejects(f.report(job, 2, "draining"), status(409));
  const url = `/v1/updates/artifacts/${release.manifest.files[0]!.sha256}?jobId=${job.id}&offset=0&length=1`;
  await assert.rejects(f.call("GET", url, {}, otherKey), status(401));
  await assert.rejects(f.call("GET", url, {}, f.options.adminToken), status(401));
  await assert.rejects(f.call("GET", `/v1/updates/artifacts/${"f".repeat(64)}?jobId=${job.id}&offset=0&length=1`, {}, f.credential), status(404));
  f.store.transaction(db => { db.prepare("INSERT INTO retired_runners(id,target) VALUES (?,?)").run(f.host, randomUUID()); });
  await assert.rejects(f.poll(), status(403)); await assert.rejects(f.call("GET", url, {}, f.credential), status(403));
  assert.equal(f.phase(job.id).phase, "unknown"); assert.equal(f.drainCount(), 1);
});

test("current administrator authority is resolved inside the outer write transaction, including replay and reads", async t => {
  const f = fixture(t), accounts = new Accounts(f.store);
  const session = await accounts.setup({ username: "admin", password: "disposable administrator password" });
  const principal = () => accounts.principal(session.token);
  const release = signed();
  // principal() sees a nested store transaction. Its caller must already hold the
  // SQLite write boundary, so a concurrent disable cannot race between auth/effect.
  let inside = false;
  f.store.addTransactionHook(db => { assert.equal(db.isTransaction, true); inside = true; });
  const checked = () => { assert.equal(inside, true); return principal(); };
  await f.call("POST", "/v1/updates/releases", release, session.token, checked);
  f.store.transaction(db => db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(session.user.id));
  for (const [method, url, body] of [["GET", "/v1/updates/releases", {}], ["POST", "/v1/updates/releases", release], ["GET", "/v1/updates/rollouts", {}]] as const) await assert.rejects(f.call(method, url, body, session.token, principal), status(401));
  const reader = () => ({ kind: "token" as const, user: { id: randomUUID(), username: "reader", role: "admin" as const, status: "active" }, scopes: ["machines:read"] });
  await assert.rejects(f.call("POST", "/v1/updates/releases", signed(3), token(), reader), status(403));
});

function runner(f: ReturnType<typeof fixture>) {
  const service = new RunnerEnrollment(f.store, f.options.controllerId), binding = { controllerId: f.options.controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() }, credential = token();
  const id = randomUUID(), issued = service.issue({ id, ...binding, ttlSeconds: 100 }) as { enrollmentToken: string };
  service.consume(issued.enrollmentToken, { id, ...binding, credential });
  const installationId = randomUUID();
  const poll = (extra: Json = {}, key = credential) => f.call("POST", `/v1/runners/${binding.runnerId}/updates/poll`, { binding, installationId, target: platform, launcherVersion: 1, currentReleaseId: f.previous, ...extra }, key);
  const report = (job: Json, sequence: number, state: string, extra: Json = {}, key = credential) => f.call("POST", `/v1/runners/${binding.runnerId}/updates/report`, { binding, jobId: job.id, attemptId: job.attemptId, sequence, state, ...extra }, key);
  return { service, binding, credential, poll, report };
}

test("runner rollouts bind generation/incarnation/revision and never cross credential kinds", async t => {
  const f = fixture(t), r = runner(f), release = signed();
  await r.poll(); await f.poll(); await f.call("POST", "/v1/updates/releases", release); await f.upload(release);
  const rollout = await f.create(release, { runnerIds: [r.binding.runnerId] });
  assert.equal(rollout.jobs.length, 2);
  const job = (await r.poll()).job; assert.equal(rollout.jobs.find((j: Json) => j.targetKind === "runner").runnerId, r.binding.runnerId);
  await assert.rejects(r.poll({}, f.credential), status(401));
  await assert.rejects(f.poll({}, r.credential), status(401));
  await assert.rejects(r.poll({ binding: { ...r.binding, generation: 2 } }), status(401));
  await assert.rejects(r.report(job, 1, "draining", { binding: { ...r.binding, incarnationId: randomUUID() } }), status(401));
  const url = `/v1/updates/artifacts/${release.manifest.files[0]!.sha256}?jobId=${job.id}&offset=0&length=1`;
  assert.equal((await f.call("GET", url, {}, r.credential)).offset, 0);
  await assert.rejects(f.call("GET", url, {}, f.credential), status(401));
  for (const [i, state] of ["draining", "downloading", "staged", "activating", "verifying"].entries()) await r.report(job, i + 1, state);
  await r.report(job, 6, "succeeded", { installedReleaseId: release.manifest.releaseId });
  assert.equal(f.drainCount(), 1); // The independently assigned legacy host remains drained.
});

test("runner rotation/revocation preserve unknown drain and reject stale or new authority on the old attempt", async t => {
  const f = fixture(t), r = runner(f), release = signed(); await r.poll(); await f.call("POST", "/v1/updates/releases", release); await f.upload(release);
  await f.create(release, { hostIds: [], runnerIds: [r.binding.runnerId] });
  const job = (await r.poll()).job; await r.report(job, 1, "draining");
  const replacement = token(); r.service.manage({ ...r.binding, credentialRevision: 2, credential: replacement }, false);
  assert.equal(f.phase(job.id).phase, "unknown");
  await assert.rejects(r.poll(), status(401)); await assert.rejects(r.poll({}, replacement), status(409));
  await assert.rejects(r.report(job, 2, "failed", { installedReleaseId: f.previous }, replacement), status(409));
  r.service.manage(r.binding, true);
  await assert.rejects(r.poll({}, replacement), status(401)); f.restart(); assert.equal(f.drainCount(), 1);
});

function startWorker(f: ReturnType<typeof fixture>, body: Json) {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const source = `const {parentPort,workerData}=await import('node:worker_threads');
    const {SqliteStore}=await import(workerData.storeUrl); const {createModule}=await import(workerData.moduleUrl);
    const module=createModule(new SqliteStore(workerData.path),workerData.options);
    parentPort.postMessage('ready'); parentPort.once('message',()=>{
      try { const result=module.handle({method:'POST',path:'/v1/updates/rollouts',parts:['v1','updates','rollouts'],query:new URLSearchParams(),body:workerData.body,token:workerData.options.adminToken,principal:()=>({kind:'operator',user:null,scopes:['admin']})});
        parentPort.postMessage({ok:true,body:result.body}); } catch(error) {parentPort.postMessage({ok:false,status:error.status});}
    });`;
  const worker = new Worker(source, { eval: true, workerData: { path: f.store.path, options: f.options, body, storeUrl: new URL(`../../src/sqlite.${extension}`, import.meta.url).href, moduleUrl: new URL(`../../src/control/updates.${extension}`, import.meta.url).href } });
  const ready = new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  const result = new Promise<Json>((resolve, reject) => { worker.on("message", message => { if (message !== "ready") resolve(message as Json); }); worker.once("error", reject); });
  return { worker, ready, result };
}

test("independent SQLite workers arbitrate overlapping rollouts and exact replay races", { timeout: 20000 }, async t => {
  const f = fixture(t), release = signed(); await f.poll(); await f.call("POST", "/v1/updates/releases", release); await f.upload(release);
  const body = { id: randomUUID(), releaseId: release.manifest.releaseId, hostIds: [f.host] };
  const workers = [startWorker(f, body), startWorker(f, body)];
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.worker.postMessage("go"));
    const results = await Promise.all(workers.map(w => w.result));
    assert.ok(results.every(r => r.ok)); assert.deepEqual(results[0]!.body, results[1]!.body);
  } finally { await Promise.all(workers.map(w => w.worker.terminate())); }
  await f.call("POST", `/v1/updates/rollouts/${body.id}/cancel`);
  const competing = [startWorker(f, { ...body, id: randomUUID() }), startWorker(f, { ...body, id: randomUUID() })];
  try {
    await Promise.all(competing.map(w => w.ready)); competing.forEach(w => w.worker.postMessage("go"));
    const results = await Promise.all(competing.map(w => w.result)); assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.find(r => !r.ok)!.status, 409);
  } finally { await Promise.all(competing.map(w => w.worker.terminate())); }
  assert.equal(f.drainCount(), 1);
});

test('component ledger requires independent evidence, exact inventory, ordered receipts and retains uncertain drains', async t => {
  const f = fixture(t), { release, job } = await f.assigned();
  let n = 0;
  for (const state of ['draining', 'downloading', 'staged', 'activating', 'verifying', 'succeeded']) await f.report(job, ++n, state, state === 'succeeded' ? { installedReleaseId: release.manifest.releaseId } : {});
  const { componentFileSetDigest } = await import('../../src/updates/components.ts');
  const one = { component: 'guest' as const, machineId: randomUUID(), assignmentId: randomUUID(), bootId: randomUUID(), generation: 1 };
  const two = { ...one, machineId: randomUUID(), assignmentId: randomUUID() };
  let targets = [one, two], ack = true;
  const context = { jobId: job.id, attemptId: job.attemptId, installationId: f.installationId, releaseId: release.manifest.releaseId };
  const plan = () => f.call('POST', `/v1/hosts/${f.host}/updates/component-plan`, { ...context, targets }, f.credential);
  assert.deepEqual(await plan(), { accepted: false, pending: true });
  f.options.componentEvidence = { targets: () => targets, acknowledged: () => ack }; f.restart();
  assert.equal((await plan()).accepted, true);
  const send = (sequence: number, state: string, target = one, patch: Json = {}) => f.call('POST', `/v1/hosts/${f.host}/updates/component-report`, { ...context, target, fileSetDigest: componentFileSetDigest(release.manifest, 'guest'), sequence, state, evidence: state === 'adopted' ? { boundary: 'idle-closed', acknowledgement: 'a'.repeat(64) } : null, ...patch }, f.credential);
  await assert.rejects(send(2, 'intent'), status(409));
  await assert.rejects(send(1, 'intent', { ...one, bootId: randomUUID() }), status(409));
  await assert.rejects(send(1, 'intent', one, { fileSetDigest: 'b'.repeat(64) }), status(409));
  const intent = await send(1, 'intent'); assert.equal(intent.job.state, 'unknown'); assert.equal(intent.job.hostState, 'succeeded'); assert.equal(f.drainCount(), 1);
  f.restart(); assert.deepEqual(await send(1, 'intent'), intent);
  await assert.rejects(send(1, 'unknown'), status(409));
  ack = false; await assert.rejects(send(2, 'adopted'), status(409));
  ack = true; const partial = await send(2, 'adopted'); assert.equal(partial.job.components.guest, 'partial'); assert.equal(partial.job.components['native-helper'], 'pendingNativeReceipt');
  await send(3, 'intent', two); await send(4, 'unknown', two); assert.equal(f.drainCount(), 1);
  const held = f.phase(job.id);
  for (const [state, installedReleaseId] of [['rolledBack', f.previous], ['unknown', undefined], ['verifying', undefined], ['succeeded', release.manifest.releaseId]] as const) {
    await assert.rejects(f.report(job, n + 1, state, installedReleaseId === undefined ? {} : { installedReleaseId }), status(409));
    assert.deepEqual(f.phase(job.id), held);
    assert.equal(f.drainCount(), 1);
  }
  const replay = await f.report(job, n, 'succeeded', { installedReleaseId: release.manifest.releaseId });
  assert.equal(replay.accepted, true);
  assert.deepEqual(f.phase(job.id), held);
  assert.equal(f.drainCount(), 1);
  targets = [one, { ...two, generation: 2 }]; await assert.rejects(send(5, 'adopted', two), status(409));
  targets = [one, two]; const done = await send(5, 'adopted', two); assert.equal(done.job.components.guest, 'ready'); assert.equal(done.job.componentTargets.length, 2); assert.equal(f.drainCount(), 0);
  f.store.transaction(db => db.prepare('UPDATE hosts SET credential=? WHERE id=?').run('c'.repeat(64), f.host));
  await assert.rejects(send(5, 'adopted', two), status(401));
});

test('component evidence and credentials are checked inside the effect transaction', async t => {
  const f = fixture(t), { release, job } = await f.assigned();
  let n = 0; for (const state of ['draining','downloading','staged','activating','verifying','succeeded']) await f.report(job, ++n, state, state === 'succeeded' ? { installedReleaseId: release.manifest.releaseId } : {});
  const target = { component: 'guest' as const, machineId: randomUUID(), assignmentId: randomUUID(), bootId: randomUUID(), generation: 1 };
  f.options.componentEvidence = { targets: db => { assert.equal(db.isTransaction, true); return [target]; }, acknowledged: () => true }; f.restart();
  const body = { jobId: job.id, attemptId: job.attemptId, installationId: f.installationId, releaseId: release.manifest.releaseId, targets: [target] };
  await f.call('POST', `/v1/hosts/${f.host}/updates/component-plan`, body, f.credential);
  const currentModule = createModule(f.store, f.options);
  f.store.transaction(db => {
    db.prepare('UPDATE hosts SET enabled=0 WHERE id=?').run(f.host);
    assert.throws(() => currentModule.handle(request('POST', `/v1/hosts/${f.host}/updates/component-plan`, body, f.credential)), status(401));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM update_component_reports').get()!.n, 0);
  });
});
