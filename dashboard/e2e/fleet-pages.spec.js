import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

/** Queue, Activity and Usage in a real browser under the gateway's content security policy, with
 * synthetic API fixtures. No controller, host or device takes part. */
const application = "9415f91b-569d-4d93-a09d-8f7f903a8463";
const lease = "b7682a27-b32e-472a-8a4d-f54a98a6d962";
const host = "5a0d0a53-6f3e-4d0e-8a3c-0d1b7f2f9a10";
const requestId = "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f11";
const template = { id: "pixel-8", revision: "3", arch: "arm64" };
const kinds = [
  [
    "lease.admitted",
    "A lease was admitted and its resources reserved; provisioning began.",
    false,
  ],
  ["lease.failed", "A lease failed during provisioning or at runtime.", true],
  [
    "request.waiting_long",
    "A request has waited longer than the configured threshold.",
    true,
  ],
  [
    "host.offline",
    "A host stopped reporting within the freshness window.",
    true,
  ],
  ["operation.succeeded", "A device or command operation succeeded.", false],
].map(([kind, summary, attention]) => ({
  kind,
  summary,
  routine: false,
  attention,
}));
const none = { p50: null, p95: null, samples: 0 };
const usageRow = {
  key: application,
  label: "Build agent with a deliberately long display name",
  requests: {
    submitted: 40,
    admitted: 36,
    cancelled: 2,
    expired: 1,
    rejected: 1,
    waiting: 0,
    waitSeconds: { p50: 4, p95: 212.5, samples: 36 },
  },
  leases: {
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
  },
};
const quietRow = {
  key: "ubuntu-24.04-workspace-with-a-long-template-name@2026.11.1/arm64",
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
const withoutRequests = ({ requests: _, ...row }) => row;

for (const width of [320, 1440]) {
  test(`queue, activity and usage under CSP at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const started = Date.now();
    const iso = (offsetSeconds) =>
      new Date(started + offsetSeconds * 1000).toISOString();
    let cancelled = false,
      sequence = 4812;
    const mutations = [],
      eventReads = [],
      usageReads = [];
    const events = [
      {
        sequence: 4810,
        at: iso(-120),
        kind: "lease.admitted",
        applicationId: application,
        leaseId: lease,
        hostId: host,
        data: { ledger: "generic", templateId: "pixel-8", platform: "android" },
      },
      {
        sequence: 4811,
        at: iso(-60),
        kind: "request.waiting_long",
        applicationId: application,
        requestId,
        data: {
          requestKind: "lease",
          waitedSeconds: 600,
          thresholdSeconds: 600,
          reason: "capacity_unavailable",
        },
      },
      {
        sequence: 4812,
        at: iso(-5),
        kind: "lease.failed",
        applicationId: application,
        leaseId: lease,
        hostId: host,
        data: { ledger: "generic", reason: "runtime_error" },
      },
    ];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.split("/api/v1/")[1];
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (path === "machines") result = { machines: [] };
      else if (path === "hosts") result = { hosts: [] };
      else if (path === "templates") result = { templates: [] };
      else if (path === "users") result = { users: [adminUser] };
      else if (path === "admin/queue")
        result = {
          observedAt: iso(0),
          limit: 500,
          waitingTotal: cancelled ? 2 : 3,
          activeTotal: 2,
          requests: [
            ...(cancelled
              ? []
              : [
                  {
                    id: requestId,
                    applicationId: application,
                    applicationName: "Build agent",
                    kind: "lease",
                    position: 1,
                    reason: "capacity_unavailable",
                    priority: 5,
                    createdAt: iso(-642),
                    deadline: iso(900),
                    label: "checkout-flow-on-a-long-branch-name",
                    template,
                    platform: "android",
                  },
                ]),
            {
              id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f12",
              applicationId: application,
              applicationName: "Build agent",
              kind: "linux-lease",
              position: cancelled ? 1 : 2,
              reason: "limit_exceeded",
              priority: 0,
              createdAt: iso(-75),
              deadline: null,
              template: { id: "workspace", revision: "2", arch: "arm64" },
              platform: "linux",
            },
            {
              id: "3d0c0a0e-6d3b-4d8a-9a51-0e6a3f0f6f13",
              applicationId: application,
              kind: "model-job",
              position: null,
              reason: null,
              priority: 0,
              createdAt: iso(-20),
              deadline: null,
              model: "fixture-model",
            },
          ],
          leases: [
            {
              id: lease,
              ledger: "generic",
              applicationId: application,
              applicationName: "Build agent",
              name: "nightly-run",
              state: "ready",
              createdAt: iso(-1500),
              expiresAt: iso(300),
              template,
              platform: "android",
            },
            {
              id: "b7682a27-b32e-472a-8a4d-f54a98a6d963",
              ledger: "linux",
              applicationId: application,
              name: null,
              state: "provisioning",
              createdAt: iso(-30),
              expiresAt: iso(1770),
              template: { id: "workspace", revision: "2", arch: "arm64" },
              platform: "linux",
            },
          ],
        };
      else if (path === `admin/requests/${requestId}/cancel`) {
        const body = route.request().postDataJSON();
        mutations.push(body);
        cancelled = true;
        result = {
          id: requestId,
          requestId: body.id,
          action: "cancel",
          state: "cancelled",
          applicationId: body.applicationId,
        };
      } else if (path === "admin/events/kinds") result = { kinds };
      else if (path === "admin/events") {
        eventReads.push(url.search);
        const selected = url.searchParams.getAll("kind");
        const subjects = [
          ["application", "applicationId"],
          ["lease", "leaseId"],
          ["request", "requestId"],
          ["host", "hostId"],
        ];
        const matches = (event) =>
          (!selected.length ||
            selected.some((kind) =>
              kind.endsWith(".*")
                ? event.kind.startsWith(kind.slice(0, -1))
                : event.kind === kind,
            )) &&
          subjects.every(
            ([parameter, field]) =>
              !url.searchParams.has(parameter) ||
              event[field] === url.searchParams.get(parameter),
          );
        // The first live read after the page opened finds one new event; later ones find none.
        if (url.searchParams.get("after") === "4812" && sequence === 4812)
          events.push({
            sequence: ++sequence,
            at: iso(1),
            kind: "host.offline",
            hostId: host,
            data: { lastSeenAt: iso(-31), silentSeconds: 31 },
          });
        const after = Number(url.searchParams.get("after") ?? 0);
        result = {
          events: events.filter(
            (event) => event.sequence > after && matches(event),
          ),
          cursor: sequence,
          more: false,
          truncated: false,
          oldestSequence: 4000,
          latestSequence: sequence,
        };
      } else if (path === "admin/usage") {
        usageReads.push(url.search);
        if (url.searchParams.get("format") === "csv") {
          await route.fulfill({
            status: 200,
            contentType: "text/csv; charset=utf-8",
            body: "group,key,label\r\napplication,total,\r\n",
          });
          return;
        }
        const byHost = url.searchParams.get("groupBy") === "host",
          rows = [usageRow, quietRow];
        const totals = {
          key: "total",
          requests: { ...usageRow.requests, submitted: 41, waiting: 1 },
          leases: { ...usageRow.leases, deviceSeconds: 69120 },
        };
        result = {
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          groupBy: url.searchParams.get("groupBy"),
          generatedAt: iso(0),
          retention: {
            requestRecords: "not pruned",
            leaseLedgerSeconds: 34560000,
            leaseLedgerStartedAt: iso(-3600),
          },
          rows: byHost ? rows.map(withoutRequests) : rows,
          totals: byHost ? withoutRequests(totals) : totals,
        };
      }
      await route.fulfill({ json: result });
    });
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const shot = async (name) => {
      if (process.env.CANAVERAL_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.CANAVERAL_SCREENSHOT_DIR}/${name}-${width}.png`,
          fullPage: true,
        });
    };

    await page.goto("/#queue");
    await expect(
      page.getByRole("heading", { name: "Queue", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Position is an order of attempts, not a promise", {
        exact: false,
      }),
    ).toBeVisible();
    const waiting = page.getByRole("list", {
      name: "Waiting requests in attempt order",
    });
    await expect(waiting.getByLabel("Position 1")).toHaveText("#1");
    await expect(
      waiting.getByText("No eligible host has free capacity for it"),
    ).toBeVisible();
    await expect(
      waiting.getByText(
        "No single order: runners claim model calls per domain",
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Leases holding capacity" })
        .getByText("nightly-run"),
    ).toBeVisible();
    // Waiting time and time remaining are counted against the controller's clock.
    await expect(waiting.getByText(/^10m 4\ds$/)).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Leases holding capacity" })
        .getByText(/^4m 5\ds$/),
    ).toBeVisible();
    expect(await fits()).toBe(true);
    await shot("queue");
    await page
      .getByRole("button", {
        name: "Cancel request checkout-flow-on-a-long-branch-name",
      })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(requestId);
    await expect(dialog).toContainText("administrator_cancelled");
    expect(mutations).toHaveLength(0);
    await shot("queue-cancel");
    await dialog
      .getByRole("button", { name: "Cancel request", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "cancelled" }),
    ).toBeVisible();
    expect(mutations).toEqual([
      {
        id: expect.stringMatching(/^[a-f0-9-]{36}$/),
        applicationId: application,
      },
    ]);
    await expect(waiting.getByLabel("Position 1")).toHaveText("#1");
    await expect(
      waiting.getByText("checkout-flow-on-a-long-branch-name"),
    ).toHaveCount(0);

    // A lease on the Queue page links to its events.
    await page
      .getByRole("link", { name: `Activity of lease ${lease}` })
      .click();
    await expect(
      page.getByRole("heading", { name: "Activity", exact: true }),
    ).toBeVisible();
    const feed = page.getByRole("list", { name: "Events, newest first" });
    await expect(feed.getByRole("listitem")).toHaveCount(2);
    expect(eventReads.at(-1)).toBe(`?tail=100&lease=${lease}`);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(feed.getByRole("listitem").first()).toContainText(
      "lease.failed",
    );
    await expect(feed.getByText("Needs attention").first()).toBeVisible();
    // A live read by cursor brings in the next event without a reload.
    await expect(feed.getByRole("listitem").first()).toContainText(
      "host.offline",
      { timeout: 10_000 },
    );
    expect(eventReads).toContain("?after=4812&limit=500");
    await expect(feed.getByRole("listitem")).toHaveCount(4);
    await page.getByLabel("Needs attention only").check();
    await expect(feed.getByRole("listitem")).toHaveCount(3);
    expect(eventReads.at(-1)).toBe(
      "?tail=100&kind=lease.failed&kind=request.waiting_long&kind=host.offline",
    );
    expect(await fits()).toBe(true);
    await shot("activity");

    await page.goto("/#usage");
    await expect(
      page.getByRole("heading", { name: "Usage", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Device time is held lease time, not CPU, memory or power",
        { exact: false },
      ),
    ).toBeVisible();
    const groups = page.getByRole("list", { name: "Usage by application" });
    await expect(groups.getByRole("listitem")).toHaveCount(2);
    await expect(groups.getByText("14h 24m")).toBeVisible();
    await expect(groups.getByText("No samples").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download CSV" }),
    ).toBeEnabled();
    expect(await fits()).toBe(true);
    await shot("usage");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    expect((await download).suggestedFilename()).toMatch(
      /^canaveral-usage-application-\d{4}-\d\d-\d\d_\d{4}-\d\d-\d\d\.csv$/,
    );
    expect(usageReads.at(-1)).toContain("format=csv");
    await page.getByLabel("Group by").selectOption("host");
    await expect(
      page
        .getByRole("list", { name: "Usage by host" })
        .getByText("Not counted by host")
        .first(),
    ).toBeVisible();
    expect(await fits()).toBe(true);
    await shot("usage-host");
    expect(info.errors).toEqual([]);
  });
}
