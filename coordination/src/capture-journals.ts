import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { identifier } from './consumers.ts';
import { captureJournalRefusal } from './mobile-live.ts';
import { noLinks, present, readRecord, saveRecord, unknownOutcome } from './runtime-process.ts';
import { strictJson } from './strict-json.ts';

type Kind = 'live' | 'video';
type Saved = Record<string, unknown>;
type Journal = { kind: Kind; id: string; path: string; machineId: string; generation: string };
type ObservedJournal = Journal & { saved: Saved };
const kinds = ['live', 'video'] as const;
const uuid = (value: unknown): string => {
  if (identifier(value) !== value) throw new Error('Expected a canonical UUID.');
  return value as string;
};

function validate(kind: Kind, saved: Saved): void {
  const { state, cleaned, hostCleaned, deviceStopped, ackReceived, legacyReceipt, stop } = saved;
  const unfinished = state === 'attaching' || state === 'started';
  const finished = state === 'finished' && cleaned === true;
  const unknown = state === 'unknown' && cleaned === false;
  if (unfinished ? cleaned !== undefined : !finished && !unknown) throw new Error('Invalid capture state or cleanup marker.');
  if ([hostCleaned, deviceStopped, ackReceived, legacyReceipt].some(value => value !== undefined && value !== true) ||
      (unfinished && [hostCleaned, deviceStopped, ackReceived, legacyReceipt, stop].some(value => value !== undefined)) ||
      (ackReceived && (kind !== 'video' || !finished)) ||
      (deviceStopped && (kind !== 'live' || hostCleaned !== true))) throw new Error('Invalid capture cleanup evidence.');
  if (stop !== undefined) {
    if (kind !== 'live' || stop === null || typeof stop !== 'object' ||
        Object.keys(stop).sort().join(',') !== 'cause,leaseId,leaseRevision') throw new Error('Invalid capture stop evidence.');
    const { cause, leaseId, leaseRevision } = stop as Saved;
    uuid(leaseId);
    if (cause !== 'fence' || !Number.isSafeInteger(leaseRevision) || Number(leaseRevision) < 1) throw new Error('Invalid capture stop evidence.');
  }
}

export class CaptureJournals {
  private readonly entries = new Map<string, ObservedJournal>();
  private readonly stamps = new Map<string, string>();
  private readonly problems = new Map<string, string>();
  private readonly marker: string;

  constructor(private readonly state: string, private readonly log: (message: string) => void) {
    this.marker = join(state, 'capture-journal-uncertain.json');
  }

  get blocked(): boolean { return this.problems.size !== 0; }
  get issues(): ReadonlyMap<string, string> { return this.problems; }

  requireReady(): void {
    if (this.blocked) throw captureJournalRefusal();
  }

  private fault(path: string, reason: string, persist = true): void {
    if (this.problems.has(path)) return;
    if (!this.blocked && persist) {
      try { saveRecord(this.marker, { path, reason }); }
      catch {
        this.problems.set(this.marker, 'Could not persist capture journal refusal.');
        this.log('Could not persist capture journal refusal. Keep the runner out of service until operator recovery.');
      }
    }
    this.problems.set(path, reason);
    this.log(`Capture journal refusal at ${JSON.stringify(path)}: ${reason}`);
  }

  private directory(kind: Kind): string { return join(this.state, 'work', kind); }

