import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { Accounts, ITERATIONS, passwordBytes, passwordHash, tokenHash } from "../src/accounts.ts";
import { ServiceError } from "../src/errors.ts";
import { SqliteStore } from "../src/sqlite.ts";

const password = "legacy-migration-password-😀";
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-account-compat-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new SqliteStore(join(directory, "controller.sqlite3"), () => 80_000);
}

test("legacy administrator hash and live sessions migrate once; leased and already-owned machines are excluded", async t => {
  const store = fixture(t), salt = randomBytes(32).toString("hex"), raw = randomBytes(32).toString("base64url");
  const encoded = await passwordHash(passwordBytes(password), salt);
  const ordinary = randomUUID(), leased = randomUUID(), owned = randomUUID();
  store.transaction(db => {
    db.exec(`CREATE TABLE administrator (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,iterations INTEGER NOT NULL);
      CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,expires REAL NOT NULL);
      CREATE TABLE machines(id TEXT PRIMARY KEY,owner TEXT);
      CREATE TABLE lease_members(lease TEXT,name TEXT,machine TEXT);`);
    db.prepare("INSERT INTO administrator VALUES(1,?,?,?,?)").run("legacyadmin", salt, encoded, ITERATIONS);
    db.prepare("INSERT INTO admin_sessions VALUES(?,?),(?,?)").run(tokenHash(raw), 80_600, tokenHash("expired"), 80_000);
    db.prepare("INSERT INTO machines VALUES(?,NULL),(?,NULL),(?,'existing-owner')").run(ordinary, leased, owned);
    db.prepare("INSERT INTO lease_members VALUES(?,?,?)").run(randomUUID(), "fixture", leased);
  });
  const accounts = new Accounts(store), migrated = accounts.session(raw);
  assert.equal(migrated.user.username, "legacyadmin");
  assert.equal(migrated.user.role, "admin");
  assert.equal(migrated.expiresAt, 80_600);
  assert.equal((await accounts.login({ username: "LEGACYADMIN", password })).user.id, migrated.user.id);
  store.transaction(db => {
    const row = db.prepare("SELECT * FROM users").get()!;
    assert.equal(row.password_hash, encoded);
    assert.equal(row.salt, salt);
    assert.equal(row.iterations, ITERATIONS);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(ordinary)!.owner, migrated.user.id);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(leased)!.owner, null);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(owned)!.owner, "existing-owner");
    assert.equal(db.prepare("SELECT count(*) AS n FROM administrator").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM admin_sessions").get()!.n, 0);
    assert.equal(db.prepare("SELECT 1 FROM user_sessions WHERE token_hash=?").get(tokenHash("expired")), undefined);
  });
  for (let i = 0; i < 4; i++) assert.equal(new Accounts(store).session(raw).user.id, migrated.user.id);
  accounts.logout(raw);
  assert.throws(() => new Accounts(store).session(raw), (error: unknown) => error instanceof ServiceError && error.status === 401);
  assert.throws(() => store.transaction(db => db.prepare("INSERT INTO admin_sessions VALUES(?,?)").run(tokenHash(raw), 80_600)), /consumed/);
  assert.throws(() => store.transaction(db => db.prepare("INSERT INTO administrator VALUES(1,?,?,?,?)").run("resurrected", salt, encoded, ITERATIONS)), /consumed/);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM users").get()!.n), 1);
});

