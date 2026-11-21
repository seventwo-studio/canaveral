import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import { ATTENTION_KINDS, EVENT_KINDS, eventView, recordEvent } from "./events.ts";
import type { EventProjection, EventRow, EventView } from "./events.ts";
import type { SqliteStore } from "./sqlite.ts";

/** Alert destinations and their durable outbox.
 *
 * A delivery row is written by the event projection in the transaction that records its event, so
 * a committed event either has its deliveries or no destination selected it. Sending happens later,
 * outside every transaction: a claim transaction counts the attempt and schedules the next one
 * before any network I/O, then a second short transaction records the outcome. A controller that
 * stops between the two re-sends at the scheduled time, so delivery is at least once and never more
 * than `max_attempts` sends. Receivers de-duplicate on the stable delivery `id`.
 *
 * The webhook URL and the signing secret are stored as given in the controller's private (0600)
 * SQLite database, like its other controller-held state; they cannot be hashed because the
 * controller must present them. No route returns either value. There is no encryption at rest.
 */
export const MAX_ALERT_DESTINATIONS = 8;
export const ALERT_MAX_ATTEMPTS = 5;
/** Delay before attempts two to five. The last entry also bounds an interrupted final attempt. */
export const ALERT_BACKOFF_SECONDS = [10, 60, 300, 900];
export const ALERT_TIMEOUT_MS = 5000;
/** One alert per destination, kind and subject within this window, so a flapping condition cannot flood a channel. */
export const ALERT_COOLDOWN_SECONDS = 300;
const DELIVERY_RETENTION_SECONDS = 7 * 86400, DELIVERY_MAX_ROWS = 2000, CLAIM_BATCH = 8;

export type DestinationType = "slack" | "webhook";
interface DestinationRow { id: string; name: string; type: DestinationType; url: string; secret: string | null; kinds: string; intent: string; created: number; removed: number | null }
interface DeliveryRow {
  id: string; destination: string; seq: number | null; kind: string; subject: string | null; event: string; state: string; attempts: number;
  max_attempts: number; next_attempt: number; created: number; updated: number; status: number | null; outcome: string | null;
}
export interface SendResult { ok: boolean; status?: number; outcome: string }
export type AlertSender = (url: string, headers: Record<string, string>, body: Buffer, timeoutMs: number) => Promise<SendResult>;

