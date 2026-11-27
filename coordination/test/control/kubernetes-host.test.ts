import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createModule, InfrastructureStore } from "../../src/control/infrastructure.ts";
import { legacyDigest, normalizeTemplate } from "../../src/control/templates.ts";
import { ServiceError } from "../../src/errors.ts";
import { cleanupKubernetesEnrollment } from "../../src/host-bootstrap.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig, HostTransport } from "../../src/host.ts";
import { SupervisorJournal } from "../../src/providers/libvirt-ownership.ts";
import { readRecord, saveRecord, StateLock, unknownOutcome } from "../../src/runtime-process.ts";
import type { RecordValue } from "../../src/runtime-process.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { preflightManagedHost } from "../../src/updates/runtime.ts";

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kubernetes-host-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), bootstrap = join(stateDir, "bootstrap");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(bootstrap, { mode: 0o700 });
  const config: HostConfig = {
    deployment: "kubernetes", shutdownGraceSeconds: 1, url: "https://controller.example.test", stateDir,
    name: "node-one", provider: "native", templates: [], capacity: { cpu: 2, memoryMiB: 1024, diskGiB: 10 },
  };
  const path = join(bootstrap, "enrollment-token"), identity = join(stateDir, "identity.json");
  const intent = join(stateDir, "enrollment-intent.json");
  return { root, config, path, identity, intent };
}

test("Kubernetes enrollment recovers a consumed claim with the same request after restart", async t => {
  const { root, config, path, identity, intent } = fixture(t);
  let now = 1000;
  const db = new SqliteStore(join(root, "controller.sqlite"), () => now);
  const global = "g".repeat(43);
  const machines = new MachineStore(db, { adminToken: "a".repeat(43), enrollmentToken: global, controllerId: randomUUID() });
  const setups = new InfrastructureStore(db);
  const setup = setups.createSetup({ id: randomUUID(), name: config.name, provider: config.provider, capacity: config.capacity });
  const token = String(setup.enrollmentToken);
  writeFileSync(path, token + "\n", { mode: 0o600 });
  const requests: RecordValue[] = [];
  function enroll(endpoint: string, body: RecordValue, bearer: string) {
    assert.equal(endpoint, "/v1/hosts/enroll/setup");
    return machines.handle({
      method: "POST", path: endpoint, parts: endpoint.slice(1).split("/"), query: new URLSearchParams(),
      token: bearer, body, principal: () => assert.fail("A setup token has no operator authority"),
    })!.body as RecordValue;
  }
  const transport: HostTransport = { request: async (_method, endpoint, body, bearer) => {
    assert.equal(readRecord(intent).id, body.id);
    assert.equal(existsSync(identity), false);
    const reply = enroll(endpoint, body, bearer);
    requests.push(structuredClone(body));
    if (requests.length === 1) throw unknownOutcome("Lost enrollment response.");
    return reply;
  } };
  const first = new HostRunner(config, { transport });
  await assert.rejects(first.start(), { outcome: "unknown" });
  assert.equal(first.identity, undefined);
  assert.equal(existsSync(path), true);
  assert.equal(existsSync(identity), false);
  assert.equal(JSON.stringify(readRecord(intent)).includes(token), false);
  assert.throws(() => enroll("/v1/hosts/enroll/setup", requests[0]!, global), { status: 401 });
  assert.throws(() => enroll("/v1/hosts/enroll/setup", { ...requests[0], id: randomUUID() }, token), { status: 401 });

  now += 1801;
  const second = new HostRunner({ ...config, name: "changed while offline" }, { transport });
  await second.connect();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(readRecord(identity).id, requests[0]!.id);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(intent), false);
  assert.equal(db.read(sql => sql.prepare("SELECT id FROM hosts").all()).length, 1);

  symlinkSync(join(root, "missing"), path);
  const existing = new HostRunner(config, { transport: { request: async () => assert.fail("Existing identity must skip enrollment") } });
  await existing.connect();
  assert.deepEqual(existing.identity, second.identity);
  assert.equal(existsSync(intent), false);
});

