import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureFileName,
  closeVideoSession,
  recordVideo,
  screenshotPng,
  type VideoSessionReceipt,
} from "./mobile-capture";
import { FakeSocket } from "@/test/fake-socket";

const machine = "0b8b0d4e-3a52-4c55-9bd4-1f5ac2b5a4f0";
const generation = "4b1f2d9a-7c0e-4e58-9a63-2f0d9c1c6e11";
const mp4 = new Uint8Array(
  readFileSync(resolve(process.cwd(), "e2e/fixtures/capture.mp4")),
);
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

let session: VideoSessionReceipt;
function stubApi() {
  const calls: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path, body });
      if (path === `/api/v1/machines/${machine}/video-sessions`)
        session = {
          id: body.id,
          machineId: machine,
          generation,
          state: "pending",
        };
      return Response.json({
        ...session,
        capability: "video",
        protocol: "canaveral-session-v1",
        state: path.endsWith("/close") ? "disconnected" : session.state,
      });
    }),
  );
  return calls;
}
async function start(signal = new AbortController().signal) {
  let socket!: FakeSocket;
  const states: string[] = [];
  const result = recordVideo(machine, {
    durationSeconds: 10,
    signal,
    onSession: () => {},
    onProgress: (state) => states.push(state),
    socket: (url) => (socket = new FakeSocket(url)) as unknown as WebSocket,
  });
  await vi.waitFor(() => expect(socket).toBeDefined());
  socket.open();
  socket.control({
    type: "ready",
    sessionId: session.id,
    generation,
    capability: "video",
  });
  socket.control({
    type: "video",
    mediaType: "video/mp4",
    codec: "avc1",
    fps: 30,
  });
  return { socket, result, states };
}
function stream(socket: FakeSocket, data: Uint8Array) {
  for (let at = 0; at < data.length; at += 65536)
    socket.bytes(data.subarray(at, at + 65536));
}
afterEach(() => vi.unstubAllGlobals());

it("names captures portably", () => {
  expect(captureFileName("  Onboarding / step 1.png ", "png")).toBe(
    "Onboarding - step 1.png",
  );
  expect(captureFileName("demo.mp4", "mp4")).toBe("demo.mp4");
  expect(() => captureFileName(" ../ ", "png")).toThrow(/file name/);
});

it("accepts only PNG screenshot results", () => {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 176,
    0, 0, 10, 62, 8, 6, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const data = btoa(String.fromCharCode(...png));
  expect(screenshotPng({ data, mediaType: "image/png" })).toMatchObject({
    width: 1200,
    height: 2622,
  });
  expect(() => screenshotPng({ data, mediaType: "image/jpeg" })).toThrow();
  expect(() =>
    screenshotPng({ data: btoa("not a png"), mediaType: "image/png" }),
  ).toThrow(/not a valid PNG/);
});

it("acknowledges only a verified complete MP4 and finishes when the host closes", async () => {
  const calls = stubApi();
  const { socket, result, states } = await start();
  expect(socket.url).toBe(
    `ws://localhost/api/v1/machines/${machine}/video-sessions/${session.id}/${generation}`,
  );
  expect(calls[0]!.body).toMatchObject({
    fps: 30,
    durationSeconds: 10,
    bitRate: 4000000,
  });
  stream(socket, mp4);
  socket.control({
    type: "finish",
    bytes: mp4.length,
    sha256: sha(mp4),
    cleaned: true,
  });
  await vi.waitFor(() => expect(socket.sent).toEqual(['{"type":"ack"}']));
  socket.close();
  const recording = await result;
  expect(recording).toMatchObject({
    bytes: mp4.length,
    sha256: sha(mp4),
    frames: 31,
    width: 64,
    height: 112,
  });
  expect(recording.data).toEqual(mp4);
  expect(states).toContain("verifying");
});

it("treats checksum, truncation, early close and host errors as failures without acknowledging", async () => {
  stubApi();
  const cases: Array<[string, (socket: FakeSocket) => void, RegExp]> = [
    [
      "checksum",
      (s) => {
        stream(s, mp4);
        s.control({
          type: "finish",
          bytes: mp4.length,
          sha256: "0".repeat(64),
          cleaned: true,
        });
      },
      /checksum/,
    ],
    [
      "truncated",
      (s) => {
        const cut = mp4.subarray(0, mp4.length - 500);
        stream(s, cut);
        s.control({
          type: "finish",
          bytes: cut.length,
          sha256: sha(cut),
          cleaned: true,
        });
      },
      /not a complete MP4/,
    ],
    [
      "byte count",
      (s) => {
        stream(s, mp4);
        s.control({
          type: "finish",
          bytes: mp4.length + 1,
          sha256: sha(mp4),
          cleaned: true,
        });
      },
      /size or cleanup/,
    ],
    [
      "early close",
      (s) => {
        stream(s, mp4.subarray(0, 1000));
        s.close();
      },
      /closed before a verified completion/,
    ],
    [
      "host error",
      (s) =>
        s.control({
          type: "error",
          code: "session_incomplete",
          message: "Native video capture did not complete.",
          outcome: "unknown",
        }),
      /did not complete\. The recording is incomplete/,
    ],
  ];
  for (const [, act, error] of cases) {
    const { socket, result } = await start();
    act(socket);
    await expect(result).rejects.toThrow(error);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBe(true);
  }
});

it("cancellation closes the stream and reports no file", async () => {
  stubApi();
  const abort = new AbortController();
  const { socket, result } = await start(abort.signal);
  stream(socket, mp4.subarray(0, 2000));
  abort.abort();
  await expect(result).rejects.toThrow(/cancelled/);
  expect(socket.closed).toBe(true);
});

it("closes sessions through the supported route, including on unload", async () => {
  const calls = stubApi();
  session = { id: "s", machineId: machine, generation, state: "ready" };
  await closeVideoSession(machine, "s");
  await closeVideoSession(machine, "s", true);
  expect(calls.map((c) => [c.path, c.body])).toEqual([
    [`/api/v1/machines/${machine}/video-sessions/s/close`, {}],
    [`/api/v1/machines/${machine}/video-sessions/s/close`, {}],
  ]);
  const keepalive = vi.mocked(fetch).mock.calls[1]![1]!;
  expect(keepalive).toMatchObject({ method: "POST", keepalive: true });
});