export function alertSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_destinations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('slack','webhook')), url TEXT NOT NULL, secret TEXT,
      kinds TEXT NOT NULL, intent TEXT NOT NULL, created REAL NOT NULL, removed REAL);
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id TEXT PRIMARY KEY, destination TEXT NOT NULL, seq INTEGER, kind TEXT NOT NULL, subject TEXT, event TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL, next_attempt REAL NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, status INTEGER, outcome TEXT);
    CREATE INDEX IF NOT EXISTS alert_deliveries_due ON alert_deliveries(next_attempt) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS alert_deliveries_subject ON alert_deliveries(destination,kind,subject,created);`);
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
}
/** HTTPS only, except plain HTTP to loopback for a local relay. No embedded credentials or fragments. */
export function alertUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000- \u007f]/.test(value)) throw new ServiceError("Invalid alert destination URL.", 400, { code: "alert_destination_invalid" });
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError("Invalid alert destination URL.", 400, { code: "alert_destination_invalid" }); }
  if (url.username || url.password || url.hash) throw new ServiceError("Alert destination URLs cannot carry credentials or fragments.", 400, { code: "alert_destination_invalid" });
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new ServiceError("Alert destinations require HTTPS; plain HTTP is limited to loopback.", 400, { code: "alert_destination_insecure" });
  }
  return url.href;
}
interface DestinationInput { id: string; name: string; type: DestinationType; url: string; secret: string | null; kinds: string[] }
export function destinationInput(value: unknown): DestinationInput {
  const input = object(value);
  if (Object.keys(input).some(key => !["id", "name", "type", "url", "secret", "kinds"].includes(key))) throw new ServiceError("Unknown alert destination field.", 400, { code: "alert_destination_invalid" });
  const id = identifier(input.id);
  if (typeof input.name !== "string" || !input.name.trim() || [...input.name].length > 100 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new ServiceError("Invalid alert destination name.", 400, { code: "alert_destination_invalid" });
  if (input.type !== "slack" && input.type !== "webhook") throw new ServiceError("Alert destination type must be slack or webhook.", 400, { code: "alert_destination_invalid" });
  const url = alertUrl(input.url);
  let secret: string | null = null;
  if (input.type === "webhook") {
    // The signing key is the receiver's only proof of origin; require real entropy and a header-safe alphabet.
    if (typeof input.secret !== "string" || !/^[\x21-\x7e]{32,512}$/.test(input.secret)) throw new ServiceError("A webhook destination requires a signing secret of 32 to 512 printable ASCII characters.", 400, { code: "alert_destination_invalid" });
    secret = input.secret;
  } else if (input.secret !== undefined) throw new ServiceError("A Slack destination takes no signing secret.", 400, { code: "alert_destination_invalid" });
  const kinds = input.kinds === undefined ? ATTENTION_KINDS : input.kinds;
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > 64 || kinds.some(kind => typeof kind !== "string" || !Object.hasOwn(EVENT_KINDS, kind)) || new Set(kinds).size !== kinds.length) {
    throw new ServiceError("Select between 1 and 64 distinct known event kinds.", 400, { code: "event_kind_unknown" });
  }
  return { id, name: input.name, type: input.type, url, secret, kinds: [...kinds as string[]].sort() };
}
/** Public projection: where it points (origin only, since a Slack path is itself a credential) and what it selects. */
function destinationView(db: DatabaseSync, row: DestinationRow) {
  const counts = Object.fromEntries(db.prepare("SELECT state,count(*) AS n FROM alert_deliveries WHERE destination=? GROUP BY state").all(row.id).map(r => [String(r.state), Number(r.n)]));
  const last = db.prepare("SELECT state,updated,status,outcome FROM alert_deliveries WHERE destination=? AND attempts>0 ORDER BY updated DESC,id LIMIT 1").get(row.id);
  let endpoint = "";
  try { endpoint = new URL(row.url).origin; } catch { /* Removed destinations keep no URL. */ }
  return { id: row.id, name: row.name, type: row.type, endpoint, signed: row.secret !== null, kinds: JSON.parse(row.kinds) as string[], createdAt: new Date(row.created * 1000).toISOString(),
    deliveries: { pending: counts.pending ?? 0, delivered: counts.delivered ?? 0, failed: counts.failed ?? 0 },
    ...(last ? { lastAttempt: { state: String(last.state), at: new Date(Number(last.updated) * 1000).toISOString(), ...(last.status === null ? {} : { status: Number(last.status) }), ...(last.outcome === null ? {} : { outcome: String(last.outcome) }) } } : {}) };
}
function deliveryView(row: DeliveryRow) {
  return { id: row.id, destinationId: row.destination, kind: row.kind, ...(row.seq === null ? {} : { sequence: row.seq }), state: row.state, attempts: row.attempts, maxAttempts: row.max_attempts,
    createdAt: new Date(row.created * 1000).toISOString(), updatedAt: new Date(row.updated * 1000).toISOString(),
    ...(row.state === "pending" ? { nextAttemptAt: new Date(row.next_attempt * 1000).toISOString() } : {}),
    ...(row.status === null ? {} : { status: row.status }), ...(row.outcome === null ? {} : { outcome: row.outcome }) };
}
function activeDestination(db: DatabaseSync, id: string): DestinationRow {
  const row = db.prepare("SELECT * FROM alert_destinations WHERE id=? AND removed IS NULL").get(identifier(id)) as unknown as DestinationRow | undefined;
  if (!row) throw new ServiceError("Unknown alert destination.", 404);
  return row;
}

export function listDestinations(db: DatabaseSync) {
  return (db.prepare("SELECT * FROM alert_destinations WHERE removed IS NULL ORDER BY created,id").all() as unknown as DestinationRow[]).map(row => destinationView(db, row));
}
/** Idempotent by UUID: an exact replay returns the destination, anything else under that UUID conflicts, including a removed one. */
export function addDestination(db: DatabaseSync, value: unknown, now: number): { created: boolean; destination: ReturnType<typeof destinationView> } {
  const input = destinationInput(value);
  const intent = createHash("sha256").update(JSON.stringify([input.name, input.type, input.url, input.secret, input.kinds])).digest("hex");
  const old = db.prepare("SELECT * FROM alert_destinations WHERE id=?").get(input.id) as unknown as DestinationRow | undefined;
  if (old) {
    if (old.intent !== intent || old.removed !== null) throw new ServiceError("Alert destination UUID already belongs to another destination.", 409, { code: "alert_destination_conflict" });
    return { created: false, destination: destinationView(db, old) };
  }
  if (Number(db.prepare("SELECT count(*) AS n FROM alert_destinations WHERE removed IS NULL").get()!.n) >= MAX_ALERT_DESTINATIONS) {
    throw new ServiceError("Alert destination limit reached; remove one before adding another.", 409, { code: "alert_destination_limit" });
  }
  db.prepare("INSERT INTO alert_destinations VALUES (?,?,?,?,?,?,?,?,NULL)").run(input.id, input.name, input.type, input.url, input.secret, JSON.stringify(input.kinds), intent, now);
  return { created: true, destination: destinationView(db, activeDestination(db, input.id)) };
}
/** Removal erases the URL and secret, cancels unsent deliveries and keeps a tombstone so the UUID cannot be reused. */
export function removeDestination(db: DatabaseSync, id: string, now: number): { id: string; removed: true } {
  const row = db.prepare("SELECT removed FROM alert_destinations WHERE id=?").get(identifier(id));
  if (!row) throw new ServiceError("Unknown alert destination.", 404);
  if (row.removed === null) {
    db.prepare("UPDATE alert_destinations SET removed=?,url='',secret=NULL WHERE id=?").run(now, identifier(id));
    db.prepare("UPDATE alert_deliveries SET state='cancelled',updated=?,outcome='destination_removed' WHERE destination=? AND state='pending'").run(now, identifier(id));
  }
  return { id: identifier(id), removed: true };
}
export function listDeliveries(db: DatabaseSync, query: URLSearchParams) {
  for (const key of query.keys()) if (!["destination", "state", "limit"].includes(key) || query.getAll(key).length > 1) throw new ServiceError("Unsupported delivery query parameter.", 400);
  const where: string[] = [], args: Array<string | number> = [];
  if (query.has("destination")) { where.push("destination=?"); args.push(identifier(query.get("destination"))); }
  if (query.has("state")) {
    if (!["pending", "delivered", "failed", "cancelled"].includes(query.get("state")!)) throw new ServiceError("Unknown delivery state.", 400);
    where.push("state=?"); args.push(query.get("state")!);
  }
  const limit = query.has("limit") ? Number(query.get("limit")) : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ServiceError("Invalid limit.", 400);
  const rows = db.prepare(`SELECT * FROM alert_deliveries${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created DESC,id LIMIT ?`).all(...args, limit) as unknown as DeliveryRow[];
  return rows.map(deliveryView);
}

/** Same-transaction outbox: every active destination that selects the kind gets one pending delivery. */
export const alertProjection: EventProjection = (db, events, now) => {
  const destinations = db.prepare("SELECT id,kinds FROM alert_destinations WHERE removed IS NULL").all() as unknown as Array<{ id: string; kinds: string }>;
  if (!destinations.length) return;
  const selected = destinations.map(row => ({ id: row.id, kinds: new Set(JSON.parse(row.kinds) as string[]) }));
  for (const event of events) for (const destination of selected) {
    if (!destination.kinds.has(event.kind)) continue;
    const subject = event.subject ?? "";
    if (db.prepare("SELECT 1 FROM alert_deliveries WHERE destination=? AND kind=? AND subject=? AND created>? LIMIT 1").get(destination.id, event.kind, subject, now - ALERT_COOLDOWN_SECONDS)) continue;
    db.prepare("INSERT INTO alert_deliveries (id,destination,seq,kind,subject,event,state,attempts,max_attempts,next_attempt,created,updated) VALUES (?,?,?,?,?,?,'pending',0,?,?,?,?)")
      .run(randomUUID(), destination.id, event.seq, event.kind, subject, JSON.stringify(eventView(event as EventRow)), ALERT_MAX_ATTEMPTS, now, now, now);
  }
};

export function alertSummary(event: EventView): string {
  const about = [event.hostId && `host ${event.hostId}`, event.leaseId && `lease ${event.leaseId}`, event.requestId && `request ${event.requestId}`,
    !event.leaseId && event.machineId && `machine ${event.machineId}`].filter(Boolean).join(", ");
  const detail = ["reason", "state", "action", "phase"].map(key => typeof event.data[key] === "string" ? `${key} ${event.data[key] as string}` : "").filter(Boolean).join(", ");
  return `${EVENT_KINDS[event.kind]?.summary ?? event.kind}${about ? ` (${about})` : ""}${detail ? ` [${detail}]` : ""}`;
}
/** Hex HMAC-SHA256 over the exact request body bytes. */
export function alertSignature(secret: string, body: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
export function alertRequest(destination: { type: DestinationType; secret: string | null }, delivery: { id: string; kind: string; seq: number | null; attempts: number; event: string }, controllerId: string, now: number) {
  const event = JSON.parse(delivery.event) as EventView;
  const body = Buffer.from(JSON.stringify(destination.type === "slack"
    ? { text: `Canaveral ${delivery.kind}: ${alertSummary(event)}` }
    : { id: delivery.id, type: "canaveral.alert", controllerId, kind: delivery.kind, ...(delivery.seq === null ? {} : { sequence: delivery.seq }), occurredAt: event.at,
      summary: alertSummary(event), event, attempt: delivery.attempts, sentAt: new Date(now * 1000).toISOString() }));
  const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(body.length), "User-Agent": "Canaveral-alerts/1", Connection: "close" };
  if (destination.type === "webhook") {
    headers["X-Canaveral-Delivery"] = delivery.id;
    headers["X-Canaveral-Signature"] = alertSignature(destination.secret!, body);
  }
  return { headers, body };
}

/** One bounded POST: no redirects, no retries, no response body retained. */
export const sendAlert: AlertSender = (target, headers, body, timeoutMs) => new Promise(resolve => {
  let settled = false;
  const finish = (result: SendResult) => { if (!settled) { settled = true; clearTimeout(timer); request.destroy(); resolve(result); } };
  const url = new URL(target);
  const request = (url.protocol === "https:" ? https : http).request(url, { method: "POST", agent: false, headers, ...(url.protocol === "https:" ? { minVersion: "TLSv1.2" as const, rejectUnauthorized: true } : {}) });
  const timer = setTimeout(() => finish({ ok: false, outcome: "timeout" }), timeoutMs);
  request.on("error", () => finish({ ok: false, outcome: "connection_failed" }));
  request.on("response", response => {
    const status = response.statusCode ?? 0;
    response.resume();
    finish(status >= 200 && status < 300 ? { ok: true, status, outcome: "delivered" } : { ok: false, status, outcome: status >= 300 && status < 400 ? "redirect_refused" : "http_error" });
  });
  request.end(body);
});

export class AlertDelivery {
  private busy = false;
  constructor(readonly store: SqliteStore, readonly controllerId: string, private readonly send: AlertSender = sendAlert) {}

  /** Count the attempt and schedule its successor before any I/O, so a crash cannot repeat a send without bound. */
  private claim(now: number, only?: string) {
    return this.store.transaction(db => {
      // An attempt that was claimed as the last one but never settled has an unknown outcome; it is not sent again.
      for (const row of db.prepare("SELECT * FROM alert_deliveries WHERE state='pending' AND attempts>=max_attempts AND next_attempt<=?").all(now) as unknown as DeliveryRow[]) {
        db.prepare("UPDATE alert_deliveries SET state='failed',updated=?,outcome='interrupted' WHERE id=?").run(now, row.id);
        this.exhausted(db, row, "interrupted");
      }
      const rows = (only === undefined
        ? db.prepare("SELECT * FROM alert_deliveries WHERE state='pending' AND attempts<max_attempts AND next_attempt<=? ORDER BY next_attempt,id LIMIT ?").all(now, CLAIM_BATCH)
        : db.prepare("SELECT * FROM alert_deliveries WHERE id=? AND state='pending' AND attempts<max_attempts").all(only)) as unknown as DeliveryRow[];
      const claimed: Array<{ delivery: DeliveryRow; destination: DestinationRow }> = [];
      for (const row of rows) {
        const destination = db.prepare("SELECT * FROM alert_destinations WHERE id=? AND removed IS NULL").get(row.destination) as unknown as DestinationRow | undefined;
        if (!destination) { db.prepare("UPDATE alert_deliveries SET state='cancelled',updated=?,outcome='destination_removed' WHERE id=?").run(now, row.id); continue; }
        const attempts = row.attempts + 1, delay = ALERT_BACKOFF_SECONDS[Math.min(attempts, ALERT_BACKOFF_SECONDS.length) - 1]!;
        db.prepare("UPDATE alert_deliveries SET attempts=?,next_attempt=?,updated=? WHERE id=?").run(attempts, now + delay, now, row.id);
        claimed.push({ delivery: { ...row, attempts }, destination });
      }
      return claimed;
    });
  }
  private settle(id: string, attempts: number, result: SendResult): void {
    this.store.transaction(db => {
      const now = this.store.clock(), row = db.prepare("SELECT * FROM alert_deliveries WHERE id=?").get(id) as unknown as DeliveryRow | undefined;
      // A removal, or a newer attempt after this one outlived its schedule, already decided this row.
      if (!row || row.state !== "pending" || row.attempts !== attempts) return;
      const exhausted = !result.ok && row.attempts >= row.max_attempts;
      db.prepare("UPDATE alert_deliveries SET state=?,updated=?,status=?,outcome=? WHERE id=?").run(result.ok ? "delivered" : exhausted ? "failed" : "pending", now, result.status ?? null, result.outcome, id);
      if (exhausted) this.exhausted(db, row, result.outcome);
    });
  }
  /** A failure to report a delivery failure is not reported again, so one dead destination cannot feed itself. */
  private exhausted(db: DatabaseSync, row: DeliveryRow, outcome: string): void {
    if (row.kind === "alert.test" || row.kind === "alert.delivery_failed") return;
    recordEvent(db, "alert.delivery_failed", { subject: row.destination, data: { deliveryId: row.id, destinationId: row.destination, kind: row.kind, attempts: row.attempts, outcome } });
  }
  private async attempt(claimed: { delivery: DeliveryRow; destination: DestinationRow }): Promise<void> {
    let result: SendResult;
    try {
      const { headers, body } = alertRequest(claimed.destination, claimed.delivery, this.controllerId, this.store.clock());
      result = await this.send(claimed.destination.url, headers, body, ALERT_TIMEOUT_MS);
    } catch { result = { ok: false, outcome: "connection_failed" }; }
    try { this.settle(claimed.delivery.id, claimed.delivery.attempts, result); } catch { /* Left pending; its scheduled retry or the interrupted sweep decides it. */ }
  }
  /** True when a claim transaction is worth opening. Read-only, so an idle controller takes no write lock. */
  due(db: DatabaseSync, now: number): boolean {
    return !!db.prepare("SELECT 1 FROM alert_deliveries WHERE state='pending' AND next_attempt<=? LIMIT 1").get(now);
  }
  /** Send what is due. Never called inside a transaction; overlapping calls are refused rather than queued. */
  async deliverDue(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const claimed = this.claim(this.store.clock());
      await Promise.all(claimed.map(item => this.attempt(item)));
      return claimed.length;
    } finally { this.busy = false; }
  }
  /** A single immediate attempt that is recorded like any delivery and never retried. */
  async test(destinationId: string, requestId: string): Promise<ReturnType<typeof deliveryView>> {
    const id = identifier(requestId);
    const fresh = this.store.transaction(db => {
      const destination = activeDestination(db, destinationId), now = this.store.clock();
      const old = db.prepare("SELECT * FROM alert_deliveries WHERE id=?").get(id) as unknown as DeliveryRow | undefined;
      if (old) {
        if (old.destination !== destination.id || old.kind !== "alert.test") throw new ServiceError("Test UUID already belongs to another delivery.", 409, { code: "alert_destination_conflict" });
        return false;
      }
      const event: EventView = { sequence: 0, at: new Date(now * 1000).toISOString(), kind: "alert.test", data: { destinationId: destination.id } };
      db.prepare("INSERT INTO alert_deliveries (id,destination,seq,kind,subject,event,state,attempts,max_attempts,next_attempt,created,updated) VALUES (?,?,NULL,'alert.test',?,?,'pending',0,1,?,?,?)")
        .run(id, destination.id, destination.id, JSON.stringify(event), now, now, now);
      return true;
    });
    if (fresh) for (const item of this.claim(this.store.clock(), id)) await this.attempt(item);
    return this.store.transaction(db => deliveryView(db.prepare("SELECT * FROM alert_deliveries WHERE id=?").get(id) as unknown as DeliveryRow));
  }
}
export function pruneDeliveries(db: DatabaseSync, now: number): number {
  let removed = Number(db.prepare("DELETE FROM alert_deliveries WHERE state!='pending' AND updated<?").run(now - DELIVERY_RETENTION_SECONDS).changes);
  const boundary = db.prepare("SELECT created FROM alert_deliveries WHERE state!='pending' ORDER BY created DESC LIMIT 1 OFFSET ?").get(DELIVERY_MAX_ROWS);
  if (boundary) removed += Number(db.prepare("DELETE FROM alert_deliveries WHERE state!='pending' AND created<=?").run(Number(boundary.created)).changes);
  return removed;
}
