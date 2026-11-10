import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One synchronous transaction owner, including authorization and expiry checks. */
export class SqliteStore {
  readonly path: string;
  private active: DatabaseSync | undefined;
  private savepoint = 0;
  private readonly hooks = new Set<(db: DatabaseSync, now: number) => void>();
  constructor(path: string, readonly clock: () => number = () => Date.now() / 1000) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Set private permissions at creation, before SQLite can write credentials.
    try { closeSync(openSync(this.path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    chmodSync(this.path, 0o600);
  }

  /** Hooks run inside every outer write boundary, before protected reads or effects. */
  addTransactionHook(hook: (db: DatabaseSync, now: number) => void): () => void {
    this.hooks.add(hook);
    return () => { this.hooks.delete(hook); };
  }

  transaction<T>(operation: (db: DatabaseSync) => T): T {
    if (this.active) {
      const db = this.active;
      const name = `canaveral_nested_${++this.savepoint}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = operation(db);
        this.synchronous(result);
        db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        db.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    }
    const db = new DatabaseSync(this.path, { timeout: 15_000, enableForeignKeyConstraints: false });
    let began = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
      this.active = db;
      const now = this.clock();
      for (const hook of this.hooks) hook(db, now);
      const result = operation(db);
      this.synchronous(result);
      db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) db.exec("ROLLBACK");
      throw error;
    } finally { this.active = undefined; db.close(); }
  }

  private synchronous(value: unknown): void {
    if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value) {
      throw new TypeError("SQLite transactions must complete synchronously.");
    }
  }
}
