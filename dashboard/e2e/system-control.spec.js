import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

for (const width of [320, 1440]) {
  test(`system interventions and configuration under CSP at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const leaseId = "11111111-2222-4333-8444-555555555555";
    const applicationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let released = false;
    const mutations = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (path === "machines") result = { machines: [] };
      else if (path === "hosts") result = { hosts: [] };
      else if (path === "templates") result = { templates: [] };
      else if (path === "users") result = { users: [adminUser] };
      else if (path === "admin/system")
        result = {
          applications: [],
          requests: [],
          jobs: [],
          operations: [],
          sessions: [],
          leases: [
            {
              id: leaseId,
              family: "linux",
              applicationId,
              state: released ? "released" : "ready",
              runtimeState: "running",
              cleanup: released ? "pending" : "notRequested",
              reservationHeld: true,
            },
          ],
        };
      else if (path === `admin/leases/${leaseId}/release`) {
        const body = route.request().postDataJSON();
        mutations.push(body);
        released = true;
        result = {
          id: leaseId,
          requestId: body.id,
          action: "release",
          state: "released",
        };
      } else if (path === "admin/configuration")
        result = { modelCatalog: [], resourceDomains: [] };
      await route.fulfill({ json: result });
    });
    await page.goto("/#system");
    await expect(
      page.getByRole("heading", { name: "System control" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Release lease", exact: true })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("reservations");
    expect(mutations).toHaveLength(0);
    await dialog
      .getByRole("button", { name: "Release lease", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("confirmed");
    expect(mutations).toHaveLength(1);
    await expect(page.getByText("pending", { exact: true })).toBeVisible();
    await page.goto("/#configuration");
    await expect(
      page.getByRole("heading", { name: "API controls" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .last()
      .click();
    await expect(page.getByLabel("API response")).toContainText("modelCatalog");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
