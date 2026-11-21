import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { McpClient, PNG, agentFixture, cli, sleep, until } from "./agent-fixture.ts";
import type { Fixture } from "./agent-fixture.ts";

/** `canaveral mcp` driven over its stdio pipes against a real loopback controller and a scripted
 * host (see agent-fixture.ts). No HostRunner, emulator or MCP client product is involved. */
const skip = process.platform === "win32" ? "relies on POSIX signals and private file modes" : false;
const leaseState = async (f: Fixture, key: string, id: string) => (await f.api("GET", `/v1/leases/${id}`, undefined, key)).body.state as string;
const requestState = async (f: Fixture, key: string, id: string) => (await f.api("GET", `/v1/requests/${id}`, undefined, key)).body.state as string;

test("MCP handshake, tool and resource listing, and JSON-RPC errors", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), client = new McpClient(f.url, app.keyFile, t);
  // Only initialize and ping are served before the handshake.
  assert.deepEqual(await client.request("ping"), {});
  assert.equal((await client.send("tools/list").reply).error.code, -32002);
  const hello = await client.initialize();
  assert.equal(hello.protocolVersion, "2025-06-18"); assert.equal(hello.serverInfo.name, "canaveral");
  assert.deepEqual(Object.keys(hello.capabilities).sort(), ["logging", "resources", "tools"]);
  assert.match(hello.instructions, /always release/);
  const tools = (await client.request("tools/list")).tools as any[];
  assert.deepEqual(tools.map(tool => tool.name), ["list_device_templates", "lease_device", "lease_status", "device_action", "install_app", "release_device"]);
  for (const tool of tools) { assert.equal(tool.inputSchema.type, "object"); assert.ok(tool.description.length > 20); }
  const resources = (await client.request("resources/list")).resources as any[];
  assert.deepEqual(resources.map(resource => resource.uri), ["canaveral://instructions"]);
  const rules = (await client.request("resources/read", { uri: "canaveral://instructions" })).contents[0];
  assert.equal(rules.mimeType, "text/markdown");
  for (const rule of ["Lease before you touch a device", "Hold only what the task needs", "Keep the lease renewed", "Always release", "Never touch a device you do not hold", "Treat `unknown` as unknown"]) assert.ok(rules.text.includes(rule), rule);
  assert.equal((await client.send("resources/read", { uri: "canaveral://other" }).reply).error.code, -32002);
  assert.deepEqual(await client.request("logging/setLevel", { level: "warning" }), {});
  assert.equal((await client.send("logging/setLevel", { level: "loud" }).reply).error.code, -32602);
  assert.equal((await client.send("prompts/list").reply).error.code, -32601);
  assert.equal((await client.send("tools/call", { name: "unlisted" }).reply).error.code, -32602);
  // Malformed input gets an error reply with a null id and the session keeps serving.
  const before = client.replies.length;
  client.raw("{not json"); client.raw("[]"); client.raw(JSON.stringify({ jsonrpc: "1.0", id: 99, method: "ping" }));
  await until(() => client.replies.length === before + 3, "error replies");
  assert.deepEqual(client.replies.slice(before).map(reply => [reply.id, reply.error.code]), [[null, -32700], [null, -32600], [null, -32600]]);
  // Tool-level mistakes are tool results the model can read, not protocol errors.
  const invalid = await client.call("lease_device", { templateId: f.image.id, colour: "blue" });
  assert.equal(invalid.isError, true); assert.equal(invalid.json.error.code, "invalid_arguments");
  const unheld = await client.call("device_action", { action: "tap", arguments: { x: 1, y: 1 } });
  assert.equal(unheld.isError, true); assert.equal(unheld.json.error.code, "lease_not_held");
  const foreign = await client.call("device_action", { leaseId: randomUUID(), action: "screenshot" });
  assert.equal(foreign.json.error.code, "lease_not_held");
  assert.equal(f.dispatched.length, 0);
  assert.equal(await client.disconnect(), 0);
  for (const secret of [app.key, f.admin]) assert.ok(!client.stderr.includes(secret));
});

