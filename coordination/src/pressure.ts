/** Host memory and disk pressure. A platform signal is reduced to a debounced state. By default
 * it is an observation only. A host refuses new placements or restarts because of it only when
 * its operator opted in (`gatePlacement`, `gateRestart`), because the thresholds have not been
 * measured natively. Nothing here stops, shrinks or relocates running work.
 * The probes read kernel state; they have portable parser fixtures but no native acceptance. */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { object, ServiceError } from "./errors.ts";

export type PressureState = "normal" | "pressured" | "unknown";
export type DimensionState = PressureState | "unsupported";
export type MemoryLevel = "normal" | "warning" | "critical";
export type MemorySource = "darwin-pressure-level" | "linux-psi-meminfo" | "linux-meminfo" | "none";
export interface PressureThresholds {
  memory: {
    /** macOS kernel level at which the host enters pressure; it always leaves at `normal`. */
    darwinEnterLevel: "warning" | "critical";
    /** Linux PSI `some avg10`, in percent of wall time stalled on memory. */
    psiEnterPercent: number; psiExitPercent: number;
    /** Linux MemAvailable as a percentage of MemTotal. */
    availableEnterPercent: number; availableExitPercent: number;
  };
  disk: { enterFreeGiB: number; exitFreeGiB: number };
  /** A signal must hold continuously this long before the state changes. */
  enterSeconds: number; clearSeconds: number;
}
export const DEFAULT_PRESSURE: PressureThresholds = {
  memory: { darwinEnterLevel: "warning", psiEnterPercent: 10, psiExitPercent: 5, availableEnterPercent: 5, availableExitPercent: 10 },
  disk: { enterFreeGiB: 5, exitFreeGiB: 10 }, enterSeconds: 10, clearSeconds: 60,
};
/** One raw reading. A dimension is `null` when its signal should exist but could not be read. */
export interface MemorySignal { source: MemorySource; level?: MemoryLevel; psiSomeAvg10?: number; availablePercent?: number }
export interface PressureSample {
  memory: MemorySignal | "unsupported" | null;
  disk: { freeGiB: number; totalGiB: number } | null;
}
/** What this host's operator lets its pressure refuse. Both are off unless set in the host file. */
export interface PressureGates { placement: boolean; restart: boolean }
export interface PressureReport {
  version: 1; state: PressureState | "disabled"; sampledAt: number;
  gates?: PressureGates;
  since?: number; reasons?: ("memory" | "disk")[];
  memory?: { state: DimensionState; source: MemorySource; level?: MemoryLevel; psiSomeAvg10?: number; availablePercent?: number };
  disk?: { state: DimensionState; freeGiB?: number; totalGiB?: number };
  thresholds?: PressureThresholds;
}

function fail(message: string): never { throw new ServiceError(message, 400); }
function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`Unknown ${label} field.`);
}
function bounded(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(`Invalid ${label}.`);
  return value as number;
}
/** Operator configuration (`pressure` in the host file). Exit thresholds must be more relaxed
 * than their enter thresholds; together with the hold times that is the hysteresis. */
