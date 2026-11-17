import type { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin, requireScope } from "./contracts.ts";
import type { ControlModule } from "./contracts.ts";
import { legacyDigest, normalizeTemplate, resources, text } from "./templates.ts";
import type { Template } from "./templates.ts";
import type { Resources } from "../consumers.ts";

export interface Blueprint {
  id: string; revision: string; name: string;
  source: { id: string; revision: string; arch: string };
  image: Template; minimum: Resources; defaults: Resources;
}
export function initializeBlueprints(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS blueprints (id TEXT NOT NULL, revision TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY(id,revision))");
}
export function blueprint(db: DatabaseSync, id: unknown, revision: unknown): Blueprint {
  const row = db.prepare("SELECT definition FROM blueprints WHERE id=? AND revision=?").get(identifier(id), text(revision, "blueprint revision"));
  if (!row) throw new ServiceError("Unknown machine blueprint revision.", 404);
  return JSON.parse(String(row.definition)) as Blueprint;
}
const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
export function saveBlueprint(db: DatabaseSync, value: unknown): Blueprint {
  const v = object(value), s = object(v.source);
  if (Object.keys(v).some(k => !["id", "revision", "name", "source", "minimum", "defaults"].includes(k)) || Object.keys(s).some(k => !["id", "revision", "arch"].includes(k))) throw new ServiceError("Unknown blueprint fields.", 400);
  const source = { id: text(s.id, "source image ID"), revision: text(s.revision, "source image revision"), arch: text(s.arch, "source architecture") };
  const row = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(source.id, source.revision, source.arch);
  if (!row) throw new ServiceError("Choose a registered source image revision.", 404);
  const image = normalizeTemplate(JSON.parse(String(row.definition)));
  if (image.mode === "device") throw new ServiceError("Machine blueprints currently require a VM image.", 400);
  const minimum = resources(v.minimum ?? image.minimum), defaults = resources(v.defaults ?? minimum);
  if (keys.some(k => minimum[k] < image.minimum[k] || defaults[k] < minimum[k]) || minimum.memoryMiB % image.memoryStepMiB || defaults.memoryMiB % image.memoryStepMiB) throw new ServiceError("Blueprint resources must satisfy the source minimums and memory granularity.", 400);
  const result: Blueprint = { id: identifier(v.id), revision: text(v.revision, "blueprint revision"), name: text(v.name, "blueprint name"), source, image, minimum, defaults };
  const previous = db.prepare("SELECT definition FROM blueprints WHERE id=? AND revision=?").get(result.id, result.revision);
  if (previous && legacyDigest(JSON.parse(String(previous.definition))) !== legacyDigest(result)) throw new ServiceError("Blueprint revision is immutable; save changes as a new revision.", 409);
  if (!previous) db.prepare("INSERT INTO blueprints VALUES (?,?,?)").run(result.id, result.revision, JSON.stringify(result));
  return result;
}
export function createModule(store: SqliteStore): ControlModule {
  store.transaction(initializeBlueprints);
  return { handle(req) {
    if (req.path !== "/v1/blueprints" || !["GET", "POST"].includes(req.method)) return undefined;
    return store.transaction(db => {
      if (req.method === "POST") { requireAdmin(req); return { body: saveBlueprint(db, req.body) }; }
      requireScope(req, "read");
      return { body: { blueprints: db.prepare("SELECT definition FROM blueprints ORDER BY rowid DESC").all().map(row => JSON.parse(String(row.definition))) } };
    });
  } };
}
