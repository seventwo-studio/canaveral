import type { DatabaseSync } from "node:sqlite";
import { object, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import type { ControlModule, ControlOptions } from "./contracts.ts";
import { initializeDevices, operationRequest } from "./devices.ts";
import { machineIdentifier } from "./machines.ts";
import { ACTIVE, capabilities, legacyMachineReady, legacySessionLease, legacyTable, refreshLegacyLeases, sameJson, utc } from "./leases.ts";

interface Row {
  id: string; machine: string; host: string; request: string; state: string; result: string | null; updated: number; created: number;
  lease: string; member: string; credential: string; dispatched: number;
}
const actionCapabilities: Record<string, string> = {
  screenshot: "screenshot", hierarchy: "hierarchy", accessibility: "hierarchy", "accessibility-action": "hierarchy",
  tap: "input", swipe: "input", text: "input", key: "input", "list-files": "files", push: "files", pull: "files", shell: "command",
  "shell-open": "pty", "shell-read": "pty", "shell-write": "pty", "shell-close": "pty", "shell-resize": "pty",
};
export function initializeConsumerOperations(db: DatabaseSync): void {
  initializeDevices(db);
  db.exec(`CREATE TABLE IF NOT EXISTS consumer_operations (id TEXT PRIMARY KEY,lease TEXT NOT NULL,member TEXT NOT NULL,credential TEXT NOT NULL,dispatched INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS consumer_operations_lease ON consumer_operations(lease);`);
}
function row(db: DatabaseSync, id: string): Row | undefined {
  return db.prepare("SELECT d.*,c.lease,c.member,c.credential,c.dispatched FROM device_operations d JOIN consumer_operations c ON c.id=d.id WHERE d.id=?").get(id) as unknown as Row | undefined;
}
function view(value: Row) {
  return { id: value.id, leaseId: value.lease, member: value.member, state: value.state, updatedAt: utc(value.updated),
    ...(value.result === null ? {} : { result: JSON.parse(value.result) as unknown }) };
}
/** Closes invalid intents before dispatch/receipts. Dispatched effects without a receipt remain uncertain. */
export function refreshConsumerOperations(db: DatabaseSync, now: number, leaseId?: string): void {
  if (!["consumer_operations", "device_operations", "leases", "machines", "hosts"].every(name => legacyTable(db, name))) return;
  const rows = db.prepare("SELECT d.*,c.lease,c.credential,c.dispatched FROM device_operations d JOIN consumer_operations c ON c.id=d.id WHERE d.state='queued'" + (leaseId === undefined ? "" : " AND c.lease=?")).all(...(leaseId === undefined ? [] : [leaseId])) as unknown as Row[];
  for (const op of rows) {
    const lease = db.prepare("SELECT * FROM leases WHERE id=?").get(op.lease);
    const machine = db.prepare("SELECT m.*,h.seen,h.enabled,h.offer AS host_offer FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?").get(op.machine);
    const valid = leaseId === undefined && lease && lease.state === "ready" && lease.credential === op.credential &&
      now < Number(lease.expires) && now < op.created + 120 && machine && machine.host === op.host && legacyMachineReady(db, machine, now) &&
      db.prepare("SELECT 1 FROM consumers WHERE id=? AND revoked=0").get(lease.consumer!);
    if (!valid) {
      db.prepare("UPDATE device_operations SET state=?,result=?,updated=? WHERE id=? AND state='queued'")
        .run(op.dispatched ? "unknown" : "failed", JSON.stringify({ detail: "Operation authorization ended before a completed receipt. Inspect before issuing another effect." }), now, op.id);
    }
  }
}
/** Route module for the generic legacy namespace only; Linux operations retain their own ledger. */
export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  store.transaction(initializeConsumerOperations);
  return { handle(req) {
    const parts = req.parts;
    const submit = req.method === "POST" && parts.length === 4;
    const read = req.method === "GET" && parts.length === 5;
    if (parts[0] !== "v1" || parts[1] !== "leases" || parts[3] !== "operations" || (!submit && !read)) return undefined;
    const leaseId = machineIdentifier(parts[2]);
    return store.transaction(db => {
      if (!legacyTable(db, "leases") || !db.prepare("SELECT 1 FROM leases WHERE id=?").get(leaseId)) return undefined;
      refreshLegacyLeases(db, store.clock());
      const lease = legacySessionLease(db, leaseId, req.token);
      if (read) {
        const old = row(db, machineIdentifier(parts[4]));
        if (!old || old.lease !== lease.id) throw new ServiceError("Unknown operation.", 404);
        return { body: view(old) };
      }
      const input = object(req.body);
      if (Object.keys(input).length !== 4 || !["id", "member", "action", "arguments"].every(k => Object.hasOwn(input, k)) || typeof input.member !== "string" || !input.member.trim() || [...input.member].length > 100) throw new ServiceError("Operation requires id, explicit member, action and arguments.", 400);
      const request = operationRequest({ id: input.id, action: input.action, arguments: input.arguments });
      const existing = db.prepare("SELECT 1 FROM device_operations WHERE id=?").get(request.id);
      if (existing) {
        const old = row(db, request.id);
        if (!old || old.lease !== lease.id) throw new ServiceError("Unknown operation.", 404);
        if (old.member !== input.member || !sameJson(JSON.parse(old.request), request)) throw new ServiceError("Operation identity belongs to another request.", 409);
        return { body: view(old) };
      }
      if (legacyTable(db, "linux_operations") && db.prepare("SELECT 1 FROM linux_operations WHERE id=?").get(request.id)) throw new ServiceError("Unknown operation.", 404);
      if (!ACTIVE.includes(lease.state)) throw new ServiceError("Lease has ended.", 410);
      const machine = db.prepare("SELECT m.*,h.seen,h.enabled,h.offer AS host_offer FROM machines m JOIN hosts h ON h.id=m.host JOIN lease_members lm ON lm.machine=m.id WHERE lm.lease=? AND lm.name=?").get(lease.id, input.member);
      if (!machine) throw new ServiceError("Unknown environment member.", 404);
      const image = object(JSON.parse(String(machine.template))), cap = actionCapabilities[request.action];
      if (!cap || !capabilities(image)[cap as keyof ReturnType<typeof capabilities>]) throw new ServiceError("Requested operation capability is unsupported.", 409, { code: "capability_unsupported" });
      if (lease.state !== "ready" || !legacyMachineReady(db, machine, store.clock())) throw new ServiceError("Environment member is not ready for access.", 409, { code: "member_not_ready" });
      if (Number(db.prepare("SELECT count(*) AS n FROM device_operations WHERE host=? AND state='queued'").get(machine.host!)!.n) >= 32) throw new ServiceError("Host device operation queue is full.", 429);
      const now = store.clock();
      db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'queued',NULL,?,?)").run(request.id, machine.id!, machine.host!, JSON.stringify(request), now, now);
      db.prepare("INSERT INTO consumer_operations VALUES (?,?,?,?,0)").run(request.id, lease.id, input.member, lease.credential);
      return { status: 201, body: view(row(db, request.id)!) };
    });
  } };
}
