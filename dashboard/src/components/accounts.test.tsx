import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountPage, TokensPage, UsersPage } from "./accounts";
import { ClaimScreen, takeClaim } from "./claim-screen";
import { tokenScopes, tokenState } from "@/lib/accounts";
import { loginReceipt, type User } from "@/lib/inventory";
const account: User = {
  id: "own",
  username: "alice",
  role: "user",
  status: "active",
};
const token = {
  id: "t1",
  name: "Automation",
  scopes: ["machines:read"],
  prefix: "cnv_safe",
  createdAt: 10,
  expiresAt: 9999999999,
  lastUsedAt: null,
  revokedAt: null,
};
let requests: { path: string; body?: Record<string, unknown> }[];
let route: (path: string, body?: Record<string, unknown>) => unknown;
beforeEach(() => {
  requests = [];
  route = (path) => (path === "auth/tokens" ? { tokens: [token] } : {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: RequestInit) => {
      const path = url.replace("/api/v1/", ""),
        body = opts.body ? JSON.parse(String(opts.body)) : undefined;
      requests.push({ path, body });
      const value = await route(path, body);
      return { ok: true, json: async () => value };
    }),
  );
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("rejects missing or unknown account authority", () => {
  expect(() => loginReceipt({ user: { username: "old-admin" } })).toThrow();
  expect(() => loginReceipt({ user: { ...account, role: "owner" } })).toThrow();
  expect(loginReceipt({ user: account }).user.role).toBe("user");
});
it("removes claim fragments immediately without writing browser storage", async () => {
  const local = vi.spyOn(Storage.prototype, "setItem");
  history.replaceState({}, "", "/#claim=fixture-claim");
  const claim = takeClaim();
  expect(location.hash).toBe("");
  expect(claim).toBe("fixture-claim");
  route = (path) =>
    path === "auth/claim/info"
      ? { kind: "invite", username: "alice", expiresAt: 9999999999 }
      : { user: account };
  const done = vi.fn(),
    actor = userEvent.setup();
  render(<ClaimScreen token={claim!} onDone={done} />);
  await screen.findByText("Account: alice");
  await actor.type(screen.getByLabelText("New password"), "fixture password");
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "fixture password",
  );
  await actor.click(
    screen.getByRole("button", { name: "Save password and sign in" }),
  );
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(requests.find((r) => r.path === "auth/claim")?.body).toEqual({
    token: "fixture-claim",
    password: "fixture password",
  });
  expect(local).not.toHaveBeenCalled();
  local.mockRestore();
});
it("gives expired claim recovery instructions and never replays a lost claim", async () => {
  route = (path) =>
    path === "auth/claim/info"
      ? { kind: "reset", username: "alice", expiresAt: 9999999999 }
      : Promise.reject(new Error("lost"));
  const actor = userEvent.setup();
  render(<ClaimScreen token="fixture-claim" onDone={vi.fn()} />);
  await screen.findByText("Account: alice");
  await actor.type(screen.getByLabelText("New password"), "fixture password");
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "fixture password",
  );
  await actor.click(
    screen.getByRole("button", { name: "Save password and sign in" }),
  );
  await screen.findByText(/Sign in with the password you just chose/);
  expect(
    screen
      .getByRole("button", { name: "Save password and sign in" })
      .matches(":disabled"),
  ).toBe(true);
  expect(requests.filter((r) => r.path === "auth/claim")).toHaveLength(1);
});
it("accepts bootstrap information with no username selected yet", async () => {
  route = () => ({ kind: "bootstrap", username: null, expiresAt: 9999999999 });
  render(<ClaimScreen token="fixture-bootstrap" onDone={vi.fn()} />);
  expect(await screen.findByLabelText("Username")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Save password and sign in" })
      .matches(":disabled"),
  ).toBe(false);
});
it("allows correcting a refused bootstrap username without replaying a claim automatically", async () => {
  route = (path) =>
    path === "auth/claim/info"
      ? { kind: "bootstrap", username: null, expiresAt: 9999999999 }
      : Promise.reject(
          Object.assign(new Error("Choose a valid username."), { status: 400 }),
        );
  const actor = userEvent.setup();
  render(<ClaimScreen token="fixture-bootstrap" onDone={vi.fn()} />);
  await actor.type(await screen.findByLabelText("Username"), "-invalid");
  await actor.type(screen.getByLabelText("New password"), "fixture password");
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "fixture password",
  );
  await actor.click(
    screen.getByRole("button", { name: "Save password and sign in" }),
  );
  await screen.findByText("Choose a valid username.");
  expect(
    screen
      .getByRole("button", { name: "Save password and sign in" })
      .matches(":disabled"),
  ).toBe(false);
  expect(requests.filter((r) => r.path === "auth/claim")).toHaveLength(1);
});
it("treats a server failure after password change as uncertain", async () => {
  route = () =>
    Promise.reject(
      Object.assign(new Error("Service unavailable"), { status: 503 }),
    );
  const actor = userEvent.setup();
  render(<AccountPage user={account} onChanged={vi.fn()} />);
  await actor.type(
    screen.getByLabelText("Current password"),
    "fixture password",
  );
  await actor.type(
    screen.getByLabelText("New password"),
    "new fixture password",
  );
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "new fixture password",
  );
  await actor.click(screen.getByRole("button", { name: "Change password" }));
  await screen.findByText(/The password change could not be confirmed/);
  expect(
    screen
      .getByRole("button", { name: "Change password" })
      .matches(":disabled"),
  ).toBe(true);
  expect(requests.filter((r) => r.path === "auth/password")).toHaveLength(1);
});
it("limits token presets and shows secrets once without persisting them", async () => {
  expect(tokenScopes("admin", false)).toEqual(["machines:read"]);
  const set = vi.spyOn(Storage.prototype, "setItem");
  route = (path, body) =>
    body?.name
      ? { ...token, id: body.id, name: body.name, token: "fixture-secret" }
      : { tokens: [token] };
  const actor = userEvent.setup();
  render(<TokensPage user={account} />);
  await screen.findByText(/Automation · Active/);
  expect(
    screen.queryByRole("option", { name: "Administrator access" }),
  ).toBeNull();
  await actor.type(screen.getByLabelText("Token name"), "Agent");
  await actor.selectOptions(screen.getByLabelText("Permissions"), "manage");
  await actor.click(screen.getByRole("button", { name: "Create token" }));
  await screen.findByDisplayValue("fixture-secret");
  expect(requests.find((r) => r.body?.name)?.body?.scopes).toEqual([
    "machines:read",
    "machines:write",
    "machines:access",
  ]);
  await actor.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByDisplayValue("fixture-secret")).toBeNull();
  expect(set).not.toHaveBeenCalled();
  set.mockRestore();
});
it("keeps uncertain token IDs for explicit revocation without mint replay", async () => {
  route = (path, body) =>
    body?.name
      ? Promise.reject(new Error("lost"))
      : path.endsWith("revoke")
        ? {}
        : { tokens: [] };
  const actor = userEvent.setup();
  render(<TokensPage user={account} />);
  await actor.type(screen.getByLabelText("Token name"), "Lost");
  await actor.click(screen.getByRole("button", { name: "Create token" }));
  await screen.findByText(/Token creation could not be confirmed/);
  const id = requests.find((r) => r.body?.name)?.body?.id;
  expect(
    screen.getByRole("button", { name: "Create token" }).matches(":disabled"),
  ).toBe(true);
  await actor.click(screen.getByRole("button", { name: "Refresh tokens" }));
  expect(requests.filter((r) => r.body?.name)).toHaveLength(1);
  await actor.click(
    screen.getByRole("button", { name: "Revoke uncertain token" }),
  );
  await waitFor(() =>
    expect(requests.some((r) => r.path === `auth/tokens/${id}/revoke`)).toBe(
      true,
    ),
  );
});
it("handles mint replays without a secret and distinguishes token states", async () => {
  expect(tokenState({ ...token, expiresAt: 1 })).toBe("Expired");
  expect(tokenState({ ...token, expiresAt: 1, revokedAt: 2 })).toBe("Revoked");
  route = (_path, body) =>
    body?.name
      ? { ...token, id: body.id, name: body.name }
      : { tokens: [token] };
  const actor = userEvent.setup();
  render(<TokensPage user={{ ...account, role: "admin" }} />);
  await actor.type(screen.getByLabelText("Token name"), "Replay");
  await actor.selectOptions(screen.getByLabelText("Permissions"), "admin");
  await actor.click(screen.getByRole("button", { name: "Create token" }));
  await screen.findByText(/secret is unavailable/);
  expect(requests.find((r) => r.body?.name)?.body?.scopes).toEqual(["admin"]);
});
it("changes password only with confirmation and calls logout flow", async () => {
  const done = vi.fn(),
    actor = userEvent.setup();
  render(<AccountPage user={account} onChanged={done} />);
  await actor.type(
    screen.getByLabelText("Current password"),
    "old fixture password",
  );
  await actor.type(
    screen.getByLabelText("New password"),
    "new fixture password",
  );
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "mismatch fixture",
  );
  await actor.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Passwords do not match.")).toBeTruthy();
  expect(requests).toHaveLength(0);
  await actor.clear(screen.getByLabelText("Confirm password"));
  await actor.type(
    screen.getByLabelText("Confirm password"),
    "new fixture password",
  );
  await actor.click(screen.getByRole("button", { name: "Change password" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(requests[0]?.body).toEqual({
    currentPassword: "old fixture password",
    password: "new fixture password",
  });
});
it("creates pending ordinary accounts, issues and revokes links, and surfaces last-admin rejection", async () => {
  const pending = { ...account, status: "pending" };
  route = (path, body) =>
    path === "users" && !body
      ? {
          users: [
            pending,
            { ...account, id: "admin", username: "admin", role: "admin" },
          ],
        }
      : path.endsWith("invite")
        ? { token: "fixture-invite" }
        : {};
  const actor = userEvent.setup();
  render(<UsersPage />);
  await screen.findByText("alice · user · pending");
  await actor.type(screen.getByLabelText("New username"), "bob");
  await actor.click(screen.getByRole("button", { name: "Create user" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) => r.body?.username === "bob" && r.body.role === "user",
      ),
    ).toBe(true),
  );
  await actor.click(
    screen.getByRole("button", { name: "Issue invitation for alice" }),
  );
  await screen.findByDisplayValue(/#claim=fixture-invite/);
  await actor.click(
    screen.getByRole("button", { name: "Revoke invitation for alice" }),
  );
  await waitFor(() => expect(screen.queryByDisplayValue(/#claim=/)).toBeNull());
  route = (path) => {
    if (path.endsWith("update"))
      return Promise.reject(
        Object.assign(
          new Error("Last active administrator cannot be disabled"),
          { status: 409 },
        ),
      );
    return { users: [pending] };
  };
  await actor.click(screen.getByRole("button", { name: "Disable admin" }));
  await screen.findByText(/Last active administrator/);
});

it("offers reset links and explicit role updates for existing accounts", async () => {
  route = (path, body) =>
    path === "users" && !body
      ? { users: [account] }
      : path.endsWith("reset-password")
        ? { token: "fixture-reset" }
        : {};
  const actor = userEvent.setup();
  render(<UsersPage />);
  await actor.click(
    await screen.findByRole("button", { name: "Reset password for alice" }),
  );
  await screen.findByDisplayValue(/#claim=fixture-reset/);
  await actor.click(screen.getByRole("button", { name: "Make alice admin" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) => r.path === "users/own/update" && r.body?.role === "admin",
      ),
    ).toBe(true),
  );
  expect(screen.queryByDisplayValue(/#claim=/)).toBeNull();
});
it("re-enables a disabled user to pending before issuing a fresh invitation", async () => {
  let current = { ...account, status: "disabled" };
  route = (path, body) => {
    if (path === "users") return { users: [current] };
    if (path.endsWith("update")) {
      current = { ...current, status: String(body?.status) };
      return current;
    }
    return { token: "fixture-reenabled" };
  };
  const actor = userEvent.setup();
  render(<UsersPage />);
  await actor.click(
    await screen.findByRole("button", { name: /^Enable alice$/ }),
  );
  await actor.click(
    await screen.findByRole("button", {
      name: /^Issue invitation for alice$/,
    }),
  );
  await screen.findByDisplayValue(/#claim=fixture-reenabled/);
  expect(
    requests.some(
      (r) => r.path === "users/own/update" && r.body?.status === "pending",
    ),
  ).toBe(true);
});
it("offers sign-in and reissue instructions for expired links", async () => {
  route = () =>
    Promise.reject(Object.assign(new Error("Expired"), { status: 410 }));
  render(<ClaimScreen token="fixture-expired" onDone={vi.fn()} />);
  expect(await screen.findByText(/expired or already used/)).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Save password and sign in" })
      .matches(":disabled"),
  ).toBe(true);
});
