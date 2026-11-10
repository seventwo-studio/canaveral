import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ServiceError, object, secret } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";

export const ITERATIONS = 600_000;
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function username(value: unknown): string {
  if (typeof value !== "string" || /^[A-Za-z0-9][A-Za-z0-9_.@+-]{2,99}$/.exec(value)?.[0] !== value) {
    throw new ServiceError("Use a username of 3–100 letters, numbers, dots, underscores, @, + or -.", 400);
  }
  return value.toLowerCase();
}

export function passwordBytes(value: unknown): Buffer {
  if (typeof value !== "string" || Array.from(value).length < 12 || Array.from(value).length > 1024 ||
      Array.from(value).some(character => character.length === 1 && /[\uD800-\uDFFF]/.test(character))) {
    throw new ServiceError("Use a password of 12–1024 characters.", 400);
  }
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > 4096) throw new ServiceError("Password is too long.", 400);
  return encoded;
}

export async function passwordHash(password: Buffer, salt: string, iterations = ITERATIONS): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    pbkdf2(password, Buffer.from(salt, "hex"), iterations, 32, "sha256", (error, result) => {
      if (error) reject(error); else resolve(result.toString("hex"));
    });
  });
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export interface Session { user: { username: string }; expiresAt: number }
export interface NewSession extends Session { token: string }
interface Account { username: string; salt: string; password_hash: string; iterations: number }

export class Accounts {
  private readonly dummySalt = randomBytes(32).toString("hex");
  constructor(readonly store: SqliteStore) {
    store.transaction(db => {
      const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_migrations'").get();
      if (migrated && db.prepare("SELECT 1 FROM account_migrations WHERE id=1").get()) {
        throw new ServiceError("This database uses Python user and API-token authorization. Use the Python controller; the experimental TypeScript account backend cannot open it.", 503);
      }
      db.exec(`
      CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK (id=1), username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, iterations INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_throttle (id INTEGER PRIMARY KEY CHECK (id=1), started REAL NOT NULL, attempts INTEGER NOT NULL);
      `);
    });
  }

  status(): { setupRequired: boolean } {
    return this.store.transaction(db => ({ setupRequired: !db.prepare("SELECT 1 FROM administrator").get() }));
  }

  private newSession(db: DatabaseSync, name: string): NewSession {
    const token = randomBytes(32).toString("base64url");
    const expires = this.store.clock() + SESSION_SECONDS;
    db.prepare("DELETE FROM admin_sessions WHERE expires<=?").run(this.store.clock());
    db.exec("DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions ORDER BY expires DESC LIMIT -1 OFFSET 63)");
    db.prepare("INSERT INTO admin_sessions VALUES (?,?)").run(tokenHash(token), expires);
    return { token, expiresAt: expires, user: { username: name } };
  }

  async setup(value: unknown): Promise<NewSession> {
    const body = object(value), name = username(body.username), password = passwordBytes(body.password);
    const salt = randomBytes(32).toString("hex");
    // Expensive derivation stays off the event loop and outside the SQLite lock.
    // Recheck under BEGIN IMMEDIATE: concurrent setup can create only one row.
    const encoded = await passwordHash(password, salt);
    return this.store.transaction(db => {
      if (db.prepare("SELECT 1 FROM administrator").get()) {
        throw new ServiceError("An administrator already exists. Sign in with the existing account.", 409);
      }
      db.prepare("INSERT INTO administrator VALUES (1,?,?,?,?)").run(name, salt, encoded, ITERATIONS);
      return this.newSession(db, name);
    });
  }

  private attempt(): void {
    const now = this.store.clock();
    this.store.transaction(db => {
      const row = db.prepare("SELECT started,attempts FROM auth_throttle WHERE id=1").get() as
        { started: number; attempts: number } | undefined;
      if (!row || now - row.started >= 60) db.prepare("INSERT OR REPLACE INTO auth_throttle VALUES (1,?,1)").run(now);
      else {
        if (row.attempts >= 10) throw new ServiceError("Too many sign-in attempts. Try again in one minute.", 429);
        db.exec("UPDATE auth_throttle SET attempts=attempts+1 WHERE id=1");
      }
    });
  }

  async login(value: unknown): Promise<NewSession> {
    this.attempt();
    let name: string, password: Buffer;
    try { const body = object(value); name = username(body.username); password = passwordBytes(body.password); }
    catch { throw new ServiceError("Username or password rejected.", 401); }
    const account = this.store.transaction(db => db.prepare("SELECT * FROM administrator WHERE username=?").get(name)) as
      Account | undefined;
    const encoded = await passwordHash(password, account?.salt ?? this.dummySalt, account?.iterations ?? ITERATIONS);
    const expected = account?.password_hash ?? "0".repeat(64);
    const actualBytes = Buffer.from(encoded, "ascii"), expectedBytes = Buffer.from(expected, "ascii");
    const matches = actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
    if (!matches || !account) {
      throw new ServiceError("Username or password rejected.", 401);
    }
    return this.store.transaction(db => this.newSession(db, name));
  }

  session(value: unknown): Session {
    let token: string;
    try { token = secret(value); } catch { throw new ServiceError("Session credential rejected.", 401); }
    return this.store.transaction(db => {
      const row = db.prepare("SELECT expires FROM admin_sessions WHERE token_hash=?").get(tokenHash(token)) as
        { expires: number } | undefined;
      if (!row || row.expires <= this.store.clock()) throw new ServiceError("Session credential rejected.", 401);
      const admin = db.prepare("SELECT username FROM administrator WHERE id=1").get() as { username: string } | undefined;
      if (!admin) throw new ServiceError("Session credential rejected.", 401);
      return { user: { username: admin.username }, expiresAt: row.expires };
    });
  }

  authorized(token: unknown): boolean {
    try { this.session(token); return true; }
    catch (error) { if (error instanceof ServiceError) return false; throw error; }
  }

  logout(value: unknown): { ok: true } {
    let token: string;
    try { token = secret(value); } catch { throw new ServiceError("Session credential rejected.", 401); }
    this.store.transaction(db => { db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(tokenHash(token)); });
    return { ok: true };
  }
}
