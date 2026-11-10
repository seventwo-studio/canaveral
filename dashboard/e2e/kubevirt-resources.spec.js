import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 1440]) {
  for (const state of ["available", "unavailable"]) {
    test(`scoped KubeVirt usage ${state} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const owned =
        state === "available"
          ? {
              scope: "assigned-vm-pods",
              ownership: {
                status: "complete",
                assignedMachines: 1,
                verifiedMachines: 1,
              },
              metrics: {
                status: "available",
                cpuCores: 0.000125,
                memoryMiB: 128,
                podCount: 2,
                sampledAt: Date.now() / 1000,
              },
            }
          : {
              scope: "assigned-vm-pods",
              ownership: { status: "unavailable" },
              metrics: { status: "unavailable" },
            };
      const host = {
        id: "pool",
        name: "Development pool",
        provider: "kubevirt",
        kind: "orchestrator",
        online: true,
        enabled: true,
        capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
        reserved: { cpu: 2, memoryMiB: 1024, diskGiB: 8 },
        usage: {
          scope: "runner",
          fresh: true,
          receivedAt: Date.now() / 1000,
          sampledAt: Date.now() / 1000,
          cluster: {
            namespace: "guests",
            sampledAt: Date.now() / 1000,
            metrics: {
              status: "available",
              cpuCores: 2,
              memoryMiB: 1024,
              podCount: 4,
            },
            quotas: { status: "available", items: [] },
            canaveral: owned,
          },
        },
      };
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname.replace(
          "/api/v1/",
          "",
        );
        let result = {};
        if (["auth/status", "auth/session"].includes(path))
          result = { user: adminUser, setupRequired: false };
        if (path === "hosts") result = { hosts: [host] };
        if (path === "machines") result = { machines: [] };
        if (path === "templates") result = { templates: [] };
        if (path === "hosts/pool/resources")
          result = {
            hostId: host.id,
            budget: host.capacity,
            reserved: host.reserved,
            categories: [],
            images: [],
            allocations: [],
            samples: [],
          };
        await route.fulfill({ json: result });
      });
      await page.goto("/#orchestrators/pool");
      const usage = page.getByRole("region", {
        name: "Canaveral VM workload usage",
      });
      await expect(usage).toBeVisible();
      await expect(page.getByText(/2 CPU cores/)).toBeVisible();
      if (state === "available") {
        await expect(usage.getByText(/0.000125 CPU cores/)).toBeVisible();
        await expect(
          usage.getByText(/Verified for 1 assigned machine/),
        ).toBeVisible();
      } else {
        await expect(
          usage.getByText(/Canaveral VM usage unavailable/),
        ).toBeVisible();
        await expect(usage.getByText(/0 CPU cores/)).toHaveCount(0);
      }
      await expect(
        usage.getByText(/included in the namespace total/),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
    });
  }
}
