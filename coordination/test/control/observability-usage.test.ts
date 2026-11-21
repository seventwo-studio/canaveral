import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Observability } from "../../src/control/observability.ts";
import { usageCsv, usageReport } from "../../src/usage.ts";
import type { UsageReport } from "../../src/usage.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";
import { observabilityFixture } from "./observability-fixture.test.ts";

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const range = (from: number, to: number) => `from=${iso(from)}&to=${iso(to)}`;

test("lease usage matches a scripted history: counts, time to ready, hold percentiles and device-seconds", async t => {
  const f = observabilityFixture(t), slow = f.application({ provisioningTimeoutSeconds: 50 });
  // The fixture host is eligible only while its heartbeat is fresh on the scripted clock.
  const acquire = (credential = f.app.credential) => { f.beat(); return f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 }), credential); };
  const release = (lease: any) => f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() });
  // 1000 admitted, 1010 ready, 1100 released: ready after 10 s, held 100 s.
  const first = await acquire(); f.setNow(1010); f.ready(first); f.setNow(1100); await release(first);
  // 1100 admitted, 1130 ready, 1400 released: ready after 30 s, held 300 s.
  const second = await acquire(); f.setNow(1130); f.ready(second);
  // 1200 admitted, never ready, failed at its 50 s provisioning deadline: held 50 s.
  f.setNow(1200); const third = await acquire(slow.credential); f.setNow(1250); f.beat();
  assert.equal((await f.request("GET", `/v1/leases/${third.id}`, {}, slow.credential)).state, "failed");
  f.setNow(1400); await release(second);
  // 1500 admitted, 1505 ready, still active when the report is read at 2000.
  f.setNow(1500); const fourth = await acquire(); f.setNow(1505); f.ready(fourth);
  f.setNow(2000);
  const report = await f.admin(`/v1/admin/usage?${range(1000, 2000)}&groupBy=application`) as UsageReport;
  assert.deepEqual(report.totals.leases, { admitted: 4, ready: 3, released: 2, expired: 0, failed: 1, active: 1, cleanupBlocked: 0, deviceSeconds: 950,
    timeToReadySeconds: { p50: 10, p95: 30, samples: 3 }, holdSeconds: { p50: 100, p95: 300, samples: 3 } });
  assert.deepEqual(report.rows.map(row => [row.key, row.label, row.leases.admitted, row.leases.failed, row.leases.deviceSeconds]).sort(),
    [[f.app.id, "Fixture application", 3, 0, 900], [slow.id, "Fixture application", 1, 1, 50]].sort());
  assert.deepEqual(report.rows.find(row => row.key === slow.id)!.leases.holdSeconds, { p50: 50, p95: 50, samples: 1 });
  assert.equal(report.from, iso(1000)); assert.equal(report.to, iso(2000)); assert.equal(report.generatedAt, iso(2000));
  assert.deepEqual(report.retention, { requestRecords: "not pruned", leaseLedgerSeconds: 400 * 86400, leaseLedgerStartedAt: iso(1000) });

  // Counts follow the cohort admitted in the range; device-seconds follow the time that falls inside it.
  const window = await f.admin(`/v1/admin/usage?${range(1050, 1300)}`) as UsageReport;
  assert.equal(window.totals.leases.admitted, 2); assert.equal(window.totals.leases.failed, 1); assert.equal(window.totals.leases.released, 1);
  assert.equal(window.totals.leases.deviceSeconds, 50 + 200 + 50);
  assert.deepEqual(window.totals.leases.holdSeconds, { p50: 50, p95: 300, samples: 2 });
  // An active lease is counted up to now, never into the future.
  assert.equal((await f.admin(`/v1/admin/usage?${range(1900, 5000)}`)).totals.leases.deviceSeconds, 100);

  for (const [group, key, label] of [["host", f.host, "disposable fixture"], ["platform", "linux", undefined], ["template", "fixture-image@1/amd64", undefined]] as const) {
    const grouped = await f.admin(`/v1/admin/usage?${range(1000, 2000)}&groupBy=${group}`) as UsageReport;
    assert.deepEqual(grouped.rows.map(row => [row.key, row.label]), [[key, label]]);
    assert.deepEqual(grouped.rows[0]!.leases, report.totals.leases);
    // A request has no host until admission, so host grouping reports leases only.
    assert.equal(Object.hasOwn(grouped.rows[0]!, "requests"), group !== "host");
  }
  const filtered = await f.admin(`/v1/admin/usage?${range(1000, 2000)}&application=${slow.id}`) as UsageReport;
  assert.equal(filtered.applicationId, slow.id); assert.deepEqual(filtered.rows.map(row => row.key), [slow.id]); assert.equal(filtered.totals.leases.admitted, 1);

  // Cleanup that was blocked is counted on its lease; proven cleanup leaves the figures unchanged.
  const cleanup = (await f.request("GET", `/v1/leases/${first.id}`)).members[0].cleanup, machine = first.members[0].machineId;
  f.beat({ reports: { [machine]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: first.id, state: "blocked", attempt: 1, reason: "ownership" } } } });
  assert.equal((await f.admin(`/v1/admin/usage?${range(1000, 2000)}`)).totals.leases.cleanupBlocked, 1);

  // The reads are indexed and bounded, because a report runs inside the controller's single write transaction.
  f.store.transaction(db => {
    const plan = (sql: string, ...values: Array<string | number>) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...values).map(row => String(row.detail)).join("; ");
    assert.match(plan("SELECT 1 FROM requests WHERE created>=? AND created<?", 0, 1), /USING COVERING INDEX requests_created/);
    assert.match(plan("SELECT 1 FROM requests WHERE created>=? AND created<? AND application=?", 0, 1, f.app.id), /USING COVERING INDEX requests_application_created/);
    assert.match(plan("SELECT * FROM usage_leases WHERE admitted>=? AND admitted<? AND ended>?", 0, 1, 0), /USING INDEX usage_leases_admitted/);
    assert.match(plan("SELECT * FROM usage_leases WHERE ended IS NULL AND admitted<?", 1), /USING INDEX usage_leases_ended \(ended=\?\)/, "only the leases still held");
    // A lease carried into a range is looked for no further back than the longest hold on record.
    assert.equal(db.prepare("SELECT max_hold FROM usage_state").get()!.max_hold, 300);
    // A range that holds more rows than one report may read is refused before it is read.
    const query = { from: 1000, to: 2000, groupBy: "application" as const };
    assert.equal(usageReport(db, query, 2000, 400 * 86400, 4).totals.leases.admitted, 4);
    assert.throws(() => usageReport(db, query, 2000, 400 * 86400, 3), failure(400, "usage_range_too_large"));
  });
  // The ledger keeps an ended lease for the configured period and never drops an active one.
  f.setNow(1400 + 400 * 86400 + 1); f.observability.maintain(true);
  f.store.transaction(db => assert.deepEqual(db.prepare("SELECT lease FROM usage_leases ORDER BY admitted").all().map(row => row.lease), [fourth.id]));
});

