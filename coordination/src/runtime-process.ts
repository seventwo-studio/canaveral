import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import { legacyDigest } from "./control/templates.ts";

export type RecordValue = Record<string, unknown>;
export const unknownOutcome = (message = "Owned process closure is unconfirmed; retain its reservation."): ServiceError =>
  new ServiceError(message, 409, { code: "helper_cancellation_uncertain", retryable: false, outcome: "unknown" });
export function present(path: string): boolean { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
/** Check every existing parent; metadata and owned roots never traverse symlinks. */
export function noLinks(path: string): void {
  const absolute = resolve(path), parent = dirname(absolute);
  if (parent !== absolute) noLinks(parent);
  if (present(absolute) && lstatSync(absolute).isSymbolicLink()) throw new ServiceError("Owned paths cannot be symbolic links.", 409);
}
export function privateDirectory(path: string): void {
  noLinks(path); mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new ServiceError("Host state must be a private owned directory.", 409);
}
export function readRecord(path: string, maximum = 1_048_576): RecordValue {
  noLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new ServiceError("Invalid private runtime record.", 409);
    const bytes = readFileSync(fd);
    if (bytes.length > maximum) throw new ServiceError("Private runtime record exceeds its bound.", 409);
    return object(JSON.parse(bytes.toString("utf8")) as unknown);
  } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** Synchronized replacement, private temporary file, never follow destination links. */
export function saveRecord(path: string, value: unknown): void {
  privateDirectory(dirname(path)); noLinks(path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { noLinks(path); renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally { if (present(temporary)) unlinkSync(temporary); }
}
export function assignmentFingerprint(machine: RecordValue): string {
  identifier(machine.id);
  return legacyDigest({ id: machine.id, template: object(machine.template), resources: object(machine.resources) });
}

/** SQLite locks release on process loss. These are TS-runner locks, not native flock substitutes. */
export class StateLock {
  private db: DatabaseSync | undefined;
  constructor(readonly path: string, readonly shared = false) {
    privateDirectory(dirname(path)); noLinks(path);
    const db = new DatabaseSync(path, { timeout: 0 });
    try {
      db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS runner_lock (id INTEGER PRIMARY KEY);");
      db.exec(shared ? "BEGIN; SELECT * FROM runner_lock;" : "BEGIN EXCLUSIVE;");
      this.db = db;
    } catch { db.close(); throw new ServiceError("Owned state has active work.", 409, { code: "assignment_busy" }); }
  }
  close(): void { const db = this.db; this.db = undefined; if (db) { try { db.exec("ROLLBACK"); } finally { db.close(); } } }
}
export interface AssignmentContext { machine: RecordValue; folder: string }
const assignmentContext = new AsyncLocalStorage<AssignmentContext>();
export const currentAssignment = (): AssignmentContext | undefined => assignmentContext.getStore();
export async function assignmentAccess<T>(machine: RecordValue, folder: string, work: () => Promise<T>, options: { exclusive?: boolean; fencing?: boolean } = {}): Promise<T> {
  if (!machine.lease) return work();
  if (process.platform === "win32") throw new ServiceError("Lease assignment locking is unavailable on Windows.", 409, { code: "capability_unsupported" });
  const id = identifier(machine.id), parent = dirname(folder);
  const lock = new StateLock(join(parent, ".assignment-locks", `${id}.sqlite`), !options.exclusive);
  try {
    if (present(join(parent, ".lease-cleanup", `${id}.json`)) && !options.exclusive && !options.fencing) throw new ServiceError("Assignment has a durable cleanup intent.", 410);
    return await assignmentContext.run({ machine, folder }, work);
  } finally { lock.close(); }
}

export interface ExecutionClock { now(): number; wall(): number; readonly suspendAware: boolean; readonly bootId?: string }
/** hrtime covers awake elapsed time. Wall advances also expire contact across sleep.
 * Node has no portable continuous Darwin clock; leased starts require an injected native clock.
 */
export function executionClock(): ExecutionClock {
  let elapsed = 1, mono = process.hrtime.bigint(), wall = Date.now();
  return { suspendAware: false, wall: () => Date.now() / 1000, now: () => {
    const nextMono = process.hrtime.bigint(), nextWall = Date.now();
    const awake = Number(nextMono - mono) / 1e9, civil = (nextWall - wall) / 1000;
    elapsed += civil < -5 ? 20 + awake : Math.max(awake, civil, 0);
    mono = nextMono; wall = nextWall; return elapsed;
  } };
}
export function contactFresh(last: number, now: number): boolean { return Number.isFinite(last) && last > 0 && now >= last && now - last < 20; }
interface GuardRecord { machine: RecordValue; receivedAt: number; fenced: boolean; executionStarted: boolean; bootId?: string; elapsedDeadline?: number; retired?: boolean; cleanupId?: string }
export interface LeaseAuthorization { leaseID: string; revision: number; remainingSeconds: number; fenced: boolean }
export class LeaseGuard {
  readonly records = new Map<string, GuardRecord>();
  private deadlines = new Map<string, number>();
  private checkpointDirty = false;
  private historyKnown: boolean;
  readonly path: string;
  constructor(state: string, readonly clock: ExecutionClock = executionClock()) {
    this.path = join(state, "lease-execution.json");
    this.historyKnown = present(this.path) || !present(join(state, "identity.json"));
    if (present(this.path)) {
      const saved = readRecord(this.path); let changed = false;
      let recoveredAt: number | undefined;
      try { const value = clock.now(); if (Number.isFinite(value) && value >= 0) recoveredAt = value; } catch { /* Load every record fenced before persisting. */ }
      for (const [id, value] of Object.entries(saved)) {
        identifier(id); const raw = object(value), machine = object(raw.machine), lease = object(machine.lease);
        if (machine.id !== id || typeof raw.fenced !== "boolean" || typeof raw.receivedAt !== "number" || !Number.isFinite(raw.receivedAt)) throw unknownOutcome("Invalid persisted lease guard.");
        validateLease(lease);
        const remaining = Number(lease.authorizationDeadline) - clock.wall() - 5;
        const boundDeadline = typeof raw.elapsedDeadline === 'number' && Number.isFinite(raw.elapsedDeadline) && raw.elapsedDeadline >= 0 && raw.elapsedDeadline <= Number.MAX_SAFE_INTEGER ? raw.elapsedDeadline : undefined;
        const deadline = Math.min((recoveredAt ?? 0) + Math.max(0, remaining), boundDeadline ?? Infinity);
        const fenced = raw.fenced || clock.wall() < raw.receivedAt - 5 || remaining <= 0 || !clock.suspendAware || recoveredAt === undefined ||
          clock.bootId !== undefined && (raw.bootId !== clock.bootId || boundDeadline === undefined || recoveredAt >= deadline);
        this.records.set(id, { machine, receivedAt: raw.receivedAt, fenced, executionStarted: raw.executionStarted !== false,
          ...(typeof raw.bootId === 'string' ? { bootId: raw.bootId } : {}),
          ...(boundDeadline === undefined ? {} : { elapsedDeadline: boundDeadline }),
          ...(raw.retired === true ? { retired: true, cleanupId: identifier(raw.cleanupId) } : {}) });
        this.deadlines.set(id, deadline); changed ||= fenced !== raw.fenced;
      }
      if (changed) this.save();
    }
  }
  private save(): void {
    this.checkpointDirty = true;
    saveRecord(this.path, Object.fromEntries(this.records));
    this.checkpointDirty = false;
  }
  private sample(): number | undefined {
    try { const value = this.clock.now(); if (Number.isFinite(value) && value >= 0) return value; } catch { /* Native fencing remains responsible for stopping execution. */ }
    let changed = false;
    for (const record of this.records.values()) if (!record.fenced) { record.fenced = true; changed = true; }
    if (changed || this.checkpointDirty) this.save();
    return undefined;
  }
  observe(machines: RecordValue[], roundTrip: number): void {
    if (!Number.isFinite(roundTrip) || roundTrip < 0) throw new ServiceError("Invalid heartbeat timing.", 400);
    const now = this.sample(); if (now === undefined) throw unknownOutcome('Lease clock failed; retained assignments remain fenced.');
    const wall = this.clock.wall(), seen = new Set<string>();
    for (const machine of machines) {
      const id = identifier(machine.id), previous = this.records.get(id); seen.add(id);
      if (!machine.lease) { if (previous) previous.fenced = true; continue; }
      const lease = object(machine.lease); validateLease(lease);
      if (previous && object(previous.machine.lease).id !== lease.id) { previous.fenced = true; this.save(); throw new ServiceError("Machine lease ownership changed.", 409); }
      if (previous?.retired) continue;
      if (previous && Number(lease.revision) < Number(object(previous.machine.lease).revision)) continue;
      let deadline = now + Math.max(0, Number(lease.authorizationDeadline) - Number(lease.controllerNow) - roundTrip);
      if (previous && Number(lease.authorizationDeadline) <= Number(object(previous.machine.lease).authorizationDeadline)) deadline = Math.min(deadline, this.deadlines.get(id)!);
      const fenced = !!previous && (previous.fenced || now >= this.deadlines.get(id)!) ||
        !["provisioning", "ready"].includes(String(lease.state)) || Math.abs(wall - Number(lease.controllerNow)) > 5 + roundTrip || deadline <= now || !this.clock.suspendAware;
      this.records.set(id, { machine: structuredClone(machine), receivedAt: wall, fenced, executionStarted: previous ? previous.executionStarted : !this.historyKnown,
        ...(this.clock.bootId === undefined ? {} : { bootId: this.clock.bootId, elapsedDeadline: deadline }) });
      this.deadlines.set(id, deadline);
    }
    for (const [id, record] of this.records) if (!seen.has(id) && !record.retired) record.fenced = true;
    this.save(); this.historyKnown = true;
  }
  allowed(id: string): boolean {
    // A failed fence write stays uncertain until its checkpoint is synchronized.
    if (this.checkpointDirty) this.save();
    const record = this.records.get(id);
    if (!record) return true;
    if (!record.fenced) {
      const now = this.sample();
      if (now === undefined) return false;
      if (now >= this.deadlines.get(id)!) { record.fenced = true; this.save(); }
    }
    return !record.fenced && !record.retired;
  }
  assignments(current: RecordValue[]): RecordValue[] {
    const result = new Map(current.map(m => [identifier(m.id), structuredClone(m)]));
    for (const [id, record] of this.records) {
      if (record.retired) { result.delete(id); continue; }
      if (!result.has(id)) result.set(id, structuredClone(record.machine));
      if (!this.allowed(id)) Object.assign(result.get(id)!, { desired: "stopped", leaseFenced: true });
    }
    return [...result.values()];
  }
  fencedMachines(): Set<string> { return new Set([...this.records].filter(([id, r]) => !r.retired && !this.allowed(id)).map(([id]) => id)); }
  beginExecution(id: string, leaseId: string): void {
    const record = this.records.get(identifier(id));
    if (!record || object(record.machine.lease).id !== identifier(leaseId) || !this.allowed(id)) throw new ServiceError("Leased execution is unauthorized.", 410);
    if (!record.executionStarted) { record.executionStarted = true; this.save(); }
  }
  neverStarted(id: string, leaseId: string): boolean { const r = this.records.get(identifier(id)); return !!r && object(r.machine.lease).id === identifier(leaseId) && !r.executionStarted; }
  authorization(id: string, leaseId: string): LeaseAuthorization {
    const record = this.records.get(identifier(id));
    if (!record || object(record.machine.lease).id !== identifier(leaseId)) throw new ServiceError("Native lease ownership is unavailable.", 409);
    const allowed = this.allowed(id);
    const now = allowed ? this.sample() : undefined;
    const current = allowed && now !== undefined && now < this.deadlines.get(id)!;
    if (!current && !record.fenced) { record.fenced = true; this.save(); }
    return { leaseID: leaseId, revision: Number(object(record.machine.lease).revision), remainingSeconds: current ? this.deadlines.get(id)! - now! : 0, fenced: !current };
  }
  retire(id: string, leaseId: string, cleanupId: string): void {
    const record = this.records.get(identifier(id));
    if (!record || object(record.machine.lease).id !== identifier(leaseId)) throw new ServiceError("Cleanup lease ownership differs.", 409);
    const cleanup = object(record.machine.leaseCleanup);
    if (cleanup.id !== identifier(cleanupId) || cleanup.leaseId !== leaseId) throw new ServiceError("Cleanup intent differs.", 409);
    Object.assign(record, { fenced: true, retired: true, cleanupId }); this.save();
  }
}
function validateLease(lease: RecordValue): void {
  identifier(lease.id);
  for (const key of ["authorizationDeadline", "controllerNow"]) if (typeof lease[key] !== "number" || !Number.isFinite(lease[key]) || lease[key] < 0 || lease[key] > Number.MAX_SAFE_INTEGER) throw new ServiceError("Invalid lease deadline.", 400);
  if (!Number.isSafeInteger(lease.revision) || Number(lease.revision) < 1) throw new ServiceError("Invalid lease revision.", 400);
}

export function groupPresent(id: number): boolean | undefined {
  if (!Number.isSafeInteger(id) || id <= 1 || process.platform === "win32") return undefined;
  try { process.kill(-id, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
}
export function helperDirectory(folder: string, id: string): string { return join(dirname(folder), ".assignment-helpers", identifier(id)); }
/** Recovered PIDs are observed, never signalled. Missing launch publication remains blocked. */
export function helpersClosed(machine: RecordValue, folder: string, inspect?: (pid: number) => number | null): boolean {
  const root = helperDirectory(folder, String(machine.id));
  try {
    noLinks(root); if (!present(root)) return true;
    for (const name of readdirSync(root)) {
      const path = join(root, name), r = readRecord(path, 65536);
      if (r.version !== 2 || r.machineId !== machine.id || r.leaseId !== object(machine.lease).id || !["running", "cancelling"].includes(String(r.state)) || !Number.isInteger(r.pid) || Number(r.pid) <= 1 || r.processGroupId !== r.pid || typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt) || r.startedAt <= 0 || !inspect) return false;
      if (inspect(Number(r.pid)) === r.startedAt || groupPresent(Number(r.pid)) !== false) return false;
      unlinkSync(path);
    }
    return true;
  } catch { return false; }
}
export interface ProcessOptions {
  folder?: string; machine?: RecordValue; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv; input?: string | Uint8Array;
  /** Native backend may signal a group only while it pins the unreaped direct child. */
  signalOwnedGroup?: (child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) => void;
  birth?: (child: ChildProcessWithoutNullStreams) => number | undefined;
}
export interface ProcessResult { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }
export class ProcessSupervisor {
  private running = new Set<{ child: ChildProcessWithoutNullStreams; stop: () => void; done: Promise<void> }>();
  async run(argv: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    if (!argv.length || argv.some(x => typeof x !== "string" || x.includes("\0"))) throw new ServiceError("Invalid helper arguments.", 400);
    if (options.signal?.aborted) throw new ServiceError("Helper cancelled before launch.", 410);
    const held = currentAssignment(), machine = options.machine ?? held?.machine, folder = options.folder ?? held?.folder;
    const lease = machine?.lease ? object(machine.lease) : undefined;
    let receipt: string | undefined, record: RecordValue = {};
    if (lease) {
      if (!folder || !machine || process.platform === "win32") throw new ServiceError("Leased helper ownership is unavailable.", 409, { code: "capability_unsupported" });
      receipt = join(helperDirectory(folder, String(machine.id)), `${randomUUID()}.json`);
      record = { version: 2, machineId: machine.id, leaseId: lease.id, state: "launching" }; saveRecord(receipt, record);
    }
    const child = spawn(argv[0]!, argv.slice(1), { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], ...(options.env ? { env: options.env } : {}) });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, stopped = false, uncertain = false, exited = false;
    let resolveDone!: () => void;
    const done = new Promise<void>(r => { resolveDone = r; });
    const mark = (state: string): void => { if (receipt) { record.state = uncertain ? "uncertain" : state; saveRecord(receipt, record); } };
    const stop = (): void => {
      stopped = true;
      try { mark("cancelling"); } catch { uncertain = true; }
      // libuv's live child handle protects direct-child signalling. Node cannot pin
      // an unreaped group leader; group signalling requires the explicit native hook.
      try { if (!exited) options.signalOwnedGroup ? options.signalOwnedGroup(child, "SIGKILL") : child.kill("SIGKILL"); }
      catch { uncertain = true; }
    };
    const entry = { child, stop, done }; this.running.add(entry);
    options.signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(stop, options.timeoutMs ?? 300_000);
    let boundedDrain: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<ProcessResult>((accept, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return; settled = true;
          if (error) reject(error); else accept({ code: child.exitCode, signal: child.signalCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        };
        const collect = (target: Buffer[]) => (data: Buffer): void => { bytes += data.length; if (bytes <= (options.maxOutputBytes ?? 1_048_576)) target.push(data); else { uncertain = true; stop(); } };
        child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
        child.stdin.on("error", () => { /* A partial input is never replayed. */ });
        child.once("spawn", () => {
          try {
            if (receipt) { const birth = options.birth?.(child); record = { ...record, pid: child.pid, startedAt: birth ?? 0, processGroupId: child.pid, state: birth ? "running" : "uncertain" }; uncertain ||= !birth; saveRecord(receipt, record); }
            if (options.signal?.aborted) stop();
            child.stdin.end(options.input);
          } catch { uncertain = true; stop(); }
        });
        child.once("error", () => {
          if (!child.pid && receipt) { unlinkSync(receipt); receipt = undefined; }
          finish(new ServiceError("Helper launch failed.", 409));
        });
        child.once("exit", () => {
          exited = true;
          boundedDrain = setTimeout(() => { uncertain = true; child.stdout.destroy(); child.stderr.destroy(); finish(unknownOutcome("Helper output did not close; descendants remain uncertain.")); }, 1000);
        });
        child.once("close", () => {
          if (boundedDrain) clearTimeout(boundedDrain);
          if (receipt) {
            if (!uncertain && groupPresent(child.pid!) === false) { unlinkSync(receipt); receipt = undefined; }
            else { uncertain = true; try { mark("uncertain"); } catch { /* Keep durable launch intent. */ } }
          }
          if (uncertain || (stopped && groupPresent(child.pid!) !== false)) finish(unknownOutcome());
          else if (stopped) finish(new ServiceError("Helper cancelled or its execution deadline ended.", 410));
          else finish();
        });
        // Stop must itself have a finite wait even if the OS refuses termination.
        const stopWatch = setInterval(() => { if (stopped && !boundedDrain) boundedDrain = setTimeout(() => { uncertain = true; child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); finish(unknownOutcome()); }, 2000); if (settled) clearInterval(stopWatch); }, 25);
      });
      return result;
    } finally {
      clearTimeout(timeout); if (boundedDrain) clearTimeout(boundedDrain);
      options.signal?.removeEventListener("abort", stop);
      if (exited && (groupPresent(child.pid!) === false || process.platform === "win32" && !uncertain)) this.running.delete(entry);
      resolveDone();
    }
  }
  async close(): Promise<void> {
    const entries = [...this.running]; entries.forEach(e => e.stop());
    await Promise.all(entries.map(e => e.done));
    for (const entry of entries) if (groupPresent(entry.child.pid!) === false) this.running.delete(entry);
    if (entries.some(e => e.child.exitCode === null && e.child.signalCode === null || process.platform !== "win32" && groupPresent(e.child.pid!) !== false)) throw unknownOutcome();
  }
}

export interface NativeClock { version: number; bootSessionID: string; continuous: number }
export async function publishNativeLease(machine: RecordValue, directory: string, authorization: () => LeaseAuthorization, nativeClock: () => Promise<NativeClock>, clock: ExecutionClock, stopping = false): Promise<RecordValue> {
  const lock = new StateLock(join(directory, "lease-authorization.sqlite"));
  try {
    const start = clock.now(), allowed = authorization(), native = await nativeClock(), elapsed = clock.now() - start;
    if (native.version !== 1 || !Number.isFinite(native.continuous) || native.continuous < 0) throw new ServiceError("Native continuous lease clock is unavailable.", 409);
    const leaseId = identifier(object(machine.lease).id), boot = readRecord(join(directory, "runner-launch.json")).attemptedAt;
    if (allowed.leaseID !== leaseId || !Number.isSafeInteger(allowed.revision) || allowed.revision < 1 || !Number.isFinite(allowed.remainingSeconds) || allowed.remainingSeconds < 0 || typeof allowed.fenced !== "boolean" || typeof boot !== "number" || !Number.isFinite(boot)) throw new ServiceError("Native lease identity or boot differs.", 409);
    const value: RecordValue = { version: 1, machineID: identifier(machine.id), leaseID: leaseId, revision: allowed.revision, boot, bootSessionID: identifier(native.bootSessionID), deadline: Math.max(0, native.continuous + allowed.remainingSeconds - elapsed - .25), fenced: stopping || allowed.fenced };
    const path = join(directory, "lease-authorization.json");
    if (present(path)) {
      const previous = readRecord(path);
      if (previous.leaseID !== leaseId || previous.machineID !== machine.id || previous.boot !== boot || previous.bootSessionID !== native.bootSessionID || typeof previous.deadline !== "number" || !Number.isFinite(previous.deadline) || typeof previous.fenced !== "boolean" || !Number.isSafeInteger(previous.revision)) throw new ServiceError("Native authorization belongs to another identity or boot.", 409);
      if (allowed.revision < Number(previous.revision)) throw new ServiceError("Native revision cannot move backwards.", 409);
      value.fenced ||= previous.fenced;
      if (allowed.revision === previous.revision) value.deadline = Math.min(Number(value.deadline), previous.deadline);
    }
    saveRecord(path, value); return value;
  } finally { lock.close(); }
}

export interface NativeFenceChecks {
  pidExists(pid: number): Promise<boolean>;
  diskClosed(path: string): Promise<boolean>;
  withRuntimeLock<T>(path: string, work: () => Promise<T>): Promise<T>;
}
export async function confirmFenced(machine: RecordValue, directory: string, checks: NativeFenceChecks): Promise<boolean> {
  const leaseId = identifier(object(machine.lease).id), boot = readRecord(join(directory, "runner-launch.json")).attemptedAt;
  if (typeof boot !== "number" || !Number.isFinite(boot) || boot < 0) throw new ServiceError("Native boot identity is invalid.", 409);
  const marker = join(directory, "lease-fenced.json"); let proof: RecordValue;
  if (present(marker)) {
    proof = readRecord(marker, 65536);
    if (identifier(proof.machineID) !== machine.id || identifier(proof.leaseID) !== leaseId || proof.boot !== boot) throw new ServiceError("Native fence belongs to another boot or lease.", 409);
  } else {
    if (String(readRecord(join(directory, "machine.json")).executionLeaseID).toLowerCase() !== leaseId) return false;
    proof = readRecord(join(directory, "status.json"));
    if (proof.phase !== "Stopped" || typeof proof.updatedAt !== "number" || !Number.isFinite(proof.updatedAt) || proof.updatedAt + 978307200 < boot) return false;
  }
  if (!Number.isInteger(proof.pid) || Number(proof.pid) <= 0) throw new ServiceError("Native process identity is unavailable.", 409);
  if (await checks.pidExists(Number(proof.pid))) return false;
  for (const file of ["runtime.lock", "disk.img", "runner-launch.json"]) noLinks(join(directory, file));
  try { return await checks.withRuntimeLock(join(directory, "runtime.lock"), async () => {
    if (!await checks.diskClosed(join(directory, "disk.img"))) return false;
    if (present(marker)) saveRecord(join(directory, "fenced-stop.json"), { boot, stoppedAt: Date.now() / 1000, consistency: "crash-consistent", leaseID: leaseId });
    return true;
  }); } catch (e) { if (e instanceof ServiceError && e.code === "assignment_busy") return false; throw e; }
}

export interface RemovalChecks extends NativeFenceChecks { confirmedStopped(native: string): Promise<boolean>; prebootStorage?(machine: RecordValue, folder: string, storage: string): Promise<boolean>; treeClosed?(storage: string): Promise<boolean> }
/** Recoverable owned removal. The native provider must supply real lock/stop/handle proofs. */
export async function removeAppleStorage(storageRoot: string, machine: RecordValue, folder: string, requestId: string, checks: RemovalChecks, preboot = false): Promise<RecordValue> {
  const id = identifier(machine.id), request = identifier(requestId), fingerprint = assignmentFingerprint(machine);
  if (machine.desired !== "stopped" || readRecord(join(folder, "assignment.json")).fingerprint !== fingerprint) throw new ServiceError("Owned removal requires a matching stopped assignment.", 409);
  const root = resolve(storageRoot), storage = join(root, id), quarantine = join(root, `.removing-${id}-${request}`), receipt = join(folder, "deletion.json");
  noLinks(root); noLinks(storage); noLinks(quarantine);
  const lock = new StateLock(join(folder, "deletion.sqlite"));
  try {
    const expected: RecordValue = { id: request, machineId: id, fingerprint };
    let proof: RecordValue;
    if (present(receipt)) {
      proof = readRecord(receipt);
      if (proof.evidence === "preboot") Object.assign(expected, { evidence: "preboot", leaseId: identifier(object(machine.lease).id) });
      if (Object.entries(expected).some(([k, v]) => proof[k] !== v) || preboot && proof.evidence !== "preboot") throw new ServiceError("Deletion receipt ownership differs.", 409);
    } else {
      if (!present(storage) || !lstatSync(storage).isDirectory() || present(quarantine) || readRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint) throw new ServiceError("Owned storage or removal path is unavailable.", 409);
      if (preboot) {
        if (!await checks.prebootStorage?.(machine, folder, storage)) throw new ServiceError("Preboot evidence is unavailable.", 409);
        Object.assign(expected, { evidence: "preboot", leaseId: identifier(object(machine.lease).id) });
      }
      proof = { ...expected, state: "planned" };
    }
    if (proof.state === "complete") { if (present(storage) || present(quarantine)) throw new ServiceError("Storage reappeared after deletion.", 409); return proof; }
    if (present(storage)) {
      if (proof.state !== "planned" || present(quarantine) || readRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint) throw new ServiceError("Deletion layout or ownership changed.", 409);
      const native = join(storage, id.toUpperCase()), partial = proof.evidence === "preboot";
      noLinks(native);
      for (const file of ["runtime.lock", "status.json", "runner-launch.json", "fenced-stop.json", "disk.img"]) noLinks(join(native, file));
      if (partial && !await checks.treeClosed?.(storage)) throw new ServiceError("Partial preparation handles remain unconfirmed.", 409);
      const remove = async (): Promise<void> => {
        if (partial ? !await checks.prebootStorage?.(machine, folder, storage) : !await checks.confirmedStopped(native) || !await checks.diskClosed(join(native, "disk.img"))) throw new ServiceError("Positive stop and closed handles are required.", 409);
        saveRecord(receipt, proof); renameSync(storage, quarantine); syncDirectory(root);
      };
      if (present(native)) await checks.withRuntimeLock(join(native, "runtime.lock"), remove); else if (partial) await remove(); else throw new ServiceError("Native storage is missing.", 409);
    }
    if (!present(quarantine) && proof.state !== "removing") throw new ServiceError("No durable evidence explains missing storage.", 409);
    if (present(quarantine)) {
      if (!["planned", "removing"].includes(String(proof.state))) throw new ServiceError("Invalid removal state.", 409);
      if (proof.state === "planned" && readRecord(join(quarantine, "canaveral-owner.json")).fingerprint !== fingerprint) throw new ServiceError("Quarantine ownership differs.", 409);
      proof = { ...expected, state: "removing" }; saveRecord(receipt, proof);
      // Host state is private and the assignment gate is exclusive. rm unlinks
      // nested symlinks; it never follows them into separately owned trees.
      rmSync(quarantine, { recursive: true }); syncDirectory(root);
    }
    proof = { ...expected, state: "complete" }; saveRecord(receipt, proof); return proof;
  } finally { lock.close(); }
}

export interface ObservedProcess { pid: number; createdAt: number; uid: number; executable: string; argv: string[]; zombie?: boolean }
export interface ProcessInspector {
  get(pid: number): Promise<ObservedProcess | null>;
  children?(pid: number): Promise<ObservedProcess[]>;
  /** Must recheck the creation identity atomically with native signalling. */
  terminatePinned?(proof: ObservedProcess): Promise<void>;
}
export interface UsageBinding { process: ObservedProcess; born: number; category: "virtualMachines" | "simulators" }
/** Read only attribution: no lock acquisition, adoption, scanning by process name or signalling. */
export async function appleProcesses(config: RecordValue, machine: RecordValue, folder: string, inspector: ProcessInspector): Promise<UsageBinding[]> {
  const id = identifier(machine.id), storage = join(resolve(String(config.storage)), id), native = join(storage, id.toUpperCase()), expected = assignmentFingerprint(machine);
  noLinks(storage); noLinks(native); noLinks(folder);
  if (readRecord(join(folder, "assignment.json"), 65536).fingerprint !== expected || readRecord(join(storage, "canaveral-owner.json"), 65536).fingerprint !== expected) throw new ServiceError("Runtime observation ownership is unavailable.", 409);
  const definition = readRecord(join(native, "machine.json"), 65536), leaseId = machine.lease ? object(machine.lease).id : undefined;
  if (identifier(definition.id) !== id || (definition.executionLeaseID ? identifier(definition.executionLeaseID) : undefined) !== leaseId) throw new ServiceError("Runtime observation lease identity differs.", 409);
  const launch = readRecord(join(native, "runner-launch.json"), 65536), status = readRecord(join(native, "status.json"), 65536), boot = Number(launch.attemptedAt);
  if (!Number.isFinite(boot) || typeof status.updatedAt !== "number" || !Number.isFinite(status.updatedAt) || status.updatedAt + 978307200 < boot - 1 || !Number.isInteger(status.pid) || Number(status.pid) <= 0) throw new ServiceError("Runtime observation boot is unavailable.", 409);
  const processInfo = await inspector.get(Number(status.pid));
  if (!processInfo) return [];
  if (!validOwnedProcess(processInfo, boot) || resolve(processInfo.executable) !== resolve(String(config.runner)) || JSON.stringify(processInfo.argv.slice(1)) !== JSON.stringify(["run", native]) || (await inspector.get(processInfo.pid))?.createdAt !== processInfo.createdAt) throw new ServiceError("Runtime process observation identity differs.", 409);
  return [{ process: processInfo, born: processInfo.createdAt, category: "virtualMachines" }];
}
function validOwnedProcess(info: ObservedProcess, launch: number): boolean { return Number.isFinite(info.createdAt) && info.createdAt >= launch - 1 && info.createdAt <= launch + 10 && (!process.getuid || info.uid === process.getuid()); }
export async function androidProcesses(config: RecordValue, machine: RecordValue, image: RecordValue, folder: string, argv: string[], executables: Set<string>, inspector: ProcessInspector): Promise<UsageBinding[]> {
  const id = identifier(machine.id), storage = join(resolve(String(config.storage)), id), expected = assignmentFingerprint(machine);
  noLinks(folder); noLinks(storage);
  for (const path of [join(folder, "assignment.json"), join(storage, "canaveral-owner.json")]) if (readRecord(path, 65536).fingerprint !== expected) throw new ServiceError("Android observation ownership differs.", 409);
  const path = join(storage, "launch.json");
  if (!present(path) && machine.observed === "stopped") return [];
  const launch = readRecord(path, 65536), required = ["version", "bootId", "machineId", "leaseId", "fingerprint", "argv", "startedAt", "pid", "processStartedAt"];
  const port = readRecord(join(storage, "endpoint.json"), 65536).port;
  if (readRecord(join(storage, "avd-created.json"), 65536).name !== `cvm-${id}` || !Number.isInteger(port) || Number(port) % 2 !== 0 || Number(port) < 5554 || Number(port) >= 5682 || argv[argv.indexOf("-avd") + 1] !== `cvm-${id}` || argv[argv.indexOf("-port") + 1] !== String(port)) throw new ServiceError("Android AVD or endpoint identity differs.", 409);
  identifier(launch.bootId);
  if (Object.keys(launch).length !== required.length || required.some(k => !(k in launch)) || launch.version !== 2 || launch.machineId !== id || launch.fingerprint !== expected || (launch.leaseId ?? null) !== (machine.lease ? object(machine.lease).id : null) || JSON.stringify(launch.argv) !== JSON.stringify(argv) || typeof launch.startedAt !== "number" || !Number.isFinite(launch.startedAt) || typeof launch.processStartedAt !== "number" || !Number.isFinite(launch.processStartedAt) || launch.processStartedAt <= 0 || !Number.isInteger(launch.pid) || Number(launch.pid) <= 1) throw new ServiceError("Android pinned process identity is unavailable.", 409);
  const info = await inspector.get(Number(launch.pid));
  if (!info) { if (machine.observed === "stopped") return []; throw new ServiceError("Android process disappeared before observation.", 409); }
  if (info.createdAt !== launch.processStartedAt || !validOwnedProcess(info, launch.startedAt) || !executables.has(resolve(info.executable)) || JSON.stringify(info.argv.slice(1)) !== JSON.stringify(argv.slice(1))) throw new ServiceError("Android process identity differs.", 409);
  if (!inspector.children) throw new ServiceError("Android descendant observation is unavailable.", 409);
  const children = await inspector.children(info.pid), result: UsageBinding[] = [{ process: info, born: info.createdAt, category: "simulators" }];
  for (const child of children) {
    if (!Number.isFinite(child.createdAt) || child.createdAt < info.createdAt || (process.getuid && child.uid !== process.getuid()) || (await inspector.get(child.pid))?.createdAt !== child.createdAt) throw new ServiceError("Android descendant identity differs.", 409);
    result.push({ process: child, born: child.createdAt, category: "simulators" });
  }
  if ((await inspector.get(info.pid))?.createdAt !== info.createdAt) throw new ServiceError("Android process changed during observation.", 409);
  return result;
}
/** Explicit native power cut; a persisted request never re-signals a recovered PID. */
export async function forceStop(directory: string, requestId: string, approvedRunners: Set<string>, inspector: ProcessInspector, checks: NativeFenceChecks): Promise<RecordValue> {
  const request = identifier(requestId), boot = Number(readRecord(join(directory, "runner-launch.json")).attemptedAt), receipt = join(directory, `power-off-${request}.json`);
  if (!Number.isFinite(boot)) throw new ServiceError("Native boot receipt is invalid.", 409);
  let proof: RecordValue;
  if (present(receipt)) {
    proof = readRecord(receipt);
    if (proof.boot !== boot || proof.requestId !== request || !Number.isSafeInteger(proof.pid) || Number(proof.pid) <= 1 || typeof proof.createdAt !== "number" || !Number.isFinite(proof.createdAt) || proof.createdAt <= 0) throw new ServiceError("Power-off receipt belongs to another boot or has no pinned process identity.", 409);
  } else {
    const status = readRecord(join(directory, "status.json")), info = await inspector.get(Number(status.pid));
    if (!info || !validOwnedProcess(info, boot) || !approvedRunners.has(resolve(info.executable)) || JSON.stringify(info.argv.slice(1)) !== JSON.stringify(["run", directory]) || !inspector.terminatePinned) throw new ServiceError("Native process ownership could not be established; power-off refused.", 409);
    let held = false;
    try { await checks.withRuntimeLock(join(directory, "runtime.lock"), async () => {}); } catch (error) { if (error instanceof ServiceError && error.code === "assignment_busy") held = true; else throw error; }
    if (!held) throw new ServiceError("Native runtime lock is not owned.", 409);
    proof = { boot, pid: info.pid, createdAt: info.createdAt, executable: info.executable, requestId: request, requestedAt: Date.now() / 1000 };
    saveRecord(receipt, proof); await inspector.terminatePinned(info);
  }
  if ((await inspector.get(Number(proof.pid)))?.createdAt === proof.createdAt) return { state: "unknown", detail: "Verified native process has not exited; resources remain reserved." };
  try { return await checks.withRuntimeLock(join(directory, "runtime.lock"), async () => {
    if (!await checks.diskClosed(join(directory, "disk.img"))) return { state: "unknown", detail: "Native disk handles remain open." };
    saveRecord(join(directory, "fenced-stop.json"), { ...proof, stoppedAt: Date.now() / 1000, consistency: "crash-consistent" });
    return { state: "stopped", detail: "Explicit power-off confirmed with closed runtime and disk handles." };
  }); } catch (error) { if (error instanceof ServiceError && error.code === "assignment_busy") return { state: "unknown", detail: "Native runtime lock remains owned." }; throw error; }
}

/** PTY creation is supplied by a native backend; pipes are never presented as terminals. */
export interface PtyHandle {
  onData(listener: (bytes: Uint8Array) => void): void;
  onExit(listener: (code: number | null) => void): void;
  write(text: string): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
  close(): Promise<boolean>;
}
export interface PtyBackend { open(argv: readonly string[], env?: NodeJS.ProcessEnv): Promise<PtyHandle> }
interface ShellEntry { handle: PtyHandle; data: Buffer; base: number; seen: number; ended: boolean; exitCode: number | null; closing: boolean }
export class ShellSessions {
  private sessions = new Map<string, ShellEntry>();
  private revoked = new Set<string>();
  private used = new Set<string>();
  constructor(readonly backend: PtyBackend, readonly clock: () => number = () => performance.now() / 1000) {}
  private key(machine: string, session: string): string { return `${identifier(machine)}:${identifier(session)}`; }
  async open(machine: string, session: string, argv: readonly string[], env?: NodeJS.ProcessEnv): Promise<RecordValue> {
    if (this.revoked.has(machine)) throw new ServiceError("Shell assignment is permanently fenced.", 410);
    const key = this.key(machine, session);
    if (this.used.has(key)) throw new ServiceError("Shell identity already used; open a new session.", 409);
    this.used.add(key);
    const handle = await this.backend.open(argv, env), entry: ShellEntry = { handle, data: Buffer.alloc(0), base: 0, seen: this.clock(), ended: false, exitCode: null, closing: false };
    this.sessions.set(key, entry);
    handle.onData(data => { if (entry.closing) return; const next = Buffer.concat([entry.data, data]), excess = Math.max(0, next.length - 65536); entry.base += excess; entry.data = Buffer.from(next.subarray(excess)); });
    handle.onExit(code => { entry.ended = true; entry.exitCode = code; });
    if (this.revoked.has(machine)) { entry.closing = true; await this.terminate(key, entry); throw new ServiceError("Shell authorization ended during creation.", 410); }
    return { session };
  }
  async control(machine: string, action: string, args: RecordValue): Promise<RecordValue> {
    const key = this.key(machine, String(args.session)), entry = this.sessions.get(key);
    if (!entry || entry.closing) throw new ServiceError("Shell closed or runner restarted; open a new session.", 404);
    if (action === "shell-close") { entry.closing = true; if (!await this.terminate(key, entry)) throw unknownOutcome("Shell closure is unconfirmed; its process remains tracked."); return { closed: true }; }
    if (this.revoked.has(machine)) throw new ServiceError("Shell assignment is permanently fenced.", 410);
    entry.seen = this.clock();
    if (action === "shell-write") {
      if (entry.ended || typeof args.text !== "string" || args.text.includes("\0") || Buffer.byteLength(args.text) > 65536) throw new ServiceError("Invalid shell input or exited shell.", 400);
      await entry.handle.write(args.text);
    } else if (action === "shell-resize") {
      for (const key of ["rows", "cols"]) if (!Number.isInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > 500) throw new ServiceError("Invalid terminal dimensions.", 400);
      await entry.handle.resize(Number(args.rows), Number(args.cols));
    } else if (action !== "shell-read") throw new ServiceError("Unsupported shell control.", 400);
    const offset = args.offset ?? entry.base;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new ServiceError("Invalid shell offset.", 400);
    return { data: entry.data.subarray(Math.max(0, Number(offset) - entry.base)).toString("base64"), offset: entry.base + entry.data.length, truncated: Number(offset) < entry.base, exited: entry.ended, exitCode: entry.exitCode };
  }
  private async terminate(key: string, entry: ShellEntry): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const closed = await Promise.race([entry.handle.close(), new Promise<false>(r => { timer = setTimeout(() => r(false), 4000); })]);
      if (closed) this.sessions.delete(key);
      return closed;
    } catch { return false; } finally { if (timer) clearTimeout(timer); }
  }
  async revoke(machines: Set<string>): Promise<boolean> {
    for (const id of machines) this.revoked.add(id);
    const entries = [...this.sessions].filter(([key]) => machines.has(key.split(":")[0]!)); entries.forEach(([, entry]) => { entry.closing = true; });
    const outcomes = await Promise.all(entries.map(([key, entry]) => this.terminate(key, entry))); return outcomes.every(Boolean);
  }
  async sweep(active?: Set<string>): Promise<boolean> {
    const entries = [...this.sessions].filter(([key, entry]) => entry.closing || this.clock() - entry.seen > 600 || active && !active.has(key.split(":")[0]!));
    entries.forEach(([, entry]) => { entry.closing = true; });
    return (await Promise.all(entries.map(([key, entry]) => this.terminate(key, entry)))).every(Boolean);
  }
}