export function pressureConfig(value: unknown): { enabled: boolean; gates: PressureGates; thresholds: PressureThresholds } {
  if (value === undefined) return { enabled: true, gates: { placement: false, restart: false }, thresholds: structuredClone(DEFAULT_PRESSURE) };
  const input = object(value); only(input, ["enabled", "gatePlacement", "gateRestart", "memory", "disk", "enterSeconds", "clearSeconds"], "pressure");
  for (const key of ["enabled", "gatePlacement", "gateRestart"]) if (input[key] !== undefined && typeof input[key] !== "boolean") fail(`Invalid pressure ${key} flag.`);
  // Sampling is on by default as an observation. Refusing work because of it is an explicit choice.
  const gates = { placement: input.gatePlacement === true, restart: input.gateRestart === true };
  if (input.enabled === false && (gates.placement || gates.restart)) fail("A host that reports no pressure cannot gate on it.");
  const memory = object(input.memory ?? {}), disk = object(input.disk ?? {}), base = DEFAULT_PRESSURE;
  only(memory, Object.keys(base.memory), "memory pressure"); only(disk, Object.keys(base.disk), "disk pressure");
  const level = memory.darwinEnterLevel ?? base.memory.darwinEnterLevel;
  if (level !== "warning" && level !== "critical") fail("darwinEnterLevel must be warning or critical.");
  const thresholds: PressureThresholds = {
    memory: { darwinEnterLevel: level as "warning" | "critical",
      psiEnterPercent: bounded(memory.psiEnterPercent ?? base.memory.psiEnterPercent, "psiEnterPercent", 0.1, 100),
      psiExitPercent: bounded(memory.psiExitPercent ?? base.memory.psiExitPercent, "psiExitPercent", 0, 100),
      availableEnterPercent: bounded(memory.availableEnterPercent ?? base.memory.availableEnterPercent, "availableEnterPercent", 0, 99),
      availableExitPercent: bounded(memory.availableExitPercent ?? base.memory.availableExitPercent, "availableExitPercent", 0.1, 100) },
    disk: { enterFreeGiB: bounded(disk.enterFreeGiB ?? base.disk.enterFreeGiB, "enterFreeGiB", 0, 1_048_576),
      exitFreeGiB: bounded(disk.exitFreeGiB ?? base.disk.exitFreeGiB, "exitFreeGiB", 0.001, 1_048_576) },
    enterSeconds: bounded(input.enterSeconds ?? base.enterSeconds, "enterSeconds", 0, 3600),
    clearSeconds: bounded(input.clearSeconds ?? base.clearSeconds, "clearSeconds", 0, 86400),
  };
  if (thresholds.memory.psiExitPercent >= thresholds.memory.psiEnterPercent || thresholds.memory.availableExitPercent <= thresholds.memory.availableEnterPercent ||
      thresholds.disk.exitFreeGiB <= thresholds.disk.enterFreeGiB) fail("Pressure exit thresholds must be more relaxed than their enter thresholds.");
  return { enabled: input.enabled !== false, gates, thresholds };
}

const rank: Record<MemoryLevel, number> = { normal: 0, warning: 1, critical: 2 };
interface Track { state: "normal" | "pressured"; observed?: boolean; enterSince?: number; clearSince?: number }
function advance(track: Track, entering: boolean, clear: boolean, now: number, thresholds: PressureThresholds): void {
  // The hold times debounce changes from a known state. A host that starts under pressure has
  // no normal state to hold, so its first reading decides at once.
  if (!track.observed) { track.observed = true; if (entering) { track.state = "pressured"; return; } }
  if (track.state === "normal") {
    delete track.clearSince;
    if (!entering) { delete track.enterSince; return; }
    track.enterSince ??= now;
    if (now - track.enterSince >= thresholds.enterSeconds) { track.state = "pressured"; delete track.enterSince; }
  } else {
    delete track.enterSince;
    if (!clear) { delete track.clearSince; return; }
    track.clearSince ??= now;
    if (now - track.clearSince >= thresholds.clearSeconds) { track.state = "normal"; delete track.clearSince; }
  }
}
const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

/** Debounced state per dimension. An unreadable signal is `unknown` at once and resumes from the
 * last known state, so a read failure can never shorten the hold a pressured host must serve. */
