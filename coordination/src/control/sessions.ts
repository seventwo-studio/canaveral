import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions } from "node:tls";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { ConsumerIdentities, identifier } from "../consumers.ts";
import { RunnerEnrollment } from "../enrollment.ts";
import type { Binding } from "../enrollment.ts";
import { LinuxLeases } from "../linux-leases.ts";
import { secret, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import type { ControlModule, ControlOptions, ControlRequest, ControlResponse } from "./contracts.ts";
import { registerMachineHooks } from "./machines.ts";
import { legacyDigest } from "./templates.ts";
import { legacySessionLease, refreshLegacyLeases, legacyMachineReady, leaseEligible, capabilities } from "./leases.ts";
import { encodeControl, exact, MAX_BINARY_BYTES, MAX_CONTROL_BYTES, SESSION_PROTOCOL, validateRelayMessage, workerError } from "./session-protocol.ts";
import type { SessionCapability, SessionSide, SessionChannel, SessionMessage } from "./session-protocol.ts";
import { GuestHelperBinding, MAX_INSPECTION_BYTES, validateSnapshot } from "./session-protocol.ts";
import { GuestChunkFiles } from "../guest/chunk-files.ts";
import { GuestChunkShells } from "../guest/chunk-shells.ts";
import { connect as connectGuestDisplay } from "../guest/display.ts";
import type { DisplayConnection } from "../guest/display.ts";
import { jsonBytes } from "./transfers.ts";
import type { ByteReader, VerifiedDownload } from "./transfers.ts";
export * from "./session-protocol.ts";

const LIVE = ["pending", "attaching", "ready"];
const CAPABILITIES = { pty: "pty", display: "displayStream", upload: "files", download: "files", accessibility: "hierarchy" } as const;
interface SessionRow {
  id: string; lease: string; machine: string; assignment: string; host: string; controller: string; runner_generation: number; incarnation: string;
  request: string; generation: string; credential: string; state: string; created: number; attach_deadline: number; deadline: number;
  consumer_attached: number; host_attached: number;
  ledger: "legacy" | "linux";
}
interface LeaseRow { id: string; application: string; credential: string | null; expires: number; state: string; runtime: string; member: string; capabilities: string; required: string; domain: string; backend: string; image_id: string; image_revision: string; arch: string; digest: string }
interface AssignmentRow { id: string; lease: string; controller: string; runner: string; generation: number; incarnation: string; report: string | null; closed: number }
export interface SessionView {
  id: string; leaseId: string; member: string; capability: SessionCapability; generation: string; protocol: typeof SESSION_PROTOCOL;
  state: string; createdAt: string; attachBefore: string; authorizationDeadline: string;
}
export type SessionCommand =
  | { type: "sessions.attach"; sessionId: string; generation: string; side: SessionSide; ownerId: string; token: string; binding?: Binding }
  | { type: "sessions.authorized"; sessionId: string; generation: string; ready?: boolean }
  | { type: "sessions.disconnect"; sessionId: string; generation: string };
export interface SessionModule extends ControlModule { sessionCommand(command: SessionCommand): unknown }
function bindingOf(a: AssignmentRow): Binding { return { controllerId: a.controller, runnerId: a.runner, generation: a.generation, incarnationId: a.incarnation }; }
function hash(token: string): string { return createHash("sha256").update("linux-lease:" + secret(token), "ascii").digest("hex"); }
function matches(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
function utc(value: number): string { return new Date(value * 1000).toISOString(); }

/** Owns additive session claims; never adopts legacy host/lease tables or stores payloads. */
export class AccessSessions implements SessionModule {
  readonly applications: ConsumerIdentities;
  readonly runners: RunnerEnrollment;
  readonly leases: LinuxLeases;
  constructor(readonly store: SqliteStore, readonly options: ControlOptions) {
    this.applications = new ConsumerIdentities(store);
    this.runners = new RunnerEnrollment(store, options.controllerId);
    this.leases = new LinuxLeases(store, this.applications, this.runners);
    store.transaction(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS control_access_sessions (
        id TEXT PRIMARY KEY,lease TEXT NOT NULL,machine TEXT NOT NULL,assignment TEXT NOT NULL,host TEXT NOT NULL,
        controller TEXT NOT NULL,runner_generation INTEGER NOT NULL,incarnation TEXT NOT NULL,request TEXT NOT NULL,generation TEXT NOT NULL,
        credential TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,attach_deadline REAL NOT NULL,deadline REAL NOT NULL,
        consumer_attached INTEGER NOT NULL DEFAULT 0,host_attached INTEGER NOT NULL DEFAULT 0,ledger TEXT NOT NULL DEFAULT 'linux');
        CREATE INDEX IF NOT EXISTS control_access_sessions_host ON control_access_sessions(host,state);
        UPDATE control_access_sessions SET state='disconnected' WHERE state IN ('pending','attaching','ready');`);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_sessions'").get()) {
        for (const old of db.prepare("SELECT * FROM access_sessions").all()) {
          const v = JSON.parse(String(old.request)) as { id: string; member: string; capability: string };
          const request = JSON.stringify({ id: identifier(v.id), member: v.member, capability: v.capability });
          const existing = this.row(db, String(old.id));
          if (existing) {
            if (existing.ledger !== "legacy" || existing.lease !== old.lease || existing.generation !== old.generation || existing.request !== request)
              throw new ServiceError("Persisted session identity conflicts across ledgers.", 409);
            continue;
          }
          db.prepare("INSERT INTO control_access_sessions VALUES (?,?,?,'',?,'',0,'',?,?,?,?,?,?,?, ?,?,'legacy')")
            .run(String(old.id), String(old.lease), String(old.machine), String(old.host), request, String(old.generation), String(old.credential),
              LIVE.includes(String(old.state)) ? "disconnected" : String(old.state), Number(old.created), Number(old.attach_deadline), Number(old.deadline), Number(old.consumer_attached), Number(old.host_attached));
        }
        db.exec("UPDATE access_sessions SET state='disconnected' WHERE state IN ('pending','attaching','ready')");
      }
    });
    registerMachineHooks(store, { heartbeatResponse: (db, host) => {
      this.refresh(db);
      return { accessSessions: (db.prepare("SELECT * FROM control_access_sessions WHERE ledger='legacy' AND host=? AND host_attached=0 AND state IN ('pending','attaching') ORDER BY created,id LIMIT 100")
        .all(host) as unknown as SessionRow[]).map(row => ({ ...this.view(row), machineId: row.machine, controllerNow: store.clock() })) };
    } });
  }
  private isLegacy(db: DatabaseSync, id: string): boolean {
    const legacy = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get() && !!db.prepare("SELECT 1 FROM leases WHERE id=?").get(id);
    if (legacy && this.lease(db, id)) throw new ServiceError("Lease identity is ambiguous across ledgers.", 409);
    return legacy;
  }
  private legacyMachine(db: DatabaseSync, lease: string, member: string): Record<string, unknown> | undefined {
    return db.prepare("SELECT m.*,h.seen,h.enabled,h.offer AS host_offer FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN hosts h ON h.id=m.host WHERE lm.lease=? AND lm.name=?").get(lease, member);
  }
  private refreshLegacy(db: DatabaseSync, row: SessionRow, now: number): void {
    const l = db.prepare("SELECT l.*,c.revoked FROM leases l JOIN consumers c ON c.id=l.consumer WHERE l.id=?").get(row.lease);
    let state = row.state;
    if (!l || l.revoked || l.credential !== row.credential) state = "revoked";
    else if (l.state === "expired" || now >= Number(l.expires)) state = "expired";
    else if (!["provisioning", "ready"].includes(String(l.state))) state = "revoked";
    else if (state !== "ready" && now >= row.attach_deadline) state = "expired";
    else {
      const machine = this.legacyMachine(db, row.lease, this.view(row).member);
      if (!machine || machine.id !== row.machine || machine.host !== row.host || machine.desired !== "running" ||
        !leaseEligible(JSON.parse(String(machine.host_offer)), JSON.parse(String(machine.template))) || !legacyMachineReady(db, machine, now)) state = "disconnected";
    }
    db.prepare("UPDATE control_access_sessions SET state=?,deadline=? WHERE id=?").run(state, Number(l?.expires ?? row.deadline), row.id);
  }
  private createLegacy(db: DatabaseSync, leaseId: string, token: string, id: string, request: string): { created: boolean; session: SessionView } {
    const l = legacySessionLease(db, leaseId, token), old = this.row(db, id), v = JSON.parse(request) as { member: string; capability: SessionCapability };
    if (old) {
      if (old.lease !== leaseId || old.ledger !== "legacy") throw new ServiceError("Unknown session.", 404);
      if (old.request !== request) throw new ServiceError("Session identity belongs to another request.", 409);
      return { created: false, session: this.view(old) };
    }
    const now = this.store.clock();
    if (!["provisioning", "ready"].includes(String(l.state)) || now >= Number(l.expires)) throw new ServiceError("Lease has ended.", 410);
    const m = this.legacyMachine(db, leaseId, v.member);
    if (!m) throw new ServiceError("Unknown environment member.", 404);
    const image = JSON.parse(String(m.template)) as Record<string, unknown>;
    if (!capabilities(image)[CAPABILITIES[v.capability]]) throw new ServiceError("Requested session capability is unsupported.", 409, { code: "capability_unsupported" });
    if (l.state !== "ready" || m.desired !== "running" || !leaseEligible(JSON.parse(String(m.host_offer)), image) || !legacyMachineReady(db, m, now))
      throw new ServiceError("Environment member is not ready for access.", 409, { code: "member_not_ready" });
    db.prepare("INSERT INTO control_access_sessions VALUES (?,?,?,'',?,'',0,'',?,?,?,'pending',?,?,?,0,0,'legacy')")
      .run(id, leaseId, String(m.id), String(m.host), request, randomUUID(), String(l.credential), now, now + 30, Number(l.expires));
    return { created: true, session: this.view(this.row(db, id)!) };
  }
  private row(db: DatabaseSync, id: string): SessionRow | undefined {
    return db.prepare("SELECT * FROM control_access_sessions WHERE id=?").get(id) as unknown as SessionRow | undefined;
  }
  private lease(db: DatabaseSync, id: string): LeaseRow | undefined { return db.prepare("SELECT * FROM linux_leases WHERE id=?").get(id) as unknown as LeaseRow | undefined; }
  private assignment(db: DatabaseSync, lease: string): AssignmentRow | undefined {
    return db.prepare("SELECT * FROM linux_lease_assignments WHERE lease=?").get(lease) as unknown as AssignmentRow | undefined;
  }
  private view(row: SessionRow): SessionView {
    const request = JSON.parse(row.request) as { member: string; capability: SessionCapability };
    return { id: row.id, leaseId: row.lease, member: request.member, capability: request.capability, generation: row.generation,
      protocol: SESSION_PROTOCOL, state: row.state, createdAt: utc(row.created), attachBefore: utc(row.attach_deadline), authorizationDeadline: utc(row.deadline) };
  }
  /** Account/admin/application credentials deliberately cannot substitute for a current lease key. */
  private authenticate(db: DatabaseSync, id: string, token: string): LeaseRow {
    const lease = this.lease(db, identifier(id));
    let supplied: string;
    try { supplied = hash(token); } catch { throw new ServiceError("Lease credential rejected.", 401); }
    if (!lease?.credential || !matches(lease.credential, supplied) || !this.applications.active(db, lease.application)) {
      // Distinguish an owning application from malformed/cross-role credentials without disclosing another lease.
      let owner = false;
      try { owner = this.applications.verify(db, token).id === lease?.application; } catch { /* fixed refusal */ }
      if (owner) throw new ServiceError("A lease-scoped credential is required for guest access.", 403, { code: "lease_credential_required" });
      throw new ServiceError("Lease credential rejected.", 401);
    }
    return lease;
  }
  private eligible(db: DatabaseSync, lease: LeaseRow, a: AssignmentRow | undefined, capability: SessionCapability): boolean {
    if (!a || a.closed || lease.state !== "ready" || lease.runtime !== "running" || !this.runners.current(db, bindingOf(a))) return false;
    const report: unknown = a.report ? JSON.parse(a.report) : null;
    const required = JSON.parse(lease.required) as string[], offered = JSON.parse(lease.capabilities) as string[];
    const index = ["command", "pty", "files"].indexOf(CAPABILITIES[capability]);
    // This ledger only admits headless Linux: no synthetic display/accessibility fallback.
    if (index < 0 || !offered.includes(CAPABILITIES[capability]) || !Array.isArray(report) || report.length !== 14 || report[6 + index] !== true ||
        !required.every(c => report[6 + ["command", "pty", "files"].indexOf(c)] === true)) return false;
    const approval = db.prepare("SELECT * FROM linux_lease_runner_approvals WHERE controller=? AND runner=? AND generation=? AND incarnation=? AND revoked=0")
      .get(a.controller, a.runner, a.generation, a.incarnation) as { domain: string; backend: string; images: string } | undefined;
    const image = JSON.stringify([lease.image_id, lease.image_revision, lease.arch, lease.digest]);
    return !!approval && approval.domain === lease.domain && approval.backend === lease.backend && (JSON.parse(approval.images) as string[]).includes(image);
  }
  private refresh(db: DatabaseSync): void {
    const now = this.store.clock();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get()) refreshLegacyLeases(db, now);
    for (const row of db.prepare("SELECT * FROM control_access_sessions WHERE state IN ('pending','attaching','ready')").all() as unknown as SessionRow[]) {
      if (row.ledger === "legacy") { this.refreshLegacy(db, row, now); continue; }
      const lease = this.lease(db, row.lease), a = lease ? this.assignment(db, lease.id) : undefined;
      let state = row.state;
      if (!lease || !this.applications.active(db, lease.application) || lease.credential !== row.credential) state = "revoked";
      else if (lease.state === "expired" || now >= lease.expires) state = "expired";
      else if (!["provisioning", "ready"].includes(lease.state)) state = "revoked";
      else if (row.state !== "ready" && now >= row.attach_deadline) state = "expired";
      else if (!a || a.id !== row.assignment || a.runner !== row.host || a.controller !== row.controller || a.generation !== row.runner_generation || a.incarnation !== row.incarnation ||
        !this.eligible(db, lease, a, this.view(row).capability)) state = "disconnected";
      db.prepare("UPDATE control_access_sessions SET state=?,deadline=? WHERE id=?").run(state, lease?.expires ?? row.deadline, row.id);
    }
  }
  private transaction<T>(fn: (db: DatabaseSync) => T): T { return this.store.transaction(db => { this.refresh(db); return fn(db); }); }
  create(leaseId: string, token: string, value: unknown): { created: boolean; session: SessionView } {
    const v = exact(value, ["id", "member", "capability"]), id = identifier(v.id), lease = identifier(leaseId);
    if (typeof v.member !== "string" || typeof v.capability !== "string" || !Object.hasOwn(CAPABILITIES, v.capability)) throw new ServiceError("Session requires an explicit member and supported capability.", 400);
    const request = JSON.stringify({ id, member: v.member, capability: v.capability });
    return this.transaction(db => {
      if (this.isLegacy(db, lease)) return this.createLegacy(db, lease, token, id, request);
      const l = this.authenticate(db, lease, token), old = this.row(db, id);
      if (old) {
        if (old.lease !== lease || old.ledger !== "linux") throw new ServiceError("Unknown session.", 404);
        if (old.request !== request) throw new ServiceError("Session identity belongs to another request.", 409);
        return { created: false, session: this.view(old) };
      }
      const now = this.store.clock();
      if (!["provisioning", "ready"].includes(l.state) || now >= l.expires) throw new ServiceError("Lease has ended.", 410);
      if (v.member !== "primary") throw new ServiceError("Unknown environment member.", 404);
      if (!(JSON.parse(l.capabilities) as string[]).includes(CAPABILITIES[v.capability as SessionCapability])) throw new ServiceError("Requested session capability is unsupported.", 409, { code: "capability_unsupported" });
      const a = this.assignment(db, lease);
      if (!this.eligible(db, l, a, v.capability as SessionCapability)) throw new ServiceError("Environment member is not ready for access.", 409, { code: "member_not_ready" });
      db.prepare("INSERT INTO control_access_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,0,0,'linux')")
        .run(id, lease, l.member, a!.id, a!.runner, a!.controller, a!.generation, a!.incarnation, request, randomUUID(), l.credential!, now, now + 30, l.expires);
      return { created: true, session: this.view(this.row(db, id)!) };
    });
  }
  inspect(leaseId: string, sessionId: string, token: string, close = false): SessionView {
    return this.transaction(db => {
      if (this.isLegacy(db, identifier(leaseId))) legacySessionLease(db, identifier(leaseId), token);
      else this.authenticate(db, leaseId, token);
      const row = this.row(db, identifier(sessionId));
      if (!row || row.lease !== identifier(leaseId)) throw new ServiceError("Unknown session.", 404);
      if (close && LIVE.includes(row.state)) { db.prepare("UPDATE control_access_sessions SET state='closed' WHERE id=?").run(row.id); row.state = "closed"; }
      return this.view(row);
    });
  }
  sessionCommand(command: SessionCommand): unknown {
    const id = identifier(command.sessionId), generation = identifier(command.generation);
    return this.transaction(db => {
      const row = this.row(db, id);
      if (command.type === "sessions.disconnect") {
        db.prepare("UPDATE control_access_sessions SET state='disconnected' WHERE id=? AND generation=? AND state IN ('pending','attaching','ready')").run(id, generation);
        return { disconnected: true };
      }
      if (command.type === "sessions.authorized") return { authorized: !!row && row.generation === generation && (command.ready ? row.state === "ready" : LIVE.includes(row.state)) };
      const owner = identifier(command.ownerId);
      if (command.side === "consumer") {
        if (this.isLegacy(db, owner)) legacySessionLease(db, owner, command.token);
        else this.authenticate(db, owner, command.token);
      }
      else if (command.side === "host") {
        if (row?.ledger === "legacy") {
          const host = db.prepare("SELECT credential FROM hosts WHERE id=?").get(owner);
          let supplied: string; try { secret(command.token); supplied = legacyDigest(command.token); } catch { throw new ServiceError("Host credential rejected.", 401); }
          if (command.binding || !host || !matches(String(host.credential), supplied)) throw new ServiceError("Host credential rejected.", 401);
        } else {
          if (!command.binding || command.binding.runnerId !== owner) throw new ServiceError("Runner binding is required.", 401);
          this.runners.verify(db, command.token, command.binding);
        }
      } else throw new ServiceError("Invalid session peer.", 400);
      if (!row || row[command.side === "host" ? "host" : "lease"] !== owner) throw new ServiceError("Unknown session.", 404);
      if (row.generation !== generation) throw new ServiceError("Session generation changed.", 409);
      if (command.side === "host" && row.ledger === "linux" && (command.binding!.controllerId !== row.controller || command.binding!.generation !== row.runner_generation || command.binding!.incarnationId !== row.incarnation)) throw new ServiceError("Session assignment binding differs.", 403);
      if (!LIVE.includes(row.state)) throw new ServiceError("Session has ended. Negotiate a new session identity.", 410);
      const column = command.side === "host" ? "host_attached" : "consumer_attached", other = command.side === "host" ? row.consumer_attached : row.host_attached;
      if (row[column]) throw new ServiceError("This session peer is already attached.", 409);
      db.prepare(`UPDATE control_access_sessions SET ${column}=1,state=? WHERE id=?`).run(other ? "ready" : "attaching", id);
      return this.view(this.row(db, id)!);
    });
  }
  /** Runner polling is bounded and authenticated to the exact current assignment binding. */
  assigned(token: string, binding: unknown): unknown {
    return this.transaction(db => {
      const b = this.runners.verify(db, token, binding);
      return { accessSessions: (db.prepare("SELECT * FROM control_access_sessions WHERE host=? AND controller=? AND runner_generation=? AND incarnation=? AND host_attached=0 AND state IN ('pending','attaching') ORDER BY created,id LIMIT 100")
        .all(b.runnerId, b.controllerId, b.generation, b.incarnationId) as unknown as SessionRow[]).map(row => ({ ...this.view(row), machineId: row.machine, assignmentId: row.assignment, controllerNow: this.store.clock() })) };
    });
  }
  handle(req: ControlRequest): ControlResponse | undefined {
    const p = req.parts;
    if (p[0] !== "v1") return undefined;
    if (p.length === 4 && p[1] === "runners" && p[2] === "sessions" && p[3] === "assignments" && req.method === "POST") {
      const v = exact(req.body, ["binding"]); return { body: this.assigned(req.token, v.binding) };
    }
    if (p[1] !== "leases" || p[3] !== "sessions" || !p[2]) return undefined;
    // These routes use the stronger lease-key role; an account principal or admin is insufficient.
    if (p.length === 4 && req.method === "POST") { const result = this.create(p[2], req.token, req.body); return { status: result.created ? 201 : 200, body: result.session }; }
    if (p.length === 5 && p[4] && req.method === "GET") return { body: this.inspect(p[2], p[4], req.token) };
    if (p.length === 6 && p[4] && p[5] === "close" && req.method === "POST") { exact(req.body, []); return { body: this.inspect(p[2], p[4], req.token, true) }; }
    return undefined;
  }
}
export function createModule(store: SqliteStore, options: ControlOptions): SessionModule { return new AccessSessions(store, options); }

export interface SessionCommandClient { request(command: SessionCommand): Promise<unknown> }
interface Pair {
  view: SessionView; peers: Partial<Record<SessionSide, SocketPeer>>; started: Promise<void>; start(): void; closed: boolean;
}
/** One assembled input message and one pending socket write per direction. No retry/reconnect. */
class SocketPeer {
  private busy = false;
  private writer: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastPong = Date.now();
  private lastPing = Date.now();
  private timer: NodeJS.Timeout;
  constructor(readonly socket: Duplex, readonly server = true) {
    socket.on("error", () => {});
    this.timer = setInterval(() => {
      if (Date.now() - this.lastPong >= 30_000) { this.close(); return; }
      if (!this.busy && Date.now() - this.lastPing >= 10_000) {
        this.lastPing = Date.now(); void this.send(Buffer.from("canaveral"), 9).catch(() => this.close());
      }
    }, 500);
    this.timer.unref();
    socket.once("close", () => clearInterval(this.timer));
  }
  close(): void { clearInterval(this.timer); this.socket.destroy(); }
  async read(size: number): Promise<Buffer> {
    const result = Buffer.alloc(size); let offset = 0;
    while (offset < size) {
      if (this.socket.destroyed || this.socket.readableEnded) throw new ServiceError("Session disconnected.", 410, { code: "session_disconnected" });
      const part = this.socket.read(Math.min(size - offset, this.socket.readableLength || size - offset)) as Buffer | null;
      if (part) { part.copy(result, offset); offset += part.length; continue; }
      await new Promise<void>((resolve, reject) => {
        const done = (): void => { cleanup(); resolve(); };
        const ended = (): void => { cleanup(); reject(new ServiceError("Session disconnected.", 410)); };
        const cleanup = (): void => { this.socket.off("readable", done); this.socket.off("close", ended); this.socket.off("end", ended); this.socket.off("error", ended); };
        this.socket.once("readable", done); this.socket.once("close", ended); this.socket.once("end", ended); this.socket.once("error", ended);
      });
    }
    return result;
  }
  async send(data: Uint8Array, opcode = 1): Promise<void> {
    if (this.socket.destroyed || this.queued >= 2) throw new ServiceError("Session output is blocked or disconnected.", 410);
    this.queued++;
    const previous = this.writer;
    let release!: () => void;
    this.writer = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.busy = true;
    try {
      const length = data.byteLength;
      const header = Buffer.alloc(length < 126 ? 2 : length <= 65535 ? 4 : 10);
      header[0] = 0x80 | opcode;
      if (length < 126) header[1] = length;
      else if (length <= 65535) { header[1] = 126; header.writeUInt16BE(length, 2); }
      else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
      if (this.server) await this.write(Buffer.concat([header, data]));
      else {
        header[1] = header[1]! | 128;
        const mask = randomBytes(4), payload = Buffer.from(data);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
        await this.write(Buffer.concat([header, mask, payload]));
      }
    } finally { this.busy = false; this.queued--; release(); }
  }
  async write(data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); finish(new ServiceError("Session output remained blocked; delivery is uncertain.", 408, { retryable: false, outcome: "unknown" })); }, 30_000);
      const closed = (): void => finish(new ServiceError("Session disconnected during output.", 410));
      const finish = (error?: Error | null): void => { clearTimeout(timer); this.socket.off("close", closed); error ? reject(error) : resolve(); };
      this.socket.once("close", closed);
      this.socket.write(data, error => finish(error));
    });
  }
  async message(): Promise<{ binary: boolean; data: Uint8Array } | null> {
    let kind = 0, size = 0;
    const assembled = Buffer.alloc(MAX_BINARY_BYTES);
    for (;;) {
      const h = await this.read(2), opcode = h[0]! & 15, final = !!(h[0]! & 128);
      if ((h[0]! & 112) || !!(h[1]! & 128) !== this.server) throw new ServiceError("Invalid masked session frame.", 400);
      let length = h[1]! & 127;
      if (length === 126) { length = (await this.read(2)).readUInt16BE(); if (length < 126) throw new ServiceError("Noncanonical session frame.", 400); }
      else if (length === 127) {
        const n = (await this.read(8)).readBigUInt64BE();
        if (n < 65536n || n > BigInt(MAX_BINARY_BYTES)) throw new ServiceError("Session frame exceeds its budget.", 400);
        length = Number(n);
      }
      if (![0, 1, 2, 8, 9, 10].includes(opcode) || (opcode >= 8 && (!final || length > 125))) throw new ServiceError("Unsupported session frame.", 400);
      if (opcode < 8) {
        if (opcode === 0 ? kind === 0 : kind !== 0) throw new ServiceError("Invalid fragmented session message.", 400);
        if (opcode !== 0) kind = opcode;
        if (size + length > (kind === 1 ? MAX_CONTROL_BYTES : MAX_BINARY_BYTES)) throw new ServiceError("Session message exceeds its budget.", 400);
      }
      const mask = this.server ? await this.read(4) : undefined, data = await this.read(length);
      if (mask) for (let i = 0; i < length; i++) data[i] = data[i]! ^ mask[i % 4]!;
      if (opcode === 8) return null;
      if (opcode === 9) { await this.send(data, 10); continue; }
      if (opcode === 10) { this.lastPong = Date.now(); continue; }
      data.copy(assembled, size); size += length;
      if (final) return { binary: kind === 2, data: assembled.subarray(0, size) };
    }
  }
}

/** HTTP boundary checks are repeated here before durable attachment, including on direct callers. */
function upgradeRequest(req: IncomingMessage): { key: string; token: string; command: Extract<SessionCommand, { type: "sessions.attach" }> } {
  const path = req.url ?? "", p = path.split("/");
  if (req.method !== "GET" || !/^\/v1\/(hosts|leases)\/[0-9a-f-]+\/sessions\/[0-9a-f-]+\/[0-9a-f-]+$/.test(path)) throw new ServiceError("Invalid session attachment path.", 400);
  const counts = new Map<string, number>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) { const k = req.rawHeaders[i]!.toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
  if ([...counts.values()].some(count => count !== 1) || req.headers.origin !== undefined || req.headers.cookie !== undefined) throw new ServiceError("Session upgrade headers rejected.", 403);
  const h = req.headers;
  if (typeof h.host !== "string" || !h.host || h.upgrade?.toLowerCase() !== "websocket" || !h.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade") || h["sec-websocket-version"] !== "13" ||
    typeof h["sec-websocket-protocol"] !== "string" || !h["sec-websocket-protocol"].split(/\s*,\s*/).includes(SESSION_PROTOCOL) || h["sec-websocket-extensions"] !== undefined ||
    h["transfer-encoding"] !== undefined || (h["content-length"] !== undefined && h["content-length"] !== "0")) throw new ServiceError("Invalid session WebSocket upgrade.", 400);
  const key = h["sec-websocket-key"], authorization = h.authorization;
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key || !authorization?.startsWith("Bearer ")) throw new ServiceError("Invalid session WebSocket credentials or key.", 400);
  const side: SessionSide = p[2] === "hosts" ? "host" : "consumer";
  const command: Extract<SessionCommand, { type: "sessions.attach" }> = { type: "sessions.attach", sessionId: identifier(p[5]), generation: identifier(p[6]), side, ownerId: identifier(p[3]), token: authorization.slice(7) };
  const controller = h["x-canaveral-controller-id"], generation = h["x-canaveral-runner-generation"], incarnation = h["x-canaveral-incarnation-id"];
  if (side === "host" && [controller, generation, incarnation].some(x => x !== undefined)) {
    if (typeof controller !== "string" || typeof generation !== "string" || !/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation)) || typeof incarnation !== "string") throw new ServiceError("Invalid runner session binding.", 400);
    command.binding = { controllerId: identifier(controller), runnerId: command.ownerId, generation: Number(generation), incarnationId: identifier(incarnation) };
  }
  return { key, token: command.token, command };
}
export function createSessionUpgradeHandler(client: SessionCommandClient): { handle(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>; close(): void } {
  const pairs = new Map<string, Pair>(); let stopped = false, monitoring = false;
  const disconnect = (pair: Pair): void => {
    if (pair.closed) return;
    pair.closed = true; pair.start();
    for (const p of Object.values(pair.peers)) p.close();
    pairs.delete(pair.view.id + ":" + pair.view.generation);
    void client.request({ type: "sessions.disconnect", sessionId: pair.view.id, generation: pair.view.generation }).catch(() => {});
  };
  const authorized = async (pair: Pair, ready = false): Promise<boolean> => {
    const result = await client.request({ type: "sessions.authorized", sessionId: pair.view.id, generation: pair.view.generation, ready }) as { authorized?: boolean };
    return result?.authorized === true;
  };
  const timer = setInterval(() => {
    if (monitoring) return; monitoring = true;
    void Promise.all([...pairs.values()].map(async pair => {
      try { if (!await authorized(pair)) disconnect(pair); } catch { disconnect(pair); }
    })).finally(() => { monitoring = false; });
  }, 250); timer.unref();
  return {
    close(): void { stopped = true; clearInterval(timer); for (const pair of [...pairs.values()]) disconnect(pair); },
    async handle(req, socket, head): Promise<void> {
      let pair: Pair | undefined, peer: SocketPeer | undefined, claimed: Extract<SessionCommand, { type: "sessions.attach" }> | undefined, upgraded = false;
      socket.on("error", () => {});
      try {
        if (stopped) throw new ServiceError("Session service is shutting down.", 503);
        const { key, command } = upgradeRequest(req);
        if (head.length > MAX_BINARY_BYTES + 14) throw new ServiceError("Session upgrade input exceeds its budget.", 400);
        socket.pause();
        const view = await client.request(command) as SessionView; claimed = command;
        if (stopped || socket.destroyed) throw new ServiceError("Session disconnected during admission.", 410);
        const identity = view.id + ":" + view.generation;
        pair = pairs.get(identity);
        if (!pair) {
          let start!: () => void;
          const started = new Promise<void>(resolve => { start = resolve; });
          pair = { view, peers: {}, started, start, closed: false }; pairs.set(identity, pair);
        }
        if (pair.closed || pair.peers[command.side]) throw new ServiceError("Session peer cannot be replaced.", 409);
        peer = new SocketPeer(socket); pair.peers[command.side] = peer;
        const currentPair = pair;
        socket.once("close", () => disconnect(currentPair));
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        await peer.write(Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\nSec-WebSocket-Protocol: " + SESSION_PROTOCOL + "\r\n\r\n"));
        upgraded = true;
        if (head.length) socket.unshift(head);
        // Each handle may reach this while the other handshake is in flight. The second stored
        // peer owns startup; socket writes complete before ready is emitted.
        (peer as SocketPeer & { accepted?: boolean }).accepted = true;
        if (Object.values(pair.peers).length === 2 && Object.values(pair.peers).every(p => (p as SocketPeer & { accepted?: boolean }).accepted)) {
          if (!await authorized(pair, true)) throw new ServiceError("Session authorization ended.", 410);
          const ready = Buffer.from(JSON.stringify({ type: "ready", sessionId: view.id, generation: view.generation, capability: view.capability }));
          await Promise.all(Object.values(pair.peers).map(p => p.send(ready))); pair.start();
        }
        await pair.started;
        while (!pair.closed) {
          const message = await peer.message(); if (!message) break;
          validateRelayMessage(view.capability, command.side, message.data, message.binary);
          if (!await authorized(pair, true) || pair.closed) throw new ServiceError("Session authorization ended.", 410);
          const other = pair.peers[command.side === "host" ? "consumer" : "host"];
          if (!other) throw new ServiceError("Session peer ended.", 410);
          await other.send(message.data, message.binary ? 2 : 1);
        }
      } catch (error) {
        if (!upgraded && !socket.destroyed) {
          const status = error instanceof ServiceError ? error.status : 503;
          // No backend error, endpoint, token or payload is copied into the response.
          socket.end(`HTTP/1.1 ${status} Session Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        }
      } finally {
        if (pair) disconnect(pair);
        else {
          if (upgraded) peer?.close();
          if (claimed) void client.request({ type: "sessions.disconnect", sessionId: claimed.sessionId, generation: claimed.generation }).catch(() => {});
        }
      }
    },
  };
}