export interface LeaseCleanupOptions {
  state: string; storageRoot: string; machine: RecordValue; folder: string; guard: LeaseGuard; now: number;
  closeSessions(): Promise<void>;
  stop?(): Promise<RecordValue>;
  remove?(requestId: string, preboot?: boolean): Promise<RecordValue>;
  preboot?: boolean;
  inspectHelper?(pid: number): number | null;
}
/** External intent survives assignment credential erasure; only positive proofs complete it. */
export async function cleanupLease(options: LeaseCleanupOptions): Promise<RecordValue> {
  const { machine, folder, guard } = options, id = identifier(machine.id), lease = object(machine.lease), intent = object(machine.leaseCleanup), request = identifier(intent.id);
  if (identifier(intent.leaseId) !== identifier(lease.id) || !["released", "expired", "failed"].includes(String(lease.state)) || machine.desired !== "stopped") throw new ServiceError("Cleanup requires its terminal pinned lease and stopped intent.", 409);
  const fingerprint = assignmentFingerprint(machine), receipt = join(dirname(folder), ".lease-cleanup", `${id}.json`), storage = join(resolve(options.storageRoot), id), quarantine = join(dirname(folder), `.erasing-${id}-${request}`);
  const expected = { id: request, machineId: id, leaseId: lease.id, fingerprint }, lock = new StateLock(`${receipt}.sqlite`);
  try {
    let proof: RecordValue = present(receipt) ? readRecord(receipt) : { ...expected, phase: "planned", attempt: 0 };
    if (Object.entries(expected).some(([k, value]) => proof[k] !== value) || !Number.isSafeInteger(proof.attempt) || Number(proof.attempt) < 0) throw new ServiceError("Cleanup receipt ownership differs.", 409);
    const report = (state: string, reason?: string): RecordValue => ({ state: state === "complete" ? "stopped" : "unknown", leaseFenced: true, leaseCleanup: { id: request, leaseId: lease.id, attempt: Math.max(1, Number(proof.attempt)), state, ...(reason ? { reason } : {}), ...(state === "complete" ? { executionStopped: true, storageRemoved: true, credentialsErased: true } : {}) } });
    if (proof.phase === "complete") return [storage, folder, quarantine].some(present) ? report("blocked", "recovery") : report("complete");
    if (options.now < Number(intent.notBefore ?? 0)) return report("blocked", String(proof.reason ?? "recovery"));
    proof.attempt = Math.max(Number(proof.attempt), Number(intent.attempts ?? 0)) + 1; saveRecord(receipt, proof);
    try {
      for (const path of [folder, storage, quarantine]) noLinks(path);
      await options.closeSessions();
      return await assignmentAccess(machine, folder, async () => {
        if (!helpersClosed(machine, folder, options.inspectHelper)) throw new ServiceError("Owned helpers remain unconfirmed.", 409, { code: "operations_pending" });
        const assignmentOwned = (path: string): boolean => {
          const assignment = readRecord(join(path, "assignment.json"));
          return assignment.fingerprint === fingerprint && assignment.leaseId === lease.id;
        };
        if (proof.phase === "planned" && !present(join(folder, "deletion.json")) && guard.neverStarted(id, String(lease.id))) {
          const root = dirname(storage);
          if (present(root) && readdirSync(root).some(name => name.startsWith(`.removing-${id}-`))) throw new ServiceError("Unexplained storage quarantine.", 409, { code: "recovery" });
          if (present(storage) && (readdirSync(storage).join() !== "canaveral-owner.json" || readRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint)) throw new ServiceError("Unstarted storage ownership differs.", 409, { code: "ownership" });
          if (present(folder) && !assignmentOwned(folder)) throw new ServiceError("Assignment ownership differs.", 409, { code: "ownership" });
          Object.assign(proof, { phase: "unstarted", evidence: "never-started", executionStopped: true, storageExisted: present(storage) }); saveRecord(receipt, proof);
        }
        if (proof.phase === "unstarted") {
          if (present(storage)) {
            if (!proof.storageExisted || readdirSync(storage).some(name => name !== "canaveral-owner.json")) throw new ServiceError("Unstarted storage changed.", 409, { code: "ownership" });
            const marker = join(storage, "canaveral-owner.json");
            if (present(marker)) { if (readRecord(marker).fingerprint !== fingerprint) throw new ServiceError("Storage ownership changed.", 409); unlinkSync(marker); }
            // Recursive removal is deliberately excluded for never-started storage.
            rmdirSync(storage); syncDirectory(dirname(storage));
          }
          proof.phase = present(folder) ? "storageRemoved" : "complete"; saveRecord(receipt, proof);
        }
        if (proof.phase === "planned" && options.preboot && !present(join(folder, "deletion.json")) && prebootStorage(machine, folder, storage)) {
          Object.assign(proof, { phase: "preboot", executionStopped: true, storageExisted: present(storage) }); saveRecord(receipt, proof);
        }
        if (proof.phase === "preboot") {
          if (proof.storageExisted) {
            if (!options.remove) throw new ServiceError("Preboot storage erasure is unavailable.", 409);
            const removed = await options.remove(request, true);
            if (removed.state !== "complete" || removed.id !== request || removed.machineId !== id) throw new ServiceError("Preboot removal receipt differs.", 409);
          } else if (present(storage)) throw new ServiceError("Preboot storage reappeared.", 409);
          proof.phase = "storageRemoved"; saveRecord(receipt, proof);
        }
        if (proof.phase === "planned") {
          if (!options.stop || !options.remove || !present(folder) || !assignmentOwned(folder)) throw new ServiceError("Native cleanup is unavailable.", 409, { code: "capability_unsupported" });
          if (!present(join(folder, "deletion.json"))) {
            if (readRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint) throw new ServiceError("Native storage ownership differs.", 409);
            if ((await options.stop()).state !== "stopped") throw new ServiceError("Native stop is unconfirmed.", 409, { code: "execution_pending" });
          }
          const removed = await options.remove(request);
          if (removed.state !== "complete" || removed.id !== request || removed.machineId !== id) throw new ServiceError("Native removal receipt differs.", 409, { code: "storage_removal" });
          proof.phase = "storageRemoved"; proof.executionStopped = true; saveRecord(receipt, proof);
        }
        if (present(storage)) throw new ServiceError("Storage reappeared during cleanup.", 409);
        if (proof.phase === "storageRemoved") {
          if (!present(folder) || present(quarantine) || !assignmentOwned(folder)) throw new ServiceError("Credential erasure layout differs.", 409, { code: "credential_erasure" });
          proof.phase = "erasing"; saveRecord(receipt, proof);
        }
        if (proof.phase === "erasing") {
          if (present(folder)) { if (present(quarantine) || !assignmentOwned(folder)) throw new ServiceError("Credential quarantine differs.", 409); renameSync(folder, quarantine); syncDirectory(dirname(folder)); }
          if (!present(quarantine) || !assignmentOwned(quarantine)) throw new ServiceError("Credential quarantine is missing or foreign.", 409);
          proof.phase = "removing"; saveRecord(receipt, proof);
        }
        if (proof.phase === "removing") {
          if (present(folder)) throw new ServiceError("Assignment reappeared during erasure.", 409);
          if (present(quarantine)) { noLinks(quarantine); rmSync(quarantine, { recursive: true }); syncDirectory(dirname(folder)); }
          proof.phase = "complete"; delete proof.reason; saveRecord(receipt, proof);
        }
        if (proof.phase !== "complete") throw new ServiceError("Cleanup phase requires inspection.", 409);
        return report("complete");
      }, { exclusive: true });
    } catch (error) {
      const reason = error instanceof ServiceError ? error.code === "assignment_busy" ? "operations_pending" : error.code : "recovery";
      proof.reason = reason; saveRecord(receipt, proof); return report("blocked", reason);
    }
  } finally { lock.close(); }
}

