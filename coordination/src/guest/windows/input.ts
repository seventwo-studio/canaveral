import { Lane, ServiceError, allowed, equal, fields, integer, text, uncertain, type Authority, type MaybePromise } from "./common.ts";
export type Bounds = readonly [number, number, number, number];
export type KeyCode = [number, number, number];
export type InputEvent = { kind: "key"; vk: number; scan: number; flags: number } | { kind: "mouse"; flags: number; data: number; x: number; y: number };
export interface HeldState { version: 1; blocked: boolean; keys: { keysym: number; codes: KeyCode[] }[]; buttons: number; transient: KeyCode[] }
export interface InputBackend { post(events: InputEvent[], bounds: Bounds | null, cleanup: boolean): MaybePromise<{ posted: boolean }> }
export interface KeyResolution { codes: KeyCode[]; validate?: () => MaybePromise<boolean> }
export type KeyResolver = (keysym: number, modifiers: number) => MaybePromise<KeyResolution>;
export const MODIFIERS: Record<number, number> = { 0xffe1: 1, 0xffe2: 1, 0xffe3: 2, 0xffe4: 2, 0xffe9: 4, 0xffea: 20, 0xffe7: 8, 0xffe8: 8, 0xffeb: 8, 0xffec: 8 };
const BUTTONS = [[1, 2, 4, 0], [2, 0x20, 0x40, 0], [4, 8, 0x10, 0], [128, 0x80, 0x100, 1]] as const;
export function neutral(): HeldState { return { version: 1, blocked: false, keys: [], buttons: 0, transient: [] }; }
export function keyInput(vk: number, scan: number, flags: number): InputEvent {
  if (!integer(vk, 0, 254) || !integer(scan, 0, 65535) || !integer(flags, 0, 15) || flags & 4 && (vk !== 0 || flags & 9) || flags & 8 && (vk !== 0 || scan === 0) || !(flags & 12) && (vk === 0 || scan !== 0) || (flags & 12) === 12) throw new ServiceError("Invalid native Windows key descriptor.", 400);
  return { kind: "key", vk, scan, flags };
}
export function mouseInput(flags: number, data = 0, x = 0, y = 0): InputEvent {
  if (!integer(flags, 1, 0xffff) || !integer(data, -2147483648, 0xffffffff) || !integer(x, 0, 65535) || !integer(y, 0, 65535) || flags & ~0xd9ff || Boolean(flags & 0x8000) !== Boolean(flags & 0x4000) || flags & 1 && (flags & 0xc000) !== 0xc000 || flags & 0xc000 && !(flags & 1) || flags & 0x1800 && flags & 0x180 || (flags & 0x1800) === 0x1800 || [6, 0x18, 0x60, 0x180].some(pair => (flags & pair) === pair) || flags & 0x180 && ![1, 2, 3].includes(data) || !(flags & 1) && (x !== 0 || y !== 0) || data !== 0 && !(flags & 0x1980)) throw new ServiceError("Invalid native Windows mouse event.", 400);
  return { kind: "mouse", flags, data, x, y };
}
export function pointerInput(x: number, y: number, bounds: Bounds): InputEvent {
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(n => !Number.isSafeInteger(n)) || !integer(bounds[2], 1, 4096) || !integer(bounds[3], 1, 4096) || !integer(x, 0, bounds[2] - 1) || !integer(y, 0, bounds[3] - 1)) throw new ServiceError("Pointer is outside the captured desktop.", 400);
  return mouseInput(0xc001, 0, bounds[2] === 1 ? 0 : Math.floor(x * 65535 / (bounds[2] - 1)), bounds[3] === 1 ? 0 : Math.floor(y * 65535 / (bounds[3] - 1)));
}
function code(raw: unknown): KeyCode {
  if (!Array.isArray(raw) || raw.length !== 3) throw new ServiceError("Invalid held-key descriptor.", 400);
  const result: KeyCode = [raw[0] as number, raw[1] as number, raw[2] as number]; keyInput(...result);
  if (result[2] & 2) throw new ServiceError("Held keys require down descriptors.", 400); return result;
}
export function codes(raw: unknown): KeyCode[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) throw new ServiceError("Invalid Windows key resolution.", 400);
  const result = raw.map(code), a = result[0]!, b = result[1];
  if (b ? !(a[0] === 0 && b[0] === 0 && a[2] === 4 && b[2] === 4 && integer(a[1], 0xd800, 0xdbff) && integer(b[1], 0xdc00, 0xdfff)) : a[2] === 4 && integer(a[1], 0xd800, 0xdfff)) throw new ServiceError("A Unicode scalar must retain its surrogate pair.", 400);
  return result;
}
export function validateState(raw: unknown): HeldState {
  const v = fields(raw, ["version", "blocked", "keys", "buttons", "transient"]);
  if (v.version !== 1 || typeof v.blocked !== "boolean" || !Array.isArray(v.keys) || v.keys.length > 256 || !integer(v.buttons, 0, 255) || v.buttons & ~0x87 || !Array.isArray(v.transient) || v.transient.length > 2048) throw new ServiceError("Invalid Windows held-input record.", 400);
  const seen = new Set<number>(), native = new Set<string>(), transient = new Set<string>();
  const result = neutral(); result.blocked = v.blocked; result.buttons = v.buttons;
  for (const rawKey of v.keys) {
    const k = fields(rawKey, ["keysym", "codes"]);
    if (!integer(k.keysym, 0, 0xffffffff) || seen.has(k.keysym)) throw new ServiceError("Duplicate or invalid held keysym.", 400);
    const value = codes(k.codes);
    if (value.some(c => native.has(c.join(",")) || MODIFIERS[k.keysym as number] && c[2] === 4)) throw new ServiceError("Native keys cannot be shared between keysyms.", 400);
    seen.add(k.keysym); for (const c of value) native.add(c.join(",")); result.keys.push({ keysym: k.keysym, codes: value });
  }
  result.keys.sort((a, b) => a.keysym - b.keysym);
  for (const rawCode of v.transient) { const c = code(rawCode), id = c.join(","); if (c[2] !== 4 || transient.has(id)) throw new ServiceError("Invalid transient Unicode releases.", 400); transient.add(id); result.transient.push(c); }
  if (result.transient.length && (!result.blocked || result.keys.length || result.buttons)) throw new ServiceError("Transient text recovery requires neutral blocked state.", 400);
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new ServiceError("Held-input metadata is oversized.", 400);
  return result;
}
export class WindowsHeldInput {
  private value: HeldState; private revoked = false; readonly lane = new Lane();
  constructor(readonly backend: InputBackend, readonly resolve: KeyResolver, readonly save: (state: HeldState) => MaybePromise<boolean>, readonly authorized: Authority, readonly cleanupAuthorized: Authority = authorized, recovered?: HeldState) {
    this.value = validateState(recovered ?? neutral()); if (recovered) this.value.blocked = true;
  }
  get state(): HeldState { return structuredClone(this.value); }
  get modifiers(): number { return this.value.keys.reduce((bits, key) => bits | (MODIFIERS[key.keysym] ?? 0), 0); }
  authorize(cleanup = false, pending = false): void {
    const active = allowed(this.authorized); if (!active) this.revoked = true;
    if (!(cleanup ? allowed(this.cleanupAuthorized) : active && !this.revoked && (pending || !this.value.blocked))) throw new ServiceError("Windows input ended or requires explicit reset.", this.revoked && !cleanup ? 410 : 409, { code: "input_reset_uncertain", retryable: false });
  }
  async persist(state: HeldState): Promise<void> { if (await this.save(structuredClone(state)) !== true) throw new ServiceError("Input persistence is unconfirmed.", 409, { code: "input_reset_uncertain" }); }
  private async dispatch(events: InputEvent[], following: HeldState, bounds: Bounds | null, cleanup = false, transient: KeyCode[] = [], before?: () => MaybePromise<boolean>): Promise<void> {
    const next = validateState(following), pending = structuredClone(next), keys = new Map(this.value.keys.map(k => [k.keysym, k]));
    for (const k of next.keys) { if (keys.has(k.keysym) && !equal(keys.get(k.keysym), k)) throw new ServiceError("A held key cannot change native identity.", 409); keys.set(k.keysym, k); }
    pending.keys = [...keys.values()]; pending.buttons |= this.value.buttons;
    pending.transient = [...new Map([...this.value.transient, ...next.transient, ...transient].map(c => [c.join(","), c])).values()]; pending.blocked = true;
    this.value = validateState(pending); let dispatched = false;
    try {
      await this.persist(this.value); this.authorize(cleanup, true);
      if (events.length) { if (before && await before() !== true) throw new ServiceError("Windows key layout changed before input.", 409); dispatched = true; const result = await this.backend.post(events, bounds, cleanup); if (!equal(result, { posted: true })) throw new ServiceError("Native input acknowledgement differs.", 409); }
      this.authorize(cleanup, true); await this.persist(next); this.authorize(cleanup, true); this.value = next;
    } catch (error) { throw new ServiceError("Windows input remains blocked pending explicit release.", error instanceof ServiceError && error.status === 410 ? 410 : 409, { code: "input_reset_uncertain", retryable: false, ...(dispatched ? { outcome: "unknown" } : {}) }); }
  }
  async key(keysym: number, down: boolean, bounds: Bounds): Promise<{ posted: boolean }> {
    if (!integer(keysym, 0, 0xffffffff) || typeof down !== "boolean") throw new ServiceError("Invalid held-key operation.", 400);
    return this.lane.run(async () => {
      this.authorize(); const held = this.value.keys.find(k => k.keysym === keysym);
      if (!down && !held) return { posted: false };
      let resolved: KeyResolution | undefined;
      if (!held) { try { resolved = await this.resolve(keysym, this.modifiers); } catch { throw new ServiceError("Windows key resolution was refused.", 409, { code: "input_rejected", retryable: false }); } }
      const key = held ?? { keysym, codes: codes(resolved!.codes) }, next = this.state;
      if (down && !held) next.keys.push(key); if (!down) next.keys = next.keys.filter(k => k.keysym !== keysym);
      await this.dispatch(key.codes.map(([v, s, f]) => keyInput(v, s, f | (down ? 0 : 2))), next, bounds, false, [], resolved?.validate); return { posted: true };
    });
  }
  async pointer(x: number, y: number, mask: number, bounds: Bounds): Promise<{ posted: boolean }> {
    if (!integer(mask, 0, 255) || (mask & 24) === 24 || (mask & 96) === 96) throw new ServiceError("Conflicting pointer directions.", 400);
    const move = pointerInput(x, y, bounds);
    return this.lane.run(async () => {
      this.authorize(); const next = this.state; next.buttons = mask & 0x87; const events = [move];
      for (const [bit, , up, data] of BUTTONS) if (this.value.buttons & bit && !(mask & bit)) events.push(mouseInput(up, data));
      for (const [bit, down, , data] of BUTTONS) if (mask & bit && !(this.value.buttons & bit)) events.push(mouseInput(down, data));
      for (const [bit, flag, delta] of [[8, 0x800, 120], [16, 0x800, -120], [32, 0x1000, -120], [64, 0x1000, 120]]) if (mask & bit!) events.push(mouseInput(flag!, delta!));
      await this.dispatch(events, next, bounds); return { posted: true };
    });
  }
  async text(value: string, bounds: Bounds): Promise<{ posted: boolean }> {
    text(value, 16000);
    return this.lane.run(async () => {
      this.authorize(); if (this.value.keys.length || this.value.buttons) throw new ServiceError("Release held input before text insertion.", 409); if (!value) return { posted: false };
      const batches: number[][] = []; let units: number[] = [];
      for (const scalar of value) { const raw = Buffer.from(scalar, "utf16le"), part: number[] = []; for (let i = 0; i < raw.length; i += 2) part.push(raw.readUInt16LE(i)); if (units.length + part.length > 1024) { batches.push(units); units = []; } units.push(...part); } if (units.length) batches.push(units);
      for (const batch of batches) await this.dispatch(batch.flatMap(unit => [keyInput(0, unit, 4), keyInput(0, unit, 6)]), this.state, bounds, false, [...new Set(batch)].map(unit => [0, unit, 4]));
      return { posted: true };
    });
  }
  async reset(): Promise<{ released: true }> {
    return this.lane.run(async () => {
      this.authorize(true); const keys = [...this.value.keys].sort((a, b) => Number(Boolean(MODIFIERS[a.keysym])) - Number(Boolean(MODIFIERS[b.keysym])) || a.keysym - b.keysym);
      const events = [...keys.flatMap(k => k.codes.map(([v, s, f]) => keyInput(v, s, f | 2))), ...this.value.transient.map(([v, s, f]) => keyInput(v, s, f | 2))];
      for (const [bit, , up, data] of BUTTONS) if (this.value.buttons & bit) events.push(mouseInput(up, data));
      await this.dispatch(events, neutral(), null, true); return { released: true };
    });
  }
}
