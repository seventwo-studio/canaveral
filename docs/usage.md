# Usage reporting

Implemented in the TypeScript controller and verified by portable fixtures with a
scripted clock. The figures describe controller state: what was requested, admitted
and held. They are not measured device utilisation, and no native runtime took part.

A usage report answers, for a time range: how many requests were submitted and how
they ended, how long admitted requests waited, how many leases were admitted, how
long they took to become ready, how long they were held, how many failed, and how
many device-seconds were consumed. It groups by application, template, platform or
host and is available as JSON or CSV.

## Where the figures come from

| Figure | Source | Retention |
| --- | --- | --- |
| Requests and wait time | The `requests` ledger | The controller does not prune request records |
| Leases, time to ready, hold time, device-seconds | The `usage_leases` ledger | `usageRetentionSeconds` after the lease ends, default 400 days |

Neither lease ledger stores when a lease became ready or ended. `usage_leases` keeps
one small row per lease with those times. It is updated from lease
[events](events.md) in the transaction that records them, so it is as durable as the
lease itself, and it is kept much longer than the event log. An active lease is
never removed from it.

The ledger starts when a controller with this feature first opens the database. Each
report states that time as `retention.leaseLedgerStartedAt`. Leases that were active
at that moment are included with their true admission time; their time to ready is
unknown and is not counted. Leases that had already ended are not in the ledger.

Set `usageRetentionSeconds` (86400 to 158112000) under `observability` in the
controller configuration.

## Definitions

Counts and percentiles describe the cohort that started in the range `[from, to)`.

- **Requests** are counted by submission time. `submitted` is every request;
  `admitted`, `cancelled`, `expired`, `rejected` and `waiting` are their states now.
- **Wait** is admission time minus submission time, over admitted requests.
- **Leases** are counted by admission time. `released`, `expired` and `failed` are
  how they ended; `active` have not ended; `ready` became ready at least once.
- **Time to ready** is the first ready time minus admission time.
- **Hold** is end time minus admission time, over ended leases.
- **Cleanup blocked** counts leases whose cleanup was blocked at least once.
- **Failures** are `leases.failed`, `leases.cleanupBlocked` and `requests.rejected`.

`deviceSeconds` is different: it is the lease time that falls inside the range,
whenever the lease was admitted. A lease admitted before `from` contributes its part
after `from`. An active lease is counted up to now, never into the future. A lease
holds its reservation until cleanup is proven; device-seconds end when the lease
ends, not when cleanup completes.

Percentiles use the nearest-rank method on the samples in the group. With no sample
the value is `null`. `samples` gives the count, so a p95 over three leases can be
read for what it is.

Grouping by `host` reports leases only, because a request has no host before it is
admitted. A Linux workspace lease is placed on a resource domain; it is reported
under the host that domain is bound to, or as `domain:<id>`. `template` keys are
`id@revision/arch`; queued model calls appear as `model:<name>`. `platform` is the
template's operating system, `linux` for workspace leases and `model` for model
calls.

Direct acquisitions that were refused are not counted. They appear as throttled
`lease.refused` events only.

## Routes

| Method and path | Credential | Result |
| --- | --- | --- |
| `GET /v1/admin/usage` | Administrator | Usage across all applications |
| `GET /v1/usage` | Application | That application's own usage |

| Parameter | Meaning |
| --- | --- |
| `from`, `to` | UTC RFC3339. Default: the 24 hours before now. At most 400 days |
| `groupBy` | `application` (default), `template`, `platform`, or `host` for administrators |
| `format` | `json` (default) or `csv` |
| `application` | Administrator route only: restrict to one application |

An invalid range returns 400 `usage_range_invalid`; an unsupported grouping returns
400 `usage_group_unsupported`. A range that holds more than 200,000 requests and
leases together returns 400 `usage_range_too_large`: ask for a shorter range and
add the reports up. The application route is filtered in SQL to the
authenticated application. It never shows another application's figures or host
identities.

