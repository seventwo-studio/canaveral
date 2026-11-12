import { ResourceDomains } from "../../src/resource-domains.ts";
import { PhysicalDomains } from "../../src/physical-domains.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { authenticateSetup, claimSetup, clusterResources, consolidateLocalRuntimes, createModule, healthReady, hostHealth, InfrastructureStore, inspectHost, podUsage, ProcessUsageCollector, quantity, recordHostImages, recordInfrastructure, validateCluster, validateHealth, validateSample } from "../../src/control/infrastructure.ts";
import { legacyDigest, normalizeTemplate } from "../../src/control/templates.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
const capacity = { cpu: 8, memoryMiB: 8192, diskGiB: 100 }, size = { cpu: 2, memoryMiB: 1024, diskGiB: 8 };
const template = () => normalizeTemplate({ id: "development", revision: "1", os: "linux", arch: "arm64", mode: "headless", minimum: size });
const offer = () => ({ name: "Host", provider: "libvirt", capacity, templates: [template()] });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-infrastructure-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000; const store = new SqliteStore(join(dir, "db"), () => now);
  store.transaction(db => db.exec(`
    CREATE TABLE hosts(id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE machines(id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE templates(id TEXT,revision TEXT,arch TEXT,definition TEXT,PRIMARY KEY(id,revision,arch));
    CREATE TABLE images(id TEXT PRIMARY KEY,host TEXT NOT NULL,metadata TEXT NOT NULL);
    CREATE TABLE image_tasks(id TEXT PRIMARY KEY,host TEXT NOT NULL,state TEXT NOT NULL,reserved_disk INTEGER NOT NULL);
    CREATE TABLE inference_jobs(id TEXT PRIMARY KEY,host TEXT NOT NULL,state TEXT NOT NULL,definition TEXT NOT NULL);
    CREATE TABLE lease_members(lease TEXT,machine TEXT);
    CREATE TABLE machine_power_offs(machine TEXT,state TEXT);
    CREATE TABLE machine_deletions(machine TEXT,state TEXT);
    CREATE TABLE lease_cleanup_members(machine TEXT,state TEXT);
    CREATE TABLE device_operations(id TEXT PRIMARY KEY,host TEXT);
  `));
  const infrastructure = new InfrastructureStore(store), host = randomUUID(), credential = "c".repeat(43);
  function enroll(setupToken: string, id = host, persistent = credential, proposed: Record<string, unknown> = offer()) {
    return store.transaction(db => {
      claimSetup(db, setupToken, id, proposed, now);
      const old = db.prepare("SELECT credential FROM hosts WHERE id=?").get(id);
      if (old && old.credential !== legacyDigest(persistent)) throw new Error("Host credential mismatch.");
      if (!old) db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(id, legacyDigest(persistent), JSON.stringify(proposed), now);
    });
  }
  function machine(desired = "running", observed = "unknown", os = "linux") {
    const id = randomUUID(); store.transaction(db => db.prepare("INSERT INTO machines VALUES (?,?,?,?,?,?,'',?)").run(id, JSON.stringify({ name: "VM", resources: size }), host, JSON.stringify({ ...template(), os }), desired, observed, now)); return id;
  }
  return { store, infrastructure, host, credential, enroll, machine, tick(n: number) { now += n; }, now: () => now };
}

