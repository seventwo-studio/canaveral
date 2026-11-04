import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Same SQLite file and BEGIN IMMEDIATE boundary as the Python controller.
 * Construct only for explicitly selected state; this does not select live state.
 * Lease-expiry transaction hooks will be added when the lease store is ported.
 */
export class SqliteStore {
  readonly path: string;
  constructor(path: string, readonly clock: () => number = () => Date.now() / 1000) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Set private permissions at creation, before SQLite can write credentials.
    try { closeSync(openSync(this.path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(this.path, 0o600);
  }

  transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path, { timeout: 15_000, enableForeignKeyConstraints: false });
    let began = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
      const result = operation(db);
      if (result !== null && (typeof result === "object" || typeof result === "function") &&
          "then" in result) {
        throw new TypeError("SQLite transactions must complete synchronously.");
      }
      db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) db.exec("ROLLBACK");
      throw error;
    } finally { db.close(); }
  }
}