/** Bounded raw-socket client, with default TLS verification and no automatic reconnect. */
export class SessionConnection implements SessionChannel {
  private pending: Promise<SessionMessage> | undefined;
  private failure: ServiceError | undefined;
  private readonly timer: NodeJS.Timeout;
  private reading = false;
  private constructor(private readonly peer: SocketPeer, readonly authorized: () => boolean, readonly sessionId: string) {
    this.timer = setInterval(() => { if (!this.allowed()) this.close(); }, 250); this.timer.unref();
  }
  private allowed(): boolean { try { return this.authorized() === true && !this.peer.socket.destroyed; } catch { return false; } }
  private check(): void { if (this.failure) throw this.failure; if (!this.allowed()) throw new ServiceError("Session authorization or connection ended.", 410, { code: "session_disconnected", retryable: false }); }
  static async connect(origin: string, path: string, token: string, options: { authorized?: () => boolean; binding?: Binding; ca?: ConnectionOptions["ca"] } = {}): Promise<SessionConnection> {
    let url: URL; try { url = new URL(origin); } catch { throw new ServiceError("Invalid session origin.", 400); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^\/v1\/(hosts|leases)\/[0-9a-f-]+\/sessions\/[0-9a-f-]+\/[0-9a-f-]+$/.test(path)) throw new ServiceError("Invalid session origin or attachment path.", 400);
    secret(token);
    const allowed = options.authorized ?? (() => true);
    if (!allowed()) throw new ServiceError("Session authorization ended.", 410);
    const key = randomBytes(16).toString("base64"), expected = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET", path, agent: false, timeout: 20_000,
        ...(options.ca === undefined ? {} : { ca: options.ca }), rejectUnauthorized: true,
        headers: { Authorization: "Bearer " + token, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, "Sec-WebSocket-Protocol": SESSION_PROTOCOL,
          ...(options.binding ? { "x-canaveral-controller-id": options.binding.controllerId, "x-canaveral-runner-generation": String(options.binding.generation), "x-canaveral-incarnation-id": options.binding.incarnationId } : {}) } });
      const timer = setTimeout(() => req.destroy(new Error("deadline")), 20_000);
      req.once("upgrade", (response, stream, head) => {
        clearTimeout(timer);
        if (response.statusCode !== 101 || response.headers["sec-websocket-accept"] !== expected || response.headers["sec-websocket-protocol"] !== SESSION_PROTOCOL || response.headers["sec-websocket-extensions"] !== undefined || head.length > MAX_BINARY_BYTES + 14 || !allowed()) {
          stream.destroy(); reject(new ServiceError("Session upgrade was not accepted.", 409)); return;
        }
        stream.pause(); if (head.length) stream.unshift(head); resolve(stream);
      });
      req.once("response", response => { clearTimeout(timer); response.destroy(); reject(new ServiceError("Session upgrade rejected.", response.statusCode ?? 503)); });
      req.once("error", () => { clearTimeout(timer); reject(new ServiceError("Session connection failed; no input is automatically replayed.", 503, { retryable: false })); });
      req.end();
    });
    return new SessionConnection(new SocketPeer(socket, false), allowed, path.split("/")[5]!);
  }
  async sendControl(value: Record<string, unknown>): Promise<void> { this.check(); await this.peer.send(Buffer.from(encodeControl(value))); this.check(); }
  async sendBytes(value: Uint8Array): Promise<void> {
    this.check(); if (!(value instanceof Uint8Array) || value.byteLength > MAX_BINARY_BYTES) throw new ServiceError("Session binary messages must fit 64 KiB.", 400);
    await this.peer.send(value, 2); this.check();
  }
  async receive(timeoutSeconds = 30): Promise<SessionMessage | null> {
    this.check();
    if (this.reading) throw new ServiceError("Concurrent session reads are not permitted.", 409);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 120) throw new ServiceError("Invalid session receive timeout.", 400);
    this.reading = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      this.pending ??= this.peer.message().then(message => {
        if (!message) throw new ServiceError("Session disconnected; open a new identity without replaying input.", 410, { code: "session_disconnected" });
        if (message.binary) return message.data;
        let value: Record<string, unknown>;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.data)) as Record<string, unknown>; encodeControl(value); }
        catch { throw new ServiceError("Invalid session control.", 400); }
        return value;
      }).catch(error => { this.failure = error instanceof ServiceError ? error : new ServiceError("Session protocol failed; input is not replayed.", 503, { retryable: false }); this.close(); throw this.failure; });
      void this.pending.catch(() => {});
      const value = await Promise.race([this.pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutSeconds * 1000); })]);
      if (value !== null) { this.pending = undefined; this.check(); if (!(value instanceof Uint8Array)) this.failure = workerError(value, this.sessionId); }
      return value;
    } finally { if (timer) clearTimeout(timer); this.reading = false; }
  }
  close(): void { clearInterval(this.timer); this.peer.close(); }
}

