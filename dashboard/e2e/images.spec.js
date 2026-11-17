import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [390, 1440])
  test(`image import and cold capture at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const host = {
      id: "4be8431f-e17b-4f15-854b-e25229f34ac1",
      name: "Local Mac",
      provider: "macos",
      platform: "macos",
      runtimes: ["apple"],
      online: true,
      enabled: true,
      capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 192 },
      reserved: { cpu: 0, memoryMiB: 0, diskGiB: 32 },
    };
    const base = {
      id: "ubuntu",
      revision: "1",
      os: "linux",
      arch: "arm64",
      mode: "desktop",
      guestAccess: true,
      hostId: host.id,
      online: true,
      accepting: true,
      minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
    };
    const source = {
      id: "cff698f2-124b-4744-8172-0e451dea25e5",
      name: "Existing Linux",
      hostId: host.id,
      templateId: base.id,
      template: base,
      resources: base.minimum,
      desired: "stopped",
      observed: "stopped",
      ready: false,
      preparation: { state: "ready" },
      updatedAt: Date.now() / 1000,
    };
    const templates = [base],
      images = [],
      blueprints = [];
    let uploaded = 0,
      capture = null;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1/",
        "",
      );
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      if (path === "hosts") result = { hosts: [host] };
      if (path === "machines") result = { machines: [source] };
      if (path === "templates") result = { templates };
      if (path === "image-library") result = { images };
      if (path === "blueprints") {
        if (route.request().method() === "POST") {
          const spec = route.request().postDataJSON();
          result = {
            ...spec,
            image: templates.find((t) => t.id === spec.source.id),
          };
          blueprints.push(result);
        } else result = { blueprints };
      }
      if (path === "image-tasks") result = { tasks: capture ? [capture] : [] };
      if (path.endsWith("/images/import")) {
        const metadata = JSON.parse(
          decodeURIComponent(route.request().headers()["x-canaveral-image"]),
        );
        uploaded = route.request().postDataBuffer().length;
        result = {
          ...metadata,
          sha256: "a".repeat(64),
          bytes: uploaded,
          kind: "base",
          revision: "1",
        };
        images.push({ ...result, hostId: host.id });
        templates.push({
          ...base,
          ...metadata,
          imageKind: "base",
          guestAccess: false,
          catalogueImageId: metadata.id,
        });
      }
      if (path === "images/captures") {
        const body = route.request().postDataJSON();
        capture = {
          id: body.id,
          name: body.name,
          kind: "capture",
          state: "queued",
          updatedAt: Date.now() / 1000,
        };
        result = capture;
      }
      if (path.startsWith("image-tasks/")) {
        capture = { ...capture, state: "succeeded" };
        result = capture;
        if (!templates.some((t) => t.id === capture.id))
          templates.push({
            ...base,
            id: capture.id,
            name: capture.name,
            imageKind: "derived",
            mediaType: "disk",
            catalogueImageId: capture.id,
          });
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/#images");
    await page
      .getByRole("button", { name: "Import image", exact: true })
      .click();
    const importer = page.getByRole("dialog", { name: "Import base image" });
    await importer
      .getByLabel("Image name", { exact: true })
      .fill("Reusable Ubuntu");
    await importer.getByLabel("Format", { exact: true }).selectOption("raw");
    await importer.getByLabel("Image file", { exact: true }).setInputFiles({
      name: "ubuntu.raw",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(2 * 1024 * 1024),
    });
    await importer
      .getByRole("button", { name: "Import image", exact: true })
      .click();
    await expect(
      importer.getByText("Imported Reusable Ubuntu.", { exact: true }),
    ).toBeVisible();
    expect(uploaded).toBe(2 * 1024 * 1024);
    expect(
      await importer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await importer.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByText("Reusable Ubuntu", { exact: true }),
    ).toBeVisible();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("link", { name: /Machines/ })
      .filter({ hasText: "Machines" })
      .last()
      .click();
    const more = page.getByRole("button", {
      name: "More actions for Existing Linux",
      exact: true,
    });
    await more.click();
    await page
      .getByRole("menuitem", { name: "Capture snapshot", exact: true })
      .click();
    const captureDialog = page.getByRole("dialog", {
      name: "Capture prepared snapshot",
    });
    await expect(captureDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.press("Enter");
    await page
      .getByRole("menuitem", { name: "Capture snapshot", exact: true })
      .press("Enter");
    await captureDialog
      .getByLabel("Snapshot name", { exact: true })
      .fill("Configured snapshot");
    await captureDialog
      .getByRole("button", { name: "Capture snapshot", exact: true })
      .click();
    await expect(
      captureDialog.getByText("Prepared snapshot captured", { exact: true }),
    ).toBeVisible();
    await captureDialog
      .getByRole("button", { name: "Done", exact: true })
      .click();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("link", { name: "Image library", exact: true })
      .click();
    await expect(
      page.getByText("Configured snapshot", { exact: true }),
    ).not.toBeVisible();
    if (width < 768)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("link", { name: "Machine blueprints", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New blueprint", exact: true })
      .click();
    const blueprint = page.getByRole("dialog", {
      name: "New machine blueprint",
    });
    await blueprint
      .getByLabel("Blueprint name", { exact: true })
      .fill("Development environment");
    await blueprint
      .getByLabel("Source image or prepared snapshot")
      .selectOption({ index: 2 });
    await blueprint.getByRole("button", { name: "Save blueprint" }).click();
    await expect(
      page.getByText("Development environment", { exact: true }),
    ).toBeVisible();
    expect(blueprints[0].source.id).toBe(capture.id);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
