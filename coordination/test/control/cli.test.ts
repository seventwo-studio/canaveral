import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CliClient, CliError, privateOutput } from "../../src/account-cli.ts";
import type { RequestClient } from "../../src/account-cli.ts";
import { main, parseCli, prepareCachedImage } from "../../src/cli.ts";
import type { CliIO, CliRuntime } from "../../src/cli.ts";

const token = () => randomBytes(32).toString("base64url");
type Call = { method: string; path: string; body: Record<string, unknown> | undefined; token: string };
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "canaveral-cli-")));
  const operator = join(root, "operator"), password = join(root, "password");
  await fs.writeFile(operator, token(), { mode: 0o600 }); await fs.writeFile(password, "fixture-password-only\n", { mode: 0o600 });
  const calls: Call[] = []; let reply = async (_call: Call): Promise<Record<string, unknown>> => ({ ok: true });
  let stdout = "", stderr = "";
  async function invoke(args: string[], credential = true, overrides: Partial<CliIO> = {}) {
    stdout = ""; stderr = "";
    const status = await main(["--url", "http://127.0.0.1:8765", ...(credential ? ["--token-file", operator] : []), ...args], {
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      password: async () => { throw new Error("Unexpected prompt"); },
      client: (_url, secret): RequestClient => ({ request: async (method, path, body) => { const call = { method, path, body, token: secret }; calls.push(call); return reply(call); } }), ...overrides,
    });
    return { status, stdout, stderr };
  }
  return { root, operator, password, calls, invoke, setReply: (fn: typeof reply) => { reply = fn; }, close: () => fs.rm(root, { recursive: true, force: true }) };
}
async function withFixture(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) { const f = await fixture(); try { await work(f); } finally { await f.close(); } }
const mint = (path: string, id = randomUUID()) => ["tokens", "create", "--name", "automation", "--scope", "machines:read", "--request-id", id, "--output-file", path];

