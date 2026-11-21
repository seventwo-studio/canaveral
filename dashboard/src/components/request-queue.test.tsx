import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { User } from "@/lib/inventory";
import { RequestQueue } from "./request-queue";

// The page counts against the controller's clock. Tests hold it at the instant of the last read.
vi.mock("@/lib/clock", async (original) => ({
  ...(await original<typeof import("@/lib/clock")>()),
  controllerNow: (reading: { observed: number }) => reading.observed,
}));

const admin: User = {
  id: "admin",
  username: "Admin",
  role: "admin",
  status: "active",
};
const app = "9415f91b-569d-4d93-a09d-8f7f903a8463";
const first = {
  id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f11",
  applicationId: app,
  applicationName: "Build agent",
  kind: "lease",
  position: 1,
  reason: "capacity_unavailable",
  priority: 5,
  createdAt: "2026-11-21T09:10:41.000Z",
  deadline: "2026-11-21T09:24:03.000Z",
  label: "checkout-flow",
  template: { id: "pixel-8", revision: "3", arch: "arm64" },
  platform: "android",
};
const second = {
  ...first,
  id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f12",
  position: 2,
  reason: null,
  priority: 0,
  deadline: null,
  label: undefined,
};
const model = {
  id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f13",
  applicationId: app,
  kind: "model-job",
  position: null,
  reason: "model_job_limit",
  priority: 0,
  createdAt: "2026-11-21T09:13:03.000Z",
  deadline: null,
  model: "fixture-model",
};
const lease = {
  id: "b7682a27-b32e-472a-8a4d-f54a98a6d962",
  ledger: "generic",
  applicationId: app,
  applicationName: "Build agent",
  name: "nightly-run",
  state: "ready",
  createdAt: "2026-11-21T08:50:00.000Z",
  expiresAt: "2026-11-21T09:20:00.000Z",
  template: { id: "pixel-8", revision: "3", arch: "arm64" },
  platform: "android",
};
const view = {
  observedAt: "2026-11-21T09:14:03.000Z",
  limit: 500,
  requests: [first, second, model],
  waitingTotal: 3,
  leases: [lease],
  activeTotal: 1,
};
const response = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});
const row = (name: string) =>
  screen.getByRole("button", { name }).closest("li")!;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("waiting requests are listed in attempt order with position, reason, holder, template, wait and deadline", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      paths.push(url);
      return response(view);
    }),
  );
  render(<RequestQueue user={admin} onDenied={vi.fn()} />);
  const list = await screen.findByRole("list", {
    name: "Waiting requests in attempt order",
  });
  expect(paths).toEqual(["/api/v1/admin/queue"]);
  // The page says what a position is before anyone reads one.
  expect(
    screen.getByText(/Position is an order of attempts, not a\s+promise/),
  ).toBeTruthy();
  expect(
    within(list)
      .getAllByRole("listitem")
      .map((item) => item.firstElementChild!.textContent),
  ).toEqual(["#1", "#2", "No position"]);
  const top = within(row("Cancel request checkout-flow"));
  expect(top.getByLabelText("Position 1").textContent).toBe("#1");
  expect(
    top.getByText("No eligible host has free capacity for it", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(top.getByText("capacity_unavailable").className).toContain(
    "font-mono",
  );
  expect(top.getByText("Build agent")).toBeTruthy();
  expect(
    top
      .getByRole("link", { name: `Activity of application ${app}` })
      .getAttribute("href"),
  ).toBe(`#activity/application/${app}`);
  expect(top.getByText("pixel-8@3/arm64")).toBeTruthy();
  expect(top.getByText("android")).toBeTruthy();
  expect(top.getByText("Machine or device lease")).toBeTruthy();
  // Each value sits under its label, so a narrow screen still says what a number is.
  const pair = (label: string) =>
    top.getByText(label, { selector: "dt" }).nextElementSibling!.textContent;
  expect(pair("Priority")).toBe("5");
  expect(pair("Waiting for")).toBe("3m 22s");
  expect(pair("Deadline")).toBe("in 10m 00s");
  // A request without a label is named by its identifier, and one that was never tried says so.
  const untried = within(row(`Cancel request ${second.id}`));
  expect(
    untried.getByText("Not tried yet since it was submitted"),
  ).toBeTruthy();
  expect(
    untried.getByText("Deadline", { selector: "dt" }).nextElementSibling!
      .textContent,
  ).toBe("None");
  // A model call has no place in a single order, and the page says why instead of showing a number.
  const call = within(row(`Cancel request ${model.id}`));
  expect(call.getByText("No position")).toBeTruthy();
  expect(
    call.getByText("No single order: runners claim model calls per domain"),
  ).toBeTruthy();
  expect(
    call.getByText("Its application is at its unfinished model job limit", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(call.getByText("fixture-model")).toBeTruthy();
  expect(screen.getByText(/controller time/).textContent).toContain(
    "3 waiting · 1 lease holds capacity",
  );
});

test("leases show their holder, label and time remaining, and a bounded list says what it left out", async () => {
  const soon = {
    ...lease,
    id: "b7682a27-b32e-472a-8a4d-f54a98a6d963",
    ledger: "linux",
    name: null,
    expiresAt: "2026-11-21T09:14:00.000Z",
    template: { id: "workspace", revision: "2", arch: "amd64" },
    platform: "linux",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        ...view,
        requests: [first],
        waitingTotal: 620,
        leases: [soon, lease],
        activeTotal: 700,
      }),
    ),
  );
  render(<RequestQueue user={admin} onDenied={vi.fn()} />);
  const list = await screen.findByRole("list", {
    name: "Leases holding capacity",
  });
  const [expired, held] = within(list).getAllByRole("listitem");
  const pair = (item: HTMLElement, label: string) =>
    within(item).getByText(label, { selector: "dt" }).nextElementSibling!
      .textContent;
  expect(within(held!).getByText("nightly-run")).toBeTruthy();
  expect(pair(held!, "Time remaining")).toBe("5m 57s");
  expect(pair(held!, "Holder")).toBe(`Build agent${app}`);
  expect(
    within(held!)
      .getByRole("link", { name: `Activity of lease ${lease.id}` })
      .getAttribute("href"),
  ).toBe(`#activity/lease/${lease.id}`);
  // A lease without a label and one past its deadline are stated, not blank or negative.
  expect(within(expired!).getByText("No label")).toBeTruthy();
  expect(pair(expired!, "Time remaining")).toBe("Deadline passed");
  expect(
    screen.getByText("Showing the first 1 of 620 waiting requests.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(
    screen.getByText(/Showing the 2 leases with the soonest deadline of\s+700/),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "System" }).getAttribute("href"),
  ).toBe("#system");
});

