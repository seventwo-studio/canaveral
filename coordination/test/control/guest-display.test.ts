import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GuestStreamScreen, connect, ClientMessages, DisplayControls, DisplayEndpoint, InputDenied } from "../../src/guest/display.ts";
import { ServiceError } from "../../src/errors.ts";
import type { GuestRequest } from "../../src/guest/https.ts";
import type { SessionChannel, SessionMessage } from "../../src/control/session-protocol.ts";

const transcript = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../tests/fixtures/native_guest_stream.json"), "utf8")) as { events: { route: string; request: Record<string, unknown> | null; response: Record<string, unknown> }[] };
const frame = transcript.events[0]!.response;
function helper() {
  let owner: string | null = null, sequence = 0, fail = "", busy = false;
  const effects: Record<string, unknown>[] = [], releases: string[] = [], calls: string[] = [];
  const request: GuestRequest = async (route, body) => {
    calls.push(route); if (route === fail) throw new ServiceError("lost fixture", 409);
    if (route === "/v1/display/frame") return structuredClone(frame);
    const stream = body!.streamId as string;
    if (route === "/v1/display/take") {
      if (busy || (owner && owner !== stream)) throw new ServiceError("busy", 409, { code: "input_busy" });
      owner = stream; return { streamId: stream.toUpperCase(), sequence, state: "owned" };
    }
    if (route === "/v1/display/input") { assert.equal(stream, owner); assert.equal(body!.sequence, sequence + 1); sequence++; effects.push(body!.event as Record<string, unknown>); return { streamId: stream, sequence, posted: true }; }
    if (route === "/v1/display/action") { effects.push({ type: "semantic", ...body }); return { id: body!.id, status: "posted" }; }
    if (route === "/v1/display/release") { assert.equal(stream, owner); releases.push(stream); owner = null; sequence = 0; return { released: true }; }
    assert.fail(route);
  };
  return { request, effects, releases, calls, fail: (route: string) => { fail = route; }, busy: (value: boolean) => { busy = value; } };
}
class Queue {
  values: SessionMessage[] = [];
  wake: (() => void) | undefined;
  closed = false;
  push(v: SessionMessage) { this.values.push(v); this.wake?.(); }
  async get(timeout = 3): Promise<SessionMessage | null> {
    if (!this.values.length && !this.closed) await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.wake = undefined; resolve(); }; const timer = setTimeout(done, timeout * 1000); this.wake = done; });
    if (this.closed && !this.values.length) throw new Error("closed");
    return this.values.shift() ?? null;
  }
  close() { this.closed = true; this.wake?.(); }
}
class Channel implements SessionChannel {
  incoming = new Queue(); outgoing = new Queue();
  receive(seconds = 0.1) { return this.incoming.get(seconds); }
  async sendControl(v: Record<string, unknown>) { this.outgoing.push(v); }
  async sendBytes(v: Uint8Array) { this.outgoing.push(Buffer.from(v)); }
  close() { this.incoming.close(); }
  async next() { const v = await this.outgoing.get(); assert.notEqual(v, null); return v!; }
}
function key(down: number, keysym: number): Buffer { const b = Buffer.alloc(8); b[0] = 4; b[1] = down; b.writeUInt32BE(keysym, 4); return b; }
function pointer(mask: number, x: number, y: number): Buffer { const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); return b; }

