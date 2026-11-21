import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { User } from "@/lib/inventory";
import { ActivityFeed } from "./activity-feed";

const admin: User = {
  id: "admin",
  username: "Admin",
  role: "admin",
  status: "active",
};
const kinds = [
  {
    kind: "lease.admitted",
    summary:
      "A lease was admitted and its resources reserved; provisioning began.",
    routine: false,
    attention: false,
  },
  {
    kind: "lease.failed",
    summary: "A lease failed during provisioning or at runtime.",
    routine: false,
    attention: true,
  },
  {
    kind: "host.offline",
    summary: "A host stopped reporting within the freshness window.",
    routine: false,
    attention: true,
  },
  {
    kind: "operation.succeeded",
    summary: "A device or command operation succeeded.",
    routine: true,
    attention: false,
  },
];
const app = "9415f91b-569d-4d93-a09d-8f7f903a8463",
  lease = "b7682a27-b32e-472a-8a4d-f54a98a6d962",
  host = "5a0d0a53-6f3e-4d0e-8a3c-0d1b7f2f9a10";
const event = (
  sequence: number,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  sequence,
  at: `2026-11-21T09:14:${String(sequence % 60).padStart(2, "0")}.000Z`,
  kind,
  data: {},
  ...extra,
});
const failed = event(4812, "lease.failed", {
  applicationId: app,
  leaseId: lease,
  hostId: host,
  data: { ledger: "generic", reason: "runtime_error", attempts: 3 },
});
const admitted = event(4810, "lease.admitted", {
  applicationId: app,
  leaseId: lease,
});
const page = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  events,
  cursor: 4812,
  more: false,
  truncated: false,
  oldestSequence: 4000,
  latestSequence: 4812,
  ...extra,
});
const response = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});

let requests: string[], answer: (query: URLSearchParams) => unknown;
beforeEach(() => {
  requests = [];
  answer = () => page([admitted, failed]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url.replace("/api/v1/admin/", ""));
      if (url.endsWith("/events/kinds")) return response({ kinds });
      const reply = answer(new URL(url, "http://localhost").searchParams);
      if (reply instanceof Error) throw reply;
      return reply !== null && typeof reply === "object" && "ok" in reply
        ? reply
        : response(reply);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
const reads = () => requests.filter((request) => request !== "events/kinds");
const feed = () => screen.findByRole("list", { name: "Events, newest first" });

test("events are listed newest first with their kind, meaning, subjects and payload", async () => {
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  const items = within(await feed()).getAllByRole("listitem");
  expect(requests).toEqual(["events/kinds", "events?tail=100"]);
  expect(
    items.map((item) => within(item).getByText(/^(lease|host)\./).textContent),
  ).toEqual(["lease.failed", "lease.admitted"]);
  const top = within(items[0]!);
  expect(top.getByText("lease.failed").className).toContain("font-mono");
  expect(
    top.getByText("A lease failed during provisioning or at runtime."),
  ).toBeTruthy();
  expect(top.getByText("Needs attention")).toBeTruthy();
  expect(top.getByText("sequence 4812")).toBeTruthy();
  // The local time is shown; the exact UTC instant is on the element.
  expect(
    top.getByTitle("2026-11-21T09:14:12.000Z").getAttribute("datetime"),
  ).toBe("2026-11-21T09:14:12.000Z");
  // Subjects are labelled identifiers; payload fields keep their names.
  expect(
    top.getByText("Lease", { selector: "dt" }).nextElementSibling!.textContent,
  ).toBe(lease);
  expect(
    top.getByText("Host", { selector: "dt" }).nextElementSibling!.textContent,
  ).toBe(host);
  expect(
    top.getByText("reason", { selector: "dt" }).nextElementSibling!.textContent,
  ).toBe("runtime_error");
  expect(
    top.getByText("attempts", { selector: "dt" }).nextElementSibling!
      .textContent,
  ).toBe("3");
  expect(within(items[1]!).queryByText("Needs attention")).toBeNull();
  expect(
    screen.getByText(/Live · reads every 3 seconds while visible/).textContent,
  ).toContain("2 events from sequence 4810 to 4812 · log holds 4000 to 4812");
  // Two events is fewer than a page, so there is nothing older to ask for.
  expect(screen.getByText("No older retained event matches.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Load older events" }),
  ).toBeNull();
});

test("family, kind, attention and subject filters become the read's parameters", async () => {
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  fireEvent.change(screen.getByLabelText("Family"), {
    target: { value: "lease" },
  });
  await waitFor(() =>
    expect(reads().at(-1)).toBe("events?tail=100&kind=lease.*"),
  );
  // The kind list narrows to the family.
  expect(
    within(screen.getByLabelText("Kind"))
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["All lease kinds", "lease.admitted", "lease.failed"]);
  fireEvent.change(screen.getByLabelText("Kind"), {
    target: { value: "lease.failed" },
  });
  await waitFor(() =>
    expect(reads().at(-1)).toBe("events?tail=100&kind=lease.failed"),
  );
  fireEvent.change(screen.getByLabelText("Family"), { target: { value: "" } });
  await waitFor(() => expect(reads().at(-1)).toBe("events?tail=100"));
  fireEvent.click(screen.getByLabelText("Needs attention only"));
  await waitFor(() =>
    expect(reads().at(-1)).toBe(
      "events?tail=100&kind=lease.failed&kind=host.offline",
    ),
  );
  expect(
    screen.getByText(
      "Showing the 2 kinds the controller marks as needing attention.",
    ),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Lease"), {
    target: { value: lease },
  });
  await waitFor(() =>
    expect(reads().at(-1)).toBe(
      `events?tail=100&kind=lease.failed&kind=host.offline&lease=${lease}`,
    ),
  );
  fireEvent.change(screen.getByLabelText("Application"), {
    target: { value: app.toUpperCase() + " " },
  });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: host } });
  await waitFor(() =>
    expect(reads().at(-1)).toBe(
      `events?tail=100&kind=lease.failed&kind=host.offline&application=${app}&lease=${lease}&host=${host}`,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(reads().at(-1)).toBe("events?tail=100"));
  expect((screen.getByLabelText("Lease") as HTMLInputElement).value).toBe("");
});