export class PressureMonitor {
  private readonly memory: Track = { state: "normal" };
  private readonly disk: Track = { state: "normal" };
  private state: PressureState | undefined;
  private since = 0;
  constructor(readonly thresholds: PressureThresholds) {}
  /** `elapsed` is a monotonic clock in seconds; `wall` only labels the report. */
  observe(sample: PressureSample, elapsed: number, wall: number): PressureReport {
    if (!Number.isFinite(elapsed) || !Number.isFinite(wall) || wall < 0) throw new ServiceError("Invalid pressure sample time.", 400);
    const t = this.thresholds;
    let memory: NonNullable<PressureReport["memory"]>;
    if (sample.memory === "unsupported") memory = { state: "unsupported", source: "none" };
    else if (sample.memory === null) { delete this.memory.enterSince; delete this.memory.clearSince; memory = { state: "unknown", source: "none" }; }
    else {
      const { source, level, psiSomeAvg10: psi, availablePercent: available } = sample.memory;
      if (level === undefined && psi === undefined && available === undefined) { delete this.memory.enterSince; delete this.memory.clearSince; memory = { state: "unknown", source }; }
      else {
        const entering = level !== undefined && rank[level] >= rank[t.memory.darwinEnterLevel] || psi !== undefined && psi >= t.memory.psiEnterPercent || available !== undefined && available <= t.memory.availableEnterPercent;
        const clear = (level === undefined || level === "normal") && (psi === undefined || psi <= t.memory.psiExitPercent) && (available === undefined || available >= t.memory.availableExitPercent);
        advance(this.memory, entering, clear, elapsed, t);
        memory = { state: this.memory.state, source, ...(level === undefined ? {} : { level }), ...(psi === undefined ? {} : { psiSomeAvg10: round(psi) }), ...(available === undefined ? {} : { availablePercent: round(available) }) };
      }
    }
    let disk: NonNullable<PressureReport["disk"]>;
    if (sample.disk === null) { delete this.disk.enterSince; delete this.disk.clearSince; disk = { state: "unknown" }; }
    else {
      advance(this.disk, sample.disk.freeGiB <= t.disk.enterFreeGiB, sample.disk.freeGiB >= t.disk.exitFreeGiB, elapsed, t);
      disk = { state: this.disk.state, freeGiB: round(sample.disk.freeGiB), totalGiB: round(sample.disk.totalGiB) };
    }
    const reasons = (["memory", "disk"] as const).filter(key => (key === "memory" ? memory : disk).state === "pressured");
    const state: PressureState = reasons.length ? "pressured" : memory.state === "unknown" || disk.state === "unknown" ? "unknown" : "normal";
    if (state !== this.state) { this.state = state; this.since = wall; }
    return { version: 1, state, sampledAt: wall, since: this.since, reasons, memory, disk, thresholds: structuredClone(t) };
  }
}

