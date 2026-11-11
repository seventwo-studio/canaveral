import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHost, HostRunner, hostOffer, hostTransport, startHost } from "../../src/host.ts";
import type { HostConfig, HostDependencies, HostTransport } from "../../src/host.ts";
import { normalizeTemplate } from "../../src/control/templates.ts";
import { readRecord, saveRecord, StateLock } from "../../src/runtime-process.ts";
import type { ExecutionClock, RecordValue } from "../../src/runtime-process.ts";
import { ServiceError } from "../../src/errors.ts";
const token = "a".repeat(43);
function setup(t: { after(fn: () => void | Promise<void>): void }): { config: HostConfig; image: RecordValue; clock: ExecutionClock & { mono: number; wallTime: number } } {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-host-runner-"))); t.after(() => rmSync(state, { recursive: true, force: true }));
  const image = { id: "fixture", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, image: "/private/local/disk.img" };
  const config: HostConfig = { name: "fixture", provider: "libvirt", templates: [image], storage: join(state, "disks"), capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 128 }, url: "http://127.0.0.1:1", stateDir: state, enrollmentToken: token, pollIntervalSeconds: .25 };
  const clock = { mono: 10, wallTime: 1000, suspendAware: true, now() { return this.mono; }, wall() { return this.wallTime; } };
  return { config, image, clock };
}
function machine(image: RecordValue): RecordValue { return { id: randomUUID(), templateId: image.id, template: normalizeTemplate(image), resources: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, desired: "running", observed: "unknown" }; }
function fakeTransport(reply: () => RecordValue = () => ({ machines: [] })): HostTransport { return { request: async (_method, path) => path.endsWith("heartbeat") ? reply() : {} }; }
const providerFactory: NonNullable<HostDependencies["providerFactory"]> = () => ({ kind: "libvirt", check: async () => ({}), reconcile: async m => ({ state: m.desired }) });
async function drain(): Promise<void> { await new Promise(r => setTimeout(r, 20)); }

test('physical Linux and Mac offers include models beside VM and simulator runtimes', t => {
  const { config } = setup(t);
  const inference = { runtime: 'ollama', executable: '/private/ollama', modelsDirectory: '/private/models', models: [{ id: 'fixture:1', digest: 'sha256:' + 'a'.repeat(64), resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }] };
  for (const [provider, runtimes] of [['macos', { apple: {}, ios: {} }], ['linux', { libvirt: {}, android: {} }]] as const) {
    const offer = hostOffer({ ...config, provider, templates: [], runtimes, inference });
    assert.deepEqual((offer.inference as { models: unknown[] }).models, inference.models.map(model => ({ ...model, capability: 'generation' })));
    assert.equal(JSON.stringify(offer).includes('/private/'), false);
    assert.throws(() => hostOffer({ ...config, provider, templates: [], runtimes, inference, leaseProtocol: 1 }));
  }
  assert.throws(() => hostOffer({ ...config, provider: 'windows', templates: [], runtimes: { hyperv: {} }, inference }));
});

