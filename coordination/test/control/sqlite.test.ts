import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";

function fixture(t: { after(callback: () => void): void }): SqliteStore {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-nested-sqlite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(join(directory, "state.sqlite"), () => 123);
  store.transaction(db => db.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY)"));
  return store;
}

test("nested authorization uses the outer connection and rolls back with it", t => {
  const store = fixture(t);
  assert.throws(() => store.transaction(outer => {
    outer.prepare("INSERT INTO evidence VALUES (1)").run();
    store.transaction(inner => {
      assert.equal(inner, outer);
      assert.equal(inner.prepare("SELECT count(*) AS n FROM evidence").get()!.n, 1);
      inner.prepare("INSERT INTO evidence VALUES (2)").run();
    });
    throw new Error("authorization revoked");
  }), /authorization revoked/);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM evidence").get()!.n), 0);
});

test("a caught inner failure rolls back its savepoint without losing outer work", t => {
  const store = fixture(t);
  store.transaction(db => {
    db.prepare("INSERT INTO evidence VALUES (1)").run();
    assert.throws(() => store.transaction(inner => {
      inner.prepare("INSERT INTO evidence VALUES (2)").run();
      throw new Error("inner failure");
    }), /inner failure/);
    assert.deepEqual(db.prepare("SELECT id FROM evidence ORDER BY id").all().map(row => row.id), [1]);
  });
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM evidence").get()!.n), 1);
});

test("expiry hooks run once per outer transaction before authorization and roll back on failure", t => {
  const store = fixture(t); let calls = 0;
  const remove = store.addTransactionHook((db, now) => {
    calls++;
    assert.equal(now, 123);
    db.prepare("INSERT INTO evidence VALUES (?)").run(calls);
  });
  assert.throws(() => store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM evidence").get()!.n, 1);
    store.transaction(() => assert.equal(calls, 1));
    throw new Error("rejected");
  }), /rejected/);
  remove();
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM evidence").get()!.n), 0);
  assert.equal(calls, 1);
});

test("nested asynchronous callbacks are rejected and their writes rolled back", t => {
  const store = fixture(t);
  store.transaction(() => {
    assert.throws(() => store.transaction(db => {
      db.prepare("INSERT INTO evidence VALUES (1)").run();
      return Promise.resolve(1);
    }), /synchronously/);
  });
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM evidence").get()!.n), 0);
});
