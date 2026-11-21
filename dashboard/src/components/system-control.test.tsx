import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SystemControl } from "./system-control";
import { systemSnapshot, systemReceipt } from "@/lib/system-control";
import type { User } from "@/lib/inventory";

const user: User = {
  id: "admin",
  username: "Admin",
  role: "admin",
  status: "active",
};
const lease = {
  id: "lease",
  family: "legacy",
  state: "ready",
  applicationId: "build-agent",
  runtimeState: "running",
  cleanup: "notRequested",
  expiresAt: 1800000000,
};
const snapshot = {
  applications: [],
  leases: [lease],
  requests: [],
  jobs: [],
  operations: [],
  sessions: [],
};
const response = (value: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => value,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("safe inventory projection strips secret fields and rejects broken inventory", () => {
  expect(
    systemSnapshot({
      ...snapshot,
      leases: [{ ...lease, credential: "secret", raw: { argv: "private" } }],
    }).leases,
  ).toEqual([lease]);
  expect(() =>
    systemSnapshot({
      ...snapshot,
      leases: [{ ...lease, expiresAt: "tomorrow" }],
    }),
  ).toThrow();
  expect(() => systemSnapshot({ ...snapshot, sessions: null })).toThrow();
  expect(() =>
    systemSnapshot({ ...snapshot, leases: [lease, lease] }),
  ).toThrow();
  expect(() =>
    systemReceipt(
      {
        id: "other",
        requestId: "request",
        action: "release",
        state: "released",
      },
      "lease",
      "request",
      "release",
    ),
  ).toThrow();
});

test("lease release confirmation explains scope and unknown retries retain exact request identity", async () => {
  const mutations: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "/api/v1/admin/system") return response(snapshot);
      mutations.push({ url, body: String(init.body) });
      if (mutations.length === 1) throw new Error("lost response");
      const body = JSON.parse(String(init.body));
      return response({
        id: "lease",
        requestId: body.id,
        action: "release",
        state: "released",
      });
    }),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Release lease" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.textContent).toContain("reservations remain held");
  expect(dialog.textContent).toContain("Application: build-agent");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Release lease" }),
  );
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Retry same request" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(mutations).toHaveLength(2);
  expect(mutations[0]).toEqual(mutations[1]);
  expect(mutations[0]?.url).toBe("/api/v1/admin/leases/lease/release");
  expect(screen.getByRole("status").textContent).toContain(
    "Release lease confirmed",
  );
});

test("session closure and application revocation have distinct consequences", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        ...snapshot,
        sessions: [
          {
            id: "session",
            family: "access",
            state: "attached",
            leaseId: "lease",
          },
        ],
        applications: [
          {
            id: "app",
            family: "application",
            name: "Builder",
            state: "active",
            revoked: false,
          },
        ],
      }),
    ),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Close session" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "lease and machine remain active",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke application" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "all its leases",
  );
});

test("failed refresh retains observed data and disables actions; denial clears it", async () => {
  let calls = 0;
  const denied = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      return calls === 1
        ? response(snapshot)
        : calls === 2
          ? response({ error: "Offline" }, 503)
          : response({ error: "Forbidden" }, 403);
    }),
  );
  render(<SystemControl user={user} onDenied={denied} />);
  await screen.findByRole("button", { name: "Release lease" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh system" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "System data is stale",
  );
  expect(
    (screen.getByRole("button", { name: "Release lease" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh system" }));
  await waitFor(() => expect(denied).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Release lease" })).toBeNull();
});

test("a response from a previous account cannot populate the new account", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  const view = render(<SystemControl user={user} onDenied={vi.fn()} />);
  view.rerender(
    <SystemControl
      user={{ ...user, id: "other", role: "user" }}
      onDenied={vi.fn()}
    />,
  );
  resolve(response(snapshot));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Administrator access",
    ),
  );
  expect(screen.queryByRole("button", { name: "Release lease" })).toBeNull();
});

test("work cancellation is explicit and operations remain inspect-only", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("admin/system"))
        return response({
          ...snapshot,
          jobs: [
            {
              id: "job",
              family: "model",
              state: "running",
              applicationId: "build-agent",
              cancelRequested: false,
            },
          ],
          operations: [
            { id: "operation", family: "linux", state: "dispatched" },
          ],
        });
      requests.push(url);
      return response({
        id: "job",
        requestId: JSON.parse(String(init.body)).id,
        action: "cancel",
        state: "running",
      });
    }),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel work" }));
  expect(screen.getByRole("alertdialog").textContent).toContain(
    "Running jobs may continue",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel work" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(requests).toEqual(["/api/v1/admin/jobs/job/cancel"]);
  expect(
    within(screen.getByRole("region", { name: "operations" })).queryByRole(
      "button",
    ),
  ).toBeNull();
});

