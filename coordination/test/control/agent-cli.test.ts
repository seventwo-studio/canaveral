import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { main, parseCli } from "../../src/cli.ts";
import { RULES, skillFile } from "../../src/agent-instructions.ts";
import { CLI, PNG, agentFixture, cli, sleep, until } from "./agent-fixture.ts";
import type { Fixture } from "./agent-fixture.ts";

/** The agent-surface CLI against a real loopback controller and a scripted host (agent-fixture.ts).
 * Held leases run as real child processes so signals, parent exit and a bound PID are real. */
const skip = process.platform === "win32" ? "relies on POSIX signals and private file modes" : false;
async function run(f: Fixture, keyFile: string | undefined, args: string[]) {
  let stdout = "", stderr = "";
  const status = await main(["--url", f.url, ...(keyFile ? ["--token-file", keyFile] : []), ...args], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { status, stdout, stderr };
}
const lease = async (f: Fixture, key: string, id: string) => (await f.api("GET", `/v1/leases/${id}`, undefined, key)).body;
const request = async (f: Fixture, key: string, id: string) => (await f.api("GET", `/v1/requests/${id}`, undefined, key)).body;
function hold(f: Fixture, keyFile: string, args: string[]) { return cli(["--url", f.url, "--token-file", keyFile, "lease", "hold", "--template", f.image.id, ...args]); }
async function grant(held: ReturnType<typeof cli>): Promise<any> {
  await until(() => held.stdout().includes("\n") || held.child.exitCode !== null, "the grant line", 30000);
  assert.ok(held.stdout().includes("\n"), held.stderr());
  return JSON.parse(held.stdout().split("\n")[0]!);
}
function sleeper(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); });
  return child;
}

test("the parser accepts the agent commands and keeps the existing lease forms", () => {
  const id = randomUUID();
  assert.deepEqual([parseCli(["requests"], {}).action, parseCli(["requests", "cancel", id], {}).positionals], ["list", [id]]);
  const held = parseCli(["lease", "hold", "--template", "phone", "--arch", "arm64", "--ttl", "300", "--bind-pid", "42"], {});
  assert.deepEqual([held.action, held.positionals, held.options.template, held.options["bind-pid"]], ["hold", [], "phone", "42"]);
  assert.deepEqual([parseCli(["lease", id, "device", "tap", "--arguments-file", "a.json"], {}).action, parseCli(["lease", id, "device", "tap"], {}).positionals], ["device", [id, "tap"]]);
  assert.deepEqual(parseCli(["lease", id, "device", "--request-file", "saved.json"], {}).positionals, [id]);
  assert.deepEqual([parseCli(["lease", id, "operation", id], {}).action, parseCli(["lease", id, "install", "app.apk", "--keep-upload"], {}).options["keep-upload"]], ["operation", true]);
  // Existing forms are unchanged.
  assert.deepEqual([parseCli(["lease", id], {}).action, parseCli(["lease", id, "renew", "--request-file", "r.json"], {}).action, parseCli(["lease", "--request-file", "r.json", id, "release"], {}).action], ["", "renew", "release"]);
  for (const bad of [["lease", "hold"], ["lease", "hold", "--template", "phone", "--arch", "mips"], ["lease", "hold", "--template", "phone", "--token", "secret"], ["lease", id, "device"], ["lease", id, "device", "tap", "extra"],
    ["lease", id, "operation"], ["lease", id, "install"], ["lease", id, "record"], ["requests", "submit"], ["requests", "show"], ["requests", "purge"], ["mcp", "--key", "secret"], ["setup", "--replace"]]) {
    assert.throws(() => parseCli(bad, {}), bad.join(" "));
  }
});

