import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliError } from "../../src/account-cli.ts";
import type { RequestClient } from "../../src/account-cli.ts";
import { main, parseCli } from "../../src/cli.ts";
import type { ServerSentEvent } from "../../src/sse.ts";
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

  // Without --after a follow against the real controller starts at the head: nothing already in the log is printed.
  const fresh = new AbortController(); let live = "";
  const watching = main(["--url", f.url(), "--token-file", adminFile, "events", "--follow", "--kind", "lease.*"], { stdout: text => { live += text; }, stderr: () => {}, signal: fresh.signal });
  await new Promise(resolve => setTimeout(resolve, 400));
  const later = await f.acquire(app.credential);
  await eventually(() => live, text => text.includes(later.id));
  fresh.abort();
  assert.equal(await watching, 0);
  assert.deepEqual(live.trim().split("\n").map(line => [JSON.parse(line).kind, JSON.parse(line).leaseId]), [["lease.admitted", later.id]]);

  // usage: the same report as text, JSON and CSV.
  run = await cli(adminFile, ["usage", "--format", "json", "--last", "1h"]);
  const report = JSON.parse(run.stdout);
  assert.equal(report.groupBy, "application"); assert.equal(report.totals.leases.admitted, 3); assert.equal(report.totals.leases.released, 1);
  assert.deepEqual(report.rows.map((row: any) => row.key).sort(), [app.id, other.id].sort());
  run = await cli(adminFile, ["usage", "--format", "csv", "--group-by", "host"]);
  assert.deepEqual(run.stdout.split("\r\n").slice(0, 2).map(line => line.split(",").slice(0, 3).join(",")), ["group,key,label", `host,${f.host},disposable fixture`]);
  run = await cli(adminFile, ["usage", "--group-by", "platform"]);
  assert.match(run.stdout, /^Usage \S+ to \S+ by platform\nplatform +requests .*device-s\nlinux .*\ntotal .*\nRequest records are not pruned\. Lease figures come from the usage ledger, kept 400 days after a lease ends and started \S+\.\n$/);
  run = await cli(appFile, ["usage", "--own", "--format", "json"]);
  assert.equal(JSON.parse(run.stdout).applicationId, app.id); assert.equal(JSON.parse(run.stdout).totals.leases.admitted, 2);
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

/** A scripted streaming client: each call to `stream` plays the next script and records the path it was asked for. */
function scriptedStreams(scripts: Array<(signal: AbortSignal) => AsyncGenerator<ServerSentEvent> | Error>) {
  const paths: string[] = [];
  const client = {
    async request(): Promise<Record<string, unknown>> { throw new CliError("not scripted", 500); },
    async stream(path: string, signal: AbortSignal): Promise<AsyncIterable<ServerSentEvent>> {
      paths.push(path);
      const script = scripts[paths.length - 1];
      if (!script) return (async function* () { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); })();
      const played = script(signal);
      if (played instanceof Error) throw played;
      return played;
    },
  };
  return { paths, client: client as unknown as RequestClient };
}
const message = (event: string | undefined, data: Record<string, unknown>, id?: number): ServerSentEvent => ({ ...(event ? { event } : {}), ...(id === undefined ? {} : { id: String(id) }), data: JSON.stringify(data) });
const event = (sequence: number) => message(undefined, { sequence, at: "2026-11-21T09:00:00.000Z", kind: "lease.ready", data: {} }, sequence);
async function* play(...messages: ServerSentEvent[]) { yield* messages; }

