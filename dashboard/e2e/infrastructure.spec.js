import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 390, 1440])
  test(`infrastructure setup and diagnostics at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const health = {
      status: "warning",
      fresh: true,
      checkedAt: Date.now() / 1000,
      checks: [
        {
          id: "disk",
          label: "Storage headroom",
          status: "warning",
          detail: "Logical budget exceeds currently free storage.",
        },
      ],
      capabilities: { virtualMachines: true, shell: false },
      environment: { system: "Linux", arch: "amd64", python: "3.12" },
    };
    const usage = {
      scope: "host",
      domain: "shared-host",
      cpuPercent: 20,
      memoryAvailableMiB: 4096,
      diskFreeGiB: 50,
      fresh: true,
      receivedAt: Date.now() / 1000,
      canaveral: {
        scope: "runner-process-tree",
        categories: [
          { id: "services", cpuPercent: 1, memoryMiB: 128, processCount: 2 },
          {
            id: "virtualMachines",
            cpuPercent: 8,
            memoryMiB: 2048,
            processCount: 1,
          },
          { id: "simulators", cpuPercent: null, memoryMiB: 0, processCount: 0 },
        ],
      },
    };
    const host = {
      id: "host",
      name: "Build host",
      provider: "libvirt",
      kind: "host",
      capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
      reserved: { cpu: 2, memoryMiB: 1024, diskGiB: 10 },
      health,
      usage,
      online: true,
      enabled: true,
      placementReady: true,
    };
    const pool = {
      ...host,
      id: "pool",
      name: "Development cluster",
      provider: "kubevirt",
      kind: "orchestrator",
      usage: { ...usage, scope: "runner" },
    };
    let setups = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      if (path === "hosts") result = { hosts: [host, pool] };
      if (path === "machines") result = { machines: [] };
      if (path === "templates") result = { templates: [] };
      if (path === "connection-setups") {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          result = {
            ...body,
            enrollmentToken: "fixture-" + "x".repeat(43),
            expiresAt: Date.now() / 1000 + 1800,
          };
          setups = [{ ...body, state: "pending", expiresAt: result.expiresAt }];
        } else
          result = { setups, controllerUrl: "https://controller.example.com" };
      }
      if (path.endsWith("/revoke")) {
        setups = [];
        result = { id: path.split("/")[1], state: "revoked" };
      }
      if (path.endsWith("/resources"))
        result = {
          hostId: path.split("/")[1],
          budget: host.capacity,
          images: [],
          categories: [
            {
              id: "retainedDisks",
              label: "Stopped machine disks",
              cpu: 0,
              memoryMiB: 0,
              diskGiB: 10,
            },
          ],
          samples: [
            { ...usage, receivedAt: Date.now() / 1000 },
            { ...usage, cpuPercent: 30, receivedAt: Date.now() / 1000 - 10 },
          ],
          allocations: [
            {
              id: "vm",
              name: "Guest machine",
              resources: { cpu: 2, memoryMiB: 1024, diskGiB: 10 },
              observed: "running",
              computeReserved: true,
            },
          ],
        };
      if (path.endsWith("/checks")) result = { requested: true };
      await route.fulfill({ json: result });
    });
    await page.goto("/#hosts");
    await expect(page.getByText("Build host", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Development cluster", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "View resources for Build host" })
      .click();
    await expect(page).toHaveURL(/#hosts\/host$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Build host", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Storage headroom", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Guest machine", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Canaveral reservations by category" }),
    ).toContainText("Stopped machine disks");
    await expect(
      page.getByRole("region", { name: "Canaveral measured usage" }),
    ).toContainText("VM processes");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("img", { name: /CPU utilization history/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Run checks", exact: true }).click();
    await page
      .getByRole("link", { name: "Back to hosts", exact: true })
      .click();
    await expect(page).toHaveURL(/#hosts$/);
    await page.goBack();
    await expect(page).toHaveURL(/#hosts\/host$/);
    await page.goForward();
    await expect(page).toHaveURL(/#hosts$/);
    await expect(
      page.getByRole("region", { name: "Canaveral measured usage" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Add host", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Connection name", { exact: true })
      .fill("New build host");
    await dialog
      .getByLabel("Host operating system", { exact: true })
      .selectOption("linux");
    await dialog
      .getByLabel("Storage directory", { exact: true })
      .fill("/tmp/canaveral-guests");
    await dialog
      .getByRole("button", { name: "Create connection setup", exact: true })
      .click();
    await expect(
      dialog.getByText("Waiting for runner", { exact: true }),
    ).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Download setup file", exact: true })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("canaveral-setup.json");
    const stream = await download.createReadStream();
    let raw = "";
    for await (const chunk of stream) raw += chunk.toString();
    const bundle = JSON.parse(raw);
    expect(bundle.config.provider).toBe("linux");
    expect(bundle.controllerUrl).toBe("https://controller.example.com");
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await dialog
      .getByRole("button", { name: "Revoke setup credential", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: "Create connection setup",
        exact: true,
      }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByRole("link", { name: /Orchestrators/ }).click();
    await expect(
      page.getByText("Development cluster", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Build host", { exact: true })).toHaveCount(0);
    await page
      .getByRole("link", { name: "View resources for Development cluster" })
      .click();
    await expect(page).toHaveURL(/#orchestrators\/pool$/);
    await expect(
      page.getByRole("heading", { name: "Development cluster", exact: true }),
    ).toBeVisible();
    await page.goto("/#hosts/missing/resources");
    await expect(
      page.getByText("Connection not found", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
