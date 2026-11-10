import type { DatabaseSync } from "node:sqlite";

/** Drain affects new placement only; existing assignment reports retain authority. */
export function updateDraining(db: DatabaseSync, id: string, kind: "host" | "runner" = "host"): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_update_jobs'").get()) return false;
  const classified = db.prepare("PRAGMA table_info(host_update_jobs)").all().some(column => column.name === "target_kind");
  if (!classified && kind !== "host") return false;
  const sql = "SELECT 1 FROM host_update_jobs WHERE host=? AND phase NOT IN ('succeeded','rolledBack','failed','cancelled')";
  return Boolean(classified ? db.prepare(sql + " AND target_kind=?").get(id, kind) : db.prepare(sql).get(id));
}