test("CLI collection defaults and strict parser retain legacy global flag placement", async () => {
  assert.equal(parseCli(["users"], {}).action, "list"); assert.equal(parseCli(["tokens"], {}).action, "list");
  assert.equal(parseCli(["host", "--config", "host.json", "--state", "state", "--ca-file", "ca.pem"], {}).options["ca-file"], "ca.pem");
  assert.throws(() => parseCli(["host", "--config", "one", "--setup-file", "two", "--state", "state"], {}));
  assert.throws(() => parseCli(["machines", "--token", "secret"], {}));
  assert.throws(() => parseCli(["tokens", "create", "--name", "x", "--scope", "wrong", "--request-id", randomUUID(), "--output-file", "new"], {}));
  assert.throws(() => parseCli(["users", "create", "--username", "a", "--request-id", randomUUID(), "--status", "active"], {}));
  await withFixture(async f => { assert.equal((await f.invoke(["users"])).status, 0); assert.equal((await f.invoke(["tokens"])).status, 0); assert.deepEqual(f.calls.map(c => c.path), ["/v1/users", "/v1/auth/tokens"]); });
});
test("init creates 0600 credentials and refuses overwrite or dangling symlinks", async () => withFixture(async f => {
  const directory = join(f.root, "secrets"); assert.equal((await f.invoke(["init", directory], false)).status, 0);
  const before = await fs.readFile(join(directory, "admin.token"), "utf8"); assert.match(before, /^[A-Za-z0-9_-]{43}\n$/);
  assert.notEqual(before, await fs.readFile(join(directory, "enrollment.token"), "utf8"));
  if (process.platform !== "win32") assert.equal((await fs.stat(join(directory, "admin.token"))).mode & 0o777, 0o600);
  const result = await f.invoke(["init", directory], false); assert.equal(result.status, 1); assert.ok(!result.stdout.includes(before.trim()));
  assert.equal(await fs.readFile(join(directory, "admin.token"), "utf8"), before);
  const dangling = join(f.root, "dangling"); await fs.mkdir(dangling); await fs.symlink(join(f.root, "missing"), join(dangling, "enrollment.token"));
  assert.equal((await f.invoke(["init", dangling], false)).status, 1);
  await assert.rejects(fs.stat(join(dangling, "admin.token")));
}));
test("login saves session privately and prints neither password nor issued token", async () => withFixture(async f => {
  const issued = token(); f.setReply(async () => ({ token: issued, user: { username: "alice" }, expiresAt: 1000 }));
  const destination = join(f.root, "alice.session");
  const result = await f.invoke(["login", "--username", "alice", "--password-file", f.password, "--output-file", destination], false);
  assert.equal(result.status, 0); assert.equal(await fs.readFile(destination, "utf8"), issued + "\n");
  if (process.platform !== "win32") assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(issued)); assert.ok(!result.stderr.includes(issued)); assert.ok(!result.stdout.includes("fixture-password-only"));
  assert.ok(result.stdout.includes("credentialFile")); assert.equal(f.calls[0]!.body!.password, "fixture-password-only");
}));
test("existing login output and symlinks are rejected before authentication", async () => withFixture(async f => {
  const before = await fs.readFile(f.operator, "utf8"); const symlink = join(f.root, "link"); await fs.symlink(f.operator, symlink);
  for (const destination of [f.operator, symlink]) assert.equal((await f.invoke(["login", "--username", "alice", "--password-file", f.password, "--output-file", destination], false)).status, 1);
  assert.equal(await fs.readFile(f.operator, "utf8"), before); assert.equal(f.calls.length, 0);
}));
test("failed login file flush revokes newly issued session and removes only reserved output", async () => withFixture(async f => {
  const issued = token(); f.setReply(async () => ({ token: issued, user: { username: "alice" } }));
  const destination = join(f.root, "unwritten.session");
  const result = await f.invoke(["login", "--username", "alice", "--password-file", f.password, "--output-file", destination], false, {
    output: (path, work) => privateOutput(path, async (write, output) => { await work(write, output); throw new Error("fixture disk full"); }),
  });
  assert.equal(result.status, 1); await assert.rejects(fs.stat(destination));
  assert.deepEqual(f.calls.map(c => c.path), ["/v1/auth/login", "/v1/auth/logout"]); assert.equal(f.calls[1]!.token, issued);
  assert.ok(!(result.stdout + result.stderr).includes(issued));
}));
test("mint deduplicates scopes and retains stable request UUID and expiry", async () => withFixture(async f => {
  const id = randomUUID(), issued = token(), destination = join(f.root, "token"); f.setReply(async () => ({ id, token: issued }));
  const result = await f.invoke([...mint(destination, id), "--scope", "machines:read", "--scope", "machines:access"]);
  assert.equal(result.status, 0); assert.equal(await fs.readFile(destination, "utf8"), issued + "\n");
  assert.deepEqual(f.calls[0]!.body, { id, name: "automation", scopes: ["machines:access", "machines:read"], expiresInSeconds: 2592000 });
  assert.ok(!(result.stdout + result.stderr).includes(issued));
}));
test("replayed mint never silently creates a replacement", async () => withFixture(async f => {
  const id = randomUUID(), destination = join(f.root, "lost"); f.setReply(async () => ({ id, name: "automation" }));
  const result = await f.invoke(mint(destination, id)); assert.equal(result.status, 1); assert.match(result.stderr, /already issued/);
  assert.equal(f.calls.length, 1); await assert.rejects(fs.stat(destination)); assert.equal(result.stdout, "");
}));
test("mint save failure revokes only the issued matching token", async () => withFixture(async f => {
  const id = randomUUID(), issued = token(), destination = join(f.root, "unsaved"); f.setReply(async () => ({ id, token: issued }));
  const result = await f.invoke(mint(destination, id), true, { output: (path, work) => privateOutput(path, async (write, output) => { await work(write, output); throw new Error("fixture disk full"); }) });
  assert.equal(result.status, 1); assert.equal(f.calls[1]!.path, `/v1/auth/tokens/${id}/revoke`); await assert.rejects(fs.stat(destination));
  assert.ok(!(result.stdout + result.stderr).includes(issued));
}));
test("unconfirmed mint identity is not treated as a saved or revocable issued token", async () => withFixture(async f => {
  const destination = join(f.root, "mismatched"); f.setReply(async () => ({ id: randomUUID(), token: token() }));
  const result = await f.invoke(mint(destination)); assert.equal(result.status, 1); assert.match(result.stderr, /outcome=unknown/);
  assert.equal(f.calls.length, 1); await assert.rejects(fs.stat(destination));
}));
test("invalid expiry and empty user update have no HTTP side effects", async () => withFixture(async f => {
  assert.equal((await f.invoke([...mint(join(f.root, "invalid")), "--expires-in", "0"])).status, 1);
  assert.equal((await f.invoke(["users", "update", randomUUID()])).status, 1); assert.equal(f.calls.length, 0);
}));
test("logout does not remove an API/operator credential rejected as a session", async () => withFixture(async f => {
  f.setReply(async () => { throw new CliError("Session credential rejected.", 401); });
  assert.equal((await f.invoke(["logout"])).status, 1); await fs.stat(f.operator); assert.equal(f.calls.length, 1);
}));
test("logout revokes a confirmed session before removing its file", async () => withFixture(async f => {
  assert.equal((await f.invoke(["logout"])).status, 0); await assert.rejects(fs.stat(f.operator));
  assert.deepEqual(f.calls.map(c => c.path), ["/v1/auth/session", "/v1/auth/logout"]);
}));
test("password change uses protected input and removes the revoked session file", async () => withFixture(async f => {
  const next = join(f.root, "next"); await fs.writeFile(next, "new-fixture-password", { mode: 0o600 });
  const result = await f.invoke(["account", "password", "--current-password-file", f.password, "--password-file", next]);
  assert.equal(result.status, 0); await assert.rejects(fs.stat(f.operator));
  assert.deepEqual(f.calls[0]!.body, { currentPassword: "fixture-password-only", password: "new-fixture-password" });
  assert.ok(!(result.stdout + result.stderr).includes("fixture-password"));
}));
test("password inputs reject public permissions and symlinks before login", { skip: process.platform === "win32" }, async () => withFixture(async f => {
  await fs.chmod(f.password, 0o644);
  const args = ["login", "--username", "alice", "--password-file", f.password, "--output-file", join(f.root, "session")];
  assert.equal((await f.invoke(args, false)).status, 1); assert.equal(f.calls.length, 0);
  await fs.chmod(f.password, 0o600); const link = join(f.root, "password-link"); await fs.symlink(f.password, link);
  assert.equal((await f.invoke(args.map(s => s === f.password ? link : s), false)).status, 1); assert.equal(f.calls.length, 0);
}));
test("setup and reset claims go only to private fragment link files", async () => withFixture(async f => {
  const issued = token(); f.setReply(async () => ({ kind: "bootstrap", token: issued, expiresAt: 1000 })); const destination = join(f.root, "link");
  const result = await f.invoke(["admin", "setup-link", "--dashboard-url", "https://canaveral.example", "--output-file", destination]);
  assert.equal(result.status, 0); assert.equal(await fs.readFile(destination, "utf8"), `https://canaveral.example/#claim=${issued}\n`);
  assert.ok(!(result.stdout + result.stderr).includes(issued)); assert.equal(f.calls[0]!.path, "/v1/auth/bootstrap");
  const id = randomUUID(); assert.equal((await f.invoke(["admin", "recover", "--user-id", id, "--dashboard-url", "https://canaveral.example", "--output-file", join(f.root, "reset")])).status, 0);
  assert.equal(f.calls[1]!.path, `/v1/users/${id}/reset-password`);
}));
test("remote insecure claim origin is rejected before claim issuance", async () => withFixture(async f => {
  const result = await f.invoke(["admin", "setup-link", "--dashboard-url", "http://canaveral.example", "--output-file", join(f.root, "unsafe")]);
  assert.equal(result.status, 1); assert.equal(f.calls.length, 0);
}));
test("machine and device commands keep stable UUIDs and validate arguments before dispatch", async () => withFixture(async f => {
  const id = randomUUID(); assert.equal((await f.invoke(["create", "test", "--template", "linux-server", "--request-id", id, "--memory-mib", "2048"])).status, 0);
  assert.deepEqual(f.calls[0]!.body, { id, name: "test", templateId: "linux-server", resources: { memoryMiB: 2048 } });
  const args = join(f.root, "args.json"); await fs.writeFile(args, JSON.stringify({ x: -1, y: 2 }));
  assert.equal((await f.invoke(["device", id, "tap", "--arguments-file", args, "--request-id", randomUUID()])).status, 1); assert.equal(f.calls.length, 1);
  assert.equal((await f.invoke(["create", "test", "--template", "linux", "--request-id", "bad"])).status, 1); assert.equal(f.calls.length, 1);
}));
test("operation exports verify base64 and refuse existing output", async () => withFixture(async f => {
  const bytes = Buffer.from([0, 255, 42]), destination = join(f.root, "shot");
  f.setReply(async () => ({ state: "succeeded", result: { data: bytes.toString("base64"), mediaType: "image/png" } }));
  assert.equal((await f.invoke(["operation", randomUUID(), "--output", destination])).status, 0); assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal((await f.invoke(["operation", randomUUID(), "--output", destination])).status, 1); assert.deepEqual(await fs.readFile(destination), bytes);
  f.setReply(async () => ({ state: "succeeded", result: { data: "not-base64" } }));
  assert.equal((await f.invoke(["operation", randomUUID(), "--output", join(f.root, "bad")])).status, 1);
}));
test("legacy serve flags map to explicit config and retain generated controller identity", async () => withFixture(async f => {
  const enrollment = join(f.root, "enrollment"); await fs.writeFile(enrollment, token(), { mode: 0o600 });
  const state = join(f.root, "state", "controller.sqlite3"); const configs: Record<string, unknown>[] = []; const controller = new AbortController(); controller.abort();
  const runtime = { controller: async (config: Record<string, unknown>) => { configs.push(config); return { close() {} }; } } as CliRuntime;
  const args = ["serve", "--database", state, "--admin-token-file", f.operator, "--enrollment-token-file", enrollment];
  assert.equal((await f.invoke(args, false, { runtime, signal: controller.signal })).status, 0);
  assert.equal((await f.invoke(args, false, { runtime, signal: controller.signal })).status, 0);
  assert.equal(configs[0]!.controllerId, configs[1]!.controllerId); assert.equal(configs[0]!.statePath, state);
  assert.deepEqual(configs[0]!.listen, { host: "127.0.0.1", port: 8765 });
  await fs.writeFile(state, "existing"); await fs.unlink(state + ".controller-id");
  assert.equal((await f.invoke(args, false, { runtime, signal: controller.signal })).status, 1); assert.equal(configs.length, 2);
}));
test("host setup check does not enroll or persist configuration", async () => withFixture(async f => {
  const setup = join(f.root, "setup.json"), state = join(f.root, "runner-state");
  await fs.writeFile(setup, JSON.stringify({ schemaVersion: 1, controllerUrl: "https://controller.example", enrollmentToken: token(), config: { name: "host", templates: [] } }));
  const runtime = { checkHost: async (options: Record<string, unknown>) => { assert.equal(options.controllerUrl, "https://controller.example"); return { status: "failed" }; } } as unknown as CliRuntime;
  assert.equal((await f.invoke(["host", "--setup-file", setup, "--state", state, "--check"], false, { runtime })).status, 1);
  await assert.rejects(fs.stat(state)); assert.equal(f.calls.length, 0);
}));
test("local validates ports before state changes and cleans up services in reverse order", async () => withFixture(async f => {
  const root = join(f.root, "local"), calls: string[] = []; const controller = new AbortController(); controller.abort();
  const runtime = {
    controller: async () => { calls.push("api"); return { close() { calls.push("api-close"); } }; },
    dashboard: async () => { calls.push("dashboard"); return { close() { calls.push("dashboard-close"); } }; },
  } as unknown as CliRuntime;
  assert.equal((await f.invoke(["local", "--state", root, "--api-port", "8875", "--dashboard-port", "8875"], false, { runtime, signal: controller.signal })).status, 1);
  await assert.rejects(fs.stat(root));
  assert.equal((await f.invoke(["local", "--state", root], false, { runtime, signal: controller.signal })).status, 0);
  assert.deepEqual(calls, ["api", "dashboard", "dashboard-close", "api-close"]); await assert.rejects(fs.stat(join(root, "local.lock")));
  assert.match(await fs.readFile(join(root, "admin.token"), "utf8"), /^[A-Za-z0-9_-]{43}\n$/);
}));
test("template CLI validates public contract without printing private recipe", async () => withFixture(async f => {
  const path = join(f.root, "template.json"); await fs.writeFile(path, JSON.stringify({ id: "linux", revision: "1", os: "linux", mode: "headless", arch: "arm64", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, prepare: { driver: "cloud-init", commands: ["private-fixture-command"] } }));
  const result = await f.invoke(["template", "validate", path], false); assert.equal(result.status, 0); const value = JSON.parse(result.stdout);
  assert.equal(value.preparationDriver, "cloud-init"); assert.match(value.recipeDigest, /^[a-f0-9]{64}$/); assert.ok(!result.stdout.includes("private-fixture-command"));
}));
test("base cache pins checksums, supports local source symlinks and retains corrupt entries", async () => withFixture(async f => {
  const bytes = Buffer.concat([Buffer.alloc(1_048_576), Buffer.from("fixture-image")]), source = join(f.root, "base.raw"), cache = join(f.root, "cache");
  await fs.writeFile(source, bytes); const alias = join(f.root, "source-link"); await fs.symlink(source, alias);
  const sha256 = createHash("sha256").update(bytes).digest("hex"), spec = { path: alias, format: "raw", sha256 };
  const path = await prepareCachedImage(spec, cache); assert.deepEqual(await fs.readFile(path), bytes);
  assert.equal(await prepareCachedImage(spec, cache), path);
  await fs.writeFile(path, "corrupt"); await assert.rejects(prepareCachedImage(spec, cache), /checksum failed/); assert.equal(await fs.readFile(path, "utf8"), "corrupt");
  await fs.unlink(path); await fs.symlink(source, path); await assert.rejects(prepareCachedImage(spec, cache), /regular file/);
  await fs.unlink(path); await assert.rejects(prepareCachedImage({ ...spec, sha256: "0".repeat(64) }, cache), /checksum failed/);
  assert.equal((await fs.readdir(cache)).length, 0);
}));
test("HTTP client preserves mutation identity through lost and malformed replies without replay", async () => {
  let count = 0; const id = randomUUID();
  const server = createServer((req, res) => { count++; req.resume(); if (count === 1) req.socket.destroy(); else { res.setHeader("Content-Type", "application/json"); res.end("malformed"); } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const client = new CliClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token());
    for (let i = 0; i < 2; i++) await assert.rejects(client.request("POST", "/v1/machines", { id }), (error: unknown) => error instanceof CliError && error.outcome === "unknown" && error.requestId === id);
    assert.equal(count, 2);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
test("HTTP redirects and credential-echo error bodies never forward credentials or leak secret text", async () => {
  const sensitive = token(); let count = 0;
  const server = createServer((req, res) => { count++; req.resume(); if (count === 1) { res.writeHead(307, { Location: "/v1/redirect" }); res.end(); } else { res.writeHead(400); res.end(JSON.stringify({ error: sensitive })); } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const client = new CliClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, sensitive);
    await assert.rejects(client.request("POST", "/v1/auth/login", {}), /redirects/); assert.equal(count, 1);
    await assert.rejects(client.request("POST", "/v1/auth/login", {}), (error: unknown) => error instanceof Error && !error.message.includes(sensitive)); assert.equal(count, 2);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test("application and lease credential outputs reserve before rotation and never retry a lost local save", async () => withFixture(async f => {
  const id = randomUUID(), issued = token(); f.setReply(async () => ({ id, credential: issued }));
  const destination = join(f.root, "app-key");
  let result = await f.invoke(["apps", "credential", id, "--output-file", destination]);
  assert.equal(result.status, 0); assert.equal(await fs.readFile(destination, "utf8"), issued + "\n"); assert.ok(!result.stdout.includes(issued));
  result = await f.invoke(["apps", "credential", id, "--output-file", destination]); assert.equal(result.status, 1); assert.equal(f.calls.length, 1);
  result = await f.invoke(["lease", id, "credential", "--output-file", join(f.root, "lease-key")], true, { output: (path, work) => privateOutput(path, async (write, output) => { await work(write, output); throw new Error("fixture disk full"); }) });
  assert.equal(result.status, 1); assert.match(result.stderr, /outcome=unknown/); assert.ok(!result.stderr.includes("requestId=")); assert.equal(f.calls.length, 2); assert.ok(!(result.stdout + result.stderr).includes(issued));
}));
test("lease acquisition uses the persisted request file and UUID without inventing a replacement", async () => withFixture(async f => {
  const id = randomUUID(), request = join(f.root, "acquire.json"); const value = { id, templateId: "linux", templateRevision: "1", arch: "arm64", ttlSeconds: 600 };
  await fs.writeFile(request, JSON.stringify(value));
  assert.equal((await f.invoke(["leases", "acquire", "--request-file", request])).status, 0);
  assert.deepEqual(f.calls[0]!.body, value); assert.equal(f.calls[0]!.path, "/v1/leases");
}));

test("fresh local Android configuration reaches the host runtime and dashboard receives every connector", async () => withFixture(async f => {
  const sdk = join(f.root, "sdk"), root = join(f.root, "local");
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  await fs.mkdir(join(sdk, "system-images", "android-35", "google_apis", abi), { recursive: true });
  const controller = new AbortController(); controller.abort(); let hostOptions: Record<string, unknown> | undefined, dashboardOptions: Record<string, unknown> | undefined;
  const runtime = {
    controller: async () => ({ close() {} }),
    host: async (options: Record<string, unknown>) => { hostOptions = options; return { close() {} }; },
    dashboard: async (options: Record<string, unknown>) => { dashboardOptions = options; return { close() {} }; },
  } as unknown as CliRuntime;
  const result = await f.invoke(["local", "--state", root, "--android-sdk", sdk], false, { runtime, signal: controller.signal });
  assert.equal(result.status, 0, result.stderr); assert.ok(hostOptions);
  assert.equal((hostOptions.config as Record<string, unknown>).provider, process.platform === "darwin" ? "macos" : "linux");
  const connectors = dashboardOptions!.connectors as Record<string, unknown>;
  assert.deepEqual(Object.keys(connectors).sort(), ["accessibility", "desktop", "download", "imageImport", "shell", "upload"]);
}));

test("local Linux configuration embeds the supplied TypeScript bundle without generating a legacy helper", { skip: process.platform !== "darwin" }, async () => withFixture(async f => {
  const root = join(f.root, "local"); await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(join(root, "desktop_ed25519"), "fixture-private-key", { mode: 0o600 });
  await fs.writeFile(join(root, "desktop_ed25519.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKeyOnly", { mode: 0o644 });
  const manifest = join(f.root, "guest-bundle.json"); await fs.writeFile(manifest, JSON.stringify([{ path: "/opt/canaveral/server.mjs", content: "// fixture bundle; never executed", mode: "0644" }]));
  const controller = new AbortController(); controller.abort();
  const runtime = { controller: async () => ({ close() {} }), host: async () => ({ close() {} }), dashboard: async () => ({ close() {} }) } as unknown as CliRuntime;
  const result = await f.invoke(["local", "--state", root, "--linux-image", join(f.root, "installed.raw"), "--apple-runner", join(f.root, "installed-runner"), "--guest-helper-manifest", manifest], false, { runtime, signal: controller.signal });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await fs.readFile(join(root, "linux-host.json"), "utf8")) as { guestHelperManifest: string; templates: Array<{ prepare: { files: Array<{ path: string; content: string }> } }> };
  assert.equal(config.guestHelperManifest, manifest); assert.ok(config.templates[0]!.prepare.files.some(file => file.path === "/opt/canaveral/server.mjs"));
  assert.ok(JSON.stringify(config).includes("/usr/bin/node"));
}));
