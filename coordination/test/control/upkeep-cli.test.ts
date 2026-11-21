import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RequestClient } from "../../src/account-cli.ts";
import { main } from "../../src/cli.ts";
import { startController } from "../../src/main.ts";
import { DEFAULT_PRESSURE, PressureMonitor } from "../../src/pressure.ts";
import type { MemoryLevel } from "../../src/pressure.ts";

const key = () => randomBytes(32).toString("base64url");
type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
/** The CLI against a recording client: what each command sends, and what it refuses to send. */
async function cli(args: string[], reply: Record<string, unknown> = { ok: true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-upkeep-cli-"))), token = join(root, "operator");
  writeFileSync(token, key(), { mode: 0o600 });
  const calls: Call[] = []; let stdout = "", stderr = "";
  try {
    const status = await main(["--token-file", token, ...args], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      client: (): RequestClient => ({ request: async (method: string, path: string, body?: Record<string, unknown>) => { calls.push({ method, path, body }); return reply; } }) as RequestClient });
    return { status, stdout, stderr, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("runtime and upkeep commands send explicit, UUID-keyed requests", async () => {
  const host = randomUUID(), request = randomUUID(), inspection = randomUUID(), image = "system-images;android-36;google_apis;arm64-v8a";
  assert.deepEqual((await cli(["runtimes", "show", host])).calls, [{ method: "GET", path: `/v1/hosts/${host}/runtimes`, body: undefined }]);
  // A listing may take a generated UUID, printed for the operator; nothing else is implied.
  const listed = await cli(["runtimes", "list", host, "--platform", "ios"]);
  const generated = /^Operation UUID ([0-9a-f-]{36})\n$/.exec(listed.stderr)?.[1];
  assert.ok(generated);
  assert.deepEqual(listed.calls, [{ method: "POST", path: `/v1/hosts/${host}/operations`, body: { id: generated, kind: "runtime-list", arguments: { platform: "ios" } } }]);
  // The Android licence acknowledgement is sent only when the operator typed its flag.
  const plain = await cli(["runtimes", "install", host, "--platform", "android", "--identifier", image, "--request-id", request]);
  assert.deepEqual(plain.calls[0]!.body, { id: request, kind: "runtime-install", arguments: { platform: "android", identifier: image } });
  const acknowledged = await cli(["runtimes", "install", host, "--platform", "android", "--identifier", image, "--request-id", request, "--accept-android-licenses", "--timeout-seconds", "1800"]);
  assert.deepEqual(acknowledged.calls[0]!.body, { id: request, kind: "runtime-install", arguments: { platform: "android", identifier: image, timeoutSeconds: 1800, acceptLicenses: true } });
  assert.deepEqual((await cli(["runtimes", "remove", host, "--platform", "android", "--identifier", image, "--request-id", request])).calls[0]!.body,
    { id: request, kind: "runtime-remove", arguments: { platform: "android", identifier: image } });
  // A change needs a UUID the operator saved; none is invented for it.
  for (const missing of [["runtimes", "install", host, "--platform", "android", "--identifier", image], ["runtimes", "remove", host, "--platform", "android", "--identifier", image],
    ["upkeep", "purge", host, "--inspection", inspection, "--entry", randomUUID()], ["runtimes", "list", host], ["runtimes", "list", host, "--platform", "tvos"], ["runtimes", "install", host, "--platform", "android", "--request-id", request],
    ["runtimes", host], ["upkeep", "purge", host, "--inspection", inspection, "--request-id", request], ["runtimes", "install", host, "--platform", "android", "--identifier", image, "--request-id", request, "--timeout-seconds", "5"]]) {
    const refused = await cli(missing);
    assert.equal(refused.status, 1, missing.join(" ")); assert.deepEqual(refused.calls, []);
  }
  assert.deepEqual((await cli(["upkeep", "status", host])).calls, [{ method: "GET", path: `/v1/hosts/${host}/upkeep`, body: undefined }]);
  assert.equal((await cli(["upkeep", "status", host, "--idle-stop-seconds", "600"])).calls[0]!.path, `/v1/hosts/${host}/upkeep?idleStopSeconds=600`);
  assert.equal((await cli(["upkeep", "status", host, "--idle-stop-seconds", "10"])).status, 1);
  const inspected = await cli(["upkeep", "inspect", host, "--request-id", request]);
  assert.deepEqual(inspected.calls[0]!.body, { id: request, kind: "storage-inspect", arguments: {} });
  const first = randomUUID(), second = `.removing-${randomUUID()}-${randomUUID()}`;
  const purged = await cli(["upkeep", "purge", host, "--inspection", inspection, "--entry", first, "--entry", second, "--request-id", request]);
  assert.deepEqual(purged.calls, [{ method: "POST", path: `/v1/hosts/${host}/operations`, body: { id: request, kind: "storage-purge", arguments: { inspection, entries: [first, second] } } }]);
  assert.deepEqual((await cli(["host-operation", request])).calls, [{ method: "GET", path: `/v1/host-operations/${request}`, body: undefined }]);
  const help = (await cli(["--help"])).stdout;
  for (const text of ["runtimes install HOST", "--accept-android-licenses", "upkeep purge HOST", "never downloads", "pressure"]) assert.ok(help.includes(text), text);
});

test("through the real controller: other credentials are refused, hosts show pressure and a waiting request names it", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-upkeep-http-")));
  const admin = key(), enrollment = key();
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  t.after(async () => { await controller.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${controller.address.port}`;
  const api = async (method: string, route: string, body?: unknown, token = admin): Promise<{ status: number; body: any }> => {
    const response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  // A stand-in Android host speaking the host protocol: no runner, SDK or device is involved.
  const host = randomUUID(), hostToken = key(), systemImage = "system-images;android-35;google_apis;arm64-v8a";
  const image = { id: "phone", revision: "1", arch: "arm64", os: "android", mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage, profile: "pixel_8" } };
  const offer = { name: "upkeep http fixture", provider: "android", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 16 }, templates: [image], leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch: "arm64", runtime: "android" }] };
  assert.equal((await api("POST", "/v1/hosts/enroll", { id: host, credential: hostToken, offer }, enrollment)).status, 200);
  let sample = 0;
  const pressure = (level: MemoryLevel) => new PressureMonitor({ ...DEFAULT_PRESSURE, enterSeconds: 0, clearSeconds: 0 }).observe({ memory: { source: "darwin-pressure-level", level }, disk: { freeGiB: 100, totalGiB: 500 } }, 0, Date.now() / 1000 + ++sample);
  const beat = async (level: MemoryLevel, extra: Record<string, unknown> = {}) => {
    const reply = await api("POST", `/v1/hosts/${host}/heartbeat`, { offer, pressure: pressure(level), upkeep: { version: 1, platforms: ["android"], idleStop: { defaultSeconds: null, templates: {} }, busy: [] }, ...extra }, hostToken);
    assert.equal(reply.status, 200, JSON.stringify(reply.body)); return reply.body;
  };
  await beat("normal");
  const application = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: [{ id: "phone", revision: "1", arch: "arm64" }],
    limits: { resources: { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, activeLeases: 4, defaultTTLSeconds: 300, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120 } });
  const appKey = application.body.credential as string;
  const lease = await api("POST", "/v1/leases", { id: randomUUID(), templateId: "phone", templateRevision: "1", arch: "arm64" }, appKey);
  assert.equal(lease.status, 201, JSON.stringify(lease.body));
  const leased = lease.body.members[0].machineId as string;
  await beat("normal", { reports: { [leased]: { state: "running", accessReady: true } } });
  const leaseKey = (await api("POST", `/v1/leases/${lease.body.id}/credential`, {}, appKey)).body.credential as string;
  assert.match(leaseKey, /^[A-Za-z0-9_-]{43,}$/);

  // Application, lease, enrollment and host credentials, and an unknown one, reach none of the routes.
  const operation = { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } };
  for (const credential of [appKey, leaseKey, enrollment, hostToken, key()]) {
    for (const [method, route, body] of [["GET", `/v1/hosts/${host}/runtimes`], ["GET", `/v1/hosts/${host}/upkeep`], ["GET", `/v1/hosts/${host}/operations`], ["GET", `/v1/host-operations/${operation.id}`],
      ["POST", `/v1/hosts/${host}/operations`, operation]] as [string, string, unknown?][]) assert.equal((await api(method, route, body, credential)).status, 401, `${method} ${route}`);
  }
  assert.deepEqual((await api("GET", `/v1/hosts/${host}/operations`)).body.operations, []);

  // The operator's listing travels out on the host's next heartbeat and its result comes back the same way.
  assert.equal((await api("POST", `/v1/hosts/${host}/operations`, operation)).status, 201);
  assert.deepEqual((await beat("normal", { reports: { [leased]: { state: "running", accessReady: true } } })).hostOperations.map((entry: any) => [entry.id, entry.kind, entry.arguments]), [[operation.id, "runtime-list", { platform: "android" }]]);
  await beat("normal", { reports: { [leased]: { state: "running", accessReady: true } }, hostOperationReports: { [operation.id]: { state: "succeeded", result: { platform: "android", installed: [{ identifier: systemImage, compatible: true, devices: 1 }], available: { state: "unavailable" } } } } });
  const adminFile = join(root, "admin"), run = async (...args: string[]) => {
    let stdout = "", stderr = "";
    const status = await main(["--url", url, "--token-file", adminFile, ...args], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    return { status, stdout, stderr };
  };
  const shown = JSON.parse((await run("runtimes", "show", host)).stdout);
  assert.deepEqual(shown.platforms[0].installed[0].usedBy.templates, [{ id: "phone", revision: "1", arch: "arm64", offered: true }]);
  assert.deepEqual(shown.platforms[0].installed[0].usedBy.machines.map((machine: any) => [machine.id, machine.leased]), [[leased, true]]);
  assert.equal(JSON.parse((await run("host-operation", operation.id)).stdout).state, "succeeded");
  // An unacknowledged Android install is refused with its own code; an image a live lease uses cannot be removed.
  const unacknowledged = await api("POST", `/v1/hosts/${host}/operations`, { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: "system-images;android-36;google_apis;arm64-v8a" } });
  assert.deepEqual([unacknowledged.status, unacknowledged.body.code], [400, "license_acknowledgement_required"]);
  assert.match(unacknowledged.body.error, /licence acknowledgement/);
  assert.equal((await run("runtimes", "install", host, "--platform", "android", "--identifier", "system-images;android-36;google_apis;arm64-v8a", "--request-id", randomUUID())).status, 1);
  const inUse = await api("POST", `/v1/hosts/${host}/operations`, { id: randomUUID(), kind: "runtime-remove", arguments: { platform: "android", identifier: systemImage } });
  assert.deepEqual([inUse.status, inUse.body.code], [409, "runtime_in_use"]);
  const preview = JSON.parse((await run("upkeep", "status", host, "--idle-stop-seconds", "600")).stdout);
  assert.deepEqual([preview.idleStop.previewSeconds, preview.idleStop.devices[0].machineId, preview.idleStop.devices[0].reason], [600, leased, "leased"]);

  // Pressure is shown wherever host health is: the host list, through the CLI too.
  const view = async () => JSON.parse((await run("hosts")).stdout).hosts[0];
  assert.deepEqual([(await view()).pressure.state, (await view()).placementReady, (await view()).health], ["normal", true, null]);
  await beat("critical", { reports: { [leased]: { state: "running", accessReady: true } } });
  const pressured = await view();
  assert.deepEqual([pressured.pressure.state, pressured.pressure.placementBlocked, pressured.pressure.reasons, pressured.pressure.memory.level, pressured.placementReady], ["pressured", true, ["memory"], "critical", false]);
  // New work waits with a reason that names the pressure; the lease already running is untouched.
  const direct = await api("POST", "/v1/leases", { id: randomUUID(), templateId: "phone", templateRevision: "1", arch: "arm64" }, appKey);
  assert.deepEqual([direct.status, direct.body.code, direct.body.retryable], [503, "host_pressure", true]);
  assert.match(direct.body.error, /memory or disk pressure/);
  const waiting = { id: randomUUID(), kind: "lease", intent: { templateId: "phone", templateRevision: "1", arch: "arm64" } };
  const submitted = await api("POST", "/v1/requests", waiting, appKey);
  assert.deepEqual([submitted.status, submitted.body.state, submitted.body.reason], [201, "waiting", "host_pressure"]);
  assert.equal((await api("GET", `/v1/leases/${lease.body.id}`, undefined, appKey)).body.state, "ready");
  await beat("normal", { reports: { [leased]: { state: "running", accessReady: true } } });
  let admitted: any;
  // The controller's own pass admits it once the host reports normal pressure again.
  for (let attempt = 0; attempt < 100 && admitted?.state !== "admitted"; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); admitted = (await api("GET", `/v1/requests/${waiting.id}`, undefined, appKey)).body; }
  assert.deepEqual([admitted.state, admitted.reason], ["admitted", null]);
});