test("requests list, show, submit and cancel use the application key", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), id = randomUUID(), queued = randomUUID();
  const intent = { templateId: f.image.id, templateRevision: "1", arch: f.image.arch, ttlSeconds: 60 };
  const file = f.file("request.json", JSON.stringify({ id, kind: "lease", intent, source: { repository: "example/app", run: "42" } }));
  const submitted = await run(f, app.keyFile, ["requests", "submit", "--request-file", file]);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.deepEqual([JSON.parse(submitted.stdout).id, JSON.parse(submitted.stdout).source.run], [id, "42"]);
  // The same file replays; the second request waits behind the only device.
  assert.equal((await run(f, app.keyFile, ["requests", "submit", "--request-file", file])).status, 0);
  assert.equal((await run(f, app.keyFile, ["requests", "submit", "--request-file", f.file("queued.json", JSON.stringify({ id: queued, kind: "lease", intent }))])).status, 0);
  await until(async () => (await lease(f, app.key, id)).state === "ready", "a ready lease");
  const shown = JSON.parse((await run(f, app.keyFile, ["requests", "show", id])).stdout);
  assert.deepEqual([shown.state, shown.target], ["admitted", id]);
  const listed = JSON.parse((await run(f, app.keyFile, ["requests"])).stdout);
  assert.deepEqual(listed.requests.map((entry: any) => entry.id).sort(), [id, queued].sort());
  assert.equal(JSON.parse((await run(f, app.keyFile, ["requests", "list", "--after", [id, queued].sort()[0]!])).stdout).requests.length, 1);
  // Cancel withdraws the waiting request and releases the admitted one; repeating it is safe.
  assert.equal(JSON.parse((await run(f, app.keyFile, ["requests", "cancel", queued])).stdout).state, "cancelled");
  for (let i = 0; i < 2; i++) assert.equal(JSON.parse((await run(f, app.keyFile, ["requests", "cancel", id])).stdout).state, "admitted");
  assert.equal((await lease(f, app.key, id)).state, "released");
  const other = await f.application();
  assert.equal((await run(f, other.keyFile, ["requests", "show", id])).status, 1);
  assert.equal((await run(f, undefined, ["requests"])).status, 1);
  assert.ok(!(submitted.stdout + submitted.stderr).includes(app.key));
});

test("a held lease prints one grant line, renews, and releases when its bound PID exits", { skip, timeout: 120000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), bound = sleeper(t), id = randomUUID(), keyFile = join(f.root, "lease.key");
  const source = f.file("source.json", JSON.stringify({ repository: "example/app", run: "17" }));
  const held = hold(f, app.keyFile, ["--revision", "1", "--arch", f.image.arch, "--ttl", "6", "--name", "ci-phone", "--priority", "0", "--wait", "60", "--request-id", id, "--source-file", source, "--lease-key-file", keyFile, "--bind-pid", String(bound.pid)]);
  t.after(() => { held.child.kill("SIGKILL"); });
  const granted = await grant(held);
  assert.deepEqual([granted.leaseId, granted.requestId, granted.state, granted.held, granted.ttlSeconds, granted.leaseKeyFile, granted.member], [id, id, "ready", true, 6, keyFile, "primary"]);
  assert.equal(held.stdout().trim().split("\n").length, 1, "exactly one grant line");
  const stored = await request(f, app.key, id);
  assert.deepEqual([stored.kind, stored.source.run, stored.source.surface, stored.intent.name], ["lease", "17", "cli", "ci-phone"]);
  // The lease key is saved privately, never printed, and it works for this lease only.
  const leaseKey = readFileSync(keyFile, "utf8").trim();
  assert.equal(statSync(keyFile).mode & 0o777, 0o600); assert.ok(!(held.stdout() + held.stderr()).includes(leaseKey));
  const args = f.file("tap.json", JSON.stringify({ x: 3, y: 4 }));
  const tapped = await run(f, undefined, ["lease", id, "device", "tap", "--lease-key-file", keyFile, "--arguments-file", args]);
  assert.equal(tapped.status, 0, tapped.stderr); assert.equal(JSON.parse(tapped.stdout).state, "succeeded");
  // Past the original TTL the lease is still ready: the holder renewed it.
  await sleep(9000);
  const current = await lease(f, app.key, id);
  assert.equal(current.state, "ready"); assert.ok(current.revision > granted.revision); assert.ok(Date.parse(current.expiresAt) > Date.parse(granted.expiresAt));
  assert.equal(held.child.exitCode, null);
  // The bound process exits: the holder releases and exits cleanly.
  bound.kill("SIGKILL");
  assert.equal(await held.exited, 0, held.stderr());
  assert.equal((await lease(f, app.key, id)).state, "released");
  assert.match(held.stderr(), /bound process exit\); lease .* released/);
  assert.ok(!(held.stdout() + held.stderr()).includes(app.key));
});

