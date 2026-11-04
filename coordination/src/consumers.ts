import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { object, secret, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";

export interface Resources { cpu: number; memoryMiB: number; diskGiB: number }
export interface ImagePermission { id: string; revision: string; arch: "arm64" | "amd64" }
export interface ApplicationLimits {
  resources: Resources; activeLeases: number; defaultTTLSeconds: number;
  maxTTLSeconds: number; maxLifetimeSeconds: number; provisioningTimeoutSeconds: number;
}
export interface ApplicationSpec { id: string; name: string; templates: ImagePermission[]; limits: ApplicationLimits }
export interface Application extends ApplicationSpec { revoked: boolean; createdAt: number }
interface Row { id: string; specification: string; credential: string; revoked: number; created: number }

function exact(record: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) {
    throw new ServiceError("Invalid application policy fields.", 400);
  }
}

export function identifier(value: unknown): string {
  if (typeof value !== "string") throw new ServiceError("Expected a UUID.", 400);
  let normalized = value.replace(/^urn:uuid:/, "");
  if (normalized.startsWith("{") && normalized.endsWith("}")) normalized = normalized.slice(1, -1);
  normalized = normalized.replaceAll("-", "");
  if (/^[a-fA-F0-9]{32}$/.exec(normalized)?.[0] !== normalized) throw new ServiceError("Expected a UUID.", 400);
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`.toLowerCase();
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > 100) {
    throw new ServiceError(`Invalid ${label}.`, 400);
  }
  return value;
}

function integer(value: unknown, label: string, maximum = 1_048_576): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ServiceError(`Invalid ${label}.`, 400);
  }
  return value;
}

export function applicationLimits(value: unknown): ApplicationLimits {
  const limits = object(value);
  const ttlFields = ["defaultTTLSeconds", "maxTTLSeconds", "maxLifetimeSeconds", "provisioningTimeoutSeconds"] as const;
  if (Object.keys(limits).some(key => !["resources", "activeLeases", ...ttlFields].includes(key))) {
    throw new ServiceError("Invalid application limits.", 400);
  }
  const budget = object(limits.resources);
  exact(budget, ["cpu", "memoryMiB", "diskGiB"]);
  const result: ApplicationLimits = {
    resources: { cpu: integer(budget.cpu, "cpu"), memoryMiB: integer(budget.memoryMiB, "memoryMiB"), diskGiB: integer(budget.diskGiB, "diskGiB") },
    activeLeases: integer(limits.activeLeases, "active lease limit", 2 ** 31 - 1),
    defaultTTLSeconds: 1800, maxTTLSeconds: 3600, maxLifetimeSeconds: 86400, provisioningTimeoutSeconds: 900,
  };
  for (const key of ttlFields) result[key] = integer(Object.hasOwn(limits, key) ? limits[key] : result[key], key, 2 ** 31 - 1);
  if (!(result.defaultTTLSeconds <= result.maxTTLSeconds && result.maxTTLSeconds <= result.maxLifetimeSeconds)) {
    throw new ServiceError("Default TTL must fit maximum TTL and total lifetime.", 400);
  }
  return result;
}

// Match Python's code-point tuple ordering, including non-BMP image names.
function compareText(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const order = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (order) return order;
  }
  return left.length - right.length;
}

export function applicationSpec(value: unknown): ApplicationSpec {
  const input = object(value);
  exact(input, ["id", "name", "templates", "limits"]);
  if (!Array.isArray(input.templates) || input.templates.length > 1000) throw new ServiceError("Invalid application image allowlist.", 400);
  const seen = new Set<string>();
  const templates = input.templates.map(value => {
    const item = object(value); exact(item, ["id", "revision", "arch"]);
    if (item.arch !== "arm64" && item.arch !== "amd64") throw new ServiceError("Image permissions must pin id, revision and architecture.", 400);
    const entry: ImagePermission = { id: text(item.id, "image id"), revision: text(item.revision, "image revision"), arch: item.arch };
    const key = JSON.stringify([entry.id, entry.revision, entry.arch]);
    if (seen.has(key)) throw new ServiceError("Duplicate image permission.", 400);
    seen.add(key); return entry;
  });
  templates.sort((a, b) => compareText(a.id, b.id) || compareText(a.revision, b.revision) || compareText(a.arch, b.arch));
  return { id: identifier(input.id), name: text(input.name, "application name"), templates, limits: applicationLimits(input.limits) };
}

// Legacy application keys use digest(secret): SHA256 of its JSON string.
// Administrator sessions use SHA256(raw ASCII) and remain a distinct identity.
function credentialHash(token: string): string {
  return createHash("sha256").update(JSON.stringify(token), "utf8").digest("hex");
}

export class ConsumerIdentities {
  constructor(readonly store: SqliteStore) {
    store.transaction(db => db.exec(`
      CREATE TABLE IF NOT EXISTS consumers (id TEXT PRIMARY KEY,specification TEXT NOT NULL,credential TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS templates (id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY (id,revision,arch));
    `));
  }

  private public(row: Row): Application {
    return { ...JSON.parse(row.specification) as ApplicationSpec, revoked: Boolean(row.revoked), createdAt: row.created };
  }

  create(value: unknown): Application & { credential: string } {
    const spec = applicationSpec(value), token = randomBytes(32).toString("base64url");
    return this.store.transaction(db => {
      if (db.prepare("SELECT 1 FROM consumers WHERE id=?").get(spec.id)) {
        throw new ServiceError("Application ID already exists. Inspect it and rotate its credential after a lost creation response.", 409);
      }
      for (const image of spec.templates) {
        if (!db.prepare("SELECT 1 FROM templates WHERE id=? AND revision=? AND arch=?").get(image.id, image.revision, image.arch)) {
          throw new ServiceError("Application permission references an unknown image revision.", 400);
        }
      }
      db.prepare("INSERT INTO consumers VALUES (?,?,?,0,?)").run(spec.id, JSON.stringify(spec), credentialHash(token), this.store.clock());
      return { ...this.public(this.row(db, spec.id)), credential: token };
    });
  }

  list(): Application[] {
    return this.store.transaction(db => (db.prepare("SELECT * FROM consumers ORDER BY created,id").all() as unknown as Row[]).map(row => this.public(row)));
  }

  rotate(id: unknown): { id: string; credential: string } {
    const consumerId = identifier(id), token = randomBytes(32).toString("base64url");
    return this.store.transaction(db => {
      if (this.row(db, consumerId).revoked) throw new ServiceError("Revoked applications cannot be reactivated by credential rotation.", 409);
      db.prepare("UPDATE consumers SET credential=? WHERE id=?").run(credentialHash(token), consumerId);
      return { id: consumerId, credential: token };
    });
  }

  revoke(id: unknown): { id: string; revoked: true } {
    const consumerId = identifier(id);
    return this.store.transaction(db => {
      this.row(db, consumerId);
      db.prepare("UPDATE consumers SET revoked=1 WHERE id=?").run(consumerId);
      return { id: consumerId, revoked: true };
    });
  }

  authenticate(value: unknown): Application {
    let token: string;
    try { token = secret(value); } catch { throw new ServiceError("Application credential rejected.", 401); }
    return this.store.transaction(db => {
      const row = db.prepare("SELECT * FROM consumers WHERE credential=? AND revoked=0").get(credentialHash(token)) as Row | undefined;
      if (!row) throw new ServiceError("Application credential rejected.", 401);
      return this.public(row);
    });
  }

  private row(db: DatabaseSync, id: string): Row {
    const row = db.prepare("SELECT * FROM consumers WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new ServiceError("Unknown application.", 404);
    return row;
  }
}
