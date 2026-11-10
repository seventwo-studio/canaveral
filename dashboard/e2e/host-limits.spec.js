import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

for (const width of [320, 1440])
  test(`host resource limits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const host = {
      id: "linux",
      name: "Build host",
      provider: "linux",
      kind: "host",
      online: true,
      enabled: true,
      capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
      limits: { cpu: 4, memoryMiB: 4096, diskGiB: 50 },
      reserved: { cpu: 2, memoryMiB: 2048, diskGiB: 10 },
    };
    let saved;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      if (path === "hosts") result = { hosts: [host] };
      if (path === "machines") result = { machines: [] };
      if (path === "templates") result = { templates: [] };
      if (path === "hosts/linux/resources")
        result = {
          hostId: host.id,
          capacity: host.capacity,
          limits: host.limits,
          reserved: host.reserved,
          categories: [
            {
              id: "virtualMachines",
              label: "Virtual machines",
              ...host.reserved,
            },
          ],
          allocations: [],
          images: [],
          samples: [],
        };
      if (path === "hosts/linux/limits") {
        saved = route.request().postDataJSON();
        host.limits = saved.limits;
        result = { hostId: host.id, limits: host.limits };
      }
      expect(path).not.toBe("resource-budgets");
      await route.fulfill({ json: result });
    });
    await page.goto("/#hosts");
    await expect(
      page.getByRole("button", { name: "Add host", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Shared budgets", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("link", { name: "Build host overview", exact: true })
      .click();
    const form = page.getByRole("form", { name: "Canaveral host limits" });
    await expect(form.getByLabel("vCPUs", { exact: true })).toHaveValue("4");
    await form.getByLabel("vCPUs", { exact: true }).fill("3");
    await form.getByLabel("Memory (MiB)", { exact: true }).fill("3072");
    await form.getByLabel("Disk (GiB)", { exact: true }).fill("40");
    await form
      .getByRole("button", { name: "Save host limits", exact: true })
      .click();
    await expect(form.getByRole("status")).toHaveText("Host limits saved.");
    expect(saved).toEqual({ limits: { cpu: 3, memoryMiB: 3072, diskGiB: 40 } });
    await expect(page.getByLabel("Resources by category")).toContainText(
      "2 vCPU / 3 vCPU",
    );
    expect(
      await form.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.reload();
    await expect(form.getByLabel("vCPUs", { exact: true })).toHaveValue("3");
  });
