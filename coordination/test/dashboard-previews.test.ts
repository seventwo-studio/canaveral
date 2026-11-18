import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DashboardPreviews, previewIntent } from "../src/dashboard-previews.ts";
import { ConsumerClient, LeaseClient } from "../src/consumer-client.ts";

test("preview specifications reject aliases, collisions, external authority and invalid executable", () => {
  const spec = {
    id: randomUUID(),
    mode: "static",
    files: [{ path: "index.html", data: "" }],
  };
  for (const path of [
    "../x",
    ".canaveral/x",
    "a//b",
    "index.html/a/b",
    "index.html",
  ]) {
    assert.throws(() =>
      previewIntent({ ...spec, files: [...spec.files, { path, data: "" }] }),
    );
  }
  assert.throws(() => previewIntent({ ...spec, applicationKey: "override" }));
  assert.throws(() =>
    previewIntent({ ...spec, mode: "command", argv: [], port: 80 }),
  );
  assert.deepEqual(
    previewIntent({
      ...spec,
      mode: "command",
      argv: ["bun", "app.js"],
      port: 3000,
    }).argv,
    ["bun", "app.js"],
  );
});

test("owner provisions a nested static asset after mkdir, fences access and waits for cleanup", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "workspace-preview-")),
    digest = "sha256:" + "a".repeat(64);
  const config = {
    applicationKeyFile: join(tmp, "key"),
    database: join(tmp, "state"),
    templateId: "test",
    templateRevision: "1",
    arch: "arm64" as const,
    digest,
    ttlSeconds: 30,
  };
  writeFileSync(config.applicationKeyFile, "a".repeat(43));
  const manager = new DashboardPreviews(config, {
    baseUrl: "https://localhost",
  });
  t.after(() => {
    manager.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const app = ConsumerClient.prototype,
    client = LeaseClient.prototype,
    events: string[] = [];
  let cleanup = false;
  t.mock.method(app, "catalogue", async () => ({
    templates: [
      {
        id: "test",
        revision: "1",
        arch: "arm64",
        digest,
        workspaceIOVersion: 1,
      },
    ],
  }));
  t.mock.method(app, "submitRequest", async () => ({
    request: { state: "admitted" },
  }));
  t.mock.method(app, "inspectLease", async () => ({
    state: "ready",
    members: [{ ready: true }],
    cleanup: { state: cleanup ? "complete" : "pending" },
  }));
  t.mock.method(app, "rotateLeaseCredential", async () => ({
    credential: "k".repeat(43),
  }));
  t.mock.method(app, "cancelRequest", async () => ({ state: "admitted" }));
  t.mock.method(
    client,
    "createOperation",
    async (req: { arguments: { argv: string[] } }) => {
      const a = req.arguments.argv;
      events.push(a[0] === "node" ? "mkdir " + a.at(-1) : "launch");
      return { operation: { state: "succeeded" } };
    },
  );
  t.mock.method(client, "operation", async () => ({
    state: "queued",
    previewReady: true,
  }));
  let transfer: Record<string, unknown>;
  t.mock.method(
    client,
    "createTransfer",
    async (intent: Record<string, unknown>) => {
      transfer = intent;
      events.push(String(intent.path));
    },
  );
  t.mock.method(client, "createTransferStep", async () => ({
    state: "succeeded",
    receipt: { offset: 1 },
  }));
  t.mock.method(client, "transfer", async () => ({
    ...transfer,
    state: "committed",
    durable: true,
  }));
  const id = randomUUID(),
    body = {
      id,
      mode: "static",
      files: [
        { path: "index.html", data: "eA==" },
        { path: "assets/icons/x.png", data: "eA==" },
      ],
    };
  const start = () => manager.handle("owner", "POST", undefined, body);
  assert.deepEqual(start(), start());
  assert.throws(() => manager.handle("other", "GET", id), /Unknown preview/);
  assert.deepEqual(manager.handle("other", "GET"), { previews: [] });
  assert.throws(
    () =>
      manager.handle("owner", "POST", undefined, {
        ...body,
        files: body.files.slice(0, 1),
      }),
    /another specification/,
  );
  const state = () =>
    (manager.handle("owner", "GET", id) as { state: string }).state;
  async function until(wanted: string) {
    for (let i = 0; i < 60 && state() !== wanted; i++) await delay(100);
    assert.equal(state(), wanted);
  }
  await until("ready");
  assert.deepEqual(events, [
    "mkdir assets/icons",
    "index.html",
    "assets/icons/x.png",
    "launch",
  ]);
  assert.ok(manager.target("owner", id));
  assert.equal(manager.target("other", id), undefined);
  assert.deepEqual(Object.keys(manager.handle("owner", "GET", id)).sort(), [
    "expiresAt",
    "id",
    "mode",
    "state",
  ]);
  manager.handle("owner", "DELETE", id);
  assert.equal(manager.target("owner", id), undefined);
  await delay(1200);
  assert.equal(state(), "stopping");
  cleanup = true;
  await until("stopped");
});
