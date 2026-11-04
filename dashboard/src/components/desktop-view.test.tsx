import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DesktopView } from "./desktop-view";
import type { DisplayActions } from "@/lib/workspace";
import type { RFBChannel } from "@novnc/novnc";
import type { Mock } from "vitest";

interface FixtureSocket extends EventTarget {
  send: Mock<(value: string) => void>;
  readyState: number;
}
interface FixtureConnection extends EventTarget {
  channel: RFBChannel;
  viewOnly: boolean;
  focus: Mock;
  disconnect: Mock;
  clipboardPasteFrom: Mock<(value: string) => void>;
}
const state = vi.hoisted(() => ({
  connections: [] as FixtureConnection[],
  socket: null as FixtureSocket | null,
}));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    viewOnly = true;
    clipboardPasteFrom = vi.fn<(value: string) => void>();
    channel: RFBChannel;
    focus: Mock;
    disconnect: Mock;
    constructor(_target: Element, channel: RFBChannel) {
      super();
      this.channel = channel;
      this.focus = vi.fn();
      this.disconnect = vi.fn();
      state.connections.push(this);
    }
  },
}));

afterEach(() => {
  cleanup();
  state.connections.length = 0;
  vi.unstubAllGlobals();
});

test("owned actions wait for their receipt and disconnect never replays them", async () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn<(value: string) => void>();
    constructor() {
      super();
      state.socket = this;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const actionsRef: { current: DisplayActions | null } = { current: null };
  const rendered = render(
    <DesktopView
      machine={{ id: "fixture", template: { mode: "desktop" } }}
      actionsRef={actionsRef}
    />,
  );
  const socket = state.socket!;
  const message = (value: unknown) =>
    act(() =>
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(value) }),
      ),
    );
  await expect(
    actionsRef.current!.perform("tap", { x: 1, y: 2 }),
  ).rejects.toThrow("Take input control");
  message({ type: "control", state: "owned" });
  const pending = actionsRef.current!.perform("tap", { x: 1, y: 2 });
  const request = JSON.parse(socket.send.mock.lastCall![0]) as { id: string };
  expect(request).toMatchObject({
    type: "action",
    action: "tap",
    arguments: { x: 1, y: 2 },
  });
  message({
    type: "action-result",
    id: request.id,
    state: "succeeded",
    result: { posted: true },
  });
  await expect(pending).resolves.toEqual({ posted: true });
  const interrupted = actionsRef.current!.perform("tap", { x: 3, y: 4 });
  const assertion = expect(interrupted).rejects.toThrow("Inspect receipt");
  rendered.unmount();
  await assertion;
  expect(actionsRef.current).toBeNull();
  expect(socket.send).toHaveBeenCalledTimes(2);
});

test("input remains view-only until the runner grants ownership", () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn<(value: string) => void>();
    constructor() {
      super();
      state.socket = this;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  render(
    <DesktopView machine={{ id: "fixture", template: { mode: "desktop" } }} />,
  );
  const connection = state.connections[0]!,
    socket = state.socket!;
  act(() => connection.dispatchEvent(new Event("connect")));
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  expect(connection.viewOnly).toBe(true);
  expect(socket.send).toHaveBeenLastCalledWith(
    JSON.stringify({ type: "input-control", action: "take" }),
  );
  const control = (state: string) =>
    act(() =>
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "control", state }),
        }),
      ),
    );
  control("busy");
  expect(connection.viewOnly).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Another connection");
  control("owned");
  expect(connection.viewOnly).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Release control" }));
  control("view-only");
  expect(connection.viewOnly).toBe(true);
  control("reset-uncertain");
  expect(screen.getByRole("alert").textContent).toContain(
    "Input reset could not be confirmed",
  );
  vi.unstubAllGlobals();
});

test("malformed successful acknowledgements fence input and reject pending receipts without replay", async () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn<(value: string) => void>();
    constructor() {
      super();
      state.socket = this;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const actionsRef: { current: DisplayActions | null } = { current: null };
  render(
    <DesktopView
      machine={{ id: "fixture", template: { mode: "desktop" } }}
      actionsRef={actionsRef}
    />,
  );
  const message = (value: unknown) =>
    act(() =>
      state.socket!.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(value) }),
      ),
    );
  message({ type: "control", state: "owned" });
  const pending = actionsRef.current!.perform("tap", { x: 1, y: 2 });
  const rejected = expect(pending).rejects.toThrow("Inspect receipt");
  const request = JSON.parse(state.socket!.send.mock.lastCall![0]) as {
    id: string;
  };
  message({
    type: "action-result",
    id: request.id,
    state: "succeeded",
    result: null,
  });
  await rejected;
  expect(actionsRef.current!.owned()).toBe(false);
  expect(state.socket!.send).toHaveBeenCalledTimes(1);
});

test("clipboard permission completing after a machine change never targets the replacement connection", async () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn<(value: string) => void>();
    constructor() {
      super();
      state.socket = this;
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  let resolveText!: (value: string) => void;
  vi.stubGlobal("navigator", {
    clipboard: {
      readText: () =>
        new Promise<string>((resolve) => {
          resolveText = resolve;
        }),
    },
  });
  const rendered = render(
    <DesktopView machine={{ id: "first", template: { mode: "desktop" } }} />,
  );
  const first = state.connections[0]!;
  act(() => first.dispatchEvent(new Event("connect")));
  act(() =>
    state.socket!.dispatchEvent(
      new MessageEvent("message", {
        data: '{"type":"control","state":"owned"}',
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Paste clipboard into guest" }),
  );
  rendered.rerender(
    <DesktopView machine={{ id: "second", template: { mode: "desktop" } }} />,
  );
  await act(async () => resolveText("do not retarget"));
  expect(first.clipboardPasteFrom).not.toHaveBeenCalled();
  expect(state.connections[1]!.clipboardPasteFrom).not.toHaveBeenCalled();
});
