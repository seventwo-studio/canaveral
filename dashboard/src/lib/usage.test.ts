import { afterEach, expect, test, vi } from "vitest";
import {
  csvName,
  deviceTime,
  failures,
  seconds,
  share,
  usageCsv,
  usagePath,
  usageRange,
  usageReport,
} from "./usage";

const distribution = { p50: 4, p95: 212.5, samples: 36 };
const row = {
  key: "9415f91b-569d-4d93-a09d-8f7f903a8463",
  label: "Build agent",
  requests: {
    submitted: 40,
    admitted: 36,
    cancelled: 2,
    expired: 1,
    rejected: 1,
    waiting: 0,
    waitSeconds: distribution,
  },
  leases: {
    admitted: 41,
    ready: 39,
    released: 30,
    expired: 8,
    failed: 2,
    active: 1,
    cleanupBlocked: 1,
    deviceSeconds: 51840.25,
    timeToReadySeconds: { p50: 38.2, p95: 71, samples: 39 },
    holdSeconds: { p50: 900, p95: 3600, samples: 40 },
  },
};
const report = {
  from: "2026-11-20T00:00:00.000Z",
  to: "2026-11-21T00:00:00.000Z",
  groupBy: "application",
  generatedAt: "2026-11-21T09:14:03.512Z",
  retention: {
    requestRecords: "not pruned",
    leaseLedgerSeconds: 34560000,
    leaseLedgerStartedAt: "2026-11-01T08:00:00.000Z",
  },
  rows: [row],
  totals: { ...row, key: "total", label: undefined },
};
afterEach(() => vi.unstubAllGlobals());

test("a usage report is decoded strictly and must answer the grouping that was asked", () => {
  const decoded = usageReport(report, "application");
  expect(decoded.rows).toEqual([row]);
  expect(decoded.totals.key).toBe("total");
  expect(decoded.leaseLedgerStartedAt).toBe("2026-11-01T08:00:00.000Z");
  expect(failures(decoded.rows[0]!)).toBe(4);
  const { requests: _, ...hostRow } = row;
  const { requests: __, ...hostTotals } = report.totals;
  const hosts = usageReport(
    { ...report, groupBy: "host", rows: [hostRow], totals: hostTotals },
    "host",
  );
  expect(hosts.rows[0]!.requests).toBeUndefined();
  expect(failures(hosts.rows[0]!)).toBe(3);
  const empty = { p50: null, p95: null, samples: 0 };
  expect(
    usageReport(
      {
        ...report,
        rows: [{ ...row, leases: { ...row.leases, holdSeconds: empty } }],
      },
      "application",
    ).rows[0]!.leases.holdSeconds,
  ).toEqual(empty);
  for (const broken of [
    // A reply for another grouping is not shown under this one.
    [report, "host"],
    [{ ...report, groupBy: "host" }, "host"],
    [{ ...report, from: "yesterday" }, "application"],
    [{ ...report, retention: {} }, "application"],
    [{ ...report, rows: [row, row] }, "application"],
    [
      {
        ...report,
        rows: [{ ...row, leases: { ...row.leases, admitted: -1 } }],
      },
      "application",
    ],
    [
      {
        ...report,
        rows: [{ ...row, leases: { ...row.leases, deviceSeconds: "many" } }],
      },
      "application",
    ],
    [
      {
        ...report,
        rows: [{ ...row, requests: { ...row.requests, waiting: 1.5 } }],
      },
      "application",
    ],
    // A percentile without a sample, or a sample without a percentile, is not a figure.
    [
      {
        ...report,
        rows: [
          {
            ...row,
            leases: {
              ...row.leases,
              holdSeconds: { p50: 0, p95: 0, samples: 0 },
            },
          },
        ],
      },
      "application",
    ],
    [
      {
        ...report,
        rows: [
          {
            ...row,
            leases: {
              ...row.leases,
              holdSeconds: { p50: null, p95: null, samples: 3 },
            },
          },
        ],
      },
      "application",
    ],
    [{ ...report, totals: undefined }, "application"],
  ] as const)
    expect(() => usageReport(broken[0], broken[1])).toThrow();
});