test("a held lease releases on SIGTERM and on parent exit, and a wait stopped by SIGINT leases nothing", { skip, timeout: 120000 }, async t => {
  const f = await agentFixture(t, { devices: 2 }), app = await f.application();
  const first = hold(f, app.keyFile, ["--ttl", "30"]);
  t.after(() => { first.child.kill("SIGKILL"); });
  const a = await grant(first);
  assert.match(first.stderr(), new RegExp(`Lease request UUID ${a.leaseId}`), "a generated request UUID is announced before use");
  // The second holder is a child of a shell that is then killed: it is re-parented and releases.
  const shell = spawn("/bin/sh", ["-c", '"$0" "$@" & wait', process.execPath, CLI, "--url", f.url, "--token-file", app.keyFile, "lease", "hold", "--template", f.image.id, "--ttl", "30"], { stdio: ["ignore", "pipe", "pipe"] });
  let orphanOutput = "";
  shell.stdout.on("data", (data: Buffer) => { orphanOutput += data.toString("utf8"); });
  await until(() => orphanOutput.includes("\n"), "the second grant line", 30000);
  const b = JSON.parse(orphanOutput.split("\n")[0]!);
  assert.equal((await lease(f, app.key, b.leaseId)).state, "ready");
  // Both devices are held, so a third holder waits. SIGINT withdraws its request.
  const waiting = randomUUID(), third = hold(f, app.keyFile, ["--ttl", "30", "--request-id", waiting]);
  t.after(() => { third.child.kill("SIGKILL"); });
  await until(() => third.stderr().includes("Waiting for a free device"), "a queued holder");
  assert.equal((await request(f, app.key, waiting)).state, "waiting");
  third.child.kill("SIGINT");
  assert.equal(await third.exited, 1); assert.equal(third.stdout(), "");
  assert.equal((await request(f, app.key, waiting)).state, "cancelled");
  shell.kill("SIGKILL");
  await until(async () => (await lease(f, app.key, b.leaseId)).state === "released", "release after parent exit", 15000);
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0, first.stderr());
  assert.equal((await lease(f, app.key, a.leaseId)).state, "released");
  assert.match(first.stderr(), /Stopped \(signal\)/);
});

test("--detach prints the grant and returns; the lease stays until it is cancelled", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t), app = await f.application(), id = randomUUID(), keyFile = join(f.root, "detached.key");
  const detached = await run(f, app.keyFile, ["lease", "hold", "--template", f.image.id, "--ttl", "60", "--request-id", id, "--lease-key-file", keyFile, "--detach"]);
  assert.equal(detached.status, 0, detached.stderr);
  const granted = JSON.parse(detached.stdout);
  assert.deepEqual([granted.leaseId, granted.held, granted.state], [id, false, "ready"]);
  assert.equal((await lease(f, app.key, id)).state, "ready");
  // An existing key file is never replaced, and nothing is leased for the refused command.
  const refused = await run(f, app.keyFile, ["lease", "hold", "--template", f.image.id, "--lease-key-file", keyFile, "--detach"]);
  assert.equal(refused.status, 1); assert.equal(readFileSync(keyFile, "utf8").trim().length, 43);
  assert.equal((await f.api("GET", "/v1/requests", undefined, app.key)).body.requests.length, 1);
  for (const bad of [["--bind-pid", "1", "--detach"], ["--bind-pid", "2147483646"], ["--ttl", "100000"], ["--arch", f.image.arch === "arm64" ? "amd64" : "arm64"]]) {
    const result = await run(f, app.keyFile, ["lease", "hold", "--template", f.image.id, ...bad]);
    assert.equal(result.status, 1, bad.join(" ")); assert.equal(result.stdout, "");
  }
  assert.equal((await f.api("GET", "/v1/requests", undefined, app.key)).body.requests.length, 1);
  assert.equal((await run(f, app.keyFile, ["requests", "cancel", id])).status, 0);
  assert.equal((await lease(f, app.key, id)).state, "released");
});

