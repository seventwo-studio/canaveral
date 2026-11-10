import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";

const template = {
  id: "ubuntu",
  revision: "r1",
  arch: "amd64",
  os: "linux",
  mode: "headless",
  hostId: "h1",
  online: true,
  accepting: true,
  minimum: { cpu: 1, memoryMiB: 512, diskGiB: 4 },
  defaults: { cpu: 2, memoryMiB: 1024, diskGiB: 8 },
};
const host = {
  id: "h1",
  name: "Arctic",
  online: true,
  enabled: true,
  provider: "kubevirt",
  capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 64 },
  reserved: { cpu: 2, memoryMiB: 1024, diskGiB: 8 },
};
const machine = {
  id: "m1",
  name: "Voyager",
  hostId: "h1",
  templateId: "ubuntu",
  template,
  resources: template.defaults,
  desired: "running",
  observed: "running",
  ready: false,
  preparation: { state: "pending" },
};
interface FixtureResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
interface FixtureCall {
  path: string;
  method: string;
  credentials?: RequestCredentials;
  headers: Record<string, string>;
  value?: Record<string, unknown>;
  body?: string;
}
let calls: FixtureCall[],
  handler: (
    path: string,
    options?: { method: string },
  ) => FixtureResponse | Promise<FixtureResponse>;
