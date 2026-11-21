import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Host } from "@/lib/infrastructure";
import type { Machine, User } from "@/lib/inventory";
import type { LiveEnding, LiveHandlers } from "@/lib/live-view";
import type { PlayerEvents } from "@/lib/live-player";
import {
  ScreenWall,
  WALL_LIMIT,
  wallSelection,
  watchable,
} from "./screen-wall";

/** The relay and the decoder are stood in for here: this file checks which devices are offered, what
 * each tile shows and when a view is opened, renewed, reopened and closed. */
interface View {
  machineId: string;
  handlers: LiveHandlers;
  watched: boolean[];
  closed: boolean[];
}
interface Player {
  events: PlayerEvents;
  inits: number;
  appended: number;
  destroyed: boolean;
}
const views: View[] = [],
  players: Player[] = [];
vi.mock("@/lib/live-view", async (original) => ({
  ...(await original<typeof import("@/lib/live-view")>()),
  watchLive: (machineId: string, handlers: LiveHandlers) => {
    const view: View = { machineId, handlers, watched: [], closed: [] };
    views.push(view);
    return {
      setWatched: (value: boolean) => view.watched.push(value),
      close: (keepalive = false) => view.closed.push(keepalive),
    };
  },
}));
vi.mock("@/lib/live-player", () => ({
  createLivePlayer: (_video: HTMLVideoElement, events: PlayerEvents) => {
    const player: Player = { events, inits: 0, appended: 0, destroyed: false };
    players.push(player);
    return {
      init: () => player.inits++,
      append: () => player.appended++,
      destroy: () => {
        player.destroyed = true;
      },
    };
  },
}));

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const owner: User = {
  id: "7ed721ca-e104-49ea-9b0a-8a58d6a63ba1",
  username: "alice",
  role: "user",
  status: "active",
};
const hosts = [{ id: "h1", name: "Studio" }] as Host[];
function device(
  n: number,
  extra: Partial<Machine> = {},
  os = "android",
): Machine {
  return {
    id: id(n),
    name: `Phone ${n}`,
    hostId: "h1",
    ownerId: owner.id,
    templateId: "phone",
    template: { id: "phone", revision: "1", arch: "arm64", os, mode: "device" },
    resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 },
    desired: "running",
    observed: "running",
    ready: true,
    preparation: { state: "ready" },
    ...extra,
  } as unknown as Machine;
}
const five = [1, 2, 3, 4, 5].map((n) => device(n));
function wall(
  machines: Machine[],
  extra: Partial<Parameters<typeof ScreenWall>[0]> = {},
) {
  const props = {
    machines,
    hosts,
    users: [owner],
    admin: false,
    loaded: true,
    stale: "",
    onControl: vi.fn(),
    onDenied: vi.fn(),
    ...extra,
  };
  return { ...render(<ScreenWall {...props} />), props };
}
const hide = (hidden: boolean) =>
  act(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: hidden,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
const end = (view: View, ending: LiveEnding) =>
  act(() => view.handlers.onEnd(ending));
beforeEach(() => {
  views.length = 0;
  players.length = 0;
  location.hash = "#screens";
});
afterEach(() => {
  cleanup();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

test("only running, account-owned mobile devices are offered; a leased device never is", () => {
  expect(watchable(device(1))).toBe(true);
  expect(watchable(device(1, {}, "ios"))).toBe(true);
  // A leased machine has no user owner. Neither does an operator-created one; both stay off the wall.
  expect(watchable(device(1, { ownerId: null }))).toBe(false);
  expect(watchable(device(1, { ownerId: undefined }))).toBe(false);
  expect(watchable(device(1, { observed: "stopped" }))).toBe(false);
  expect(watchable(device(1, { desired: "stopped" }))).toBe(false);
  expect(watchable(device(1, { deletion: { id: "d", state: "queued" } }))).toBe(
    false,
  );
  expect(watchable(device(1, {}, "linux"))).toBe(false);
  expect(
    watchable({
      ...device(1),
      template: { ...device(1).template, mode: "desktop" },
    } as Machine),
  ).toBe(false);
  wall(
    [
      device(1),
      device(2, { ownerId: null, name: "Leased phone" }),
      device(3, { observed: "stopped", name: "Stopped phone" }),
    ],
    { admin: true },
  );
  const offered = within(
    screen.getByRole("list", { name: "Devices you can watch" }),
  ).getAllByRole("listitem");
  expect(offered).toHaveLength(1);
  expect(offered[0]!.textContent).toContain("Phone 1");
  // An administrator sees whose device it is.
  expect(offered[0]!.textContent).toContain(
    "Android Emulator · Studio · alice",
  );
  expect(screen.queryByText("Leased phone")).toBeNull();
  expect(
    screen.getByText(
      /a leased device's\s+screen belongs to its lease holder and is never shown here/,
    ),
  ).toBeTruthy();
  // Nothing is watched until someone asks: a capture costs its host a slot and a reservation.
  expect(views).toEqual([]);
  expect(
    screen.getByText(
      /one of that host's four video\s+sessions, with one CPU and 256 MiB reserved/,
    ),
  ).toBeTruthy();
});

test("a watched device opens one live view and shows its state until the first frame", () => {
  const { props } = wall(five);
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 2" }));
  expect(views.map((view) => view.machineId)).toEqual([id(2)]);
  const tile = within(
    screen.getByRole("article", { name: "Live screen of Phone 2" }),
  );
  expect(tile.getByRole("status").textContent).toBe("Opening the live view…");
  expect(tile.getByText("Connecting")).toBeTruthy();
  // An ordinary account does not know host names; the tile does not invent one.
  expect(tile.getByText("Android Emulator · Studio")).toBeTruthy();
  act(() => views[0]!.handlers.onLive());
  expect(tile.getByRole("status").textContent).toContain(
    "a still Android screen sends none until it changes",
  );
  act(() => {
    views[0]!.handlers.onInit(1, new Uint8Array(4));
    views[0]!.handlers.onSegment({
      epoch: 1,
      sequence: 0,
      keyframe: true,
      data: new Uint8Array(8),
    });
  });
  expect(players[0]).toMatchObject({ inits: 1, appended: 1 });
  act(() => players[0]!.events.onPicture({ width: 1080, height: 2400 }));
  expect(tile.getByText("Live")).toBeTruthy();
  expect(tile.queryByRole("status")).toBeNull();
  // The picture is watch-only: no controls, not focusable, and it takes no pointer input.
  const video = tile.getByLabelText("Screen of Phone 2") as HTMLVideoElement;
  expect(video.controls).toBe(false);
  expect(video.muted).toBe(true);
  expect(video.tabIndex).toBe(-1);
  expect(video.className).toContain("pointer-events-none");
  expect(video.parentElement!.style.aspectRatio).toBe("1080 / 2400");
  // Acting on the device happens on its control page.
  fireEvent.click(
    tile.getByRole("button", { name: "Open control of Phone 2" }),
  );
  expect(props.onControl).toHaveBeenCalledWith(id(2));
  // The address names the wall, so a reload shows the same devices.
  expect(location.hash).toBe(`#screens/${id(2)}`);
});

test("the wall holds four screens at most and closes a view when its tile leaves", () => {
  wall(five);
  for (const n of [1, 2, 3, 4])
    fireEvent.click(screen.getByRole("button", { name: `Watch Phone ${n}` }));
  expect(views).toHaveLength(WALL_LIMIT);
  expect(
    within(
      screen.getByRole("region", { name: "Watched screens" }),
    ).getAllByRole("article"),
  ).toHaveLength(4);
  expect(
    screen
      .getByRole("button", { name: "Watch Phone 5" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByText(/The wall shows four screens at most/)
      .getAttribute("role"),
  ).toBe("status");
  const second = views[1]!;
  fireEvent.click(
    within(
      screen.getByRole("article", { name: "Live screen of Phone 2" }),
    ).getByRole("button", { name: "Stop watching Phone 2" }),
  );
  expect(second.closed).toEqual([false]);
  expect(players[1]!.destroyed).toBe(true);
  expect(
    screen.queryByRole("article", { name: "Live screen of Phone 2" }),
  ).toBeNull();
  // The others keep their views: removing one tile does not reopen them.
  expect(views).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 5" }));
  expect(views.map((view) => view.machineId)).toEqual([
    id(1),
    id(2),
    id(3),
    id(4),
    id(5),
  ]);
  expect(location.hash).toBe(`#screens/${[1, 3, 4, 5].map(id).join("+")}`);
});

test("a view is renewed only while its picture is on screen, and a lapsed view reopens when it returns", async () => {
  wall(five);
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 1" }));
  const first = views[0]!;
  expect(first.watched).toEqual([true]);
  await hide(true);
  expect(first.watched.at(-1)).toBe(false);
  // The view lapses while the tab is in the background: nothing is reopened behind the user's back.
  await end(first, {
    reason: "view_expired",
    message: "The view lapsed while it was not on screen.",
    again: "now",
    state: "Paused",
  });
  expect(views).toHaveLength(1);
  expect(
    within(
      screen.getByRole("article", { name: "Live screen of Phone 1" }),
    ).getByText("Paused"),
  ).toBeTruthy();
  await hide(false);
  expect(views).toHaveLength(2);
  expect(views[1]!.watched.at(-1)).toBe(true);
  expect(
    within(
      screen.getByRole("article", { name: "Live screen of Phone 1" }),
    ).getByText("Connecting"),
  ).toBeTruthy();
  // A view that lapses while it was on screen all along is not reopened in a loop.
  await end(views[1]!, {
    reason: "view_expired",
    message: "The view lapsed while it was not on screen.",
    again: "now",
    state: "Paused",
  });
  expect(views).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 1 again" }));
  expect(views).toHaveLength(3);
});

test("a host that does not offer live views is a state, not an error; failures say what happened", async () => {
  const { props } = wall([device(1, { name: "iPhone" }, "ios"), device(2)]);
  fireEvent.click(screen.getByRole("button", { name: "Watch iPhone" }));
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 2" }));
  await end(views[0]!, {
    reason: "capability_unsupported",
    message:
      "Live view is not offered by this device's host. For iOS it is off unless the host opts in.",
    again: "no",
    state: "Not offered",
  });
  const ios = within(
    screen.getByRole("article", { name: "Live screen of iPhone" }),
  );
  expect(ios.getByText("Not offered")).toBeTruthy();
  expect(ios.getByRole("status").textContent).toContain(
    "is not offered by this device's host",
  );
  expect(ios.queryByRole("alert")).toBeNull();
  // Asking again cannot help while the host is configured that way.
  expect(ios.queryByRole("button", { name: /again/ })).toBeNull();
  expect(
    ios.getByRole("button", { name: "Open control of iPhone" }),
  ).toBeTruthy();
  await end(views[1]!, {
    reason: "capture_failed",
    message: "The device's screen capture failed. It is not retried by itself.",
    again: "later",
  });
  const android = within(
    screen.getByRole("article", { name: "Live screen of Phone 2" }),
  );
  expect(android.getByText("Ended")).toBeTruthy();
  expect(android.getByRole("alert").textContent).toBe(
    "The device's screen capture failed. It is not retried by itself.",
  );
  expect(
    android.getByRole("button", { name: "Watch Phone 2 again" }),
  ).toBeTruthy();
  expect(props.onDenied).not.toHaveBeenCalled();
  // A browser that cannot decode the stream leaves the view so the capture can stop.
  fireEvent.click(android.getByRole("button", { name: "Watch Phone 2 again" }));
  const view = views.at(-1)!;
  act(() =>
    players
      .at(-1)!
      .events.onProblem("This browser cannot decode the device's H.264 video."),
  );
  expect(view.closed).toEqual([false]);
  expect(android.getByRole("alert").textContent).toBe(
    "This browser cannot decode the device's H.264 video.",
  );
  expect(android.queryByRole("button", { name: /again/ })).toBeNull();
});

test("an ended session signs out; a device that stops leaves its tile explained", async () => {
  const view = wall(five);
  fireEvent.click(screen.getByRole("button", { name: "Watch Phone 1" }));
  await end(views[0]!, {
    reason: "unauthenticated",
    message: "Your session does not have access to this device.",
    again: "no",
    denied: true,
  });
  expect(view.props.onDenied).toHaveBeenCalledTimes(1);
  // The inventory now reports the device stopped: its view is closed and the tile says why.
  view.rerender(
    <ScreenWall
      {...view.props}
      machines={[device(1, { observed: "stopped" }), ...five.slice(1)]}
    />,
  );
  const tile = within(
    screen.getByRole("article", { name: "Screen of Phone 1" }),
  );
  expect(tile.getByText(/This device is not running/)).toBeTruthy();
  expect(views[0]!.closed).toEqual([false]);
  fireEvent.click(tile.getByRole("button", { name: "Remove from the wall" }));
  expect(screen.queryByRole("region", { name: "Watched screens" })).toBeNull();
});

test("the address restores the wall, and leaving the page closes every view with a keepalive request", () => {
  expect(wallSelection(`#screens/${id(1)}+${id(2)}`)).toEqual([id(1), id(2)]);
  expect(
    wallSelection(`#screens/${[1, 2, 3, 4, 5].map(id).join("+")}`),
  ).toHaveLength(WALL_LIMIT);
  expect(wallSelection(`#screens/${id(1)}+${id(1)}+not-a-device`)).toEqual([
    id(1),
  ]);
  expect(wallSelection("#machines")).toEqual([]);
  expect(wallSelection(`#screens/${id(1)}/extra`)).toEqual([]);
  location.hash = `#screens/${id(3)}+${id(9)}`;
  const view = wall(five);
  expect(views.map((v) => v.machineId)).toEqual([id(3)]);
  // A device the account cannot see is named by its identifier and can be removed.
  expect(
    within(
      screen.getByRole("article", { name: `Screen of ${id(9)}` }),
    ).getByText("This device is not in your device list."),
  ).toBeTruthy();
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(views[0]!.closed).toEqual([true]);
  view.unmount();
  expect(players[0]!.destroyed).toBe(true);
});

test("an empty or stale device list says what it is", () => {
  const view = wall([], { loaded: false });
  expect(screen.getByText("Loading the device list…")).toBeTruthy();
  view.rerender(<ScreenWall {...view.props} loaded />);
  expect(screen.getByText("No running mobile device to watch")).toBeTruthy();
  expect(
    screen.getByText(
      /appears here while it is running\s+and belongs to your account/,
    ),
  ).toBeTruthy();
  view.rerender(
    <ScreenWall
      {...view.props}
      loaded
      stale="Inventory is stale. Could not load data."
      machines={five}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "The device list is stale. Inventory is stale. Could not load data.",
  );
});
