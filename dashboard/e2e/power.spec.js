import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 1440])
  test(`explicit VM power off confirmation and stable retry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const host = {
      id: "4be8431f-e17b-4f15-854b-e25229f34ac1",
      name: "Local Mac",
      provider: "macos",
      runtimes: ["apple"],
      online: true,
      enabled: true,
      capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 192 },
      reserved: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    };
    const template = {
      id: "linux",
      revision: "1",
      arch: "arm64",
      os: "linux",
      mode: "desktop",
      minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    };
    const machine = {
      id: "98923bb7-3834-44b6-bf5b-a5c8b2008010",
      name: "Stuck test VM",
      hostId: host.id,
      templateId: "linux",
      template,
      resources: template.minimum,
      desired: "stopped",
      observed: "stopping",
      ready: false,
      preparation: { state: "notRequired" },
      updatedAt: Date.now() / 1000,
    };
    const requests = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {},
        status = 200;
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      if (path === "hosts") result = { hosts: [host] };
      if (path === "machines") result = { machines: [machine] };
      if (path === "templates") result = { templates: [] };
      if (path.endsWith("/power-off")) {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) {
          status = 503;
          result = { error: "Response interrupted. Retry the same request." };
        } else
          result = {
            id: requests[0].id,
            machineId: machine.id,
            state: "queued",
          };
      }
      await route.fulfill({ status, json: result });
    });
    await page.goto("/#machines");
    await page
      .getByRole("button", { name: "Power off Stuck test VM", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Unsaved changes may be lost");
    expect(requests).toHaveLength(0);
    await dialog
      .getByRole("button", { name: "Power off VM", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Retry the same request",
    );
    await dialog
      .getByRole("button", { name: "Power off VM", exact: true })
      .click();
    await expect(dialog).toContainText("Resources stay reserved");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(Object.keys(requests[0])).toEqual(["id"]);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  });
