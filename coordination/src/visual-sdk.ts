/** Incremental RFB 3.8 viewer. Raw/resize always supported; optional TightPNG/JPEG
 * decoding is negotiated only with an explicit decoder. Input is never replayed.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { ConsumerConfigurationError } from './consumer-client.ts';
import { checked, controlBytes, identifier, interrupted, record, Serial, SessionError, timeout, validText } from './sdk.ts';
import type { SessionChannel } from './sdk.ts';
export interface DecodedImage { width: number; height: number; rgb: Uint8Array }
export interface DisplayOptions {
  timeoutMs?: number;
  maxFrameBytes?: number;
  /** Optional synchronous bounded PNG/JPEG decoder; validate dimensions before allocating.
   * Without it only Raw/DesktopSize is negotiated, avoiding unsupported JPEG traffic.
   */
  decodeImage?: (data: Uint8Array, format: 'PNG' | 'JPEG', width: number, height: number, maxBytes: number) => DecodedImage;
}
export type OwnershipState = 'owned' | 'busy' | 'view-only' | 'reset-uncertain' | 'stale' | 'not-ready' | 'closed';
export interface ActionReceipt extends Record<string, unknown> { type: 'action-result'; id: string; state: 'succeeded' | 'failed' | 'unknown'; result: Record<string, unknown> }
const STATES = ['owned', 'busy', 'view-only', 'reset-uncertain', 'stale', 'not-ready'];
const INPUT_FIELDS: Record<string, string[]> = {
  tap: ['x', 'y'], swipe: ['x', 'y', 'toX', 'toY', 'durationMs'], text: ['text'], key: ['key'],
  'accessibility-action': ['snapshotId', 'nodeId', 'nativeAction'], launch: ['app'], terminate: ['app'],
  'open-url': ['url'], rotate: ['orientation'], location: ['latitude', 'longitude'], permission: ['app', 'permission', 'state'],
  install: ['artifact'], uninstall: ['app'],
};
export function inputAction(id: string, action: string, args: Record<string, unknown>): Record<string, unknown> {
  identifier(id); const fields = INPUT_FIELDS[action];
  if (!Object.hasOwn(INPUT_FIELDS, action) || !fields || !record(args) || fields.length !== Object.keys(args).length || !fields.every(k => Object.hasOwn(args, k))) throw new ConsumerConfigurationError('Invalid display input action.');
  for (const [key, value] of Object.entries(args)) {
    if (['x', 'y', 'toX', 'toY', 'durationMs'].includes(key)) {
      if (!Number.isInteger(value) || Number(value) < (key === 'durationMs' ? 1 : 0) || Number(value) > (key === 'durationMs' ? 10000 : 32768)) throw new ConsumerConfigurationError('Invalid input coordinates/duration.');
    } else if (key === 'latitude' || key === 'longitude') {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > (key === 'latitude' ? 90 : 180)) throw new ConsumerConfigurationError('Invalid geographic coordinate.');
    } else if (!validText(value) || (key === 'text' ? [...value].length > 16000 : !value.length || value.length > 4096 || value.startsWith('-'))) throw new ConsumerConfigurationError('Invalid input argument.');
  }
  if (Object.hasOwn(args, 'app') && !/^[A-Za-z0-9_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.$]+)?(?![\s\S])/.test(String(args.app))) throw new ConsumerConfigurationError('Invalid application identifier.');
  if (action === 'permission' && !['grant', 'revoke', 'reset'].includes(String(args.state))) throw new ConsumerConfigurationError('Invalid permission state.');
  if (action === 'rotate' && !['PORTRAIT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT'].includes(String(args.orientation))) throw new ConsumerConfigurationError('Invalid orientation.');
  const value = { type: 'action', id: identifier(id), action, arguments: args }; controlBytes(value); return value;
}
export class DisplayClient {
  readonly connection: SessionChannel;
  readonly maxFrameBytes: number;
  width = 0;
  height = 0;
  state: OwnershipState | null = null;
  closed = false;
  #buffer: Buffer = Buffer.alloc(0);
  #rgb = Buffer.alloc(0);
  #missing = Buffer.alloc(0);
  #rectangles: number | null = null;
  #updates = 0;
  #initialized = false;
  #waiting: string | undefined;
  #result: ActionReceipt | undefined;
  #serial = new Serial();
  #decoder: DisplayOptions['decodeImage'];
  static validateOptions(options: DisplayOptions): void {
    timeout(options.timeoutMs ?? 30_000);
    if (!Number.isSafeInteger(options.maxFrameBytes ?? 67108864) || (options.maxFrameBytes ?? 67108864) < 4) throw new ConsumerConfigurationError('Choose a positive decoded framebuffer budget.');
    if (options.decodeImage !== undefined && typeof options.decodeImage !== 'function') throw new ConsumerConfigurationError('decodeImage must be a bounded image decoder.');
  }
  private constructor(connection: SessionChannel, options: DisplayOptions) { this.connection = connection; this.maxFrameBytes = options.maxFrameBytes ?? 67108864; this.#decoder = options.decodeImage; }
  static async connect(connection: SessionChannel, options: DisplayOptions = {}): Promise<DisplayClient> {
    this.validateOptions(options); const self = new DisplayClient(connection, options);
    try { await self.#initialize(performance.now() + (options.timeoutMs ?? 30000)); return self; }
    catch (error) { self.close(); throw interrupted(error, connection.sessionId); }
  }
  close(): void { if (!this.closed) { this.closed = true; this.state = 'closed'; this.connection.close(); } }
  [Symbol.dispose](): void { this.close(); }
  async #initialize(deadline: number): Promise<void> {
    if (!(await this.#read(12, deadline)).equals(Buffer.from('RFB 003.008\n'))) throw new SessionError('Display requires RFB 3.8.', 'capability_unsupported');
    await this.connection.sendBytes(Buffer.from('RFB 003.008\n'));
    const count = (await this.#read(1, deadline))[0]!;
    if (!count || !(await this.#read(count, deadline)).includes(1)) throw new SessionError('Display did not offer protected initialization.');
    await this.connection.sendBytes(Buffer.from([1]));
    if (!(await this.#read(4, deadline)).equals(Buffer.alloc(4))) throw new SessionError('Display initialization refused.');
    await this.connection.sendBytes(Buffer.from([1])); // Shared: never evict another viewer.
    const header = await this.#read(24, deadline), nameSize = header.readUInt32BE(20);
    if (nameSize > 4096) throw new SessionError('Display name exceeds envelope.');
    await this.#read(nameSize, deadline); this.#resize(header.readUInt16BE(0), header.readUInt16BE(2));
    const pixels = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
    const encodings = this.#decoder ? [-260, 0, -223] : [0, -223];
    const settings = Buffer.alloc(4 + 4 * encodings.length); settings[0] = 2; settings.writeUInt16BE(encodings.length, 2);
    encodings.forEach((n, i) => settings.writeInt32BE(n, 4 + 4 * i));
    await this.connection.sendBytes(Buffer.concat([Buffer.alloc(4), pixels, settings]));
    this.#initialized = true; this.#parse(); await this.#wait(() => this.state !== null, deadline);
  }
  #resize(width: number, height: number): void {
    if (!width || !height || width * height * 4 > this.maxFrameBytes) throw new SessionError('Display exceeds framebuffer budget.');
    this.width = width; this.height = height; this.#rgb = Buffer.alloc(width * height * 3); this.#missing = Buffer.alloc(width * height, 1);
  }
  async #receive(deadline: number): Promise<void> {
    const left = deadline - performance.now(); if (left <= 0) throw new SessionError('Display response timed out; inspect its original receipt.', 'session_incomplete', this.#waiting);
    const value = checked(await this.connection.receive(Math.min(left, 300000)), this.#waiting ?? this.connection.sessionId);
    if (value === null) throw new SessionError('Display response timed out; input is not replayed.', 'session_incomplete', this.#waiting);
    if (Buffer.isBuffer(value)) {
      if (this.#buffer.length + value.length > this.maxFrameBytes + 65536) throw new SessionError('Display stream exceeds decode budget.');
      this.#buffer = Buffer.concat([this.#buffer, value]); if (this.#initialized) this.#parse();
    } else if (value.type === 'control') {
      if (!STATES.includes(String(value.state))) throw new SessionError('Invalid ownership response.'); this.state = value.state as OwnershipState;
    } else if (value.type === 'action-result' && value.id === this.#waiting) {
      if (!['succeeded', 'failed', 'unknown'].includes(String(value.state)) || !record(value.result)) throw new SessionError('Invalid display receipt.');
      this.#result = value as ActionReceipt;
    } else if (value.type !== 'action-result') throw new SessionError('Unexpected display control.');
  }
  async #read(size: number, deadline: number): Promise<Buffer> {
    while (this.#buffer.length < size) await this.#receive(deadline);
    const data = this.#buffer.subarray(0, size); this.#buffer = this.#buffer.subarray(size); return data;
  }
  async #wait(predicate: () => boolean, deadline: number): Promise<void> { while (!predicate()) await this.#receive(deadline); }
  #parse(): void {
    while (this.#buffer.length) {
      let b = this.#buffer;
      if (this.#rectangles === null) {
        if (b[0] === 2) { this.#buffer = b.subarray(1); continue; }
        if (b[0] === 3) {
          if (b.length < 8) return; const size = b.readUInt32BE(4); if (size > 16384) throw new SessionError('Display clipboard exceeds envelope.');
          if (b.length < 8 + size) return; this.#buffer = b.subarray(8 + size); continue;
        }
        if (b[0] !== 0) throw new SessionError('Unsupported RFB server message.', 'capability_unsupported');
        if (b.length < 4) return;
        this.#rectangles = b.readUInt16BE(2); this.#buffer = b.subarray(4);
        if (!this.#rectangles) { this.#rectangles = null; this.#updates++; continue; }
        b = this.#buffer;
      }
      if (b.length < 12) return;
      const x = b.readUInt16BE(0), y = b.readUInt16BE(2), w = b.readUInt16BE(4), h = b.readUInt16BE(6), encoding = b.readInt32BE(8);
      let used = 12;
      if (encoding === -223) this.#resize(w, h);
      else {
        if (!w || !h || x + w > this.width || y + h > this.height) throw new SessionError('Display rectangle is outside the framebuffer.');
        let rgb: Uint8Array;
        if (encoding === 0) {
          used += w * h * 4; if (b.length < used) return;
          rgb = Buffer.alloc(w * h * 3);
          for (let p = 0; p < w * h; p++) { rgb[p * 3] = b[12 + p * 4]!; rgb[p * 3 + 1] = b[13 + p * 4]!; rgb[p * 3 + 2] = b[14 + p * 4]!; }
        } else if (encoding === -260 && this.#decoder) {
          if (b.length < 13) return; const kind = b[12]! >> 4;
          if (kind === 8) {
            used = 16; if (b.length < used) return; rgb = Buffer.alloc(w * h * 3);
            for (let p = 0; p < w * h; p++) { rgb[p * 3] = b[13]!; rgb[p * 3 + 1] = b[14]!; rgb[p * 3 + 2] = b[15]!; }
          } else {
            if (kind !== 9 && kind !== 10) throw new SessionError('Unsupported TightPNG rectangle.', 'capability_unsupported');
            let size = 0, offset = 13;
            for (let i = 0; i < 3; i++) { if (b.length <= offset) return; const part = b[offset++]!; size |= (i === 2 ? part : part & 127) << (i * 7); if (i === 2 || !(part & 128)) break; }
            if (size > this.maxFrameBytes) throw new SessionError('Compressed image exceeds budget.');
            used = offset + size; if (b.length < used) return;
            const image = this.#decoder(b.subarray(offset, used), kind === 10 ? 'PNG' : 'JPEG', w, h, this.maxFrameBytes);
            if (image.width !== w || image.height !== h || image.rgb.byteLength !== w * h * 3) throw new SessionError('Compressed dimensions differ from the rectangle.');
            rgb = image.rgb;
          }
        } else throw new SessionError('Display used an encoding that was not negotiated.', 'capability_unsupported');
        for (let row = 0; row < h; row++) {
          this.#rgb.set(rgb.subarray(row * w * 3, (row + 1) * w * 3), ((y + row) * this.width + x) * 3);
          this.#missing.fill(0, (y + row) * this.width + x, (y + row) * this.width + x + w);
        }
      }
      this.#buffer = b.subarray(used); this.#rectangles!--;
      if (!this.#rectangles) { this.#rectangles = null; this.#updates++; }
    }
  }
  #owned(): void { if (this.state !== 'owned') throw new SessionError('Take input ownership before sending input.', 'input_busy', undefined, false); }
  #operation<T>(work: () => Promise<T>, owned = false, requestId?: string): Promise<T> {
    return this.#serial.run(async () => {
      if (this.closed) throw new SessionError('Display connection ended; input is not replayed.', 'session_disconnected', requestId, false);
      if (owned) this.#owned();
      try { return await work(); }
      catch (error) { this.close(); throw interrupted(error, requestId ?? this.connection.sessionId); }
    });
  }
  screenshot(timeoutMs = 30000): Promise<Buffer> {
    timeout(timeoutMs);
    return this.#operation(async () => {
      const deadline = performance.now() + timeoutMs; this.#missing.fill(1);
      while (true) {
        const update = this.#updates, request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(this.width, 6); request.writeUInt16BE(this.height, 8);
        await this.connection.sendBytes(request); await this.#wait(() => this.#updates > update, deadline);
        if (!this.#missing.includes(1)) return encodePng(this.width, this.height, this.#rgb);
      }
    });
  }
  #inputControl(action: 'take' | 'release', timeoutMs: number): Promise<OwnershipState> {
    timeout(timeoutMs);
    return this.#operation(async () => { this.state = null; await this.connection.sendControl({ type: 'input-control', action }); await this.#wait(() => this.state !== null, performance.now() + timeoutMs); return this.state!; });
  }
  takeControl(timeoutMs = 30000): Promise<OwnershipState> { return this.#inputControl('take', timeoutMs); }
  releaseControl(timeoutMs = 30000): Promise<OwnershipState> { return this.#inputControl('release', timeoutMs); }
  key(keysym: number, down = true): Promise<void> {
    if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff || typeof down !== 'boolean') throw new ConsumerConfigurationError('Use a 32-bit keysym and boolean state.');
    const b = Buffer.alloc(8); b[0] = 4; b[1] = Number(down); b.writeUInt32BE(keysym, 4); return this.#operation(() => this.connection.sendBytes(b), true);
  }
  pressKey(keysym: number): Promise<void> {
    if (!Number.isInteger(keysym) || keysym < 0 || keysym > 0xffffffff) throw new ConsumerConfigurationError('Use a 32-bit keysym.');
    const b = Buffer.alloc(16); b[0] = b[8] = 4; b[1] = 1; b.writeUInt32BE(keysym, 4); b.writeUInt32BE(keysym, 12); return this.#operation(() => this.connection.sendBytes(b), true);
  }
  #pointer(x: number, y: number, buttons: number): Buffer {
    if (![x, y, buttons].every(Number.isInteger) || x < 0 || y < 0 || x >= this.width || y >= this.height || buttons < 0 || buttons > 255) throw new ConsumerConfigurationError('Pointer is outside the framebuffer or mask.');
    const b = Buffer.alloc(6); b[0] = 5; b[1] = buttons; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); return b;
  }
  pointer(x: number, y: number, buttons = 0): Promise<void> { const b = this.#pointer(x, y, buttons); return this.#operation(() => this.connection.sendBytes(b), true); }
  click(x: number, y: number, button = 1): Promise<void> {
    const b = this.#pointer(x, y, button); if (!button || (button & (button - 1))) throw new ConsumerConfigurationError('Choose one button bit.');
    return this.#operation(() => this.connection.sendBytes(Buffer.concat([b, this.#pointer(x, y, 0)])), true);
  }
  action(requestId: string, action: string, args: Record<string, unknown>, timeoutMs = 30000): Promise<ActionReceipt> {
    return this.#receipt(inputAction(requestId, action, args), true, timeoutMs);
  }
  receipt(requestId: string, timeoutMs = 30000): Promise<ActionReceipt> { return this.#receipt({ type: 'action-receipt', id: identifier(requestId) }, false, timeoutMs); }
  #receipt(value: Record<string, unknown>, owned: boolean, timeoutMs: number): Promise<ActionReceipt> {
    timeout(timeoutMs); const id = String(value.id);
    return this.#operation(async () => {
      this.#waiting = id; this.#result = undefined;
      await this.connection.sendControl(value); await this.#wait(() => this.#result !== undefined, performance.now() + timeoutMs);
      const result = this.#result!; this.#waiting = undefined; this.#result = undefined;
      if (value.type === 'action' && result.state === 'unknown') this.state = 'reset-uncertain'; return result;
    }, owned, id);
  }
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b;
}
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.byteLength !== width * height * 3) throw new ConsumerConfigurationError('Invalid RGB image.');
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (width * 3 + 1)); for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
/** Portable 8-bit noninterlaced PNG decoder. For JPEG/interlaced PNG supply a decoder.
 * The caller-provided rectangle bounds are checked before decompression.
 */
export function decodePng(data: Uint8Array, width: number, height: number, maxBytes = 67108864): DecodedImage {
  const b = Buffer.from(data); if (b.length < 33 || !b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || width * height * 4 > maxBytes) throw new SessionError('Invalid PNG envelope.');
  let offset = 8, channels = 0, palette: Buffer | undefined, ended = false, sawData = false; const compressed: Buffer[] = [];
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset), end = offset + size + 12; if (end > b.length || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new SessionError('Invalid PNG chunk.');
    const type = b.toString('ascii', offset + 4, offset + 8), bytes = b.subarray(offset + 8, end - 4);
    if (!channels && type !== 'IHDR') throw new SessionError('PNG header missing.');
    if (type === 'IHDR') {
      if (offset !== 8 || size !== 13 || bytes.readUInt32BE(0) !== width || bytes.readUInt32BE(4) !== height || bytes[8] !== 8 || bytes[10] !== 0 || bytes[11] !== 0 || bytes[12] !== 0) throw new SessionError('PNG dimensions or format differ from the rectangle.', 'capability_unsupported');
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[bytes[9]!] ?? 0; if (!channels) throw new SessionError('Unsupported PNG color type.', 'capability_unsupported');
    } else if (type === 'PLTE') { if (sawData || !size || size % 3 || size > 768) throw new SessionError('Invalid PNG palette.'); palette = bytes; }
    else if (type === 'IDAT') { sawData = true; compressed.push(bytes); }
    else if (type === 'IEND') { if (size || end !== b.length) throw new SessionError('Invalid PNG end.'); ended = true; break; }
    else if ((b[offset + 4]! & 32) === 0) throw new SessionError('Unsupported critical PNG chunk.', 'capability_unsupported');
    offset = end;
  }
  if (!ended || !sawData) throw new SessionError('Incomplete PNG.');
  const stride = width * channels, expected = height * (stride + 1), raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) throw new SessionError('Invalid PNG byte count.');
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a: number, c: number, d: number) => { const p = a + c - d, x = Math.abs(p - a), y = Math.abs(p - c), z = Math.abs(p - d); return x <= y && x <= z ? a : y <= z ? c : d; };
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!; if (filter > 4) throw new SessionError('Invalid PNG filter.');
    for (let x = 0; x < stride; x++) {
      const i = row * stride + x, left = x >= channels ? pixels[i - channels]! : 0, up = row ? pixels[i - stride]! : 0, corner = row && x >= channels ? pixels[i - stride - channels]! : 0;
      pixels[i] = (raw[row * (stride + 1) + x + 1]! + [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter]!) & 255;
    }
  }
  const rgb = Buffer.alloc(width * height * 3), color = b[25]!;
  for (let i = 0; i < width * height; i++) {
    if (color === 3) { const p = pixels[i]! * 3; if (!palette || p + 3 > palette.length) throw new SessionError('Invalid PNG palette index.'); rgb.set(palette.subarray(p, p + 3), i * 3); }
    else if (channels <= 2) rgb.fill(pixels[i * channels]!, i * 3, i * 3 + 3);
    else rgb.set(pixels.subarray(i * channels, i * channels + 3), i * 3);
  }
  return { width, height, rgb };
}
