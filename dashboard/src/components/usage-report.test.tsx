import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { User } from "@/lib/inventory";
import { UsageReport } from "./usage-report";

const admin: User = {
  id: "admin",
  username: "Admin",
  role: "admin",
  status: "active",
};
const none = { p50: null, p95: null, samples: 0 };
const app = "9415f91b-569d-4d93-a09d-8f7f903a8463",
  other = "9415f91b-569d-4d93-a09d-8f7f903a8464";
const leases = {
  admitted: 41,
  ready: 39,
  released: 30,
  expired: 8,
  failed: 2,
  active: 1,
  cleanupBlocked: 1,
  deviceSeconds: 51840,
  timeToReadySeconds: { p50: 38.2, p95: 71, samples: 39 },
  holdSeconds: { p50: 900, p95: 3600, samples: 40 },
};
const requests = {
  submitted: 40,
  admitted: 36,
  cancelled: 2,
  expired: 1,
  rejected: 1,
  waiting: 0,
  waitSeconds: { p50: 4, p95: 212.5, samples: 36 },
};
const quiet = {
  key: other,
  requests: {
    submitted: 1,
    admitted: 0,
    cancelled: 0,
    expired: 0,
    rejected: 0,
    waiting: 1,
    waitSeconds: none,
  },
  leases: {
    admitted: 0,
    ready: 0,
    released: 0,
    expired: 0,
    failed: 0,
    active: 0,
    cleanupBlocked: 0,
    deviceSeconds: 17280,
    timeToReadySeconds: none,
    holdSeconds: none,
  },
};
function report(query: URLSearchParams, extra: Record<string, unknown> = {}) {
  const groupBy = query.get("groupBy")!,
    host = groupBy === "host";
  const strip = <T extends { requests?: unknown }>({
    requests: _,
    ...rest
  }: T) => rest;
  const rows = [{ key: app, label: "Build agent", requests, leases }, quiet];
  const totals = {
    key: "total",
    requests: { ...requests, submitted: 41, waiting: 1 },
    leases: { ...leases, deviceSeconds: 69120 },
  };
  return {
    from: query.get("from"),
    to: query.get("to"),
    groupBy,
    generatedAt: "2026-11-21T09:14:03.512Z",
    retention: {
      requestRecords: "not pruned",
      leaseLedgerSeconds: 34560000,
      leaseLedgerStartedAt: "2026-11-01T08:00:00.000Z",
    },
    rows: host ? rows.map(strip) : rows,
    totals: host ? strip(totals) : totals,
    ...extra,
  };
}
const response = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});
let asked: URLSearchParams[], answer: (query: URLSearchParams) => unknown;
beforeEach(() => {
  asked = [];
  answer = (query) => report(query);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const query = new URL(url, "http://localhost").searchParams;
      asked.push(query);
      if (query.get("format") === "csv")
        return new Response("group,key\r\n", {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8" },
        });
      const reply = answer(query);
      if (reply instanceof Error) throw reply;
      return reply !== null && typeof reply === "object" && "ok" in reply
        ? reply
        : response(reply);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const pair = (scope: HTMLElement, label: string) =>
  within(scope).getByText(label, { selector: "dt" }).nextElementSibling!
    .textContent;
const groups = () => screen.findByRole("list", { name: /^Usage by / });

test("a report shows requests by outcome, waits, leases, device time, holds and failures, with what they are", async () => {
  render(<UsageReport user={admin} onDenied={vi.fn()} />);
  const [busy, idle] = within(await groups()).getAllByRole("listitem");
  // The default question: the last 24 hours by application.
  expect(asked).toHaveLength(1);
  expect(asked[0]!.get("groupBy")).toBe("application");
  expect(
    Date.parse(asked[0]!.get("to")!) - Date.parse(asked[0]!.get("from")!),
  ).toBe(86400 * 1000);
  expect(within(busy!).getByText("Build agent")).toBeTruthy();
  expect(within(busy!).getByText(app).className).toContain("font-mono");
  expect(pair(busy!, "Requests by outcome")).toBe(
    "40 submitted36 admitted · 2 cancelled · 1 expired · 1 rejected · 0 still waiting",
  );
  expect(pair(busy!, "Wait until admitted")).toBe(
    "4s · 3m 32sp50 · p95 of 36 samples",
  );
  expect(pair(busy!, "Leases")).toBe(
    "41 admitted39 became ready · 30 released · 8 expired · 1 active",
  );
  expect(pair(busy!, "Device time held")).toBe("14h 24m75% of the total");
  expect(
    within(busy!).getByRole("meter", {
      name: "75% of the device time held in this range",
    }),
  ).toBeTruthy();
  expect(pair(busy!, "Time to ready")).toBe(
    "38.2s · 1m 11sp50 · p95 of 39 samples",
  );
  expect(pair(busy!, "Hold time")).toBe(
    "15m 00s · 1h 00mp50 · p95 of 40 samples",
  );
  expect(pair(busy!, "Failures")).toBe(
    "42 failed leases · 1 with cleanup blocked · 1 rejected requests",
  );
  // A group without a label is named by its key, and a percentile without samples is not a zero.
  expect(within(idle!).getByText(other)).toBeTruthy();
  expect(pair(idle!, "Wait until admitted")).toBe("No samples");
  expect(pair(idle!, "Hold time")).toBe("No samples");
  expect(pair(idle!, "Device time held")).toBe("4h 48m25% of the total");
  // The total stands apart and has no share of itself.
  const totals = screen.getByRole("region", { name: "Total for the range" });
  expect(pair(totals, "Device time held")).toBe("19h 12m");
  expect(pair(totals, "Requests by outcome")).toContain("41 submitted");
  // Provenance: what the figures are, what they are not, and where they begin.
  expect(
    screen.getByText(
      /Device\s+time is held lease time, not CPU, memory or power measured on a\s+host/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /Lease figures begin .* when the usage ledger started; leases that ended before then are not in it\./,
    ),
  ).toBeTruthy();
  expect(screen.getByText(/read from the\s+controller at/)).toBeTruthy();
  expect(
    screen.queryByText(/This range starts before the usage ledger did/),
  ).toBeNull();
});

test("grouping by host reports leases only and says why; a range before the ledger is flagged", async () => {
  render(<UsageReport user={admin} onDenied={vi.fn()} />);
  await groups();
  fireEvent.change(screen.getByLabelText("Group by"), {
    target: { value: "host" },
  });
  await waitFor(() => expect(asked.at(-1)!.get("groupBy")).toBe("host"));
  await screen.findByRole("list", { name: "Usage by host" });
  const first = within(
    screen.getByRole("list", { name: "Usage by host" }),
  ).getAllByRole("listitem")[0]!;
  expect(pair(first, "Requests by outcome")).toBe("Not counted by host");
  expect(pair(first, "Wait until admitted")).toBe("Not counted by host");
  expect(pair(first, "Failures")).toBe(
    "32 failed leases · 1 with cleanup blocked",
  );
  expect(
    screen.getByText(/A request has no host until it is admitted/),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Range"), {
    target: { value: "30d" },
  });
  await waitFor(() =>
    expect(
      Date.parse(asked.at(-1)!.get("to")!) -
        Date.parse(asked.at(-1)!.get("from")!),
    ).toBe(30 * 86400 * 1000),
  );
  // The ledger began on 1 November; a range reaching further back is told so.
  answer = (query) => report(query, { from: "2026-10-22T09:14:03.000Z" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(
    (
      await screen.findByText(/This range starts before the usage ledger did/)
    ).getAttribute("role"),
  ).toBe("status");
});

test("a custom range is checked before it is asked for", async () => {
  render(<UsageReport user={admin} onDenied={vi.fn()} />);
  await groups();
  fireEvent.change(screen.getByLabelText("Range"), {
    target: { value: "custom" },
  });
  expect(screen.getByText("Choose a start and an end.")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Refresh usage" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("From (local time)"), {
    target: { value: "2026-11-10T00:00" },
  });
  fireEvent.change(screen.getByLabelText("To (local time)"), {
    target: { value: "2026-11-09T00:00" },
  });
  expect(screen.getByText("The start must be before the end.")).toBeTruthy();
  expect(asked).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("To (local time)"), {
    target: { value: "2026-11-17T00:00" },
  });
  await waitFor(() => expect(asked).toHaveLength(2));
  expect(
    Date.parse(asked[1]!.get("to")!) - Date.parse(asked[1]!.get("from")!),
  ).toBe(7 * 86400 * 1000);
  expect(asked[1]!.get("from")).toBe(
    new Date("2026-11-10T00:00").toISOString(),
  );
});

test("the CSV download covers exactly the report on screen and reports a failure in place", async () => {
  const created: Blob[] = [],
    clicked: string[] = [];
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return "blob:usage";
      },
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(`${this.download} ${this.href}`);
  });
  render(<UsageReport user={admin} onDenied={vi.fn()} />);
  await groups();
  const shown = asked[0]!;
  fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
  await waitFor(() => expect(clicked).toHaveLength(1));
  expect(Object.fromEntries(asked[1]!)).toEqual({
    from: shown.get("from"),
    to: shown.get("to"),
    groupBy: "application",
    format: "csv",
  });
  expect(clicked[0]).toBe(
    `canaveral-usage-application-${shown.get("from")!.slice(0, 10)}_${shown.get("to")!.slice(0, 10)}.csv blob:usage`,
  );
  expect(created[0]!.size).toBe("group,key\r\n".length);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: "Orchestrator response was not confirmed." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
  expect(
    (
      await screen.findByText("Orchestrator response was not confirmed.")
    ).getAttribute("role"),
  ).toBe("alert");
  expect(clicked).toHaveLength(1);
  // The report itself is untouched by a failed download.
  expect(within(await groups()).getAllByRole("listitem")).toHaveLength(2);
});