test("enrollment persists one private identity before lost response, retries exactly, and reconnects without enrollment", async t => {
  const { config, clock } = setup(t); let attempts = 0; const enrollments: RecordValue[] = [];
  const transport: HostTransport = { request: async (_m, path, body) => { if (path.endsWith("enroll")) { enrollments.push(body); attempts++; if (attempts === 1) throw new Error("lost reply"); } return { machines: [] }; } };
  const first = new HostRunner(config, { transport, clock, providerFactory }); await assert.rejects(first.connect());
  const identity = readRecord(join(config.stateDir, "identity.json")); assert.equal(statSync(join(config.stateDir, "identity.json")).mode & 0o777, 0o600);
  await first.connect(); assert.deepEqual(enrollments[0], enrollments[1]); assert.equal(first.identity?.id, identity.id);
  const restored = new HostRunner({ ...config, enrollmentToken: undefined } as unknown as HostConfig, { transport, clock, providerFactory }); await restored.connect(); assert.equal(attempts, 2); assert.equal(restored.identity?.id, identity.id); await first.close(); await restored.close();
});
test("wrong controller and invalid trust bundle cannot replace a saved host identity", async t => {
  const { config } = setup(t), runner = new HostRunner(config, { transport: fakeTransport() }); await runner.connect(); const before = readRecord(join(config.stateDir, "identity.json"));
  const other = new HostRunner({ ...config, url: "http://127.0.0.1:2" }, { transport: fakeTransport() }); await assert.rejects(other.connect()); assert.deepEqual(readRecord(join(config.stateDir, "identity.json")), before);
  assert.throws(() => new HostRunner({ ...config, caFile: join(config.stateDir, "missing.pem") })); await runner.close(); await other.close();
});
test("heartbeat uses current on-disk credential, dispatch freshness, exact report fields and cached telemetry", async t => {
  const { config, clock } = setup(t); let heartbeatToken = "", body: RecordValue = {};
  const transport: HostTransport = { request: async (_m, path, data, auth) => { if (path.endsWith("heartbeat")) { body = data; heartbeatToken = auth; clock.mono += 21; } return { machines: [] }; } };
  const runner = new HostRunner(config, { transport, clock, providerFactory }); await runner.connect();
  const identity = readRecord(join(config.stateDir, "identity.json")); saveRecord(join(config.stateDir, "identity.json"), { ...identity, credential: "b".repeat(43) });
  await runner.collectResources(); await runner.poll(); assert.equal(heartbeatToken, "b".repeat(43)); assert.equal(runner.lastContact, 10); assert.equal(runner.fresh(), false); assert.equal("sessionReports" in body, false); assert.ok(body.resources); assert.equal(JSON.stringify(body).includes("/private/local"), false); await runner.close();
});
test("bounded reconciliation continues independent heartbeat polling while provider is occupied", async t => {
  const { config, image, clock } = setup(t), assigned = [machine(image), machine(image), machine(image)]; let started = 0, polls = 0; const releases: Array<() => void> = [];
  const runner = new HostRunner({ ...config, concurrency: 2 }, { clock, transport: { request: async (_m, path) => { if (path.endsWith("heartbeat")) polls++; return { machines: assigned }; } }, providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => { started++; await new Promise<void>(r => releases.push(r)); return { state: "running" }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll(); await runner.step(); await drain(); assert.equal(started, 2);
  await runner.poll(); assert.equal(polls, 2); await runner.step(); assert.equal(started, 2);
  releases.forEach(r => r()); await drain(); await runner.close();
});
test("stopped reconciliation bypasses guest preparation and credentials; template and ownership changes are refused", async t => {
  const { config, image } = setup(t), m: RecordValue = { ...machine(image), desired: "stopped" }; let calls = 0;
  const local = { ...image, prepare: { driver: "ssh", commands: ["false"] } }; m.template = normalizeTemplate(local);
  const runner = new HostRunner({ ...config, templates: [local] }, { transport: fakeTransport(), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => { calls++; return { state: "stopped" }; } }) });
  await runner.initializeProviders(); assert.equal((await runner.reconcile(m)).state, "stopped"); assert.equal(calls, 1);
  const folder = join(config.stateDir, "machines", String(m.id)); assert.throws(() => statSync(join(folder, "guest-token.json")));
  saveRecord(join(folder, "assignment.json"), { fingerprint: "foreign" }); await assert.rejects(runner.reconcile(m)); assert.equal(calls, 1); await runner.close();
});
test("durable interrupted device effects become unknown and never replay after restart", async t => {
  const { config, image, clock } = setup(t), m = machine(image), operation = { id: randomUUID(), machineId: m.id, action: "shell", arguments: { argv: ["private-value"] }, expiresAt: 1100 }; let calls = 0;
  const transport = fakeTransport(() => ({ machines: [m], deviceOperations: [operation] }));
  const factory: NonNullable<HostDependencies["providerFactory"]> = () => ({ kind: "libvirt", check: async () => ({}), reconcile: async () => ({ state: "running" }), operate: async () => { calls++; throw new Error("response lost"); } });
  const run = async (): Promise<HostRunner> => { const r = new HostRunner(config, { clock, transport, providerFactory: factory }); await r.initializeProviders(); await r.connect(); await r.checkEnvironment(); await r.poll(); r.reports.set(String(m.id), { state: "running" }); return r; };
  const first = await run(); await first.step(); await drain(); assert.equal(first.deviceReports.get(operation.id)?.state, "unknown"); await first.close();
  const second = await run(); await second.step(); await drain(); assert.equal(calls, 1); assert.equal(second.deviceReports.get(operation.id)?.state, "unknown"); await second.close();
});
test("lease configuration cannot enable unaccepted execution; offline only reconciles fenced stops", async t => {
  const { config, image, clock } = setup(t), id = randomUUID(), m: RecordValue = { ...machine(image), lease: { id, revision: 1, state: "ready", controllerNow: 1000, authorizationDeadline: 1060 } };
  assert.throws(() => hostOffer({ ...config, leaseProtocol: 1 })); assert.throws(() => hostOffer({ ...config, leaseImages: [] }));
  const requests: RecordValue[] = [];
  const runner = new HostRunner(config, { clock, transport: fakeTransport(() => ({ machines: [m, machine(image)] })), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async current => { requests.push(current); return { state: "stopped" }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.poll(); clock.mono = 70; await runner.step(); await drain(); assert.equal(requests.length, 1); assert.equal(requests[0]!.desired, "stopped"); assert.equal(requests[0]!.id, m.id); await runner.close();
});
test("failed provider startup closes earlier providers and releases runner lock", async t => {
  const { config } = setup(t); let closed = 0;
  await assert.rejects(startHost({ ...config, provider: "linux", templates: [], runtimes: { libvirt: {}, android: {} } }, { transport: fakeTransport(), providerFactory: options => { if (options.provider === "android") throw new Error("failure"); return { kind: "libvirt", check: async () => ({}), reconcile: async () => ({}), close: async () => { closed++; } }; } }));
  assert.equal(closed, 1); const lock = new StateLock(join(config.stateDir, "host-runner.sqlite")); lock.close();
});
test("offline environment checks never enroll or create identity", async t => {
  const { config } = setup(t); let contacts = 0; const result = await checkHost(config, { transport: { request: async () => { contacts++; return {}; } }, providerFactory }); assert.equal(result.status, "passed"); assert.equal(contacts, 0); assert.throws(() => statSync(join(config.stateDir, "identity.json")));
});
test("outbound HTTP refuses redirects and never forwards host bearer credentials", async t => {
  const { config } = setup(t); let redirected = false;
  const server = createServer((request, response) => { if (request.url === "/v1/redirected") redirected = true; response.writeHead(302, { Location: "/v1/redirected" }); response.end("{}"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise<void>((r, e) => server.close(error => error ? e(error) : r())));
  const address = server.address(); assert.ok(address && typeof address === "object"); const transport = hostTransport({ ...config, url: `http://127.0.0.1:${address.port}` });
  await assert.rejects(transport.request("POST", "/v1/hosts/enroll", {}, token)); assert.equal(redirected, false);
});

test("consolidated runtime guest callback overrides host URL during preparation", async t => {
  const { config, image, clock } = setup(t), local = { ...image, prepare: { driver: "cloud-init", commands: ["true"] } }, m = machine(local);
  let data = "";
  const runner = new HostRunner({ ...config, templates: [local], guestOrchestratorURL: "https://wrong.invalid" }, { clock, transport: fakeTransport(), providerFactory: () => ({ kind: "libvirt", config: { guestOrchestratorURL: "https://guests.example.test" }, check: async () => ({}), reconcile: async (_m, i) => { data = String(i._userData); return { state: "running" }; } }) });
  await runner.initializeProviders(); runner.assignments = [m]; runner.lastContact = 10;
  await runner.reconcile(m); assert.ok(data.includes("cloud-config")); assert.ok(Buffer.from(data.match(/"content":"([^"]+)"/)![1]!, "base64").toString().includes("https://guests.example.test")); assert.equal(data.includes("wrong.invalid"), false); await runner.close();
});
test("round robin reconciliation and reserved operation slots avoid starvation", async t => {
  const { config, image, clock } = setup(t), machines = [machine(image), machine(image), machine(image)], operation = { id: randomUUID(), machineId: machines[0]!.id, action: "shell", arguments: { argv: ["true"] }, expiresAt: 1100 }; const reconciled = new Set<string>(); let operated = 0;
  const runner = new HostRunner({ ...config, concurrency: 1 }, { clock, transport: fakeTransport(() => ({ machines, deviceOperations: [operation] })), providerFactory: () => ({ kind: "libvirt", check: async () => ({}), reconcile: async m => { reconciled.add(String(m.id)); return { state: "running" }; }, operate: async () => { operated++; return { state: "succeeded", result: {} }; } }) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  for (let i = 0; i < 5; i++) { await runner.step(); await drain(); }
  assert.equal(reconciled.size, 3); assert.equal(operated, 1); await runner.close();
});

test("guest preparation receives cloneable data and verified health determines access readiness", async t => {
  const { config, image, clock } = setup(t), local = { ...image, guestAccess: true, prepare: { driver: "cloud-init", commands: ["true"] } }, m = machine(local); let prepared = 0;
  const runner = new HostRunner({ ...config, templates: [local], guestOrchestratorURL: "https://controller.example.test" }, { clock, transport: fakeTransport(), providerFactory,
    guest: { prepare: async (_machine, definition) => { prepared++; return structuredClone(definition); }, control: async () => ({ ready: true, mode: "headless" }) } });
  await runner.initializeProviders(); runner.assignments = [m]; runner.lastContact = 10;
  const report = await runner.reconcile(m); assert.equal(prepared, 1); assert.equal(report.accessReady, true); assert.equal((report.preparation as RecordValue).state, "ready"); await runner.close();
});
