import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, parseCli } from "../../src/cli.ts";
import { controllerFixture, eventually } from "./observability-controller.test.ts";

/** Disposable loopback controller only: this proves no native host or runtime acceptance. */
test("canaveral events, usage and alerts drive the controller with private files and never print a secret", { timeout: 90_000 }, async t => {
  const f = await controllerFixture(t);
  const files = mkdtempSync(join(tmpdir(), "canaveral-observability-cli-")); t.after(() => rmSync(files, { recursive: true, force: true }));
  const file = (name: string, value: string, mode = 0o600) => { const path = join(files, name); writeFileSync(path, value + "\n", { mode }); chmodSync(path, mode); return path; };
  const secret = "cli-signing-secret-with-enough-entropy-0123456789";
  const received: Array<{ headers: http.IncomingHttpHeaders; body: Buffer }> = []; let answer = 204;
  const hook = http.createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", c => chunks.push(c as Buffer)); request.on("end", () => { received.push({ headers: request.headers, body: Buffer.concat(chunks) }); response.writeHead(answer); response.end(); }); });
  hook.listen(0, "127.0.0.1"); await once(hook, "listening");
  t.after(() => new Promise<void>(resolve => { hook.close(() => resolve()); hook.closeAllConnections(); }));
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks/PRIVATE-PATH`;
  const app = await f.application(), other = await f.application();
  const adminFile = file("admin", f.admin), appFile = file("app", app.credential);
  const cli = async (token: string | undefined, args: string[], signal?: AbortSignal) => {
    let stdout = "", stderr = "";
    const status = await main(["--url", f.url(), ...(token ? ["--token-file", token] : []), ...args], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, ...(signal ? { signal } : {}) });
    for (const hidden of [f.admin, app.credential, other.credential, f.hostToken, secret, "PRIVATE-PATH"]) assert.ok(!(stdout + stderr).includes(hidden), hidden);
    return { status, stdout, stderr, lines: stdout.trim().split("\n").filter(Boolean) };
  };
  const lease = await f.acquire(app.credential); await f.acquire(other.credential); await f.ready(lease);

  // events: one JSON object per line, the resume cursor on stderr.
  let run = await cli(adminFile, ["events", "--kind", "lease.*"]);
  assert.equal(run.status, 0, run.stderr);
  const listed = run.lines.map(line => JSON.parse(line));
  assert.deepEqual(listed.map(event => event.kind), ["lease.admitted", "lease.admitted", "lease.ready"]);
  assert.equal(run.stderr, `cursor=${listed.at(-1).sequence}\n`);
  run = await cli(adminFile, ["events", "--kind", "lease.admitted", "--kind", "lease.ready", "--limit", "1"]);
  assert.equal(run.lines.length, 1); assert.match(run.stderr, /^cursor=\d+ more=true\n$/);
  const cursor = Number(/cursor=(\d+)/.exec(run.stderr)![1]);
  run = await cli(adminFile, ["events", "--kind", "lease.*", "--after", String(cursor)]);
  assert.deepEqual(run.lines.map(line => JSON.parse(line).kind), ["lease.admitted", "lease.ready"]);
  run = await cli(adminFile, ["events", "--tail", "1", "--lease", lease.id, "--text"]);
  assert.match(run.stdout, new RegExp(`^ +\\d+ \\S+Z lease\\.ready application=${app.id} lease=${lease.id} host=${f.host} machine=\\S+ ledger=generic state=ready previous=provisioning revision=2\\n$`));
  // --own reads as the application: its own events, no host, and no operator filters.
  run = await cli(appFile, ["events", "--own"]);
  const own = run.lines.map(line => JSON.parse(line));
  assert.ok(own.length >= 3 && own.every(event => event.applicationId === app.id && !("hostId" in event)));
  assert.equal((await cli(appFile, ["events"])).status, 1, "an application credential is not an administrator");
  assert.equal((await cli(adminFile, ["events", "--own"])).status, 1);
  for (const args of [["events", "--own", "--host", f.host], ["events", "--after", "1", "--tail", "2"], ["events", "--kind", "Lease"], ["events", "--limit", "501"], ["events", "--since", "yesterday"], ["events", "--follow", "--tail", "5"],
    ["events", "--unknown"], ["usage", "--format", "xml"], ["usage", "--last", "soon"], ["usage", "--last", "24h", "--from", "2026-01-01T00:00:00Z"], ["usage", "--own", "--group-by", "host"], ["alerts", "bogus"]]) {
    const refused = await cli(args.includes("--own") ? appFile : adminFile, args); assert.equal(refused.status, 1, args.join(" ")); assert.equal(refused.stdout, "");
  }

  // A refusal names its stable code beside the status, so the error catalogue applies from the command line.
  assert.match((await cli(adminFile, ["events", "--kind", "lease.unheard"])).stderr, /^canaveral: Controller request failed \(HTTP 400, event_kind_unknown\)\. Inspect state before retrying\.\n$/);
  assert.match((await cli(appFile, ["usage", "--own", "--from", "2026-01-01T00:00:00Z", "--to", "2028-01-01T00:00:00Z"])).stderr, /HTTP 400, usage_range_invalid/);

  // events --follow streams until interrupted, starting after the cursor it was given.
  const abort = new AbortController(); let followed = "";
  const following = main(["--url", f.url(), "--token-file", adminFile, "events", "--follow", "--kind", "lease.*", "--after", String(listed.at(-1).sequence)], { stdout: text => { followed += text; }, stderr: text => { followed += text; }, signal: abort.signal });
  await new Promise(resolve => setTimeout(resolve, 300));
  const release = randomUUID();
  await f.call("POST", `/v1/leases/${lease.id}/release`, app.credential, { id: release });
  await eventually(() => followed, text => text.includes("lease.released"));
  abort.abort();
  assert.equal(await following, 0);
  const streamed = followed.trim().split("\n");
  assert.deepEqual(streamed.slice(0, -1).map(line => JSON.parse(line).kind), ["lease.released"]);
  assert.equal(streamed.at(-1), `cursor=${JSON.parse(streamed[0]!).sequence}`);

  // usage: the same report as text, JSON and CSV.
  run = await cli(adminFile, ["usage", "--format", "json", "--last", "1h"]);
  const report = JSON.parse(run.stdout);
  assert.equal(report.groupBy, "application"); assert.equal(report.totals.leases.admitted, 2); assert.equal(report.totals.leases.released, 1);
  assert.deepEqual(report.rows.map((row: any) => row.key).sort(), [app.id, other.id].sort());
  run = await cli(adminFile, ["usage", "--format", "csv", "--group-by", "host"]);
  assert.deepEqual(run.stdout.split("\r\n").slice(0, 2).map(line => line.split(",").slice(0, 3).join(",")), ["group,key,label", `host,${f.host},disposable fixture`]);
  run = await cli(adminFile, ["usage", "--group-by", "platform"]);
  assert.match(run.stdout, /^Usage \S+ to \S+ by platform\nplatform +requests .*device-s\nlinux .*\ntotal .*\nRequest records are not pruned\. Lease figures come from the usage ledger, kept 400 days after a lease ends and started \S+\.\n$/);
  run = await cli(appFile, ["usage", "--own", "--format", "json"]);
  assert.equal(JSON.parse(run.stdout).applicationId, app.id); assert.equal(JSON.parse(run.stdout).totals.leases.admitted, 1);
  assert.equal((await cli(adminFile, ["usage", "--application", other.id, "--format", "json"])).lines.length > 0, true);

  // alerts: the URL and signing secret come from private files; a readable-by-others file is refused before any request.
  const destination = randomUUID(), urlFile = file("hook.url", hookUrl), secretFile = file("hook.secret", secret);
  const add = ["alerts", "add", "--request-id", destination, "--name", "Operations", "--type", "webhook", "--url-file", urlFile, "--secret-file", secretFile, "--kind", "host.draining", "--kind", "host.accepting"];
  assert.equal((await cli(adminFile, add.map(arg => arg === secretFile ? file("loose.secret", secret, 0o644) : arg))).status, 1);
  assert.equal((await cli(adminFile, add.filter(arg => arg !== "--secret-file" && arg !== secretFile))).status, 1);
  assert.equal((await cli(adminFile, [...add.slice(0, 7), "slack", ...add.slice(8)])).status, 1, "a Slack destination takes no secret");
  assert.equal((await cli(adminFile, ["alerts", "list"])).stdout.includes(destination), false, "no refused attempt created a destination");
  run = await cli(adminFile, add);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual((({ id, type, endpoint, signed, kinds }) => ({ id, type, endpoint, signed, kinds }))(JSON.parse(run.stdout)),
    { id: destination, type: "webhook", endpoint: new URL(hookUrl).origin, signed: true, kinds: ["host.accepting", "host.draining"] });
  assert.equal((await cli(adminFile, add)).status, 0, "the same request UUID and files replay");
  assert.equal(JSON.parse((await cli(adminFile, ["alerts", "list"])).stdout).destinations.length, 1);
  // test: exit status reports the receiver's answer.
  run = await cli(adminFile, ["alerts", "test", destination]);
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).delivery.state, "delivered");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.headers["x-canaveral-signature"], "sha256=" + createHmac("sha256", secret).update(received[0]!.body).digest("hex"));
  answer = 500;
  run = await cli(adminFile, ["alerts", "test", destination, "--request-id", randomUUID()]);
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).delivery.state, "failed");
  answer = 204;
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: false });
  await eventually(() => received.length, count => count === 3);
  assert.equal(JSON.parse(received[2]!.body.toString()).kind, "host.draining");
  run = await cli(adminFile, ["alerts", "deliveries", "--destination", destination, "--state", "delivered"]);
  assert.deepEqual(JSON.parse(run.stdout).deliveries.map((d: any) => d.kind).sort(), ["alert.test", "host.draining"]);
  assert.deepEqual(JSON.parse((await cli(adminFile, ["alerts", "remove", destination])).stdout), { id: destination, removed: true });
  assert.deepEqual(JSON.parse((await cli(adminFile, ["alerts", "list"])).stdout).destinations, []);
  assert.equal((await cli(adminFile, ["alerts", "test", destination])).status, 1);
  assert.equal((await cli(appFile, ["alerts", "list"])).status, 1);
});

test("the command line documents and strictly parses the observability commands", async () => {
  let help = "";
  assert.equal(await main(["--help"], { stdout: text => { help += text; } }), 0);
  for (const phrase of ["events [--after SEQ | --tail N]", "usage [--last 24h | --from TIME --to TIME]", "alerts list | deliveries | remove ID | test ID", "alerts add --request-id UUID", "doctor [--json]", "private 0600 files"]) assert.ok(help.includes(phrase), phrase);
  assert.deepEqual({ ...parseCli(["events", "--kind", "lease.*", "--kind", "host.offline", "--follow"], {}).options }, { kind: ["lease.*", "host.offline"], follow: true });
  assert.equal(parseCli(["alerts"], {}).action, "list");
  assert.deepEqual(parseCli(["alerts", "test", "abc", "--request-id", "x"], {}).positionals, ["abc"]);
  for (const argv of [["events", "extra"], ["usage", "--kind", "x"], ["alerts", "add"], ["alerts", "remove"], ["doctor", "--follow"], ["alerts", "list", "--state", "x"]]) assert.throws(() => parseCli(argv, {}), Error, argv.join(" "));
});
