import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 768, 1440]) {
  test(`host overview stacks categories and scopes machines/images at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const categories = [
      {
        id: "virtualMachines",
        label: "Virtual machines",
        cpu: 4,
        memoryMiB: 8192,
        diskGiB: 80,
      },
      {
        id: "simulators",
        label: "Simulators",
        cpu: 2,
        memoryMiB: 2048,
        diskGiB: 8,
      },
      {
        id: "retainedDisks",
        label: "Stopped machine disks",
        cpu: 0,
        memoryMiB: 0,
        diskGiB: 32,
      },
      { id: "images", label: "Images", cpu: 0, memoryMiB: 0, diskGiB: 64 },
      {
        id: "imageTasks",
        label: "Image imports and captures",
        cpu: 0,
        memoryMiB: 0,
        diskGiB: 5,
      },
      { id: "inference", label: "Inference", cpu: 0, memoryMiB: 0, diskGiB: 0 },
    ];
    const host = {
      id: "mac",
      name: "Development Mac",
      kind: "host",
      provider: "macos",
      runtimes: ["apple", "android"],
      online: true,
      enabled: true,
      capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 192 },
      reserved: { cpu: 6, memoryMiB: 10240, diskGiB: 189 },
    };
    const other = { ...host, id: "other", name: "Other host" };
    const machine = (id, name, hostId, observed, system = "linux") => ({
      id,
      name,
      hostId,
      observed,
      desired: observed,
      ready: observed === "running",
      preparation: { state: "ready" },
      updatedAt: Date.now() / 1000,
      templateId: "ubuntu",
      template: {
        os: system,
        arch: "arm64",
        mode: system === "android" ? "device" : "desktop",
        guestAccess: true,
      },
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    });
    const machines = [
      machine("ubuntu", "Ubuntu workspace", "mac", "running"),
      machine("android", "Android acceptance", "mac", "running", "android"),
      machine("stopped", "Retained workspace", "mac", "stopped"),
      machine("foreign", "Foreign machine", "other", "running"),
    ];
    const images = [
      {
        id: "base",
        name: "Ubuntu base",
        revision: "3",
        os: "linux",
        arch: "arm64",
        format: "qcow2",
        origin: "runtime",
        offered: true,
      },
      {
        id: "captured",
        name: "Configured Ubuntu",
        revision: "1",
        os: "linux",
        arch: "arm64",
        format: "raw",
        kind: "derived",
        origin: "library",
        bytes: 32 * 1073741824,
        offered: true,
      },
      {
        id: "pending",
        name: "Registered Windows disk",
        revision: "1",
        os: "windows",
        arch: "arm64",
        format: "raw",
        kind: "base",
        origin: "library",
        bytes: 8 * 1073741824,
        offered: false,
      },
    ];
    let failResources = false;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { user: adminUser, setupRequired: false };
      if (path === "hosts") result = { hosts: [host, other] };
      if (path === "machines") result = { machines };
      if (path === "templates") result = { templates: [] };
      if (path === "hosts/mac/resources" && failResources) {
        await route.fulfill({
          status: 503,
          json: { error: "Resource report unavailable" },
        });
        return;
      }
      if (path === "hosts/mac/resources")
        result = {
          hostId: host.id,
          budget: host.capacity,
          reserved: host.reserved,
          categories,
          allocations: machines
            .filter((m) => m.hostId === "mac")
            .map((m) => ({ ...m, computeReserved: m.observed === "running" })),
          images,
          samples: [],
        };
      await route.fulfill({ json: result });
    });
    await page.goto("/#hosts");
    await page
      .getByRole("link", { name: "Development Mac overview", exact: true })
      .click();
    await expect(page).toHaveURL(/#hosts\/mac$/);
    await expect(
      page.getByRole("heading", { name: "Development Mac", exact: true }),
    ).toBeVisible();
    for (const label of ["CPU", "Memory", "Storage"])
      await expect(
        page.getByRole("img", { name: `${label} reservations by category` }),
      ).toBeVisible();
    const legend = page.getByRole("region", {
      name: "Canaveral reservations by category",
    });
    for (const category of categories)
      await expect(
        legend.getByText(category.label, { exact: true }),
      ).toBeVisible();
    const segments = await page
      .getByRole("img", { name: "CPU reservations by category" })
      .locator("rect[data-category]")
      .evaluateAll((elements) =>
        elements.map((el) => ({
          id: el.dataset.category,
          width: Number(el.getAttribute("width")),
        })),
      );
    expect(segments.find((s) => s.id === "virtualMachines").width).toBe(500);
    expect(segments.find((s) => s.id === "simulators").width).toBe(250);
    const members = page.getByRole("region", { name: "Host machines" });
    await expect(members).toContainText("2 running · 3 assigned");
    for (const name of [
      "Ubuntu workspace",
      "Android acceptance",
      "Retained workspace",
    ])
      await expect(members.getByText(name, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Foreign machine", { exact: true }),
    ).toHaveCount(0);
    await members.getByRole("radio", { name: "Running", exact: true }).click();
    await expect(
      members.getByText("Retained workspace", { exact: true }),
    ).toHaveCount(0);
    await expect(
      members.getByText("Ubuntu workspace", { exact: true }),
    ).toBeVisible();
    await members
      .getByRole("radio", { name: "All machines", exact: true })
      .click();
    await expect(
      members.getByText("Retained workspace", { exact: true }),
    ).toBeVisible();
    const installed = page.getByRole("region", { name: "Installed images" });
    for (const image of images)
      await expect(
        installed.getByText(image.name, { exact: true }),
      ).toBeVisible();
    await expect(installed).toContainText("Not offered for creation");
    await page
      .getByRole("button", { name: "Inspect Ubuntu workspace" })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Ubuntu workspace", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(members).toContainText("2 running · 3 assigned");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.goto("/#hosts/mac/resources");
    await expect(
      page.getByRole("heading", { name: "Development Mac", exact: true }),
    ).toBeVisible();
    failResources = true;
    await page.reload();
    await expect(installed).toContainText(
      "Installed image inventory unavailable.",
    );
    await expect(installed).not.toContainText("No installed images reported.");
    await expect(
      page.getByText("Resource categories unavailable.", { exact: true }),
    ).toBeVisible();
    failResources = false;
    await page
      .getByRole("button", { name: "Retry resources", exact: true })
      .click();
    await expect(
      installed.getByText("Configured Ubuntu", { exact: true }),
    ).toBeVisible();
    host.online = false;
    await page.reload();
    await expect(members).toContainText("Runtime unknown · 3 assigned");
    await expect(
      members.getByRole("button", { name: "Control", exact: true }),
    ).toHaveCount(0);
  });
}
