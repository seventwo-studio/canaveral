import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliClient } from "../../src/account-cli.ts";
import { main } from "../../src/cli.ts";
import { startController } from "../../src/main.ts";

/** Disposable loopback controller only: this proves no native host/runtime acceptance. */
test("account CLI login, scoped token mint/revoke, invitation and password recovery against real controller", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "canaveral-cli-controller-"));
  const operator = randomBytes(32).toString("base64url"), operatorFile = join(root, "operator"), passwordFile = join(root, "password");
  const password = "private-cli-integration-password";
  await fs.writeFile(operatorFile, operator, { mode: 0o600 }); await fs.writeFile(passwordFile, password, { mode: 0o600 });
  const service = await startController({ statePath: join(root, "db"), adminTokenFile: operatorFile, controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  const url = `http://127.0.0.1:${service.address.port}`;
  const client = new CliClient(url, operator);
  async function cli(file: string | undefined, args: string[]) {
    let stdout = "", stderr = "";
    const status = await main(["--url", url, ...(file ? ["--token-file", file] : []), ...args], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
    assert.equal(status, 0, stderr); assert.ok(!(stdout + stderr).includes(password)); return stdout;
  }
  try {
    await cli(operatorFile, ["admin", "create", "--password-file", passwordFile]);
    const adminSession = join(root, "admin.session");
    await cli(undefined, ["login", "--username", "admin", "--password-file", passwordFile, "--output-file", adminSession]);
    const id = randomUUID();
    await cli(adminSession, ["users", "create", "--username", "alice", "--request-id", id]);
    const linkFile = join(root, "alice.link");
    const invitationOutput = await cli(adminSession, ["users", "invite", id, "--dashboard-url", "https://dashboard.example", "--output-file", linkFile]);
    const claim = new URL((await fs.readFile(linkFile, "utf8")).trim()).hash.slice("#claim=".length);
    assert.ok(!invitationOutput.includes(claim));
    await new CliClient(url, "").request("POST", "/v1/auth/claim", { token: claim, password });
    const session = join(root, "alice.session");
    const loginOutput = await cli(undefined, ["login", "--username", "alice", "--password-file", passwordFile, "--output-file", session]);
    const aliceSession = (await fs.readFile(session, "utf8")).trim(); assert.ok(!loginOutput.includes(aliceSession));
    const tokenId = randomUUID(), tokenFile = join(root, "inventory.token");
    const tokenOutput = await cli(session, ["tokens", "create", "--name", "inventory", "--scope", "machines:read", "--request-id", tokenId, "--output-file", tokenFile]);
    const inventoryToken = (await fs.readFile(tokenFile, "utf8")).trim(); assert.ok(!tokenOutput.includes(inventoryToken));
    const inventory = new CliClient(url, inventoryToken);
    assert.deepEqual((await inventory.request("GET", "/v1/machines")).machines, []);
    await assert.rejects(inventory.request("GET", "/v1/users"), /HTTP 403/);
    const listed = JSON.parse(await cli(session, ["tokens"])) as { tokens: Array<{ id: string; token?: string }> };
    assert.equal(listed.tokens[0]!.id, tokenId); assert.equal(listed.tokens[0]!.token, undefined);
    await cli(session, ["tokens", "revoke", tokenId]);
    await assert.rejects(inventory.request("GET", "/v1/machines"), /HTTP 401/);
    const next = join(root, "new-password"); await fs.writeFile(next, "new-private-cli-password", { mode: 0o600 });
    await cli(session, ["account", "password", "--current-password-file", passwordFile, "--password-file", next]);
    await assert.rejects(fs.stat(session));
    await assert.rejects(new CliClient(url, aliceSession).request("GET", "/v1/auth/session"), /HTTP 401/);
    await cli(undefined, ["login", "--username", "alice", "--password-file", next, "--output-file", session]);
    const refreshed = new CliClient(url, (await fs.readFile(session, "utf8")).trim());
    assert.equal(((await refreshed.request("GET", "/v1/auth/session")).user as { id: string }).id, id);
    await cli(session, ["logout"]); await assert.rejects(fs.stat(session));
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