test("Python-migrated user/token schemas remain readable and are not replaced with legacy authority", async t => {
  const store = fixture(t), raw = randomBytes(32).toString("base64url"), pat = randomBytes(32).toString("base64url");
  const uid = randomUUID(), tid = randomUUID();
  // Exact column order and types from the Python Accounts migration.
  store.transaction(db => {
    db.exec(`CREATE TABLE account_migrations(id INTEGER PRIMARY KEY); INSERT INTO account_migrations VALUES(1);
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),status TEXT NOT NULL CHECK(status IN ('active','pending','disabled')),created REAL NOT NULL,salt TEXT,password_hash TEXT,iterations INTEGER);
      CREATE TABLE user_sessions(token_hash TEXT PRIMARY KEY,user TEXT NOT NULL,expires REAL NOT NULL);
      CREATE TABLE api_tokens(id TEXT PRIMARY KEY,user TEXT NOT NULL,name TEXT NOT NULL,scopes TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,last_used REAL,revoked REAL,prefix TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL);`);
    db.prepare("INSERT INTO users VALUES(?,?,'user','active',70000,NULL,NULL,NULL)").run(uid, "pythonuser");
    db.prepare("INSERT INTO user_sessions VALUES(?,?,?)").run(tokenHash(raw), uid, 81_000);
    db.prepare("INSERT INTO api_tokens VALUES(?,?,?, ?,70000,81000,NULL,NULL,?,?)").run(tid, uid, "existing", '["machines:read"]', pat.slice(0, 8), tokenHash(pat));
  });
  const accounts = new Accounts(store);
  assert.equal(accounts.session(raw).user.id, uid);
  assert.equal(accounts.principal(pat).user.id, uid);
  assert.deepEqual(accounts.principal(pat).scopes, ["machines:read"]);
  assert.equal(accounts.authorized(raw), false);
  assert.throws(() => accounts.session(pat), ServiceError);
  accounts.tokens(raw, undefined, tid);
  assert.throws(() => new Accounts(store).principal(pat), ServiceError);
  store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM account_migrations").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM administrator").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM admin_sessions").get()!.n, 0);
  });
});

test("first-admin setup adds legacy ownership column and never adopts lease assignments", async t => {
  const store = fixture(t), ordinary = randomUUID(), leased = randomUUID();
  store.transaction(db => {
    db.exec("CREATE TABLE machines(id TEXT PRIMARY KEY); CREATE TABLE lease_members(lease TEXT,name TEXT,machine TEXT);");
    db.prepare("INSERT INTO machines VALUES(?),(?)").run(ordinary, leased);
    db.prepare("INSERT INTO lease_members VALUES(?,?,?)").run(randomUUID(), "primary", leased);
  });
  const accounts = new Accounts(store), admin = await accounts.setup({ username: "admin", password });
  store.transaction(db => {
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(ordinary)!.owner, admin.user.id);
    assert.equal(db.prepare("SELECT owner FROM machines WHERE id=?").get(leased)!.owner, null);
  });
});

test("failed migration rolls back and does not mark legacy sessions consumed", async t => {
  const store = fixture(t);
  store.transaction(db => {
    db.exec("CREATE TABLE administrator(id INTEGER PRIMARY KEY,username TEXT,salt TEXT,password_hash TEXT,iterations INTEGER); CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT);");
    db.prepare("INSERT INTO administrator VALUES(1,'legacy','salt','hash',600000)").run();
  });
  assert.throws(() => new Accounts(store));
  store.transaction(db => {
    assert.equal(db.prepare("SELECT username FROM administrator").get()!.username, "legacy");
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='account_migrations'").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='consumed_administrator'").get(), undefined);
  });
});

test("independent startup workers serialize legacy migration and retain one identity", async t => {
  const store = fixture(t), raw = randomBytes(32).toString("base64url");
  store.transaction(db => {
    db.exec("CREATE TABLE administrator(id INTEGER PRIMARY KEY,username TEXT,salt TEXT,password_hash TEXT,iterations INTEGER); CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,expires REAL NOT NULL);");
    db.prepare("INSERT INTO administrator VALUES(1,'legacy',?,?,?)").run("ab".repeat(32), "cd".repeat(32), ITERATIONS);
    db.prepare("INSERT INTO admin_sessions VALUES(?,?)").run(tokenHash(raw), 80_600);
  });
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      Promise.all([import(workerData.accounts), import(workerData.sqlite)]).then(([{Accounts},{SqliteStore}]) => {
        const accounts = new Accounts(new SqliteStore(workerData.path, () => 80000));
        parentPort.postMessage(accounts.session(workerData.token).user.id);
      });
    `, { eval: true, workerData: { path: store.path, token: raw, accounts: new URL("../src/accounts.js", import.meta.url).href, sqlite: new URL("../src/sqlite.js", import.meta.url).href } });
    let result: string | undefined;
    worker.once("message", value => { result = value as string; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0 || !result) reject(new Error("Account migration worker failed"));
      else resolve(result);
    });
  })));
  assert.equal(new Set(results).size, 1);
  store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM account_migrations").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n, 1);
  });
});
