import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { identifier } from './consumers.ts';
import { noLinks, present, readRecord, saveRecord, unknownOutcome } from './runtime-process.ts';

type Kind = 'live' | 'video';
type Saved = Record<string, unknown>;

export class CaptureJournals {
  private readonly indexes = new Map<Kind, { devices: Map<string, Set<string>>; unidentified: boolean }>();

  constructor(private readonly state: string) {}

  path(kind: Kind, id: string): string {
    return join(this.state, 'work', kind, identifier(id) + '.json');
  }

  private ownerPath(kind: Kind, id: string): string {
    return join(this.state, 'work', kind, 'owners', identifier(id) + '.json');
  }

  private index(kind: Kind) {
    const existing = this.indexes.get(kind);
    if (existing) return existing;
    const index = { devices: new Map<string, Set<string>>(), unidentified: false };
    const directory = join(this.state, 'work', kind);
    noLinks(directory);
    for (const name of present(directory) ? readdirSync(directory) : []) {
      if (!name.endsWith('.json')) continue;
      try {
        const id = identifier(name.slice(0, -5)), owner = this.ownerPath(kind, id);
        // A legacy journal has only its contents to identify the device. Index it once,
        // keeping the original path so a previous runner can still recognize the attempt.
        const indexed = present(owner), machineId = identifier(readRecord(indexed ? owner : this.path(kind, id)).machineId);
        this.add(index.devices, machineId, id);
        if (!indexed) saveRecord(owner, { machineId });
      } catch {
        // The original format cannot attribute an unreadable journal to a device.
        // Any unassigned uncertainty prevents capture until the state is inspected.
        index.unidentified = true;
      }
    }
    this.indexes.set(kind, index);
    return index;
  }

  private add(devices: Map<string, Set<string>>, machineId: string, id: string): void {
    const ids = devices.get(machineId) ?? new Set<string>();
    ids.add(id);
    devices.set(machineId, ids);
  }

  save(kind: Kind, id: string, saved: Saved): void {
    const machineId = identifier(saved.machineId), owner = this.ownerPath(kind, id), index = this.index(kind);
    if (!present(owner)) saveRecord(owner, { machineId });
    else if (readRecord(owner).machineId !== machineId) throw unknownOutcome('Capture journal belongs to another device.');
    this.add(index.devices, machineId, id);
    saveRecord(this.path(kind, id), saved);
  }

  forDevice(kind: Kind, machineId: string, forAdmission = true): { id: string; path: string; saved: Saved }[] {
    const { devices, unidentified } = this.index(kind);
    if (forAdmission && unidentified) throw unknownOutcome('Capture journal ownership is unknown.');
    const journals: { id: string; path: string; saved: Saved }[] = [];
    for (const id of devices.get(machineId) ?? []) {
      const path = this.path(kind, id);
      // The durable ownership entry is written before the first capture journal.
      if (!present(path)) continue;
      const saved = readRecord(path);
      if (saved.machineId !== machineId) throw unknownOutcome('Capture journal belongs to another device.');
      journals.push({ id, path, saved });
    }
    return journals;
  }
}
