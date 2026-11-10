import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startController } from "../../src/main.ts";
import type { ControllerConfig } from "../../src/main.ts";

type Json = Record<string, any>;

test("controller workers preserve human ownership, current scopes and revocation across restart", { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-controller-integration-"));
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  const adminTokenFile = join(directory, "admin.token"), enrollmentTokenFile = join(directory, "enrollment.token");
  writeFileSync(adminTokenFile, admin, { mode: 0o600 });
  writeFileSync(enrollmentTokenFile, enrollment, { mode: 0o600 });
  const config: ControllerConfig = { statePath: join(directory, "controller.sqlite"), adminTokenFile, enrollmentTokenFile,
    controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } };
  let controller: Awaited<ReturnType<typeof startController>> | undefined;
  t.after(async () => {
    await controller?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  controller = await startController(config);
  async function call(path: string, token = "", body?: Json, expected = 200): Promise<Json> {
    const response = await fetch(`http://127.0.0.1:${controller!.address.port}${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json() as Json;
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return value;
  }
  const password = "disposable-controller-test-password";
  const administrator = await call("/v1/auth/setup", admin, { username: "administrator", password });
  async function activate(username: string): Promise<Json> {
    const user = await call("/v1/users", administrator.token, { id: randomUUID(), username });
    const claim = await call(`/v1/users/${user.id}/invite`, administrator.token, {});
    return call("/v1/auth/claim", "", { token: claim.token, password });
  }
  const alice = await activate("alice"), bob = await activate("bob");
  const host = randomUUID(), credential = randomBytes(32).toString("base64url");
  const offer = { name: "portable-fixture-only", provider: "libvirt", capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
    templates: [{ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }] };
  await call("/v1/hosts/enroll", enrollment, { id: host, credential, offer });
  const specification = { id: randomUUID(), name: "alice-machine", templateId: "linux", resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const machine = await call("/v1/machines", alice.token, specification);
  assert.equal(machine.ownerId, alice.user.id);
  await call(`/v1/machines/${machine.id}`, bob.token, undefined, 404);
  await call("/v1/machines", bob.token, { ...specification, name: "foreign-replay" }, 404);
  assert.deepEqual((await call("/v1/machines", bob.token)).machines, []);
  const tokenSpec = { id: randomUUID(), name: "read-only", scopes: ["machines:read"] };
  const readOnly = await call("/v1/auth/tokens", alice.token, tokenSpec);
  assert.equal(typeof readOnly.token, "string");
  const replay = await call("/v1/auth/tokens", alice.token, tokenSpec);
  assert.equal(replay.token, undefined);
  assert.equal((await call(`/v1/machines/${machine.id}`, readOnly.token)).id, machine.id);
  await call("/v1/machines", readOnly.token, { ...specification, id: randomUUID() }, 403);
  await call("/v1/auth/tokens", readOnly.token, { ...tokenSpec, id: randomUUID() }, 401);
  await call(`/v1/admin/tokens/${tokenSpec.id}/revoke`, administrator.token, {});
  await call(`/v1/machines/${machine.id}`, readOnly.token, undefined, 401);
  assert.equal((await call(`/v1/machines/${machine.id}`, alice.token)).ownerId, alice.user.id);
  await call(`/v1/users/${alice.user.id}/update`, administrator.token, { status: "disabled" });
  await call(`/v1/machines/${machine.id}`, alice.token, undefined, 401);
  await controller.close();
  controller = undefined;
  controller = await startController(config);
  assert.deepEqual((await call("/v1/machines", bob.token)).machines, []);
  assert.equal((await call(`/v1/machines/${machine.id}`, administrator.token)).ownerId, alice.user.id);
  await call(`/v1/machines/${machine.id}`, readOnly.token, undefined, 401);
});
