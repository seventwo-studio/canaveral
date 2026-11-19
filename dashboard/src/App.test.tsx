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
  it.each([
    ["system", "System control", "admin/system"],
    ["configuration", "API controls", "admin/configuration"],
  ])(
    "opens the administrator %s workspace from a deep link",
    async (hash, heading, endpoint) => {
      const original = handler;
      handler = (path, options) =>
        path === "admin/system"
          ? json({
              applications: [],
              leases: [],
              requests: [],
              jobs: [],
              operations: [],
              sessions: [],
            })
          : path === "consumers"
            ? json({ applications: [] })
            : original(path, options);
      location.hash = hash!;
      render(<App />);
      await userEvent.type(await screen.findByLabelText("Username"), "admin");
      await userEvent.type(
        screen.getByLabelText("Password"),
        "a sufficiently long password",
      );
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByRole("heading", { name: heading });
      expect(
        screen.getByRole("navigation", { name: "Administration navigation" }),
      ).toBeTruthy();
      if (hash === "configuration")
        await userEvent.click(
          screen.getAllByRole("button", { name: /^Refresh$/ }).at(-1)!,
        );
      await waitFor(() =>
        expect(calls.some((call) => call.path === endpoint)).toBe(true),
      );
    },
  );

  it.each(["admin", "admin/users", "admin/tokens", "system", "configuration"])(
    "blocks ordinary-user deep link %s before requesting admin data",
    async (hash) => {
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
          : original(p);
      location.hash = hash;
      await login();
      expect(
        calls.some((c) =>
          [
            "hosts",
            "users",
            "admin/tokens",
            "admin/system",
            "admin/configuration",
            "consumers",
          ].includes(c.path),
        ),
      ).toBe(false);
      expect(
        screen.queryByRole("navigation", { name: "Administration navigation" }),
      ).toBeNull();
      expect(screen.getByRole("heading", { name: "Machines" })).toBeTruthy();
    },
  );
  it("shows fleet ownership and filters without changing lifecycle controls", async () => {
    const original = handler;
    handler = (p) =>
      p === "users"
        ? json({
            users: [
              {
                id: "alice",
                username: "alice",
                role: "user",
                status: "active",
              },
            ],
          })
        : p === "machines"
          ? json({
              machines: [
                { ...machine, ownerId: "alice" },
                { ...machine, id: "m2", name: "Unassigned", ownerId: null },
              ],
            })
          : original(p);
    const actor = await login();
    expect(
      await screen.findByText("No user owner", { selector: "dd" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Administration navigation" }),
    ).toBeTruthy();
    await actor.selectOptions(screen.getByLabelText("Machine owner"), "alice");
    expect(screen.queryByRole("button", { name: /^Unassigned$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Voyager" })).toBeTruthy();
  });
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
    await actor.click(screen.getByRole("link", { name: "Image library" }));
    await screen.findByRole("heading", { name: "Image library" });
    expect(screen.queryByRole("button", { name: "Import image" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("image-tasks"))).toBe(false);
    await actor.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Users" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "API tokens" })).toBeTruthy();
  });
  it("creates a machine from a pinned blueprint with its resource defaults", async () => {
    const original = handler;
    const blueprint = {
      id: "blueprint",
      name: "Prepared development",
      revision: "3",
      source: {
        id: template.id,
        revision: template.revision,
        arch: template.arch,
      },
      image: template,
      minimum: template.minimum,
      defaults: { cpu: 3, memoryMiB: 2048, diskGiB: 20 },
    };
    handler = (path, options) =>
      path === "blueprints"
        ? json({ blueprints: [blueprint] })
        : original(path, options);
    const actor = await login();
    await actor.click(screen.getByRole("link", { name: "Machine blueprints" }));
    await actor.click(
      await screen.findByRole("button", { name: "Create machine" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Machine blueprint")).toBeTruthy();
    await actor.type(dialog.getByLabelText("Machine name"), "Workbench");
    await actor.click(dialog.getByRole("button", { name: "Create machine" }));
    const posted = calls.find(
      (c) => c.path === "machines" && c.method === "POST",
    )!.value!;
    expect(posted.blueprintId).toBe("blueprint");
    expect(posted.blueprintRevision).toBe("3");
    expect(posted.resources).toEqual(blueprint.defaults);
    expect(posted.templateId).toBeUndefined();
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
    expect(screen.getAllByText("Preparing").length).toBeGreaterThan(0);
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
  it("selects an advertised iOS runtime and retries its pinned template", async () => {
    const original = handler;
    const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
    const phone = {
      ...template,
      id: "phone",
      name: "iPhone",
      arch: "arm64",
      os: "ios",
      mode: "device",
      device: { runtime },
    };
    handler = (path, options) => {
      if (path === "templates")
        return json({
          templates: [template, phone, { ...phone, revision: "r2" }],
        });
      if (path === "machines" && options?.method === "POST")
        return Promise.reject(new Error("Lost response"));
      return original(path, options);
    };
    const user = await login();
    await user.click(screen.getByRole("button", { name: "Create machine" }));
    const dialog = within(screen.getByRole("dialog"));
    const picker = dialog.getByRole("combobox", { name: "Base image" });
    picker.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("option", { name: `iPhone · r1 · arm64 · ${runtime}` }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("option", { name: `iPhone · r2 · arm64 · ${runtime}` }),
    );
    expect(dialog.getByLabelText("iOS simulator template")).toBe(picker);
    expect(document.getElementById("template-summary")?.textContent).toContain(
      runtime,
    );
    await user.type(dialog.getByLabelText("Machine name"), "Explorer");
    await user.click(dialog.getByRole("button", { name: "Create machine" }));
    await user.click(
      await dialog.findByRole("button", { name: "Retry request" }),
    );
    await dialog.findByRole("button", { name: "Retry request" });
    const requests = calls
      .filter((c) => c.path === "machines" && c.method === "POST")
      .map((c) => c.value);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      templateId: "phone",
      templateRevision: "r2",
      arch: "arm64",
    });
    expect(requests[1]).toEqual(requests[0]);
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
  it("launches a Linux desktop from desktop images without placement choices", async () => {
    const desktop = {
      ...template,
      id: "linux-desktop",
      revision: "1",
      arch: "arm64",
      mode: "desktop",
      guestAccess: true,
      name: "Debian desktop",
      minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 16 },
      defaults: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    };
    const original = handler;
    handler = (p, options) =>
      p === "templates"
        ? json({ templates: [template, desktop] })
        : p === "machines" && options?.method === "POST"
          ? json({
              ...machine,
              id: calls.at(-1)!.value!.id,
              name: "Review",
              template: desktop,
            })
          : original(p, options);
    const user = await login();
    await user.click(screen.getByRole("button", { name: "Launch desktop" }));
    const dialog = screen.getByRole("dialog");
    within(dialog).getByRole("heading", { name: "Launch a desktop" });
    expect(within(dialog).getByText(/linux · Desktop/)).toBeTruthy();
    expect(within(dialog).queryByText("Placement")).toBeNull();
    expect(within(dialog).getByLabelText("Desktop image")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Machine name"), "Review");
    await user.click(
      within(dialog).getByRole("button", { name: "Launch desktop" }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === "machines" && c.method === "POST")?.value,
      ).toMatchObject({
        name: "Review",
        templateId: "linux-desktop",
        templateRevision: "1",
        arch: "arm64",
        resources: desktop.defaults,
      }),
    );
    expect(
      calls.find((c) => c.path === "machines" && c.method === "POST")?.value,
    ).not.toHaveProperty("hostId");
    await screen.findByText(/Review is starting on Arctic/);
  });
  it("launches a macOS desktop and explains it runs once", async () => {
    const mac = {
      ...template,
      id: "macos-desktop",
      revision: "1",
      os: "macos",
      arch: "arm64",
      mode: "desktop",
      guestAccess: true,
      name: "macOS desktop",
      minimum: { cpu: 4, memoryMiB: 8192, diskGiB: 64 },
      defaults: { cpu: 4, memoryMiB: 8192, diskGiB: 64 },
    };
    const original = handler;
    handler = (p, options) =>
      p === "templates"
        ? json({
            templates: [
              template,
              mac,
              // Intel macOS and macOS without a guest helper are never offered.
              { ...mac, id: "intel", arch: "amd64" },
              { ...mac, id: "plain", guestAccess: undefined },
            ],
          })
        : p === "machines" && options?.method === "POST"
          ? json({
              ...machine,
              id: calls.at(-1)!.value!.id,
              name: "Mac review",
              template: mac,
            })
          : original(p, options);
    const user = await login();
    await user.click(screen.getByRole("button", { name: "Launch desktop" }));
    const dialog = screen.getByRole("dialog");
    within(dialog).getByRole("heading", { name: "Launch a desktop" });
    expect(within(dialog).getByText(/macos · Desktop/)).toBeTruthy();
    expect(
      within(dialog).getByText(/boots once with its own guest credential/),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Placement")).toBeNull();
    // The form's native select mirrors the offered images.
    expect(dialog.querySelectorAll("select option")).toHaveLength(1);
    await user.type(
      within(dialog).getByLabelText("Machine name"),
      "Mac review",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Launch desktop" }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.path === "machines" && c.method === "POST")?.value,
      ).toMatchObject({
        name: "Mac review",
        templateId: "macos-desktop",
        templateRevision: "1",
        arch: "arm64",
        resources: mac.defaults,
      }),
    );
    await screen.findByText(/Mac review is starting on Arctic/);
  });
  it("offers neither headless images nor desktops without guest access", async () => {
    const original = handler;
    handler = (p, options) =>
      p === "templates"
        ? json({
            templates: [
              template,
              { ...template, id: "installer", mode: "desktop" },
            ],
          })
        : original(p, options);
    const user = await login();
    await user.click(screen.getByRole("button", { name: "Launch desktop" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        /No online accepting host offers a desktop image/,
      ),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Launch desktop",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("deletes a stopped machine and confirms only after the controller stops listing it", async () => {
    const stopped = { ...machine, desired: "stopped", observed: "stopped" };
    let listed: unknown[] = [stopped];
    const original = handler;
    handler = (p, options) =>
      p === "machines" && options?.method !== "POST"
        ? json({ machines: listed })
        : p === "machines/m1/delete"
          ? json({ ...calls.at(-1)!.value, machineId: "m1", state: "queued" })
          : original(p, options);
    const user = await login();
    await user.click(
      screen.getByRole("button", { name: "More actions for Voyager" }),
    );
    // The receipt is queued: the host has not confirmed removal yet.
    listed = [{ ...stopped, deletion: { id: "pending", state: "running" } }];
    await user.click(
      await screen.findByRole("menuitem", { name: /Delete machine/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.path === "machines/m1/delete")).toBe(false);
    await user.click(
      within(dialog).getByRole("button", { name: "Delete machine" }),
    );
    await within(dialog).findByText(/Waiting for the host to confirm removal/);
    const request = calls.find((c) => c.path === "machines/m1/delete")!;
    expect(request.value!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.queryByText(/Voyager deleted/)).toBeNull();
    const list = screen.getByRole("list", {
      name: "Machine list",
      hidden: true,
    });
    await within(list).findByText("Deleting");
    listed = [];
    await user.click(
      within(dialog).getAllByRole("button", { name: "Close" })[0]!,
    );
    await user.click(screen.getAllByRole("button", { name: /Refresh/ })[0]!);
    await screen.findByText("Voyager deleted. The host confirmed removal.");
  });
  it("reuses a lost deletion request ID after the dialog is closed and reopened", async () => {
    const stopped = { ...machine, desired: "stopped", observed: "stopped" };
    const original = handler;
    handler = (p, options) =>
      p === "machines" && options?.method !== "POST"
        ? json({ machines: [stopped] })
        : p === "machines/m1/delete"
          ? Promise.reject(new Error("Lost response"))
          : original(p, options);
    const user = await login();
    const attempt = async () => {
      await user.click(
        screen.getByRole("button", { name: "More actions for Voyager" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: /Delete machine/ }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: "Delete machine" }),
      );
      await within(dialog).findByRole("alert");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    };
    await attempt();
    await attempt();
    const requests = calls.filter((c) => c.path === "machines/m1/delete");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.value).toEqual(requests[0]!.value);
  });
  it("shows a blocked deletion as unconfirmed and retries with its request ID", async () => {
    const blocked = {
      ...machine,
      desired: "stopped",
      observed: "unknown",
      deletion: {
        id: "11111111-1111-4111-8111-111111111111",
        state: "blocked",
      },
    };
    const original = handler;
    handler = (p, options) =>
      p === "machines" && options?.method !== "POST"
        ? json({ machines: [blocked] })
        : p === "machines/m1/delete"
          ? json({ id: blocked.deletion.id, machineId: "m1", state: "blocked" })
          : original(p, options);
    const user = await login();
    const list = screen.getByRole("list", { name: "Machine list" });
    expect(within(list).getByText("Deletion blocked")).toBeTruthy();
    expect(
      within(list).getByText("Removal unconfirmed; storage retained"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop Voyager" })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "More actions for Voyager" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Check deletion status/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Check deletion" }),
    );
    await within(dialog).findByText(/could not confirm removal/);
    expect(calls.find((c) => c.path === "machines/m1/delete")!.value).toEqual({
      id: blocked.deletion.id,
    });
    expect(screen.queryByText(/Voyager deleted/)).toBeNull();
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
