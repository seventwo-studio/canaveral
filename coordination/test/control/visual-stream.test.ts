import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { DisplayClient, decodePng } from '../../src/visual-sdk.ts';
import { ConsumerConfigurationError, SessionError } from '../../src/sdk.ts';
import type { SessionChannel, SessionMessage } from '../../src/sdk.ts';

class ScreenWire implements SessionChannel {
  readonly sessionId = randomUUID();
  queue: Array<SessionMessage | null> = [];
  requests = 0;
  controls: Record<string, unknown>[] = [];
  closes = 0;
  capture: (() => void) | undefined;
  receivePending: (() => void) | undefined;
  constructor() {
    const header = Buffer.alloc(24); header.writeUInt16BE(2, 0); header.writeUInt16BE(1, 2);
    this.queue.push(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), Buffer.alloc(4), header]), { type: 'control', state: 'view-only' });
  }
  async sendControl(value: Record<string, unknown>): Promise<void> { this.controls.push(value); }
  async sendBytes(data: Uint8Array): Promise<void> {
    if (data[0] === 3) { this.requests++; if (this.capture) this.capture(); else this.frame(this.requests); }
  }
  async receive(): Promise<SessionMessage | null> {
    if (this.receivePending) { const pending = this.receivePending; this.receivePending = undefined; pending(); return new Promise(() => {}); }
    return this.queue.shift() ?? null;
  }
  close(): void { this.closes++; }
  frame(value: number, width = 2, resize = false): void {
    const header = Buffer.alloc(4); header.writeUInt16BE(resize ? 2 : 1, 2);
    const rectangle = (encoding: number, pixels = Buffer.alloc(0)) => {
      const result = Buffer.alloc(12); result.writeUInt16BE(width, 4); result.writeUInt16BE(1, 6); result.writeInt32BE(encoding, 8); return Buffer.concat([result, pixels]);
    };
    const pixels = Buffer.alloc(width * 4); for (let x = 0; x < width; x++) pixels[x * 4] = value;
    const update = Buffer.concat([header, ...(resize ? [rectangle(-223)] : []), rectangle(0, pixels)]);
    for (let at = 0; at < update.length; at += 7) this.queue.push(update.subarray(at, at + 7));
  }
}
function chunks(bytes: Buffer): Array<{ type: string; data: Buffer }> {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); const result = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at); assert.ok(at + size + 12 <= bytes.length);
    let crc = 0xffffffff; for (const byte of bytes.subarray(at + 4, at + 8 + size)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(at + 8 + size));
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), data: bytes.subarray(at + 8, at + 8 + size) }); at += size + 12;
  }
  return result;
}

test('frame iteration requests one complete frame at a time without taking input or prefetching', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), stream = display.frames({ intervalMs: 1 });
  assert.equal(wire.requests, 0);
  const first = (await stream.next()).value!; assert.equal(first.index, 0); assert.equal(first.width, 2); assert.equal(first.height, 1);
  assert.deepEqual([...decodePng(first.png, 2, 1).rgb], [1, 0, 0, 1, 0, 0]);
  await delay(5); assert.equal(wire.requests, 1);
  const second = (await stream.next()).value!; assert.equal(second.index, 1); assert.ok(second.timestampMs >= first.timestampMs); assert.equal(wire.requests, 2);
  assert.deepEqual([...decodePng(first.png, 2, 1).rgb], [1, 0, 0, 1, 0, 0]);
  await stream.return(); assert.equal(display.closed, false); assert.equal(display.state, 'view-only'); assert.deepEqual(wire.controls, []); display.close();
});

test('capture cancellation interrupts cadence and pending screen reads without reconnecting', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), controller = new AbortController();
  const stream = display.frames({ intervalMs: 60000, signal: controller.signal }); await stream.next();
  const pending = stream.next(); controller.abort();
  await assert.rejects(pending, error => error instanceof SessionError && error.code === 'capture_cancelled');
  assert.equal(wire.requests, 1); assert.equal(display.closed, false); display.close();
  const blocked = new ScreenWire(), other = await DisplayClient.connect(blocked), stop = new AbortController();
  blocked.capture = () => {}; let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; }); blocked.receivePending = entered;
  const next = other.frames({ signal: stop.signal }).next(); await reading; stop.abort();
  await assert.rejects(next, error => error instanceof SessionError && error.code === 'capture_cancelled');
  assert.equal(other.closed, true); assert.equal(blocked.closes, 1); assert.equal(blocked.requests, 1);
});

test('screen disconnect terminates iteration instead of replaying captures', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire); wire.capture = () => {};
  const stream = display.frames(); await assert.rejects(stream.next()); assert.equal(display.closed, true); assert.equal(wire.requests, 1);
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
});

