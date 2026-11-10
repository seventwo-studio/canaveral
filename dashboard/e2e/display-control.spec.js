import { adminUser } from "./auth-fixture.js";
import { test, expect } from "@playwright/test";

test("real noVNC client accepts separate runner control acknowledgements", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const machine = {
    id: "display-fixture",
    name: "Fixture desktop",
    hostId: "host",
    observed: "running",
    desired: "running",
    ready: true,
    updatedAt: Date.now() / 1000,
    preparation: { state: "ready" },
    templateId: "linux",
    template: {
      id: "linux",
      name: "Linux",
      os: "linux",
      arch: "arm64",
      mode: "desktop",
      guestAccess: true,
    },
    resources: { cpu: 2, memoryMiB: 2048, diskGiB: 16 },
  };
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const result =
      path.endsWith("auth/status") || path.endsWith("auth/session")
        ? { setupRequired: false, user: adminUser }
        : path.endsWith("/machines")
          ? { machines: [machine] }
          : path.endsWith("/hosts")
            ? { hosts: [] }
            : path.endsWith("/templates")
              ? { templates: [] }
              : path.endsWith("/accessibility")
                ? {
                    snapshotId: "11111111-2222-4333-8444-555555555555",
                    capturedAt: Date.now() / 1000,
                    source: "fixture",
                    coordinateSpace: "screen-pixels",
                    truncated: false,
                    coverage: "Synthetic normalized native hierarchy fixture",
                    nodes: [
                      {
                        id: "target",
                        parentId: null,
                        depth: 0,
                        name: "Launch fixture",
                        role: "button",
                        identifier: "launch",
                        states: { enabled: true },
                        properties: {},
                        path: [0],
                        bounds: { x: 1, y: 1, width: 4, height: 4 },
                        actions: ["click"],
                      },
                    ],
                  }
                : {};
    await route.fulfill({ json: result });
  });
  let controlRequest,
    peer,
    stage = 0;
  await page.routeWebSocket("**/desktop", (ws) => {
    peer = ws;
    ws.onMessage((data) => {
      if (typeof data === "string") {
        controlRequest = JSON.parse(data);
        return;
      }
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
      }
    });
    ws.send(Buffer.from("RFB 003.008\n"));
  });
  await page.goto("/#machines");
  await page.getByRole("button", { name: "Control", exact: true }).click();
  const take = page.getByRole("button", { name: "Take control", exact: true });
  try {
    await expect(take).toBeEnabled();
  } catch (error) {
    throw new Error(
      `Handshake stage ${stage}, peer ${Boolean(peer)}: ${errors.join("; ")}; ${await page.locator('[role="alert"]').allTextContents()}`,
    );
  }
  await take.click();
  await expect
    .poll(() => controlRequest)
    .toEqual({ type: "input-control", action: "take" });
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  peer.send(JSON.stringify({ type: "control", state: "owned" }));
  await expect(
    page.getByText("Mouse and keyboard connected", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await page.getByRole("button", { name: /Launch fixture/ }).click();
  await page.getByRole("button", { name: "click", exact: true }).click();
  await expect.poll(() => controlRequest.action).toBe("accessibility-action");
  expect(controlRequest).toMatchObject({
    type: "action",
    arguments: {
      snapshotId: "11111111-2222-4333-8444-555555555555",
      nodeId: "target",
      nativeAction: "click",
    },
  });
  peer.send(
    JSON.stringify({
      type: "action-result",
      id: controlRequest.id,
      state: "succeeded",
      result: { posted: true },
    }),
  );
  await expect(
    page.getByRole("button", { name: "click", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Release control", exact: true })
    .click();
  await expect.poll(() => controlRequest.action).toBe("release");
  peer.send(JSON.stringify({ type: "control", state: "view-only" }));
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  await expect(take).toBeEnabled();
});
