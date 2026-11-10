import { Lane, ServiceError, allowed, equal, integer, unsupported, type Authority, type MaybePromise } from "./common.ts";
import { type KeyCode, type KeyResolution } from "./input.ts";
export type Layout = readonly [string, number, string];
export interface WindowsKeyAPI {
  layout(): MaybePromise<Layout>;
  scan(vk: number, layout: string): MaybePromise<number>;
  map(character: string, layout: string): MaybePromise<number>;
  translate(vk: number, scan: number, modifiers: number, layout: string): MaybePromise<string>;
}
const NAMED: Record<number, number> = { 0xff08: 8, 0xff09: 9, 0xff0d: 13, 0xff1b: 27, 0xffff: 46, 0xff50: 36, 0xff57: 35, 0xff55: 33, 0xff56: 34, 0xff51: 37, 0xff52: 38, 0xff53: 39, 0xff54: 40, 0xff63: 45, 0xffe1: 160, 0xffe2: 161, 0xffe3: 162, 0xffe4: 163, 0xffe9: 164, 0xffea: 165, 0xffe7: 91, 0xffe8: 92, 0xffeb: 91, 0xffec: 92, 0xff8d: 13, 0xff67: 93 };
for (let i = 0; i < 24; i++) NAMED[0xffbe + i] = 0x70 + i;
export class WindowsKeys {
  readonly lane = new Lane(); closed = false;
  constructor(readonly api: WindowsKeyAPI, readonly authorized: Authority) {}
  authorize(): void { if (!allowed(this.authorized)) this.closed = true; if (this.closed) throw new ServiceError("Windows key authorization ended.", 410); }
  async scan(vk: number, token: Layout, enter = false): Promise<KeyCode> {
    const scan = await this.api.scan(vk, token[2]);
    if (!integer(scan, 1, 65535) || !(scan & 255) || ![0, 0xe0].includes(scan >>> 8)) unsupported("This key has no unambiguous native scan mapping.");
    return [0, scan & 255, 8 | Number(enter || scan >>> 8 === 0xe0)];
  }
  resolve = async (keysym: number, modifiers: number): Promise<KeyResolution> => this.lane.run(async () => {
    this.authorize(); if (!integer(keysym, 0, 0xffffffff) || !integer(modifiers, 0, 31) || modifiers & ~31) throw new ServiceError("Invalid Windows keysym/modifiers.", 400);
    let token: Layout | undefined, result: KeyCode[];
    const observe = async (): Promise<Layout> => { const value = await this.api.layout(); if (!value[0] || !integer(value[1], 1) || !value[2]) throw new ServiceError("Foreground layout is unavailable.", 409, { code: "input_stale" }); return value; };
    if (NAMED[keysym]) { token = await observe(); result = [await this.scan(NAMED[keysym]!, token, keysym === 0xff8d)]; }
    else {
      const scalar = integer(keysym, 0x20, 0x7e) || integer(keysym, 0xa0, 0xff) ? keysym : (keysym & 0xff000000) === 0x01000000 ? keysym & 0xffffff : 0;
      if (!integer(scalar, 1, 0x10ffff) || integer(scalar, 0xd800, 0xdfff)) unsupported("This keysym cannot be resolved without guessing.");
      const character = String.fromCodePoint(scalar);
      if (!(modifiers & 14)) { const raw = Buffer.from(character, "utf16le"); result = []; for (let i = 0; i < raw.length; i += 2) result.push([0, raw.readUInt16LE(i), 4]); }
      else {
        if (scalar > 65535) unsupported("Modified supplementary Unicode is unsupported.");
        token = await observe(); const mapping = await this.api.map(character, token[2]);
        if (!integer(mapping, 0, 0x7fff)) unsupported("Character cannot be mapped in this layout.");
        const vk = mapping & 255, required = mapping >>> 8; let active = modifiers & 7;
        if ((required & 6) === 6 && modifiers & 16) active |= 2;
        if (!integer(vk, 1, 254) || required & ~7 || required & 6 & ~active) unsupported("Required shortcut modifiers are not held.");
        const descriptor = await this.scan(vk, token), producing = await this.api.translate(vk, descriptor[1], required & 6 | modifiers & 1, token[2]);
        if (producing !== character && !(producing.length === 1 && /\p{L}/u.test(producing) && /\p{L}/u.test(character) && producing.toLowerCase() === character.toLowerCase())) unsupported("Dead-key or ambiguous shortcut translation is unsupported.");
        result = [descriptor];
      }
    }
    if (token && !equal(await observe(), token)) throw new ServiceError("Foreground layout changed.", 409, { code: "input_stale" });
    this.authorize(); const retained = token && [...token];
    return { codes: result, validate: async () => this.lane.run(async () => { this.authorize(); if (retained && !equal(await observe(), retained)) throw new ServiceError("Keyboard layout changed before posting.", 409, { code: "input_stale" }); this.authorize(); return true; }) };
  });
  close(): void { this.closed = true; }
}