test("Kubernetes enrollment refuses unsafe bootstrap files and a replaced pending credential", async t => {
  const { root, config, path, intent } = fixture(t);
  const token = "k".repeat(43);
  let issued = 0;
  const transport: HostTransport = { request: async () => { issued++; throw unknownOutcome(); } };
  const runner = new HostRunner(config, { transport });
  await assert.rejects(runner.connect(), { code: "kubernetes_bootstrap_token_invalid" });
  const file = join(root, "external");
  writeFileSync(file, token, { mode: 0o600 });
  for (const provision of [
    () => symlinkSync(file, path),
    () => linkSync(file, path),
    () => writeFileSync(path, token, { mode: 0o644 }),
    () => writeFileSync(path, token.repeat(7), { mode: 0o600 }),
    () => mkdirSync(path, { mode: 0o700 }),
  ]) {
    provision();
    await assert.rejects(runner.connect(), { code: "kubernetes_bootstrap_token_invalid" });
    rmSync(path, { recursive: true });
  }
  assert.equal(issued, 0);
  writeFileSync(path, token, { mode: 0o600 });
  await assert.rejects(runner.connect(), { outcome: "unknown" });
  const saved = readRecord(intent);
  writeFileSync(path, "x".repeat(43));
  await assert.rejects(runner.connect(), { code: "kubernetes_bootstrap_recovery_required" });
  assert.deepEqual(readRecord(intent), saved);
  assert.equal(issued, 1);
});

test("Kubernetes validates deployment and refuses containerd and managed activation", t => {
  const { config } = fixture(t);
  assert.throws(() => new HostRunner({ ...config, deployment: null } as unknown as HostConfig), { code: "invalid_request" });
  assert.throws(() => new HostRunner({ ...config, shutdownGraceSeconds: 0 }), { code: "invalid_request" });
  assert.throws(() => new HostRunner({ ...config, provider: "containerd" }), { code: "kubernetes_containerd_disabled" });
  assert.throws(() => new HostRunner({ ...config, provider: "linux", runtimes: { containerd: {} } }), { code: "kubernetes_containerd_disabled" });
  assert.throws(() => preflightManagedHost(config, {}), { code: "kubernetes_managed_updates_disabled" });
});

test("Kubernetes maintenance proves a stopped VM without racing reconciliation for its journal", async t => {
  const { config, identity, root } = fixture(t);
  const image = { id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless",
    minimum: { cpu: 1, memoryMiB: 512, diskGiB: 1 }, image: join(root, "base.img") };
  const machine = { id: randomUUID(), templateId: image.id, template: normalizeTemplate(image),
    resources: image.minimum, desired: "stopped", observed: "stopped" };
  saveRecord(identity, { id: randomUUID(), orchestrator: config.url, credential: "k".repeat(43) });
  const drainId = randomUUID();
  let draining = false, challenge = 0, proof: RecordValue | undefined;
  const transport: HostTransport = { request: async (_method, _endpoint, body) => {
    proof = (body.maintenance as { proof?: RecordValue }).proof;
    return { machines: [machine], ...(draining ? { maintenance: { version: 1, phase: "draining",
      drainId, challenge: (++challenge).toString(16).padStart(64, "0") } } : {}) };
  } };
  let reconciles = 0, nativeStopped = true;
  const latch = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const checking = latch(), releaseCheck = latch(), checked = [latch(), latch()];
  let probes = 0;
  const runner = new HostRunner({ ...config, provider: "libvirt", socketPath: "/run/canaveral/libvirt-sock",
    templates: [image], storage: join(root, "disks") }, { transport, providerFactory: () => ({
    kind: "libvirt",
    check: async () => ({}),
    maintenanceStorage: async () => "present",
    async reconcile(_machine, _image, folder) {
      reconciles++;
      const journal = new SupervisorJournal(folder, "libvirt-reconcile", { fixture: true });
      try { return { state: "stopped" }; } finally { journal.close(); }
    },
    async updateStopped(_machine: RecordValue, _image: RecordValue, folder: string, readOnly?: boolean) {
      assert.equal(readOnly, true);
      const done = checked[probes++];
      const journal = new SupervisorJournal(folder, "libvirt-reconcile", { fixture: true, existingOnly: true });
      try {
        checking.resolve();
        await releaseCheck.promise;
        return nativeStopped;
      } finally { journal.close(); done?.resolve(); }
    },
  }) });
  t.after(async () => { releaseCheck.resolve(); await runner.close(); });
  await runner.initializeProviders(); await runner.connect();
  await runner.poll(); await runner.step(); await nextTurn();

  draining = true;
  await runner.poll(); await checking.promise;
  await runner.step();
  assert.equal(reconciles, 1, "reconciliation must wait while the stop probe owns the journal");
  releaseCheck.resolve(); await checked[0]!.promise; await nextTurn();
  await runner.step();
  assert.equal(reconciles, 1, "keep the stop proof current until the heartbeat sends it");

  nativeStopped = false;
  await runner.poll();
  assert.equal(proof?.challenge, "1".padStart(64, "0"));
  assert.equal(proof?.idle, true); assert.equal(proof?.workloadsStopped, true);
  // A failed native probe releases the reservation for another reconciliation.
  await checked[1]!.promise; await nextTurn();
  await runner.step();
  assert.equal(reconciles, 2);
  await runner.poll();
  assert.equal(proof?.idle, false); assert.equal(proof?.workloadsStopped, false);
});

