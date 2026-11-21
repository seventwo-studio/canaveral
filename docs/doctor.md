# canaveral doctor

`canaveral doctor` is a read-only diagnosis of one controller. It reports what is
wrong, or about to be, with a stable code and a next step for each finding. It is
verified by portable fixtures against a loopback controller; it has not been run
against a production controller as part of this work.

```sh
canaveral --url https://controller.example.com --token-file admin.token doctor
canaveral --url https://controller.example.com --token-file admin.token doctor --json
```

It exits 0 when there are no findings and 1 when there is at least one, including a
notice. A waiting request or a host in maintenance is a finding: `doctor` answers
"is there anything to look at", not only "is something broken". Use `--json` and
the `severity` field to decide what should fail a script.

## What it does, and does not do

1. One unauthenticated `GET /healthz` to the controller origin, with the default
   trust store. It sends no credential.
2. One `GET /v1/admin/diagnosis` with the credential file.

Both are reads. `doctor` never sends a POST. The controller computes the diagnosis
on a separate read-only SQLite connection, so it cannot write, take the write lock
or advance a lifecycle, whatever it finds. Checking the credential uses the same
path as any other read route.

A diagnosis reads the ledgers as they are. It does not contact hosts, repeat an
operation or decide an uncertain outcome. A finding about a host says what the host
last reported, not what is true on that machine now.

Controller state is examined only with administrator authority: the operator
credential, an administrator session or a token with the `admin` scope.

## Output

```text
Canaveral doctor: https://controller.example.com
ok   controller: reachable over TLSv1.3; certificate valid until 2027-02-01T00:00:00.000Z
ok   credential: accepted with administrator authority
examined 3 hosts, 5 active leases, 1 waiting requests, 0 update jobs, 1 alert destinations
2 findings:
[error] lease_cleanup_blocked: Cleanup of lease b7682a27-... is blocked (storage_removal) after 3 attempts.
    next: Inspect the lease and its host for the reported reason. ...
[notice] request_waiting: Request 0d6c... (lease) has waited 42s; last admission answer: capacity_unavailable.
    next: No eligible host has capacity. ...
```

`--json` prints `{controller, ok, checks, findings, checked, omitted, generatedAt}`.
Each finding is `{code, severity, subject: {type, id}, summary, nextStep, details}`.
Severity is `error`, `warning` or `notice`; findings are ordered in that order. At
most 50 findings are listed per category and `omitted` counts the rest.

## Findings

Connection and credential findings are produced by the CLI. The others come from
controller state.

| Code | Severity | Meaning | Next step |
| --- | --- | --- | --- |
| `controller_unreachable` | error | Nothing answered `GET /healthz` at the origin | Check the service, the origin and the route to it |
| `controller_tls_untrusted` | error | The certificate was not accepted by the default trust store | Reissue the certificate for this name; never skip verification |
| `controller_tls_expiring` | warning | The certificate expires within 14 days | Renew it; the controller reloads TLS files without a restart |
| `controller_plain_http` | warning or error | The origin is plain HTTP outside loopback | Configure `tls` or a TLS terminator and use the HTTPS origin |
| `credential_missing` | error | No `--token-file` was given | Supply an administrator credential file |
| `credential_rejected` | error | The controller answered 401 | Sign in again or use a current credential |
| `credential_not_administrator` | error | The controller answered 403 | Use an operator credential or an administrator scope |
| `diagnosis_unavailable` | error | The controller did not return a diagnosis | Check the controller version and its storage |
| `host_offline` | error | No heartbeat for 30 seconds or more | Check the host service and its route; reservations stay held |
| `host_draining` | notice | The host refuses new placements | `canaveral accept HOST` when it should take work again |
| `host_maintenance` | notice | A maintenance drain is active | `canaveral maintenance status HOST`, then resume |
| `host_checks_failed` | error | Environment checks failed; names up to five failing checks | Repair the prerequisites and request a check run |
| `host_checks_stale` | warning | The last check result is older than 120 seconds | Request a check run; restart the host service if it does not refresh |
| `host_checks_missing` | notice | The runner reports no environment checks | Upgrade the runner |
| `lease_cleanup_blocked` | error | A lease's cleanup is blocked; reservations stay held | Inspect the reported reason on the host; do not remove storage by hand |
| `lease_cleanup_pending` | warning | A lease ended over 15 minutes ago and cleanup is unproven | Check that its host or runner is reporting |
| `operation_outcome_unknown` | warning | A device or command operation ended `unknown` in the last 24 hours | Inspect the device or workspace; never replay it |
| `install_outcome_unknown` | error | An uploaded-app install is `unknown` and unresolved | Inspect, then `canaveral operation ID --resolve-file FILE` |
| `request_waiting` | notice | A request is waiting; names its last admission answer | Depends on the answer: capacity, limits or drain |
| `request_waiting_long` | warning | It has waited past `requestWaitAlertSeconds` | The same, sooner |
| `update_job_uncertain` | error | A host update job has an uncertain outcome | Inspect the host's installed release before another rollout |
| `update_job_failed` | warning | A job failed or rolled back in the last 24 hours | Read its component states, fix the host, start a new rollout |
| `update_job_active` | notice | A job is in progress | Wait; the host admits no new work meanwhile |
| `alert_delivery_failing` | warning | Alerts to a destination failed in the last 24 hours | `canaveral alerts test ID`, then check the receiver |

An offline host is reported as offline only; what it last said about its checks is
not repeated. An uncertain install stops being a finding when an operator resolves
it or when its leased emulator's cleanup is proven.

Stable [error codes](error-codes.md) returned by routes are a separate catalogue.

## Limits

- `doctor` checks the controller you point it at. It does not log in to hosts or run
  their environment checks; `canaveral host --check` does that on a host.
- TLS is checked against the default trust store only. A controller behind a private
  certificate authority is reported as untrusted.
- Findings describe ledger state. They do not establish that a runtime stopped, that
  storage was removed or that a host is healthy.
- The route is not forwarded by the dashboard gateway.
