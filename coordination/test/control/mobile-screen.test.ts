import test from "node:test";
import assert from "node:assert/strict";
import { SimulatorScreen, compactLength, dimensions } from "../../src/providers/mobile.ts";
import type { DeviceRequest, NativePipe, RecordValue } from "../../src/providers/mobile.ts";
function png(width = 1080, height = 2400): Buffer { const value = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(value); value.writeUInt32BE(13, 8); value.write("IHDR", 12); value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value; }
function screen(system = "android") {
  const calls: DeviceRequest[] = []; let density = 3, observations = 0, allowed = true, frame = png();
  const provider = { control: async (_m: RecordValue, _i: RecordValue, _folder: string, request: DeviceRequest) => { calls.push(request); return { data: frame.toString("base64") }; }, displayDensity: async () => { observations++; return density; } };
  const value = new SimulatorScreen(provider, { id: "fixture" }, { os: system }, "/fixture", () => allowed); value.size = [1080, 2400];
  return { value, calls, get observations() { return observations; }, setDensity: (n: number) => { density = n; }, revoke: () => { allowed = false; }, rotate: () => { frame = png(2400, 1080); } };
}

test("PNG dimensions and TightPNG compact lengths preserve bounded binary framing", () => {
  assert.deepEqual(dimensions(png()), [1080, 2400]); assert.throws(() => dimensions(Buffer.from("not PNG"))); assert.throws(() => dimensions(png(0, 10))); assert.deepEqual(compactLength(128), Buffer.from([0x80, 1])); assert.deepEqual(compactLength(16384), Buffer.from([0x80, 0x80, 1])); assert.throws(() => compactLength(4194304));
});

test("iOS gestures use one scale observation, and unsupported scales dispatch no input", async () => {
  const f = screen("ios"); await f.value.pointer(1, 300, 600); await f.value.pointer(0, 600, 900);
  assert.deepEqual({ ...f.calls.at(-1)!.arguments, durationMs: 0 }, { x: 100, y: 200, toX: 200, toY: 300, durationMs: 0 }); assert.equal(f.observations, 1);
  await f.value.pointer(8, 300, 600); assert.equal(f.observations, 2);
  await f.value.key(true, 0xff0d); assert.deepEqual(f.calls.at(-1)!.arguments, { key: "40" }); await f.value.key(false, 0xff0d); assert.equal(f.calls.length, 3);
  for (const density of [0, -1, NaN, Infinity, 1e-320]) { const invalid = screen("ios"); invalid.setDensity(density); await invalid.value.pointer(1, 300, 600); await assert.rejects(invalid.value.pointer(0, 300, 600)); assert.deepEqual(invalid.calls, []); assert.equal(invalid.value.pressed, undefined); }
});

test("revocation, rotation and reset barriers cannot turn stale mouse-down into native input", async () => {
  const f = screen(); await f.value.pointer(1, 100, 200); assert.equal(f.value.resetInput(), true); await f.value.pointer(0, 100, 200); assert.deepEqual(f.calls, []);
  await f.value.pointer(1, 100, 200); f.rotate(); const frame = await f.value.frame(new Set([-260, -223])); assert.equal(frame.readUInt16BE(2), 2); assert.equal(frame.readInt32BE(12), -223); assert.equal(f.value.pressed, undefined);
  f.revoke(); const before = f.calls.length; await assert.rejects(f.value.capture(), /authorization/); assert.equal(f.calls.length, before);
});

test("private RFB duplex performs handshake, demand captures and discrete input without durable operations", async () => {
  const f = screen(), encodings = Buffer.alloc(12); encodings[0] = 2; encodings.writeUInt16BE(2, 2); encodings.writeInt32BE(-260, 4); encodings.writeInt32BE(-223, 8);
  const request = Buffer.from([3, 0, 0, 0, 0, 0, 4, 56, 9, 96]), pointer = (mask: number) => { const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(50, 2); b.writeUInt16BE(60, 4); return b; }, key = Buffer.alloc(8); key[0] = 4; key[1] = 1; key.writeUInt32BE(97, 4);
  const input = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1]), encodings, request, pointer(1), pointer(0), key, request]), output: Buffer[] = []; let offset = 0, closed = false;
  const pipe: NativePipe = { read: async count => { const b = input.subarray(offset, offset + Math.min(count, 3)); offset += b.length; return b; }, write: async data => { output.push(Buffer.from(data)); return data.length; }, end: async () => {}, wait: async () => 0, close: async () => { closed = true; } };
  await assert.rejects(f.value.serve(pipe), /interrupted/);
  assert.equal(Buffer.concat(output).subarray(0, 12).toString(), "RFB 003.008\n"); assert.ok(closed); assert.equal(f.calls.filter(c => c.action === "screenshot").length, 3);
  assert.deepEqual(f.calls.filter(c => c.action !== "screenshot").map(c => [c.action, c.arguments]), [["tap", { x: 50, y: 60 }], ["text", { text: "a" }]]);
});
