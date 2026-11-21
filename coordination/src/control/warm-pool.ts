/** Warm pool for leased mobile devices.
 *
 * A warm device is an ordinary machine row that the pool creates on one host, so every capacity
 * ledger already counts its CPU, memory and disk exactly once. It has no owner, no lease and no
 * consumer. A lease takes it over by becoming the owner of that same row; nothing is released and
 * nothing is reserved again. A warm device the pool gives up is destroyed through the machine
 * deletion receipt, which releases its reservation only on the host's stop and removal proof.
 *
 * Only Android lease images are served. The table shapes carry no Android assumption, so another
 * device provider can join by advertising a warm pool in its offer.
 *
 * Implementation limit: fixture coverage only. No real emulator has been pre-booted or adopted. */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import { physicalBudget, physicalMapping } from "../physical-domains.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlRequest, ControlResponse } from "./contracts.ts";
import { healthReady } from "./infrastructure.ts";
import { isDeleted } from "./lifecycle.ts";
import { hostAdmissionClosed } from "./maintenance.ts";
import { machineDigest, machineLeaseEligible, placementSize, validateMachineRequest } from "./machines.ts";
import type { MachineStore, Resources } from "./machines.ts";
import { baselineUsable } from "./pool-ledger.ts";

type Json = Record<string, any>;
const KEYS = ["cpu", "memoryMiB", "diskGiB"] as const;
/** A booting warm device that is not checked and ready within this time is given up. */
export const WARM_BOOT_TIMEOUT_SECONDS = 300;
/** A warm device stops being offered, and is recycled, this long before its hold's deadline, so an
 * adoption never races the native supervisor's own expiry of the hold. */
export const WARM_HANDOVER_MARGIN_SECONDS = 20;
/** A ready warm device that its host has not reported running and checked for this long is given
 * up. It is the bound on how long a hung emulator can sit in the pool as if it were usable. */
export const WARM_UNREADY_SECONDS = 60;
/** A waiting request counts on a booting warm device of its own image for at most this long after
 * the device was created; after that it takes the device's capacity like any other. */
export const WARM_SERVE_BOOT_SECONDS = 90;
const BACKOFF_BASE_SECONDS = 15, BACKOFF_MAX_SECONDS = 600, HOST_LEASE_SECONDS = 30;
const LIVE = ["booting", "ready"];
/** What the pool needs to know from the modules that own admission. */
export interface WarmPoolHooks {
  /** Whether the application's own limits would still admit a device lease of this size. */
  withinLimits(db: DatabaseSync, applicationId: string, need: Resources): boolean;
  /** For a waiting request that is not a device lease: what it would reserve, and the runner domains
   * that could serve it right now if they had the capacity. Undefined when nothing could. */
  runnerDemand(db: DatabaseSync, request: { kind: string; application: string; intent: Json }): { need: Resources; domains: string[] } | undefined;
}

interface WarmRow {
  machine: string; hold: string; host: string; template_id: string; revision: string; arch: string; state: string; reason: string | null;
  created: number; expires: number; ready_at: number | null; lease: string | null; origin: string | null; claimed_at: number | null; deletion: string | null; updated: number;
  unready_since: number | null;
}
interface TargetRow { host: string; template_id: string; revision: string; arch: string; count: number; max_age: number; updated: number; actor: string }