test("a lease waits in the queue, is granted with progress, drives its own device and is released on stdin close", { skip, timeout: 120000 }, async t => {
  const f = await agentFixture(t), app = await f.application();
  const a = new McpClient(f.url, app.keyFile, t), b = new McpClient(f.url, app.keyFile, t);
  await a.initialize(); await b.initialize();
  const listed = await a.call("list_device_templates");
  assert.deepEqual(listed.json.templates.map((image: any) => [image.templateId, image.os, image.available]), [[f.image.id, "android", true]]);
  assert.equal(listed.json.limits.maxTTLSeconds, 600);
  // The template is the only one offered, so the revision and architecture are resolved for the caller.
  const first = await a.call("lease_device", { templateId: f.image.id, ttlSeconds: 60 }, "a");
  assert.equal(first.isError, false, JSON.stringify(first.json));
  assert.equal(first.json.state, "ready"); assert.equal(first.json.members[0].ready, true); assert.equal(first.json.renewal.automatic, true);
  assert.ok(a.progress("a").some(message => message.includes("booting")), a.progress("a").join("|"));
  assert.equal(a.progress("a").at(-1), "The device is ready.");
  // The request is a durable `lease` request under the lease UUID, tagged with its origin.
  const stored = (await f.api("GET", `/v1/requests/${first.json.leaseId}`, undefined, app.key)).body;
  assert.equal(stored.kind, "lease"); assert.equal(stored.state, "admitted"); assert.equal(stored.source.surface, "mcp"); assert.equal(stored.source.client, "fixture-client");
  assert.ok(stored.deadline !== null);
  // Scoped control through the lease key the session holds: a screenshot is image content.
  const shot = await a.call("device_action", { action: "screenshot" });
  assert.deepEqual(shot.content.map(item => item.type), ["image", "text"]);
  assert.equal(shot.content[0].mimeType, "image/png"); assert.deepEqual(Buffer.from(shot.content[0].data, "base64"), PNG);
  assert.equal(shot.json.state, "succeeded");
  const tap = await a.call("device_action", { leaseId: first.json.leaseId, action: "tap", arguments: { x: 10, y: 20 } });
  assert.equal(tap.json.state, "succeeded"); assert.equal(tap.content[1].text, "ok tap");
  assert.deepEqual(f.dispatched.map(operation => [operation.action, operation.arguments, operation.leaseId]), [["screenshot", {}, first.json.leaseId], ["tap", { x: 10, y: 20 }, first.json.leaseId]]);
  // Arguments are checked before anything is sent, and the reply says what the action expects.
  const bad = await a.call("device_action", { action: "tap", arguments: { x: 10 } });
  assert.equal(bad.isError, true); assert.match(bad.json.error.expects, /x, y/); assert.equal(f.dispatched.length, 2);
  // The other session cannot act on a device it does not hold.
  assert.equal((await b.call("device_action", { leaseId: first.json.leaseId, action: "tap", arguments: { x: 1, y: 1 } })).json.error.code, "lease_not_held");
  assert.equal(f.dispatched.length, 2);
  // B queues while the only device is in use, with progress, and nothing is leased for it.
  const second = randomUUID(), waiting = b.start("lease_device", { templateId: f.image.id, ttlSeconds: 60, requestId: second, source: { task: "fixture" } }, "b");
  await until(() => b.progress("b").some(message => message.startsWith("Waiting for a free device")), "queued progress");
  await sleep(1500);
  assert.equal(await requestState(f, app.key, second), "waiting");
  for (const args of [{}, { leaseId: second }]) assert.deepEqual((await b.call("lease_status", args)).json, { held: [], waiting: [second], ended: [] });
  // A releases; B is admitted to a different, freshly booted device.
  const released = await a.call("release_device", { leaseId: first.json.leaseId });
  assert.equal(released.json.state, "released");
  assert.equal((await a.call("lease_status")).json.held.length, 0);
  assert.equal((await a.call("device_action", { leaseId: first.json.leaseId, action: "tap", arguments: { x: 1, y: 1 } })).json.error.code, "lease_ended");
  const granted = await waiting.reply;
  assert.equal(granted.isError, false, JSON.stringify(granted.json)); assert.equal(granted.json.leaseId, second); assert.equal(granted.json.state, "ready");
  assert.ok(b.progress("b").some(message => message.includes("booting")));
  assert.equal((await f.api("GET", `/v1/requests/${second}`, undefined, app.key)).body.source.task, "fixture");
  assert.equal((await b.call("device_action", { action: "key", arguments: { key: "KEYCODE_HOME" } })).json.state, "succeeded");
  assert.equal(f.dispatched.at(-1)!.leaseId, second);
  // A client that disconnects releases what its session holds.
  assert.equal(await b.disconnect(), 0);
  assert.equal(await leaseState(f, app.key, second), "released");
  assert.match(b.stderr, new RegExp(`lease ${second} released`));
  assert.equal(await a.disconnect(), 0);
  for (const client of [a, b]) assert.ok(!client.stderr.includes(app.key));
});

