import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { InfrastructureStore } from "../../src/control/infrastructure.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig, HostTransport } from "../../src/host.ts";
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