test("a failed read keeps the earlier report and says so; an empty range says what would appear", async () => {
  render(<UsageReport user={admin} onDenied={vi.fn()} />);
  await groups();
  answer = () => new Error("offline");
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The usage shown is from an earlier read. Could not load data. Try refreshing.",
  );
  expect(within(await groups()).getAllByRole("listitem")).toHaveLength(2);
  const empty = {
    key: "total",
    requests: {
      submitted: 0,
      admitted: 0,
      cancelled: 0,
      expired: 0,
      rejected: 0,
      waiting: 0,
      waitSeconds: none,
    },
    leases: quiet.leases,
  };
  answer = (query) =>
    report(query, {
      rows: [],
      totals: { ...empty, leases: { ...empty.leases, deviceSeconds: 0 } },
    });
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(
    await screen.findByText("Nothing recorded in this range"),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByText(
      /appears here\s+when a request was submitted or a lease was admitted or\s+still held/,
    ),
  ).toBeTruthy();
  // A controller without a usage ledger: lease figures are unavailable, not zero.
  answer = (query) =>
    report(query, {
      retention: {
        requestRecords: "not pruned",
        leaseLedgerSeconds: 34560000,
        leaseLedgerStartedAt: null,
      },
    });
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  expect(
    await screen.findByText(
      /reports no usage ledger, so lease figures are unavailable rather than zero/,
    ),
  ).toBeTruthy();
});

test("a reply for another grouping is not shown; lost authority clears the page", async () => {
  const onDenied = vi.fn();
  answer = (query) => ({ ...report(query), groupBy: "template" });
  const view = render(<UsageReport user={admin} onDenied={onDenied} />);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load data. Try refreshing.",
  );
  expect(screen.queryByRole("list")).toBeNull();
  answer = () =>
    response({ error: "Credential scope does not permit this action." }, 403);
  fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert").textContent).toBe(
    "Administrator access is required.",
  );
  view.unmount();
  asked = [];
  render(<UsageReport user={{ ...admin, role: "user" }} onDenied={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toBe(
    "Administrator access is required.",
  );
  expect(asked).toEqual([]);
});
