import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { adminUser } from "./auth-fixture.js";

/** The screen wall in a real browser: the production gateway relays a live view from a stand-in
 * controller, and the page decodes it. The segments are cut from an FFmpeg recording made with the
 * runner's encoder arguments (31 frames, 64 × 112), so this checks that the browser's Media Source
 * Extensions accept the stream's shape. No device, emulator or runner takes part. */
const mp4 = readFileSync(new URL("./fixtures/capture.mp4", import.meta.url));
function boxes(data) {
  const found = [];
  for (let at = 0; at < data.length; at += data.readUInt32BE(at))
    found.push({
      type: data.toString("latin1", at + 4, at + 8),
      data: data.subarray(at, at + data.readUInt32BE(at)),
    });
  return found;
}
const parts = boxes(mp4);
const init = Buffer.concat(
  parts
    .filter((box) => ["ftyp", "moov"].includes(box.type))
    .map((box) => box.data),
);
const segments = parts
  .map((box, index) =>
    box.type === "moof"
      ? Buffer.concat([box.data, parts[index + 1].data])
      : null,
  )
  .filter(Boolean);
const token = randomBytes(32).toString("base64url");
const generation = "4b1f2d9a-7c0e-4e58-9a63-2f0d9c1c6e11";
const android = "11111111-2222-4333-8444-555555555555";
const ios = "11111111-2222-4333-8444-666666666666";
const leased = "11111111-2222-4333-8444-777777777777";
const template = (os) => ({
  id: `acceptance-${os}`,
  revision: "1",
  arch: "arm64",
  os,
  mode: "device",
  hostId: "h1",
  online: true,
  accepting: true,
  minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
  defaults: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
});
const device = (id, name, os, ownerId) => ({
  id,
  name,
  hostId: "h1",
  ownerId,
  templateId: `acceptance-${os}`,
  template: template(os),
  resources: template(os).defaults,
  desired: "running",
  observed: "running",
  ready: true,
  preparation: { state: "ready" },
  updatedAt: Date.now() / 1000,
});
function frame(opcode, payload) {
  const data = Buffer.from(payload);
  const header =
    data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([header, data]);
}
/** Stands in for the controller behind the real dashboard gateway (port 18765): it authorizes the
 * machine, accepts the relayed attachment and plays the host's side of a live view. */
