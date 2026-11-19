import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DashboardPreviews, previewIntent } from "../src/dashboard-previews.ts";
import {
  ConsumerClient,
  ConsumerTransportError,
  LeaseClient,
} from "../src/consumer-client.ts";

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
  const leaseExpiry = new Date(Date.now() + 30000).toISOString();
  t.mock.method(app, "inspectLease", async () => ({
    state: "ready",
    expiresAt: leaseExpiry,
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
    "request",
    "state",
  ]);
  manager.handle("owner", "DELETE", id);
  assert.equal(manager.target("owner", id), undefined);
  await delay(1200);
  assert.equal(state(), "stopping");
  cleanup = true;
  await until("stopped");
});

test("build publication waits for verified transfer and release, survives restart, and fences lost launches", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "dashboard-builds-"));
  const config = {
    applicationKeyFile: join(tmp, "key"),
    database: join(tmp, "db"),
    templateId: "linux",
    templateRevision: "1",
    arch: "amd64" as const,
    digest: "sha256:" + "b".repeat(64),
    ttlSeconds: 30,
  };
  writeFileSync(config.applicationKeyFile, "a".repeat(43));
  const open = () =>
    new DashboardPreviews(config, { baseUrl: "https://localhost" });
  let manager = open();
  t.after(() => {
    manager.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  const app = ConsumerClient.prototype,
    client = LeaseClient.prototype;
  t.mock.method(app, "catalogue", async () => ({
    templates: [
      {
        id: "linux",
        revision: "1",
        arch: "amd64",
        digest: config.digest,
        workspaceIOVersion: 1,
      },
    ],
  }));
  t.mock.method(app, "submitRequest", async () => ({
    request: { state: "admitted" },
  }));
  let clean = false;
  t.mock.method(app, "inspectLease", async () => ({
    state: "ready",
    members: [{ ready: true }],
    cleanup: { state: clean ? "complete" : "pending" },
  }));
  t.mock.method(app, "cancelRequest", async () => ({ state: "admitted" }));
  t.mock.method(app, "rotateLeaseCredential", async () => ({
    credential: "k".repeat(43),
  }));
  const launched = t.mock.method(client, "createOperation", async () => {
    throw new ConsumerTransportError("lost", "connection_failed", {
      outcome: "unknown",
    });
  });
  const result = {
    stdoutBase64: "eA==",
    stderrBase64: "",
    stdoutBytes: 1,
    stderrBytes: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 2,
    truncated: false,
    terminationConfirmed: true,
  };
  t.mock.method(client, "operation", async () => ({
    state: "succeeded",
    result,
  }));
  const paths = new Map<string, string>();
  t.mock.method(
    client,
    "createTransfer",
    async (v: { id: string; path: string }) => paths.set(v.id, v.path),
  );
  const digest = createHash("sha256").update("x").digest("hex");
  t.mock.method(
    client,
    "createTransferStep",
    async (id: string, _step: number, req: { action: string }) => {
      const large = paths.get(id) === "large";
      if (large) assert.equal(req.action, "beginDownload");
      const receipt =
        req.action === "beginDownload"
          ? { bytes: large ? 1048577 : 1 }
          : req.action === "read"
            ? { data: "eA==", offset: 1 }
            : {};
      return { state: "succeeded", receipt };
    },
  );
  t.mock.method(client, "transfer", async (id: string) => ({
    state: "verified",
    bytes: 1,
    sha256: paths.get(id) === "bad" ? "0".repeat(64) : digest,
  }));
  const specs = ["ok", "bad", "large"].map((artifact) => ({
    artifact,
    id: randomUUID(),
    imageId: "default",
    files: [],
    argv: ["make"],
  }));
  function submit(spec: (typeof specs)[number]) {
    return manager.handle("owner", "POST", undefined, spec, true);
  }
  function inspect(id: string) {
    return manager.handle("owner", "GET", id, undefined, true) as {
      state: string;
      result?: unknown;
    };
  }
  async function until(id: string, state: string) {
    for (let i = 0; i < 80 && inspect(id).state !== state; i++)
      await delay(100);
    assert.equal(inspect(id).state, state);
  }
  for (const spec of specs) {
    assert.deepEqual(submit(spec), submit(spec));
    assert.throws(
      () => submit({ ...spec, argv: ["other"] }),
      /another specification/,
    );
    assert.throws(
      () => manager.handle("other", "GET", spec.id, undefined, true),
      /Unknown build/,
    );
  }
  for (const { id } of specs) {
    await until(id, "stopping");
    assert.deepEqual(inspect(id).result, result);
    assert.throws(() => manager.artifact("owner", id), /unavailable/);
  }
  const interrupted = { ...specs[0]!, id: randomUUID() };
  submit(interrupted);
  await until(interrupted.id, "running");
  manager.close();
  manager = open();
  clean = true;
  for (const { id, artifact } of specs) {
    await until(id, artifact === "ok" ? "succeeded" : "failed");
    if (artifact === "ok")
      assert.equal(manager.artifact("owner", id).bytes.toString(), "x");
    else assert.throws(() => manager.artifact("owner", id), /unavailable/);
    assert.throws(() => manager.artifact("other", id), /Unknown build/);
    assert.deepEqual(submit(specs.find((s) => s.id === id)!), inspect(id));
  }
  await until(interrupted.id, "failed");
  const cancelled = { ...specs[0]!, id: randomUUID() };
  submit(cancelled);
  assert.throws(
    () => manager.handle("other", "DELETE", cancelled.id, undefined, true),
    /Unknown build/,
  );
  manager.handle("owner", "DELETE", cancelled.id, undefined, true);
  await until(cancelled.id, "stopped");
  const expired = { ...specs[0]!, id: randomUUID() };
  submit(expired);
  const later = Date.now() + 31000;
  t.mock.method(Date, "now", () => later);
  await until(expired.id, "stopped");
  assert.throws(() => manager.artifact("owner", expired.id), /unavailable/);
  assert.equal(launched.mock.callCount(), 4);
});
