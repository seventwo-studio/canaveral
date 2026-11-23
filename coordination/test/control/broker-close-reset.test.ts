import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { SessionConnection, Transport } from "../../src/sdk.ts";
import { LiveStream, VideoClient } from "../../src/video-sdk.ts";
import type { LiveView } from "../../src/video-sdk.ts";

/** The SDK's stream clients against a real socket whose broker closes it. The broker ends a pair
 * by destroying its sockets, and it pings each peer every ten seconds. A pong the client sends in
 * answer to a ping that arrived just before the close reaches a closed socket, so the connection is
 * reset instead of ended in order. These stand-ins force that ordering: they ping, wait for the
 * pong and only then reset, as a close with that pong unread does. */
type Frame = { opcode: number; data: Buffer };
function frame(opcode: number, data: Buffer): Buffer {
  const header = data.length < 126 ? Buffer.from([0x80 | opcode, data.length]) : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([header, data]);
}
const PING = frame(9, Buffer.from("canaveral"));
const text = (value: Record<string, unknown>) => frame(1, Buffer.from(JSON.stringify(value)));
async function broker(t: test.TestContext, script: { opened(socket: Socket): void; received(socket: Socket, frame: Frame): void }): Promise<{ url: string; reset: Promise<void> }> {
  let resetDone!: () => void;
  const reset = new Promise<void>(resolve => { resetDone = resolve; });
  const server = http.createServer();
  server.on("upgrade", (request, socket: Socket) => {
    socket.on("error", () => {});
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    script.opened(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Client frames here are small and masked: two header bytes, the mask, then the payload.
      while (buffer.length >= 6 && buffer.length >= 6 + (buffer[1]! & 127)) {
        const size = buffer[1]! & 127, mask = buffer.subarray(2, 6), data = Buffer.alloc(size);
        for (let i = 0; i < size; i++) data[i] = buffer[6 + i]! ^ mask[i % 4]!;
        const opcode = buffer[0]! & 15; buffer = buffer.subarray(6 + size);
        if (opcode === 10) { socket.resetAndDestroy(); resetDone(); return; }
        script.received(socket, { opcode, data });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reset };
}
async function connect(url: string, path: string, id: string): Promise<SessionConnection> {
  return SessionConnection.connect(new Transport({ baseUrl: url, allowLoopbackHttp: true }, randomBytes(32).toString("base64url")), path, id);
}

const VIEW = randomUUID();
function view(state: LiveView["state"], endReason?: string): LiveView {
  const now = Date.now();
  return { id: VIEW, machineId: randomUUID(), captureId: randomUUID(), generation: randomUUID(), capability: "live", protocol: "canaveral-session-v1", state,
    ...(endReason ? { endReason } : {}), mediaType: "video/mp4", codec: "avc1", fps: 30, bitRate: 4_000_000, ttlSeconds: 120,
    attachBefore: new Date(now + 30_000).toISOString(), authorizationDeadline: new Date(now + 120_000).toISOString(), leaseId: randomUUID(), member: "primary" };
}

test("a live stream reset as the broker ends its view reports the view's recorded reason, not a connection failure", async t => {
  const b = await broker(t, { opened: socket => socket.write(PING), received: () => {} });
  const connection = await connect(b.url, `/v1/leases/${randomUUID()}/live-views/${VIEW}/${randomUUID()}`, VIEW);
  t.after(() => connection.close());
  let inspected = 0;
  const stream = new LiveStream(connection, view("ready"), {}, async () => { inspected++; return view("ended", "lease_expired"); });
  const result = await stream.segments().next();
  await b.reset;
  assert.deepEqual(result, { done: true, value: { reason: "lease_expired", source: "controller" } });
  assert.deepEqual(stream.ended, { reason: "lease_expired", source: "controller" });
  assert.equal(inspected, 1);
});

test("a worker's error control still ends a live stream with that error", async () => {
  const messages: unknown[] = [{ type: "error", code: "session_incomplete", message: "native capture ended early", outcome: "unknown" }];
  const channel = { sessionId: VIEW, async sendControl() {}, async sendBytes() {}, async receive() { return (messages.shift() ?? null) as Record<string, unknown> | null; }, close() {} };
  let inspected = 0;
  const stream = new LiveStream(channel, view("ready"), {}, async () => { inspected++; return view("ended", "lease_expired"); });
  await assert.rejects(stream.segments().next(), (error: Error & { code?: string }) => error.code === "session_incomplete");
  assert.equal(inspected, 0); assert.equal(stream.ended, undefined);
});

function box(type: string, data = Buffer.alloc(0)): Buffer { const b = Buffer.alloc(8); b.writeUInt32BE(8 + data.length); b.write(type, 4); return Buffer.concat([b, data]); }
const MP4 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov"), box("moof"), box("mdat", Buffer.from("encoded-native-samples"))]);
const FINISH = { type: "finish", bytes: MP4.length, sha256: createHash("sha256").update(MP4).digest("hex"), cleaned: true };

test("a verified recording whose connection is reset after its acknowledgement is complete", async t => {
  const acks: unknown[] = [];
  const b = await broker(t, {
    opened: socket => socket.write(Buffer.concat([text({ type: "video", mediaType: "video/mp4", codec: "avc1", fps: 30 }), frame(2, MP4), text(FINISH)])),
    // The host has the ACK and closes; the broker's heartbeat crosses that close.
    received: (socket, { opcode, data }) => { if (opcode === 1) { acks.push(JSON.parse(data.toString())); socket.write(PING); } },
  });
  const id = randomUUID(), connection = await connect(b.url, `/v1/leases/${randomUUID()}/video-sessions/${id}/${randomUUID()}`, id);
  t.after(() => connection.close());
  const out: Buffer[] = [], video = await VideoClient.connect(connection);
  const result = await video.record({ write: bytes => { out.push(Buffer.from(bytes)); return bytes.length; } });
  await b.reset;
  assert.deepEqual(acks, [{ type: "ack" }]);
  assert.deepEqual(result, FINISH); assert.deepEqual(Buffer.concat(out), MP4);
});

test("a recording whose connection is reset before its finish stays incomplete", async t => {
  const b = await broker(t, { opened: socket => socket.write(Buffer.concat([text({ type: "video", mediaType: "video/mp4", codec: "avc1", fps: 30 }), frame(2, MP4), PING])), received: () => {} });
  const id = randomUUID(), connection = await connect(b.url, `/v1/leases/${randomUUID()}/video-sessions/${id}/${randomUUID()}`, id);
  t.after(() => connection.close());
  const video = await VideoClient.connect(connection);
  await assert.rejects(video.record({ write: bytes => bytes.length }), (error: Error & { code?: string }) => error.code === "session_incomplete");
  await b.reset;
  assert.equal(video.finish, undefined);
});
