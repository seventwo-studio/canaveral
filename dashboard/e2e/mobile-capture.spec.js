import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

// Produced by FFmpeg with the runner's encoder arguments: 31 frames, 64 × 112.
const mp4 = readFileSync(new URL("./fixtures/capture.mp4", import.meta.url));
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const token = randomBytes(32).toString("base64url");
const machineId = "11111111-2222-4333-8444-555555555555";
const generation = "4b1f2d9a-7c0e-4e58-9a63-2f0d9c1c6e11";
const template = {
  id: "acceptance-ios",
  revision: "1",
  arch: "arm64",
  os: "ios",
  mode: "device",
  hostId: "h1",
  online: true,
  accepting: true,
  minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
  defaults: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
};
const machine = {
  id: machineId,
  name: "Trial phone",
  hostId: "h1",
  ownerId: adminUser.id,
  templateId: template.id,
  template,
  resources: template.defaults,
  desired: "running",
  observed: "running",
  ready: true,
  preparation: { state: "ready" },
  updatedAt: Date.now() / 1000,
};
function frame(opcode, payload) {
  const data = Buffer.from(payload);
  const header =
    data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([header, data]);
}
/** Stands in for the controller behind the real dashboard gateway (port 18765). */
async function controller(upgrades) {
  const server = createServer((request, response) => {
    const ok = request.url === `/v1/machines/${machineId}/authorize`;
    response.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        ok ? { authorized: true, machineId, action: "access" } : {},
      ),
    );
  });
  server.on("upgrade", (request, socket) => {
    upgrades.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      extensions: request.headers["sec-websocket-extensions"],
    });
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\n\r\n`,
    );
    const sessionId = request.url.split("/")[5];
    const send = (value) => socket.write(frame(1, JSON.stringify(value)));
    send({ type: "ready", sessionId, generation, capability: "video" });
    send({ type: "video", mediaType: "video/mp4", codec: "avc1", fps: 30 });
    for (let at = 0; at < mp4.length; at += 8192)
      socket.write(frame(2, mp4.subarray(at, at + 8192)));
    send({
      type: "finish",
      bytes: mp4.length,
      sha256: createHash("sha256").update(mp4).digest("hex"),
      cleaned: true,
    });
    let input = Buffer.alloc(0);
    socket.on("data", (data) => {
      input = Buffer.concat([input, data]);
      if (input.length < 6) return;
      const length = input[1] & 127,
        mask = input.subarray(2, 6);
      if (input.length < 6 + length) return;
      const text = Buffer.from(
        input.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]),
      ).toString();
      upgrades.at(-1).received = text;
      socket.end(frame(8, Buffer.alloc(0)));
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(18765, "127.0.0.1", resolve));
  return server;
}

for (const width of [390, 1440])
  test(`owner captures a screenshot and a verified MP4 under CSP at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await context.addCookies([
      {
        name: "canaveral_session",
        value: token,
        url: "http://127.0.0.1:18766",
      },
    ]);
    let session = null;
    let state = "pending";
    const requests = [];
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname.split("/api/v1/")[1];
      const method = route.request().method();
      const body = method === "POST" ? route.request().postDataJSON() : null;
      requests.push([method, path, body]);
      let result = {};
      if (["auth/status", "auth/session"].includes(path))
        result = { setupRequired: false, user: adminUser };
      else if (path === "hosts") result = { hosts: [] };
      else if (path === "templates") result = { templates: [template] };
      else if (path === "machines") result = { machines: [machine] };
      else if (path === "users") result = { users: [adminUser] };
      else if (path === `machines/${machineId}/operations`)
        result = {
          id: body.id,
          machineId,
          state: "succeeded",
          result: { data: png, mediaType: "image/png" },
        };
      else if (path.startsWith(`machines/${machineId}/video-sessions`)) {
        if (body?.fps) session = body.id;
        else if (path.endsWith("/close")) state = "disconnected";
        else if (method === "GET") state = "finished";
        result = {
          id: session,
          machineId,
          generation,
          capability: "video",
          protocol: "canaveral-session-v1",
          state,
          fps: 30,
          durationSeconds: 5,
          bitRate: 4000000,
        };
      }
      await route.fulfill({ json: result });
    });
    const upgrades = [];
    const server = await controller(upgrades);
    try {
      await page.goto("/#machines");
      await page
        .getByRole("button", { name: "Trial phone", exact: true })
        .click();
      await page.getByLabel("Screenshot name").fill("Onboarding 1");
      await page.getByRole("button", { name: "Take screenshot" }).click();
      await expect(
        page.getByRole("link", { name: "Download Onboarding 1.png" }),
      ).toHaveAttribute("download", "Onboarding 1.png");
      await expect(
        page.getByRole("img", { name: "Device screenshot" }),
      ).toBeVisible();
      await page.getByLabel("Recording name").fill("Walkthrough");
      await page.getByLabel("Recording length").selectOption("5");
      await page.getByRole("button", { name: "Record MP4" }).click();
      await expect(
        page.getByText(/Recording verified · 31 frames · 1\.0 s · 64 × 112/),
      ).toBeVisible();
      await expect(page.getByText(/capture session released/)).toBeVisible();
      const video = page.getByLabel("Recording preview");
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element.readyState >= 1 ? element.duration : 0,
          ),
        )
        .toBeGreaterThan(0.9);
      expect(
        await video.evaluate((element) => [
          element.videoWidth,
          element.videoHeight,
        ]),
      ).toEqual([64, 112]);
      const download = page.waitForEvent("download");
      await page
        .getByRole("link", { name: "Download Walkthrough.mp4" })
        .click();
      const file = await download;
      expect(file.suggestedFilename()).toBe("Walkthrough.mp4");
      expect(readFileSync(await file.path())).toEqual(mp4);
      expect(upgrades).toEqual([
        {
          url: `/v1/machines/${machineId}/video-sessions/${session}/${generation}`,
          authorization: `Bearer ${token}`,
          cookie: undefined,
          origin: undefined,
          extensions: undefined,
          received: '{"type":"ack"}',
        },
      ]);
      expect(requests).not.toContainEqual([
        "POST",
        `machines/${machineId}/video-sessions/${session}/close`,
        {},
      ]);
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