test("setup credentials are returned once, bound to offer and one persistent host identity", t => {
  const f = fixture(t), id = randomUUID(), issued = f.infrastructure.createSetup({ id, ...offer() }), token = String(issued.enrollmentToken);
  assert.throws(() => f.enroll(token, f.host, f.credential, { ...offer(), name: "wrong" }));
  f.enroll(token); f.enroll(token);
  assert.throws(() => f.enroll(token, randomUUID())); assert.throws(() => f.enroll(token, f.host, "d".repeat(43)));
  assert.throws(() => f.infrastructure.createSetup({ id, ...offer() }));
  assert.equal(JSON.stringify(f.infrastructure.setups()).includes(token), false);
  const restored = new InfrastructureStore(f.store); assert.equal(restored.setups()[0]!.hostId, f.host);
  f.tick(1801); assert.doesNotThrow(() => f.enroll(token));
  const expired = f.infrastructure.createSetup({ id: randomUUID(), ...offer() }); f.tick(1800);
  assert.throws(() => f.enroll(String(expired.enrollmentToken), randomUUID()));
  f.infrastructure.revokeSetup(id); assert.throws(() => f.enroll(token));
  f.store.transaction(db => assert.throws(() => authenticateSetup(db, token, f.now())));
});
test("failed checks gate admission; cached health/resources retain original age and do not change reservations", t => {
  const f = fixture(t), issued = f.infrastructure.createSetup({ id: randomUUID(), ...offer() }); f.enroll(String(issued.enrollmentToken)); f.machine();
  const health = { status: "passed", checkedAt: f.now(), checks: [{ id: "runtime", label: "Runtime", status: "passed", detail: "Fixture report." }] };
  const sample = { scope: "host", domain: "physical-host", sampledAt: f.now(), cpuPercent: 25, memoryTotalMiB: 16000, diskFreeGiB: 80 };
  f.store.transaction(db => { assert.equal(healthReady(db, f.host, f.now()), true); recordInfrastructure(db, f.host, { health, resources: sample }, f.now()); });
  f.tick(121);
  f.store.transaction(db => { recordInfrastructure(db, f.host, { health, resources: sample }, f.now()); assert.equal(healthReady(db, f.host, f.now()), false); assert.equal(hostHealth(db, f.host, f.now()).fresh, false); });
  assert.equal((f.infrastructure.hostResources(f.host).samples as unknown[]).length, 1);
  assert.deepEqual(f.infrastructure.hostResources(f.host).reserved, size);
  f.store.transaction(db => recordInfrastructure(db, f.host, { resources: { ...sample, sampledAt: f.now() } }, f.now()));
  assert.equal((f.infrastructure.hostResources(f.host).samples as unknown[]).length, 2);
  f.infrastructure.requestChecks(f.host);
  f.store.transaction(db => assert.equal(recordInfrastructure(db, f.host, {}, f.now()), f.now()));
  assert.throws(() => validateHealth({ ...health, checks: [{ ...health.checks[0], status: "failed" }] }));
  assert.throws(() => validateSample({ ...sample, cpuPercent: NaN }));
});
test("limits, stopping and unknown machines, leased disks and pending tasks share one conservative ledger", t => {
  const f = fixture(t); f.enroll(String(f.infrastructure.createSetup({ id: randomUUID(), ...offer() }).enrollmentToken));
  const stopping = f.machine("stopped", "stopping"), stopped = f.machine("stopped", "stopped"), leased = f.machine("stopped", "stopped", "android");
  f.store.transaction(db => {
    db.prepare("INSERT INTO lease_members VALUES (?,?)").run(randomUUID(), leased);
    db.prepare("INSERT INTO image_tasks VALUES (?,?,'unknown',3)").run(randomUUID(), f.host);
    db.prepare("INSERT INTO inference_jobs VALUES (?,?,'unknown',?)").run(randomUUID(), f.host, JSON.stringify({ resources: size }));
    for (let i = 0; i < 2; i++) { const id = randomUUID(); db.prepare("INSERT INTO images VALUES (?,?,?)").run(id, f.host, JSON.stringify({ id, revision: "1", arch: "arm64", sha256: "a".repeat(64), format: "raw", bytes: 1073741825 })); }
  });
  f.infrastructure.capacity.save(f.host, { limits: { ...capacity, cpu: 1 } });
  const data = f.infrastructure.hostResources(f.host), categories = data.categories as (typeof size & { id: string })[];
  assert.deepEqual(data.reserved, { cpu: 6, memoryMiB: 3072, diskGiB: 37 });
  for (const key of ["cpu", "memoryMiB", "diskGiB"] as const) assert.equal(categories.reduce((sum, c) => sum + c[key], 0), (data.reserved as typeof size)[key]);
  assert.equal(categories.find(c => c.id === "retainedDisks")!.diskGiB, 8);
  assert.equal((data.available as typeof size).cpu, 0);
  f.store.transaction(db => db.prepare("UPDATE machines SET observed='stopped' WHERE id=?").run(stopping));
  assert.equal((f.infrastructure.hostResources(f.host).reserved as typeof size).cpu, 4);
  f.store.transaction(db => db.prepare("INSERT INTO machine_power_offs VALUES (?,'unknown')").run(stopped));
  assert.equal((f.infrastructure.hostResources(f.host).reserved as typeof size).cpu, 6);
});
test("inventory revisions are immutable, host scoped and do not become offered", t => {
  const f = fixture(t); f.enroll(String(f.infrastructure.createSetup({ id: randomUUID(), ...offer() }).enrollmentToken));
  const second = { ...template(), revision: "2" };
  let validated = false;
  f.store.transaction(db => recordHostImages(db, f.host, [template(), second], f.now(), (_db, host, defs) => { assert.equal(host, f.host); assert.equal(defs.length, 2); validated = true; }));
  assert.equal(validated, true);
  const images = f.infrastructure.hostResources(f.host).images as Record<string, unknown>[];
  assert.equal(images.find(i => i.revision === "2")!.offered, false);
  f.store.transaction(db => assert.throws(() => recordHostImages(db, f.host, [{ ...second, name: "changed" }], f.now(), () => {})));
  f.store.transaction(db => assert.throws(() => recordHostImages(db, f.host, [second, second], f.now(), () => {})));
});
test("administrative API rejects setup credentials and current non-admin accounts", t => {
  const f = fixture(t), module = createModule(f.store, { adminToken: "x".repeat(43), controllerId: randomUUID() });
  let principal: Principal = { kind: "operator", user: null, scopes: [] };
  const req: ControlRequest = { method: "GET", path: "/v1/connection-setups", parts: ["v1", "connection-setups"], body: {}, token: "x".repeat(43), query: new URLSearchParams(), principal() { return principal; } };
  assert.deepEqual(module.handle(req), { body: { setups: [] } });
  principal = { kind: "token", user: { id: randomUUID(), username: "user", role: "user", status: "active" }, scopes: ["machines:read", "admin"] };
  assert.throws(() => module.handle(req));
  req.principal = () => { throw new Error("Setup credential is not an account credential."); }; assert.throws(() => module.handle(req));
  assert.equal(module.handle({ ...req, path: "/v1/elsewhere" }), undefined);
});
test("offline consolidation retains immutable assignments and requires local fencing", t => {
  const f = fixture(t), source = randomUUID(), targetOffer = { name: "Linux host", provider: "linux", capacity, runtimes: { libvirt: {} }, templates: [template()] };
  f.enroll(String(f.infrastructure.createSetup({ id: randomUUID(), ...offer() }).enrollmentToken));
  const machine = f.machine();
  f.store.transaction(db => { db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(source, legacyDigest("s".repeat(43)), JSON.stringify(offer()), f.now()); db.prepare("UPDATE machines SET host=? WHERE id=?").run(source, machine); });
  assert.throws(() => consolidateLocalRuntimes(f.store, f.host, [source], targetOffer, () => { throw new Error("Lock not held."); }));
  assert.equal(f.store.transaction(db => db.prepare("SELECT host FROM machines WHERE id=?").get(machine)!.host), source);
  consolidateLocalRuntimes(f.store, f.host, [source], targetOffer, ids => assert.deepEqual(ids, [f.host, source]));
  assert.equal(f.store.transaction(db => db.prepare("SELECT host FROM machines WHERE id=?").get(machine)!.host), f.host);
  assert.equal(f.store.transaction(db => healthReady(db, f.host, f.now())), false);
  assert.deepEqual(f.infrastructure.hostResources(f.host).reserved, size);
  consolidateLocalRuntimes(f.store, f.host, [source], targetOffer, () => {});
});
test("infrastructure initialization preserves opaque legacy host rows without fabricating limits", t => {
  const f = fixture(t), legacy = "legacy-host", original = { id: legacy, credential: "opaque-credential", offer: "{}", seen: 123, enabled: 1 };
  f.store.transaction(db => db.prepare("INSERT INTO hosts VALUES (?,?,?,?,?)").run(original.id, original.credential, original.offer, original.seen, original.enabled));
  new InfrastructureStore(f.store);
  assert.deepEqual({ ...f.store.transaction(db => db.prepare("SELECT * FROM hosts WHERE id=?").get(legacy)!) }, original);
  assert.equal(f.store.transaction(db => db.prepare("SELECT 1 FROM host_limits WHERE host=?").get(legacy)), undefined);
});
const namespace = "guests", now = Date.parse("2026-11-03T00:01:00Z") / 1000;
function inventory(name = "vm", names = ["guest"]): Record<string, any> { return { metadata: { name, namespace, creationTimestamp: "2026-11-03T00:00:00Z" }, spec: { containers: names.map(name => ({ name })) }, status: { phase: "Running" } }; }
function metric(name = "vm", names = ["guest"], stamp: unknown = "2026-11-03T00:01:00Z"): Record<string, any> { return { metadata: { name, namespace }, timestamp: stamp, window: "30s", containers: names.map(name => ({ name, usage: { cpu: "100m", memory: "64Mi" } })) }; }
test("namespace usage and quota quantities remain distinct from runner metrics and reservations", () => {
  for (const [v, n] of [["250m", .25], ["10n", 1e-8], ["2Gi", 2147483648], ["1.5G", 1500000000], ["1e3", 1000]] as const) assert.equal(quantity(v), n);
  for (const v of ["NaN", "Infinity", "-1", "1garbage", "1e999999999", "9007199254740993", "9007199254740992001m"]) assert.equal(quantity(v), null);
  const report = clusterResources(namespace, now, [inventory("vm", ["guest", "helper"])], [metric("vm", ["guest", "helper"])], [{ metadata: { name: "pool" }, status: { hard: { "requests.cpu": "4", "requests.memory": "8Gi" }, used: { "requests.cpu": "500m", "requests.storage": "20Gi" } } }]);
  const metrics = report.metrics as Record<string, unknown>;
  assert.equal(metrics.cpuCores, .2); assert.equal(metrics.memoryMiB, 128);
  assert.deepEqual(metrics.coverage, { status: "complete", activePods: 1, measuredPods: 1 });
  assert.equal((report.quotas as any).items[0].used["requests.storage"], 20);
  assert.equal(validateSample({ scope: "runner", domain: "worker", sampledAt: 1, cpuPercent: 5, cluster: report }).scope, "runner");
  assert.deepEqual((report.canaveral as any).ownership, { status: "unavailable" });
});
test("all active workloads, regular containers and running sidecars are required for namespace totals", () => {
  const missing = podUsage(namespace, now, [inventory(), inventory("other")], [metric()]);
  assert.equal(missing.status, "unavailable"); assert.equal("cpuCores" in missing, false);
  assert.deepEqual(missing.coverage, { status: "incomplete", activePods: 2, measuredPods: 1 });
  for (const measurements of [[metric(), metric()], [metric("vm", [])], [metric("vm", ["guest", "guest"])], [metric("vm", ["helper"])]]) assert.equal(podUsage(namespace, now, [inventory()], measurements).status, "unavailable");
  for (const section of ["initContainerStatuses", "ephemeralContainerStatuses"]) {
    const pod = inventory(); pod.status[section] = [{ name: "extra", state: { running: {} } }];
    assert.equal(podUsage(namespace, now, [pod], [metric()]).status, "unavailable");
    assert.equal(podUsage(namespace, now, [pod], [metric("vm", ["guest", "extra"])]).status, "available");
  }
});
test("stale, future and previous-incarnation measurements cannot become fresh namespace totals", () => {
  for (const stamp of ["2026-11-02T23:58:59Z", "2026-11-03T00:01:06Z", null, "2026-11-03T00:01:00"]) assert.equal(podUsage(namespace, now, [inventory()], [metric("vm", ["guest"], stamp)]).status, "unavailable");
  const replaced = inventory(); replaced.metadata.creationTimestamp = "2026-11-03T00:00:50Z";
  assert.equal(podUsage(namespace, now, [replaced], [metric("vm", ["guest"], "2026-11-03T00:00:49Z")]).status, "unavailable");
  const fresh = podUsage(namespace, now, [inventory()], [metric("vm", ["guest"], "2026-11-03T00:00:10Z")]);
  assert.equal(fresh.sampledAt, now - 50);
  assert.equal(podUsage(namespace, now, [replaced], [metric()], true).status, "unavailable");
});
test("successful empty namespace differs from denied or malformed inventory/metrics", () => {
  assert.equal(podUsage(namespace, now, [], []).cpuCores, 0);
  const stopped = inventory(); stopped.status.phase = "Succeeded"; assert.equal(podUsage(namespace, now, [stopped], []).podCount, 0);
  for (const [pods, metrics] of [[{}, []], [[], {}], [false, false], [[inventory(), inventory()], [metric()]]]) assert.equal(podUsage(namespace, now, pods, metrics).status, "unavailable");
  const invalid = metric(); invalid.containers[0].usage.cpu = "NaN";
  assert.equal(podUsage(namespace, now, [inventory()], [invalid]).status, "unavailable");
  const unknown = clusterResources(namespace, now, false, false, false);
  assert.deepEqual(unknown.metrics, { status: "unavailable", coverage: { status: "unavailable" } });
  assert.deepEqual(unknown.quotas, { status: "unavailable", items: [] });
  assert.equal(JSON.stringify(unknown).includes("private"), false);
});
test("coverage validation rejects contradictory counts and available partial totals, retaining legacy reports", () => {
  const complete = clusterResources(namespace, now, [inventory()], [metric()], []);
  for (const coverage of [{ status: "complete", activePods: 2, measuredPods: 1 }, { status: "incomplete", activePods: 1, measuredPods: 1 }, { status: "complete", activePods: true, measuredPods: 1 }, { status: "unavailable" }, { status: "complete" }]) {
    const value = structuredClone(complete); (value.metrics as any).coverage = coverage; assert.throws(() => validateCluster(value));
  }
  const legacy = structuredClone(complete); delete (legacy.metrics as any).coverage; delete (legacy.metrics as any).sampledAt; assert.doesNotThrow(() => validateCluster(legacy));
});
test("process usage de-duplicates owned/tree identities and handles PID reuse and failed verification as unknown", () => {
  const collector = new ProcessUsageCollector();
  const p = { pid: 99, birth: 1, name: "CanaveralVMRunner", userSeconds: 2, systemSeconds: 0, rssBytes: 1048576 };
  const group = (value: Record<string, unknown>) => (value.categories as any[])[1];
  assert.equal(group(collector.collect([p], 4, 10)).cpuPercent, null);
  p.userSeconds = 4; assert.equal(group(collector.collect([p, p], 4, 12)).cpuPercent, 25);
  p.birth = 2; assert.equal(group(collector.collect([p], 4, 14)).cpuPercent, null);
  const owned = { ...p, expectedBirth: 2, category: "virtualMachines" as const, verify: () => false };
  const unknown = group(collector.collect([owned, p], 4, 16, new Set(), true));
  assert.equal(unknown.processCount, null); assert.equal(unknown.memoryMiB, null);
  assert.doesNotThrow(() => validateSample({ scope: "host", domain: "fixture", canaveral: collector.collect(null, 4, 18) }));
});
test("environment inspection fails closed with fixed diagnostics and separates artifact from native acceptance", () => {
  const config = { ...offer(), provider: "libvirt", templates: [] };
  const report = inspectHost(config, { system: "Linux", arch: "amd64", storageWritable: true, tools: [{ label: "virsh", available: true }, { label: "qemu-img", available: true }], backendValid: true, libvirtLeaseArtifact: true, measurements: { cpuCount: 8, memoryTotalMiB: 8192, diskFreeGiB: 100 } }, 1000);
  assert.equal(report.status, "warning"); assert.equal(report.capabilities!.libvirtLeaseArtifact, true);
  assert.ok(report.checks!.some(c => c.id === "libvirt-lease-acceptance" && c.status === "warning"));
  const failed = inspectHost(config, { system: "Darwin", arch: "arm64", storageWritable: false, tools: [], backendValid: null }, 1000);
  assert.equal(failed.status, "failed"); assert.ok(failed.checks!.some(c => c.id === "backend" && c.status === "skipped"));
});

