# TypeScript model-job controller slice

`coordination/src/model-jobs.ts` adds an application-owned `model-job/1` ledger to the
TypeScript controller's owned SQLite worker and HTTP handler. Runner execution happens
outside the controller: the runner pulls work over the outbound runner routes below.
The [Rust model executor](rust-model-execution.md) claims and reports work through
these routes and owns the local runtime process. The public API integration
fixture covers the controller-to-executor lifecycle. Model installation, VM
placement and native runtime acceptance are outside this controller slice;
portable fixture results and native acceptance remain separate.

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

`tls` and `enrollmentTokenFile` are optional; other fields are required, and unknown
fields are refused. `enrollmentTokenFile` enables the separate compatibility host
enrollment flow; bound Rust runners use explicit runner approval. Paths must be
absolute. `listen.host` must be an IP literal. Plain HTTP is allowed only on loopback.
Any other address needs `tls`, served with TLS 1.2 or later. The process starts identity and control workers on the same selected SQLite
database and one listener, prints `{"listening":{"host","port"}}` on stdout,
and stops on SIGTERM/SIGINT. It never selects state, imports legacy hosts or starts a
runtime by itself. Keep the database and `controllerId` together (see
[runner enrollment](runner-enrollment.md)). Run only one controller process per
database in deployment; the multi-process fixture below exists only to exercise SQLite
serialization. Do not share writable state with an older controller. Validate schema compatibility and credential authority before cutover.

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
| `/v1/model-catalog` | `{model, digest, adapter, resources: {cpu, memoryMiB, diskGiB}}` | Pins a supported adapter (`ollama`, `llama.cpp`, `vllm`, `mlx`), model label and digest with a per-job reservation size |
| `/v1/resource-domains` | `{id, name, capacity: {cpu, memoryMiB, diskGiB}}` | Defines one physical capacity budget. This activates nothing on its own |
| `GET /v1/resource-domains/{id}` | — | `{id, name, capacity, reserved, available, reservations}` |
| `/v1/model-grants` | `{applicationId, model, digest, maxUnfinished}` | Lets one unrevoked application submit one catalogued model. `maxUnfinished` is 1–1024 |
| `/v1/model-grants/revoke` | `{applicationId, model, digest}` | Blocks new submissions. In the same transaction, rejects that application's waiting queued model calls for the model and closes its unclaimed direct jobs as `failed` without execution. Claimed work keeps its reservation |
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