export function recordPreparation(machine: RecordValue, folder: string, neverStarted: boolean): RecordValue {
  const expected = { version: 1, machineId: identifier(machine.id), leaseId: identifier(object(machine.lease).id), fingerprint: assignmentFingerprint(machine) }, path = join(folder, "provisioning.json");
  if (present(path)) {
    const value = readRecord(path);
    if (Object.entries(expected).some(([k, v]) => value[k] !== v) || !["preparing", "unproven", "bootRequested"].includes(String(value.phase))) throw new ServiceError("Provisioning journal belongs to another assignment.", 409);
    return value;
  }
  const owner = readRecord(join(folder, "assignment.json"));
  if (owner.fingerprint !== expected.fingerprint || owner.leaseId !== expected.leaseId) throw new ServiceError("Preparation assignment ownership differs.", 409);
  const value = { ...expected, phase: neverStarted ? "preparing" : "unproven" }; saveRecord(path, value); return value;
}
export function prebootStorage(machine: RecordValue, folder: string, storage: string): boolean {
  const path = join(folder, "provisioning.json"); if (!present(path)) return false;
  const journal = readRecord(path), id = identifier(machine.id), leaseId = identifier(object(machine.lease).id), fingerprint = assignmentFingerprint(machine);
  if (journal.version !== 1 || journal.machineId !== id || journal.leaseId !== leaseId || journal.fingerprint !== fingerprint || !["preparing", "unproven", "bootRequested"].includes(String(journal.phase))) throw new ServiceError("Provisioning journal identity differs.", 409);
  if (journal.phase !== "preparing") return false;
  const owner = readRecord(join(folder, "assignment.json"));
  if (owner.fingerprint !== fingerprint || owner.leaseId !== leaseId) throw new ServiceError("Partial assignment ownership differs.", 409);
  const native = join(storage, id.toUpperCase()); noLinks(storage); noLinks(native);
  if (present(storage) && readRecord(join(storage, "canaveral-owner.json")).fingerprint !== fingerprint) throw new ServiceError("Partial storage ownership differs.", 409);
  if (present(dirname(storage)) && readdirSync(dirname(storage)).some(n => n.startsWith(`.removing-${id}-`))) throw new ServiceError("Unexplained removal quarantine blocks preboot cleanup.", 409);
  for (const name of ["runner-launch.json", "status.json", "lease-authorization.json", "lease-fenced.json", "fenced-stop.json", "runner.log"]) if (present(join(native, name))) throw new ServiceError("Partial storage has possible execution evidence.", 409);
  if (present(join(folder, "apple-boot-request.json"))) throw new ServiceError("Durable native boot request blocks preboot cleanup.", 409);
  if (present(join(native, "machine.json")) && String(readRecord(join(native, "machine.json")).executionLeaseID).toLowerCase() !== leaseId) throw new ServiceError("Partial native metadata belongs to another lease.", 409);
  return true;
}
