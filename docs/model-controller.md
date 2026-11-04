# TypeScript model-job controller slice

`coordination/src/model-jobs.ts` adds an application-owned `model-job/1` ledger to the
TypeScript controller's owned SQLite worker and HTTP handler. Runner execution happens
outside the controller: the runner pulls work over the outbound runner routes below.
This slice contains no executor, model download/load, VM placement or native evidence.
It is a component of the model lifecycle. The lifecycle is not complete or accepted
until a runner executor is wired to these routes and end-to-end fixture and native gates
are reported separately.

## Running the controller

```sh
npm --prefix coordination ci --ignore-scripts
npm --prefix coordination run build
node coordination/dist/src/main.js /absolute/controller-config.json
```

```json
{ "statePath": "/absolute/state/controller.sqlite", "adminTokenFile": "/absolute/secrets/admin.token",
  "controllerId": "<stable UUID>", "listen": { "host": "127.0.0.1", "port": 8443 },
  "tls": { "certFile": "/absolute/tls/cert.pem", "keyFile": "/absolute/tls/key.pem" } }
```

Every field except `tls` is required, and unknown fields are refused. Paths must be
absolute. `listen.host` must be an IP literal. Plain HTTP is allowed only on loopback.
Any other address needs `tls`, served with TLS 1.2 or later. The process starts one
owned SQLite worker and one listener, prints `{"listening":{"host","port"}}` on stdout,
and stops on SIGTERM/SIGINT. It never selects state, imports legacy hosts or starts a
runtime by itself. Keep the database and `controllerId` together (see
[runner enrollment](runner-enrollment.md)). Run only one controller process per
database in deployment; the multi-process fixture below exists only to exercise SQLite
serialization. Do not share writable state with the Python controller.

## Authority

| Role | Proof | Routes |
| --- | --- | --- |
| Administrator | Operator token or account session | Catalog, domains, grants, runner approvals |
| Application | Application credential (`/v1/consumers`) | Submit, inspect, cancel its own jobs |
| Runner | Current runner credential plus exact `binding` | Claim, list assignments, report |

Each credential is checked again inside the same `BEGIN IMMEDIATE` transaction as the
effect. A revocation that commits first therefore wins. Credentials never cross roles.
Another application's job looks the same as a missing one (404). A binding is
`{controllerId, runnerId, generation, incarnationId}` from enrollment.

## Operator configuration (administrator)

All routes are POST with an exact JSON object. Repeating an identical definition is a
replay. A changed definition is a 409; entries are immutable in this slice.

| Route | Body | Effect |
| --- | --- | --- |
| `/v1/model-catalog` | `{model, digest, adapter: "ollama", resources: {cpu, memoryMiB, diskGiB}}` | Pins a model label and digest with a per-job reservation size |
| `/v1/resource-domains` | `{id, name, capacity: {cpu, memoryMiB, diskGiB}}` | Defines one physical capacity budget. This activates nothing on its own |
| `GET /v1/resource-domains/{id}` | — | `{id, name, capacity, reserved, available, reservations}` |
| `/v1/model-grants` | `{applicationId, model, digest, maxUnfinished}` | Lets one unrevoked application submit one catalogued model. `maxUnfinished` is 1–1024 |
| `/v1/model-grants/revoke` | `{applicationId, model, digest}` | Blocks new submissions and claims of that application's unclaimed jobs for that model |
| `/v1/model-runner-approvals` | `{binding, domainId, models: [{model, digest}]}` | Maps one current binding to one domain and its catalogued models |
| `/v1/model-runner-approvals/revoke` | `{binding}` | Blocks new claims. Existing assignments keep their reservations and report authority |

Several bindings can map to one domain; that is how two runner identities share one
physical host's budget. Approvals belong to one generation. A reenrolled runner inherits
no approval, and approving a revoked or superseded binding is refused. Nothing is
discovered or approved automatically.

## Application routes

| Route | Body | Result |
| --- | --- | --- |
| `POST /v1/model-jobs` | `model-job/1` submit envelope | `201 {created: true, job}` for a new job; `200 {created: false, job}` for an exact replay |
| `GET /v1/model-jobs/{id}` | — | `job` view |
| `POST /v1/model-jobs/{id}/cancel` | `{version: 1, applicationId, id, message: {type: "cancel"}}` | `job` view |

`applicationId` must be the authenticated application (otherwise 403). The submission
needs an active grant for its exact model and digest (403). Unfinished jobs per grant
are bounded (429). The idempotency key is `(applicationId, id)`. A changed submission
under an existing key is a 409 and never runs again. After a lost reply, resend the
identical submission.

A job view has `version, applicationId, id, model, digest, maxTokens, state,
cancelRequested, stopped, cleanup, assignment, reservationHeld, createdAt, updatedAt`.
It includes `result` only on success. Prompts are not echoed. `assignment` is one of
`none`, `current`, `released` or `revoked`. With `revoked`, the bound runner binding
was revoked or superseded. Its unfinished work is then reported as `unknown` and keeps
its reservation.

Cancellation is an intent. An unclaimed job is cancelled in the same transaction that
excludes every claim, so the cancellation itself is the positive evidence that nothing
ran: `cancelled`, `stopped: true`, `cleanup: "complete"`. For a claimed job, the
controller records the request and delivers it to the runner. Its reservation is kept
until the runner reports a stop and completed cleanup.

## Runner wire interface