test("Kubernetes shutdown is shared across callers and requires positive quiescence", async t => {
  const { config, identity } = fixture(t);
  saveRecord(identity, { id: randomUUID(), orchestrator: config.url, credential: "k".repeat(43) });
  const runner = await new HostRunner(config, { transport: { request: async () => ({ machines: [] }) } }).start();
  await runner.poll();
  const first = runner.close();
  assert.equal(runner.updateAdmissionFenced, true);
  assert.equal(runner.close(), first);
  await first;
  new StateLock(join(config.stateDir, "host-runner.sqlite")).close();
});

test("Kubernetes shutdown times out with retained state and no second owner", async t => {
  const { config, identity } = fixture(t);
  saveRecord(identity, { id: randomUUID(), orchestrator: config.url, credential: "k".repeat(43) });
  let finish: (() => void) | undefined;
  const runner = await new HostRunner(config, {
    transport: { request: async () => ({ machines: [] }) },
    inference: { execute: async () => ({}), close: () => new Promise<void>(resolve => { finish = resolve; }) },
  }).start();
  await runner.poll();
  await assert.rejects(runner.close(), { code: "host_shutdown_incomplete", outcome: "unknown" });
  assert.equal(existsSync(identity), true);
  const lock = join(config.stateDir, "host-runner.sqlite");
  assert.throws(() => new StateLock(lock));
  assert.ok(finish);
  finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  new StateLock(lock).close();
});

test("termination during enrollment keeps the pending claim and releases its lock after the request settles", async t => {
  const { config, path, identity, intent } = fixture(t);
  const token = "k".repeat(43);
  writeFileSync(path, token, { mode: 0o600 });
  let started: (() => void) | undefined;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const transport: HostTransport = { request: async (_method, _endpoint, _body, _token, signal) => {
    started!();
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(unknownOutcome()), { once: true }));
  } };
  const controller = new AbortController();
  const pending = new HostRunner(config, { transport }).start(controller.signal);
  await dispatched;
  controller.abort();
  await assert.rejects(pending, { code: "host_shutdown_incomplete" });
  assert.equal(existsSync(identity), false);
  assert.equal(existsSync(intent), true);
  assert.equal(existsSync(path), true);
  new StateLock(join(config.stateDir, "host-runner.sqlite")).close();
});

function leftover(f: ReturnType<typeof fixture>, token = "t".repeat(43)) {
  const id = randomUUID(), credential = "c".repeat(43), orchestrator = f.config.url;
  saveRecord(f.identity, { id, credential, orchestrator });
  saveRecord(f.intent, { version: 1, tokenDigest: legacyDigest(token), id, credential, orchestrator, offer: {} });
  writeFileSync(f.path, token, { mode: 0o600 });
  return { id, credential, orchestrator, token };
}
const refuse: HostTransport = { request: async () => assert.fail("Existing identity must skip enrollment") };

test("Kubernetes start with an existing identity removes the matching leftover claim and token", async t => {
  const f = fixture(t);
  const saved = leftover(f);
  const logs: string[] = [];
  const runner = new HostRunner(f.config, { transport: refuse, log: message => logs.push(message) });
  await runner.connect();
  assert.equal(runner.identity?.id, saved.id);
  assert.equal(existsSync(f.intent), false);
  assert.equal(existsSync(f.path), false);
  assert.deepEqual(logs, []);
});