test("a controller without a usage ledger reports it as absent", () => {
  expect(
    usageReport(
      {
        ...report,
        retention: { ...report.retention, leaseLedgerStartedAt: null },
      },
      "application",
    ).leaseLedgerStartedAt,
  ).toBeNull();
});

test("ranges are UTC instants; a custom range is checked before it is asked for", () => {
  const now = Date.parse("2026-11-21T09:14:03.512Z");
  expect(usageRange("24h", { from: "", to: "" }, now)).toEqual({
    from: "2026-11-20T09:14:03.000Z",
    to: "2026-11-21T09:14:03.000Z",
  });
  expect(usageRange("30d", { from: "", to: "" }, now)).toEqual({
    from: "2026-10-22T09:14:03.000Z",
    to: "2026-11-21T09:14:03.000Z",
  });
  expect(
    usageRange("custom", { from: "", to: "2026-11-21T00:00" }, now),
  ).toEqual({ error: "Choose a start and an end." });
  expect(
    usageRange(
      "custom",
      { from: "2026-11-21T00:00", to: "2026-11-20T00:00" },
      now,
    ),
  ).toEqual({ error: "The start must be before the end." });
  expect(
    usageRange(
      "custom",
      { from: "2024-01-01T00:00", to: "2026-11-20T00:00" },
      now,
    ),
  ).toEqual({ error: "A range covers at most 400 days." });
  const custom = usageRange(
    "custom",
    { from: "2026-11-01T00:00", to: "2026-11-08T00:00" },
    now,
  );
  expect(
    "from" in custom && Date.parse(custom.to) - Date.parse(custom.from),
  ).toBe(7 * 86400 * 1000);
  expect(
    usagePath(
      { from: "2026-11-20T00:00:00.000Z", to: "2026-11-21T00:00:00.000Z" },
      "host",
    ),
  ).toBe(
    "admin/usage?from=2026-11-20T00%3A00%3A00.000Z&to=2026-11-21T00%3A00%3A00.000Z&groupBy=host",
  );
  expect(csvName(report, "template")).toBe(
    "canaveral-usage-template-2026-11-20_2026-11-21.csv",
  );
});

test("figures say what they are: no sample is not zero, and a share needs a total", () => {
  expect(seconds(null)).toBe("No samples");
  expect(seconds(0)).toBe("0s");
  expect(seconds(4.26)).toBe("4.3s");
  expect(seconds(212.5)).toBe("3m 32s");
  expect(deviceTime(51840)).toBe("14h 24m");
  expect(deviceTime(0.4)).toBe("<1s");
  expect(deviceTime(0)).toBe("0s");
  expect(share(25, 100)).toBe(25);
  expect(share(0, 0)).toBeNull();
});

test("the CSV download asks for exactly the range on screen and refuses anything that is not CSV", async () => {
  const requests: string[] = [];
  const reply = (body: BodyInit, status: number, type: string) =>
    new Response(body, { status, headers: { "Content-Type": type } });
  let next = () => reply("group,key\r\n", 200, "text/csv; charset=utf-8");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push(url);
      expect(init.credentials).toBe("same-origin");
      return next();
    }),
  );
  const range = { from: report.from, to: report.to };
  const file = await usageCsv(range, "host");
  expect(file.size).toBe("group,key\r\n".length);
  expect(file.type).toContain("text/csv");
  expect(requests).toEqual([
    "/api/v1/admin/usage?from=2026-11-20T00%3A00%3A00.000Z&to=2026-11-21T00%3A00%3A00.000Z&groupBy=host&format=csv",
  ]);
  next = () =>
    reply(
      JSON.stringify({
        error: "Credential scope does not permit this action.",
      }),
      403,
      "application/json",
    );
  await expect(usageCsv(range, "host")).rejects.toMatchObject({
    message: "Credential scope does not permit this action.",
    status: 403,
  });
  next = () => reply("<html>", 200, "text/html");
  await expect(usageCsv(range, "host")).rejects.toThrow("not CSV");
  next = () => {
    throw new TypeError("network");
  };
  await expect(usageCsv(range, "host")).rejects.toThrow(
    "Could not download the usage file",
  );
});
