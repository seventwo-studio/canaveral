import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

for (const width of [320, 768, 1440]) {
  test(`fleet pulse remains readable at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 1100 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const host = {
      id: "host",
      name: "Build host",
      provider: "macos",
      kind: "host",
      online: true,
      enabled: true,
      capacity: { cpu: 12, memoryMiB: 32768, diskGiB: 512 },
      reserved: { cpu: 4, memoryMiB: 8192, diskGiB: 80 },
    };
    const machines = ["running", "running", "stopped", "error"].map(
      (observed, i) => ({
        id: `m-${i}`,
        name: `Workspace ${i + 1}`,
        hostId: host.id,
        observed,
        desired: observed,
        ready: i === 0,
        ownerId: adminUser.id,
        preparation: { state: i === 1 ? "pending" : "ready" },
        templateId: "linux",
        template: {
          os: "linux",
          arch: "arm64",
          mode: "desktop",
          revision: "v1",
        },
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 20 },
      }),
    );
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      const result = ["auth/status", "auth/session"].includes(path)
        ? { setupRequired: false, user: adminUser }
        : path === "hosts"
          ? { hosts: [host] }
          : path === "machines"
            ? { machines }
            : path === "templates"
              ? { templates: [] }
              : path === "users"
                ? { users: [adminUser] }
                : path === "admin/tokens"
                  ? { tokens: [] }
                  : {};
      await route.fulfill({ json: result });
    });
    await page.goto("/");
    const pulse = page.getByRole("region", { name: "Fleet pulse" });
    await expect(pulse.getByText("4 machines · 1 ready")).toBeVisible();
    if (width < 768) {
      await expect(
        pulse.getByRole("meter", { name: "Build host CPU reserved" }),
      ).toHaveCount(0);
      await pulse
        .getByRole("button", { name: "Show host reservations", exact: true })
        .click();
    }
    await expect(
      pulse.getByRole("meter", { name: "Build host CPU reserved" }),
    ).toHaveAttribute("value", "4");
    if (width < 768)
      await pulse
        .getByRole("button", { name: "Hide host reservations", exact: true })
        .click();
    await expect(pulse.getByText("Preparing", { exact: true })).toBeVisible();
    await expect(pulse.getByText("Error", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 320) {
      await expect(
        page.getByRole("button", { name: "Details Workspace 1", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({
      path: testInfo.outputPath("workspace.png"),
      fullPage: true,
    });

    const inventory = page.getByRole("region", { name: "Machines inventory" });
    await page
      .getByRole("textbox", { name: "Search machines" })
      .fill("nothing matches");
    await expect(
      page.getByRole("heading", { name: "No matching machines" }),
    ).toBeVisible();
    await pulse
      .getByRole("button", {
        name: "Filter preparing machines: 1",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Search machines" }),
    ).toHaveValue("");
    await expect(inventory.locator("[data-machine-id]")).toHaveCount(1);
    await expect(
      inventory.getByRole("button", { name: "Workspace 2", exact: true }),
    ).toBeVisible();
    await expect(
      pulse.getByRole("button", {
        name: "Filter preparing machines: 1",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await pulse
      .getByRole("button", { name: "1 needs attention", exact: true })
      .click();
    await expect(inventory.locator("[data-machine-id]")).toHaveCount(1);
    await expect(
      inventory.getByRole("button", { name: "Workspace 4", exact: true }),
    ).toBeVisible();
    const more = inventory.getByRole("button", {
      name: "More actions for Workspace 4",
    });
    await more.focus();
    await more.press("Enter");
    await page
      .getByRole("menuitem", { name: "Machine details", exact: true })
      .press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(inventory.locator("[data-machine-id]")).toHaveCount(4);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    if (width < 768) {
      const navigation = page.getByRole("button", { name: "Toggle Sidebar" });
      await expect(navigation).toBeInViewport();
      await navigation.click();
      await page.getByRole("link", { name: "Overview", exact: true }).click();
    } else {
      await page.goto("/#admin");
    }
    await expect(
      page.getByText("Access management", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator("#workspace-content")).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByText("Refreshing administration…", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("overview.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
