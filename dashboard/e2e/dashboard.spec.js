import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 1440]) {
  test(`headless workspace exposes files and terminals without a graphical connection at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const host = { ...h, id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
    const image = { ...t, hostId: host.id, guestAccess: true };
    const machine = {
      ...m,
      id: "11111111-2222-4333-8444-555555555555",
      hostId: host.id,
      template: image,
      capabilities: {
        desktopStream: false,
        files: true,
        shell: true,
        accessibility: false,
      },
    };
    let graphics = 0;
    await page.routeWebSocket("**/desktop", (socket) => {
      graphics++;
      socket.close();
    });
    await page.routeWebSocket("**/shells/*/stream", (socket) =>
      socket.send(Buffer.from("headless ready\r\n")),
    );
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (path === "hosts") result = { hosts: [host] };
      else if (path === "templates") result = { templates: [image] };
      else if (path === "machines") result = { machines: [machine] };
      else if (path.endsWith("/operations")) {
        const body = route.request().postDataJSON();
        const data =
          body.action === "list-files"
            ? {
                path: "/",
                entries: [{ name: "notes.txt", kind: "file", size: 12 }],
              }
            : {};
        result = {
          id: body.id,
          machineId: machine.id,
          state: "succeeded",
          result: data,
        };
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Control", exact: true }).click();
    await expect(page.getByText("notes.txt")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Desktop", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Inspect", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Terminals", exact: true }).click();
    await page
      .getByRole("button", { name: "New shell", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Shell 1", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".xterm-screen")).toBeVisible();
    expect(graphics).toBe(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
const t = {
  id: "ubuntu-server",
  revision: "2026.11",
  arch: "arm64",
  os: "linux",
  mode: "headless",
  hostId: "h1",
  online: true,
  accepting: true,
  preparationDriver: "cloud-init",
  minimum: { cpu: 1, memoryMiB: 512, diskGiB: 4 },
  defaults: { cpu: 2, memoryMiB: 2048, diskGiB: 16 },
};
const h = {
  id: "h1",
  name: "Arctic",
  provider: "kubevirt",
  online: true,
  enabled: true,
  capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 256 },
  reserved: { cpu: 2, memoryMiB: 2048, diskGiB: 16 },
};
const m = {
  id: "m1",
  name: "Voyager",
  exact: true,
  hostId: "h1",
  templateId: t.id,
  template: t,
  resources: t.defaults,
  desired: "running",
  observed: "running",
  ready: true,
  preparation: { state: "ready" },
  updatedAt: Date.now() / 1000,
};
for (const width of [1440, 1133, 390, 320])
  test(`production dashboard at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    let signedIn = false;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      if (path === "auth/login") signedIn = true;
      if (path === "auth/logout") signedIn = false;
      const value = ["auth/status", "auth/session"].includes(path)
        ? {
            setupRequired: false,
            ...(signedIn ? { user: adminUser } : {}),
          }
        : path === "auth/login"
          ? { user: adminUser }
          : path === "hosts"
            ? { hosts: [h] }
            : path === "machines"
              ? { machines: [m] }
              : path === "templates"
                ? { templates: [t] }
                : {};
      await route.fulfill({ json: value });
    });
    const response = await page.goto("/");
    expect(response.headers()["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.fonts.check('14px "Geist Mono"')),
    ).toBe(true);
    expect(
      await page
        .locator("label, input, button")
        .evaluateAll((elements) =>
          elements.every((element) =>
            getComputedStyle(element).fontFamily.includes("Geist Mono"),
          ),
        ),
    ).toBe(true);
    expect(
      await page
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).toContain("Arial");
    await expect(page.locator(".launch-poster .rocket-art")).toHaveAttribute(
      "data-rendered",
      "true",
    );
    await page.screenshot({
      path: testInfo.outputPath("login.png"),
      fullPage: true,
    });
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password", { exact: true }).fill("fixture password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("button", { name: "Voyager", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Voyager", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("machines.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const filters = page.getByRole("radiogroup", { name: "Filter inventory" });
    await filters.getByRole("radio", { name: "Stopped", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "No matching machines" }),
    ).toBeVisible();
    await filters.getByRole("radio", { name: "Stopped", exact: true }).click();
    await expect(
      filters.getByRole("radio", { name: "Stopped", exact: true }),
    ).toBeChecked();
    await filters.getByRole("radio", { name: "All", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Voyager", exact: true }),
    ).toBeVisible();
    const inventory = page.getByRole("region", { name: "Machines inventory" });
    expect(
      await inventory.evaluate((section) => {
        const card = section.querySelector('[data-slot="card"]');
        return (
          section.scrollWidth <= section.clientWidth + 1 &&
          card.scrollWidth <= card.clientWidth + 1
        );
      }),
    ).toBe(true);
    await expect(
      inventory.getByText("Resources", { exact: true }),
    ).toBeVisible();
    await expect(
      inventory.getByRole("button", { name: "Stop Voyager", exact: true }),
    ).toBeVisible();
    const create = page.getByRole("button", {
      name: "Create machine",
      exact: true,
    });
    await create.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("combobox", { name: "Placement" }).click();
    await page.getByRole("option", { name: "Arctic" }).click();
    await expect(page.getByRole("combobox", { name: "Placement" })).toHaveText(
      "Arctic",
    );
    await page.screenshot({
      path: testInfo.outputPath("create.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(create).toBeFocused();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("link", { name: /Orchestrators/ }).click();
    if (width < 768)
      await expect(
        page.getByRole("dialog", { name: "Sidebar" }),
      ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Drain pool" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("hosts.png"),
      fullPage: true,
    });
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("link", { name: /Images/ }).click();
    await expect(page.getByRole("button", { name: "Use image" })).toBeVisible();
    await page.getByRole("button", { name: "Use image" }).click();
    await expect(
      page.getByRole("combobox", { name: "Base image", exact: true }),
    ).toContainText("2026.11");
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Sign out" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

test("device workspace browses files and keeps two terminals under CSP", async ({
  page,
}) => {
  const device = {
    ...m,
    id: "1031317b-2749-4ad4-9dbb-834907de53ff",
    template: { ...t, os: "android", mode: "device" },
  };
  const receipts = new Map(),
    actions = [];
  let inspections = 0,
    uploadedBytes = 0;
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      window.cspViolations.push(event.violatedDirective),
    );
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      "/api/v1/",
      "",
    );
    let result;
    if (["auth/status", "auth/session"].includes(path))
      result = { setupRequired: false, user: adminUser };
    else if (path === "hosts") result = { hosts: [h] };
    else if (path === "machines") result = { machines: [device] };
    else if (path === "templates") result = { templates: [t] };
    else if (path.endsWith("/files/upload")) {
      uploadedBytes = route.request().postDataBuffer().length;
      result = { uploaded: uploadedBytes, durable: true };
    } else if (path.endsWith("/accessibility")) {
      inspections++;
      result = {
        snapshotId: `00000000-0000-4000-8000-${String(inspections).padStart(12, "0")}`,
        capturedAt: Date.now() / 1000,
        source: "android-uiautomator",
        coordinateSpace: "screen-pixels",
        truncated: false,
        coverage: "Synthetic normalized native hierarchy fixture",
        nodes: [
          {
            id: `ax-${inspections}`,
            parentId: null,
            depth: 0,
            role: "Button",
            name: "Save document",
            identifier: "app:id/save",
            states: { enabled: true },
            actions: ["click"],
            bounds: { x: 1, y: 2, width: 30, height: 20 },
            properties: { "resource-id": "app:id/save" },
          },
        ],
      };
    } else if (path.endsWith("/operations")) {
      const body = route.request().postDataJSON();
      actions.push(body);
      let data = {};
      if (body.action === "list-files")
        data = { entries: [{ name: "sample.txt", kind: "file" }] };
      if (body.action === "pull")
        data = { data: btoa("hello from guest"), mediaType: "text/plain" };
      if (body.action === "accessibility")
        data = {
          snapshotId: "fixture-snapshot",
          capturedAt: Date.now() / 1000,
          source: "android-uiautomator",
          coordinateSpace: "screen-pixels",
          nodes: [
            {
              id: "ax-1",
              role: "Button",
              name: "Save document",
              identifier: "app:id/save",
              states: { enabled: true },
              actions: ["click"],
              bounds: { x: 1, y: 2, width: 30, height: 20 },
              properties: { "resource-id": "app:id/save" },
            },
          ],
        };
      if (body.action === "shell-read")
        data = { data: btoa("connected\r\n"), offset: 11, exited: false };
      receipts.set(body.id, { state: "succeeded", result: data });
      result = { state: "queued", id: body.id };
    } else if (path.startsWith("operations/"))
      result = receipts.get(path.split("/")[1]);
    else result = {};
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket("**/shells/*/stream", (socket) => {
    socket.send(Buffer.from("connected\r\n"));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Control", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await expect(page.getByText("sample.txt")).toBeVisible();
  await page.getByRole("button", { name: /sample.txt/ }).click();
  await expect(
    page
      .getByRole("region", { name: "File preview" })
      .getByText("hello from guest"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const inspector = page.getByRole("complementary", {
    name: "Accessibility inspector",
  });

  await inspector.getByRole("button", { name: /Save document/ }).click();
  await expect(
    inspector.getByRole("region", { name: "Element details" }),
  ).toContainText("app:id/save");
  await expect.poll(() => inspections).toBeGreaterThanOrEqual(2);
  await expect(
    inspector.getByRole("region", { name: "Element details" }),
  ).toContainText("app:id/save");
  await inspector
    .getByRole("button", { name: "Pause live accessibility" })
    .click();
  const pausedAt = inspections;
  await page.waitForTimeout(2300);
  expect(inspections).toBe(pausedAt);
  await page.getByLabel("Upload file").setInputFiles({
    name: "large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(2 * 1024 * 1024),
  });
  await expect.poll(() => uploadedBytes).toBe(2 * 1024 * 1024);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  await page
    .getByRole("button", { name: "New shell", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Shell 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New shell", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Shell 2", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".xterm-screen").last()).toContainText("connected");
  expect(
    new Set(
      actions
        .filter((a) => a.action === "shell-open")
        .map((a) => a.arguments.session),
    ).size,
  ).toBe(2);
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});
