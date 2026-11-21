import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { main } from "../../src/cli.ts";
import { diagnose, FINDING_CODES } from "../../src/control/diagnosis.ts";
import { Observability } from "../../src/control/observability.ts";
import type { Finding } from "../../src/control/diagnosis.ts";
import { probeController } from "../../src/observability-cli.ts";
import { observabilitySettings } from "../../src/observability.ts";
import { controllerFixture, key } from "./observability-controller.test.ts";
import { observabilityFixture } from "./observability-fixture.test.ts";

const sample = (extra: Record<string, unknown> = {}) => ({ scope: "host", domain: "fixture", sampledAt: 0, cpuPercent: 10, cpuCount: 8, memoryTotalMiB: 16000, memoryAvailableMiB: 8000, diskTotalGiB: 500, diskFreeGiB: 250, ...extra });
const health = (status: string, checks: Array<Record<string, string>> = [], checkedAt = 0) => ({ status, checkedAt, checks });
const codes = (findings: Finding[]) => findings.map(finding => finding.code);

test("the observer records liveness, pressure and long waits as transitions, each exactly once", async t => {
  const f = observabilityFixture(t, { diskFreeAlertPercent: 10, memoryAvailableAlertPercent: 5, requestWaitAlertSeconds: 120 });
  const observed = async () => (await f.events()).filter(event => /^host\.(offline|online|disk|memory)|^request\.waiting_long/.test(event.kind)).map(event => event.kind);
  // After a start every host looks silent until it reports; liveness is not judged inside that window.
  f.advance(31); assert.equal(f.observability.observe(), 0);
  f.advance(20); f.beat(); assert.equal(f.observability.observe(), 0);
  f.advance(29); assert.equal(f.observability.observe(), 0, "still inside the 30 s freshness window");
  f.advance(1); assert.equal(f.observability.observe(), 1); assert.equal(f.observability.observe(), 0);
  f.advance(600); assert.equal(f.observability.observe(), 0, "a host that stays silent is one event, not one per round");
  f.beat({ resources: sample() }); assert.equal(f.observability.observe(), 1);
  const [offline, online] = (await f.events()).filter(event => event.kind === "host.offline" || event.kind === "host.online");
  assert.equal(offline!.hostId, f.host); assert.equal(offline!.data.silentSeconds, 30); assert.equal(online!.data.offlineSeconds, 600);
  // Pressure begins below the threshold and ends only with headroom above it; an unavailable reading changes nothing.
  const report = (resources: Record<string, unknown>) => { f.advance(11); f.beat({ resources: sample(resources) }); return f.observability.observe(); };
  assert.equal(report({ diskFreeGiB: 49 }), 1); assert.equal(report({ diskFreeGiB: 40 }), 0);
  assert.equal(report({ diskFreeGiB: 55 }), 0, "11% is above the threshold but inside the hysteresis band");
  assert.equal(report({ diskFreeGiB: null }), 0);
  assert.equal(report({ diskFreeGiB: 60, memoryAvailableMiB: 700 }), 2);
  assert.equal(report({ memoryAvailableMiB: 4000 }), 1);
  assert.deepEqual(await observed(), ["host.offline", "host.online", "host.disk_pressure", "host.disk_pressure_cleared", "host.memory_pressure", "host.memory_pressure_cleared"]);
  const pressure = (await f.events("kind=host.disk_pressure"))[0]!;
  assert.deepEqual(pressure.data, { freeGiB: 49, totalGiB: 500, freePercent: 9.8, thresholdPercent: 10 });
  // A restarted controller keeps what it already knew: no second offline event, and a heartbeat inside the grace still ends it.
  f.advance(31); f.observability.observe();
  const restarted = new (f.observability.constructor as typeof import("../../src/control/observability.ts").Observability)(f.store, f.options, f.apps);
  f.advance(100); assert.equal(restarted.observe(), 0);
  f.beat(); assert.equal(restarted.observe(), 1);
  assert.deepEqual((await observed()).slice(-2), ["host.offline", "host.online"]);
  // A long wait is recorded once and forgotten when the request leaves the queue.
  const app = f.application({ activeLeases: 1, maxWaitingRequests: 5 });
  await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 }), app.credential);
  const id = f.leases.requests.submit(app.credential, { id: randomUUID(), kind: "lease", intent: { templateId: f.image.id, templateRevision: "1", arch: "amd64" } }).request.id;
  f.advance(119); f.beat(); assert.equal(f.observability.observe(), 0);
  f.advance(1); f.beat(); assert.equal(f.observability.observe(), 1); assert.equal(f.observability.observe(), 0);
  const long = (await f.events("kind=request.waiting_long"))[0]!;
  assert.equal(long.requestId, id); assert.equal(long.applicationId, app.id); assert.equal(long.data.waitedSeconds, 120);
  f.leases.requests.cancel(app.credential, id, {});
  assert.equal(f.observability.observe(), 1, "the condition row is removed");
  f.store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM event_conditions WHERE kind='request.waiting_long'").get()!.n, 0));
  assert.equal((await f.events("kind=request.waiting_long")).length, 1);

  // With nothing to do, a round opens no transaction at all: every timer probes on a read-only connection first.
  let transactions = 0;
  f.store.addTransactionHook(() => { transactions++; });
  f.beat(); transactions = 0;
  for (let round = 0; round < 3; round++) { f.advance(5); await f.observability.tick(); }
  assert.equal(f.observability.maintain(true), false, "nothing is past its retention");
  assert.equal(transactions, 0);
  // Work that is due is done: a silent host, and events past their age.
  f.advance(31); await f.observability.tick();
  assert.equal(transactions, 1); assert.equal((await f.events("kind=host.offline")).length, 3);
  f.advance(31 * 86400); transactions = 0;
  assert.equal(f.observability.maintain(true), true); assert.equal(transactions, 1);
  assert.equal(f.observability.maintain(true), false);
});