  /** Inspect both directories before replay. Only operator recovery clears a refusal. */
  scan(): void {
    if (this.blocked) return;
    try {
      noLinks(this.marker);
      if (present(this.marker)) {
        readRecord(this.marker, undefined, strictJson);
        this.fault(this.marker, 'Capture journal refusal requires operator recovery.', false);
        return;
      }
    } catch {
      this.fault(this.marker, 'Cannot read the capture journal refusal marker.', false);
      return;
    }
    const found = new Set<string>();
    const byId = new Map<string, string>();
    for (const kind of kinds) {
      const directory = this.directory(kind);
      let names: string[];
      try {
        noLinks(directory);
        names = present(directory) ? readdirSync(directory) : [];
      } catch {
        this.fault(directory, 'Cannot read the capture journal directory.');
        continue;
      }
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.json')) continue;
        const path = join(directory, name);
        found.add(path);
        const parts = name.slice(0, -5).split('.');
        let id: string, scopedDevice: string | undefined;
        try {
          if (!name.endsWith('.json') || parts.length > 2) throw new Error();
          id = uuid(parts.at(-1));
          scopedDevice = parts.length === 2 ? uuid(parts[0]) : undefined;
        } catch {
          this.fault(path, 'Invalid capture journal filename.');
          continue;
        }
        const duplicate = byId.get(id);
        if (duplicate) {
          this.fault(duplicate, `Conflicting journal for the same capture at ${JSON.stringify(path)}.`);
          this.fault(path, `Conflicting journal for the same capture at ${JSON.stringify(duplicate)}.`);
          continue;
        }
        byId.set(id, path);
        let stamp: string;
        try {
          const stat = lstatSync(path, { bigint: true });
          if (!stat.isFile()) throw new Error();
          stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch { this.fault(path, 'Cannot inspect the capture journal as a regular file.'); continue; }
        if (this.stamps.get(path) === stamp) continue;
        const saved = this.readBody(kind, path);
        if (!saved) continue;
        let machineId: string, generation: string;
        try { machineId = uuid(saved.machineId); generation = uuid(saved.generation); }
        catch {
          this.fault(path, 'Missing or invalid capture device or generation.');
          continue;
        }
        if (scopedDevice && scopedDevice !== machineId) {
          this.fault(path, 'Capture device disagrees with the filename.');
          continue;
        }
        const previous = this.entries.get(id);
        if (previous) {
          if (previous.path !== path || !isDeepStrictEqual(previous.saved, saved)) {
            this.fault(path, 'Capture journal changed outside a runner transition.');
            continue;
          }
        } else if (saved.state === 'attaching') {
          // A restored attaching journal is indistinguishable from one rolled back after dispatch.
          this.fault(path, 'An attaching journal from outside this runner cannot prove capture never started.');
          continue;
        }
        this.entries.set(id, { kind, id, path, machineId, generation, saved });
        this.stamps.set(path, stamp);
      }
    }
    for (const { path } of this.entries.values()) if (!found.has(path)) this.fault(path, 'Capture journal disappeared while the runner was active.');
  }

  private readBody(kind: Kind, path: string): Saved | undefined {
    let saved: Saved;
    try { saved = readRecord(path, undefined, strictJson); }
    catch { this.fault(path, 'Cannot read or parse the capture journal.'); return; }
    try { validate(kind, saved); }
    catch { this.fault(path, 'Invalid capture state or cleanup evidence.'); return; }
    return saved;
  }

  private read(entry: ObservedJournal): Saved {
    const saved = this.readBody(entry.kind, entry.path);
    if (saved && !isDeepStrictEqual(entry.saved, saved)) {
      this.fault(entry.path, 'Capture journal changed outside a runner transition.');
    }
    this.requireReady();
    return saved!;
  }

  private entry(kind: Kind, machineId: string, id: string, generation: string): Journal {
    this.requireReady();
    const existing = this.entries.get(id);
    if (existing && (existing.kind !== kind || existing.machineId !== machineId || existing.generation !== generation)) {
      this.fault(existing.path, 'Capture journal disagrees with the requested kind, device or generation.');
      this.requireReady();
    }
    return existing ?? { kind, id, machineId, generation, path: join(this.directory(kind), `${machineId}.${id}.json`) };
  }

  load(kind: Kind, machineId: string, id: string, generation: string): { path: string; saved: Saved } | undefined {
    this.entry(kind, uuid(machineId), uuid(id), uuid(generation));
    const entry = this.entries.get(id);
    return entry && { path: entry.path, saved: this.read(entry) };
  }

  save(kind: Kind, id: string, saved: Saved): void {
    this.scan();
    const entry = this.entry(kind, uuid(saved.machineId), uuid(id), uuid(saved.generation));
    const previous = this.entries.get(entry.id);
    if (previous ? saved.state === 'attaching' : saved.state !== 'attaching') {
      throw unknownOutcome('Capture journal cannot be created or replaced out of order.');
    }
    if (previous) {
      const current = this.read(previous);
      // Once capture ends, only receipt compatibility and independent device stop proof can be added.
      if ((current.state === 'finished' || current.state === 'unknown') &&
          !isDeepStrictEqual({ ...current, ...(saved.legacyReceipt ? { legacyReceipt: true } : {}),
            ...(saved.deviceStopped ? { deviceStopped: true } : {}) }, saved)) {
        throw unknownOutcome('Capture journal cannot change settled capture evidence.');
      }
    }
    validate(kind, saved);
    try { saveRecord(entry.path, saved); }
    catch {
      this.fault(entry.path, 'Could not durably save the capture journal.');
      this.requireReady();
    }
    this.entries.set(entry.id, { ...entry, saved: structuredClone(saved) });
  }

  forDevice(kind: Kind, machineId: string): { id: string; saved: Saved }[] {
    this.scan();
    this.requireReady();
    return [...this.entries.values()]
      .filter(entry => entry.kind === kind && entry.machineId === machineId)
      .map(entry => ({ id: entry.id, saved: this.read(entry) }));
  }
}
