import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import type { ControlRequest } from "../../src/control/contracts.ts";
import { createModule, refreshLeaseCleanup } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-lifecycle-machines-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const store = new SqliteStore(join(directory, "state.sqlite3"), () => 1_000);
  const options = { adminToken: "a".repeat(43), enrollmentToken: "e".repeat(43), controllerId: randomUUID() };
  let machines = new MachineStore(store, options);
  const lifecycle = createModule(store, options);
  const host = randomUUID(), credential = "h".repeat(43);
  const offer = { name: "fixture", provider: "apple", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 40 },
    templates: [{ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }] };
  function req(path = "/v1/machines", body: Record<string, unknown> = {}): ControlRequest {
    return { method: "POST", path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: options.adminToken,
      principal: () => ({ kind: "operator", user: null, scopes: [] }) };
  }
  machines.enroll({ id: host, credential, offer }, options.enrollmentToken);
  function post(id: string, action: string, intent: { id: string }) {
    const response = lifecycle.handle(req(`/v1/machines/${id}/${action}`, intent));
    assert.ok(response && !("then" in response));
    return response.body as { state: string };
  }
  const specification = { id: randomUUID(), name: "fixture-machine", templateId: "linux", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 10 } };
  machines.create(specification, req());
  return { store, specification, host, credential, offer, req, post,
    get machines() { return machines; },
    beat: (reports: Record<string, unknown> = {}) => machines.heartbeat(host, credential, { offer, reports }),
    reserved: () => machines.hosts(req())[0]!.reserved,
    restart: () => { machines = new MachineStore(new SqliteStore(store.path, () => 1_000), options); },
  };
}

test("machine heartbeat holds power reservations, releases only matching ACK, and retains deleted creation identity", t => {
  const f = fixture(t), id = f.specification.id, power = { id: randomUUID() }, removal = { id: randomUUID() };
  f.post(id, "power-off", power);
  assert.equal(f.beat().machines[0].powerOffRequest, power.id);
  f.beat({ [id]: { state: "stopped" } });
  assert.equal(f.reserved().cpu, 2);
  assert.throws(() => f.machines.desired(id, "running", f.req()), (e: unknown) => e instanceof ServiceError && e.status === 409);
  f.beat({ [id]: { state: "stopped", powerOffId: power.id } });
  assert.equal(f.reserved().cpu, 0);
  assert.equal(f.reserved().diskGiB, 10);
  f.post(id, "delete", removal);
  f.beat({ [id]: { state: "unknown", deletion: { ...removal, state: "blocked" } } });
  assert.equal(f.reserved().diskGiB, 10);
  assert.equal(f.beat({ [id]: { state: "stopped", deletion: { ...removal, state: "complete" } } }).machines.length, 0);
  assert.equal(f.machines.machines(f.req()).length, 0);
  assert.equal(f.reserved().diskGiB, 0);
  f.beat({ [id]: { state: "running" } });
  assert.equal(f.reserved().cpu, 0);
  const replay = f.machines.create(f.specification, f.req());
  assert.equal(replay.deletion.state, "complete");
  assert.equal(replay.ready, false);
  f.restart();
  assert.equal(f.reserved().diskGiB, 0);
  assert.equal(f.machines.create(f.specification, f.req()).deletion.state, "complete");
});

test("machine heartbeat suppresses stale preparation after positive lease cleanup and reclaims capacity", t => {
  const f = fixture(t), id = f.specification.id, leaseId = randomUUID();
  // Fixture-only bookkeeping: this does not claim native lease admission or execution.
  f.store.transaction(db => {
    db.exec("CREATE TABLE leases (id TEXT PRIMARY KEY,state TEXT NOT NULL,cleanup TEXT NOT NULL); CREATE TABLE lease_members (lease TEXT NOT NULL,name TEXT NOT NULL,machine TEXT NOT NULL UNIQUE,PRIMARY KEY(lease,name));");
    db.prepare("INSERT INTO leases VALUES (?,'released','pending')").run(leaseId);
    db.prepare("INSERT INTO lease_members VALUES (?,'primary',?)").run(leaseId, id);
    db.prepare("UPDATE machines SET desired='stopped',preparation_hash=?,prepared_at=1000,access_ready=1 WHERE id=?").run("f".repeat(64), id);
    refreshLeaseCleanup(db, 1_000);
  });
  const assignment = f.beat({ [id]: { state: "stopped" } }).machines[0];
  const cleanup = assignment.leaseCleanup;
  assert.equal(f.reserved().cpu, 2);
  assert.equal(f.reserved().diskGiB, 10);
  const completed = { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId, state: "complete", attempt: 1,
    executionStopped: true, storageRemoved: true, credentialsErased: true }, preparation: { state: "ready", tokenHash: "f".repeat(64) } };
  assert.equal(f.beat({ [id]: completed }).machines.length, 0);
  assert.equal(f.reserved().cpu, 0);
  assert.equal(f.reserved().diskGiB, 0);
  f.beat({ [id]: { state: "running", preparation: { state: "ready", tokenHash: "f".repeat(64) } } });
  f.store.transaction(db => {
    assert.equal(db.prepare("SELECT preparation_hash FROM machines WHERE id=?").get(id)?.preparation_hash, null);
    assert.equal(db.prepare("SELECT cleanup FROM leases WHERE id=?").get(leaseId)?.cleanup, "complete");
  });
  f.restart();
  assert.equal(f.beat().machines.length, 0);
});