test("an incomplete identifier and an unsatisfiable attention filter are never sent", async () => {
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  const before = reads().length;
  fireEvent.change(screen.getByLabelText("Lease"), {
    target: { value: "b7682a27-b32e" },
  });
  expect(screen.getByText("Enter a complete UUID.")).toBeTruthy();
  expect(screen.getByLabelText("Lease").getAttribute("aria-invalid")).toBe(
    "true",
  );
  fireEvent.change(screen.getByLabelText("Lease"), { target: { value: "" } });
  expect(screen.queryByText("Enter a complete UUID.")).toBeNull();
  fireEvent.change(screen.getByLabelText("Family"), {
    target: { value: "operation" },
  });
  await waitFor(() =>
    expect(reads().at(-1)).toBe("events?tail=100&kind=operation.*"),
  );
  const sent = reads().length;
  expect(sent).toBe(before + 1);
  fireEvent.click(screen.getByLabelText("Needs attention only"));
  expect(
    await screen.findByText(
      "No kind in this selection is marked as needing attention, so nothing can match.",
    ),
  ).toBeTruthy();
  // Nothing was read for a filter that selects no kind: it is not sent as an unfiltered read.
  await act(async () => {
    await Promise.resolve();
  });
  expect(reads().length).toBe(sent);
  expect(
    screen.queryByRole("list", { name: "Events, newest first" }),
  ).toBeNull();
});

test("choosing an identifier in an event filters to it, and a linked subject opens filtered", async () => {
  const view = render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  fireEvent.click(
    screen.getAllByRole("button", { name: `Show only lease ${lease}` })[0]!,
  );
  await waitFor(() =>
    expect(reads().at(-1)).toBe(`events?tail=100&lease=${lease}`),
  );
  expect((screen.getByLabelText("Lease") as HTMLInputElement).value).toBe(
    lease,
  );
  view.unmount();
  requests = [];
  const request = "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f11";
  render(
    <ActivityFeed user={admin} onDenied={vi.fn()} initial={{ request }} />,
  );
  await feed();
  expect(reads()).toEqual([`events?tail=100&request=${request}`]);
  // A request filter has no field of its own: it is shown and can be removed.
  fireEvent.click(
    screen.getByRole("button", { name: "Remove the request filter" }),
  );
  await waitFor(() => expect(reads().at(-1)).toBe("events?tail=100"));
});

