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
  HTMLElement.prototype.scrollIntoView = vi.fn();
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
  await screen.findByRole("row", { name: "alice account" });
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
  const dialog = screen.getByRole("alertdialog", { name: "Disable admin?" });
  expect(requests.filter((r) => r.path === "users/admin/update")).toHaveLength(
    0,
  );
  await actor.click(
    within(dialog).getByRole("button", { name: "Disable account" }),
  );
  await screen.findByText("Last active administrator cannot be disabled");
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
  const reset = screen.getByRole("alertdialog", {
    name: "Reset password for alice?",
  });
  expect(
    within(reset).getByText(/immediately blocks alice's current password/),
  ).toBeTruthy();
  await actor.click(
    within(reset).getByRole("button", { name: "Reset password" }),
  );
  await screen.findByDisplayValue(/#claim=fixture-reset/);
  await actor.click(screen.getByRole("button", { name: "Make alice admin" }));
  const promotion = screen.getByRole("alertdialog", {
    name: "Make alice an administrator?",
  });
  expect(
    within(promotion).getByText(/manage all users, machines/),
  ).toBeTruthy();
  await actor.click(
    within(promotion).getByRole("button", {
      name: "Grant administrator access",
    }),
  );
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
it("filters users by username or identity and status and shows owned-machine counts", async () => {
  const pending: User = {
    ...account,
    id: "pending-id",
    username: "bob",
    status: "pending",
  };
  const disabled: User = {
    ...account,
    id: "disabled-id",
    username: "carol",
    status: "disabled",
  };
  route = () => ({ users: [account, pending, disabled] });
  const actor = userEvent.setup();
  const fixture = {
    id: "m1",
    name: "Fixture",
    hostId: "h1",
    templateId: "t1",
    ownerId: account.id,
    resources: { cpu: 1, memoryMiB: 1024, diskGiB: 8 },
    desired: "running",
    observed: "running",
    preparation: { state: "notRequired" },
    template: { os: "linux", arch: "arm64", mode: "headless" },
  };
  render(<UsersPage machines={[fixture, { ...fixture, id: "m2" }]} />);
  const alice = await screen.findByRole("row", { name: "alice account" });
  expect(within(alice).getByRole("cell", { name: "Machines: 2" })).toBeTruthy();
  await actor.type(screen.getByLabelText("Search users"), "PENDING-ID");
  expect(screen.queryByRole("row", { name: "alice account" })).toBeNull();
  expect(screen.getByRole("row", { name: "bob account" })).toBeTruthy();
  await actor.clear(screen.getByLabelText("Search users"));
  screen.getByRole("combobox", { name: "User status" }).focus();
  await actor.keyboard("{ArrowDown}{End}{Enter}");
  expect(screen.getByRole("row", { name: "carol account" })).toBeTruthy();
  expect(screen.queryByRole("row", { name: "bob account" })).toBeNull();
  await actor.type(screen.getByLabelText("Search users"), "alice");
  expect(screen.getByText("No users match")).toBeTruthy();
});

it("confirms self-demotion, explains the last administrator and restores focus on cancel", async () => {
  const admin: User = { ...account, role: "admin" };
  route = () => ({ users: [admin] });
  const actor = userEvent.setup();
  render(<UsersPage user={admin} />);
  const trigger = await screen.findByRole("button", {
    name: "Make alice user",
  });
  expect(screen.getByText("Last active administrator")).toBeTruthy();
  await actor.click(trigger);
  const dialog = screen.getByRole("alertdialog", {
    name: "Remove administrator access from alice?",
  });
  expect(within(dialog).getByText(/This is your account/)).toBeTruthy();
  expect(
    within(dialog).getByText(/limited to their own machines/),
  ).toBeTruthy();
  expect(requests.filter((r) => r.body)).toHaveLength(0);
  await actor.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(requests.filter((r) => r.body)).toHaveLength(0);
});

it.each([401, 403])(
  "clears cached users and one-time links after access is denied (%s)",
  async (status) => {
    route = (path) =>
      path === "users"
        ? { users: [{ ...account, status: "pending" }] }
        : { token: "fixture-visible" };
    const denied = vi.fn(),
      actor = userEvent.setup();
    render(<UsersPage onDenied={denied} />);
    await actor.click(
      await screen.findByRole("button", { name: "Issue invitation for alice" }),
    );
    await screen.findByDisplayValue(/fixture-visible/);
    route = () =>
      Promise.reject(Object.assign(new Error("Denied"), { status }));
    await actor.click(screen.getByRole("button", { name: "Refresh users" }));
    await screen.findByText(
      status === 401
        ? /Your session has ended/
        : /Administrator access is required/,
    );
    expect(screen.queryByRole("row", { name: "alice account" })).toBeNull();
    expect(screen.queryByDisplayValue(/fixture-visible/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create user" }).matches(":disabled"),
    ).toBe(true);
    expect(denied).toHaveBeenCalledOnce();
  },
);

it("requires an explicit refresh after an unknown mutation without replaying creation", async () => {
  let created = false;
  route = (path, body) => {
    if (path === "users" && body) {
      created = true;
      return Promise.reject(new Error("Lost response"));
    }
    return {
      users: created
        ? [
            account,
            { ...account, id: "new", username: "bob", status: "pending" },
          ]
        : [account],
    };
  };
  const actor = userEvent.setup();
  render(<UsersPage />);
  await screen.findByRole("row", { name: "alice account" });
  await actor.type(screen.getByLabelText("New username"), "bob");
  await actor.click(screen.getByRole("button", { name: "Create user" }));
  await screen.findByText(/Creation of bob could not be confirmed/);
  expect(
    screen.getByRole("button", { name: "Create user" }).matches(":disabled"),
  ).toBe(true);
  expect(screen.queryByRole("row", { name: "bob account" })).toBeNull();
  await actor.click(screen.getByRole("button", { name: "Refresh users" }));
  await screen.findByRole("row", { name: "bob account" });
  expect(
    screen.getByRole("button", { name: "Create user" }).matches(":disabled"),
  ).toBe(false);
  expect(requests.filter((r) => r.path === "users" && r.body)).toHaveLength(1);
});

it("ignores an earlier identity's delayed user list", async () => {
  let complete!: (value: unknown) => void;
  const delayed = new Promise((resolve) => {
    complete = resolve;
  });
  route = () => delayed;
  const admin: User = { ...account, role: "admin" };
  const view = render(<UsersPage user={admin} />);
  const replacement: User = { ...admin, id: "other", username: "replacement" };
  route = () => ({ users: [replacement] });
  view.rerender(<UsersPage user={replacement} />);
  await screen.findByRole("row", { name: "replacement account" });
  await act(async () => {
    complete({ users: [account] });
    await delayed;
  });
  expect(screen.queryByRole("row", { name: "alice account" })).toBeNull();
  expect(screen.getByRole("row", { name: "replacement account" })).toBeTruthy();
});

it("drops a delayed invitation after unmount without fetching or exposing it", async () => {
  let complete!: (value: unknown) => void;
  const delayed = new Promise((resolve) => {
    complete = resolve;
  });
  route = (path) =>
    path === "users" ? { users: [{ ...account, status: "pending" }] } : delayed;
  const denied = vi.fn(),
    actor = userEvent.setup();
  const view = render(<UsersPage onDenied={denied} />);
  await actor.click(
    await screen.findByRole("button", { name: "Issue invitation for alice" }),
  );
  view.unmount();
  await act(async () => {
    complete({ token: "fixture-late-secret" });
    await delayed;
  });
  expect(requests.filter((r) => r.path === "users")).toHaveLength(1);
  render(<UsersPage onDenied={denied} />);
  await screen.findByRole("row", { name: "alice account" });
  expect(screen.queryByDisplayValue(/fixture-late-secret/)).toBeNull();
  expect(denied).not.toHaveBeenCalled();
});

it("ignores a delayed access-denial callback after unmount", async () => {
  let reject!: (reason: unknown) => void;
  const delayed = new Promise((_resolve, fail) => {
    reject = fail;
  });
  route = () => delayed;
  const denied = vi.fn();
  const view = render(<UsersPage onDenied={denied} />);
  view.unmount();
  await act(async () => {
    reject(Object.assign(new Error("Denied"), { status: 403 }));
    await delayed.catch(() => undefined);
  });
  expect(denied).not.toHaveBeenCalled();
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
