import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

const host = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Studio",
  provider: "macos",
  online: true,
  enabled: true,
  accepting: true,
  capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 128 },
  reserved: { cpu: 0, memoryMiB: 0, diskGiB: 0 },
};
const offer = {
  hostId: host.id,
  online: true,
  accepting: true,
  arch: "arm64",
  os: "linux",
  preparationDriver: "cloud-init",
};
const headless = {
  ...offer,
  id: "linux-server",
  revision: "1",
  mode: "headless",
  minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 },
};
const desktop = {
  ...offer,
  id: "linux-desktop",
  revision: "1",
  name: "Debian desktop",
  mode: "desktop",
  guestAccess: true,
  minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 16 },
  defaults: { cpu: 2, memoryMiB: 4096, diskGiB: 32 },
};

/** Minimal RFB 3.8 server: no security, a 16x16 true-colour frame buffer. */
function rfbFixture(ws, state) {
  let stage = 0;
  ws.onMessage((data) => {
    if (typeof data === "string") {
      state.control.push(JSON.parse(data));
      return;
    }
    const bytes = Buffer.from(data);
    if (stage === 0) {
      stage++;
      ws.send(Buffer.from([1, 1]));
    } else if (stage === 1) {
      stage++;
      ws.send(Buffer.alloc(4));
    } else if (stage === 2) {
      stage++;
      const header = Buffer.alloc(24);
      header.writeUInt16BE(16, 0);
      header.writeUInt16BE(16, 2);
      Buffer.from([
        32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
      ]).copy(header, 4);
      ws.send(header);
      ws.send(JSON.stringify({ type: "control", state: "view-only" }));
    } else {
      // RFB client messages: 4 = KeyEvent, 5 = PointerEvent.
      for (let i = 0; i < bytes.length;) {
        const type = bytes[i];
        if (type === 4) {
          state.keys.push({
            down: bytes[i + 1],
            key: bytes.readUInt32BE(i + 4),
          });
          i += 8;
        } else if (type === 5) {
          state.pointer.push(bytes[i + 1]);
          i += 6;
        } else break;
      }
    }
  });
  ws.send(Buffer.from("RFB 003.008\n"));
}