test("every protected infrastructure route rechecks current authority inside its SQLite transaction", async t => {
  const { Accounts, tokenHash } = await import("../../src/accounts.ts");
  const f = fixture(t), operatorToken = "o".repeat(43), humanToken = "h".repeat(43), user = randomUUID(), tokenId = randomUUID();
  const module = createModule(f.store, { adminToken: operatorToken, controllerId: randomUUID() });
  const accounts = new Accounts(f.store);
  f.enroll(String(f.infrastructure.createSetup({ id: randomUUID(), ...offer() }).enrollmentToken));
  const setupId = randomUUID(); f.infrastructure.createSetup({ id: setupId, ...offer() });
  f.store.transaction(db => {
    db.prepare("INSERT INTO users VALUES (?,?,'admin','active',1000,NULL,NULL,NULL)").run(user, "operator-user");
    db.prepare("INSERT INTO api_tokens VALUES (?,?,?,'[\"admin\"]',1000,10000,NULL,NULL,'fixture',?)").run(tokenId, user, "administration", tokenHash(humanToken));
  });
  const original = f.store.transaction.bind(f.store);
  let boundary: (() => void) | undefined;
  f.store.transaction = <T>(operation: (db: import("node:sqlite").DatabaseSync) => T): T => {
    const hook = boundary; boundary = undefined; hook?.();
    return original(operation);
  };
  const routes = [
    ["POST", "/v1/connection-setups", () => ({ id: randomUUID(), ...offer() })],
    ["GET", "/v1/connection-setups", () => ({})],
    ["POST", `/v1/connection-setups/${setupId}/revoke`, () => ({})],
    ["POST", `/v1/hosts/${f.host}/checks`, () => ({})],
    ["POST", `/v1/hosts/${f.host}/limits`, () => ({ limits: { ...capacity, cpu: 1 } })],
    ["GET", `/v1/hosts/${f.host}/resources`, () => ({})],
  ] as const;
  for (const change of ["disable", "demote", "revoke", "scope"] as const) for (const [method, path, body] of routes) {
    await t.test(`${change} at ${method} ${path}`, () => {
      original(db => { db.prepare("UPDATE users SET status='active',role='admin' WHERE id=?").run(user); db.prepare("UPDATE api_tokens SET revoked=NULL,scopes='[\"admin\"]' WHERE id=?").run(tokenId); });
      const before = original(db => ({ setups: db.prepare("SELECT * FROM connection_setups ORDER BY id").all(), checks: db.prepare("SELECT * FROM host_health").all(), limits: db.prepare("SELECT * FROM host_limits").all() }));
      const req: ControlRequest = { method, path, parts: path.split("/").filter(Boolean), body: body(), token: humanToken, query: new URLSearchParams(), principal() {
        const current = accounts.principal(humanToken);
        boundary = () => original(db => {
          if (change === "disable") db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(user);
          if (change === "demote") db.prepare("UPDATE users SET role='user' WHERE id=?").run(user);
          if (change === "revoke") db.prepare("UPDATE api_tokens SET revoked=1000 WHERE id=?").run(tokenId);
          if (change === "scope") db.prepare("UPDATE api_tokens SET scopes='[\"machines:read\"]' WHERE id=?").run(tokenId);
        });
        return current;
      } };
      assert.throws(() => module.handle(req), (error: unknown) => error instanceof Error && "status" in error && (error.status === 401 || error.status === 403));
      const after = original(db => ({ setups: db.prepare("SELECT * FROM connection_setups ORDER BY id").all(), checks: db.prepare("SELECT * FROM host_health").all(), limits: db.prepare("SELECT * FROM host_limits").all() }));
      assert.deepEqual(after, before);
    });
  }
});

test("mapped host resources include held runner reservations in category totals", t => {
  const f = fixture(t); f.enroll(String(f.infrastructure.createSetup({ id: randomUUID(), ...offer() }).enrollmentToken));
  const domain = randomUUID(), domains = new ResourceDomains();
  f.store.transaction(db => {
    ResourceDomains.schema(db);
    domains.define(db, { id: domain, name: "fixture", capacity }, 1);
    new PhysicalDomains().map(db, f.host, domain);
    domains.reserve(db, { id: randomUUID(), domain, kind: "model", owner: domain, resources: size }, 1);
  });
  f.machine();
  const report = f.infrastructure.hostResources(f.host);
  assert.equal(report.physicalDomainId, domain);
  assert.deepEqual(report.reserved, { cpu: 4, memoryMiB: 2048, diskGiB: 16 });
  const categories = report.categories as (typeof size & { id: string })[];
  assert.equal(categories.find(c => c.id === "physicalShared")!.cpu, size.cpu);
  for (const key of ["cpu", "memoryMiB", "diskGiB"] as const) assert.equal(categories.reduce((sum, c) => sum + c[key], 0), (report.reserved as typeof size)[key]);
});
