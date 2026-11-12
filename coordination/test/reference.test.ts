import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Accounts, passwordHash } from "../src/accounts.ts";
import { ConsumerIdentities, applicationSpec } from "../src/consumers.ts";
import type { ApplicationSpec } from "../src/consumers.ts";
import { SqliteStore } from "../src/sqlite.ts";

const reference = await import(new URL("../../../fixtures/migration/coordination_reference.ts", import.meta.url).href) as {
  PASSWORD: string; SALT: string; PASSWORD_HASH: string; TOKEN: string; SESSION_HASH: string;
  APPLICATION_TOKEN: string; APPLICATION_HASH: string; APPLICATION: ApplicationSpec;
};
function fixture(t: { after: (callback: () => void) => void }) {
  const folder = mkdtempSync(join(tmpdir(), "canaveral-migration-storage-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "controller.sqlite");
  return { path, store: new SqliteStore(path, () => 80_000) };
}

test("historical UTF-8 password derivation and session fingerprints match fixed values", async () => {
  assert.equal(await passwordHash(Buffer.from(reference.PASSWORD, "utf8"), reference.SALT), reference.PASSWORD_HASH);
  assert.equal(createHash("sha256").update(reference.TOKEN, "ascii").digest("hex"), reference.SESSION_HASH);
});

test("persisted legacy hashes and sessions retain login, logout and restart behavior", async t => {
  const { store } = fixture(t);
  store.transaction(db => {
    db.exec(`CREATE TABLE administrator (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,iterations INTEGER NOT NULL); CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,expires REAL NOT NULL);`);
    db.prepare("INSERT INTO administrator VALUES (1,'admin',?,?,600000)").run(reference.SALT, reference.PASSWORD_HASH);
    db.prepare("INSERT INTO admin_sessions VALUES (?,?)").run(reference.SESSION_HASH, 80_000 + 3600);
  });
  const accounts = new Accounts(store), migrated = accounts.session(reference.TOKEN);
  assert.equal(migrated.user.username,"admin"); assert.equal(migrated.user.role,"admin");
  assert.equal(migrated.expiresAt,83_600);
  const login = await accounts.login({ username: "ADMIN", password: reference.PASSWORD });
  assert.equal(login.user.id,migrated.user.id);
  const reopened = new Accounts(new SqliteStore(store.path, () => 80_000));
  assert.deepEqual(reopened.session(login.token), {user:login.user,expiresAt:login.expiresAt});
  reopened.logout(login.token); reopened.logout(reference.TOKEN);
  assert.equal(accounts.authorized(login.token), false);
  assert.equal(accounts.authorized(reference.TOKEN), false);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM user_sessions").get()!.n), 0);
});

test("migrated historical account schemas stay readable without resurrecting legacy authority", t => {
  const { store } = fixture(t);
  const uid = "11111111-2222-4333-8444-555555555555";
  store.transaction(db => {
    db.exec(`CREATE TABLE account_migrations(id INTEGER PRIMARY KEY); INSERT INTO account_migrations VALUES (1);
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL,salt TEXT,password_hash TEXT,iterations INTEGER);
      CREATE TABLE user_sessions(token_hash TEXT PRIMARY KEY,user TEXT NOT NULL,expires REAL NOT NULL);`);
    db.prepare("INSERT INTO users VALUES (?, 'admin','admin','active',80000,?,?,600000)").run(uid,reference.SALT,reference.PASSWORD_HASH);
    db.prepare("INSERT INTO user_sessions VALUES (?,?,83600)").run(reference.SESSION_HASH,uid);
  });
  const accounts = new Accounts(store);
  assert.equal(accounts.session(reference.TOKEN).user.id, uid);
  accounts.logout(reference.TOKEN);
  assert.equal(new Accounts(store).authorized(reference.TOKEN),false);
  store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM administrator").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM admin_sessions").get()!.n, 0);
    assert.throws(() => db.prepare("INSERT INTO admin_sessions VALUES (?,83600)").run(reference.SESSION_HASH),/consumed/);
    assert.throws(() => db.prepare("INSERT INTO administrator VALUES (1,'resurrected',?,?,600000)").run(reference.SALT,reference.PASSWORD_HASH),/consumed/);
  });
});

test("historical application policies and one-time hashes survive rotations and revocation", t => {
  const { store } = fixture(t), identities = new ConsumerIdentities(store);
  store.transaction(db => db.prepare("INSERT INTO consumers VALUES (?,?,?,0,80000)").run(reference.APPLICATION.id,JSON.stringify(reference.APPLICATION),reference.APPLICATION_HASH));
  assert.equal(identities.authenticate(reference.APPLICATION_TOKEN).id, reference.APPLICATION.id);
  const rotated = identities.rotate(reference.APPLICATION.id);
  assert.throws(() => identities.authenticate(reference.APPLICATION_TOKEN));
  assert.equal(identities.authenticate(rotated.credential).id, reference.APPLICATION.id);
  const stored = store.transaction(db => String(db.prepare("SELECT credential FROM consumers WHERE id=?").get(reference.APPLICATION.id)!.credential));
  assert.equal(stored,createHash("sha256").update(JSON.stringify(rotated.credential)).digest("hex"));
  assert.notEqual(stored,rotated.credential);
  identities.revoke(reference.APPLICATION.id);
  assert.throws(() => identities.authenticate(rotated.credential));
  assert.throws(() => identities.rotate(reference.APPLICATION.id));
  const created = identities.create({...reference.APPLICATION,id:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"});
  assert.equal(new ConsumerIdentities(new SqliteStore(store.path)).authenticate(created.credential).id,created.id);
  identities.revoke(created.id);
  assert.equal(identities.list().every(application => application.revoked),true);
});

test("Unicode policy ordering, resource limits and TTL defaults match fixed wire expectations", () => {
  const templates = ["😀", "\uFFFF", "alpha"].map(id => ({ id, revision: "4", arch: "arm64" }));
  const limits = {resources:reference.APPLICATION.limits.resources,activeLeases:2};
  const input = {...reference.APPLICATION,templates,limits};
  assert.deepEqual(applicationSpec(input), {...reference.APPLICATION, linuxEgress:{enabled:false}, templates:["alpha","\uFFFF","😀"].map(id=>({id,revision:"4",arch:"arm64"}))});
});