test("held leases are renewed before expiry; the maximum lifetime and the end of a lease are announced", { skip, timeout: 120000 }, async t => {
  const f = await agentFixture(t, { devices: 2 }), long = await f.application(), capped = await f.application({ defaultTTLSeconds: 6, maxTTLSeconds: 10, maxLifetimeSeconds: 10 });
  const a = new McpClient(f.url, long.keyFile, t), b = new McpClient(f.url, capped.keyFile, t);
  await a.initialize(); await b.initialize();
  const [kept, limited] = await Promise.all([a.call("lease_device", { templateId: f.image.id, ttlSeconds: 6 }), b.call("lease_device", { templateId: f.image.id, ttlSeconds: 6 })]);
  assert.equal(kept.json.state, "ready"); assert.equal(limited.json.state, "ready");
  const granted = Date.parse(kept.json.expiresAt);
  // Well past the original 6-second TTL the first lease is still ready, because the session renewed it.
  await sleep(13000);
  const status = (await a.call("lease_status", { leaseId: kept.json.leaseId })).json.held[0];
  assert.equal(status.state, "ready"); assert.ok(status.renewal.count >= 2, JSON.stringify(status.renewal));
  assert.ok(status.revision > kept.json.revision); assert.ok(Date.parse(status.expiresAt) >= granted + 8000, status.expiresAt);
  assert.equal(status.renewal.lastFailure, null);
  assert.equal((await a.call("device_action", { action: "tap", arguments: { x: 2, y: 2 } })).json.state, "succeeded");
  assert.deepEqual(a.logs(), []);
  // The second application allows ten seconds in total: the session says when renewal stops and when the lease ends.
  await until(() => b.logs("lease_ended").length === 1, "lease-ending notice", 15000);
  const capNotice = b.logs("lease_lifetime_reached")[0];
  assert.equal(capNotice.level, "warning"); assert.equal(capNotice.logger, "canaveral"); assert.equal(capNotice.data.leaseId, limited.json.leaseId);
  assert.deepEqual([b.logs("lease_ended")[0].level, b.logs("lease_ended")[0].data.state], ["warning", "expired"]);
  assert.equal(await leaseState(f, capped.key, limited.json.leaseId), "expired");
  const after = await b.call("device_action", { leaseId: limited.json.leaseId, action: "tap", arguments: { x: 1, y: 1 } });
  assert.equal(after.isError, true); assert.equal(after.json.error.code, "lease_ended");
  assert.deepEqual((await b.call("lease_status")).json.ended.map((lease: any) => [lease.leaseId, lease.state]), [[limited.json.leaseId, "expired"]]);
  assert.equal(await b.disconnect(), 0);
  // SIGTERM releases like a disconnect does.
  a.child.kill("SIGTERM");
  assert.equal(await a.exited, 0);
  assert.equal(await leaseState(f, long.key, kept.json.leaseId), "released");
  assert.match(a.stderr, /SIGTERM; releasing held leases/);
});