const json = (body: unknown, status = 200): FixtureResponse => ({
  ok: status < 400,
  status,
  json: async () => body,
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal("localStorage", { setItem: vi.fn(), length: 0 });
  vi.stubGlobal("sessionStorage", { setItem: vi.fn(), length: 0 });
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  location.hash = "";
  calls = [];
  handler = (path) =>
    path === "auth/status"
      ? json({ setupRequired: false })
      : ["auth/login", "auth/session"].includes(path)
        ? json({
            user: {
              id: "admin-id",
              username: "admin",
              role: "admin",
              status: "active",
            },
          })
        : path === "hosts"
          ? json({ hosts: [host] })
          : path === "templates"
            ? json({ templates: [template] })
            : path === "machines"
              ? json({ machines: [machine] })
              : json({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: Omit<FixtureCall, "path">) => {
      const path = url.replace("/api/v1/", "");
      calls.push({
        path,
        ...options,
        value: options.body ? JSON.parse(options.body) : undefined,
      });
      return handler(path, options);
    }),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function login() {
  const user = userEvent.setup();
  render(<App />);
  await user.type(await screen.findByLabelText("Username"), "admin");
  await user.type(screen.getByLabelText("Password"), "correct password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("button", { name: "Voyager" });
  return user;
}
describe("dashboard contracts", () => {
  it("keeps ordinary users in their workspace without requesting administrator inventory", async () => {
    const original = handler;
    handler = (p) =>
      ["auth/login", "auth/session"].includes(p)
        ? json({
            user: {
              id: "alice",
              username: "alice",
              role: "user",
              status: "active",
            },
          })
        : p === "hosts"
          ? json({ error: "Forbidden" }, 403)
          : original(p);
    location.hash = "hosts/h1";
    const actor = await login();
    expect(calls.some((c) => c.path === "hosts")).toBe(false);
    expect(calls.some((c) => c.path === "templates")).toBe(true);
    expect(screen.queryByRole("link", { name: "Hosts" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Orchestrators" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Capture Voyager/ }),
    ).toBeNull();
    await actor.click(screen.getByRole("link", { name: "Images" }));
    await screen.findByRole("button", { name: "Use image" });
    expect(screen.queryByRole("button", { name: "Import image" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("image-tasks"))).toBe(false);
    await actor.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Users" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "API tokens" })).toBeTruthy();
  });
  it("fails closed for a login response without account authority", async () => {
    const original = handler;
    handler = (p) =>
      ["auth/login", "auth/session"].includes(p)
        ? json({ user: { username: "legacy" } })
        : original(p);
    const actor = userEvent.setup();
    render(<App />);
    await actor.type(await screen.findByLabelText("Username"), "legacy");
    await actor.type(screen.getByLabelText("Password"), "fixture password");
    await actor.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "auth/login")).toBe(true),
    );
    expect(calls.some((c) => c.path === "hosts" || c.path === "machines")).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });
  it("clears privileged inventory when the current account role changes", async () => {
    const actor = await login(),
      original = handler;
    const hostCalls = calls.filter((c) => c.path === "hosts").length;
    handler = (p) =>
      p === "auth/session"
        ? json({
            user: {
              id: "admin-id",
              username: "admin",
              role: "user",
              status: "active",
            },
          })
        : original(p);
    await actor.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(
      "Your account access changed. Sign in again to continue.",
    );
    expect(screen.queryByText("Voyager")).toBeNull();
    expect(calls.filter((c) => c.path === "hosts")).toHaveLength(hostCalls);
  });
  it("retains the last good inventory when a successful response contains malformed data", async () => {
    const user = await login(),
      original = handler;
    handler = (path) =>
      path === "machines"
        ? json({ machines: [{ ...machine, template: null }] })
        : original(path);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText(/Displayed data may be out of date/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voyager" })).toBeTruthy();
  });
  it("keeps a mismatched creation response unconfirmed and retries only the original request", async () => {
    const user = await login(),
      original = handler;
    handler = (path, options) =>
      path === "machines" && options?.method === "POST"
        ? json({ id: "other", name: "Wrong guest", hostId: "h1" })
        : original(path);
    await user.click(screen.getByRole("button", { name: "Create machine" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Machine name"), "Explorer");
    await user.click(dialog.getByRole("button", { name: "Create machine" }));
    const retry = await dialog.findByRole("button", { name: "Retry request" });
    expect(screen.queryByText(/Wrong guest assigned/)).toBeNull();
    expect(
      calls.filter((c) => c.path === "machines" && c.method === "POST"),
    ).toHaveLength(1);
    await user.click(retry);
    await dialog.findByRole("button", { name: "Retry request" });
    const created = calls.filter(
      (c) => c.path === "machines" && c.method === "POST",
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.value?.id).toBe(created[1]?.value?.id);
  });
  it("keeps sessions out of persistent storage and discards inventory on sign-out", async () => {
    const user = await login();
    expect(screen.getByText("Preparing")).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(calls.find((c) => c.path === "hosts")!.credentials).toBe(
      "same-origin",
    );
    expect(
      calls.find((c) => c.path === "hosts")!.headers.Authorization,
    ).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(screen.queryByText("Voyager")).toBeNull();
    expect(calls.find((c) => c.path === "auth/logout")!.credentials).toBe(
      "same-origin",
    );
  });
  it("restores a cookie session without asking for credentials", async () => {
    const original = handler;
    handler = (path) =>
      path === "auth/status"
        ? json({
            setupRequired: false,
            user: {
              id: "admin-id",
              username: "admin",
              role: "admin",
              status: "active",
            },
          })
        : original(path);
    render(<App />);
    await screen.findByRole("button", { name: "Voyager" });
    expect(calls.some((call) => call.path === "auth/login")).toBe(false);
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
  it("retains stale inventory, then expires a rejected session", async () => {
    const user = await login(),
      original = handler;
    handler = (p) =>
      p === "hosts" ? json({ error: "Offline" }, 503) : original(p);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText(/Displayed data may be out of date/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voyager" })).toBeTruthy();
    handler = (p) =>
      p === "hosts" ? json({ error: "Expired" }, 401) : original(p);
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(
      await screen.findByText("Your session ended. Sign in again to continue."),
    ).toBeTruthy();
    expect(screen.queryByText("Voyager")).toBeNull();
  });
  it("pins template revision and reuses a creation ID only for an unchanged retry", async () => {
    const user = await login(),
      original = handler;
    handler = (p, options) =>
      p === "machines" && options?.method === "POST"
        ? Promise.reject(new Error("Lost response"))
        : original(p);
    await user.click(screen.getByRole("button", { name: "Create machine" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Machine name"), "Explorer");
    await user.click(
      within(dialog).getByRole("button", { name: "Create machine" }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: "Retry request" }),
    );
    await within(dialog).findByRole("button", { name: "Retry request" });
    const created = () =>
      calls.filter((c) => c.path === "machines" && c.method === "POST");
    expect(created()).toHaveLength(2);
    expect(created()[0]!.value).toEqual(created()[1]!.value);
    expect(created()[0]!.value).toMatchObject({
      name: "Explorer",
      templateRevision: "r1",
      arch: "amd64",
      resources: template.defaults,
    });
    await user.type(within(dialog).getByLabelText("Machine name"), "-two");
    await user.click(
      within(dialog).getByRole("button", { name: "Create machine" }),
    );
    await within(dialog).findByRole("button", { name: "Retry request" });
    expect(created()[2]!.value!.id).not.toBe(created()[0]!.value!.id);
  });
  it("requires confirmation before requesting a graceful stop", async () => {
    const user = await login();
    await user.click(screen.getByRole("button", { name: "Stop Voyager" }));
    expect(calls.some((c) => c.path.endsWith("/desired"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.path.endsWith("/desired"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Stop Voyager" }));
    await user.click(screen.getByRole("button", { name: "Request stop" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === "machines/m1/desired")?.value,
      ).toEqual({ state: "stopped" }),
    );
  });
  it("blocks credentials in an insecure context", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false });
    render(<App />);
    expect(
      await screen.findByText(/Open this dashboard over HTTPS/),
    ).toBeTruthy();
    expect(screen.getByLabelText("Password").matches(":disabled")).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("does not restore inventory from a response that arrives after sign-out", async () => {
    const user = await login(),
      original = handler;
    let resolve!: (response: FixtureResponse) => void;
    handler = (p) =>
      p === "machines"
        ? new Promise((r) => {
            resolve = r;
          })
        : original(p);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    resolve(json({ machines: [machine] }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy(),
    );
    expect(screen.queryByText("Voyager")).toBeNull();
  });
  it("checks setup confirmation before creating the first account", async () => {
    const original = handler;
    handler = (p) =>
      p === "auth/status"
        ? json({ setupRequired: true, setupAllowed: true })
        : original(p);
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "long enough password");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "different password",
    );
    await user.click(
      screen.getByRole("button", { name: "Create admin account" }),
    );
    expect(await screen.findByText("Passwords do not match.")).toBeTruthy();
    expect(calls.some((c) => c.path === "auth/setup")).toBe(false);
  });
});