export function initializeWarmPool(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS warm_targets (host TEXT NOT NULL,template_id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,count INTEGER NOT NULL,max_age INTEGER NOT NULL,updated REAL NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(host,template_id,revision,arch));
    CREATE TABLE IF NOT EXISTS warm_headroom (host TEXT PRIMARY KEY,resources TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS warm_devices (machine TEXT PRIMARY KEY,hold TEXT NOT NULL UNIQUE,host TEXT NOT NULL,template_id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,
      created REAL NOT NULL,expires REAL NOT NULL,ready_at REAL,lease TEXT UNIQUE,origin TEXT,claimed_at REAL,deletion TEXT,updated REAL NOT NULL,unready_since REAL);
    CREATE INDEX IF NOT EXISTS warm_devices_live ON warm_devices(host,state);
    CREATE TABLE IF NOT EXISTS warm_backoff (host TEXT NOT NULL,template_id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,failures INTEGER NOT NULL,next_attempt REAL NOT NULL,last_error TEXT,last_error_at REAL,proven INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(host,template_id,revision,arch));`);
  if (!db.prepare("PRAGMA table_info(warm_devices)").all().some(column => column.name === "unready_since"))
    db.exec("ALTER TABLE warm_devices ADD COLUMN unready_since REAL");
  if (!db.prepare("PRAGMA table_info(warm_backoff)").all().some(column => column.name === "proven"))
    db.exec("ALTER TABLE warm_backoff ADD COLUMN proven INTEGER NOT NULL DEFAULT 0");
}
function table(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function size(db: DatabaseSync, machineId: string): Resources { return JSON.parse(String(db.prepare("SELECT request FROM machines WHERE id=?").get(machineId)!.request)).resources as Resources; }
const none = (): Resources => ({ cpu: 0, memoryMiB: 0, diskGiB: 0 });
const sum = (a: Resources, b: Resources, sign = 1): Resources => ({ cpu: a.cpu + sign * b.cpu, memoryMiB: a.memoryMiB + sign * b.memoryMiB, diskGiB: a.diskGiB + sign * b.diskGiB });
/** Booted, checked and outside the hand-over margin: a lease could take it right now. */
function adoptable(db: DatabaseSync, row: WarmRow, now: number): boolean {
  if (row.state !== "ready" || row.expires - now <= WARM_HANDOVER_MARGIN_SECONDS) return false;
  const machine = db.prepare("SELECT observed,access_ready FROM machines WHERE id=?").get(row.machine);
  return machine?.observed === "running" && !!machine.access_ready;
}
function offerOf(host: Json): Json | undefined { try { return object(JSON.parse(String(host.offer))); } catch { return undefined; } }
/** Online, accepting, healthy and not draining: the same gate as lease placement. */
function hostReady(db: DatabaseSync, host: Json, now: number): boolean {
  return !!host.enabled && now - Number(host.seen) < HOST_LEASE_SECONDS && !hostAdmissionClosed(db, String(host.id)).closed && healthReady(db, String(host.id), now) &&
    !(table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(String(host.id)));
}
function template(db: DatabaseSync, id: string, revision: string, arch: string): Json | undefined {
  const row = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(id, revision, arch);
  return row ? JSON.parse(String(row.definition)) as Json : undefined;
}
/** A warm device is given up through the machine deletion receipt: its reservation is released
 * only when the host reports the emulator proven stopped and its storage removed. */
function retire(db: DatabaseSync, row: WarmRow, reason: string, now: number): void {
  const deletion = randomUUID();
  db.prepare("INSERT INTO machine_deletions (id,machine,state,created) VALUES (?,?,'queued',?)").run(deletion, row.machine, now);
  db.prepare("UPDATE machines SET desired='stopped',access_ready=0 WHERE id=?").run(row.machine);
  db.prepare("UPDATE warm_devices SET state='retiring',reason=?,deletion=?,updated=? WHERE machine=?").run(reason, deletion, now, row.machine);
}
function failed(db: DatabaseSync, row: WarmRow, detail: string, now: number, counted: boolean): void {
  const error = [...detail].slice(0, 500).join("") || "The warm device did not become ready.";
  db.prepare(`INSERT INTO warm_backoff (host,template_id,revision,arch,failures,next_attempt,last_error,last_error_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(host,template_id,revision,arch) DO UPDATE SET failures=failures+excluded.failures,last_error=excluded.last_error,last_error_at=excluded.last_error_at`)
    .run(row.host, row.template_id, row.revision, row.arch, counted ? 1 : 0, 0, error, now);
  if (counted) {
    // A failed boot withdraws the image's proof on this host: the next devices come one at a time again.
    db.prepare("UPDATE warm_backoff SET proven=0 WHERE host=? AND template_id=? AND revision=? AND arch=?").run(row.host, row.template_id, row.revision, row.arch);
    // Consecutive failed boots wait 15 s, 30 s, 60 s and so on, to at most 10 minutes.
    const failures = Number(db.prepare("SELECT failures FROM warm_backoff WHERE host=? AND template_id=? AND revision=? AND arch=?").get(row.host, row.template_id, row.revision, row.arch)!.failures);
    db.prepare("UPDATE warm_backoff SET next_attempt=? WHERE host=? AND template_id=? AND revision=? AND arch=?").run(now + Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.min(failures - 1, 10)), row.host, row.template_id, row.revision, row.arch);
  }
}

/** State transitions from host observations. Safe in any transaction, including the heartbeat's. */
export function settleWarmDevices(db: DatabaseSync, now: number): void {
  if (!table(db, "warm_devices")) return;
  for (const row of db.prepare("SELECT * FROM warm_devices WHERE state NOT IN ('removed','adopted')").all() as unknown as WarmRow[]) {
    if (row.state === "retiring") {
      if (isDeleted(db, row.machine)) db.prepare("UPDATE warm_devices SET state='removed',updated=? WHERE machine=?").run(now, row.machine);
      continue;
    }
    // A claimed device is its lease's from here on; the lease's own cleanup removes it, also when
    // the lease ended before the host ever adopted the device.
    if (row.state === "adopting") {
      if (isDeleted(db, row.machine)) db.prepare("UPDATE warm_devices SET state='removed',updated=? WHERE machine=?").run(now, row.machine);
      continue;
    }
    const machine = db.prepare("SELECT observed,access_ready,detail FROM machines WHERE id=?").get(row.machine)!;
    const ready = machine.observed === "running" && !!machine.access_ready, ended = machine.observed === "error" || machine.observed === "stopped";
    if (row.state === "booting") {
      if (ready) {
        db.prepare("UPDATE warm_devices SET state='ready',ready_at=?,updated=? WHERE machine=?").run(now, now, row.machine);
        // One device of this image booted and passed its checks here: the image is proven on this host.
        db.prepare(`INSERT INTO warm_backoff (host,template_id,revision,arch,failures,next_attempt,proven) VALUES (?,?,?,?,0,0,1)
          ON CONFLICT(host,template_id,revision,arch) DO UPDATE SET failures=0,next_attempt=0,proven=1`).run(row.host, row.template_id, row.revision, row.arch);
      } else if (ended || now - row.created >= WARM_BOOT_TIMEOUT_SECONDS) {
        failed(db, row, ended ? String(machine.detail) || "The warm device stopped while booting." : "The warm device was not ready within its boot timeout.", now, true);
        retire(db, row, "boot_failed", now);
      }
    } else if (row.state === "ready") {
      // A ready device that stopped is replaced, not counted as a failed boot.
      if (ended) { failed(db, row, String(machine.detail) || "The warm device stopped.", now, false); retire(db, row, "stopped", now); }
      else if (now >= row.expires - WARM_HANDOVER_MARGIN_SECONDS) retire(db, row, "age", now);
      // A device that its host no longer reports running and checked (a hung emulator answers no
      // readiness check) cannot be adopted. It is given up after a bounded time, not at its age.
      else if (ready) { if (row.unready_since !== null) db.prepare("UPDATE warm_devices SET unready_since=NULL WHERE machine=?").run(row.machine); }
      else if (row.unready_since === null) db.prepare("UPDATE warm_devices SET unready_since=? WHERE machine=?").run(now, row.machine);
      else if (now - row.unready_since >= WARM_UNREADY_SECONDS) {
        failed(db, row, `The warm device was not running and checked for ${WARM_UNREADY_SECONDS} seconds${machine.detail ? `: ${String(machine.detail)}` : "."}`, now, false);
        retire(db, row, "unready", now);
      }
    }
  }
}
/** The warm marker on a pool device's assignment. The host needs the hold for the device's whole
 * life, including after a lease took it over, because its storage stays bound to that hold. */
export function warmAssignment<T extends { id: string }>(db: DatabaseSync, machine: T, forHost: boolean, now: number): T & { warm?: Json } {
  if (!table(db, "warm_devices")) return machine;
  const row = db.prepare("SELECT hold,state,expires FROM warm_devices WHERE machine=?").get(machine.id);
  if (!row) return machine;
  return { ...machine, warm: forHost ? { id: row.hold, state: row.state, authorizationDeadline: row.expires, controllerNow: now } : { state: row.state } };
}
/** Whether a lease member came from the warm pool. Undefined until the host has proven which. */
export function memberSource(db: DatabaseSync, machineId: string): "warm" | "cold" | undefined {
  if (!table(db, "warm_devices")) return "cold";
  const row = db.prepare("SELECT origin FROM warm_devices WHERE machine=?").get(machineId);
  if (!row) return "cold";
  return row.origin === "warm" || row.origin === "cold" ? row.origin : undefined;
}
/** Hands one ready warm device to one lease, in the caller's admission transaction. The caller
 * inserts the lease member row; `lease_members.machine` is unique, so no device has two leases.
 * The device is no longer ready until its host proves that it adopted it for this lease. */
export function claimWarmDevice(db: DatabaseSync, leaseId: string, image: Json, wanted: Resources, now: number): string | undefined {
  if (!table(db, "warm_devices")) return undefined;
  const rows = db.prepare(`SELECT w.*,m.request,m.template,m.observed,m.access_ready,h.offer,h.seen,h.enabled,h.id AS host_id FROM warm_devices w JOIN machines m ON m.id=w.machine JOIN hosts h ON h.id=w.host
    WHERE w.state='ready' AND w.template_id=? AND w.revision=? AND w.arch=? ORDER BY w.ready_at,w.machine`).all(String(image.id), String(image.revision), String(image.arch));
  for (const row of rows) {
    if (Number(row.expires) - now <= WARM_HANDOVER_MARGIN_SECONDS || row.observed !== "running" || !row.access_ready) continue;
    // Exactly the pinned definition and exactly the requested size; anything else is a cold boot.
    if (machineDigest(JSON.parse(String(row.template))) !== machineDigest(image) || !KEYS.every(key => JSON.parse(String(row.request)).resources[key] === wanted[key])) continue;
    const offer = offerOf(row);
    if (!offer || !machineLeaseEligible(offer, image) || !hostReady(db, { id: row.host_id, enabled: row.enabled, seen: row.seen }, now) || !baselineUsable(db, String(row.host_id), image, wanted.diskGiB)) continue;
    db.prepare("UPDATE warm_devices SET state='adopting',lease=?,claimed_at=?,updated=? WHERE machine=? AND state='ready'").run(leaseId, now, now, String(row.machine));
    db.prepare("UPDATE machines SET observed='starting',access_ready=0,detail='',updated=? WHERE id=?").run(now, String(row.machine));
    return String(row.machine);
  }
  return undefined;
}
/** Every report of a pool device names the binding it describes. Returns false for a report that
 * must be ignored: readiness that names another binding than the controller's current one. */
export function warmReport(db: DatabaseSync, machineId: string, report: Json, now: number): boolean {
  if (!table(db, "warm_devices")) return true;
  const row = db.prepare("SELECT * FROM warm_devices WHERE machine=?").get(machineId) as unknown as WarmRow | undefined;
  if (!row) return true;
  let marker: Json | undefined;
  if (report.warm != null) {
    marker = object(report.warm);
    if (Object.keys(marker).some(key => !["id", "lease", "origin"].includes(key)) || identifier(marker.id) !== marker.id || (marker.lease !== undefined && identifier(marker.lease) !== marker.lease) ||
      (marker.origin !== undefined && marker.origin !== "warm" && marker.origin !== "cold")) throw new ServiceError("Invalid warm device receipt.", 400);
  }
  const ready = report.state === "running" && report.accessReady === true;
  if (LIVE.includes(row.state)) {
    // A warm device is ready only by its own warm-phase report.
    return !ready || (marker?.id === row.hold && marker.lease === undefined);
  }
  if (row.state === "adopting") {
    const current = marker?.id === row.hold && marker.lease === row.lease;
    // An observation of the earlier warm binding says nothing about the lease's device. A fence or
    // cleanup receipt is about the lease itself and is always processed.
    if (!current) return report.leaseFenced === true || report.leaseCleanup != null;
    if (ready) {
      // Only a proven origin completes the hand-over: the adopted warm device, or a fresh cold boot.
      if (marker!.origin === undefined) return false;
      db.prepare("UPDATE warm_devices SET state='adopted',origin=?,updated=? WHERE machine=?").run(String(marker!.origin), now, machineId);
    }
  }
  return true;
}

export class WarmPool implements ControlModule {
  constructor(readonly store: SqliteStore, readonly machines: MachineStore, private readonly hooks: WarmPoolHooks) { store.transaction(initializeWarmPool); }
  /** Timer and post-request entry. A busy database or an unexpected failure must not take the worker down. */
  wake(): boolean {
    try {
      // No targets and nothing live needs no write boundary.
      const probe = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
      let work: boolean;
      try { work = !!probe.prepare("SELECT 1 FROM warm_targets WHERE count>0 LIMIT 1").get() || !!probe.prepare("SELECT 1 FROM warm_devices WHERE state IN ('booting','ready','adopting','retiring') LIMIT 1").get(); }
      finally { probe.close(); }
      if (work) this.store.transaction(db => this.reconcile(db, this.store.clock()));
      return true;
    } catch { return false; }
  }
  /** Settle observations, give up what is no longer wanted or is contended, then refill. Refilling
   * runs last and only here, after the admission pass, so a waiting request always goes first. */
  reconcile(db: DatabaseSync, now: number): void {
    settleWarmDevices(db, now);
    this.trim(db, now);
    const pressured = this.contention(db, now);
    this.replenish(db, now, pressured);
  }
  private live(db: DatabaseSync, host: string): WarmRow[] {
    return db.prepare("SELECT * FROM warm_devices WHERE host=? AND state IN ('booting','ready') ORDER BY created,machine").all(host) as unknown as WarmRow[];
  }
  /** Give up warm devices their host no longer wants: a drain, a withdrawn image or pool, or a lower target. */
  private trim(db: DatabaseSync, now: number): void {
    for (const entry of db.prepare("SELECT DISTINCT host FROM warm_devices WHERE state IN ('booting','ready')").all()) {
      const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(String(entry.host)), offer = host ? offerOf(host) : undefined, rows = this.live(db, String(entry.host));
      // A draining or disabled host keeps no warm devices; they would only block its maintenance.
      if (!host || !offer?.warmPool || !host.enabled || hostAdmissionClosed(db, String(entry.host)).closed) { for (const row of rows) retire(db, row, "host", now); continue; }
      const groups = new Map<string, WarmRow[]>();
      for (const row of rows) { const key = JSON.stringify([row.template_id, row.revision, row.arch]); groups.set(key, [...(groups.get(key) ?? []), row]); }
      for (const group of groups.values()) {
        const first = group[0]!, image = template(db, first.template_id, first.revision, first.arch);
        const target = db.prepare("SELECT count FROM warm_targets WHERE host=? AND template_id=? AND revision=? AND arch=?").get(first.host, first.template_id, first.revision, first.arch);
        if (!image || !machineLeaseEligible(offer, image)) { for (const row of group) retire(db, row, "ineligible", now); continue; }
        // Over target: booting devices go first (newest first), then the oldest ready ones.
        const order = [...group.filter(row => row.state === "booting").reverse(), ...group.filter(row => row.state === "ready")];
        for (const row of order.slice(0, Math.max(0, group.length - Number(target?.count ?? 0)))) retire(db, row, "target", now);
      }
    }
  }
  /** What one waiting request would need for admission, and where. `fits` answers with the hosts
   * that would take it if each had `spare` more unreserved capacity, by the owning module's own
   * placement rule. Undefined when no capacity the pool holds could ever admit the request. */
  private probe(db: DatabaseSync, request: Json, now: number): { need: Resources; own?: (spoken: Set<string>) => WarmRow | undefined; fits(spare: (host: string) => Resources): string[] } | undefined {
    const intent = JSON.parse(String(request.intent)) as Json;
    if (request.kind !== "lease") {
      // A runner-domain request shares a host's budget only through an explicit physical mapping.
      const demand = this.hooks.runnerDemand(db, { kind: String(request.kind), application: String(request.application), intent });
      const mapped = (demand?.domains ?? []).flatMap(domain => { const host = physicalMapping(db, { domainId: domain })?.hostId; return host ? [{ domain, host }] : []; });
      if (!demand || !mapped.length) return undefined;
      return { need: demand.need, fits: spare => mapped.filter(({ domain, host }) => {
        // The mapped budget is the smaller of the host's and the domain's capacity. It is compared
        // unclamped: on a budget that is already overcommitted, a freed device may admit nothing.
        const budget = physicalBudget(db, { domainId: domain }), extra = spare(host);
        return !!budget && KEYS.every(key => demand.need[key] <= budget.capacity[key] - budget.reserved[key] + extra[key]);
      }).map(entry => entry.host) };
    }
    const image = template(db, String(intent.templateId), String(intent.templateRevision), String(intent.arch));
    // The same size rule as admission: a request below the image's minimum or off its memory step
    // has no placement anywhere, whatever the pool gives up.
    const need = image ? placementSize(image, intent.resources ?? {}) : undefined;
    if (!image || !need || !this.hooks.withinLimits(db, String(request.application), need)) return undefined;
    let wanted: Json;
    try { wanted = validateMachineRequest({ id: randomUUID(), name: "placement", templateId: intent.templateId, templateRevision: intent.templateRevision, arch: intent.arch, resources: intent.resources ?? {} }); }
    catch { return undefined; }
    return { need,
      // A warm device of the request's own image and size will serve it: one a lease could take
      // now, or one that is still within its usual boot time.
      own: spoken => (db.prepare("SELECT w.* FROM warm_devices w WHERE w.state IN ('booting','ready') AND w.template_id=? AND w.revision=? AND w.arch=? ORDER BY w.created,w.machine").all(String(image.id), String(image.revision), String(image.arch)) as unknown as WarmRow[])
        .find(row => {
          if (spoken.has(row.machine) || !(adoptable(db, row, now) || row.state === "booting" && now - row.created < WARM_SERVE_BOOT_SECONDS) || !KEYS.every(key => size(db, row.machine)[key] === need[key])) return false;
          const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(row.host), offer = host ? offerOf(host) : undefined;
          return !!host && !!offer && hostReady(db, host, now) && machineLeaseEligible(offer, image) && baselineUsable(db, row.host, image, need.diskGiB);
        }),
      fits: spare => this.machines.placements(db, wanted, true, true, null, spare).map(candidate => String(candidate.host.id)) };
  }
  /** A waiting request that capacity refused wins over warm devices, but only where giving them up
   * would actually admit it. Each request is tested with the placement rule its own admission uses.
   * If it fits once devices already being removed are gone, nothing more is given up. Otherwise the
   * fewest warm devices that make it fit on one host are given up: unresponsive ones first, then
   * booting ones, then the oldest ready ones. A request that no capacity of the pool could admit
   * (an invalid size, an application limit, capacity held by other work) changes nothing.
   * Returns the hosts that must not be refilled ahead of a request they are about to take. */
  private contention(db: DatabaseSync, now: number): Set<string> {
    const pressured = new Set<string>();
    if (!table(db, "requests")) return pressured;
    const waiting = db.prepare("SELECT application,kind,intent FROM requests WHERE state='waiting' AND reason='capacity_unavailable' AND (deadline IS NULL OR deadline>?) ORDER BY sequence LIMIT 64").all(now);
    if (!waiting.length) return pressured;
    // Capacity already promised to an earlier waiting request in this pass, and warm devices already counted for one.
    const promised = new Map<string, Resources>(), spoken = new Set<string>();
    /** Not free yet, but on its way without giving anything more up: devices already being removed, less what is promised. */
    const pending = (host: string): Resources => (db.prepare("SELECT machine FROM warm_devices WHERE host=? AND state='retiring'").all(host))
      .reduce<Resources>((total, row) => sum(total, size(db, String(row.machine))), sum(none(), promised.get(host) ?? none(), -1));
    const givable = (host: string): WarmRow[] => {
      const rows = this.live(db, host).filter(row => !spoken.has(row.machine));
      const unready = rows.filter(row => row.state === "ready" && !adoptable(db, row, now));
      return [...unready, ...rows.filter(row => row.state === "booting").reverse(), ...rows.filter(row => row.state === "ready" && !unready.includes(row))];
    };
    const promise = (host: string, need: Resources): void => { pressured.add(host); promised.set(host, sum(promised.get(host) ?? none(), need)); };
    for (const request of waiting) {
      // One request's evaluation is its own savepoint: if it cannot be evaluated, it changes nothing
      // and neither stops the pool nor the requests behind it.
      try {
        this.store.transaction(() => {
          const probe = this.probe(db, request, now);
          if (!probe) return;
          const own = probe.own?.(spoken);
          if (own) { spoken.add(own.machine); return; }
          const already = probe.fits(pending)[0];
          if (already) { promise(already, probe.need); return; }
          const host = probe.fits(candidate => givable(candidate).reduce((total, row) => sum(total, size(db, row.machine)), pending(candidate)))[0];
          if (!host) return; // Nothing the pool holds stands between this request and its admission.
          const chosen: WarmRow[] = [];
          let freed = none();
          for (const row of givable(host)) {
            chosen.push(row); freed = sum(freed, size(db, row.machine));
            const offered = freed;
            if (probe.fits(candidate => candidate === host ? sum(pending(candidate), offered) : pending(candidate)).includes(host)) break;
          }
          for (const row of chosen) retire(db, row, "contention", now);
          promise(host, probe.need);
        });
      } catch { /* This request is skipped in this pass. */ }
    }
    return pressured;
  }
  /** A given-up device of this image that is not yet proven removed. While there is one, the image's
   * pool on that host creates nothing: an unconfirmed failure is never multiplied. */
  private unproven(db: DatabaseSync, host: string, templateId: string, revision: string, arch: string): Json | undefined {
    return db.prepare(`SELECT w.machine,w.updated,w.reason,d.state AS removal FROM warm_devices w LEFT JOIN machine_deletions d ON d.id=w.deletion
      WHERE w.host=? AND w.template_id=? AND w.revision=? AND w.arch=? AND w.state='retiring' ORDER BY w.updated,w.machine LIMIT 1`).get(host, templateId, revision, arch);
  }
  private replenish(db: DatabaseSync, now: number, pressured: Set<string>): void {
    for (const target of db.prepare("SELECT * FROM warm_targets WHERE count>0 ORDER BY host,template_id,revision,arch").all() as unknown as TargetRow[]) {
      if (pressured.has(target.host)) continue;
      const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(target.host), offer = host ? offerOf(host) : undefined, image = template(db, target.template_id, target.revision, target.arch);
      const need = image ? placementSize(image, {}) : undefined;
      if (!host || !offer?.warmPool || !image || !need || !hostReady(db, host, now) || !machineLeaseEligible(offer, image) || !baselineUsable(db, target.host, image, need.diskGiB)) continue;
      if (this.unproven(db, target.host, target.template_id, target.revision, target.arch)) continue;
      const backoff = db.prepare("SELECT next_attempt,proven FROM warm_backoff WHERE host=? AND template_id=? AND revision=? AND arch=?").get(target.host, target.template_id, target.revision, target.arch);
      if (backoff && now < Number(backoff.next_attempt)) continue;
      const headroom = this.headroom(db, target.host);
      // The host's own device limit counts every pool device that still runs or may run there.
      const count = (states: string, where = ""): number => Number(db.prepare(`SELECT count(*) AS n FROM warm_devices WHERE host=? AND state IN (${states})${where}`).get(target.host, ...(where ? [target.template_id, target.revision, target.arch] : []))!.n);
      let held = count("'booting','ready','retiring'"), mine = count("'booting','ready'", " AND template_id=? AND revision=? AND arch=?"), booting = count("'booting'", " AND template_id=? AND revision=? AND arch=?");
      while (mine < target.count && held < Number(offer.warmPool.maxDevices)) {
        // Until one device of this image has booted and passed its checks on this host, and again
        // after any failed boot, devices are created one at a time. A broken image or SDK then
        // costs one slot, not every slot of the target at once.
        if (!backoff?.proven && booting >= 1) break;
        const free = this.machines.remainingCapacity(db, target.host);
        // The pool never spends the operator's headroom and never more than the ledger has free.
        if (!KEYS.every(key => need[key] + headroom[key] <= free[key])) break;
        const machine = randomUUID();
        try { this.machines.createMachine(db, { id: machine, name: `warm-${machine.slice(0, 8)}`, templateId: target.template_id, templateRevision: target.revision, arch: target.arch, hostId: target.host }, true); }
        catch (error) { if (error instanceof ServiceError) break; throw error; }
        // The hold's deadline is fixed here and never extended; the host's supervisor enforces it.
        db.prepare("INSERT INTO warm_devices (machine,hold,host,template_id,revision,arch,state,created,expires,updated) VALUES (?,?,?,?,?,?,'booting',?,?,?)")
          .run(machine, randomUUID(), target.host, target.template_id, target.revision, target.arch, now, now + Math.min(target.max_age, Number(offer.warmPool.maxAgeSeconds)), now);
        mine++; held++; booting++;
      }
    }
  }
  private headroom(db: DatabaseSync, host: string): Resources {
    const row = db.prepare("SELECT resources FROM warm_headroom WHERE host=?").get(host);
    return row ? JSON.parse(String(row.resources)) as Resources : { cpu: 0, memoryMiB: 0, diskGiB: 0 };
  }
  private view(db: DatabaseSync, host: Json, now: number): Json {
    const id = String(host.id), offer = offerOf(host);
    const targets = (db.prepare("SELECT * FROM warm_targets WHERE host=? ORDER BY template_id,revision,arch").all(id) as unknown as TargetRow[]).map(target => {
      const count = (state: string): number => Number(db.prepare("SELECT count(*) AS n FROM warm_devices WHERE host=? AND template_id=? AND revision=? AND arch=? AND state=?").get(id, target.template_id, target.revision, target.arch, state)!.n);
      const backoff = db.prepare("SELECT * FROM warm_backoff WHERE host=? AND template_id=? AND revision=? AND arch=?").get(id, target.template_id, target.revision, target.arch);
      // Why the pool creates nothing for this image here, when it does not: a given-up device is not
      // yet proven removed (an operator must inspect one whose removal stays blocked), or the host
      // does not usably store the baseline the image names.
      const stuck = this.unproven(db, id, target.template_id, target.revision, target.arch), image = template(db, target.template_id, target.revision, target.arch), need = image ? placementSize(image, {}) : undefined;
      const paused = stuck ? { reason: "removal_unproven", machineId: stuck.machine, since: stuck.updated, givenUpFor: stuck.reason, removal: stuck.removal ?? "queued" }
        : image?.baseline && (!need || !baselineUsable(db, id, image, need.diskGiB)) ? { reason: "baseline_unavailable" } : null;
      return { templateId: target.template_id, templateRevision: target.revision, arch: target.arch, count: target.count, maxAgeSeconds: target.max_age, ready: count("ready"), booting: count("booting"), retiring: count("retiring"), paused,
        failed: Number(backoff?.failures ?? 0), proven: !!backoff?.proven, nextAttemptAt: backoff && Number(backoff.next_attempt) > now ? Number(backoff.next_attempt) : null,
        lastError: backoff?.last_error ?? null, lastErrorAt: backoff?.last_error_at ?? null };
    });
    const devices = (db.prepare("SELECT * FROM warm_devices WHERE host=? AND state IN ('booting','ready','adopting','retiring') ORDER BY created,machine").all(id) as unknown as WarmRow[]).map(row => ({
      machineId: row.machine, templateId: row.template_id, templateRevision: row.revision, arch: row.arch, state: row.state, reason: row.reason, createdAt: row.created, readyAt: row.ready_at, expiresAt: row.expires,
      // Since when a ready device has not been reported running and checked; it is not offered meanwhile.
      unreadySince: row.state === "ready" ? row.unready_since : null,
      ...(row.lease ? { leaseId: row.lease } : {}) }));
    return { hostId: id, name: offer?.name ?? null, online: now - Number(host.seen) < HOST_LEASE_SECONDS, enabled: !!offer?.warmPool, limits: offer?.warmPool ?? null, headroom: this.headroom(db, id), targets, devices };
  }
  private configure(db: DatabaseSync, hostId: string, body: Json, actor: string, now: number): Json {
    const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId), offer = host ? offerOf(host) : undefined;
    if (!host || !offer) throw new ServiceError("Unknown host.", 404);
    if (Object.keys(body).some(key => !["targets", "headroom"].includes(key)) || !Array.isArray(body.targets) || body.targets.length > 100) throw new ServiceError("Supply the host's complete warm targets and an optional headroom.", 400);
    const pool = offer.warmPool as Json | undefined;
    if (!pool && body.targets.length) throw new ServiceError("This host's operator has not enabled warm devices.", 409, { code: "warm_pool_disabled" });
    const whole = (value: unknown, label: string, minimum: number, maximum: number): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ServiceError(`Invalid ${label}.`, 400);
      return value;
    };
    const seen = new Set<string>();
    const targets = (body.targets as unknown[]).map(value => {
      const entry = object(value);
      if (Object.keys(entry).some(key => !["templateId", "templateRevision", "arch", "count", "maxAgeSeconds"].includes(key)) || [entry.templateId, entry.templateRevision, entry.arch].some(part => typeof part !== "string" || !part)) throw new ServiceError("A warm target names a template, revision and architecture.", 400);
      const key = JSON.stringify([entry.templateId, entry.templateRevision, entry.arch]);
      if (seen.has(key)) throw new ServiceError("Each lease image has at most one warm target per host.", 400);
      seen.add(key);
      const image = (offer.templates as Json[]).find(item => item.id === entry.templateId && item.revision === entry.templateRevision && item.arch === entry.arch);
      // Only an image this host explicitly advertises for leases can be kept warm.
      if (!image || !machineLeaseEligible(offer, image)) throw new ServiceError("A warm target must be a lease image this host advertises.", 409, { code: "warm_target_ineligible" });
      return { templateId: String(entry.templateId), templateRevision: String(entry.templateRevision), arch: String(entry.arch), count: whole(entry.count, "warm target count", 0, Number(pool!.maxDevices)),
        maxAgeSeconds: whole(entry.maxAgeSeconds ?? pool!.maxAgeSeconds, "warm maximum age", 60, Number(pool!.maxAgeSeconds)) };
    });
    if (pool && targets.reduce((total, target) => total + target.count, 0) > Number(pool.maxDevices)) throw new ServiceError("Warm targets exceed this host's warm device limit.", 409, { code: "warm_target_limit" });
    db.prepare("DELETE FROM warm_targets WHERE host=?").run(hostId);
    for (const target of targets) db.prepare("INSERT INTO warm_targets VALUES (?,?,?,?,?,?,?,?)").run(hostId, target.templateId, target.templateRevision, target.arch, target.count, target.maxAgeSeconds, now, actor);
    if (body.headroom !== undefined) {
      const input = object(body.headroom);
      if (Object.keys(input).sort().join() !== "cpu,diskGiB,memoryMiB") throw new ServiceError("Headroom takes cpu, memoryMiB and diskGiB.", 400);
      const headroom = Object.fromEntries(KEYS.map(key => [key, whole(input[key], "warm headroom", 0, 1_048_576)]));
      db.prepare("INSERT INTO warm_headroom VALUES (?,?) ON CONFLICT(host) DO UPDATE SET resources=excluded.resources").run(hostId, JSON.stringify(headroom));
    }
    this.reconcile(db, now);
    return this.view(db, db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId)!, now);
  }
  handle(req: ControlRequest): ControlResponse | undefined {
    const all = req.path === "/v1/warm-pool" && req.method === "GET";
    const one = req.parts.length === 4 && req.parts[0] === "v1" && req.parts[1] === "hosts" && req.parts[3] === "warm-pool" && (req.method === "GET" || req.method === "POST");
    if (!all && !one) return undefined;
    return this.store.transaction(db => {
      // Targets, device identities and failure detail are infrastructure inventory: administrators only.
      const principal = requireAdmin(req), now = this.store.clock();
      if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
      settleWarmDevices(db, now);
      if (all) return { body: { hosts: db.prepare("SELECT * FROM hosts WHERE id IN (SELECT host FROM warm_targets UNION SELECT host FROM warm_devices WHERE state IN ('booting','ready','adopting','retiring')) OR offer LIKE '%\"warmPool\"%' ORDER BY id").all()
        .filter(host => !(table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(String(host.id)))).map(host => this.view(db, host, now)) } };
      const hostId = identifier(req.parts[2]);
      if (req.method === "POST") return { body: this.configure(db, hostId, req.body, principal.kind === "operator" ? "operator" : `${principal.kind}:${principal.user!.id}`, now) };
      const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId);
      if (!host) throw new ServiceError("Unknown host.", 404);
      return { body: this.view(db, host, now) };
    });
  }
}
