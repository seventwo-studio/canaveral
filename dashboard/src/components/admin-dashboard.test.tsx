import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AdminOverview,
  AdminTokensPage,
  useAdminUsers,
} from "./admin-dashboard";
import type { User } from "@/lib/inventory";

const admin: User = {
  id: "admin",
  username: "admin",
  role: "admin",
  status: "active",
};
const alice: User = {
  id: "alice",
  username: "alice",
  role: "user",
  status: "active",
};
const token = {
  id: "pat-id",
  userId: "alice",
  name: "Deploy worker",
  prefix: "cv_safe_",
  scopes: ["machines:read"],
  createdAt: 100,
  expiresAt: 9999999999,
  lastUsedAt: null,
  revokedAt: null as number | null,
};
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
let rows: (typeof token)[],
  calls: Array<{ path: string; method: string }>,
  handler: (path: string, method: string) => unknown;
function Harness({
  identity = admin,
  onDenied = vi.fn(),
  overview = false,
}: {
  identity?: User;
  onDenied?: () => void;
  overview?: boolean;
}) {
  const directory = useAdminUsers(identity, onDenied);
  return overview ? (
    <AdminOverview
      user={identity}
      inventory={{ machines: [], hosts: [], templates: [] }}
      loaded={false}
      stale="Inventory unavailable"
      directory={directory}
      onDenied={onDenied}
      onInspect={vi.fn()}
      onRefresh={vi.fn()}
    />
  ) : (
    <AdminTokensPage
      key={identity.id}
      user={identity}
      directory={directory}
      onDenied={onDenied}
    />
  );
}
beforeEach(() => {
  rows = [{ ...token }];
  calls = [];
  handler = (path, method) => {
    if (path === "users") return json({ users: [admin, alice] });
    if (path === "admin/tokens") return json({ tokens: rows });
    if (method === "POST") {
      rows = rows.map((t) => ({ ...t, revokedAt: 123 }));
      return json(rows[0]);
    }
    return json({}, 404);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.replace("/api/v1/", "");
      calls.push({ path, method: options.method ?? "GET" });
      return handler(path, options.method ?? "GET");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("confirms cross-user revocation and refreshes terminal metadata without displaying a secret", async () => {
  const actor = userEvent.setup();
  render(<Harness />);
  const row = await screen.findByRole("row", { name: /Deploy worker/ });
  expect(within(row).getByText("alice")).toBeTruthy();
  await actor.click(
    within(row).getByRole("button", { name: "Revoke Deploy worker" }),
  );
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await actor.click(screen.getByRole("button", { name: "Cancel" }));
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  await actor.click(
    within(row).getByRole("button", { name: "Revoke Deploy worker" }),
  );
  const dialog = screen.getByRole("alertdialog");
  expect(within(dialog).getByText(/for alice/)).toBeTruthy();
  await actor.click(
    within(dialog).getByRole("button", { name: "Revoke token" }),
  );
  await screen.findByText("Revoked Deploy worker.");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Revoke Deploy worker" }),
    ).toBeNull(),
  );
  expect(calls.filter((c) => c.method === "POST")).toEqual([
    { path: "admin/tokens/pat-id/revoke", method: "POST" },
  ]);
  expect(
    screen.queryByRole("textbox", { name: /secret|New API token/ }),
  ).toBeNull();
});
it("refreshes an unknown mutation outcome without replaying it", async () => {
  const original = handler;
  handler = (path, method) => {
    if (method === "POST") {
      rows = rows.map((t) => ({ ...t, revokedAt: 123 }));
      throw new Error("Lost reply");
    }
    return original(path, method);
  };
  const actor = userEvent.setup();
  render(<Harness />);
  await actor.click(
    await screen.findByRole("button", { name: "Revoke Deploy worker" }),
  );
  await actor.click(screen.getByRole("button", { name: "Revoke token" }));
  await screen.findByText(/Revocation could not be confirmed/);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Revoke Deploy worker" }),
    ).toBeNull(),
  );
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it("filters tokens by owner and terminal state", async () => {
  rows.push({
    ...token,
    id: "other",
    userId: "admin",
    name: "Old runner",
    revokedAt: 100,
  });
  const actor = userEvent.setup();
  render(<Harness />);
  await screen.findByText("Old runner");
  await actor.type(screen.getByLabelText("Search API tokens"), "alice");
  expect(screen.queryByText("Old runner")).toBeNull();
  await actor.selectOptions(screen.getByLabelText("Token status"), "revoked");
  expect(screen.queryByRole("row", { name: /Deploy worker/ })).toBeNull();
  expect(screen.getByText(/No tokens match/)).toBeTruthy();
});
it("clears a denied revoke without issuing another privileged request", async () => {
  const onDenied = vi.fn(),
    actor = userEvent.setup();
  render(<Harness onDenied={onDenied} />);
  await screen.findByRole("row", { name: /Deploy worker/ });
  const original = handler;
  handler = (path, method) =>
    method === "POST"
      ? json({ error: "Access changed" }, 403)
      : original(path, method);
  await actor.click(
    screen.getByRole("button", { name: "Revoke Deploy worker" }),
  );
  await actor.click(screen.getByRole("button", { name: "Revoke token" }));
  await waitFor(() => expect(onDenied).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("row", { name: /Deploy worker/ })).toBeNull();
  expect(calls.filter((c) => c.path === "admin/tokens")).toHaveLength(1);
});
it.each([401, 403])(
  "clears token data and reports denied access on %s",
  async (status) => {
    const onDenied = vi.fn(),
      actor = userEvent.setup();
    render(<Harness onDenied={onDenied} />);
    await screen.findByRole("row", { name: /Deploy worker/ });
    const original = handler;
    handler = (path, method) =>
      path === "admin/tokens"
        ? json({ error: "Access changed" }, status)
        : original(path, method);
    await actor.click(
      screen.getByRole("button", { name: "Refresh API access" }),
    );
    await waitFor(() => expect(onDenied).toHaveBeenCalled());
    expect(screen.queryByRole("row", { name: /Deploy worker/ })).toBeNull();
  },
);
it("does not restore a prior identity's directory or tokens from late replies", async () => {
  let resolve!: (value: unknown) => void;
  handler = () =>
    new Promise((r) => {
      resolve = r;
    });
  const view = render(<Harness />);
  await waitFor(() =>
    expect(calls.some((c) => c.path === "admin/tokens")).toBe(true),
  );
  view.rerender(<Harness identity={alice} />);
  await act(async () => {
    resolve(json({ tokens: [token] }));
  });
  expect(screen.queryByRole("row", { name: /Deploy worker/ })).toBeNull();
  expect(calls).toHaveLength(2);
});
it("shows unavailable overview counts instead of claiming zero state", async () => {
  handler = () =>
    json({ error: "Older server has no administration endpoint" }, 404);
  render(<Harness overview />);
  await screen.findByText(/API access could not be refreshed/);
  expect(screen.getAllByText("—")).toHaveLength(4);
  expect(screen.getByText(/Load inventory to review/)).toBeTruthy();
});
it.each([
  [{ status: "passed", fresh: false }, "Environment checks are stale"],
  [{ status: "checking", fresh: true }, "Environment checks in progress"],
  [undefined, "Placement not ready"],
] as const)(
  "flags online connections fenced by placement checks (%s)",
  async (health, detail) => {
    render(
      <AdminOverview
        user={admin}
        inventory={{
          machines: [],
          templates: [],
          hosts: [
            {
              id: "host",
              name: "Blocked host",
              provider: "libvirt",
              online: true,
              enabled: true,
              placementReady: false,
              capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 64 },
              health,
            },
          ],
        }}
        loaded
        stale=""
        directory={{
          data: [admin],
          error: "",
          loading: false,
          refresh: async () => {},
          clear: vi.fn(),
        }}
        onDenied={vi.fn()}
        onInspect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    await screen.findByText(detail);
    expect(
      screen
        .getByRole("link", { name: "Review Blocked host" })
        .getAttribute("href"),
    ).toBe("#hosts/host/resources");
    expect(
      screen.queryByText(/No machine or infrastructure alerts/),
    ).toBeNull();
  },
);