test('APNG recording streams ordered independently decodable frames through a partial writer', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), output: Buffer[] = [];
  let writtenBeforeSecond = false;
  wire.capture = () => { if (wire.requests === 2) writtenBeforeSecond = output.length > 0; wire.frame(wire.requests); };
  const result = await display.record({ write: data => { assert.ok(data.length <= 65536); const count = Math.min(3, data.length); output.push(Buffer.from(data.subarray(0, count))); return count; } }, { frameCount: 3, intervalMs: 1 });
  const bytes = Buffer.concat(output), parsed = chunks(bytes);
  assert.deepEqual(parsed.map(chunk => chunk.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  assert.equal(parsed[1]!.data.readUInt32BE(0), 3); assert.equal(parsed[1]!.data.readUInt32BE(4), 1);
  assert.deepEqual(parsed.filter(chunk => ['fcTL', 'fdAT'].includes(chunk.type)).map(chunk => chunk.data.readUInt32BE(0)), [0, 1, 2, 3, 4]);
  for (const control of parsed.filter(chunk => chunk.type === 'fcTL')) { assert.equal(control.data.readUInt16BE(20), 1); assert.equal(control.data.readUInt16BE(22), 1000); }
  assert.deepEqual(parsed.filter(chunk => ['IDAT', 'fdAT'].includes(chunk.type)).map(chunk => [...inflateSync(chunk.type === 'fdAT' ? chunk.data.subarray(4) : chunk.data)]), [[0, 1, 0, 0, 1, 0, 0], [0, 2, 0, 0, 2, 0, 0], [0, 3, 0, 0, 3, 0, 0]]);
  assert.deepEqual(result, { mediaType: 'image/apng', frames: 3, bytes: bytes.length, width: 2, height: 1, durationMs: 3 });
  assert.equal(writtenBeforeSecond, true); assert.equal(wire.requests, 3); assert.deepEqual(wire.controls, []); assert.equal(display.closed, false); display.close();
});

test('rotation and output budgets fail recordings without a completion marker or further capture', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), output: Buffer[] = [];
  wire.capture = () => wire.frame(wire.requests, wire.requests === 1 ? 2 : 1, wire.requests === 2);
  await assert.rejects(display.record({ write: data => { output.push(Buffer.from(data)); return data.length; } }, { frameCount: 3, intervalMs: 1 }), error => error instanceof SessionError && error.code === 'recording_incomplete');
  assert.equal(wire.requests, 2); assert.equal(chunks(Buffer.concat(output)).some(chunk => chunk.type === 'IEND'), false); display.close();
  const small = new ScreenWire(), other = await DisplayClient.connect(small); let writes = 0;
  await assert.rejects(other.record({ write: data => { writes++; return data.length; } }, { frameCount: 2, maxBytes: 1 }));
  assert.equal(small.requests, 1); assert.equal(writes, 0); other.close();
});

test('recording validates bounds before capture and bounds blocked output and cancellation', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), writer = { write: (data: Uint8Array) => data.length };
  for (const options of [{ frameCount: 0 }, { frameCount: 10001 }, { frameCount: 1, intervalMs: 0 }, { frameCount: 1, maxBytes: Infinity }]) await assert.rejects(display.record(writer, options), ConsumerConfigurationError);
  await assert.rejects(display.record(writer, { frameCount: 1, signal: AbortSignal.abort() }), error => error instanceof SessionError && error.code === 'capture_cancelled');
  assert.equal(wire.requests, 0);
  await assert.rejects(display.record({ write: () => new Promise(() => {}) }, { frameCount: 2, timeoutMs: 10 }), error => error instanceof SessionError && error.code === 'recording_incomplete');
  assert.equal(wire.requests, 1);
  const controller = new AbortController(); let writing!: () => void; const started = new Promise<void>(resolve => { writing = resolve; });
  const recording = display.record({ write: () => { writing(); return new Promise(() => {}); } }, { frameCount: 2, signal: controller.signal });
  await started; controller.abort(); await assert.rejects(recording, error => error instanceof SessionError && error.code === 'capture_cancelled');
  assert.equal(wire.requests, 2); assert.deepEqual(wire.controls, []); display.close();
});

test('recording disconnect and invalid sink results cannot produce complete artifacts', async () => {
  const wire = new ScreenWire(), display = await DisplayClient.connect(wire), output: Buffer[] = [];
  wire.capture = () => { if (wire.requests === 1) wire.frame(1); };
  await assert.rejects(display.record({ write: data => { output.push(Buffer.from(data)); return data.length; } }, { frameCount: 2, intervalMs: 1 }));
  assert.equal(wire.requests, 2); assert.equal(display.closed, true);
  assert.equal(chunks(Buffer.concat(output)).some(chunk => chunk.type === 'IEND'), false);
  const sinkWire = new ScreenWire(), other = await DisplayClient.connect(sinkWire);
  await assert.rejects(other.record({ write: () => 0 }, { frameCount: 1 }), error => error instanceof SessionError && error.code === 'recording_incomplete');
  await assert.rejects(other.record({ write: () => { throw new Error('private sink detail'); } }, { frameCount: 1 }), error => error instanceof SessionError && error.code === 'recording_incomplete' && !error.message.includes('private'));
  assert.equal(other.closed, false); other.close();
});
