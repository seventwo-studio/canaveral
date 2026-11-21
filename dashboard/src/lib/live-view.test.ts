import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeSocket } from "@/test/fake-socket";
import { VIEW_TTL_SECONDS, liveEnding, watchLive } from "./live-view";
import type { LiveEnding, LiveSegment } from "./live-view";

const machine = "11111111-2222-4333-8444-555555555555";
const generation = "4b1f2d9a-7c0e-4e58-9a63-2f0d9c1c6e11";
const response = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});
interface Call {
  path: string;
  method: string;
  body: unknown;
  keepalive: boolean;
}
let calls: Call[], reply: (call: Call) => unknown, sockets: FakeSocket[];
const creating = (call: Call) =>
  call.method === "POST" && call.path.endsWith("/live-views");
const receipt = (call: Call) => ({
  id: (call.body as { id: string }).id,
  machineId: machine,
  generation,
  capability: "live",
  protocol: "canaveral-session-v1",
  state: "pending",
  mediaType: "video/mp4",
  codec: "avc1",
  fps: 30,
  ttlSeconds: 60,
});
function watch() {
  const seen = {
    live: 0,
    inits: [] as [number, number[]][],
    segments: [] as LiveSegment[],
    endings: [] as LiveEnding[],
  };
  const view = watchLive(
    machine,
    {
      onLive: () => seen.live++,
      onInit: (epoch, data) => seen.inits.push([epoch, [...data]]),
      onSegment: (segment) => seen.segments.push(segment),
      onEnd: (ending) => seen.endings.push(ending),
    },
    (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  return { view, seen };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
/** Opens a view up to the broker's `ready`. */
async function ready() {
  const watched = watch();
  await settle();
  const socket = sockets.at(-1)!;
  const id = (
    calls
      .filter(
        (call) => call.method === "POST" && call.path.endsWith("/live-views"),
      )
      .at(-1)!.body as { id: string }
  ).id;
  socket.open();
  socket.control({
    type: "ready",
    sessionId: id,
    generation,
    capability: "live",
  });
  return { ...watched, socket, id };
}
beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  sockets = [];
  reply = (call) => (creating(call) ? receipt(call) : {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        path: url.replace("/api/v1/", ""),
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        keepalive: init.keepalive === true,
      };
      calls.push(call);
      const value = reply(call);
      if (value instanceof Error) throw value;
      return value !== null && typeof value === "object" && "ok" in value
        ? value
        : response(value);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a view opens with a bounded lifetime and attaches to its own generation", async () => {
  const { socket, id, seen } = await ready();
  expect(calls).toEqual([
    {
      path: `machines/${machine}/live-views`,
      method: "POST",
      body: { id, ttlSeconds: VIEW_TTL_SECONDS },
      keepalive: false,
    },
  ]);
  expect(VIEW_TTL_SECONDS).toBeGreaterThanOrEqual(10);
  expect(VIEW_TTL_SECONDS).toBeLessThanOrEqual(120);
  expect(socket.url).toBe(
    `ws://localhost/api/v1/machines/${machine}/live-views/${id}/${generation}`,
  );
  expect(socket.sent).toEqual([]);
  expect(seen.endings).toEqual([]);
});

test("segments are delivered whole and in order, and a renewal reply inside one is not part of it", async () => {
  const { socket, seen } = await ready();
  socket.control({
    type: "live",
    mediaType: "video/mp4",
    codec: "avc1",
    fps: 30,
  });
  expect(seen.live).toBe(1);
  socket.control({ type: "init", epoch: 1, bytes: 5 });
  socket.bytes(new Uint8Array([1, 2]));
  expect(seen.inits).toEqual([]);
  socket.bytes(new Uint8Array([3, 4, 5]));
  expect(seen.inits).toEqual([[1, [1, 2, 3, 4, 5]]]);
  socket.control({
    type: "segment",
    epoch: 1,
    sequence: 0,
    keyframe: true,
    bytes: 4,
  });
  socket.bytes(new Uint8Array([9, 8]));
  // The broker answers a renewal whenever it likes, including between a segment's binary messages.
  socket.control({
    type: "renewal",
    renewed: true,
    authorizationDeadline: "2026-11-21T09:15:03.512Z",
  });
  socket.bytes(new Uint8Array([7, 6]));
  socket.control({
    type: "segment",
    epoch: 1,
    sequence: 3,
    keyframe: true,
    bytes: 1,
  });
  socket.bytes(new Uint8Array([5]));
  // A later epoch starts with its own initialization segment.
  socket.control({ type: "init", epoch: 2, bytes: 1 });
  socket.bytes(new Uint8Array([0]));
  expect(
    seen.segments.map((s) => [s.epoch, s.sequence, s.keyframe, [...s.data]]),
  ).toEqual([
    [1, 0, true, [9, 8, 7, 6]],
    [1, 3, true, [5]],
  ]);
  expect(seen.inits.map(([epoch]) => epoch)).toEqual([1, 2]);
  expect(seen.endings).toEqual([]);
});

test("a view is renewed every third of its lifetime, only while it is watched", async () => {
  const { socket, view } = await ready();
  const third = (VIEW_TTL_SECONDS * 1000) / 3;
  await vi.advanceTimersByTimeAsync(third);
  expect(socket.sent).toEqual(['{"type":"renew"}']);
  await vi.advanceTimersByTimeAsync(third);
  expect(socket.sent).toHaveLength(2);
  // Off screen: nothing is sent, so the view lapses and the device's capture can stop.
  view.setWatched(false);
  await vi.advanceTimersByTimeAsync(third * 2);
  expect(socket.sent).toHaveLength(2);
  // Back on screen: renewed at once, because the lifetime may be nearly spent.
  view.setWatched(true);
  expect(socket.sent).toHaveLength(3);
  view.setWatched(true);
  expect(socket.sent).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(third);
  expect(socket.sent).toHaveLength(4);
  expect(new Set(socket.sent)).toEqual(new Set(['{"type":"renew"}']));
});

test("the host's ending and its refusal to serve are reported in words", async () => {
  let opened = await ready();
  opened.socket.control({
    type: "live",
    mediaType: "video/mp4",
    codec: "avc1",
    fps: 30,
  });
  opened.socket.control({ type: "end", reason: "capture_unavailable" });
  expect(opened.seen.endings).toEqual([liveEnding("capture_unavailable")]);
  expect(opened.seen.endings[0]!.again).toBe("no");
  expect(opened.socket.closed).toBe(true);
  // The controller already ended that view; it is not closed a second time.
  expect(calls.filter((call) => call.path.endsWith("/close"))).toEqual([]);
  // An iOS host that has not opted in answers in-band. That is a state of the host, not a failure.
  opened = await ready();
  opened.socket.control({
    type: "error",
    code: "capability_unsupported",
    message: "Live view is unsupported.",
    outcome: "unknown",
  });
  expect(opened.seen.endings).toEqual([
    {
      reason: "capability_unsupported",
      message:
        "Live view is not offered by this device's host. For iOS it is off unless the host opts in.",
      again: "no",
      state: "Not offered",
    },
  ]);
  // A code this page does not know keeps the host's own sentence.
  opened = await ready();
  opened.socket.control({
    type: "error",
    code: "encoder_gone",
    message: "The encoder exited.",
    outcome: "unknown",
  });
  expect(opened.seen.endings).toEqual([
    { reason: "encoder_gone", message: "The encoder exited.", again: "later" },
  ]);
});

test("a socket that drops reads the controller's reason for the ending", async () => {
  const { socket, id, seen } = await ready();
  reply = (call) =>
    creating(call)
      ? receipt(call)
      : { id, machineId: machine, state: "ended", endReason: "view_expired" };
  socket.close();
  await settle();
  expect(calls.at(-1)).toMatchObject({
    path: `machines/${machine}/live-views/${id}`,
    method: "GET",
  });
  expect(seen.endings).toEqual([
    {
      reason: "view_expired",
      message: "The view lapsed while it was not on screen.",
      again: "now",
      state: "Paused",
    },
  ]);
  // The record cannot be read, for example after the credential ended: the drop itself is reported.
  const next = await ready();
  reply = (call) =>
    creating(call)
      ? receipt(call)
      : response({ error: "Credential rejected." }, 401);
  next.socket.close();
  await settle();
  expect(next.seen.endings.map((ending) => ending.reason)).toEqual([
    "disconnected",
  ]);
});

test("refusals when opening are explained and attach nothing", async () => {
  const cases: [number, string | undefined, Partial<LiveEnding>][] = [
    [404, "not_found", { reason: "not_found", again: "no" }],
    // A leased or stopped device, or a host without capacity for the capture.
    [409, "conflict", { reason: "conflict", again: "later" }],
    [
      409,
      "capability_unsupported",
      { reason: "capability_unsupported", state: "Not offered", again: "no" },
    ],
    [
      409,
      "capture_cleanup_pending",
      { reason: "capture_cleanup_pending", again: "later" },
    ],
    [429, "live_view_limit", { reason: "live_view_limit", state: "Full" }],
    [429, "limit_exceeded", { reason: "limit_exceeded", state: "Full" }],
    [403, "forbidden", { reason: "forbidden", denied: true, again: "no" }],
    [401, "unauthenticated", { reason: "unauthenticated", denied: true }],
    [409, undefined, { reason: "refused", message: "Live view rejected." }],
  ];
  for (const [status, code, expected] of cases) {
    calls = [];
    sockets = [];
    reply = () =>
      response(
        { error: "Live view rejected.", ...(code ? { code } : {}) },
        status,
      );
    const { seen } = watch();
    await settle();
    expect(seen.endings).toHaveLength(1);
    expect(seen.endings[0]).toMatchObject(expected);
    expect(sockets).toEqual([]);
    // A definite refusal created nothing, so nothing is closed.
    expect(calls).toHaveLength(1);
  }
  // A reply that never arrived may have created the view: it is closed by its identifier.
  calls = [];
  reply = (call) =>
    call.path.endsWith("/live-views") ? new Error("offline") : {};
  const { seen } = watch();
  await settle();
  expect(seen.endings[0]).toMatchObject({
    reason: "unavailable",
    again: "now",
  });
  expect(
    calls.map((call) => [
      call.method,
      call.path.replace(/[0-9a-f-]{36}\/close$/, "ID/close"),
    ]),
  ).toEqual([
    ["POST", `machines/${machine}/live-views`],
    ["POST", `machines/${machine}/live-views/ID/close`],
  ]);
});

test("leaving closes the socket and the view; page unload uses a keepalive request", async () => {
  const { socket, id, view, seen } = await ready();
  view.close();
  expect(socket.closed).toBe(true);
  expect(calls.at(-1)).toEqual({
    path: `machines/${machine}/live-views/${id}/close`,
    method: "POST",
    body: {},
    keepalive: false,
  });
  await settle();
  // Leaving is not an ending to report, and a second close does nothing.
  expect(seen.endings).toEqual([]);
  view.close();
  expect(calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);
  const next = await ready();
  next.view.close(true);
  expect(calls.at(-1)).toMatchObject({
    path: `machines/${machine}/live-views/${next.id}/close`,
    keepalive: true,
  });
  // A view closed before its receipt arrived never attaches.
  sockets = [];
  const early = watch();
  early.view.close();
  await settle();
  expect(sockets).toEqual([]);
});

test("a stream that breaks its envelope ends the view and leaves it", async () => {
  const violations: ((socket: FakeSocket, id: string) => void)[] = [
    (socket) => socket.bytes(new Uint8Array([1])),
    (socket) => {
      socket.control({
        type: "segment",
        epoch: 1,
        sequence: 0,
        keyframe: true,
        bytes: 2,
      });
      socket.bytes(new Uint8Array([1, 2, 3]));
    },
    (socket) => {
      socket.control({
        type: "segment",
        epoch: 1,
        sequence: 0,
        keyframe: true,
        bytes: 2,
      });
      socket.control({
        type: "segment",
        epoch: 1,
        sequence: 1,
        keyframe: false,
        bytes: 2,
      });
    },
    (socket) =>
      socket.control({
        type: "segment",
        epoch: 1,
        sequence: 0,
        keyframe: true,
        bytes: 9 * 1048576,
      }),
    (socket) => socket.control({ type: "init", epoch: 1, bytes: 2 * 1048576 }),
    (socket) =>
      socket.control({ type: "segment", epoch: 1, sequence: 0, bytes: 2 }),
    (socket) => {
      socket.control({ type: "init", epoch: 1, bytes: 70000 });
      socket.bytes(new Uint8Array(65537));
    },
    (socket) =>
      socket.control({
        type: "live",
        mediaType: "video/webm",
        codec: "vp9",
        fps: 30,
      }),
    (socket) => socket.control({ type: "finish", bytes: 1 }),
  ];
  for (const violate of violations) {
    const { socket, id, seen } = await ready();
    violate(socket, id);
    expect(seen.endings.map((ending) => ending.reason)).toEqual(["protocol"]);
    expect(socket.closed).toBe(true);
    expect(calls.at(-1)!.path).toBe(
      `machines/${machine}/live-views/${id}/close`,
    );
  }
  // A first message that is not this view's `ready` is refused too.
  const watched = watch();
  await settle();
  sockets.at(-1)!.open();
  sockets.at(-1)!.control({
    type: "ready",
    sessionId: machine,
    generation,
    capability: "live",
  });
  expect(watched.seen.endings.map((ending) => ending.reason)).toEqual([
    "protocol",
  ]);
});

test("a receipt for another view or another kind of session is refused", async () => {
  for (const wrong of [
    { capability: "video" },
    { machineId: generation },
    { generation: "soon" },
    { codec: "hevc" },
    { id: generation },
  ]) {
    sockets = [];
    const base = reply;
    reply = (call) => (creating(call) ? { ...receipt(call), ...wrong } : {});
    const { seen } = watch();
    await settle();
    expect(seen.endings.map((ending) => ending.reason)).toEqual([
      "unavailable",
    ]);
    expect(sockets).toEqual([]);
    reply = base;
  }
});
