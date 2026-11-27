import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { identifier } from './consumers.ts';
import { noLinks, present, readRecord, saveRecord, unknownOutcome } from './runtime-process.ts';

type Kind = 'live' | 'video';
type Saved = Record<string, unknown>;

export class CaptureJournals {
  private readonly restored = new Map<Kind, { legacy: Map<string, string[]>; uncertain: boolean }>();

  constructor(private readonly state: string) {}

  initialize(): void {
    this.restore('live');
    this.restore('video');
  }

  private directory(kind: Kind): string {
    return join(this.state, 'work', kind);
  }

  private names(kind: Kind): string[] {
    const directory = this.directory(kind);
    noLinks(directory);
    return present(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')) : [];
  }

  path(kind: Kind, machineId: string, id: string): string {
    const directory = this.directory(kind), session = identifier(id);
    const legacy = join(directory, session + '.json');
    return present(legacy) ? legacy : join(directory, `${identifier(machineId)}.${session}.json`);
  }

  read(path: string, machineId: string): Saved {
    const saved = readRecord(path);
    if (saved.machineId !== machineId) throw unknownOutcome('Capture journal belongs to another device.');
    return saved;
  }

  private restore(kind: Kind) {
    const existing = this.restored.get(kind);
    if (existing) return existing;
    const legacy = new Map<string, string[]>();
    const restored = { legacy, uncertain: false };
    this.restored.set(kind, restored);
    let names: string[];
    try { names = this.names(kind); }
    catch { restored.uncertain = true; return restored; }
    for (const name of names) {
      try {
        const ids = name.slice(0, -5).split('.');
        if (ids.length > 2 || ids.some(id => identifier(id) !== id)) throw unknownOutcome('Invalid capture journal filename.');
        const path = join(this.directory(kind), name);
        if (ids.length === 2) {
          // A corrupt body is scoped by its filename. Conflicting ownership on
          // restore is host-wide uncertainty because either device may be affected.
          let saved: Saved;
          try { saved = readRecord(path); } catch { continue; }
          if (saved.machineId !== ids[0]) restored.uncertain = true;
        } else {
          // Legacy filenames carry no device. Read the journal itself and ignore
          // old ownership sidecars, which can disagree after a partial restore.
          const device = identifier(readRecord(path).machineId);
          const sessions = legacy.get(device) ?? [];
          sessions.push(ids[0]!);
          legacy.set(device, sessions);
        }
      } catch { restored.uncertain = true; }
    }
    return restored;
  }

  save(kind: Kind, id: string, saved: Saved): void {
    const machineId = identifier(saved.machineId), path = this.path(kind, machineId, id);
    if (present(path)) this.read(path, machineId);
    else if (this.names(kind).some(name => name.endsWith(`.${identifier(id)}.json`))) {
      throw unknownOutcome('Capture journal belongs to another device.');
    }
    saveRecord(path, saved);
  }

  forDevice(kind: Kind, machineId: string, forAdmission = true): { id: string; path: string; saved: Saved }[] {
    const device = identifier(machineId), { legacy, uncertain } = this.restore(kind);
    if (forAdmission && uncertain) throw unknownOutcome('Capture journal ownership is unknown.');
    const directory = this.directory(kind), prefix = device + '.';
    const scoped = this.names(kind).filter(name => name.startsWith(prefix));
    const flat = (legacy.get(device) ?? []).map(id => id + '.json');
    return [...scoped, ...flat].flatMap(name => {
      const path = join(directory, name);
      if (!present(path)) return [];
      const id = identifier(name.slice(name.startsWith(prefix) ? prefix.length : 0, -5));
      return [{ id, path, saved: this.read(path, device) }];
    });
  }
}