test("SIGINT releases every held lease and withdraws a wait", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), client = new McpClient(f.url, app.keyFile, t);
  await client.initialize();
  const held = await client.call("lease_device", { templateId: f.image.id });
  assert.equal(held.json.ttlSeconds, 60, "the application's default TTL applies");
  const queued = randomUUID(), wait = client.start("lease_device", { templateId: f.image.id, requestId: queued }, "q");
  await until(() => client.progress("q").length > 0, "queued progress");
  client.child.kill("SIGINT");
  assert.equal(await client.exited, 0);
  assert.equal(await leaseState(f, app.key, held.json.leaseId), "released");
  assert.equal(await requestState(f, app.key, queued), "cancelled");
  assert.equal(client.replies.some(reply => reply.id === wait.id), false);
});

test("cancelling a tool call withdraws a waiting request and releases one admitted meanwhile", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t, { bootMs: 4000 }), app = await f.application(), holder = new McpClient(f.url, app.keyFile, t), client = new McpClient(f.url, app.keyFile, t);
  await holder.initialize(); await client.initialize();
  // Cancelled while its device boots: the request stays admitted and its lease is released.
  const booting = randomUUID(), early = client.start("lease_device", { templateId: f.image.id, requestId: booting }, "boot");
  await until(() => client.progress("boot").some(message => message.includes("booting")), "booting progress");
  client.notify("notifications/cancelled", { requestId: early.id, reason: "no longer needed" });
  await until(async () => await leaseState(f, app.key, booting) === "released", "release of the admitted lease");
  assert.equal(await requestState(f, app.key, booting), "admitted");
  // Cancelled while queued behind a held device: the request is withdrawn and nothing is leased.
  assert.equal((await holder.call("lease_device", { templateId: f.image.id })).json.state, "ready");
  const queued = randomUUID(), late = client.start("lease_device", { templateId: f.image.id, requestId: queued }, "queue");
  await until(() => client.progress("queue").some(message => message.startsWith("Waiting")), "queued progress");
  client.notify("notifications/cancelled", { requestId: late.id });
  await until(async () => await requestState(f, app.key, queued) === "cancelled", "withdrawn request");
  assert.equal((await f.api("GET", `/v1/leases/${queued}`, undefined, app.key)).status, 404);
  // A cancelled call gets no reply, and the session keeps working.
  await sleep(500);
  assert.deepEqual(await client.request("ping"), {});
  assert.equal(client.replies.some(reply => reply.id === early.id || reply.id === late.id), false);
  assert.deepEqual((await client.call("lease_status")).json, { held: [], waiting: [], ended: [] });
  assert.equal(await client.disconnect(), 0); assert.equal(await holder.disconnect(), 0);
});

test("an unknown outcome is reported as unknown and never replayed", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), client = new McpClient(f.url, app.keyFile, t);
  await client.initialize();
  const lease = (await client.call("lease_device", { templateId: f.image.id })).json.leaseId as string;
  // The host reports that it cannot tell whether the command ran.
  const operationId = randomUUID(), uncertain = { action: "shell", arguments: { argv: ["uncertain", "effect"] }, operationId };
  const first = await client.call("device_action", uncertain);
  assert.equal(first.isError, true);
  assert.deepEqual([first.json.state, first.json.replayed, first.json.operationId, first.json.leaseId], ["unknown", false, operationId, lease]);
  assert.match(first.json.guidance, /may or may not have happened/);
  assert.equal(f.dispatched.filter(operation => operation.id === operationId).length, 1);
  // Reading the receipt again with the identical id and arguments does not run it again.
  const again = await client.call("device_action", uncertain);
  assert.equal(again.json.state, "unknown");
  await sleep(500);
  assert.equal(f.dispatched.filter(operation => operation.id === operationId).length, 1);
  // The same id with other arguments is another request: refused, not executed.
  const conflict = await client.call("device_action", { ...uncertain, arguments: { argv: ["uncertain", "other"] } });
  assert.equal(conflict.isError, true); assert.equal(conflict.json.error.status, 409);
  // A definite failure is a failure, not unknown.
  const failed = await client.call("device_action", { action: "shell", arguments: { argv: ["refuse"] } });
  assert.deepEqual([failed.isError, failed.json.state], [true, "failed"]);
  // An action in flight when the lease ends is unknown too, and the session announces the lost lease.
  const hanging = randomUUID(), inFlight = client.start("device_action", { action: "shell", arguments: { argv: ["hang"] }, operationId: hanging, waitSeconds: 60 });
  await until(() => f.hanging.has(hanging), "an action in flight");
  assert.equal((await f.api("POST", `/v1/leases/${lease}/release`, { id: randomUUID() }, app.key)).status, 200);
  const lost = await inFlight.reply;
  assert.deepEqual([lost.isError, lost.json.state, lost.json.replayed], [true, "unknown", false]);
  await until(() => client.logs("lease_ended").length === 1, "lease-ended notice");
  assert.equal(client.logs("lease_ended")[0].data.state, "released");
  assert.equal((await client.call("device_action", { action: "tap", arguments: { x: 1, y: 1 } })).json.error.code, "lease_not_held");
  assert.equal(f.dispatched.filter(operation => operation.id === hanging).length, 1);
  assert.equal(f.dispatched.length, 3);
  assert.equal(await client.disconnect(), 0);
});

