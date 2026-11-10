import test from "node:test";
import assert from "node:assert/strict";
import { WindowsHeldInput, neutral, validateState, type HeldState, type InputEvent, type KeyCode } from "../../src/guest/windows/input.ts";
import { WindowsKeys, type Layout, type WindowsKeyAPI } from "../../src/guest/windows/keys.ts";
import { Win32Desktop, pngBGRA } from "../../src/guest/windows/desktop.ts";
const bounds = [0, 0, 100, 100] as const;
function fixture() {
  const events: InputEvent[][] = [], saved: HeldState[] = []; let fail = false;
  const input = new WindowsHeldInput({ post: value => { events.push(value); if (fail) throw new Error("private failure"); return { posted: true }; } }, () => ({ codes: [[0, 30, 8]] }), state => { saved.push(state); return true; }, () => true);
  return { input, events, saved, fail: () => { fail = true; } };
}
test("held key repeats/releases retain native descriptors without layout re-resolution", async () => {
  let resolutions = 0; const events: InputEvent[] = [];
  const held = new WindowsHeldInput({ post: e => { events.push(...e); return { posted: true }; } }, () => ({ codes: [[0, ++resolutions, 8]] }), () => true, () => true);
  assert.deepEqual(await held.key(65, false, bounds), { posted: false }); await held.key(65, true, bounds); await held.key(65, true, bounds); await held.key(65, false, bounds); assert.equal(resolutions, 1); assert.deepEqual(events.map(e => e.kind === "key" ? [e.scan, e.flags] : []), [[1, 8], [1, 8], [1, 10]]);
});
test("uncertain button swaps retain union until release-only reset", async () => {
  const f = fixture(); await f.input.pointer(1, 2, 1, bounds); f.fail(); await assert.rejects(f.input.pointer(1, 2, 4, bounds), { outcome: "unknown" }); assert.equal(f.input.state.buttons, 5); assert.equal(f.input.state.blocked, true);
  await assert.rejects(f.input.pointer(1, 2, 0, bounds)); assert.equal(f.events.length, 2); assert.deepEqual(f.events[1]!.slice(1), [{ kind: "mouse", flags: 4, data: 0, x: 0, y: 0 }, { kind: "mouse", flags: 8, data: 0, x: 0, y: 0 }]);
});
test("save failure posts nothing and failed final persistence retains release candidates", async () => {
  let calls = 0, posts = 0;
  const held = new WindowsHeldInput({ post: () => { posts++; return { posted: true }; } }, () => ({ codes: [[0, 30, 8]] }), () => ++calls !== 2, () => true);
  await assert.rejects(held.key(65, true, bounds)); assert.equal(posts, 1); assert.equal(held.state.keys.length, 1); assert.equal(held.state.blocked, true); await held.reset(); assert.deepEqual(held.state, neutral());
  const failed = new WindowsHeldInput({ post: () => { throw new Error("must not post"); } }, () => ({ codes: [[0, 30, 8]] }), () => false, () => true); await assert.rejects(failed.key(65, true, bounds)); assert.equal(failed.state.blocked, true);
});
test("Unicode batching preserves surrogate pairs and unknown text releases", async () => {
  let calls = 0; const saved: HeldState[] = [], posted: InputEvent[][] = [];
  const held = new WindowsHeldInput({ post: events => { posted.push(events); if (++calls === 2) throw new Error("unknown"); return { posted: true }; } }, () => ({ codes: [[0, 30, 8]] }), s => { saved.push(s); return true; }, () => true);
  await assert.rejects(held.text("a".repeat(1023) + "😀" + "z".repeat(2000), bounds), { outcome: "unknown" }); assert.equal(posted.length, 2); assert.equal(posted[0]!.length, 2046); assert.equal(held.state.blocked, true); assert(held.state.transient.some(c => c[1] === 0xd83d)); assert(held.state.transient.some(c => c[1] === 0xde00)); assert(saved[0]!.blocked);
});
test("native alias ownership, malformed recovery and conflicting wheels refuse before effects", async () => {
  const f = fixture(); await f.input.key(65, true, bounds); await assert.rejects(f.input.key(66, true, bounds)); assert.equal(f.events.length, 1); await assert.rejects(f.input.pointer(1, 2, 24, bounds));
  assert.throws(() => validateState({ ...neutral(), transient: [[0, 65, 4]] })); assert.throws(() => validateState({ ...neutral(), keys: [{ keysym: 65, codes: [[0, 0xd800, 4]] }] }));
});
test("pre-post layout barrier rejects changes after pending persistence", async () => {
  let layout: Layout = ["1", 1, "1"], posts = 0;
  const api: WindowsKeyAPI = { layout: () => layout, scan: () => 30, map: () => 65, translate: () => "a" };
  const keys = new WindowsKeys(api, () => true);
  const held = new WindowsHeldInput({ post: () => { posts++; return { posted: true }; } }, keys.resolve, () => { layout = ["1", 1, "2"]; return true; }, () => true);
  await assert.rejects(held.key(0xffe3, true, bounds)); assert.equal(posts, 0); assert.equal(held.state.blocked, true);
});
test("keys preserve left/right and keypad scan distinctions, supplementary Unicode and AltGr", async () => {
  const api: WindowsKeyAPI = { layout: () => ["1", 1, "1"], scan: vk => vk === 0xa3 ? 0xe01d : vk === 13 ? 28 : 30, map: () => 65 | (6 << 8), translate: () => "€" };
  const keys = new WindowsKeys(api, () => true);
  assert.deepEqual((await keys.resolve(0xffe4, 0)).codes, [[0, 29, 9]]); assert.deepEqual((await keys.resolve(0xff8d, 0)).codes, [[0, 28, 9]]); assert.deepEqual((await keys.resolve(0x0101f600, 0)).codes, [[0, 0xd83d, 4], [0, 0xde00, 4]]);
  await assert.rejects(keys.resolve(0x010020ac, 4)); assert.deepEqual((await keys.resolve(0x010020ac, 20)).codes, [[0, 30, 8]]); await assert.rejects(keys.resolve(0xff13, 0));
});
test("desktop partial SendInput fences ordinary access even after cleanup reset", async () => {
  let partial = true;
  const desktop = new Win32Desktop({ geometry: () => bounds, capture: () => ({ bounds, pixels: Buffer.alloc(100 * 100 * 4) }), post: events => partial ? 0 : events.length, close: () => true }, () => true);
  await assert.rejects(desktop.post([{ kind: "key", vk: 0, scan: 30, flags: 8 }], bounds, false), { outcome: "unknown" }); partial = false;
  await desktop.post([{ kind: "key", vk: 0, scan: 30, flags: 10 }], null, true); await assert.rejects(desktop.post([{ kind: "key", vk: 0, scan: 30, flags: 8 }], bounds, false));
  await assert.rejects(desktop.post([{ kind: "mouse", flags: 0xc001, data: 0, x: 0, y: 0 }], null, true));
});
test("PNG converts top-down BGRA into a bounded RGB PNG", () => { const png = pngBGRA(1, 1, Buffer.from([10, 20, 30, 0])); assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(png.readUInt32BE(16), 1); assert.equal(png.readUInt32BE(20), 1); });