test("request usage counts every outcome and measures wait from submission to admission", async t => {
  const f = observabilityFixture(t), queued = f.application({ activeLeases: 1, maxWaitingRequests: 10 }), denied = f.application({}, []);
  const intent = { templateId: f.image.id, templateRevision: "1", arch: "amd64", ttlSeconds: 3600 };
  const submit = (credential: string, extra: Record<string, unknown> = {}) => { const id = f.leases.requests.submit(credential, { id: randomUUID(), kind: "lease", intent, ...extra }).request.id; f.leases.requests.pass(); return id; };
  const first = submit(queued.credential);                                   // admitted at 1000: waited 0 s
  const second = submit(queued.credential);                                  // waits behind the one-lease limit
  f.setNow(1020); const expiring = submit(queued.credential, { deadline: iso(1050) });
  f.setNow(1030); const cancelled = submit(queued.credential);
  f.setNow(1040); f.leases.requests.cancel(queued.credential, cancelled, {});
  f.setNow(1060); await f.request("POST", `/v1/leases/${first}/release`, { id: randomUUID() }, queued.credential);
  f.beat(); f.leases.requests.pass();                                                  // admits the second: waited 60 s; expires the third
  const rejected = submit(denied.credential);
  f.setNow(1070); const waiting = submit(queued.credential);                 // still waiting when the report is read
  f.setNow(1100);
  const states = Object.fromEntries(f.leases.requests.list(queued.credential).requests.map(r => [r.id, r.state]));
  assert.deepEqual([states[first], states[second], states[expiring], states[cancelled], states[waiting]], ["admitted", "admitted", "expired", "cancelled", "waiting"]);
  const report = await f.admin(`/v1/admin/usage?${range(1000, 1100)}`) as UsageReport;
  const row = (id: string) => report.rows.find(r => r.key === id)!;
  assert.deepEqual(row(queued.id).requests, { submitted: 5, admitted: 2, cancelled: 1, expired: 1, rejected: 0, waiting: 1, waitSeconds: { p50: 0, p95: 60, samples: 2 } });
  assert.deepEqual(row(denied.id).requests, { submitted: 1, admitted: 0, cancelled: 0, expired: 0, rejected: 1, waiting: 0, waitSeconds: { p50: null, p95: null, samples: 0 } });
  assert.equal(states[rejected], undefined);
  // The two admissions are the application's leases: 60 s for the first, 40 s so far for the second.
  assert.equal(row(queued.id).leases.admitted, 2); assert.equal(row(queued.id).leases.released, 1); assert.equal(row(queued.id).leases.active, 1); assert.equal(row(queued.id).leases.deviceSeconds, 100);
  assert.equal(report.totals.requests!.submitted, 6); assert.equal(report.totals.requests!.rejected, 1);
  assert.equal(((await f.admin(`/v1/admin/usage?${range(1000, 1100)}&groupBy=template`)) as UsageReport).rows[0]!.requests!.submitted, 6);
  assert.equal(((await f.admin(`/v1/admin/usage?${range(1025, 1100)}`)) as UsageReport).totals.requests!.submitted, 3, "requests are counted by submission time");

  // An application reads its own figures only, and cannot group by host or name another application.
  const own = (await f.call("GET", `/v1/usage?${range(1000, 1100)}`, {}, queued.credential, undefined)).body as UsageReport;
  assert.equal(own.applicationId, queued.id); assert.deepEqual(own.rows.map(r => r.key), [queued.id]); assert.equal(own.totals.requests!.submitted, 5);
  assert.ok(!JSON.stringify(own).includes(denied.id) && !JSON.stringify(own).includes(f.host));
  await assert.rejects(f.call("GET", "/v1/usage?groupBy=host", {}, queued.credential, undefined), failure(400, "usage_group_unsupported"));
  await assert.rejects(f.call("GET", `/v1/usage?application=${denied.id}`, {}, queued.credential, undefined), failure(400));
  await assert.rejects(f.call("GET", "/v1/usage", {}, f.options.adminToken, undefined), failure(401));
  for (const query of ["from=2026-01-01", `${range(2000, 1000)}`, `${range(0, 401 * 86400)}`, "groupBy=owner", "format=xml", "unexpected=1"]) await assert.rejects(f.admin("/v1/admin/usage?" + query), failure(400), query);

  // CSV carries the same figures, one line per group and a total; spreadsheet formulas in labels are neutralised.
  const csv = (await f.call("GET", `/v1/admin/usage?${range(1000, 1100)}&format=csv`)) as { body: string; contentType?: string };
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  const lines = csv.body.trimEnd().split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "group,key,label,requests_submitted,requests_admitted,requests_cancelled,requests_expired,requests_rejected,requests_waiting,wait_p50_seconds,wait_p95_seconds,leases_admitted,leases_ready,leases_released,leases_expired,leases_failed,leases_active,leases_cleanup_blocked,ready_p50_seconds,ready_p95_seconds,hold_p50_seconds,hold_p95_seconds,device_seconds");
  assert.ok(lines.includes(`application,${queued.id},Fixture application,5,2,1,1,0,1,0,60,2,0,1,0,0,1,0,,,60,60,100`));
  assert.equal(lines.at(-1), "application,total,,6,2,1,1,1,1,0,60,2,0,1,0,0,1,0,,,60,60,100");
  assert.ok(usageCsv({ ...report, rows: [{ ...report.rows[0]!, label: '=cmd|"x",y' }] }).split("\r\n")[1]!.startsWith(`application,${report.rows[0]!.key},"'=cmd|""x"",y",`));
});

test("a lease already active when the ledger is installed keeps its admission time", async t => {
  const f = leaseFixture(t), lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 3600 }));
  f.ready(lease); f.setNow(1500);
  const observability = new Observability(f.store, f.options, f.apps); observability.installCapture();
  f.setNow(1600); await f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() });
  f.setNow(1700);
  const body = (await observability.handle({ method: "GET", path: "/v1/admin/usage", parts: ["v1", "admin", "usage"], query: new URLSearchParams(range(900, 1700)), body: {}, token: f.options.adminToken,
    principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) }))!.body as UsageReport;
  assert.equal(body.totals.leases.admitted, 1); assert.equal(body.totals.leases.deviceSeconds, 600); assert.deepEqual(body.totals.leases.holdSeconds, { p50: 600, p95: 600, samples: 1 });
  // Its readiness happened before the ledger existed and is therefore not claimed.
  assert.equal(body.totals.leases.ready, 0); assert.equal(body.retention.leaseLedgerStartedAt, iso(1500));
});
