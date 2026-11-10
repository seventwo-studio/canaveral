import { createHash, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ServiceError, object, secret } from "./errors.ts";
import { identifier } from "./consumers.ts";
import type { SqliteStore } from "./sqlite.ts";
import type { Principal } from "./control/contracts.ts";

export type { Principal } from "./control/contracts.ts";
export const ITERATIONS = 600_000;
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const SCOPES = ["admin", "machines:access", "machines:read", "machines:write"] as const;
export type UserRole = "admin" | "user";
export type UserStatus = "pending" | "active" | "disabled";
export type ClaimKind = "bootstrap" | "invite" | "reset";
export interface User { id: string; username: string; role: UserRole; status: UserStatus; createdAt: number }
export interface Session { user: User; expiresAt: number }
export interface NewSession extends Session { token: string }
export interface AccountPrincipal extends Principal { kind: "session" | "token"; user: User; expiresAt: number }
export interface ClaimInfo { kind: ClaimKind; username: string | null; expiresAt: number }
export interface NewClaim extends ClaimInfo { token: string }
export interface ApiToken {
  id: string; name: string; scopes: string[]; createdAt: number; expiresAt: number;
  lastUsedAt: number | null; revokedAt: number | null; prefix: string;
}
export interface NewApiToken extends ApiToken { token?: string }
export interface AdminApiToken extends ApiToken { userId: string }
interface UserRow {
  id: string; username: string; role: UserRole; status: UserStatus; created: number;
  salt: string | null; password_hash: string | null; iterations: number | null;
}
interface TokenRow {
  id: string; user: string; name: string; scopes: string; created: number; expires: number;
  last_used: number | null; revoked: number | null; prefix: string; token_hash: string;
}
interface ClaimRow { token_hash: string; user: string | null; kind: ClaimKind; expires: number; username: string | null; status: UserStatus | null }

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
  // Buffer's ASCII encoding truncates Unicode; Python's token encoding rejects it.
  if (/[^\x00-\x7f]/.test(token)) throw new ServiceError("Credential rejected.", 401);
  return createHash("sha256").update(token, "ascii").digest("hex");
}
export function fields(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const body = object(value);
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
    throw new ServiceError("Invalid request fields.", 400);
  }
  return body;
}
function publicUser(row: UserRow): User {
  return { id: row.id, username: row.username, role: row.role, status: row.status, createdAt: row.created };
}
function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "ascii"), b = Buffer.from(expected, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}
function uniqueConflict(error: unknown, message: string): never {
  if ((error as { errcode?: number }).errcode === 2067 || (error as { errcode?: number }).errcode === 1555) {
    throw new ServiceError(message, 409);
  }
  throw error;
}