test("cancelling names the request and recovers an unknown outcome with the same mutation UUID", async () => {
  const mutations: { url: string; body: string }[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/admin/queue")
        return response(
          ++reads > 1 ? { ...view, requests: [], waitingTotal: 0 } : view,
        );
      mutations.push({ url, body: String(init.body) });
      if (mutations.length === 1) throw new Error("lost response");
      return response({
        id: first.id,
        requestId: JSON.parse(String(init.body)).id,
        action: "cancel",
        state: "cancelled",
        applicationId: app,
      });
    }),
  );
  render(<RequestQueue user={admin} onDenied={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel request checkout-flow" }),
  );
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByRole("heading").textContent).toBe(
    "Cancel request checkout-flow?",
  );
  expect(dialog.textContent).toContain(`Request: ${first.id}`);
  expect(dialog.textContent).toContain(`Application: Build agent · ${app}`);
  expect(dialog.textContent).toContain("administrator_cancelled");
  expect(dialog.textContent).toContain("releases its lease instead");
  expect(mutations).toHaveLength(0);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Cancel request" }),
  );
  const retry = await within(dialog).findByRole("button", {
    name: "Retry same cancellation",
  });
  expect(dialog.textContent).toContain("Do not start another one");
  // An uncertain cancellation cannot be dismissed into a second attempt under a new UUID.
  expect(
    within(dialog)
      .getByRole("button", { name: "Keep waiting" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(mutations).toHaveLength(2);
  expect(mutations[0]).toEqual(mutations[1]);
  expect(mutations[0]!.url).toBe(`/api/v1/admin/requests/${first.id}/cancel`);
  expect(JSON.parse(mutations[0]!.body)).toEqual({
    id: expect.stringMatching(/^[a-f0-9-]{36}$/),
    applicationId: app,
  });
  expect(
    (await screen.findByText(/Request checkout-flow cancelled/)).getAttribute(
      "role",
    ),
  ).toBe("status");
  // The queue is read again and now explains why it is empty.
  expect(await screen.findByText("No requests are waiting")).toBeTruthy();
  expect(
    screen.getByText(/capacity or one of its limits keeps the controller/),
  ).toBeTruthy();
});

test("a definite refusal ends the attempt, and an admitted request's outcome is reported as it is", async () => {
  let attempt = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/admin/queue") return response(view);
      if (++attempt === 1)
        return response({ error: "Unknown or ambiguous request." }, 409);
      return response({
        id: first.id,
        requestId: JSON.parse(String(init.body)).id,
        action: "cancel",
        state: "released",
      });
    }),
  );
  render(<RequestQueue user={admin} onDenied={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel request checkout-flow" }),
  );
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Cancel request" }),
  );
  expect(
    await within(dialog).findByText("Unknown or ambiguous request."),
  ).toBeTruthy();
  expect(
    within(dialog).queryByRole("button", { name: "Retry same cancellation" }),
  ).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "Keep waiting" })
      .hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Cancel request" }),
  );
  expect(
    await screen.findByText(
      /was no longer waiting. The controller reports: released/,
    ),
  ).toBeTruthy();
});

test("a failed read keeps the last queue with a stale notice, blocks cancelling and offers a refresh", async () => {
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw new Error("offline");
      return response(view);
    }),
  );
  render(<RequestQueue user={admin} onDenied={vi.fn()} />);
  await screen.findByRole("button", { name: "Cancel request checkout-flow" });
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The queue shown is stale. Could not load data.",
  );
  expect(
    screen
      .getByRole("button", { name: "Cancel request checkout-flow" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    screen
      .getByRole("button", { name: "Cancel request checkout-flow" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("a malformed queue is not shown, and lost administrator authority clears the page", async () => {
  const onDenied = vi.fn();
  let reply = response({
    ...view,
    requests: [
      { ...first, position: 2 },
      { ...second, position: 1 },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply),
  );
  render(<RequestQueue user={admin} onDenied={onDenied} />);
  // A reply that is not in attempt order is refused whole rather than shown as if it were the order.
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load data. Try refreshing.",
  );
  expect(screen.queryByRole("list")).toBeNull();
  reply = response(
    { error: "Credential scope does not permit this action." },
    403,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh queue" }));
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert").textContent).toContain(
    "Administrator access is required.",
  );
});

test("an ordinary account is refused without a request", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<RequestQueue user={{ ...admin, role: "user" }} onDenied={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toBe(
    "Administrator access is required.",
  );
  expect(fetch).not.toHaveBeenCalled();
});