const levels: MemoryLevel[] = ["normal", "warning", "critical"];
const sources: MemorySource[] = ["darwin-pressure-level", "linux-psi-meminfo", "linux-meminfo", "none"];
const dimensionStates: DimensionState[] = ["normal", "pressured", "unknown", "unsupported"];
/** Controller-side validation of a host report: bounded, known fields only. */
export function validatePressureReport(value: unknown): PressureReport {
  const v = object(value);
  if (v.version !== 1) fail("Unsupported pressure report version.");
  const sampledAt = bounded(v.sampledAt, "pressure sample time", 0, 2 ** 53);
  if (v.state === "disabled") { only(v, ["version", "state", "sampledAt"], "pressure report"); return { version: 1, state: "disabled", sampledAt }; }
  only(v, ["version", "state", "sampledAt", "since", "reasons", "memory", "disk", "thresholds", "gates"], "pressure report");
  // A report without gates comes from a host that only observes.
  const gate = object(v.gates ?? { placement: false, restart: false });
  if (Object.keys(gate).sort().join() !== "placement,restart" || typeof gate.placement !== "boolean" || typeof gate.restart !== "boolean") fail("Invalid pressure gates.");
  if (!["normal", "pressured", "unknown"].includes(String(v.state))) fail("Invalid pressure state.");
  const memory = object(v.memory), disk = object(v.disk);
  only(memory, ["state", "source", "level", "psiSomeAvg10", "availablePercent"], "memory pressure"); only(disk, ["state", "freeGiB", "totalGiB"], "disk pressure");
  if (!dimensionStates.includes(memory.state as DimensionState) || !sources.includes(memory.source as MemorySource) || !["normal", "pressured", "unknown"].includes(String(disk.state)) ||
      memory.level !== undefined && !levels.includes(memory.level as MemoryLevel)) fail("Invalid pressure dimension.");
  const memoryView: NonNullable<PressureReport["memory"]> = { state: memory.state as DimensionState, source: memory.source as MemorySource };
  if (memory.level !== undefined) memoryView.level = memory.level as MemoryLevel;
  if (memory.psiSomeAvg10 !== undefined) memoryView.psiSomeAvg10 = bounded(memory.psiSomeAvg10, "psiSomeAvg10", 0, 100);
  if (memory.availablePercent !== undefined) memoryView.availablePercent = bounded(memory.availablePercent, "availablePercent", 0, 100);
  const diskView: NonNullable<PressureReport["disk"]> = { state: disk.state as DimensionState };
  if (disk.freeGiB !== undefined) diskView.freeGiB = bounded(disk.freeGiB, "freeGiB", 0, 2 ** 53);
  if (disk.totalGiB !== undefined) diskView.totalGiB = bounded(disk.totalGiB, "totalGiB", 0, 2 ** 53);
  if (!Array.isArray(v.reasons) || v.reasons.length > 2 || v.reasons.some(reason => reason !== "memory" && reason !== "disk")) fail("Invalid pressure reasons.");
  const reasons = (["memory", "disk"] as const).filter(key => (key === "memory" ? memoryView : diskView).state === "pressured");
  // The overall state is derived, so a report cannot claim `normal` beside a pressured dimension.
  const derived: PressureState = reasons.length ? "pressured" : memoryView.state === "unknown" || diskView.state === "unknown" ? "unknown" : "normal";
  if (v.state !== derived || (["memory", "disk"] as const).filter(key => (v.reasons as unknown[]).includes(key)).join() !== reasons.join() || v.reasons.length !== reasons.length) fail("Pressure state contradicts its dimensions.");
  return { version: 1, state: derived, sampledAt, gates: { placement: gate.placement, restart: gate.restart }, since: bounded(v.since, "pressure since", 0, 2 ** 53), reasons, memory: memoryView, disk: diskView,
    thresholds: pressureConfig(v.thresholds).thresholds };
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parseDarwinPressureLevel(text: string): MemoryLevel {
  const level = ({ "1": "normal", "2": "warning", "4": "critical" } as Record<string, MemoryLevel>)[text.trim()];
  if (!level) throw new Error("Unrecognized memory pressure level.");
  return level;
}
/** `/proc/pressure/memory`: the `some avg10` share, in percent. */
export function parseLinuxPsi(text: string): number {
  const value = Number(/^some\s+avg10=([0-9]+(?:\.[0-9]+)?)\s/m.exec(text)?.[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Unrecognized memory pressure stall information.");
  return value;
}
/** `/proc/meminfo`: MemAvailable as a percentage of MemTotal. */
export function parseMeminfoAvailable(text: string): number {
  const field = (name: string): number => Number(new RegExp(`^${name}:\\s+([0-9]+) kB$`, "m").exec(text)?.[1]);
  const total = field("MemTotal"), available = field("MemAvailable");
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(available) || available < 0 || available > total) throw new Error("Unrecognized memory information.");
  return available / total * 100;
}
function command(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(path, args, { timeout: 3000, maxBuffer: 4096, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
/** The platform's own memory signal. macOS: the kernel pressure level. Linux: PSI where the
 * kernel exposes it, plus MemAvailable. Other platforms have no signal here (`unsupported`).
 * Throws when a signal that should exist cannot be read; the caller reports `unknown`. */
export async function readMemorySignal(platform: NodeJS.Platform = process.platform): Promise<MemorySignal | "unsupported"> {
  if (platform === "darwin") return { source: "darwin-pressure-level", level: parseDarwinPressureLevel(await command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])) };
  if (platform !== "linux") return "unsupported";
  let psi: number | undefined;
  try { psi = parseLinuxPsi(await readFile("/proc/pressure/memory", "utf8")); }
  catch (error) { if (!["ENOENT", "EOPNOTSUPP", "ENOTSUP"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
  const available = parseMeminfoAvailable(await readFile("/proc/meminfo", "utf8"));
  return { source: psi === undefined ? "linux-meminfo" : "linux-psi-meminfo", ...(psi === undefined ? {} : { psiSomeAvg10: psi }), availablePercent: available };
}
