import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RunnerEnrollment } from "../src/enrollment.ts";
import { SqliteStore } from "../src/sqlite.ts";
import { IdentityClient } from "../src/identity-client.ts";
import { ServiceError } from "../src/errors.ts";

const key = () => randomBytes(32).toString("base64url");
const binding = () => ({ controllerId: randomUUID(), runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() });
const status = (n: number) => (error: unknown) => error instanceof ServiceError && error.status === n;
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "runner-enrollment-")), path = join(dir, "state.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const b = binding(), store = new SqliteStore(path, () => now), service = new RunnerEnrollment(store, b.controllerId);
  const spec = { id: randomUUID(), ...b, ttlSeconds: 10 };
  const issue = () => service.issue(spec) as { enrollmentToken: string; expiresAt: number };
  const credential = key(), consume = { id: spec.id, ...b, credential };
  return { b, store, path, service, spec, issue, credential, consume, clock: (n: number) => { now = n; } };
}

test("expiry boundary rejects first consume; exact durable receipt survives expiry and restart", t => {
  const f = fixture(t), issued = f.issue();
  f.clock(issued.expiresAt);
  assert.throws(() => f.service.consume(issued.enrollmentToken, f.consume), status(401));
  f.clock(issued.expiresAt - 0.001);
  const receipt = f.service.consume(issued.enrollmentToken, f.consume);
  f.clock(issued.expiresAt + 100);
  const restarted = new RunnerEnrollment(new SqliteStore(f.path, () => issued.expiresAt + 100), f.b.controllerId);
  assert.deepEqual(restarted.consume(issued.enrollmentToken, f.consume), receipt);
  assert.deepEqual(restarted.authenticate(f.credential, f.b), receipt);
  assert.throws(() => restarted.consume(issued.enrollmentToken, { ...f.consume, credential: key() }), status(401));
  assert.throws(() => new RunnerEnrollment(f.store, randomUUID()), status(409));
  for (const sensitive of [issued.enrollmentToken, f.credential]) assert.equal(readFileSync(f.path).includes(Buffer.from(sensitive)), false);
});

test("pair, incarnation, generation, role and bounded fields are checked without consumption", t => {
  const f = fixture(t), issued = f.issue();
  for (const changed of [{ runnerId: randomUUID() }, { controllerId: randomUUID() }, { incarnationId: randomUUID() }, { generation: 2 }]) {
    assert.throws(() => f.service.consume(issued.enrollmentToken, { ...f.consume, ...changed }), status("controllerId" in changed ? 403 : 401));
  }
  assert.throws(() => f.service.consume(f.credential, f.consume), status(401));
  for (const changed of [{ ttlSeconds: 1801 }, { generation: 1.5 }, { extra: true }, { runnerId: "a".repeat(10000) }]) {
    assert.throws(() => f.service.issue({ ...f.spec, ...changed }), status(400));
  }
  f.service.consume(issued.enrollmentToken, f.consume);
  assert.throws(() => f.service.authenticate(issued.enrollmentToken, f.b), status(401));
  for (const changed of [{ runnerId: randomUUID() }, { generation: 2 }, { incarnationId: randomUUID() }]) assert.throws(() => f.service.authenticate(f.credential, { ...f.b, ...changed }), status(401));
});

test("lost issue reply is inspected and revoked; consume revocation preserves enrolled identity", t => {
  const f = fixture(t), issued = f.issue();
  assert.throws(f.issue, status(409));
  assert.equal(JSON.stringify(f.service.inspect(f.spec.id)).includes(issued.enrollmentToken), false);
  f.service.revokeEnrollment(f.spec.id);
  assert.throws(() => f.service.consume(issued.enrollmentToken, f.consume), status(401));
  const id = randomUUID(), second = f.service.issue({ ...f.spec, id }) as { enrollmentToken: string };
  f.service.consume(second.enrollmentToken, { ...f.consume, id });
  f.service.revokeEnrollment(id);
  assert.throws(() => f.service.consume(second.enrollmentToken, { ...f.consume, id }), status(401));
  f.service.authenticate(f.credential, f.b);
});

test("rotation retries, revocation, generation fencing and incarnation history persist", t => {
  const f = fixture(t), issued = f.issue();
  f.service.consume(issued.enrollmentToken, f.consume);
  const next = key(), rotate = { ...f.b, credentialRevision: 2, credential: next };
  const receipt = f.service.manage(rotate, false);
  assert.deepEqual(f.service.manage(rotate, false), receipt);
  assert.throws(() => f.service.manage({ ...rotate, credential: key() }, false), status(409));
  assert.throws(() => f.service.manage({ ...rotate, credentialRevision: 3 }, false), status(409));
  assert.throws(() => f.service.authenticate(f.credential, f.b), status(401));
  assert.throws(() => f.service.consume(issued.enrollmentToken, f.consume), status(401));
  f.service.authenticate(next, f.b);
  const newer = { ...f.spec, id: randomUUID(), generation: 2, incarnationId: randomUUID() };
  assert.throws(() => f.service.issue(newer), status(409));
  f.service.manage(f.b, true);
  const reopened = new RunnerEnrollment(new SqliteStore(f.path), f.b.controllerId);
  assert.throws(() => reopened.authenticate(next, f.b), status(401));
  assert.throws(() => f.service.manage(rotate, false), status(409));
  assert.throws(() => f.service.issue({ ...newer, generation: 1 }), status(409));
  assert.throws(() => f.service.issue({ ...newer, incarnationId: f.b.incarnationId }), status(409));
  const approved = f.service.issue(newer) as { enrollmentToken: string };
  const b2 = { controllerId: newer.controllerId, runnerId: newer.runnerId, generation: 2, incarnationId: newer.incarnationId };
  f.service.consume(approved.enrollmentToken, { ...b2, id: newer.id, credential: key() });
  assert.throws(() => f.service.authenticate(next, f.b), status(401));
  assert.throws(() => f.service.manage(f.b, true), status(409));
});

