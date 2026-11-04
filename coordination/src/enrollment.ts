import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import { object, secret, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";

export interface Binding { controllerId: string; runnerId: string; generation: number; incarnationId: string }
interface RunnerRow { controller: string; runner: string; generation: number; incarnation: string; credential: string; revision: number; revoked: number }
interface EnrollmentRow { id: string; controller: string; runner: string; generation: number; incarnation: string; token: string; expires: number; consumed: string | null; revoked: number }
const bindingFields = ["controllerId", "runnerId", "generation", "incarnationId"];
function fields(value: unknown, names: string[]): Record<string, unknown> {
  const input = object(value);
  if (Object.keys(input).length !== names.length || names.some(key => !Object.hasOwn(input, key))) throw new ServiceError("Invalid enrollment fields.", 400);
  return input;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ServiceError("Invalid enrollment counter or lifetime.", 400);
  return value;
}
function hash(value: unknown, domain: string): string {
  return createHash("sha256").update(domain + ":" + secret(value), "ascii").digest("hex");
}
function proof(value: unknown, domain: string): string {
  try { return hash(value, domain); } catch { return denied(); }
}
function equal(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
function denied(): never { throw new ServiceError("Runner credential or enrollment rejected.", 401); }

/** Additive identity state only. Never adopts a legacy host or changes reservations. */
export class RunnerEnrollment {
  readonly controllerId: string;
  constructor(readonly store: SqliteStore, controllerId: string) {
    this.controllerId = identifier(controllerId);
    store.transaction(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS runner_controller_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runner_enrollments (id TEXT PRIMARY KEY, controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, token TEXT NOT NULL UNIQUE, expires REAL NOT NULL, consumed TEXT, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS runner_bindings (controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, credential TEXT NOT NULL, revision INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(controller,runner,generation), UNIQUE(controller,runner,incarnation));
        CREATE TABLE IF NOT EXISTS runner_credential_history (credential TEXT PRIMARY KEY, controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, revision INTEGER NOT NULL);`);
      const saved = db.prepare("SELECT id FROM runner_controller_identity WHERE singleton=1").get();
      if (saved && saved.id !== this.controllerId) throw new ServiceError("Controller identity does not match persisted state.", 409);
      db.prepare("INSERT OR IGNORE INTO runner_controller_identity VALUES (1,?)").run(this.controllerId);
    });
  }
  private binding(input: Record<string, unknown>): Binding {
    const result = { controllerId: identifier(input.controllerId), runnerId: identifier(input.runnerId), generation: positive(input.generation), incarnationId: identifier(input.incarnationId) };
    if (result.controllerId !== this.controllerId) throw new ServiceError("Wrong controller identity.", 403);
    return result;
  }
  private latest(db: DatabaseSync, b: Binding): RunnerRow | undefined {
    return db.prepare("SELECT * FROM runner_bindings WHERE controller=? AND runner=? ORDER BY generation DESC LIMIT 1").get(b.controllerId, b.runnerId) as unknown as RunnerRow | undefined;
  }
  private matches(row: RunnerRow, b: Binding): boolean { return row.generation === b.generation && row.incarnation === b.incarnationId; }
  private approval(db: DatabaseSync, b: Binding): void {
    const row = this.latest(db, b);
    if (row && (!row.revoked || b.generation <= row.generation || b.incarnationId === row.incarnation)) throw new ServiceError("Reenrollment requires revocation, a newer generation and a fresh incarnation.", 409);
    if (db.prepare("SELECT 1 FROM runner_bindings WHERE controller=? AND runner=? AND incarnation=?").get(b.controllerId, b.runnerId, b.incarnationId)) throw new ServiceError("Incarnation already exists.", 409);
    // Retained Python identities require a separate, explicit migration; never adopt them.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosts'").get() && db.prepare("SELECT 1 FROM hosts WHERE id=?").get(b.runnerId)) throw new ServiceError("Legacy host identity requires explicit migration.", 409);
  }
  private rejectEnrollmentSecret(db: DatabaseSync, credential: unknown): void {
    if (db.prepare("SELECT 1 FROM runner_enrollments WHERE token=?").get(hash(credential, "enrollment"))) {
      throw new ServiceError("Runner and enrollment credentials must differ.", 400);
    }
  }
  private remember(db: DatabaseSync, b: Binding, credential: string, revision: number): void {
    if (db.prepare("SELECT 1 FROM runner_credential_history WHERE credential=?").get(credential)) throw new ServiceError("Runner credential was already used; generate a fresh secret.", 409);
    db.prepare("INSERT INTO runner_credential_history VALUES (?,?,?,?,?)").run(credential, b.controllerId, b.runnerId, b.generation, revision);
  }
  issue(value: unknown): unknown {
    const input = fields(value, ["id", ...bindingFields, "ttlSeconds"]), b = this.binding(input);
    const id = identifier(input.id), ttl = positive(input.ttlSeconds, 1800);
    return this.store.transaction(db => {
      if (db.prepare("SELECT 1 FROM runner_enrollments WHERE id=?").get(id)) throw new ServiceError("Enrollment ID already issued; inspect and revoke after a lost reply.", 409);
      this.approval(db, b);
      const token = randomBytes(32).toString("base64url"), expiresAt = this.store.clock() + ttl;
      db.prepare("INSERT INTO runner_enrollments VALUES (?,?,?,?,?,?,?,NULL,0)").run(id, b.controllerId, b.runnerId, b.generation, b.incarnationId, hash(token, "enrollment"), expiresAt);
      return { id, ...b, expiresAt, enrollmentToken: token };
    });
  }
  inspect(id: string): unknown {
    return this.store.transaction(db => {
      const r = this.enrollment(db, id);
      return { id: r.id, controllerId: r.controller, runnerId: r.runner, generation: r.generation, incarnationId: r.incarnation, expiresAt: r.expires,
        state: r.revoked ? "revoked" : r.consumed ? "consumed" : r.expires <= this.store.clock() ? "expired" : "pending" };
    });
  }
  private enrollment(db: DatabaseSync, id: string): EnrollmentRow {
    const row = db.prepare("SELECT * FROM runner_enrollments WHERE id=?").get(identifier(id)) as unknown as EnrollmentRow | undefined;
    if (!row) throw new ServiceError("Unknown enrollment.", 404);
    return row;
  }
  revokeEnrollment(id: string): unknown {
    return this.store.transaction(db => { this.enrollment(db, id); db.prepare("UPDATE runner_enrollments SET revoked=1 WHERE id=?").run(identifier(id)); return { id: identifier(id), revoked: true }; });
  }
  consume(token: string, value: unknown): unknown {
    const input = fields(value, ["id", ...bindingFields, "credential"]), b = this.binding(input);
    const tokenHash = proof(token, "enrollment"), credential = hash(input.credential, "runner");
    return this.store.transaction(db => {
      const r = db.prepare("SELECT * FROM runner_enrollments WHERE id=?").get(identifier(input.id)) as unknown as EnrollmentRow | undefined;
      if (!r) denied();
      if (!equal(r.token, tokenHash) || r.revoked) denied();
      if (r.controller !== b.controllerId || r.runner !== b.runnerId || r.generation !== b.generation || r.incarnation !== b.incarnationId) denied();
      this.rejectEnrollmentSecret(db, input.credential);
      if (r.consumed) {
        const row = this.latest(db, b);
        if (!row || row.revoked || !this.matches(row, b) || row.revision !== 1 || !equal(r.consumed, credential) || !equal(row.credential, credential)) denied();
      } else {
        if (r.expires <= this.store.clock()) denied();
        this.approval(db, b);
        this.remember(db, b, credential, 1);
        db.prepare("INSERT INTO runner_bindings VALUES (?,?,?,?,?,1,0)").run(b.controllerId, b.runnerId, b.generation, b.incarnationId, credential);
        db.prepare("UPDATE runner_enrollments SET consumed=? WHERE id=?").run(credential, r.id);
      }
      return { ...b, credentialRevision: 1 };
    });
  }
  authenticate(token: string, value: unknown): unknown {
    return this.store.transaction(db => this.verify(db, token, value));
  }
  /** Runner proof inside the caller's transaction, so workload effects cannot outlive revocation. */
  verify(db: DatabaseSync, token: string, value: unknown): Binding & { credentialRevision: number } {
    const b = this.binding(fields(value, bindingFields)), credential = proof(token, "runner");
    const row = this.latest(db, b);
    if (!row || row.revoked || !this.matches(row, b) || !equal(row.credential, credential)) denied();
    return { ...b, credentialRevision: row.revision };
  }
  /** The normalized binding only if it is the latest unrevoked binding with this exact generation and incarnation. */
  current(db: DatabaseSync, value: unknown): Binding | undefined {
    const b = this.binding(fields(value, bindingFields)), row = this.latest(db, b);
    return row && !row.revoked && this.matches(row, b) ? b : undefined;
  }
  manage(value: unknown, revoke: boolean): unknown {
    const input = fields(value, [...bindingFields, ...(revoke ? [] : ["credentialRevision", "credential"])]), b = this.binding(input);
    const revision = revoke ? 0 : positive(input.credentialRevision), credential = revoke ? "" : hash(input.credential, "runner");
    return this.store.transaction(db => {
      const row = this.latest(db, b);
      if (!row || !this.matches(row, b)) throw new ServiceError("Unknown or stale runner binding.", 409);
      if (revoke) {
        db.prepare("UPDATE runner_bindings SET revoked=1 WHERE controller=? AND runner=? AND generation=?").run(b.controllerId, b.runnerId, b.generation);
        return { ...b, revoked: true };
      }
      if (row.revoked) throw new ServiceError("Revoked runner cannot rotate credentials.", 409);
      this.rejectEnrollmentSecret(db, input.credential);
      if (revision === row.revision && equal(row.credential, credential)) return { ...b, credentialRevision: revision };
      if (equal(row.credential, credential)) throw new ServiceError("Rotation requires a fresh credential.", 409);
      if (revision !== row.revision + 1) throw new ServiceError("Credential revision must advance exactly once.", 409);
      this.remember(db, b, credential, revision);
      db.prepare("UPDATE runner_bindings SET credential=?,revision=? WHERE controller=? AND runner=? AND generation=?").run(credential, revision, b.controllerId, b.runnerId, b.generation);
      return { ...b, credentialRevision: revision };
    });
  }
}