```json
{
  "from": "2026-11-20T00:00:00.000Z", "to": "2026-11-21T00:00:00.000Z", "groupBy": "application",
  "generatedAt": "2026-11-21T09:14:03.512Z",
  "retention": { "requestRecords": "not pruned", "leaseLedgerSeconds": 34560000, "leaseLedgerStartedAt": "2026-11-01T08:00:00.000Z" },
  "rows": [{
    "key": "9415f91b-569d-4d93-a09d-8f7f903a8463", "label": "Build agent",
    "requests": { "submitted": 40, "admitted": 36, "cancelled": 2, "expired": 1, "rejected": 0, "waiting": 1, "waitSeconds": { "p50": 4, "p95": 212.5, "samples": 36 } },
    "leases": { "admitted": 41, "ready": 39, "released": 30, "expired": 8, "failed": 2, "active": 1, "cleanupBlocked": 1, "deviceSeconds": 51840,
      "timeToReadySeconds": { "p50": 38.2, "p95": 71, "samples": 39 }, "holdSeconds": { "p50": 900, "p95": 3600, "samples": 40 } }
  }],
  "totals": { "key": "total", "requests": { "...": "same shape" }, "leases": { "...": "same shape" } }
}
```

CSV has one header line, one line per group and a final `total` line, with CRLF line
endings and these columns:

```text
group,key,label,requests_submitted,requests_admitted,requests_cancelled,requests_expired,requests_rejected,requests_waiting,wait_p50_seconds,wait_p95_seconds,leases_admitted,leases_ready,leases_released,leases_expired,leases_failed,leases_active,leases_cleanup_blocked,ready_p50_seconds,ready_p95_seconds,hold_p50_seconds,hold_p95_seconds,device_seconds
```

An empty cell means no value. A label that starts with a spreadsheet formula
character is prefixed with an apostrophe.

## SDK and CLI

```ts
const report = await client.usage({ from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z", groupBy: "template" });
```

```sh
canaveral --token-file admin.token usage --last 7d --group-by host
canaveral --token-file admin.token usage --from 2026-11-01T00:00:00Z --to 2026-12-01T00:00:00Z --format csv > november.csv
canaveral --token-file app.key usage --own --format json
```

`usage` prints a table by default. `--format json` prints the report and `--format
csv` the same CSV the route returns. `--last` takes hours or days, such as `24h` or
`7d`. `--own` reads the application view with an application credential.

## Cost of a report

A report is computed inside the controller's single write transaction, so it is
bounded and indexed rather than free:

- Requests are read through indexes on `requests(created)` and
  `requests(application, created)`. The controller adds them to the request ledger
  at startup; that ledger belongs to the waiting-request module and is never
  pruned, so without them every report would read all of it.
- Leases are read through indexes on the usage ledger. A lease carried into the
  range from before it is found by looking back no further than the longest hold
  the ledger has ever recorded.
- The rows are counted first, stopping just past the limit, so an oversized range
  is refused for about the cost of the limit.

What remains: a report at the limit still reads up to 200,000 rows and sorts their
wait and hold times in memory while other controller requests wait. On the fixture
machine that is well under a second; it has not been measured on a production
database. One very long lease raises the look-back for every later report.

## Limits

- Figures are what the controller recorded. Device-seconds are held lease time, not
  CPU, memory or power measured on a host.
- A report is read in one transaction but is not a billing record. Request records
  are never pruned by the controller; an operator who removes them changes history.
- Administrative machines that are not leased, embedded inference jobs and model job
  run time are not part of usage.
- There is no per-owner or per-source breakdown. `source` on a request drives no
  figure.
- The dashboard's Usage page shows the administrator report and downloads the
  same CSV; see [the dashboard contract](dashboard.md#queue-activity-and-usage).
  The gateway forwards `/v1/admin/usage` only, not the application route.