/** Durable runner attempt ledger. Only correlation identities and completion/cleanup states are retained. */
export class SqliteSessionReceipts {
  constructor(readonly store: SqliteStore, readonly legacyDirectory?: string) {
    store.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS runner_access_session_attempts (id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,cleanup TEXT NOT NULL)"));
  }
  private binding(job: import("./session-protocol.ts").RunnerSessionJob): string {
    return JSON.stringify([identifier(job.id), identifier(job.generation), identifier(job.leaseId), identifier(job.machineId), job.capability]);
  }
  claim(job: import("./session-protocol.ts").RunnerSessionJob): boolean {
    return this.store.transaction(db => {
      const binding = this.binding(job), row = db.prepare("SELECT binding FROM runner_access_session_attempts WHERE id=?").get(job.id);
      if (row) { if (row.binding !== binding) throw new ServiceError("Session attempt identity belongs to another binding.", 409); return false; }
      if (this.legacyDirectory !== undefined) {
        try { lstatSync(join(this.legacyDirectory, identifier(job.id) + ".json")); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ServiceError("Prior session attempt requires inspection.", 409, { retryable: false, outcome: "unknown" }); }
      }
      db.prepare("INSERT INTO runner_access_session_attempts VALUES (?,?,'connecting','notNeeded')").run(job.id, binding); return true;
    });
  }
  update(job: import("./session-protocol.ts").RunnerSessionJob, state: "active" | "complete" | "unknown", cleanup: "notNeeded" | "unknown" | "complete"): void {
    this.store.transaction(db => {
      if (!db.prepare("UPDATE runner_access_session_attempts SET state=?,cleanup=? WHERE id=? AND binding=?").run(state, cleanup, job.id, this.binding(job)).changes) throw new ServiceError("Session attempt binding differs.", 409);
    });
  }
}