test("Kubernetes start keeps leftovers that do not match the identity or claim", async t => {
  const f = fixture(t);
  for (const mismatch of [{ id: randomUUID() }, { credential: "d".repeat(43) }, { orchestrator: "https://other.example.test" }]) {
    const saved = leftover(f);
    saveRecord(f.intent, { version: 1, tokenDigest: legacyDigest(saved.token), id: saved.id, credential: saved.credential, orchestrator: saved.orchestrator, offer: {}, ...mismatch });
    await new HostRunner(f.config, { transport: refuse }).connect();
    assert.equal(existsSync(f.intent), true);
    assert.equal(existsSync(f.path), true);
    rmSync(f.intent); rmSync(f.path);
  }
  // A token that is not the claim's token stays; the matching claim itself is retired.
  leftover(f);
  writeFileSync(f.path, "u".repeat(43), { mode: 0o600 });
  await new HostRunner(f.config, { transport: refuse }).connect();
  assert.equal(existsSync(f.intent), false);
  assert.equal(readFileSync(f.path, "utf8"), "u".repeat(43));
  rmSync(f.path);
  // Unsafe claim files are never trusted: link and broad mode.
  for (const unsafe of [() => chmodSync(f.intent, 0o644), () => { rmSync(f.intent); symlinkSync(f.identity, f.intent); }]) {
    leftover(f);
    unsafe();
    await new HostRunner(f.config, { transport: refuse }).connect();
    assert.equal(existsSync(f.path), true);
    assert.equal(existsSync(f.intent), true);
    rmSync(f.intent); rmSync(f.path);
  }
});

test("Kubernetes cleanup failures after the identity commit are logged and never fail startup", async t => {
  const f = fixture(t);
  const token = "t".repeat(43);
  writeFileSync(f.path, token, { mode: 0o600 });
  const logs: string[] = [];
  // Crash between steps: removal of the token fails because the bootstrap directory became unsafe.
  const transport: HostTransport = { request: async (_method, _endpoint, body) => { chmodSync(dirname(f.path), 0o500); return { id: body.id }; } };
  const first = new HostRunner(f.config, { transport, log: message => logs.push(message) });
  try { await first.connect(); } finally { chmodSync(dirname(f.path), 0o700); }
  assert.equal(first.identity?.id, readRecord(f.identity).id);
  assert.equal(existsSync(f.path), true);
  assert.equal(existsSync(f.intent), true);
  assert.equal(logs.length, 1);
  assert.equal(JSON.stringify(logs).includes(token), false);
  // Next start finishes the cleanup without contacting the controller.
  await new HostRunner(f.config, { transport: refuse }).connect();
  assert.equal(existsSync(f.path), false);
  assert.equal(existsSync(f.intent), false);
});

test("Kubernetes cleanup keeps the claim when removing the token fails and tolerates failing removal", t => {
  const f = fixture(t), saved = leftover(f), logs: string[] = [];
  const failing = (): never => { throw new Error("EIO"); };
  assert.doesNotThrow(() => cleanupKubernetesEnrollment(f.config.stateDir, saved, message => logs.push(message), failing));
  assert.equal(existsSync(f.intent), true);
  assert.equal(existsSync(f.path), true);
  assert.equal(logs.length, 1);
  assert.doesNotThrow(() => cleanupKubernetesEnrollment(f.config.stateDir, saved, () => { throw new Error("log failed"); }, failing));
  // Token already gone, intent removal fails: still log-only.
  rmSync(f.path);
  assert.doesNotThrow(() => cleanupKubernetesEnrollment(f.config.stateDir, saved, message => logs.push(message), failing));
  assert.equal(existsSync(f.intent), true);
  cleanupKubernetesEnrollment(f.config.stateDir, saved);
  assert.equal(existsSync(f.intent), false);
});

