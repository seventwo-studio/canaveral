# Durable waiting requests

Applications opt into `/v1/requests` when capacity may be full. Direct lease
acquisition is unchanged: it still returns 503 `capacity_unavailable`. LeaseState
has no waiting value. Application model calls join the same request model as
[queued model calls](#queued-model-calls): `kind: "model-job"` requests share this
envelope, replay, waiting cap, priority, deadline and cancellation, and every
unassigned model job (including direct `/v1/model-jobs` submissions) is admitted in
request order. A preview is a `linux-lease` request with a preview service attached
after admission; see [queued previews](#queued-previews). Embedded administrator
inference (`/v1/jobs`) has no application identity and does not join this queue;
it still fails when no host has capacity.

| Method and route | Result |
| --- | --- |
| POST /v1/requests | 201 for new intent; 200 for exact normalized replay |
| GET /v1/requests | Own requests, at most 100, UUID `after` cursor and `nextCursor` |
| GET /v1/requests/{id} | Current own request |
| POST /v1/requests/{id}/cancel | Empty object; cancel waiting or release admitted lease |

Every route requires the application credential. Another application's UUID is
404, including submission; scoped lease, host and administrator keys cannot act
as application keys. Persist the UUID and complete envelope before sending it.

The envelope has `id`, `kind` (`lease` for the generic host path, `linux-lease`
for approved runner domains or `model-job` for a model call), `intent` (the existing
acquisition body without `id`, or the model-call intent below), integer `priority` (default 0), optional UTC RFC3339 `deadline` and optional
opaque `source` object, limited to 4096 UTF-8 bytes. Source can carry repository,
pull request, commit and run context; it drives no behavior. Unknown fields or
kinds return 400; `request_kind_unsupported` names the supported kinds. The request
UUID becomes the lease or model-job UUID. Do not use it for another direct acquisition.

## States and clocks

`waiting` transitions to `admitted`, `cancelled`, `expired` or `rejected`.
Only admission reserves resources. Waiting stores no credential and no placement.
An admitted response has `target` equal to the lease UUID and `admittedAt`; inspect
that lease for provisioning, runtime and cleanup. Cancellation after admission
keeps the request admitted and releases its lease through the existing lifecycle.
It never certifies cleanup or frees held reservations by itself. Repeated
cancellation is safe. SQLite serializes cancellation and admission: cancellation
wins if it acquires the write boundary while the request is still waiting.

`deadline` bounds waiting only; expiry wins at `now >= deadline`. Lease TTL,
maximum lifetime and provisioning clocks start at admission. Expiry of waiting
intent is evaluated inside the admission transaction. A past deadline produces
an expired request without execution. Revocation cancels the application's
waiting requests and retains the existing lease revocation/cleanup behavior.

## Admission and fairness

The control worker is the single queue owner for lease kinds; runner claims admit
[queued model calls](#queued-model-calls). It already instantiates both generic
and Linux lease implementations. Admission calls those implementations with a live
application lookup, under one BEGIN IMMEDIATE pass; each attempt uses a savepoint.
Grants, allowlists, application limits, health, drains and physical capacity are
therefore checked by the existing acquisition code at admission. A failed attempt
cannot leave a partial reservation or roll back another request's admission.

One admission order covers every waiting `lease` and `linux-lease` request,
whatever image pin, runner domain or host it needs. Each application has one
persisted admission record (`request_admissions`) holding when it was last
admitted by a pass, as a counter. A pass tries candidates by least recently
admitted application first (one never admitted goes before any that was), then
higher priority, then FIFO sequence. Only an admission moves its application to
the back; a refused attempt leaves the order unchanged, so the next candidate is
tried in the same pass. The order is recomputed before every attempt, so an
application admitted earlier in a pass falls behind the others for the rest of it.

What this guarantees: no application waits forever while another keeps being
admitted on capacity it could use. If application B has a request that fits a
free slot when the pass reaches it, and application A was admitted more recently
than B, B's request is tried before any of A's. A therefore cannot keep taking
slots B could use, whether their pins are identical, share one runner domain, or
are approved on overlapping but different domain sets. Admissions of an
application on capacity B cannot use (another pin or domain that B's requests do
not fit) move A to the back as well, which only helps B. With several applications
contending for one slot, they are admitted in turn.

Limits: the order is per application, not per owner, request size or resource.
There is no aging. A request that needs more than any single release frees (a
larger box behind a stream of smaller ones) can wait indefinitely while smaller
requests from other applications fit; the guarantee covers only capacity the
waiting request could use when tried. Within one application, a higher-priority
request that never fits does not block lower-priority ones behind it, and
priority does not reorder applications that have been admitted at different
times. Admissions outside the pass (direct `/v1/leases` acquisition and runner
claims of model calls) do not update the record. When more than 256 candidates
wait, a scan cycle spans several passes and a request refused earlier in the cycle
is next tried in the following cycle, so the guarantee holds per cycle, not per
pass; see the scan continuation below.

A request whose attempt returns 429 or 503 is skipped for the current scan cycle.
For the rest of that pass, so are the application's other waiting requests with the
same normalized intent apart from UUID and name: they would meet the same limit or
capacity. This relies on acquisition never deciding a 429 or 503 from the request
UUID; UUID conflicts are 409. A host drain refusal (`host_draining`), where the
controller has one, skips the group the same way. A large unservable backlog therefore costs one attempt per group, and
servable requests behind it are reached in the same pass. Requests with different
intent, and other applications, remain eligible. An unexpected failure blocks only
its own request. Passes attempt at most 256 requests; a persisted scan continuation
prevents a long unfit prefix of distinct groups from starving the rest of the queue
across passes. Submission, control mutations (including host
heartbeat and limits), identity-worker mutation completion (including approvals,
release and reclamation), startup and a one-second timer trigger passes. SQLite
serializes all ledger writers even when direct acquisitions use another worker.

Administrators set `limits.maxWaitingRequests` (default 100, maximum 1000) and
`limits.maxRequestPriority` (default 0, range 0..1000000) when creating an
application. Existing policies use these defaults. Priority may be negative down
to -1000000; values above the application maximum are rejected with 400
`request_priority_invalid`. Policy remains immutable; changing it follows the
existing application migration contract.

## Replay and failures

Replay compares kind, normalized intent, priority, deadline and source. Object key
order, capability order, default priority and default TTL normalize consistently.
The same UUID and normalized envelope returns its current state; a change returns
409 `request_conflict`. Tombstones are retained. Inspect or replay identical intent
after a lost response; never invent another UUID to resolve an uncertain outcome.

A waiting cap returns actionable 429 `request_waiting_limit`, with retryability
and Retry-After. Cancel outstanding intent or wait before submitting more. This
cap is distinct from admission quota: acquisition 429 and 503 leave intent waiting
for a later pass. Other acquisition ServiceErrors reject only that request; the
stable code appears in `reason`. Missing or removed grants are permanent rejection.
An unexpected failure inside one attempt rolls back only that attempt: the request
stays `waiting` with reason `admission_error` and is tried again in a later round.
A busy database skips the pass; the next timer or event wake retries it. Malformed
intent (unknown or mistyped acquisition fields) returns 400 at submission and does
not consume the UUID; checks that depend on current limits or grants run at
admission and reject with a reason. Ordinary structured errors retain the consumer error and
uncertain-operation contracts. The SDK never automatically retries or polls.

## Queued model calls

A `model-job` request queues one application model call. Its submitted `intent` is
exactly the `model-job/1` submit message without `type`: `{adapter, model, digest,
prompt, maxTokens}`. Other or missing fields return 400 without consuming the UUID.
Prompts are not echoed: the request stores and returns `{adapter, model, digest,
promptDigest, maxTokens}`, where `promptDigest` is `sha256:` and the lowercase hex
SHA-256 of the prompt's UTF-8 bytes. Replay compares that digest, so resending the
same prompt replays and a changed prompt is a 409 `request_conflict`. The job record
keeps the prompt for the runner. The
application needs an active grant for the exact model and digest (403), and the
adapter must match the immutable catalog entry (409); both are checked at submission
because the job record is created with the request. `resources` is the catalogued
per-job reservation. The request UUID is the model-job UUID, so
`GET /v1/model-jobs/{id}` works from submission; its view adds a `request` object
`{state, priority, deadline, reason, admittedAt}`. Nothing is reserved while waiting.

Admission is a runner claim, because only a claim binds an approved physical domain.
The control-worker pass never acquires model calls; it expires them at their
deadline, cancels them on application revocation and rejects them with reason
`model_grant_revoked` when the grant is revoked. Each claim is one transaction:
it first expires every model call whose deadline has passed, then orders the
unassigned, uncancelled model jobs the runner can serve: applications in a
persisted round-robin turn (the next application in UUID order after the last one
admitted on this runner), then higher priority, then FIFO submission order. The turn is kept per runner (`model_job_scheduler`, separate
from the lease admission record), so admissions on a runner that serves other models
cannot starve an application waiting on this one. Each claim considers only the jobs
one runner can serve, so a per-runner turn already ranks only applications competing
for that runner's capacity; the lease pass instead orders every pin together, which
is why it ranks by least recent admission rather than keeping a turn per runner or
domain. The two paths are independent: a model-call admission does not move an
application in the lease order, and a lease admission does not advance a runner's
model turn. Both reserve on the same physical ledger, so on a domain that serves
both, whichever admits first takes the free capacity; neither path orders against
the other. Eligibility (served model and digest,
catalogued adapter, unrevoked application and grant) is decided in the query, and
only the first job of each application, model and digest is considered, because
later ones share its limit and resources. Direct `/v1/model-jobs` submissions take
part at priority 0 without a deadline. The claim skips an application whose admitted, unreleased jobs for that model and digest have reached
the grant's `maxUnfinished` (reason `model_job_limit`), and skips a job whose
catalogued resources do not fit the runner's domain (reason `capacity_unavailable`,
job state `waitingForResources`). The first job that fits is reserved on the domain's
physical ledger, assigned, and marked `admitted` with `target` equal to its UUID, all
in the same transaction. Skipped jobs stay eligible; there is no aging. Waiting never
preempts, shrinks or relocates a held reservation: priority only orders admission.

`waiting` ends as `admitted`, `cancelled`, `expired` or `rejected`. A model call that
ends without admission closes its job without execution: cancellation closes it as
`cancelled`, expiry and rejection as `failed`, each with `stopped: true`,
`cleanup: "complete"` and no assignment. Cancel waiting intent through
`/v1/requests/{id}/cancel`, `/v1/model-jobs/{id}/cancel` or the administrator
request or job cancellation; all use one transition, and expiry still wins at
`now >= deadline`. Cancelling an admitted model call keeps the request `admitted`
and sets the job's `cancelRequested`; its reservation stays held until the bound
runner reports stop and cleanup.

The waiting cap counts model calls with leases. A queued model call is limited at
admission by `maxUnfinished`, not refused at submission. Direct submission keeps its
existing 429 when the application's unfinished jobs (waiting or admitted) for that
grant reach `maxUnfinished`, and creates no request record, so direct jobs are not
listed under `/v1/requests`. A request UUID already used by a direct job, or a direct
submission reusing queued intent with a different submission, returns 409. An
identical direct submission of queued intent replays the job.

## Queued previews

A preview runs a supervised foreground service inside a leased Linux workspace.
Its request is therefore the workspace box: a `linux-lease` request for the preview
image, admitted, reserved and bounded by `maxConcurrentBoxes` exactly like any other
box. The owner attaches the preview service after admission by starting the
`--preview-service` command operation with the rotated lease key; see the
[preview dispatch contract](linux-command-operations.md#preview-dispatch-contract).
There is no separate `preview` kind. The controller holds no preview files or
command: those stay with the owner, so request views never echo them, and
admission needs nothing a box does not already have. A distinct kind would have
duplicated lease admission, placement, the box limit and cleanup, or moved file
upload into the controller.

A preview request therefore follows every rule above: it waits when capacity or
the application's box limit is full, is admitted by least recent application
admission, priority and FIFO,
expires at its deadline, can be cancelled while waiting, and replays by UUID.
Waiting never preempts, shrinks or relocates a running lease. Admission reserves
on the mapped physical ledger in the pass transaction; lease TTL starts at
admission.

[Dashboard previews](dashboard.md#owner-workspace-previews) submit these requests
for their owners and show the request state. All of one dashboard's previews share
its application: the controller's per-application fairness and the waiting cap apply
to the dashboard as a whole. The dashboard bounds each owner's waiting previews and
the priority owners may set, so one owner cannot fill the shared waiting cap or jump
ahead of every other owner; owners are not otherwise scheduled against each other.

## Upgrade and backup boundary

This feature creates only new tables (`requests`, `request_scheduler`,
`request_scan`, `model_job_scheduler`, `request_admissions`) and partial indexes
for waiting order and deadline. Each pass also builds a connection-local temporary
table of its candidates and their groups, indexed by request and group; it is
never persisted. It neither alters nor converts existing tables; queued model calls add
rows to the existing `model_jobs` table in its current schema. Old databases and old application policy JSON
remain usable.

Interim builds of this change kept turns per image pin (`request_pool_turns`) and
per capacity unit (`request_unit_turns`); this version drops both tables at
startup, since admission order is disposable. A controller from before
`request_admissions` ignores it and orders leases by the global turn in
`request_scheduler`, which this version no longer advances; waiting requests and
held reservations are unaffected. Downgrading after
the first queued model call is unsupported. An older controller
does not know the `model-job` kind and rejects the waiting request, but its FIFO claim
still finds the open job in `model_jobs` and runs it, outside the request's priority,
deadline and cancellation. Held reservations, application/runner identities, assignment and
mutation receipts remain authoritative across upgrade and restart. Queue order,
scan position and request tombstones are durable in the same SQLite database.

Back up the complete database at a quiescent controller boundary before cutover,
including existing ledgers and the new queue tables. Never restore a queue without
its lease/reservation ledgers, run an older writable controller concurrently, or
infer reclamation from a request state. Fixture upgrade/reopen checks are not an
operator backup/restore exercise or native execution acceptance.

## Opt-in example

```ts
const { request } = await client.submitRequest({
  id: persistedUuid, kind: "linux-lease",
  intent: { templateId: "linux-dev", templateRevision: "1", arch: "amd64", ttlSeconds: 600 },
  deadline: "2026-12-01T12:00:00Z", source: { repository: "team/project", run: "42" },
});
// Later, explicitly inspect; the SDK does not poll.
const current = await client.inspectRequest(request.id);
```

### Queued model-call example

```ts
const { request } = await client.submitRequest({
  id: persistedUuid, kind: "model-job", priority: 0,
  intent: { adapter: "ollama", model: "your-model:latest", digest: "sha256:…", prompt, maxTokens: 600 },
  deadline: "2026-12-01T12:00:00Z",
});
```

Applications need `limits.maxRequestPriority` above 0 to submit positive priority.
Portable fixtures cover waiting, admission, priority, fairness, limits, deadline,
cancellation, replay, lost responses, restart and non-displacement; they do not
establish native model execution or measured resource fit.

### Linux workspace box concurrency

A box is a queued `linux-lease` request for an approved workspace image; it is not a new request kind. Administrator application `limits.maxConcurrentBoxes` is an optional positive safe integer, defaulting to `activeLeases` and normalized in administrator responses. Existing stored policies remain valid. It counts Linux workspace leases from admission until their held reservation is released, including released, expired or failed leases awaiting positive cleanup (`workspaceRemoved` and `dataPlaneClosed`). Direct acquisition and queued admission enforce it under the same write lock. Over-limit requests wait without a reservation; direct acquisition returns 429. `activeLeases` keeps its existing meaning.
