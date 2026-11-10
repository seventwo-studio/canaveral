import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

for (const width of [320, 1440])
  test(`base image registry imports and publisher downloads at ${width}px`, async ({
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
      reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
      health: { environment: { arch: "arm64" } },
    };
    const minimum = { cpu: 2, memoryMiB: 4096, diskGiB: 32 };
    const entries = [
      {
        id: "ubuntu-noble-cloud-arm64",
        name: "Ubuntu 24.04 LTS · cloud disk",
        publisher: "Canonical",
        os: "linux",
        arch: "arm64",
        mediaType: "disk",
        format: "qcow2",
        sourcePage: "https://cloud-images.ubuntu.com/noble/current/",
        resolver: "ubuntu-cloud",
        status: "available",
        minimum,
        note: "Installed cloud disk with automatic guest services.",
      },
      {
        id: "windows-11-iso-amd64",
        name: "Windows 11 · installation ISO",
        publisher: "Microsoft",
        os: "windows",
        arch: "amd64",
        mediaType: "installer",
        format: "iso",
        sourcePage:
          "https://www.microsoft.com/en-us/software-download/windows11",
        resolver: null,
        status: "manual",
        minimum: { ...minimum, diskGiB: 64 },
        note: "Download from Microsoft, then import the ISO.",
      },
    ];
    let task = null,
      received = null;
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
      if (path === "image-tasks") result = { tasks: task ? [task] : [] };
      if (path === "image-registry") result = { entries };
      if (path === "image-registry/imports") {
        received = route.request().postDataJSON();
        task = {
          id: received.id,
          kind: "registry",
          name: entries[0].name,
          state: "running",
          updatedAt: Date.now() / 1000,
        };
        result = task;
      }
      if (task && path === `image-tasks/${task.id}`) {
        task = { ...task, state: "succeeded" };
        result = task;
      }
      await route.fulfill({ json: result });
    });
    await page.goto("/#templates");
    await page
      .getByRole("button", { name: "Base image registry", exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Base image registry", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Publisher download", { exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Import to host", exact: true })
      .click();
    await expect(
      dialog.getByRole("region", { name: "Registry import status" }),
    ).toContainText("Imported and registered");
    expect(received.registryId).toBe(entries[0].id);
    expect(received.hostId).toBe(host.id);
    expect(received.guestAccess).toBe(true);
    expect(received.url).toBeUndefined();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await dialog.getByLabel("Search registry").fill("Windows");
    await expect(dialog.getByRole("article")).toHaveCount(1);
    await dialog
      .getByRole("button", { name: "Import downloaded file", exact: true })
      .click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Import base image", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Image name", { exact: true })).toHaveValue(
      entries[1].name,
    );
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  });