test("legacy hosts and unrelated state survive additive tables; adoption is refused", t => {
  const f = fixture(t);
  f.store.transaction(db => { db.exec("CREATE TABLE hosts (id TEXT PRIMARY KEY, credential TEXT, offer TEXT, seen REAL, enabled INTEGER)"); db.prepare("INSERT INTO hosts VALUES (?,?,?,0,1)").run(f.b.runnerId, "legacy-hash", "{}"); });
  assert.throws(f.issue, status(409));
  const db = new DatabaseSync(f.path);
  try { assert.equal(db.prepare("SELECT credential FROM hosts").get()!.credential, "legacy-hash"); } finally { db.close(); }
});

test("two owned workers race on durable single-use consume and recover exact lost replies", async t => {
  const f = fixture(t), admin = key();
  const clients = [0, 1].map(() => new IdentityClient({ path: f.path, adminToken: admin, controllerId: f.b.controllerId }));
  t.after(async () => { await Promise.all(clients.map(c => c.close())); });
  await Promise.all(clients.map(c => c.ready));
  // Issue through a real worker clock, rather than the deterministic expiry fixture.
  const issued = await clients[0]!.request({ type: "runner.issue", token: admin, body: { ...f.spec, ttlSeconds: 60 } }) as { enrollmentToken: string };
  const credentials = [key(), key()];
  const results = await Promise.allSettled(clients.map((c, i) => c.request({ type: "runner.consume", token: issued.enrollmentToken, body: { ...f.consume, credential: credentials[i] } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const winner = results.findIndex(r => r.status === "fulfilled");
  const loser = results[1 - winner]!;
  assert.ok(loser.status === "rejected" && status(401)(loser.reason));
  await clients[winner]!.close();
  const restarted = new IdentityClient({ path: f.path, adminToken: admin, controllerId: f.b.controllerId });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.request({ type: "runner.consume", token: issued.enrollmentToken, body: { ...f.consume, credential: credentials[winner] } }), { ...f.b, credentialRevision: 1 });
});


test("runner commands require explicit controller configuration without breaking account status", async t => {
  const f = fixture(t), admin = key();
  const client = new IdentityClient({ path: f.path, adminToken: admin });
  t.after(() => client.close());
  assert.deepEqual(await client.request({ type: "status" }), { setupRequired: true });
  await assert.rejects(client.request({ type: "runner.issue", token: admin, body: f.spec }), status(503));
  await assert.rejects(client.request({ type: "runner.inspect", token: key(), id: f.spec.id }), status(401));
  await assert.rejects(client.request({ type: "runner.issue", token: key(), body: f.spec }), status(401));
  await assert.rejects(client.request({ type: "runner.consume", token: key(), body: f.consume }), status(401));
  await assert.rejects(client.request({ type: "runner.authenticate", token: key(), body: f.b }), status(401));
});


test("credential history rejects cross-runner sharing and old-secret reuse atomically", t => {
  const f = fixture(t), issued = f.issue();
  assert.throws(() => f.service.consume(issued.enrollmentToken, { ...f.consume, credential: issued.enrollmentToken }), status(400));
  f.service.consume(issued.enrollmentToken, f.consume);
  f.service.manage({ ...f.b, credentialRevision: 2, credential: key() }, false);
  assert.throws(() => f.service.manage({ ...f.b, credentialRevision: 3, credential: f.credential }, false), status(409));
  const b2 = { ...f.b, runnerId: randomUUID(), incarnationId: randomUUID() }, id = randomUUID();
  const another = f.service.issue({ id, ...b2, ttlSeconds: 60 }) as { enrollmentToken: string };
  assert.throws(() => f.service.consume(another.enrollmentToken, { id, ...b2, credential: f.credential }), status(409));
  assert.equal((f.service.inspect(id) as { state: string }).state, "pending");
  f.service.consume(another.enrollmentToken, { id, ...b2, credential: key() });
});

test("consumption and rotation never promote enrollment tokens into runner credentials", t => {
  const f = fixture(t), issued = f.issue();
  const other = { ...f.spec, id: randomUUID(), runnerId: randomUUID(), incarnationId: randomUUID() };
  const pending = f.service.issue(other) as { enrollmentToken: string };
  assert.throws(() => f.service.consume(issued.enrollmentToken, { ...f.consume, credential: pending.enrollmentToken }), status(400));
  f.service.consume(issued.enrollmentToken, f.consume);
  for (const token of [issued.enrollmentToken, pending.enrollmentToken]) {
    assert.throws(() => f.service.manage({ ...f.b, credentialRevision: 2, credential: token }, false), status(400));
    assert.throws(() => f.service.authenticate(token, f.b), status(401));
  }
  assert.deepEqual(f.service.authenticate(f.credential, f.b), { ...f.b, credentialRevision: 1 });
  f.service.revokeEnrollment(other.id);
  assert.throws(() => f.service.manage({ ...f.b, credentialRevision: 2, credential: pending.enrollmentToken }, false), status(400));
  assert.deepEqual(f.service.manage({ ...f.b, credentialRevision: 2, credential: key() }, false), { ...f.b, credentialRevision: 2 });
});