test("definite action rejection can be dismissed while service uncertainty retains retry identity", async () => {
  let failureStatus = 409;
  const mutations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("admin/system")) return response(snapshot);
      mutations.push(String(init.body));
      return response({ error: "Action rejected" }, failureStatus);
    }),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Release lease" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Release lease",
    }),
  );
  await waitFor(() =>
    expect(
      (
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Cancel",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  failureStatus = 503;
  fireEvent.click(screen.getByRole("button", { name: "Release lease" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Release lease",
    }),
  );
  fireEvent.click(
    await within(screen.getByRole("alertdialog")).findByRole("button", {
      name: "Retry same request",
    }),
  );
  await waitFor(() => expect(mutations).toHaveLength(3));
  expect(mutations[1]).toBe(mutations[2]);
  expect(
    (
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test("inventory pages clear old records before loading, validate returned page, and allow going back", async () => {
  let resolvePage!: (value: unknown) => void;
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/pages/1"))
        return new Promise((done) => {
          resolvePage = done;
        });
      return response({ ...snapshot, page: 0, nextPage: 1 });
    }),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  await screen.findByRole("button", { name: "Release lease" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Release lease" })).toBeNull();
  resolvePage(
    response({
      ...snapshot,
      leases: [{ ...lease, id: "second-lease" }],
      page: 1,
      nextPage: null,
    }),
  );
  await screen.findByText("second-lease");
  expect(
    (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByRole("button", { name: "Release lease" });
  expect(urls).toEqual([
    "/api/v1/admin/system",
    "/api/v1/admin/system/pages/1",
    "/api/v1/admin/system",
  ]);
});

test("admitted requests identify lease release and cancelled work has no second action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        ...snapshot,
        leases: [],
        requests: [
          {
            id: "request",
            family: "request",
            state: "admitted",
            applicationId: "app",
          },
          {
            id: "released",
            family: "request",
            state: "admitted",
            cancelRequested: true,
          },
        ],
        jobs: [
          {
            id: "inference",
            family: "inference",
            state: "running",
            cancelRequested: true,
          },
        ],
      }),
    ),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  expect(
    await screen.findAllByRole("button", { name: "Release admitted lease" }),
  ).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Cancel work" })).toBeNull();
});

test("an explicit unknown outcome on a 4xx still requires retrying the same request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("admin/system")
        ? response(snapshot)
        : response({ error: "Inspection required", outcome: "unknown" }, 409),
    ),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Release lease" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Release lease",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Retry same request" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a response for another page cannot relabel the previous records", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      response({
        ...snapshot,
        page: 0,
        nextPage: url.endsWith("/pages/1") ? null : 1,
      }),
    ),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  await screen.findByRole("button", { name: "Release lease" });
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Release lease" })).toBeNull();
});

test("application-scoped request identities can share a UUID without hiding inventory", () => {
  const value = systemSnapshot({
    applications: [],
    leases: [],
    requests: [
      { id: "shared", family: "request", state: "waiting", applicationId: "a" },
      { id: "shared", family: "request", state: "waiting", applicationId: "b" },
    ],
    jobs: [],
    operations: [],
    sessions: [],
  });
  expect(value.requests).toHaveLength(2);
  expect(() =>
    systemSnapshot({
      ...value,
      requests: [value.requests[0], value.requests[0]],
    }),
  ).toThrow("Duplicate");
});

test("Linux readiness remains visible separately from lease lifecycle", async () => {
  const pending = {
    ...snapshot,
    leases: [{ ...lease, family: "linux", ready: false }],
  };
  expect(systemSnapshot(pending).leases[0]?.ready).toBe(false);
  expect(() =>
    systemSnapshot({ ...snapshot, leases: [{ ...lease, ready: "false" }] }),
  ).toThrow();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(pending)),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  const label = await screen.findByText("Ready");
  expect(label.parentElement?.textContent).toBe("ReadyNo");
  expect(screen.getByText("ready")).toBeTruthy();
});

test("confirmed actions queue fresh inventory behind an in-flight refresh", async () => {
  let finish!: (value: unknown) => void;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/admin/system") {
        reads++;
        if (reads === 2)
          return new Promise((done) => {
            finish = done;
          });
        return response(
          reads > 2
            ? { ...snapshot, leases: [{ ...lease, state: "released" }] }
            : snapshot,
        );
      }
      const body = JSON.parse(String(init?.body));
      return response({
        id: lease.id,
        requestId: body.id,
        action: "release",
        state: "released",
      });
    }),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  await screen.findByRole("button", { name: "Release lease" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh system" }));
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Release lease" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Release lease",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  finish(response(snapshot));
  await screen.findByText("released");
  expect(reads).toBe(3);
  expect(screen.queryByRole("button", { name: "Release lease" })).toBeNull();
});

test("leases show the holder's label and the time remaining against the controller's clock", async () => {
  const now = 1800000000;
  const leases = [
    // A fraction of a second of margin keeps the whole-second reading stable while the test runs.
    { ...lease, id: "labelled", name: "checkout-flow", expiresAt: now + 250.9 },
    { ...lease, id: "unlabelled", family: "linux", expiresAt: now - 5 },
    {
      ...lease,
      id: "ended",
      state: "released",
      name: "old-run",
      expiresAt: now + 900,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...snapshot, leases, observedAt: now })),
  );
  render(<SystemControl user={user} onDenied={vi.fn()} />);
  const section = within(await screen.findByRole("region", { name: "leases" }));
  const card = (id: string) =>
    within(
      section
        .getAllByText(id, { exact: false })[0]!
        .closest('[data-slot="card"]') as HTMLElement,
    );
  const pair = (id: string, label: string) =>
    card(id).queryByText(label, { selector: "dt" })?.nextElementSibling
      ?.textContent;
  // The controller's clock decides the countdown, whatever the browser's clock says.
  expect(pair("labelled", "Label")).toBe("checkout-flow");
  expect(pair("labelled", "Time remaining")).toBe("4m 10s");
  expect(pair("unlabelled", "Label")).toBe("None given");
  expect(pair("unlabelled", "Time remaining")).toBe("Deadline passed");
  // An ended lease has no time remaining to count.
  expect(pair("ended", "Label")).toBe("old-run");
  expect(pair("ended", "Time remaining")).toBeUndefined();
  expect(systemSnapshot({ ...snapshot, observedAt: now }).observedAt).toBe(now);
  expect(() => systemSnapshot({ ...snapshot, observedAt: "now" })).toThrow();
});