test("a diagnosis names each problem with a stable code and a next step, and changes nothing", async t => {
  const f = observabilityFixture(t, { requestWaitAlertSeconds: 300 });
  const diagnosis = async () => await f.admin("/v1/admin/diagnosis") as { findings: Finding[]; checked: Record<string, number>; omitted: number };
  // A runner's report carries when it ran its checks; an identical cached report does not refresh its age.
  const healthy = () => f.beat({ health: health("passed", [{ id: "storage", label: "Storage", detail: "writable", status: "passed" }], f.now()) });
  assert.deepEqual(codes((await diagnosis()).findings), ["host_checks_missing"]);
  healthy();
  const clean = await diagnosis();
  assert.deepEqual(clean.findings, []); assert.deepEqual(clean.checked, { hosts: 1, activeLeases: 0, waitingRequests: 0, updateJobs: 0, alertDestinations: 0 });

  // Hosts: failing checks, stale checks, draining, maintenance, offline.
  f.beat({ health: health("failed", [{ id: "android-sdk", label: "Android SDK", detail: "PRIVATE PATH /Users/operator/sdk", status: "failed" }, { id: "storage", label: "Storage", detail: "ok", status: "passed" }]) });
  let found = (await diagnosis()).findings;
  assert.deepEqual(codes(found), ["host_checks_failed"]); assert.equal(found[0]!.severity, "error"); assert.equal(found[0]!.subject.id, f.host);
  assert.match(found[0]!.summary, /disposable fixture fails android-sdk/); assert.ok(!JSON.stringify(found).includes("PRIVATE PATH"));
  healthy(); f.advance(25); f.beat(); f.advance(25); f.beat(); f.advance(25); f.beat(); f.advance(25); f.beat(); f.advance(25); f.beat();
  assert.deepEqual(codes((await diagnosis()).findings), ["host_checks_stale"], "re-sending the heartbeat does not refresh a report's age");
  healthy();
  f.store.transaction(db => {
    db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.host);
    db.prepare("INSERT INTO host_maintenance (id,host,actor,reason,created_at,phase) VALUES (?,?,'operator','PRIVATE REASON',?,'draining')").run(randomUUID(), f.host, f.now());
  });
  found = (await diagnosis()).findings;
  assert.deepEqual(codes(found), ["host_draining", "host_maintenance"]); assert.ok(found.every(finding => finding.severity === "notice"));
  assert.match(found[0]!.nextStep, new RegExp(`canaveral accept ${f.host}`)); assert.ok(!JSON.stringify(found).includes("PRIVATE REASON"));
  f.advance(31);
  found = (await diagnosis()).findings;
  assert.deepEqual(codes(found), ["host_offline"], "an offline host is reported as offline, not by what it last said"); assert.equal(found[0]!.details!.silentSeconds, 31);
  f.store.transaction(db => { db.prepare("UPDATE hosts SET enabled=1 WHERE id=?").run(f.host); db.exec("DELETE FROM host_maintenance"); });
  healthy();

  // Leases: blocked cleanup, then cleanup that stays unproven long after the lease ended.
  const lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 })), machine = lease.members[0].machineId; f.ready(lease);
  const idle = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 }));
  assert.equal((await diagnosis()).checked.activeLeases, 2);
  await f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() }); await f.request("POST", `/v1/leases/${idle.id}/release`, { id: randomUUID() });
  const cleanup = (await f.request("GET", `/v1/leases/${lease.id}`)).members[0].cleanup;
  f.beat({ reports: { [machine]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "blocked", attempt: 3, reason: "storage_removal" } } } });
  found = (await diagnosis()).findings;
  assert.deepEqual(codes(found), ["lease_cleanup_blocked"]);
  assert.deepEqual(found[0]!.details, { machineId: machine, reason: "storage_removal", attempts: 3, retryAt: new Date((f.now() + 8) * 1000).toISOString() });
  for (let n = 0; n < 32; n++) { f.advance(29); healthy(); }
  assert.deepEqual(codes((await diagnosis()).findings), ["lease_cleanup_blocked", "lease_cleanup_pending"]);
  assert.equal((await diagnosis()).findings[1]!.subject.id, idle.id);

  // Operations: an unknown outcome is reported, an uncertain install until an operator resolves it.
  const operation = randomUUID(), install = randomUUID();
  f.store.transaction(db => {
    for (const [id, action] of [[operation, "tap"], [install, "install-uploaded"]] as const) {
      db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'queued',NULL,?,?)").run(id, machine, f.host, JSON.stringify({ id, action, arguments: { secret: "PRIVATE-ARGUMENT" } }), f.now(), f.now());
      db.prepare("UPDATE device_operations SET state='unknown',updated=? WHERE id=?").run(f.now(), id);
    }
    db.prepare("INSERT INTO control_device_dispatch VALUES (?,?)").run(install, f.now());
  });
  found = (await diagnosis()).findings.filter(finding => /outcome_unknown/.test(finding.code));
  assert.deepEqual(found.map(finding => [finding.code, finding.subject.id, finding.severity]), [[`install_outcome_unknown`, install, "error"], ["operation_outcome_unknown", operation, "warning"]]);
  assert.match(found[0]!.nextStep, /--resolve-file/); assert.ok(!JSON.stringify(found).includes("PRIVATE-ARGUMENT"));
  f.store.transaction(db => db.prepare("INSERT INTO device_operation_resolutions VALUES (?,?,'cleanup-confirmed',NULL,'operator inspected','{}',?)").run(randomUUID(), install, f.now()));
  assert.deepEqual(codes((await diagnosis()).findings.filter(finding => /outcome_unknown/.test(finding.code))), ["operation_outcome_unknown"]);

  // Requests: a wait is a notice with its last admission answer, and a warning past the configured threshold.
  const app = f.application({ activeLeases: 1, maxWaitingRequests: 5 });
  await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 }), app.credential);
  const request = f.leases.requests.submit(app.credential, { id: randomUUID(), kind: "lease", intent: { templateId: f.image.id, templateRevision: "1", arch: "amd64" } }).request.id;
  f.leases.requests.pass();
  let waiting = (await diagnosis()).findings.find(finding => finding.subject.id === request)!;
  assert.deepEqual([waiting.code, waiting.severity, waiting.details!.reason, waiting.details!.applicationId], ["request_waiting", "notice", "limit_exceeded", app.id]);
  assert.match(waiting.nextStep, /limits are full/);
  for (let n = 0; n < 11; n++) { f.advance(29); healthy(); }
  waiting = (await diagnosis()).findings.find(finding => finding.subject.id === request)!;
  assert.deepEqual([waiting.code, waiting.severity, waiting.details!.waitedSeconds], ["request_waiting_long", "warning", 319]);

  // Alerts that cannot be delivered are a finding of their own.
  const destination = (await f.call("POST", "/v1/admin/alerts/destinations", { id: randomUUID(), name: "Pager", type: "slack", url: "https://hooks.example.invalid/x", kinds: ["host.draining"] })).body as any;
  f.respond(() => ({ ok: false, status: 410, outcome: "http_error" }));
  assert.equal(((await f.call("POST", `/v1/admin/alerts/destinations/${destination.id}/test`, { id: randomUUID() })).body as any).delivery.state, "failed");
  const final = await diagnosis();
  assert.deepEqual(final.findings.filter(finding => finding.code === "alert_delivery_failing").map(finding => [finding.subject.id, finding.details!.failedDeliveries]), [[destination.id, 1]]);
  // Errors first, then warnings, then notices; every code is catalogued with a next step.
  assert.deepEqual(final.findings.map(finding => finding.severity), [...final.findings.map(finding => finding.severity)].sort((a, b) => ["error", "warning", "notice"].indexOf(a) - ["error", "warning", "notice"].indexOf(b)));
  for (const finding of final.findings) { assert.ok(Object.hasOwn(FINDING_CODES, finding.code), finding.code); assert.ok(finding.nextStep.length > 20 && finding.summary.length > 10); }
  assert.equal(final.checked.waitingRequests, 1); assert.equal(final.checked.alertDestinations, 1);

  // The diagnosis adds no write: the same findings come from a connection that cannot write. This fixture is
  // quiescent and uses the operator credential, so nothing else writes either and the file stays byte-identical.
  const digest = () => createHash("sha256").update(readFileSync(f.store.path)).digest("hex"), before = digest();
  const db = new DatabaseSync(f.store.path, { readOnly: true });
  try {
    assert.deepEqual(diagnose(db, f.now(), observabilitySettings({ requestWaitAlertSeconds: 300 })).findings, final.findings);
    assert.throws(() => db.exec("DELETE FROM events"), /readonly/);
  } finally { db.close(); }
  assert.deepEqual((await diagnosis()).findings, final.findings);
  assert.equal(digest(), before);
  await assert.rejects(f.admin("/v1/admin/diagnosis?verbose=1"), (error: any) => error.status === 400);
});

