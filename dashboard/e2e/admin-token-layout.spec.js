import { expect, test } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

test("token details and revocation fit the phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const token = {
    id: "a3bd7934-42e2-41f8-8ab9-89fb13cca9a9",
    userId: adminUser.id,
    name: "Deployment worker",
    prefix: "cv_example_",
    scopes: ["machines:read"],
    createdAt: 100,
    expiresAt: 9999999999,
    lastUsedAt: null,
    revokedAt: null,
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(
      "/api/v1/".length,
    );
    const json = ["auth/status", "auth/session"].includes(path)
      ? { user: adminUser, setupRequired: false }
      : path === "admin/tokens"
        ? { tokens: [token] }
        : path === "users"
          ? { users: [adminUser] }
          : { [path]: [] };
    await route.fulfill({ json });
  });

  await page.goto("/#admin/tokens");
  const revoke = page.getByRole("button", { name: "Revoke Deployment worker" });
  await expect(revoke).toBeVisible();
  const row = page.getByRole("row").filter({ has: revoke });
  for (const cell of await row.getByRole("cell").all()) {
    const box = await cell.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  if (process.env.CANAVERAL_SCREENSHOT_DIR) {
    await page.screenshot({
      path: process.env.CANAVERAL_SCREENSHOT_DIR + "/token-record-320.png",
    });
  }
  await revoke.click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Deployment worker",
  );
});