test("lease-key commands act, save results privately, keep unknown as unknown and refuse a wrong key", { skip, timeout: 60000 }, async t => {
  const f = await agentFixture(t, { devices: 2, scratchGiB: 4 }), app = await f.application(), keyFile = join(f.root, "one.key"), otherFile = join(f.root, "two.key");
  const one = JSON.parse((await run(f, app.keyFile, ["lease", "hold", "--template", f.image.id, "--lease-key-file", keyFile, "--detach"])).stdout).leaseId as string;
  const two = JSON.parse((await run(f, app.keyFile, ["lease", "hold", "--template", f.image.id, "--lease-key-file", otherFile, "--detach"])).stdout).leaseId as string;
  const device = (id: string, key: string, ...args: string[]) => run(f, undefined, ["lease", id, "device", ...args, "--lease-key-file", key]);
  // A screenshot is saved to a private file; stdout carries receipt metadata only.
  const png = join(f.root, "screen.png"), shot = await device(one, keyFile, "screenshot", "--output", png);
  assert.equal(shot.status, 0, shot.stderr);
  assert.deepEqual(readFileSync(png), PNG); assert.equal(statSync(png).mode & 0o777, 0o600);
  assert.deepEqual([JSON.parse(shot.stdout).state, JSON.parse(shot.stdout).result], ["succeeded", { output: png, mediaType: "image/png" }]);
  assert.ok(!shot.stdout.includes(PNG.toString("base64"))); assert.match(shot.stderr, /^Operation UUID [0-9a-f-]{36}\n$/);
  // Without --output the guest's output is not printed.
  const logs = await device(one, keyFile, "logs");
  assert.deepEqual([JSON.parse(logs.stdout).resultOmitted, logs.stdout.includes("ok logs")], [true, false]);
  const text = join(f.root, "logs.txt");
  assert.equal((await device(one, keyFile, "logs", "--output", text)).status, 0); assert.equal(readFileSync(text, "utf8"), "ok logs");
  // A saved request file replays the same operation and never runs it twice.
  const saved = { id: randomUUID(), member: "primary", action: "swipe", arguments: { x: 1, y: 2, toX: 3, toY: 4, durationMs: 200 } }, savedFile = f.file("swipe.json", JSON.stringify(saved));
  for (let i = 0; i < 2; i++) assert.equal(JSON.parse((await device(one, keyFile, "--request-file", savedFile)).stdout).id, saved.id);
  assert.equal(f.dispatched.filter(operation => operation.id === saved.id).length, 1);
  const inspected = await run(f, undefined, ["lease", one, "operation", saved.id, "--lease-key-file", keyFile]);
  assert.deepEqual([inspected.status, JSON.parse(inspected.stdout).state], [0, "succeeded"]);
  // unknown stays unknown: exit 1, said plainly, not repeated.
  const uncertain = randomUUID(), argv = f.file("argv.json", JSON.stringify({ argv: ["uncertain"] }));
  const unknown = await device(one, keyFile, "shell", "--request-id", uncertain, "--arguments-file", argv);
  assert.equal(unknown.status, 1); assert.equal(JSON.parse(unknown.stdout).state, "unknown"); assert.match(unknown.stderr, /outcome=unknown/);
  assert.equal(f.dispatched.filter(operation => operation.id === uncertain).length, 1);
  // The lease key may come from the environment; the application key never works as one.
  process.env.CANAVERAL_LEASE_KEY_FILE = keyFile;
  try { assert.equal((await run(f, undefined, ["lease", one, "device", "apps"])).status, 0); } finally { delete process.env.CANAVERAL_LEASE_KEY_FILE; }
  const dispatched = f.dispatched.length;
  for (const [id, key] of [[one, otherFile], [two, keyFile], [one, app.keyFile], [one, f.file("random.key", randomBytes(32).toString("base64url"))]] as const) {
    const refused = await device(id, key, "tap", "--arguments-file", f.file(`tap-${randomBytes(3).toString("hex")}.json`, JSON.stringify({ x: 1, y: 1 })));
    assert.equal(refused.status, 1); assert.match(refused.stderr, /HTTP 401/);
  }
  assert.equal((await run(f, undefined, ["lease", one, "device", "apps"])).status, 1, "no key file, no action");
  assert.equal((await device(one, f.file("exposed.key", readFileSync(keyFile), 0o644), "apps")).status, 1);
  assert.equal((await device(one, keyFile, "rotate", "--arguments-file", f.file("rotate.json", JSON.stringify({ orientation: "PORTRAIT" })))).status, 1, "not a lease action");
  assert.equal(f.dispatched.length, dispatched);
  // A build is uploaded and installed with the lease key.
  const apk = f.file("build.apk", randomBytes(700_000)), artifact = randomUUID(), install = randomUUID();
  const installed = await run(f, undefined, ["lease", two, "install", apk, "--lease-key-file", otherFile, "--request-id", artifact, "--install-id", install]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual([JSON.parse(installed.stdout).state, JSON.parse(installed.stdout).artifactId, JSON.parse(installed.stdout).bytes, JSON.parse(installed.stdout).uploadReleased], ["succeeded", artifact, 700_000, true]);
  assert.deepEqual(f.dispatched.filter(operation => operation.action === "install-uploaded").map(operation => [operation.id, operation.leaseId]), [[install, two]]);
  for (const output of [shot, logs, unknown, installed]) for (const secret of [app.key, readFileSync(keyFile, "utf8").trim()]) assert.ok(!(output.stdout + output.stderr).includes(secret));
  for (const id of [one, two]) assert.equal((await run(f, app.keyFile, ["requests", "cancel", id])).status, 0);
});

test("instructions prints the rules; setup writes skill files without replacing and prints the registration", { skip, timeout: 30000 }, async t => {
  const f = await agentFixture(t), project = join(f.root, "project");
  mkdirSync(project);
  const rules = await run(f, undefined, ["instructions"]);
  assert.deepEqual([rules.status, rules.stdout], [0, RULES]);
  assert.equal((await run(f, undefined, ["instructions", "--skill"])).stdout, skillFile());
  assert.match(skillFile(), /^---\nname: canaveral-devices\ndescription: .+\n---\n\n# Canaveral devices/);
  const claude = join(project, ".claude/skills/canaveral-devices/SKILL.md"), codex = join(project, ".agents/skills/canaveral-devices/SKILL.md");
  const tokenFile = join(f.root, "application.key");
  const written = await run(f, tokenFile, ["setup", "--project", "--directory", project]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(claude, "utf8"), skillFile()); assert.equal(readFileSync(codex, "utf8"), skillFile());
  // The snippet names the key file, never a key, and the file does not have to exist yet.
  assert.ok(written.stdout.includes(`"CANAVERAL_TOKEN_FILE": "${tokenFile}"`)); assert.ok(written.stdout.includes(`CANAVERAL_URL = "${f.url}"`));
  assert.ok(written.stdout.includes("[mcp_servers.canaveral]")); assert.ok(written.stdout.includes('"args": [\n        "mcp"\n      ]'));
  // An existing file is kept unless --force is given; a refused run writes nothing at all.
  writeFileSync(claude, "edited by hand\n");
  const partial = join(f.root, "partial"); mkdirSync(join(partial, ".agents/skills/canaveral-devices"), { recursive: true }); writeFileSync(join(partial, ".agents/skills/canaveral-devices/SKILL.md"), "mine\n");
  const refused = await run(f, undefined, ["setup", "--project", "--directory", partial]);
  assert.equal(refused.status, 1); assert.equal(existsSync(join(partial, ".claude")), false); assert.equal(readFileSync(join(partial, ".agents/skills/canaveral-devices/SKILL.md"), "utf8"), "mine\n");
  assert.equal((await run(f, undefined, ["setup", "--project", "--directory", project, "--agent", "claude"])).status, 1);
  assert.equal(readFileSync(claude, "utf8"), "edited by hand\n");
  assert.equal((await run(f, undefined, ["setup", "--project", "--directory", project, "--agent", "claude", "--force"])).status, 0);
  assert.equal(readFileSync(claude, "utf8"), skillFile());
  assert.equal((await run(f, undefined, ["setup", "--directory", project])).status, 1, "--directory needs project scope");
  // User scope resolves against the home directory.
  const home = join(f.root, "home"); mkdirSync(home);
  const user = cli(["setup", "--agent", "codex"], { HOME: home }); user.child.stdin.end();
  assert.equal(await user.exited, 0, user.stderr());
  assert.equal(readFileSync(join(home, ".agents/skills/canaveral-devices/SKILL.md"), "utf8"), skillFile());
  assert.equal(existsSync(join(home, ".claude")), false);
});