test("just after a restart a host the controller has not heard from yet is not called offline", async t => {
  const f = observabilityFixture(t);
  const report = () => f.beat({ health: health("passed", [], f.now()) });
  const diagnosis = async (observability: Observability) => (await observability.handle({ method: "GET", path: "/v1/admin/diagnosis", parts: ["v1", "admin", "diagnosis"], query: new URLSearchParams(), body: {}, token: f.options.adminToken,
    principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) }))!.body as { findings: Finding[] };
  report();
  assert.deepEqual((await diagnosis(f.observability)).findings, []);
  // The controller was down for five minutes. Every host's last heartbeat is older than the freshness window.
  f.advance(300);
  const restarted = new Observability(f.store, f.options, f.apps);
  f.advance(5);
  let found = (await diagnosis(restarted)).findings;
  assert.deepEqual(found.map(finding => [finding.code, finding.severity]), [["controller_recently_started", "notice"]]);
  assert.deepEqual(found[0]!.details, { startedSecondsAgo: 5, hostsNotYetHeard: 1 }); assert.match(found[0]!.nextStep, /again in 40 seconds/);
  // A host that has reported since the start is judged normally, inside the grace too.
  report();
  assert.deepEqual((await diagnosis(restarted)).findings, []);
  f.advance(31);
  assert.deepEqual(codes((await diagnosis(restarted)).findings), ["host_offline"], "it reported after the start and then fell silent");
  // A host that never comes back is offline once the grace has passed, exactly when the observer says so.
  const again = new Observability(f.store, f.options, f.apps);
  f.advance(44);
  assert.deepEqual(codes((await diagnosis(again)).findings), ["controller_recently_started"]); assert.equal(again.observe(), 0);
  f.advance(1);
  assert.deepEqual(codes((await diagnosis(again)).findings), ["host_offline"]); assert.equal(again.observe(), 1);
});

