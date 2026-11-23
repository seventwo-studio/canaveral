import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { SessionConnection, Transport } from "../../src/sdk.ts";
import { LiveStream } from "../../src/video-sdk.ts";
import type { LiveView } from "../../src/video-sdk.ts";

/** The SDK's live stream against a real socket whose broker closes it. The broker ends a view by
 * destroying its sockets; a pong the viewer sends in answer to the broker's heartbeat ping, just as
 * that happens, reaches a closed socket and draws a reset instead of an orderly end. */
function view(state: LiveView["state"], endReason?: string): LiveView {
  const now = Date.now();
  return { id: VIEW, machineId: randomUUID(), captureId: randomUUID(), generation: randomUUID(), capability: "live", protocol: "canaveral-session-v1", state,
    ...(endReason ? { endReason } : {}), mediaType: "video/mp4", codec: "avc1", fps: 30, bitRate: 4_000_000, ttlSeconds: 120,
    attachBefore: new Date(now + 30_000).toISOString(), authorizationDeadline: new Date(now + 120_000).toISOString(), leaseId: randomUUID(), member: "primary" };
}
const VIEW = randomUUID();

/** A broker stand-in: accepts the upgrade, sends one heartbeat ping and, once the viewer's pong has
 * arrived, resets the connection the way a close with that pong unread does. */
async function resettingBroker(t: test.TestContext): Promise<{ url: string; reset: Promise<void> }> {
  let resetDone!: () => void;
  const reset = new Promise<void>(resolve => { resetDone = resolve; });
  const server = http.createServer();
  server.on("upgrade", (request, socket: Socket) => {
    socket.on("error", () => {});
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    socket.write(Buffer.from([0x89, 4, ...Buffer.from("ping")]));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // A masked pong: opcode 10, then length, mask and payload.
      if (received.length >= 2 && (received[0]! & 15) === 10 && received.length >= 6 + (received[1]! & 127)) { socket.resetAndDestroy(); resetDone(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reset };
}

test("a live stream whose connection is reset as the broker ends it reports the view's recorded reason, not a connection failure", async t => {
  const broker = await resettingBroker(t);
  const connection = await SessionConnection.connect(new Transport({ baseUrl: broker.url, allowLoopbackHttp: true }, randomBytes(32).toString("base64url")), `/v1/leases/${randomUUID()}/live-views/${VIEW}/${randomUUID()}`, VIEW);
  t.after(() => connection.close());
  let inspected = 0;
  const stream = new LiveStream(connection, view("ready"), {}, async () => { inspected++; return view("ended", "lease_expired"); });
  const iterator = stream.segments();
  const result = await iterator.next();
  await broker.reset;
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