/** Native helper facade; only an owner-injected authenticated assignment binding can enable it. */
export class GuestHelperAccess {
  readonly inspectionSystems = new Set(["macos"]);
  readonly supportsScopedDesktop = true;
  constructor(readonly resolve: (machine: Record<string, unknown>, image: Record<string, unknown>, folder: string) => GuestHelperBinding | Promise<GuestHelperBinding>) {}
  private async binding(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<GuestHelperBinding> {
    if (image.os !== "macos") throw new ServiceError("This guest helper adapter supports macOS only.", 409, { code: "capability_unsupported" });
    const binding = await this.resolve(machine, image, folder);
    if (!(binding instanceof GuestHelperBinding)) throw new ServiceError("Native guest assignment binding is missing.", 409);
    return binding;
  }
  private app(app: string | undefined): void { if (app !== undefined) throw new ServiceError("Native guest files do not use simulator app containers.", 400); }
  async control(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const args = request.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new ServiceError("Invalid native guest arguments.", 400);
    const action = request.action;
    if (typeof action === "string" && ["shell-open", "shell-read", "shell-write", "shell-resize", "shell-close"].includes(action)) {
      const b = await this.binding(machine, image, folder);
      return new GuestChunkShells((path, body) => b.call(path, body, action === "shell-close")).control(action, args as Record<string, unknown>);
    }
    if (action === "list-files") {
      const v = exact(args, ["path"]), b = await this.binding(machine, image, folder);
      return new GuestChunkFiles((path, body) => b.call(path, body)).list(v.path as string);
    }
    if (action === "accessibility" && !Object.keys(args).length) return this.inspect(machine, image, folder);
    throw new ServiceError("This action requires an owned display context or is unsupported.", 409, { code: "capability_unsupported", retryable: false });
  }
  async inspect(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<Record<string, unknown>> {
    const b = await this.binding(machine, image, folder), value = await b.call("/v1/accessibility", null);
    jsonBytes(value, MAX_INSPECTION_BYTES); validateSnapshot(value);
    if (value.source !== "macos-accessibility" || value.coordinateSpace !== "screen-points") throw new ServiceError("Native accessibility source or coordinates differ.", 409);
    return value;
  }
  async desktop(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<DisplayConnection> { return this.desktopSession(machine, image, folder, () => true); }
  async desktopSession(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, authorized: () => boolean): Promise<DisplayConnection> {
    const b = await this.binding(machine, image, folder);
    return connectGuestDisplay((path, body) => b.call(path, body, path === "/v1/display/release"), () => authorized() && b.authorized(), b.cleanupAuthorized ?? b.authorized);
  }
  async streamUpload(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, path: string, app: string | undefined, reader: ByteReader, size: number, authorized: () => boolean): Promise<{ uploaded: number; durable: true }> {
    this.app(app); const b = await this.binding(machine, image, folder);
    return new GuestChunkFiles((route, body) => b.call(route, body)).upload(path, reader, size, () => authorized() && b.authorized());
  }
  async streamDownload(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, path: string, app?: string): Promise<VerifiedDownload> {
    this.app(app); const b = await this.binding(machine, image, folder);
    return new GuestChunkFiles((route, body) => b.call(route, body)).download(path, b.authorized);
  }
}