test("a finding this version does not know is still shown and still fails the run", async t => {
  const tokens = mkdtempSync(join(tmpdir(), "canaveral-doctor-unknown-")); t.after(() => rmSync(tokens, { recursive: true, force: true }));
  const tokenFile = join(tokens, "token"); writeFileSync(tokenFile, key() + "\n", { mode: 0o600 });
  // A newer controller reports a condition this command has no description for, and one malformed entry.
  const newer = { generatedAt: "2026-11-21T09:00:00.000Z", omitted: 0, checked: { hosts: 1, activeLeases: 0, waitingRequests: 0, updateJobs: 0, alertDestinations: 0 },
    findings: [{ code: "quorum_degraded", severity: "error", subject: { type: "controller", id: "c" }, summary: "A condition from the future.", nextStep: "Follow the newer runbook." }, { code: 7, severity: "catastrophic" }] };
  const run = async (args: string[]) => {
    let stdout = "";
    const status = await main(["--url", "http://127.0.0.1:1", "--token-file", tokenFile, "doctor", ...args], { stdout: text => { stdout += text; }, stderr: () => {},
      probe: async () => ({ reachable: true }), client: () => ({ request: async () => newer }) as never });
    return { status, stdout };
  };
  const json = await run(["--json"]), report = JSON.parse(json.stdout) as { ok: boolean; findings: Finding[] };
  assert.deepEqual([json.status, report.ok, report.findings.map(finding => [finding.code, finding.severity])], [1, false, [["quorum_degraded", "error"], ["unknown_finding", "warning"]]]);
  assert.equal(report.findings[0]!.summary, "A condition from the future.");
  const text = await run([]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /2 findings:\n\[error\] quorum_degraded \(not known to this version\): A condition from the future\.\n {4}next: Follow the newer runbook\.\n\[warning\] unknown_finding \(not known to this version\): The controller reported a finding this version cannot describe\./);
});

