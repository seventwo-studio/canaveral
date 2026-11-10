import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Accounts } from "../src/accounts.ts";
import { SqliteStore } from "../src/sqlite.ts";

test("experimental account backend refuses a migrated Python identity database without creating legacy authority", () => {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-account-compat-"));
  try {
    const store = new SqliteStore(join(directory, "controller.sqlite3"));
    store.transaction(db => db.exec("CREATE TABLE account_migrations(id INTEGER PRIMARY KEY); INSERT INTO account_migrations VALUES(1);"));
    assert.throws(() => new Accounts(store), /Use the Python controller/);
    store.transaction(db => {
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='administrator'").get(), undefined);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='admin_sessions'").get(), undefined);
      assert.equal(db.prepare("SELECT count(*) AS count FROM account_migrations").get()?.count, 1);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