test("live reads follow the controller's cursor while visible and stop when paused or hidden", async () => {
  vi.useFakeTimers();
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await settle();
  await settle();
  expect(reads()).toEqual(["events?tail=100"]);
  const offline = event(4813, "host.offline", {
    hostId: host,
    data: { silentSeconds: 31 },
  });
  answer = (query) =>
    page(query.get("after") === "4812" ? [offline] : [], {
      cursor: 4813,
      latestSequence: 4813,
    });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(reads().at(-1)).toBe("events?after=4812&limit=500");
  const items = within(
    screen.getByRole("list", { name: "Events, newest first" }),
  ).getAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(within(items[0]!).getByText("host.offline")).toBeTruthy();
  // The next read starts at the cursor the controller returned, so the event is not repeated.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(reads().at(-1)).toBe("events?after=4813&limit=500");
  expect(
    within(
      screen.getByRole("list", { name: "Events, newest first" }),
    ).getAllByRole("listitem"),
  ).toHaveLength(3);
  const count = reads().length;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(reads().length).toBe(count);
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "Pause live updates" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(reads().length).toBe(count);
  expect(screen.getByText(/Live updates paused/)).toBeTruthy();
  // Resuming continues from the same cursor: a pause loses nothing.
  fireEvent.click(screen.getByRole("button", { name: "Resume live updates" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(reads().length).toBe(count + 1);
  expect(reads().at(-1)).toBe("events?after=4813&limit=500");
});

test("older events are asked for on request, and the page says how far it searched", async () => {
  const many = Array.from({ length: 100 }, (_, n) =>
    event(4713 + n, "operation.succeeded"),
  );
  answer = (query) =>
    page(
      query.get("tail") === "200"
        ? [event(4500, "lease.admitted"), ...many]
        : many,
    );
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  expect(screen.getByText(/Searched back to sequence/).textContent).toBe(
    "Searched back to sequence 4713.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
  await waitFor(() => expect(reads().at(-1)).toBe("events?tail=200"));
  // The larger tail returned fewer than it asked for: history is exhausted and the page says so.
  expect(
    await screen.findByText("No older retained event matches."),
  ).toBeTruthy();
  expect(within(await feed()).getAllByRole("listitem")).toHaveLength(101);
});

test("a failed read keeps the events with a stale notice, and a refresh recovers", async () => {
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  answer = () => new Error("offline");
  fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The activity shown is stale. Could not load data. Try refreshing.",
  );
  expect(within(await feed()).getAllByRole("listitem")).toHaveLength(2);
  answer = () => page([], { cursor: 4812 });
  fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(reads().at(-1)).toBe("events?after=4812&limit=500");
});

test("a failed read of the kind catalogue is retried by the refresh action", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url.replace("/api/v1/admin/", ""));
      if (url.endsWith("/events/kinds")) {
        if (fail) throw new Error("offline");
        return response({ kinds });
      }
      return response(page([admitted, failed]));
    }),
  );
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load data. Try refreshing.",
  );
  // Without the catalogue no event is read: the page would not know what the kinds mean.
  expect(requests).toEqual(["events/kinds"]);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  expect(within(await feed()).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(requests).toEqual(["events/kinds", "events/kinds", "events?tail=100"]);
});

test("retention that outran the page is reported, and empty logs say what would appear", async () => {
  answer = (query) =>
    query.has("tail")
      ? page([admitted, failed])
      : page([], {
          truncated: true,
          cursor: 9000,
          oldestSequence: 8990,
          latestSequence: 9000,
        });
  const view = render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  await feed();
  fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
  expect(
    (
      await screen.findByText(
        /Retention removed events before this page read them/,
      )
    ).getAttribute("role"),
  ).toBe("status");
  view.unmount();
  answer = () =>
    page([], { cursor: 0, oldestSequence: null, latestSequence: 0 });
  render(<ActivityFeed user={admin} onDenied={vi.fn()} />);
  expect(await screen.findByText("The event log is empty")).toBeTruthy();
  expect(
    screen.getByText(/An event is written with every change/),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Family"), {
    target: { value: "host" },
  });
  expect(
    await screen.findByText("No retained event matches these filters"),
  ).toBeTruthy();
  expect(screen.getByText(/The log keeps a bounded history/)).toBeTruthy();
});

test("lost administrator authority clears the page, and an ordinary account asks for nothing", async () => {
  const onDenied = vi.fn();
  answer = () =>
    response({ error: "Credential scope does not permit this action." }, 403);
  const view = render(<ActivityFeed user={admin} onDenied={onDenied} />);
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert").textContent).toBe(
    "Administrator access is required.",
  );
  expect(
    screen.queryByRole("list", { name: "Events, newest first" }),
  ).toBeNull();
  view.unmount();
  requests = [];
  render(<ActivityFeed user={{ ...admin, role: "user" }} onDenied={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toBe(
    "Administrator access is required.",
  );
  expect(requests).toEqual([]);
});