test("native helper transcript preserves stream/frame identities, modifiers and drag edges", async () => {
  const pending = structuredClone(transcript.events), stream = (pending[1]!.request!.streamId as string).toLowerCase();
  const screen = new GuestStreamScreen(async (route, body) => {
    const e = pending.shift()!; assert.equal(route, e.route);
    const normalize = (v: Record<string, unknown> | null) => v === null ? null : Object.fromEntries(Object.entries(v).map(([k, value]) => [k, ["streamId", "frameId"].includes(k) ? String(value).toLowerCase() : value]));
    const mapped = body === null ? null : { ...body, ...(body.streamId ? { streamId: stream } : {}) }; assert.deepEqual(normalize(mapped), normalize(e.request)); return body?.streamId && e.response.streamId ? { ...e.response, streamId: body.streamId } : e.response;
  }, () => true);
  await screen.capture();
  await screen.takeInput(); await screen.key(1, 0xffe3); await screen.key(1, 99); await screen.key(0, 99); await screen.pointer(1, 3, 2); await screen.pointer(0, 3, 2); await screen.key(0, 0xffe3);
  assert.equal(await screen.resetInput(), true); assert.equal(pending.length, 0);
});
test("busy is definite, lost input/claims are fenced without replay, revoked cleanup stays scoped", async () => {
  const h = helper(); let live = true;
  const screen = new GuestStreamScreen(h.request, () => live, () => true);
  await screen.capture(); h.busy(true); assert.equal(await screen.takeInput(), "busy"); assert.equal(screen.uncertain, false);
  h.busy(false); assert.equal(await screen.takeInput(), "owned");
  await screen.key(1, 65); live = false; await assert.rejects(screen.key(0, 65)); assert.equal(h.effects.length, 1);
  assert.equal(await screen.resetInput(), true);
  live = true; await screen.takeInput(); h.fail("/v1/display/input");
  await assert.rejects(screen.key(1, 66)); await assert.rejects(screen.key(0, 66));
  assert.equal(await screen.takeInput(), "reset-uncertain"); assert.equal(h.calls.filter(r => r === "/v1/display/input").length, 2);
  h.fail(""); await screen.closeInput();
  const lost = helper(), other = new GuestStreamScreen(lost.request, () => true); lost.fail("/v1/display/take");
  assert.equal(await other.takeInput(), "reset-uncertain"); assert.equal(await other.takeInput(), "reset-uncertain"); assert.equal(lost.calls.length, 1);
});
test("stale/read-only capture retry is bounded; malformed frames never adopt a new input binding", async () => {
  const h = helper(); let calls = 0;
  const screen = new GuestStreamScreen(async (route, body) => { if (calls++ === 0) throw new ServiceError("busy", 409, { code: "input_busy" }); return h.request(route, body); }, () => true);
  await screen.capture(); assert.equal(calls, 2);
  const issued = screen.frame; await screen.takeInput();
  for (const point of [[4, 0], [0, 3], [-1, 0], [true, 0]]) await assert.rejects(screen.pointer(1, point[0] as number, point[1] as number));
  assert.equal(h.effects.length, 0); assert.equal(screen.frame, issued);
  for (const payload of [{ ...frame, displayID: true }, { ...frame, bounds: { x: 0, y: 0, width: Infinity, height: 1 } }, { ...frame, frame: { ...(frame.frame as object), pngBase64: "!!!!" } }]) await assert.rejects(new GuestStreamScreen(async () => payload, () => true).capture());
  await screen.closeInput();
});
test("ownership ledger survives restart, refuses missing/older boot proof and permits a newer boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-display-"));
  try {
    const file = join(dir, "claims.sqlite"), machine = randomUUID(), boot = { identity: "one", startedAt: 1 };
    const controls = new DisplayControls(file); assert.equal(controls.claim(machine, "one", boot, () => true), "owned");
    const recovered = new DisplayControls(file); assert.equal(recovered.claim(machine, "two", boot, () => true), "reset-uncertain");
    assert.equal(recovered.claim(machine, "two", null, () => true), "stale");
    assert.equal(recovered.claim(machine, "two", { identity: "older", startedAt: 0 }, () => true), "stale");
    assert.equal(recovered.claim(machine, "two", { identity: "new", startedAt: 2 }, () => false), "stale");
    assert.equal(recovered.claim(machine, "two", { identity: "new", startedAt: 2 }, () => true), "owned");
    recovered.release(machine, "old-owner", boot, true); assert.equal(recovered.owns(machine, "two", { identity: "new", startedAt: 2 }), true);
    await assert.rejects(recovered.discrete(machine, randomUUID(), () => ({ identity: "new", startedAt: 2 }), () => true, async () => true), InputDenied);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("RFB parser handles fragments and excludes extensions, invalid key states and oversized controls", () => {
  const parser = new ClientMessages(), enc = Buffer.alloc(16); enc[0] = 2; enc.writeUInt16BE(3, 2); [-260, -258, -308].forEach((n, i) => enc.writeInt32BE(n, 4 + i * 4));
  const frames = Array.from(enc).flatMap(n => parser.feed(Buffer.from([n]))); assert.equal(frames.length, 1); assert.equal(frames[0]![1].length, 8); assert.equal(frames[0]![1].readInt32BE(4), -260);
  for (const bad of [Buffer.from([249]), key(2, 1), Buffer.alloc(81921), Buffer.from([2, 0, 1, 1]), Buffer.from([6, 0, 0, 0, 0, 0, 0x3e, 0x81])]) assert.throws(() => new ClientMessages().feed(bad));
});
test("two shared viewers start view-only; native claim precedes ownership; uncertain semantic actions block handover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guest-viewers-")), h = helper(), machine = randomUUID(), controls = new DisplayControls(join(dir, "claims.sqlite"));
  const endings: Promise<void>[] = [], channels: Channel[] = [];
  const start = async () => {
    const channel = new Channel(); channels.push(channel);
    const endpoint = new DisplayEndpoint(controls, machine, () => connect(h.request, () => true), () => true, { epoch: () => ({ identity: "boot", startedAt: 1 }), actionHandler: async () => ({ state: "unknown" }) });
    endings.push(endpoint.runDisplay(channel).catch(() => {}));
    assert.equal(Buffer.from(await channel.next() as Uint8Array).toString(), "RFB 003.008\n"); channel.incoming.push(Buffer.from("RFB 003.008\n"));
    assert.deepEqual(await channel.next(), Buffer.from([1, 1])); channel.incoming.push(Buffer.from([1]));
    assert.deepEqual(await channel.next(), Buffer.alloc(4)); channel.incoming.push(Buffer.from([0]));
    const header = Buffer.from(await channel.next() as Uint8Array); assert.equal(header.readUInt16BE(0), 4); assert.equal(header.readUInt16BE(2), 3);
    assert.deepEqual(await channel.next(), { type: "control", state: "view-only" }); return { channel, endpoint };
  };
  const command = async (c: Channel, action: string, state: string) => { c.incoming.push({ type: "input-control", action }); assert.deepEqual(await c.next(), { type: "control", state }); };
  try {
    const a = await start(), b = await start();
    a.channel.incoming.push(key(1, 65)); assert.deepEqual(await a.channel.next(), { type: "control", state: "view-only" }); assert.equal(h.effects.length, 0);
    await command(a.channel, "take", "owned"); await command(b.channel, "take", "busy");
    for (const byte of Buffer.concat([key(1, 0xffe3), key(1, 99), key(0, 99), pointer(1, 0, 0), pointer(1, 3, 2), pointer(0, 3, 2), key(0, 0xffe3)])) a.channel.incoming.push(Buffer.from([byte]));
    await command(a.channel, "release", "view-only"); assert.equal(h.effects.length, 7); assert.equal(h.releases.length, 1);
    await command(b.channel, "take", "owned");
    b.channel.incoming.push({ type: "action", id: randomUUID(), action: "text", arguments: { text: "uncertain" } });
    assert.deepEqual(await b.channel.next(), { type: "control", state: "reset-uncertain" }); assert.equal((await b.channel.next() as Record<string, unknown>).state, "unknown");
    await command(a.channel, "take", "reset-uncertain");
    a.endpoint.close(); b.endpoint.close(); await Promise.all(endings);
  } finally { channels.forEach(c => c.close()); await controls.close(); await Promise.all(endings); rmSync(dir, { recursive: true, force: true }); }
});
