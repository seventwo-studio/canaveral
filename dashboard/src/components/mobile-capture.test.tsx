import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileCapture } from "./mobile-capture";
import { FakeSocket } from "@/test/fake-socket";
import type { Machine } from "@/lib/inventory";

const machine = {
  id: "0b8b0d4e-3a52-4c55-9bd4-1f5ac2b5a4f0",
  hostId: "host",
  ownerId: "owner",
  observed: "running",
  desired: "running",
  ready: true,
  template: { os: "ios", mode: "device" },
} as Machine;
const png = btoa(
  String.fromCharCode(
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    3,
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function stub() {
  const calls: Array<[string, unknown]> = [];
  const sockets: FakeSocket[] = [];
  let session = "";
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:capture",
      revokeObjectURL: () => {},
    }),
  );
  vi.stubGlobal(
    "WebSocket",
    class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push([path, body]);
      if (path === `/api/v1/machines/${machine.id}/operations`)
        return Response.json({
          id: body.id,
          state: "succeeded",
          result: { data: png, mediaType: "image/png" },
        });
      if (path === `/api/v1/machines/${machine.id}/video-sessions`)
        session = body.id;
      return Response.json({
        id: session,
        machineId: machine.id,
        generation: "4b1f2d9a-7c0e-4e58-9a63-2f0d9c1c6e11",
        capability: "video",
        protocol: "canaveral-session-v1",
        state: path.endsWith("/close") ? "disconnected" : "pending",
      });
    }),
  );
  return { calls, sockets, session: () => session };
}

it("takes a named PNG screenshot with a preview and download", async () => {
  const { calls } = stub();
  render(<MobileCapture machine={machine} />);
  fireEvent.change(screen.getByLabelText("Screenshot name"), {
    target: { value: "Home screen" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Take screenshot" }));
  const link = await screen.findByRole("link", {
    name: "Download Home screen.png",
  });
  expect(link.getAttribute("download")).toBe("Home screen.png");
  expect(screen.getByRole("img", { name: "Device screenshot" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("2 × 3");
  expect(calls[0]![1]).toMatchObject({ action: "screenshot", arguments: {} });
});

it("shows an interrupted recording as a failure and closes its session", async () => {
  const { calls, sockets, session } = stub();
  render(<MobileCapture machine={machine} />);
  fireEvent.click(screen.getByRole("button", { name: "Record MP4" }));
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.close();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("closed before a verified completion");
  expect(screen.queryByRole("link", { name: /Download .*\.mp4/ })).toBeNull();
  await vi.waitFor(() =>
    expect(calls).toContainEqual([
      `/api/v1/machines/${machine.id}/video-sessions/${session()}/close`,
      {},
    ]),
  );
});

it("closes an open recording session when the panel unmounts", async () => {
  const { calls, sockets, session } = stub();
  const view = render(<MobileCapture machine={machine} />);
  fireEvent.click(screen.getByRole("button", { name: "Record MP4" }));
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  view.unmount();
  expect(sockets[0]!.closed).toBe(true);
  await vi.waitFor(() =>
    expect(calls).toContainEqual([
      `/api/v1/machines/${machine.id}/video-sessions/${session()}/close`,
      {},
    ]),
  );
});