test("a rejected claim reports an explicit recoverable code and keeps the intent", async t => {
  const f = fixture(t), first = "k".repeat(43), second = "m".repeat(43);
  writeFileSync(f.path, first, { mode: 0o600 });
  const calls: string[] = [];
  const transport: HostTransport = { request: async (_method, _endpoint, body, bearer) => {
    calls.push(bearer);
    if (bearer === first) throw new ServiceError("Setup credential is expired, revoked or already used.", 401);
    return { id: body.id };
  } };
  const runner = new HostRunner(f.config, { transport });
  await assert.rejects(runner.connect(), (error: ServiceError) => error.code === "kubernetes_bootstrap_intent_rejected" && error.status === 409 && /enrollment-intent\.json/.test(error.message));
  const saved = readRecord(f.intent);
  // A replacement token alone is refused: the saved claim may correspond to a lost success.
  writeFileSync(f.path, second, { mode: 0o600 });
  await assert.rejects(runner.connect(), { code: "kubernetes_bootstrap_recovery_required" });
  assert.deepEqual(readRecord(f.intent), saved);
  assert.deepEqual(calls, [first]);
  // Operator recovery: no host was enrolled for that id, so retire the intent and provide the new token.
  rmSync(f.intent);
  await runner.connect();
  assert.equal(runner.identity?.id === saved.id, false);
  assert.deepEqual(calls, [first, second]);
  assert.equal(existsSync(f.intent), false);
  assert.equal(existsSync(f.path), false);
  // A malformed reply is not a rejection.
  const f2 = fixture(t);
  writeFileSync(f2.path, first, { mode: 0o600 });
  await assert.rejects(new HostRunner(f2.config, { transport: { request: async () => ({ id: randomUUID() }) } }).connect(), { code: "kubernetes_bootstrap_recovery_required" });
});

test("native setup tokens stay admin-minted, single-claim, 30-minute and bound on the legacy enrollment route", t => {
  const f = fixture(t), now = { value: 1000 };
  const db = new SqliteStore(join(f.root, "legacy.sqlite"), () => now.value);
  const global = "g".repeat(43);
  const machines = new MachineStore(db, { adminToken: "a".repeat(43), enrollmentToken: global, controllerId: randomUUID() });
  const setups = new InfrastructureStore(db);
  const spec = { name: "native-host", provider: "native", capacity: { cpu: 2, memoryMiB: 1024, diskGiB: 10 } };
  const issued = setups.createSetup({ id: randomUUID(), ...spec });
  const token = String(issued.enrollmentToken);
  assert.equal(issued.expiresAt, now.value + 1800);
  const offer = { ...spec, templates: [] };
  const host = randomUUID(), credential = "h".repeat(43);
  const legacy = (bearer: string, body: RecordValue) => machines.handle({
    method: "POST", path: "/v1/hosts/enroll", parts: ["v1", "hosts", "enroll"], query: new URLSearchParams(),
    token: bearer, body, principal: () => assert.fail("A setup token has no operator authority"),
  })!.body as RecordValue;
  // Minting is admin-only: setup tokens cannot mint more setups.
  const module = createModule(db, { adminToken: "a".repeat(43), controllerId: randomUUID() });
  assert.throws(() => module.handle({ method: "POST", path: "/v1/connection-setups", parts: ["v1", "connection-setups"], query: new URLSearchParams(), token, body: { id: randomUUID(), ...spec }, principal: () => { throw new Error("Not an account credential."); } }));
  // Bound to name, provider and capacity.
  for (const changed of [{ name: "renamed" }, { provider: "libvirt" }, { capacity: { cpu: 4, memoryMiB: 1024, diskGiB: 10 } }]) {
    assert.throws(() => legacy(token, { id: host, credential, offer: { ...offer, ...changed } }), { status: 403 });
  }
  // Single claim by one host identity, retried idempotently; another identity is refused.
  assert.deepEqual(legacy(token, { id: host, credential, offer }), { id: host });
  assert.deepEqual(legacy(token, { id: host, credential, offer }), { id: host });
  assert.throws(() => legacy(token, { id: randomUUID(), credential, offer }), { status: 401 });
  // Expiry applies only before the claim; revocation applies always.
  const second = setups.createSetup({ id: randomUUID(), ...spec });
  now.value += 1801;
  assert.throws(() => legacy(String(second.enrollmentToken), { id: randomUUID(), credential, offer }), { status: 401 });
  const third = setups.createSetup({ id: randomUUID(), ...spec });
  setups.revokeSetup(String(third.id));
  assert.throws(() => legacy(String(third.enrollmentToken), { id: randomUUID(), credential, offer }), { status: 401 });
});