To queue a model call with priority, a deadline and source context, submit a
`model-job` request to `/v1/requests` instead; see
[queued model calls](requests.md#queued-model-calls). It creates the same job record.

`applicationId` must be the authenticated application (otherwise 403). The submission
needs an active grant for its exact model and digest (403), and its adapter must
match the immutable catalog entry (409). Unfinished jobs per grant
are bounded (429), counting waiting and admitted jobs. The idempotency key is `(applicationId, id)`. A changed submission
under an existing key is a 409 and never runs again. After a lost reply, resend the
identical submission.

A job view has `version, applicationId, id, model, digest, maxTokens, state,
cancelRequested, stopped, cleanup, assignment, reservationHeld, createdAt, updatedAt`.
It includes `result` only on success, and `request: {state, priority, deadline,
reason, admittedAt}` only for a queued model call. Prompts are not echoed. `assignment` is one of
`none`, `current`, `released` or `revoked`. With `revoked`, the bound runner binding
was revoked or superseded. Its unfinished work is then reported as `unknown` and keeps
its reservation.

Cancellation is an intent. An unclaimed job is cancelled in the same transaction that
excludes every claim, so the cancellation itself is the positive evidence that nothing
ran: `cancelled`, `stopped: true`, `cleanup: "complete"`. A queued model call's
request becomes `cancelled` in the same transaction, unless its deadline has passed,
in which case it expires and the job closes as `failed`. For a claimed job, the
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
| `/v1/runners/model-jobs/claim` | `{binding, claimId, adapter?}` | `{assignment: Assignment \| null}` |
| `/v1/runners/model-jobs/assignments` | `{binding}` | `{assignments: Assignment[]}`: unreleased assignments of this exact binding |
| `/v1/runners/model-jobs/report` | `{binding, assignmentId, sequence, receipt}` | `{assignmentId, sequence, state, cancelRequested, stopped, cleanup, released}` |

**Claim.** Persist `claimId` (a UUID) before sending it. The claim runs as one
transaction:

- It returns the existing assignment if `claimId` is already recorded for this binding.
  A `claimId` recorded for another binding or another adapter is a 409.
- It requires an unrevoked approval for this exact binding (otherwise 403) and fewer
  than 32 unreleased assignments.
- `adapter` defaults to `ollama` for compatibility. Explicit values use the same
  four identifiers as the catalog. The runner persists its adapter with its claim
  intent and cannot change it when resolving an uncertain claim.
- It first expires every queued model call whose deadline has passed.
- It considers unclaimed, uncancelled jobs whose model and digest the approval
  serves, whose catalog entry uses the requested adapter, whose application is
  unrevoked and whose grant is active. These checks run in the query, so jobs this
  runner cannot serve never crowd out jobs it can. Only the head job of each
  application, model and digest is read: later jobs share its limit and resources, so
  they cannot be admitted before it. Heads are taken in
  [request order](requests.md#queued-model-calls): this runner's persisted
  per-application round-robin turn, then priority (direct submissions are 0), then
  FIFO submission order. Each runner keeps its own turn, so admissions on a runner
  that serves other models do not reset it. There is no candidate cap: claim cost
  grows with the number of open jobs, held under the write lock (about 230 ms at
  100,000 open jobs in an in-memory benchmark). Skip-reason writes use the
  `(application, model, digest, closed)` index, so they touch only that group.
- It skips an application whose admitted, unreleased jobs for that model and digest
  have reached the grant's `maxUnfinished`.
- It reserves the first remaining job's catalogued resources in the approval's domain
  only if they fit beside every reservation held there, including other runners'
  reservations and, for a mapped host, the host's own charges. A job that does not
  fit becomes `waitingForResources` and is skipped; a later job that fits may be
  admitted. Nothing held is preempted, shrunk or moved.

The result is `null` when nothing fits. A `null` result records no assignment, so
replaying that `claimId` may claim later. It may still expire overdue queued calls
and record skip reasons on the waiting jobs behind a skipped head: `waitingForResources`
on the job and, for queued calls, the request `reason`. After an uncertain claim, list the
assignments or replay the same `claimId`. Do not send a fresh `claimId` to make up for
an uncertain one.

**Execute.** Execute only the bound `job.message` with the runner’s configured
adapter. Resolve the `model`/`digest` pair against verified local inventory,
including pinned artifact bytes for llama.cpp/vLLM/MLX. Runtime provisioning
finishes before claim; generation never downloads a model or treats its public
label as a path or URL. Use `cancelRequested` from claim or from the
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
These domains are separate from the legacy `hosts`/`host_limits`/`inference_jobs`
ledger. Do not offer the same physical capacity to both.

Only additive tables are created: `resource_domains`, `resource_reservations`,
`model_catalog`, `model_grants`, `model_runner_approvals`, `model_jobs`,
`model_assignments` and `model_job_scheduler` (one round-robin turn per runner), plus the shared `requests` tables.
Legacy rows are not read, converted or adopted.

The controller has no retry, relocation or reassignment. Elapsed time or a lost
connection never changes a claimed job. The only timer is the request pass, which
closes unclaimed queued model calls at their deadline, on application revocation or
on grant revocation. Revoking an application or a grant also closes that
application's unclaimed direct jobs in the revoking transaction: `cancelled` for an
application, `failed` for a grant, each with `stopped: true` and `cleanup: "complete"`.
Direct jobs left open by revocations made before this rule existed are closed the
same way once, when the controller starts. The following are not implemented:

- Prompt/result retention and deletion
- Operator reconciliation of revoked runners' work
- Mutable domains and catalog entries
- Aging or reservation for large jobs skipped in favour of smaller ones that fit
- Queueing for embedded administrator inference (`/v1/jobs`)
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
- Queued model calls: waiting when full and admission when capacity frees, priority
  and FIFO with direct submissions, per-application turns and limits, the waiting
  cap, deadline expiry, cancellation from each route, exact replay and 409 on
  change, a dropped submission reply, waiting across restart, grant and application
  revocation, and no displacement of a running job.
- Fairness across two runners serving different models, a claim behind more than
  4,096 open jobs the runner cannot serve, and closing unclaimed direct jobs on
  application and grant revocation.

These fixtures are source evidence only. They do not show runner execution, native
model inference, measured resource fit, TLS deployment or release acceptance.