/** User-bound credentials using the exact persisted Python account schema. */
export class Accounts {
  private readonly dummySalt = randomBytes(32).toString("hex");
  constructor(readonly store: SqliteStore) {
    store.transaction(db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK(id=1),username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,iterations INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY,expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_throttle (id INTEGER PRIMARY KEY CHECK(id=1),started REAL NOT NULL,attempts INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS account_migrations (id INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),status TEXT NOT NULL CHECK(status IN ('active','pending','disabled')),created REAL NOT NULL,salt TEXT,password_hash TEXT,iterations INTEGER);
        CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY,user TEXT NOT NULL,expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS account_claims (token_hash TEXT PRIMARY KEY,user TEXT,kind TEXT NOT NULL,expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY,user TEXT NOT NULL,name TEXT NOT NULL,scopes TEXT NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,last_used REAL,revoked REAL,prefix TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL);
      `);
      if (!db.prepare("SELECT 1 FROM account_migrations WHERE id=1").get()) {
        const old = db.prepare("SELECT * FROM administrator").get() as Omit<UserRow, "id" | "role" | "status" | "created"> | undefined;
        if (old) {
          const uid = randomUUID();
          db.prepare("INSERT INTO users VALUES (?,?,'admin','active',?,?,?,?)")
            .run(uid, old.username, store.clock(), old.salt, old.password_hash, old.iterations);
          db.prepare("INSERT INTO user_sessions SELECT token_hash,?,expires FROM admin_sessions WHERE expires>?").run(uid, store.clock());
          this.backfill(db, uid);
        }
        db.exec("INSERT INTO account_migrations VALUES (1)");
      }
      // Empty compatibility tables cannot become a second accepted authority.
      db.exec(`DELETE FROM administrator; DELETE FROM admin_sessions;
        CREATE TRIGGER IF NOT EXISTS consumed_administrator BEFORE INSERT ON administrator WHEN EXISTS (SELECT 1 FROM account_migrations WHERE id=1) BEGIN SELECT RAISE(ABORT,'Legacy account authority has been consumed'); END;
        CREATE TRIGGER IF NOT EXISTS consumed_admin_sessions BEFORE INSERT ON admin_sessions WHEN EXISTS (SELECT 1 FROM account_migrations WHERE id=1) BEGIN SELECT RAISE(ABORT,'Legacy account authority has been consumed'); END;`);
    });
  }

  private backfill(db: DatabaseSync, uid: string): void {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='machines'").get()) return;
    if (!db.prepare("PRAGMA table_info(machines)").all().some(column => column.name === "owner")) {
      db.exec("ALTER TABLE machines ADD COLUMN owner TEXT");
    }
    const leases = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_members'").get();
    db.prepare(`UPDATE machines SET owner=? WHERE owner IS NULL${leases ? " AND id NOT IN (SELECT machine FROM lease_members)" : ""}`).run(uid);
  }

  status(): { setupRequired: boolean } {
    return this.store.transaction(db => ({ setupRequired: !db.prepare("SELECT 1 FROM users WHERE role='admin'").get() }));
  }
  private newSession(db: DatabaseSync, row: UserRow): NewSession {
    const token = randomBytes(32).toString("base64url"), expires = this.store.clock() + SESSION_SECONDS;
    db.prepare("DELETE FROM user_sessions WHERE expires<=?").run(this.store.clock());
    db.prepare("DELETE FROM user_sessions WHERE token_hash IN (SELECT token_hash FROM user_sessions WHERE user=? ORDER BY expires DESC LIMIT -1 OFFSET 63)").run(row.id);
    db.prepare("INSERT INTO user_sessions VALUES (?,?,?)").run(tokenHash(token), row.id, expires);
    return { token, expiresAt: expires, user: publicUser(row) };
  }
  async setup(value: unknown): Promise<NewSession> {
    const body = fields(value, ["username", "password"], ["username", "password"]), name = username(body.username);
    const salt = randomBytes(32).toString("hex"), encoded = await passwordHash(passwordBytes(body.password), salt);
    return this.store.transaction(db => {
      if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
        throw new ServiceError("An administrator already exists. Sign in with the existing account.", 409);
      }
      const uid = randomUUID();
      try { db.prepare("INSERT INTO users VALUES (?,?,'admin','active',?,?,?,?)").run(uid, name, this.store.clock(), salt, encoded, ITERATIONS); }
      catch (error) { uniqueConflict(error, "Username already used."); }
      this.backfill(db, uid);
      db.exec("DELETE FROM account_claims WHERE kind='bootstrap'");
      return this.newSession(db, db.prepare("SELECT * FROM users WHERE id=?").get(uid) as unknown as UserRow);
    });
  }
  private attempt(): void {
    const now = this.store.clock();
    this.store.transaction(db => {
      const row = db.prepare("SELECT started,attempts FROM auth_throttle WHERE id=1").get() as { started: number; attempts: number } | undefined;
      if (!row || now - row.started >= 60) db.prepare("INSERT OR REPLACE INTO auth_throttle VALUES (1,?,1)").run(now);
      else {
        if (row.attempts >= 10) throw new ServiceError("Too many sign-in attempts. Try again in one minute.", 429);
        db.exec("UPDATE auth_throttle SET attempts=attempts+1 WHERE id=1");
      }
    });
  }
  async login(value: unknown): Promise<NewSession> {
    const body = fields(value, ["username", "password"], ["username", "password"]);
    this.attempt();
    let name: string, password: Buffer;
    try { name = username(body.username); password = passwordBytes(body.password); }
    catch { throw new ServiceError("Username or password rejected.", 401); }
    const row = this.store.transaction(db => db.prepare("SELECT * FROM users WHERE username=?").get(name)) as UserRow | undefined;
    const encoded = await passwordHash(password, row?.salt ?? this.dummySalt, row?.iterations ?? ITERATIONS);
    if (!row || row.status !== "active" || !matches(encoded, row.password_hash ?? "0".repeat(64))) {
      throw new ServiceError("Username or password rejected.", 401);
    }
    return this.store.transaction(db => {
      const current = db.prepare("SELECT * FROM users WHERE id=?").get(row.id) as UserRow | undefined;
      if (!current || current.status !== "active" || current.password_hash !== row.password_hash) {
        throw new ServiceError("Username or password rejected.", 401);
      }
      return this.newSession(db, current);
    });
  }

  /** Revalidate inside a caller's existing transaction; never nests BEGIN IMMEDIATE. */
  principalDb(db: DatabaseSync, value: unknown, sessionOnly = false): AccountPrincipal {
    let hashed: string;
    try { hashed = tokenHash(secret(value)); } catch { throw new ServiceError("Credential rejected.", 401); }
    const now = this.store.clock();
    const session = db.prepare("SELECT u.*,s.expires FROM user_sessions s JOIN users u ON u.id=s.user WHERE s.token_hash=? AND s.expires>?").get(hashed, now) as (UserRow & { expires: number }) | undefined;
    if (session?.status === "active") {
      return { user: publicUser(session), expiresAt: session.expires, kind: "session", scopes: [...SCOPES] };
    }
    if (!sessionOnly) {
      const row = db.prepare("SELECT u.*,t.scopes,t.expires,t.id AS token_id,t.last_used FROM api_tokens t JOIN users u ON u.id=t.user WHERE t.token_hash=? AND t.revoked IS NULL AND t.expires>?")
        .get(hashed, now) as (UserRow & { scopes: string; expires: number; token_id: string; last_used: number | null }) | undefined;
      if (row?.status === "active") {
        if (row.last_used === null || now - row.last_used >= 60) db.prepare("UPDATE api_tokens SET last_used=? WHERE id=?").run(now, row.token_id);
        return { user: publicUser(row), expiresAt: row.expires, kind: "token", scopes: JSON.parse(row.scopes) as string[] };
      }
    }
    throw new ServiceError("Credential rejected.", 401);
  }
  principal(token: string, sessionOnly = false): AccountPrincipal {
    return this.store.transaction(db => this.principalDb(db, token, sessionOnly));
  }
  session(value: unknown): Session {
    const p = this.store.transaction(db => this.principalDb(db, value, true));
    return { user: p.user, expiresAt: p.expiresAt };
  }
  /** Compatibility for the admin-only identity worker, not a general signed-in check. */
  authorized(token: unknown): boolean {
    try {
      const p = this.store.transaction(db => this.principalDb(db, token));
      return p.user.role === "admin" && p.scopes.includes("admin");
    } catch (error) { if (error instanceof ServiceError) return false; throw error; }
  }
  logout(value: unknown): { ok: true } {
    this.store.transaction(db => {
      this.principalDb(db, value, true);
      db.prepare("DELETE FROM user_sessions WHERE token_hash=?").run(tokenHash(value as string));
    });
    return { ok: true };
  }
  private invalidate(db: DatabaseSync, uid: string): void {
    db.prepare("DELETE FROM user_sessions WHERE user=?").run(uid);
    db.prepare("UPDATE api_tokens SET revoked=COALESCE(revoked,?) WHERE user=?").run(this.store.clock(), uid);
    db.prepare("DELETE FROM account_claims WHERE user=?").run(uid);
  }
  async changePassword(token: string, value: unknown): Promise<{ ok: true }> {
    const body = fields(value, ["currentPassword", "password"], ["currentPassword", "password"]);
    const row = this.store.transaction(db => {
      const p = this.principalDb(db, token, true);
      return db.prepare("SELECT * FROM users WHERE id=?").get(p.user.id) as unknown as UserRow;
    });
    const oldPassword = passwordBytes(body.currentPassword), newPassword = passwordBytes(body.password);
    const salt = randomBytes(32).toString("hex");
    const [old, encoded] = await Promise.all([passwordHash(oldPassword, row.salt!, row.iterations!), passwordHash(newPassword, salt)]);
    this.store.transaction(db => {
      this.principalDb(db, token, true);
      const current = db.prepare("SELECT * FROM users WHERE id=?").get(row.id) as unknown as UserRow;
      if (!current.password_hash || current.password_hash !== row.password_hash || !matches(old, current.password_hash)) throw new ServiceError("Password rejected.", 401);
      db.prepare("UPDATE users SET salt=?,password_hash=?,iterations=? WHERE id=?").run(salt, encoded, ITERATIONS, row.id);
      this.invalidate(db, row.id);
    });
    return { ok: true };
  }
  private admin(db: DatabaseSync, token: string, operator: boolean): void {
    if (operator) return;
    const p = this.principalDb(db, token);
    if (p.user.role !== "admin" || !p.scopes.includes("admin")) throw new ServiceError("Administrator required.", 403);
  }
  users(token: string, operator = false): { users: User[] } {
    return this.store.transaction(db => {
      this.admin(db, token, operator);
      return { users: (db.prepare("SELECT * FROM users ORDER BY created,id").all() as unknown as UserRow[]).map(publicUser) };
    });
  }
  createUser(token: string, value: unknown, operator = false): User {
    const body = fields(value, ["id", "username", "role"], ["id", "username"]);
    const uid = identifier(body.id), name = username(body.username), role = Object.hasOwn(body, "role") ? body.role : "user";
    if (role !== "admin" && role !== "user") throw new ServiceError("Invalid role.", 400);
    return this.store.transaction(db => {
      this.admin(db, token, operator);
      const old = db.prepare("SELECT * FROM users WHERE id=?").get(uid) as UserRow | undefined;
      if (old) {
        if (old.username !== name || old.role !== role) throw new ServiceError("User identity already used.", 409);
        return publicUser(old);
      }
      try { db.prepare("INSERT INTO users(id,username,role,status,created) VALUES (?,?,?,'pending',?)").run(uid, name, role, this.store.clock()); }
      catch (error) { uniqueConflict(error, "Username already used."); }
      return publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(uid) as unknown as UserRow);
    });
  }
  updateUser(token: string, id: string, value: unknown, operator = false): User {
    const uid = identifier(id), body = fields(value, ["role", "status"]);
    if (!Object.keys(body).length || Object.hasOwn(body, "role") && !["admin", "user"].includes(body.role as string) ||
        Object.hasOwn(body, "status") && !["active", "pending", "disabled"].includes(body.status as string)) throw new ServiceError("Invalid account update.", 400);
    return this.store.transaction(db => {
      this.admin(db, token, operator);
      const row = db.prepare("SELECT * FROM users WHERE id=?").get(uid) as UserRow | undefined;
      if (!row) throw new ServiceError("Unknown user.", 404);
      const role = (body.role ?? row.role) as UserRole, status = (body.status ?? row.status) as UserStatus;
      const reenable = status === "pending" && row.status === "disabled";
      if (status === "pending" && !["pending", "disabled"].includes(row.status)) throw new ServiceError("Use password reset for an active account.", 409);
      if (status === "active" && row.status === "disabled") throw new ServiceError("Enable this account to pending and issue a fresh invitation.", 409);
      if (status === "active" && !row.password_hash) throw new ServiceError("Redeem an invitation before activation.", 409);
      if (row.role === "admin" && row.status === "active" && (role !== "admin" || status !== "active") && this.activeAdmins(db) <= 1) {
        throw new ServiceError("Cannot remove the last active administrator.", 409);
      }
      db.prepare("UPDATE users SET role=?,status=? WHERE id=?").run(role, status, uid);
      if (reenable) db.prepare("UPDATE users SET password_hash=NULL,salt=NULL,iterations=NULL WHERE id=?").run(uid);
      if (status === "disabled" || reenable) this.invalidate(db, uid);
      else if (role !== row.role) db.prepare("DELETE FROM account_claims WHERE user=?").run(uid);
      return publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(uid) as unknown as UserRow);
    });
  }
  private activeAdmins(db: DatabaseSync): number {
    return db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND status='active'").get()!.n as number;
  }
  issueClaim(token: string, kind: ClaimKind, id: string | null = null, operator = false): NewClaim {
    if (!["bootstrap", "invite", "reset"].includes(kind)) throw new ServiceError("Invalid claim kind.", 400);
    if (kind === "bootstrap" && !operator) throw new ServiceError("Operator credential required.", 403);
    const uid = kind === "bootstrap" ? null : identifier(id);
    return this.store.transaction(db => {
      this.admin(db, token, operator);
      let row: UserRow | undefined;
      if (kind === "bootstrap") {
        if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) throw new ServiceError("Setup already completed.", 409);
        db.exec("DELETE FROM account_claims WHERE kind='bootstrap'");
      } else {
        row = db.prepare("SELECT * FROM users WHERE id=?").get(uid) as UserRow | undefined;
        if (!row) throw new ServiceError("Unknown user.", 404);
        if (kind === "invite" && row.status !== "pending") throw new ServiceError("Invitation requires a pending user.", 409);
        if (kind === "reset") {
          if (row.status === "disabled" && !operator) throw new ServiceError("Disabled account cannot reset.", 409);
          if (row.role === "admin" && row.status === "active" && !operator && this.activeAdmins(db) <= 1) {
            throw new ServiceError("Only operator recovery can reset the last active administrator.", 409);
          }
          this.invalidate(db, uid!);
          db.prepare("UPDATE users SET status='pending',password_hash=NULL,salt=NULL,iterations=NULL WHERE id=?").run(uid);
        }
        db.prepare("DELETE FROM account_claims WHERE user=?").run(uid);
      }
      const raw = randomBytes(32).toString("base64url"), expires = this.store.clock() + (kind === "bootstrap" ? 900 : 86400);
      db.prepare("INSERT INTO account_claims VALUES (?,?,?,?)").run(tokenHash(raw), uid, kind, expires);
      return { token: raw, kind, username: row?.username ?? null, expiresAt: expires };
    });
  }
  revokeClaim(token: string, id: string, operator = false): { ok: true } {
    const uid = identifier(id);
    this.store.transaction(db => {
      this.admin(db, token, operator);
      if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(uid)) throw new ServiceError("Unknown user.", 404);
      db.prepare("DELETE FROM account_claims WHERE user=?").run(uid);
    });
    return { ok: true };
  }
  private claim(db: DatabaseSync, raw: unknown): ClaimRow {
    let hashed: string;
    try { hashed = tokenHash(secret(raw)); } catch { throw new ServiceError("Claim rejected.", 401); }
    const row = db.prepare("SELECT c.*,u.username,u.status FROM account_claims c LEFT JOIN users u ON u.id=c.user WHERE token_hash=? AND expires>?")
      .get(hashed, this.store.clock()) as ClaimRow | undefined;
    if (!row || row.status === "disabled" || row.kind === "bootstrap" && db.prepare("SELECT 1 FROM users WHERE role='admin'").get() ||
        row.kind !== "bootstrap" && row.status !== "pending") throw new ServiceError("Claim rejected.", 401);
    return row;
  }
  claimInfo(value: unknown): ClaimInfo {
    const body = fields(value, ["token"], ["token"]); this.attempt();
    return this.store.transaction(db => {
      const row = this.claim(db, body.token);
      return { kind: row.kind, username: row.username, expiresAt: row.expires };
    });
  }
  async redeem(value: unknown): Promise<NewSession> {
    const body = fields(value, ["token", "username", "password"], ["token", "password"]); this.attempt();
    const claim = this.store.transaction(db => this.claim(db, body.token));
    let name: string | undefined;
    if (claim.kind === "bootstrap") name = username(body.username);
    else if (Object.hasOwn(body, "username")) throw new ServiceError("Claim rejected.", 401);
    const salt = randomBytes(32).toString("hex"), encoded = await passwordHash(passwordBytes(body.password), salt);
    return this.store.transaction(db => {
      const current = this.claim(db, body.token);
      let uid = current.user;
      if (current.kind === "bootstrap") {
        uid = randomUUID();
        try { db.prepare("INSERT INTO users VALUES (?,?,'admin','active',?,?,?,?)").run(uid, name!, this.store.clock(), salt, encoded, ITERATIONS); }
        catch (error) {
          if ([2067, 1555].includes((error as { errcode: number }).errcode)) throw new ServiceError("Claim rejected.", 401);
          throw error;
        }
        this.backfill(db, uid);
      } else {
        db.prepare("UPDATE users SET salt=?,password_hash=?,iterations=?,status='active' WHERE id=?").run(salt, encoded, ITERATIONS, uid);
      }
      this.invalidate(db, uid!);
      db.prepare("DELETE FROM account_claims WHERE token_hash=?").run(tokenHash(body.token as string));
      return this.newSession(db, db.prepare("SELECT * FROM users WHERE id=?").get(uid) as unknown as UserRow);
    });
  }
  private tokenPublic(row: TokenRow): ApiToken {
    return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as string[], createdAt: row.created, expiresAt: row.expires,
      lastUsedAt: row.last_used, revokedAt: row.revoked, prefix: row.prefix };
  }
  adminTokens(token: string, revoke?: string, operator = false): { tokens: AdminApiToken[] } | AdminApiToken {
    return this.store.transaction(db => {
      this.admin(db, token, operator);
      if (revoke === undefined) {
        return { tokens: (db.prepare("SELECT * FROM api_tokens ORDER BY created,id").all() as unknown as TokenRow[])
          .map(row => ({ ...this.tokenPublic(row), userId: row.user })) };
      }
      const tid = identifier(revoke);
      if (!db.prepare("SELECT 1 FROM api_tokens WHERE id=?").get(tid)) throw new ServiceError("Unknown token.", 404);
      db.prepare("UPDATE api_tokens SET revoked=COALESCE(revoked,?) WHERE id=?").run(this.store.clock(), tid);
      const row = db.prepare("SELECT * FROM api_tokens WHERE id=?").get(tid) as unknown as TokenRow;
      return { ...this.tokenPublic(row), userId: row.user };
    });
  }
  tokens(token: string): { tokens: ApiToken[] };
  tokens(token: string, value: unknown): NewApiToken;
  tokens(token: string, value: undefined, revoke: string): ApiToken;
  tokens(token: string, value?: unknown, revoke?: string): { tokens: ApiToken[] } | NewApiToken {
    let tid: string | undefined, name: string | undefined, scopes: string[] | undefined, ttl = 2592000;
    if (value !== undefined && revoke === undefined) {
      const body = fields(value, ["id", "name", "scopes", "expiresInSeconds"], ["id", "name", "scopes"]);
      tid = identifier(body.id);
      const duration = Object.hasOwn(body, "expiresInSeconds") ? body.expiresInSeconds : ttl;
      if (typeof body.name !== "string" || !body.name.trim() || Array.from(body.name).length > 100 ||
          !Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some(s => typeof s !== "string" || !(SCOPES as readonly string[]).includes(s)) ||
          new Set(body.scopes).size !== body.scopes.length || typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 60 || duration > 31536000) {
        throw new ServiceError("Invalid token specification.", 400);
      }
      name = body.name; scopes = [...body.scopes as string[]].sort(); ttl = duration;
    }
    return this.store.transaction(db => {
      const p = this.principalDb(db, token, true), uid = p.user.id;
      if (revoke !== undefined) {
        const row = db.prepare("SELECT * FROM api_tokens WHERE id=? AND user=?").get(identifier(revoke), uid) as TokenRow | undefined;
        if (!row) throw new ServiceError("Unknown token.", 404);
        db.prepare("UPDATE api_tokens SET revoked=COALESCE(revoked,?) WHERE id=?").run(this.store.clock(), row.id);
        return this.tokenPublic(db.prepare("SELECT * FROM api_tokens WHERE id=?").get(row.id) as unknown as TokenRow);
      }
      if (value === undefined) return { tokens: (db.prepare("SELECT * FROM api_tokens WHERE user=? ORDER BY created,id").all(uid) as unknown as TokenRow[]).map(row => this.tokenPublic(row)) };
      const old = db.prepare("SELECT * FROM api_tokens WHERE id=?").get(tid!) as TokenRow | undefined;
      if (old) {
        if (old.user !== uid) throw new ServiceError("Unknown token.", 404);
        if (old.name !== name || JSON.stringify((JSON.parse(old.scopes) as string[]).sort()) !== JSON.stringify(scopes) || old.expires - old.created !== ttl) {
          throw new ServiceError("Token identity already used.", 409);
        }
        return this.tokenPublic(old);
      }
      if (scopes!.includes("admin") && p.user.role !== "admin") throw new ServiceError("Administrator scope requires an administrator.", 403);
      const raw = randomBytes(32).toString("base64url"), now = this.store.clock();
      db.prepare("INSERT INTO api_tokens VALUES (?,?,?,?,?,?,NULL,NULL,?,?)").run(tid!, uid, name!, JSON.stringify(scopes), now, now + ttl, raw.slice(0, 8), tokenHash(raw));
      return { ...this.tokenPublic(db.prepare("SELECT * FROM api_tokens WHERE id=?").get(tid!) as unknown as TokenRow), token: raw };
    });
  }
}
