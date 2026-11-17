import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

for (const width of [320, 1440]) {
  test(`catalogues preserve evidence and distinguish unavailable/search states at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 });
    const minimum = { cpu: 1, memoryMiB: 1024, diskGiB: 8 };
    const source = {
      id: "ubuntu",
      revision: "24.04",
      name: "Ubuntu Server",
      os: "linux",
      arch: "arm64",
      mode: "headless",
      hostId: "host",
      online: true,
      accepting: true,
      minimum,
    };
    const image = {
      id: source.id,
      name: source.name,
      hostId: "host",
      kind: "base",
      os: source.os,
      arch: source.arch,
      format: "raw",
      mediaType: "disk",
      sha256: "a".repeat(64),
      bytes: 2147483648,
      registry: {
        id: "ubuntu-lts",
        version: "24.04",
        url: "https://example.com/ubuntu.raw",
        publisherSha256: "a".repeat(64),
      },
    };
    const blueprint = {
      id: "development",
      name: "Development workspace",
      revision: "1",
      source: { id: source.id, revision: source.revision, arch: source.arch },
      image: source,
      minimum,
      defaults: { cpu: 4, memoryMiB: 8192, diskGiB: 48 },
    };
    let failure = false;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      if (failure && ["image-library", "blueprints"].includes(path))
        return route.fulfill({
          status: 503,
          json: { error: "Catalogue temporarily unavailable" },
        });
      const result = ["auth/status", "auth/session"].includes(path)
        ? { user: adminUser, setupRequired: false }
        : path === "hosts"
          ? { hosts: [] }
          : path === "machines"
            ? { machines: [] }
            : path === "templates"
              ? { templates: [source] }
              : path === "users"
                ? { users: [adminUser] }
                : path === "image-library"
                  ? { images: [image] }
                  : path === "blueprints"
                    ? { blueprints: [blueprint] }
                    : path === "image-tasks"
                      ? { tasks: [] }
                      : {};
      await route.fulfill({ json: result });
    });
    await page.goto("/#images");
    await expect(
      page.getByText("Ubuntu Server", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Publisher SHA-256 matched", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(image.sha256, { exact: true }),
    ).not.toBeVisible();
    await page.getByText("Source & checksum", { exact: true }).click();
    await expect(page.getByText(image.sha256, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByText("Source & checksum", { exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath("image-library.png"),
      fullPage: true,
    });
    const search = page.getByRole("textbox", { name: "Search image library" });
    await search.fill("no such image");
    await expect(
      page.getByRole("heading", { name: "No matching images", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await expect(
      page.getByText("Ubuntu Server", { exact: true }),
    ).toBeVisible();
    failure = true;
    await page
      .getByRole("button", { name: "Refresh image library", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Showing the last snapshot" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create blueprint", exact: true }),
    ).toBeDisabled();
    failure = false;
    await page
      .getByRole("button", { name: "Refresh image library", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Create blueprint", exact: true }),
    ).toBeEnabled();
    await page.goto("/#blueprints");
    await expect(
      page.getByText("Development workspace", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", {
        name: "Refresh machine blueprints",
        exact: true,
      }),
    ).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("blueprints.png"),
      fullPage: true,
    });
    failure = true;
    await page.reload();
    await expect(
      page.getByRole("alert").filter({ hasText: "could not be loaded" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No machine blueprints", exact: true }),
    ).toHaveCount(0);
    failure = false;
    await page
      .getByRole("button", { name: "Retry blueprints", exact: true })
      .click();
    await expect(
      page.getByText("Development workspace", { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