Every route is a POST with `Authorization: Bearer <runner credential>`, a single
`Content-Length`, a JSON object of at most 1 MiB and no `Origin` header. Each request
has a 20-second deadline. Errors use `{error, message, code, requestId, retryable,
outcome?}`. A 4xx is a definite rejection. A 503 or any lost reply leaves the effect
uncertain.

`Assignment = {id, claimId, domainId, sequence, closed, cancelRequested, job}`. Here
`job` is the stored `model-job/1` submit envelope, including the prompt; `sequence` is
the last accepted report number (0 before any report).

| Route | Body | 200 result |
| --- | --- | --- |
| `/v1/runners/model-jobs/claim` | `{binding, claimId}` | `{assignment: Assignment \| null}` |
| `/v1/runners/model-jobs/assignments` | `{binding}` | `{assignments: Assignment[]}`: unreleased assignments of this exact binding |
| `/v1/runners/model-jobs/report` | `{binding, assignmentId, sequence, receipt}` | `{assignmentId, sequence, state, cancelRequested, stopped, cleanup, released}` |

**Claim.** Persist `claimId` (a UUID) before sending it. The claim runs as one
transaction:

- It returns the existing assignment if `claimId` is already recorded for this binding.
  A `claimId` recorded for another binding is a 409.
- It requires an unrevoked approval for this exact binding (otherwise 403) and fewer
  than 32 unreleased assignments.
- It selects the oldest unclaimed, uncancelled job whose model and digest the approval
  serves, whose application is unrevoked and whose grant is active.
- It reserves that job's catalogued resources in the approval's domain only if they fit
  beside every reservation held there, including other runners' reservations in the
  same domain.

If the oldest eligible job does not fit, it becomes `waitingForResources`, nothing
overtakes it on this runner, and the result is `null`. A `null` result records nothing,
so replaying that `claimId` may claim later. After an uncertain claim, list the
assignments or replay the same `claimId`. Do not send a fresh `claimId` to make up for
an uncertain one.

**Execute.** Execute only `job.message` with `adapter: "ollama"`. Resolve the
`model`/`digest` pair against operator-installed local inventory. Never download a
model or treat the label as a path or URL. Use `cancelRequested` from claim or from the
assignment listing as cancellation intent.

**Report.** `receipt` is a `model-job/1` receipt with the assignment's `applicationId`
and job `id`. A successful `result.model` must equal the submitted model. `sequence`
starts at 1 and advances by exactly one.

- Persist each `(sequence, receipt)` before sending it.
- Resending the last accepted sequence with an identical receipt (key order does not
  matter) is an exact replay and returns the current view.
- A different receipt at that sequence, a skipped or stale sequence, or a new report
  after release returns 409.

Accepted receipts must also follow these rules:

1. `queued`/`waitingForResources` < `running` < `unknown` < terminal. A state never
   regresses, and `unknown` cannot return to `running`.
2. A terminal state and successful result are fixed. Later reports can only add
   `stopped: true`, then `cleanup: "complete"`.
3. `cancelRequested: true` is accepted only after the application requested
   cancellation. `cancelled` also needs `stopped: true`.
4. Report `unknown` whenever the outcome cannot be positively established. Never rerun
   the job. A later terminal report from the same binding with positive evidence can
   still reconcile it.
5. Only a terminal receipt with `stopped: true` and `cleanup: "complete"` from the
   current binding the assignment was claimed under releases the reservation
   (`released: true`) and closes the assignment.

The other errors:

- A report signed with another binding's credential is a 401.
- A report from a valid binding other than the assignment's is a 403. This includes a
  reenrolled newer generation.
- A revoked binding cannot report at all, so its unfinished work stays `unknown` and
  reserved until operator reconciliation. That reconciliation is not implemented.

## Reservations and limits

`resource-domains.ts` is a generic primitive: `reserve(db, {id, domain, kind, owner,
resources})` holds an amount only if it fits within the domain capacity. `release(db,
id, owner)` requires the recorded owner. Both run inside the caller's transaction.
Model assignments and [Linux lease admission](linux-lease-controller.md#reservations-and-limits) reserve here.
These domains are separate from the legacy `hosts`/`resource_budgets`/`inference_jobs`
ledger. Do not offer the same physical capacity to both.

Only additive tables are created: `resource_domains`, `resource_reservations`,
`model_catalog`, `model_grants`, `model_runner_approvals`, `model_jobs` and
`model_assignments`. Legacy rows are not read, converted or adopted.

The controller has no background timer, retry, relocation or reassignment. Elapsed time
or a lost connection never changes a job. The following are not implemented:

- Prompt/result retention and deletion
- Operator reconciliation of revoked runners' work
- Mutable domains and catalog entries
- Fairness beyond strict per-runner FIFO
- Streaming

## Verification

```sh
npm --prefix coordination run typecheck
npm --prefix coordination run build
npm --prefix coordination test
```

`coordination/test/model-controller.test.ts` starts real `main.js` controller processes
on a disposable SQLite file over loopback HTTP. It covers:

- Eight concurrent claims from two runners sharing one domain, split across two
  independent controller processes: exactly one reservation results.
- A reply-dropping proxy for submit, claim and report, with exact replay after
  SIGKILL restarts.
- Unclaimed and claimed cancellation, and `unknown` retention across restart.
- Release only after bound stop and cleanup.
- Cross-application, cross-runner, role, revoked-binding and newer-generation denial.
- Preservation of retained legacy rows.

These fixtures are source evidence only. They do not show runner execution, native
model inference, measured resource fit, TLS deployment or release acceptance.
