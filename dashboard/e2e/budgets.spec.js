import { test, expect } from "@playwright/test";

for (const width of [320, 1440])
  test(`shared resource budget at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const hosts = ["Android runner", "Linux runner"].map((name, i) => ({
      id: "runner-" + i,
      name,
      provider: i ? "apple" : "android",
      kind: "host",
      online: true,
      enabled: true,
      capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 100 },
      reserved: { cpu: 2, memoryMiB: 2048, diskGiB: 10 },
    }));
    let budgets = [],
      saved;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {};
      if (path === "auth/status")
        result = { setupRequired: false, user: { username: "admin" } };
      if (path === "hosts") result = { hosts };
      if (path === "machines") result = { machines: [] };
      if (path === "templates") result = { templates: [] };
      if (path === "resource-budgets") {
        if (route.request().method() === "POST") {
          saved = route.request().postDataJSON();
          result = {
            ...saved,
            reserved: { cpu: 4, memoryMiB: 4096, diskGiB: 20 },
            available: { cpu: 0, memoryMiB: 4096, diskGiB: 80 },
            overcommitted: false,
          };
          budgets = [result];
        } else result = { budgets };
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/#hosts");
    await page
      .getByRole("button", { name: "Shared budgets", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Shared resource budgets",
    });
    await dialog.getByLabel("Budget name", { exact: true }).fill("Shared Mac");
    await dialog.getByRole("checkbox", { name: /Android runner/ }).check();
    await dialog.getByRole("checkbox", { name: /Linux runner/ }).check();
    await dialog
      .getByRole("button", { name: "Save shared budget", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: /Shared Mac/ }),
    ).toBeVisible();
    expect(saved.hostIds.sort()).toEqual(["runner-0", "runner-1"]);
    await expect(
      dialog.getByRole("button", { name: "Save shared budget", exact: true }),
    ).toBeEnabled();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
