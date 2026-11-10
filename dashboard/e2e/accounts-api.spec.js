import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test.describe("real account controller and gateway", () => {
  test.skip(
    !process.env.CANAVERAL_ACCOUNTS_API_FIXTURE,
    "Requires the disposable accounts API fixture",
  );
  test("remote bootstrap, invitation, private inventory, scoped token and revocation", async ({
    page,
    browser,
    baseURL,
  }) => {
    const fixture = JSON.parse(
      readFileSync(
        join(process.env.CANAVERAL_ACCOUNT_FIXTURE_DIR, "bootstrap.json"),
        "utf8",
      ),
    );
    await page.goto(`/#claim=${encodeURIComponent(fixture.token)}`);
    await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page
      .getByLabel("New password", { exact: true })
      .fill("disposable admin password");
    await page
      .getByLabel("Confirm password", { exact: true })
      .fill("disposable admin password");
    await page
      .getByRole("button", { name: "Save password and sign in", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
    await expect(
      page.getByText("Admin private machine", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Administration", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage users", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page.getByLabel("New username", { exact: true }).fill("alice");
    await page
      .getByRole("button", { name: "Create user", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Issue invitation for alice", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Disable alice", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText("Disable alice?");
    await page
      .getByRole("button", { name: "Disable account", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enable alice", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Issue invitation for alice", exact: true })
      .click();
    const invitation = await page
      .getByRole("textbox", { name: "Account link", exact: true })
      .inputValue();
    const aliceContext = await browser.newContext();
    const alice = await aliceContext.newPage();
    let api;
    try {
      await alice.goto(invitation);
      await expect(
        alice.getByText("Account: alice", { exact: true }),
      ).toBeVisible();
      expect(new URL(alice.url()).hash).toBe("");
      await alice
        .getByLabel("New password", { exact: true })
        .fill("disposable alice password");
      await alice
        .getByLabel("Confirm password", { exact: true })
        .fill("disposable alice password");
      await alice
        .getByRole("button", { name: "Save password and sign in", exact: true })
        .click();
      await expect(
        alice.getByRole("button", { name: "Account menu" }),
      ).toBeVisible();
      await expect(
        alice.getByText("Admin private machine", { exact: true }),
      ).toHaveCount(0);
      await expect(
        alice.getByRole("link", { name: "Hosts", exact: true }),
      ).toHaveCount(0);
      const created = await alice.request.post(`${baseURL}/api/v1/machines`, {
        headers: { Origin: baseURL },
        data: {
          id: randomUUID(),
          name: "Alice private machine",
          templateId: "linux",
          resources: {},
        },
      });
      expect(created.status()).toBe(200);
      const machine = await created.json();
      const adminRequests = [];
      alice.on("request", (r) => {
        if (/\/api\/v1\/(?:users|admin\/|hosts)/.test(r.url()))
          adminRequests.push(r.url());
      });
      await alice.goto("/#admin/tokens");
      await expect(
        alice.getByRole("heading", { name: "Machines", exact: true }),
      ).toBeVisible();
      expect(adminRequests).toEqual([]);
      await page.goto("/#machines");
      await expect(
        page.getByRole("button", {
          name: "Alice private machine",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Machine owner", { exact: true })
        .selectOption(machine.ownerId);
      await expect(
        page.getByRole("button", {
          name: "Admin private machine",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Alice private machine",
          exact: true,
        }),
      ).toBeVisible();
      const inventory = await alice.request.get(`${baseURL}/api/v1/machines`);
      expect((await inventory.json()).machines.map((m) => m.id)).toEqual([
        machine.id,
      ]);
      const foreign = await alice.request.get(
        `${baseURL}/api/v1/machines/${fixture.legacyMachine}`,
      );
      expect(foreign.status()).toBe(404);
      await alice.getByRole("button", { name: "Account menu" }).click();
      await alice
        .getByRole("menuitem", { name: "API tokens", exact: true })
        .click();
      await alice.getByLabel("Token name", { exact: true }).fill("Read only");
      await alice
        .getByRole("button", { name: "Create token", exact: true })
        .click();
      const secret = await alice
        .getByRole("textbox", { name: "New API token", exact: true })
        .inputValue();
      api = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
      });
      const tokenInventory = await api.get("/api/v1/machines");
      expect(tokenInventory.status()).toBe(200);
      expect((await tokenInventory.json()).machines.map((m) => m.id)).toEqual([
        machine.id,
      ]);
      const denied = await api.post("/api/v1/machines", {
        data: {
          id: randomUUID(),
          name: "Forbidden",
          templateId: "linux",
          resources: {},
        },
      });
      expect(denied.status()).toBe(403);
      await alice.getByRole("button", { name: "Done", exact: true }).click();
      await expect(
        alice.getByRole("textbox", { name: "New API token", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("link", { name: "API access", exact: true }).click();
      const tokenRow = page.getByRole("row").filter({ hasText: "Read only" });
      await expect(tokenRow).toContainText("alice");
      await tokenRow
        .getByRole("button", { name: "Revoke Read only", exact: true })
        .click();
      expect((await api.get("/api/v1/machines")).status()).toBe(200);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await tokenRow
        .getByRole("button", { name: "Revoke Read only", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Revoke token", exact: true })
        .click();
      await expect(tokenRow).toContainText("Revoked");
      await expect(
        tokenRow.getByRole("button", { name: "Revoke Read only", exact: true }),
      ).toHaveCount(0);
      expect((await api.get("/api/v1/machines")).status()).toBe(401);
      await alice
        .getByRole("button", { name: "Refresh tokens", exact: true })
        .click();
      await expect(
        alice.getByText("Read only · Revoked", { exact: true }),
      ).toBeVisible();
      if (process.env.CANAVERAL_DASHBOARD_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.CANAVERAL_DASHBOARD_SCREENSHOTS,
            "api-access-desktop.png",
          ),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (process.env.CANAVERAL_DASHBOARD_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.CANAVERAL_DASHBOARD_SCREENSHOTS,
            "api-access-mobile.png",
          ),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("link", { name: "Users", exact: true }).click();
      await page.getByLabel("Search users", { exact: true }).fill("alice");
      await expect(
        page.getByRole("row").filter({ hasText: "alice" }),
      ).toContainText("1");
      if (process.env.CANAVERAL_DASHBOARD_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.CANAVERAL_DASHBOARD_SCREENSHOTS,
            "users-desktop.png",
          ),
          fullPage: true,
        });
      }
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Administration", exact: true }),
      ).toBeVisible();
      if (process.env.CANAVERAL_DASHBOARD_SCREENSHOTS) {
        await page.screenshot({
          path: join(
            process.env.CANAVERAL_DASHBOARD_SCREENSHOTS,
            "overview-desktop.png",
          ),
          fullPage: true,
        });
      }
      expect(
        await alice.evaluate(() => localStorage.length + sessionStorage.length),
      ).toBe(0);
    } finally {
      if (api) await api.dispose();
      await aliceContext.close();
    }
  });
});