test("canaveral doctor checks the connection and credential, prints findings and exits non-zero when it has any", { timeout: 90_000 }, async t => {
  const f = await controllerFixture(t);
  const tokens = mkdtempSync(join(tmpdir(), "canaveral-doctor-")); t.after(() => rmSync(tokens, { recursive: true, force: true }));
  const file = (name: string, value: string) => { const path = join(tokens, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
  const adminFile = file("admin", f.admin), strangerFile = file("stranger", key());
  const doctor = async (args: string[], url = f.url()) => {
    let stdout = "", stderr = "";
    const status = await main(["--url", url, ...args], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    for (const secret of [f.admin, f.hostToken, f.enrollment]) assert.ok(!(stdout + stderr).includes(secret));
    return { status, stdout, stderr };
  };
  const json = async (args: string[], url?: string) => { const run = await doctor([...args, "doctor", "--json"], url); return { status: run.status, report: JSON.parse(run.stdout) as { ok: boolean; findings: Finding[]; checks: Array<{ check: string; ok: boolean }>; checked?: Record<string, number> } }; };
  const healthy = () => f.call("POST", `/v1/hosts/${f.host}/heartbeat`, f.hostToken, { offer: f.offer, reports: {}, health: health("passed", [], Date.now() / 1000) });
  await healthy();
  // A healthy controller: no findings, exit status 0, in both output forms.
  let run = await doctor(["--token-file", adminFile, "doctor"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^Canaveral doctor: http:\/\/127\.0\.0\.1:\d+\nok {3}controller: reachable over plain HTTP\nok {3}credential: accepted with administrator authority\nexamined 1 hosts, 0 active leases, 0 waiting requests, 0 update jobs, 0 alert destinations\nNo findings\.\n$/);
  let result = await json(["--token-file", adminFile]);
  assert.equal(result.status, 0); assert.equal(result.report.ok, true); assert.deepEqual(result.report.findings, []); assert.deepEqual(result.report.checks.map(check => [check.check, check.ok]), [["controller", true], ["credential", true]]);

  // Controller state: a drained host, an uncertain update and a waiting request each become a finding and status 1.
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: false });
  const job = randomUUID(), now = Date.now() / 1000;
  f.sql(db => db.prepare("INSERT INTO host_update_jobs (id,rollout,host,target_kind,release,attempt,installation,credential,phase,uncertain,components,created,updated) VALUES (?,?,?,'host','release-1',?,?,'HASH','unknown',1,'{}',?,?)")
    .run(job, randomUUID(), f.host, randomUUID(), randomUUID(), now, now));
  const app = await f.application({ activeLeases: 1 });
  const request = randomUUID();
  await f.call("POST", "/v1/requests", app.credential, { id: request, kind: "lease", intent: { templateId: "fixture-image", templateRevision: "1", arch: "amd64" } }, 201);
  result = await json(["--token-file", adminFile]);
  assert.equal(result.status, 1); assert.equal(result.report.ok, false);
  assert.deepEqual(codes(result.report.findings), ["update_job_uncertain", "host_draining", "request_waiting"]);
  assert.equal(result.report.findings[0]!.subject.id, job); assert.equal(result.report.findings[2]!.subject.id, request); assert.equal(result.report.checked!.waitingRequests, 1);
  run = await doctor(["--token-file", adminFile, "doctor"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /3 findings:\n\[error\] update_job_uncertain: .*\n {4}next: .*\n\[notice\] host_draining: .*\n {4}next: Run `canaveral accept /);
  // Doctor issued only reads: the drained host, the waiting request and the event log are exactly as before.
  const before = (await f.events()).length;
  await doctor(["--token-file", adminFile, "doctor"]);
  assert.equal((await f.events()).length, before);
  assert.equal((await f.call("GET", `/v1/requests/${request}`, app.credential)).state, "waiting");

  // Credential problems are findings too, and controller state is not examined without authority.
  result = await json(["--token-file", strangerFile]);
  assert.deepEqual([result.status, codes(result.report.findings), result.report.checks.map(check => check.ok)], [1, ["credential_rejected"], [true, false]]); assert.equal(result.report.checked, undefined);
  const password = "disposable-doctor-password";
  const administrator = await f.call("POST", "/v1/auth/setup", f.admin, { username: "administrator", password });
  const user = await f.call("POST", "/v1/users", administrator.token, { id: randomUUID(), username: "reader" });
  const reader = await f.call("POST", "/v1/auth/claim", "", { token: (await f.call("POST", `/v1/users/${user.id}/invite`, administrator.token, {})).token, password });
  assert.deepEqual(codes((await json(["--token-file", file("reader", reader.token)])).report.findings), ["credential_not_administrator"]);
  assert.deepEqual(codes((await json([])).report.findings), ["credential_missing"]);
  assert.deepEqual(codes((await json(["--token-file", file("session", administrator.token)])).report.findings), ["update_job_uncertain", "host_draining", "request_waiting"]);

  // Connection problems: nothing listening, plain HTTP beyond loopback, and a certificate the trust store does not accept.
  result = await json(["--token-file", adminFile], "http://127.0.0.1:9");
  assert.deepEqual([result.status, codes(result.report.findings), result.report.checks[0]!.ok], [1, ["controller_unreachable"], false]);
  assert.deepEqual(codes((await json(["--token-file", adminFile], "http://controller.example.invalid")).report.findings), ["controller_plain_http"]);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(tokens, "tls.key"), "-out", join(tokens, "tls.crt"), "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const secure = https.createServer({ key: readFileSync(join(tokens, "tls.key")), cert: readFileSync(join(tokens, "tls.crt")) }, (_request, response) => { response.end("{}"); });
  await new Promise<void>(resolve => secure.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { secure.close(() => resolve()); secure.closeAllConnections(); }));
  const origin = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`;
  assert.deepEqual(await probeController(origin, false), { reachable: false, code: "tls" });
  assert.deepEqual(codes((await json(["--token-file", adminFile], origin)).report.findings), ["controller_tls_untrusted"]);
  // An accepted certificate close to expiry is a warning; the probe result is injected because no trusted CA exists here.
  let stdout = "";
  const status = await main(["--url", f.url(), "--token-file", adminFile, "doctor", "--json"], { stdout: text => { stdout += text; }, stderr: () => {},
    probe: async () => ({ reachable: true, tls: { protocol: "TLSv1.3", expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString() } }) });
  assert.equal(status, 1); assert.ok(codes((JSON.parse(stdout) as { findings: Finding[] }).findings).includes("controller_tls_expiring"));
});