test("install_app uploads a local build through the lease key and installs it once", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t, { scratchGiB: 4 }), app = await f.application(), client = new McpClient(f.url, app.keyFile, t);
  await client.initialize();
  const lease = (await client.call("lease_device", { templateId: f.image.id })).json.leaseId as string;
  // Three 512 KiB chunks.
  const apk = f.file("build.apk", randomBytes(1_300_000)), artifactId = randomUUID(), installId = randomUUID();
  const installed = await client.call("install_app", { file: apk, artifactId, installId }, "install");
  assert.equal(installed.isError, false, JSON.stringify(installed.json));
  assert.deepEqual([installed.json.state, installed.json.bytes, installed.json.uploadReleased, installed.json.leaseId], ["succeeded", 1_300_000, true, lease]);
  assert.deepEqual(client.progress("install"), ["Uploading the build.", "Installing the build."]);
  const delivered = f.dispatched.filter(operation => operation.action === "install-uploaded");
  assert.deepEqual(delivered.map(operation => [operation.id, operation.arguments.artifact]), [[installId, artifactId]]);
  // Repeating the finished install with its ids installs nothing a second time.
  const again = await client.call("install_app", { file: apk, artifactId, installId });
  assert.equal(again.isError, true); assert.equal(f.dispatched.filter(operation => operation.action === "install-uploaded").length, 1);
  const missing = await client.call("install_app", { file: f.root + "/absent.apk" });
  assert.equal(missing.isError, true); assert.equal(missing.json.error.code, "local_file_error");
  assert.equal(await client.disconnect(), 0);
});

test("a wrong or unprotected application key is refused and nothing is leased", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application();
  // A well-formed key the controller does not know.
  const stranger = f.file("stranger.key", randomBytes(32).toString("base64url") + "\n"), client = new McpClient(f.url, stranger, t);
  await client.initialize();
  const listed = await client.call("list_device_templates");
  assert.equal(listed.isError, true); assert.equal(listed.json.error.status, 401);
  const refused = await client.call("lease_device", { templateId: f.image.id });
  assert.equal(refused.isError, true); assert.equal(refused.json.error.status, 401);
  assert.equal(await client.disconnect(), 0);
  assert.deepEqual((await f.api("GET", "/v1/requests", undefined, app.key)).body.requests, []);
  // A key file readable by others, a missing key file and an inline secret never start a session.
  const exposed = f.file("exposed.key", app.key + "\n", 0o644);
  for (const args of [["--url", f.url, "--token-file", exposed, "mcp"], ["--url", f.url, "mcp"], ["--url", f.url, "mcp", "--token", app.key], ["--url", "http://192.0.2.1:8765", "--allow-http", "--token-file", app.keyFile, "mcp"]]) {
    const run = cli(args); run.child.stdin.end();
    assert.equal(await run.exited, 1, args.join(" ")); assert.equal(run.stdout(), ""); assert.ok(!run.stderr().includes(app.key));
  }
  assert.equal(f.dispatched.length, 0);
});
