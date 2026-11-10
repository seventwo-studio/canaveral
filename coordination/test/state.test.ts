import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { Accounts, ITERATIONS, SESSION_SECONDS, passwordBytes, username } from "../src/accounts.ts";
import { ConsumerIdentities, applicationSpec } from "../src/consumers.ts";
import { ServiceError } from "../src/errors.ts";
import { SqliteStore } from "../src/sqlite.ts";

const password = "disposable-test-password-123";
function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-ts-state-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const now = { seconds: 80_000 };
  const store = new SqliteStore(join(directory, "controller.sqlite"), () => now.seconds);
  return { store, now };
}
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;
const spec = () => ({ id: "11111111-2222-4333-8444-555555555555", name: "Build agent", templates: [],
  limits: { resources: { cpu: 4, memoryMiB: 8192, diskGiB: 96 }, activeLeases: 2 } });

test("account setup, PBKDF2 and sessions survive reopening without plaintext credentials", async t => {
  const { store, now } = fixture(t);
  const accounts = new Accounts(store);
  assert.deepEqual(accounts.status(), { setupRequired: true });
  const first = await accounts.setup({ username: "ADMIN", password });
  assert.equal(first.expiresAt, now.seconds + SESSION_SECONDS);
  assert.deepEqual(first.user, { id: first.user.id, username: "admin", role: "admin", status: "active", createdAt: now.seconds });
  assert.match(first.user.id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  const restored = new Accounts(new SqliteStore(store.path, () => now.seconds));
  assert.equal(restored.authorized(first.token), true);
  assert.deepEqual(restored.status(), { setupRequired: false });
  await assert.rejects(restored.setup({ username: "other", password }), status(409));
  const login = await restored.login({ username: "ADMIN", password });
  assert.equal(restored.authorized(login.token), true);
  store.transaction(db => {
    const row = db.prepare("SELECT salt,password_hash,iterations FROM users").get()!;
    assert.equal(row.iterations, ITERATIONS);
    assert.equal((row.salt as string).length, 64);
    assert.equal((row.password_hash as string).length, 64);
    assert.notEqual(row.password_hash, password);
    assert.notEqual(db.prepare("SELECT token_hash FROM user_sessions").get()!.token_hash, first.token);
  });
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.deepEqual(restored.logout(first.token), { ok: true });
  assert.equal(accounts.authorized(first.token), false);
  now.seconds += SESSION_SECONDS;
  assert.equal(restored.authorized(login.token), false);
});

test("concurrent first-run requests create exactly one durable administrator", async t => {
  const { store } = fixture(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
    new Accounts(new SqliteStore(store.path)).setup({ username: "admin" + index, password })));
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  for (const outcome of outcomes) if (outcome.status === "rejected") assert.ok(status(409)(outcome.reason));
  store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND status='active'").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n, 1);
  });
});

test("persistent global attempt budget covers invalid usernames and expires after sixty seconds", async t => {
  const { store, now } = fixture(t);
  let accounts = new Accounts(store);
  await accounts.setup({ username: "admin", password });
  for (let i = 0; i < 10; i++) await assert.rejects(accounts.login({ username: "?", password: "" }), status(401));
  accounts = new Accounts(new SqliteStore(store.path, () => now.seconds));
  await assert.rejects(accounts.login({ username: "admin", password }), status(429));
  now.seconds += 60;
  assert.equal((await accounts.login({ username: "admin", password })).user.username, "admin");
});

test("unknown users and wrong passwords produce the same credential failure", async t => {
  const { store } = fixture(t); const accounts = new Accounts(store);
  await accounts.setup({ username: "admin", password });
  const errors: ServiceError[] = [];
  for (const username of ["admin", "unknown"]) {
    try { await accounts.login({ username, password: "incorrect-password" }); }
    catch (error) { assert.ok(error instanceof ServiceError); errors.push(error); }
  }
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map(error => [error.message, error.status, error.code]),
    Array(2).fill(["Username or password rejected.", 401, "unauthenticated"]));
});

test("password character counts and UTF-8 match Python without Unicode normalization", () => {
  assert.equal(username("Admin+test"), "admin+test");
  for (const invalid of ["admin\n", "ab", "äuser", true]) assert.throws(() => username(invalid), status(400));
  assert.equal(passwordBytes("😀".repeat(12)).length, 48);
  assert.equal(passwordBytes("😀".repeat(1024)).length, 4096);
  for (const invalid of ["😀".repeat(11), "😀".repeat(1025), "a".repeat(12) + "\uD800", true]) {
    assert.throws(() => passwordBytes(invalid), status(400));
  }
});

test("expired sessions are pruned and live administrator sessions remain bounded", async t => {
  const { store, now } = fixture(t); const accounts = new Accounts(store);
  const admin = await accounts.setup({ username: "admin", password });
  store.transaction(db => {
    const insert = db.prepare("INSERT INTO user_sessions VALUES (?,?,?)");
    for (let i = 0; i < 70; i++) insert.run("fixture-" + i, admin.user.id, now.seconds + 1000 + i);
    insert.run("expired", admin.user.id, now.seconds);
  });
  await accounts.login({ username: "admin", password });
  store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n, 64);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_sessions WHERE expires<=?").get(now.seconds)!.n, 0);
  });
});

