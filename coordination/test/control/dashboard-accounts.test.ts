import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

test("disposable account fixture preserves real claim, inventory, scope and revocation assertions", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "canaveral-dashboard-accounts-"));
  const source = fileURLToPath(new URL("../../../dashboard/e2e/serve_accounts.ts", import.meta.url));
  const fixture = existsSync(source) ? source : fileURLToPath(new URL("../../../../dashboard/e2e/serve_accounts.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, CANAVERAL_ACCOUNT_FIXTURE_DIR: root }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const base = "http://127.0.0.1:18768";
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(`Fixture failed to start: ${stderr}`);
      try { const health = await fetch(base + "/healthz", { signal: AbortSignal.timeout(200) }); if (health.ok && existsSync(join(root, "bootstrap.json"))) { ready = true; break; } } catch { /* Listener may not yet be bound. */ }
      await delay(50);
    }
    assert.ok(ready, `Fixture readiness timed out: ${stderr}`);
    const bootstrap = JSON.parse(readFileSync(join(root, "bootstrap.json"), "utf8")) as { token: string; legacyMachine: string };
    async function api(path: string, body?: unknown, credential = "", bearer = false) {
      const response = await fetch(base + "/api" + path, {
        method: body === undefined ? "GET" : "POST", headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }),
          ...(credential ? bearer ? { Authorization: `Bearer ${credential}` } : { Cookie: credential } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
    }
    const info = await api("/v1/auth/claim/info", { token: bootstrap.token });
    assert.equal(info.status, 200); assert.equal(info.headers.get("set-cookie"), null);
    const claimed = await api("/v1/auth/claim", { token: bootstrap.token, username: "admin", password: "disposable admin password" });
    assert.equal(claimed.status, 200); assert.equal(claimed.body.token, undefined);
    const admin = claimed.headers.get("set-cookie")!.split(";", 1)[0]!;
    const inventory = await api("/v1/machines", undefined, admin);
    assert.equal(inventory.status, 200);
    assert.equal((inventory.body.machines as { id: string }[])[0]!.id, bootstrap.legacyMachine);
    const replay = await api("/v1/auth/claim", { token: bootstrap.token, username: "other", password: "disposable admin password" });
    assert.equal(replay.status, 401);
    const aliceRecord = await api("/v1/users", { id: randomUUID(), username: "alice" }, admin);
    assert.equal(aliceRecord.status, 200);
    const aliceId = aliceRecord.body.id as string;
    const invitation = await api(`/v1/users/${aliceId}/invite`, {}, admin);
    assert.equal(invitation.status, 200);
    const aliceClaim = await api("/v1/auth/claim", { token: invitation.body.token, password: "disposable alice password" });
    assert.equal(aliceClaim.status, 200);
    const alice = aliceClaim.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.deepEqual((await api("/v1/machines", undefined, alice)).body.machines, []);
    assert.equal((await api("/v1/hosts", undefined, alice)).status, 403);
    const made = await api("/v1/machines", { id: randomUUID(), name: "Alice private machine", templateId: "linux", resources: {} }, alice);
    assert.equal(made.status, 200); assert.equal(made.body.ownerId, aliceId);
    const machineId = made.body.id as string;
    assert.equal((await api(`/v1/machines/${bootstrap.legacyMachine}`, undefined, alice)).status, 404);
    for (const suffix of ["desktop", "accessibility", `shells/${randomUUID()}/stream`, "files/download/" + Buffer.from(JSON.stringify({ path: "/private" })).toString("base64url")]) {
      assert.equal((await api(`/v1/machines/${bootstrap.legacyMachine}/${suffix}`, undefined, alice)).status, 404);
    }
    assert.equal((await api(`/v1/machines/${machineId}/desktop`, undefined, alice)).status, 409);
    const token = await api("/v1/auth/tokens", { id: randomUUID(), name: "Read only", scopes: ["machines:read"], expiresInSeconds: 60 }, alice);
    assert.equal(token.status, 200); assert.equal(typeof token.body.token, "string");
    const personal = token.body.token as string;
    const ownInventory = await api("/v1/machines", undefined, personal, true);
    assert.equal(ownInventory.status, 200); assert.deepEqual((ownInventory.body.machines as { id: string }[]).map(m => m.id), [machineId]);
    assert.equal((await api("/v1/machines", { id: randomUUID(), name: "Forbidden", templateId: "linux", resources: {} }, personal, true)).status, 403);
    assert.equal((await api(`/v1/machines/${machineId}/desktop`, undefined, personal, true)).status, 403);
    assert.equal((await api("/v1/auth/session", undefined, personal, true)).status, 401);
    const listed = await api("/v1/admin/tokens", undefined, admin);
    assert.equal(listed.status, 200);
    const row = (listed.body.tokens as Record<string, unknown>[]).find(t => t.id === token.body.id)!;
    assert.equal(row.userId, aliceId); assert.equal(row.token, undefined);
    assert.equal((await api(`/v1/admin/tokens/${token.body.id as string}/revoke`, {}, admin)).status, 200);
    assert.equal((await api("/v1/machines", undefined, personal, true)).status, 401);
    assert.equal((await api(`/v1/users/${aliceId}/update`, { status: "disabled" }, admin)).status, 200);
    assert.equal((await api("/v1/machines", undefined, alice)).status, 401);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exit, delay(3000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); })]);
    await exit; rmSync(root, { recursive: true, force: true });
  }
});