test("launches a Linux desktop, controls it, then stops and deletes it with host confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let machine = null,
    stage = "absent";
  const posted = [];
  const view = () => {
    if (!machine || stage === "absent" || stage === "deleted") return [];
    const base = {
      ...machine,
      hostId: host.id,
      ownerId: adminUser.id,
      template: desktop,
      templateId: desktop.id,
      updatedAt: Date.now() / 1000,
      capabilities: {
        desktopStream: true,
        files: true,
        shell: true,
        accessibility: true,
      },
    };
    if (stage === "preparing")
      return [
        {
          ...base,
          desired: "running",
          observed: "running",
          ready: false,
          preparation: { state: "pending" },
        },
      ];
    if (stage === "ready")
      return [
        {
          ...base,
          desired: "running",
          observed: "running",
          ready: true,
          preparation: { state: "ready" },
        },
      ];
    const stopped = {
      ...base,
      desired: "stopped",
      observed: "stopped",
      ready: false,
      preparation: { state: "ready" },
    };
    if (stage === "stopped") return [stopped];
    return [
      { ...stopped, deletion: { id: posted.at(-1).id, state: "running" } },
    ];
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split("/api/v1/")[1];
    const method = request.method();
    let result = {};
    if (["auth/status", "auth/session"].includes(path))
      result = { setupRequired: false, user: adminUser };
    else if (path === "hosts") result = { hosts: [host] };
    else if (path === "templates") result = { templates: [headless, desktop] };
    else if (path === "machines" && method === "POST") {
      const body = request.postDataJSON();
      posted.push(body);
      machine = { id: body.id, name: body.name, resources: body.resources };
      stage = "preparing";
      result = view()[0];
    } else if (path === "machines") result = { machines: view() };
    else if (path.endsWith("/desired")) {
      posted.push(request.postDataJSON());
      stage = "stopped";
      result = { ok: true };
    } else if (path.endsWith("/delete")) {
      const body = request.postDataJSON();
      posted.push(body);
      stage = "deleting";
      result = { id: body.id, machineId: machine.id, state: "queued" };
    } else if (path.endsWith("/operations")) {
      const body = request.postDataJSON();
      result = {
        id: body.id,
        machineId: machine.id,
        state: "succeeded",
        result: { path: "/", entries: [] },
      };
    }
    await route.fulfill({ json: result });
  });
  const display = { control: [], keys: [], pointer: [] };
  let peer;
  await page.routeWebSocket("**/desktop", (ws) => {
    peer = ws;
    rfbFixture(ws, display);
  });
  const refresh = () =>
    page
      .getByRole("button", { name: /^Refresh/ })
      .first()
      .click();

  await page.goto("/#machines");
  await page.getByRole("button", { name: "Launch desktop" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Launch a Linux desktop" }),
  ).toBeVisible();
  await expect(dialog.getByText("Placement")).toHaveCount(0);
  await expect(dialog.getByText(/linux · Desktop/)).toBeVisible();
  await dialog.getByLabel("Machine name").fill("review-desktop");
  await dialog.getByRole("button", { name: "Launch desktop" }).click();
  await expect(
    page.getByText(/review-desktop is starting on Studio/),
  ).toBeVisible();
  expect(posted[0]).toMatchObject({
    name: "review-desktop",
    templateId: "linux-desktop",
    templateRevision: "1",
    arch: "arm64",
    resources: desktop.defaults,
  });
  expect(posted[0]).not.toHaveProperty("hostId");
  const list = page.getByRole("list", { name: "Machine list" });
  await expect(list.getByText("Preparing", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Control", exact: true }),
  ).toHaveCount(0);

  stage = "ready";
  await refresh();
  await expect(list.getByText("Ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Control", exact: true }).click();
  const take = page.getByRole("button", { name: "Take control", exact: true });
  await expect(take).toBeEnabled();
  await take.click();
  await expect
    .poll(() => display.control.at(-1))
    .toEqual({ type: "input-control", action: "take" });
  peer.send(JSON.stringify({ type: "control", state: "owned" }));
  await expect(
    page.getByText("Mouse and keyboard connected", { exact: true }),
  ).toBeVisible();
  const screen = page.locator("canvas").first();
  await screen.click({ position: { x: 4, y: 4 } });
  await page.keyboard.type("ok");
  await expect.poll(() => display.pointer.includes(1)).toBe(true);
  await expect
    .poll(() => display.keys.filter((k) => k.down).map((k) => k.key))
    .toEqual([0x6f, 0x6b]);
  await page
    .getByRole("button", { name: "Release control", exact: true })
    .click();
  await page.getByRole("button", { name: "Close machine workspace" }).click();

  await page.getByRole("button", { name: "Stop review-desktop" }).click();
  await page.getByRole("button", { name: "Request stop" }).click();
  await expect.poll(() => posted.at(-1)).toEqual({ state: "stopped" });
  await refresh();
  await expect(list.getByText("Stopped", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "More actions for review-desktop" })
    .click();
  await page.getByRole("menuitem", { name: /Delete machine/ }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText(/permanently removes/)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete machine" }).click();
  await expect(
    confirm.getByText(/Waiting for the host to confirm removal/),
  ).toBeVisible();
  expect(posted.at(-1).id).toMatch(/^[0-9a-f-]{36}$/);
  await confirm.getByRole("button", { name: "Close" }).first().click();
  await expect(list.getByText("Deleting", { exact: true })).toBeVisible();
  await expect(page.getByText(/review-desktop deleted/)).toHaveCount(0);
  stage = "deleted";
  await refresh();
  await expect(
    page.getByText("review-desktop deleted. The host confirmed removal."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