async function controller(attachments) {
  const server = createServer((request, response) => {
    const ok = /^\/v1\/machines\/[0-9a-f-]{36}\/authorize$/.test(request.url);
    response.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        ok
          ? {
              authorized: true,
              machineId: request.url.split("/")[3],
              action: "access",
            }
          : {},
      ),
    );
  });
  server.on("upgrade", (request, socket) => {
    const [, , , machineId, , sessionId] = request.url.split("/");
    const attachment = {
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      received: [],
    };
    attachments.push(attachment);
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
    const send = (value) => socket.write(frame(1, JSON.stringify(value)));
    const sendBytes = (data) => {
      // Binary messages of at most 64 KiB; small ones here so a segment spans several.
      for (let at = 0; at < data.length; at += 1500)
        socket.write(frame(2, data.subarray(at, at + 1500)));
    };
    const epoch = (number) => {
      send({ type: "init", epoch: number, bytes: init.length });
      sendBytes(init);
      segments.forEach((segment, sequence) => {
        send({
          type: "segment",
          epoch: number,
          sequence,
          keyframe: sequence === 0,
          bytes: segment.length,
        });
        sendBytes(segment);
      });
    };
    attachment.epoch = epoch;
    send({ type: "ready", sessionId, generation, capability: "live" });
    if (machineId === ios) {
      // An iOS host that has not opted in serves nothing and says so in-band.
      send({
        type: "error",
        code: "capability_unsupported",
        message: "Live view is unsupported.",
        outcome: "unknown",
      });
      socket.end(frame(8, Buffer.alloc(0)));
      return;
    }
    send({ type: "live", mediaType: "video/mp4", codec: "avc1", fps: 30 });
    epoch(1);
    let input = Buffer.alloc(0);
    socket.on("data", (data) => {
      input = Buffer.concat([input, data]);
      while (input.length >= 6) {
        const length = input[1] & 127,
          mask = input.subarray(2, 6);
        if (length > 125 || input.length < 6 + length) return;
        const opcode = input[0] & 15;
        const text = Buffer.from(
          input.subarray(6, 6 + length).map((b, i) => b ^ mask[i % 4]),
        ).toString();
        input = input.subarray(6 + length);
        if (opcode === 8) {
          socket.end(frame(8, Buffer.alloc(0)));
          return;
        }
        if (opcode !== 1) continue;
        attachment.received.push(text);
        if (JSON.parse(text).type === "renew")
          send({
            type: "renewal",
            renewed: true,
            authorizationDeadline: new Date(Date.now() + 60000).toISOString(),
          });
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(18765, "127.0.0.1", resolve));
  return server;
}

for (const width of [320, 1440]) {
  test(`screen wall decodes a relayed live view under CSP at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    // The gateway relays a live view only for the session cookie with a matching Origin.
    await context.addCookies([
      {
        name: "canaveral_session",
        value: token,
        url: "http://127.0.0.1:18766",
      },
    ]);
    const attachments = [],
      requests = [],
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const server = await controller(attachments);
    try {
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.split("/api/v1/")[1];
        let result = {};
        if (["auth/status", "auth/session"].includes(path))
          result = { setupRequired: false, user: adminUser };
        else if (path === "machines")
          result = {
            machines: [
              device(android, "Trial phone", "android", adminUser.id),
              device(ios, "Trial iPhone", "ios", adminUser.id),
              // A leased device has no user owner; it must never be offered.
              device(leased, "Leased emulator", "android", null),
            ],
          };
        else if (path === "hosts")
          result = {
            hosts: [
              {
                id: "h1",
                name: "Studio",
                online: true,
                enabled: true,
                provider: "android",
                capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 256 },
                reserved: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
              },
            ],
          };
        else if (path === "templates") result = { templates: [] };
        else if (path === "users") result = { users: [adminUser] };
        else if (/^machines\/[0-9a-f-]{36}\/live-views/.test(path)) {
          const [, machineId, , id, action] = path.split("/");
          requests.push({
            method: request.method(),
            path,
            body: request.postDataJSON(),
          });
          result = {
            id: id ?? request.postDataJSON().id,
            machineId,
            generation,
            capability: "live",
            protocol: "canaveral-session-v1",
            state: action === "close" ? "ended" : "pending",
            mediaType: "video/mp4",
            codec: "avc1",
            fps: 30,
            bitRate: 4000000,
            ttlSeconds: 60,
            ...(id && !action
              ? { state: "ended", endReason: "disconnected" }
              : {}),
          };
        }
        await route.fulfill({ json: result });
      });
      await page.goto("/#screens");
      await expect(
        page.getByRole("heading", { name: "Screens", exact: true }),
      ).toBeVisible();
      const offered = page.getByRole("list", { name: "Devices you can watch" });
      await expect(offered.getByRole("listitem")).toHaveCount(2);
      await expect(page.getByText("Leased emulator")).toHaveCount(0);
      // Nothing is captured until someone asks to watch.
      expect(requests).toEqual([]);

      await page.getByRole("button", { name: "Watch Trial phone" }).click();
      const tile = page.getByRole("article", {
        name: "Live screen of Trial phone",
      });
      await expect(tile.getByText("Live", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const video = tile.getByLabel("Screen of Trial phone");
      // The browser decoded the stream: the element reports the encoded picture size.
      expect(
        await video.evaluate((element) => [
          element.videoWidth,
          element.videoHeight,
        ]),
      ).toEqual([64, 112]);
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element.buffered.length
              ? element.buffered.end(element.buffered.length - 1)
              : 0,
          ),
        )
        .toBeGreaterThan(0.9);
      expect(
        await video.evaluate((element) => [element.controls, element.muted]),
      ).toEqual([false, true]);
      expect(requests[0]).toMatchObject({
        method: "POST",
        path: `machines/${android}/live-views`,
        body: { ttlSeconds: 60 },
      });
      // The gateway attached with the session as a bearer credential and nothing of the browser's.
      expect(attachments[0].url).toBe(
        `/v1/machines/${android}/live-views/${requests[0].body.id}/${generation}`,
      );
      expect(attachments[0].authorization).toBe(`Bearer ${token}`);
      expect(attachments[0].cookie).toBeUndefined();
      expect(attachments[0].origin).toBeUndefined();
      expect(attachments[0].received).toEqual([]);

      // A later epoch starts with a new initialization segment on the same source buffer.
      attachments[0].epoch(2);
      await expect
        .poll(() =>
          video.evaluate((element) =>
            element.buffered.length
              ? element.buffered.end(element.buffered.length - 1)
              : 0,
          ),
        )
        .toBeGreaterThan(1.9);
      expect(await video.evaluate((element) => element.error)).toBeNull();

      // A tab in the background stops renewing; coming back renews at once.
      const visibility = (hidden) =>
        page.evaluate((value) => {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }, hidden);
      await visibility(true);
      await visibility(false);
      await expect
        .poll(() => attachments[0].received)
        .toEqual(['{"type":"renew"}']);
      await expect(tile.getByText("Live", { exact: true })).toBeVisible();

      // An iOS host that has not opted in is a state, not an error.
      await page.getByRole("button", { name: "Watch Trial iPhone" }).click();
      const phone = page.getByRole("article", {
        name: "Live screen of Trial iPhone",
      });
      await expect(
        phone.getByText("Not offered", { exact: true }),
      ).toBeVisible();
      await expect(phone.getByRole("status")).toContainText(
        "is not offered by this device's host",
      );
      await expect(phone.getByRole("alert")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(page.url()).toContain(`#screens/${android}+${ios}`);
      if (process.env.CANAVERAL_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.CANAVERAL_SCREENSHOT_DIR}/screens-${width}.png`,
          fullPage: true,
        });

      // Leaving a tile closes its view, so the device's capture can stop.
      await tile
        .getByRole("button", { name: "Stop watching Trial phone" })
        .click();
      await expect(tile).toHaveCount(0);
      await expect
        .poll(() => requests.map((request) => request.path))
        .toContain(
          `machines/${android}/live-views/${requests[0].body.id}/close`,
        );
      expect(errors).toEqual([]);
    } finally {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }
  });
}