test("failed transactions roll back and cannot commit an asynchronous callback", t => {
  const { store } = fixture(t);
  store.transaction(db => db.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY)"));
  assert.throws(() => store.transaction(db => { db.exec("INSERT INTO proof VALUES (1)"); throw new Error("interrupted"); }));
  assert.throws(() => store.transaction(db => { db.exec("INSERT INTO proof VALUES (2)"); return Promise.resolve(); }), TypeError);
  store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM proof").get()!.n, 0));
});

test("independent worker connections share one atomic persistent sign-in budget", async t => {
  const { store } = fixture(t); new Accounts(store);
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<number[]>((resolve, reject) => {
    const worker = new Worker(new URL("./throttle-worker.js", import.meta.url), { workerData: { path: store.path } });
    let statuses: number[] | undefined;
    worker.once("message", value => { statuses = value as number[]; });
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0 || !statuses) reject(new Error("Throttle fixture worker failed")); else resolve(statuses); });
  })));
  const statuses = results.flat();
  assert.equal(statuses.filter(value => value === 401).length, 10);
  assert.equal(statuses.filter(value => value === 429).length, 6);
  store.transaction(db => assert.equal(db.prepare("SELECT attempts FROM auth_throttle").get()!.attempts, 10));
});

test("application credentials rotate/revoke persistently and never appear in inventory", t => {
  const { store, now } = fixture(t); const applications = new ConsumerIdentities(store);
  const created = applications.create(spec());
  assert.equal(created.createdAt, now.seconds);
  assert.equal(applications.authenticate(created.credential).id, created.id);
  assert.equal("credential" in applications.list()[0]!, false);
  assert.throws(() => applications.create(spec()), status(409));
  assert.throws(() => applications.authenticate("a".repeat(43)), status(401));
  const restored = new ConsumerIdentities(new SqliteStore(store.path, () => now.seconds));
  const rotated = restored.rotate(created.id);
  assert.throws(() => applications.authenticate(created.credential), status(401));
  assert.equal(applications.authenticate(rotated.credential).id, created.id);
  restored.revoke(created.id);
  assert.throws(() => applications.authenticate(rotated.credential), status(401));
  assert.throws(() => restored.rotate(created.id), status(409));
  assert.equal(restored.list()[0]!.revoked, true);
  assert.throws(() => restored.revoke("aaaaaaaa-0000-4000-8000-000000000000"), status(404));
});

test("application policies pin installed image revisions and roll back failed creation", t => {
  const { store } = fixture(t); const applications = new ConsumerIdentities(store);
  const permission = { id: "ubuntu", revision: "4", arch: "arm64" };
  const request = { ...spec(), templates: [permission] };
  assert.throws(() => applications.create(request), status(400));
  assert.deepEqual(applications.list(), []);
  store.transaction(db => { db.prepare("INSERT INTO templates VALUES (?,?,?,?)").run("ubuntu", "4", "arm64", "{}"); });
  assert.deepEqual(applications.create(request).templates, [permission]);
  assert.throws(() => applicationSpec({ ...request, templates: [permission, permission] }), status(400));
  for (const limits of [ { ...request.limits, activeLeases: true }, { ...request.limits, maxTTLSeconds: 1 },
      { ...request.limits, other: 1 }, { ...request.limits, resources: { cpu: 1, memoryMiB: 1, diskGiB: 1, other: 1 } } ]) {
    assert.throws(() => applicationSpec({ ...request, limits }), status(400));
  }
  assert.throws(() => applicationSpec({ ...request, id: request.id + "\n" }), status(400));
});

test("independent account workers cannot disable both final administrators", async t => {
  const { store } = fixture(t), accounts = new Accounts(store);
  const first = await accounts.setup({ username: "firstadmin", password });
  const pending = accounts.createUser("", { id: "11111111-2222-4333-8444-555555555555", username: "secondadmin", role: "admin" }, true);
  const claim = accounts.issueClaim("", "invite", pending.id, true);
  const second = await accounts.redeem({ token: claim.token, password });
  const outcomes = await Promise.all([first.user.id, second.user.id].map(id => new Promise<number>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      Promise.all([import(workerData.accounts), import(workerData.sqlite)]).then(([{Accounts},{SqliteStore}]) => {
        const accounts = new Accounts(new SqliteStore(workerData.path));
        try { accounts.updateUser('', workerData.id, {status:'disabled'}, true); parentPort.postMessage(200); }
        catch(error) { if (error.status !== 409) throw error; parentPort.postMessage(error.status); }
      });
    `, { eval: true, workerData: { path: store.path, id, accounts: new URL("../src/accounts.js", import.meta.url).href, sqlite: new URL("../src/sqlite.js", import.meta.url).href } });
    let result: number | undefined;
    worker.once("message", value => { result = value as number; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0 || result === undefined) reject(new Error("Last-administrator worker failed"));
      else resolve(result);
    });
  })));
  assert.deepEqual(outcomes.sort(), [200, 409]);
  store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND status='active'").get()!.n, 1));
});