test("events --follow starts at the head, resumes from the position the controller reported and survives quiet stream ends", async t => {
  const tokens = mkdtempSync(join(tmpdir(), "canaveral-follow-")); t.after(() => rmSync(tokens, { recursive: true, force: true }));
  const tokenFile = join(tokens, "token"); writeFileSync(tokenFile, "x".repeat(43) + "\n", { mode: 0o600 });
  const follow = async (scripts: Parameters<typeof scriptedStreams>[0], args: string[] = [], until?: (output: { stdout: string; paths: string[] }) => boolean) => {
    const scripted = scriptedStreams(scripts), abort = new AbortController(), output = { stdout: "", stderr: "" };
    const running = main(["--url", "http://127.0.0.1:1", "--token-file", tokenFile, "events", "--follow", ...args], { stdout: text => { output.stdout += text; }, stderr: text => { output.stderr += text; },
      client: () => scripted.client, signal: abort.signal, followTiming: { reconnectMs: 5, retryMs: 20 } });
    if (until) { await eventually(() => ({ stdout: output.stdout, paths: scripted.paths }), until); abort.abort(); }
    return { status: await running, ...output, paths: scripted.paths, sequences: output.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line).sequence as number) };
  };
  const lifetime = (cursor: number) => message("end", { code: "stream_lifetime", cursor }, cursor);
  // No --after: the first stream starts at the head. It ends without any event, at its lifetime.
  const quiet = await follow([
    () => play(message("open", { cursor: 40 }, 40), message("cursor", { cursor: 44 }, 44), lifetime(44)),
    () => play(message("open", { cursor: 44 }, 44), event(45), message("cursor", { cursor: 50 }, 50), lifetime(50)),
    // Seven more ordinary ends in a row: following again is not a failure and has no limit.
    ...Array.from({ length: 7 }, () => () => play(message("open", { cursor: 50 }, 50), lifetime(50))),
  ], ["--kind", "lease.*"], output => output.paths.length === 10);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(quiet.sequences, [45], "only the new event is printed; retained history is never replayed");
  assert.equal(quiet.paths[0], "/v1/admin/events/stream?kind=lease.*");
  assert.equal(quiet.paths[1], "/v1/admin/events/stream?kind=lease.*&after=44", "the quiet stream's end cursor is the resume position");
  assert.deepEqual([...new Set(quiet.paths.slice(2))], ["/v1/admin/events/stream?kind=lease.*&after=50"]);
  assert.ok(quiet.paths.every(path => !/after=0\b/.test(path)));
  assert.equal(quiet.stderr, "cursor=50\n");
  // A stream cut before it reported any position is followed from the head again, not from zero.
  const cut = await follow([() => new CliError("Controller response was not confirmed.", 503), () => play(message("open", { cursor: 7 }, 7), event(8))], [], output => output.stdout.includes('"sequence":8'));
  assert.deepEqual([cut.status, cut.sequences, cut.paths.slice(0, 2)], [0, [8], ["/v1/admin/events/stream", "/v1/admin/events/stream"]]);
  // A lost connection resumes from the last event; a closing controller from its end cursor.
  const lost = await follow([() => play(message("open", { cursor: 10 }, 10), event(11)), () => play(message("open", { cursor: 11 }, 11), message("end", { code: "controller_closing", cursor: 13 }, 13)), () => play(message("open", { cursor: 13 }, 13), event(14))],
    ["--after", "10"], output => output.stdout.includes('"sequence":14'));
  assert.deepEqual([lost.status, lost.sequences], [0, [11, 14]]);
  assert.deepEqual(lost.paths.slice(0, 3), ["/v1/admin/events/stream?after=10", "/v1/admin/events/stream?after=11", "/v1/admin/events/stream?after=13"]);
  // Only consecutive attempts that yield nothing count; five retries, then the command says where to continue.
  const failing = await follow([() => play(message("open", { cursor: 3 }, 3), event(4)), ...Array.from({ length: 6 }, () => () => new CliError("Controller response was not confirmed.", 503))]);
  assert.equal(failing.status, 1); assert.equal(failing.paths.length, 6, "the stream that worked, then five retries");
  assert.deepEqual([...new Set(failing.paths.slice(1))], ["/v1/admin/events/stream?after=4"]);
  assert.match(failing.stderr, /The event stream could not be resumed\. Continue with --after 4\./);
  // A credential that stopped being accepted ends the follow; a definite refusal is not retried.
  const revoked = await follow([() => play(message("open", { cursor: 3 }, 3), message("end", { code: "unauthenticated", cursor: 3 }, 3))]);
  assert.deepEqual([revoked.status, revoked.stderr, revoked.paths.length], [1, "stream ended: unauthenticated\n", 1]);
  const refused = await follow([() => new CliError("Controller request failed (HTTP 429, event_stream_limit). Inspect state before retrying.", 429)]);
  assert.deepEqual([refused.status, refused.paths.length], [1, 1]); assert.match(refused.stderr, /event_stream_limit/);
  const truncated = await follow([() => play(message("open", { cursor: 2 }, 2), message("truncated", { after: 2 }), event(90))], ["--after", "2"], output => output.stdout.includes('"sequence":90'));
  assert.match(truncated.stderr, /^truncated=true \(retention removed events after the supplied cursor\)\ncursor=90\n$/);
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
