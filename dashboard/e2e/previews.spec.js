import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

for (const width of [320, 1440]) {
  test(`a waiting preview shows its queue state and cancels at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const deadline = new Date(Date.now() + 600000).toISOString();
    let preview = {
      id: "0b6e5a4c-1d2e-4f3a-8b7c-6d5e4f3a2b1c",
      mode: "static",
      state: "provisioning",
      expiresAt: deadline,
      request: {
        state: "waiting",
        priority: 0,
        deadline,
        reason: "capacity_unavailable",
        admittedAt: null,
      },
    };
    const deletes = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (["machines", "hosts", "templates"].includes(path))
        result = { [path]: [] };
      else if (path === "previews") result = { previews: [preview] };
      else if (path === "previews/" + preview.id) {
        if (route.request().method() === "DELETE") {
          deletes.push(path);
          preview = {
            ...preview,
            state: "stopped",
            request: {
              ...preview.request,
              state: "cancelled",
              reason: "consumer_cancelled",
            },
          };
        }
        result = preview;
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/#previews");
    await expect(page.getByText("waiting for capacity")).toBeVisible();
    await expect(page.getByText(/Queued at priority 0/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel waiting preview" }).click();
    await expect(
      page.getByText("Request cancelled (consumer_cancelled)"),
    ).toBeVisible();
    expect(deletes).toEqual(["previews/" + preview.id]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
