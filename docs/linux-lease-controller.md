# TypeScript Linux lease controller slice

`coordination/src/linux-leases.ts` adds headless Linux guest leases to the TypeScript
controller's owned SQLite worker and HTTP handler. It implements the application/lease
subset of the [consumer HTTP contract](consumer-api.md) that the
[TypeScript consumer SDK](consumer-sdk.md) uses, plus operator configuration and an
outbound runner wire. It is provider-neutral across two execution backends that host
a Linux guest: `kubevirt` and `appleVirtualization` (a Linux guest on Apple
Virtualization; this is not macOS guest scope). It contains no VM executor, image
ingestion, PTY or file path, and no native evidence. Its experimental
[command operation path](linux-command-operations.md) uses durable bound runner handoffs. A lease never becomes
`ready` without an explicit runner runtime and capability report.

Run it as described in [the model-job controller slice](model-controller.md#running-the-controller);
both ledgers share one process, database and `controllerId`. Do not share writable
state with an older controller. Back up existing state and validate schema compatibility before cutover.

## Authority

| Role | Proof | Routes |
| --- | --- | --- |
| Administrator | Operator token or account session | Images, grants, runner approvals, resource domains |
| Application | Application credential | Catalogue, acquire, list; inspect/renew/release/credential of its own leases |
| Lease | That lease's current key | Inspect, renew, release; command submission and receipts for that lease only |
| Runner | Current runner credential plus exact `binding` | Claim, list assignments, report; bound operation poll/report |

Every credential is checked inside the same `BEGIN IMMEDIATE` transaction as the
effect. Credentials never cross roles. Another application's lease looks missing
(404). A lease key presented to the credential route is a 403, and is rejected (401)
everywhere else outside its own lease.

## Operator configuration (administrator)

All routes are POST with an exact JSON object. An identical definition is a replay; a
changed one is a 409. Entries are immutable.

| Route | Body | Effect |
| --- | --- | --- |
| `/v1/linux-lease-images` | `{id, revision, arch, os: "linux", mode: "headless", backend, digest, resources, capabilities}` | Pins one installed image: one backend, one `sha256:` digest, a fixed per-lease reservation size and a subset of `command`, `pty`, `files` |
| `/v1/linux-lease-grants` | `{applicationId, imageId, revision, arch, digest}` | Allowlists one catalogued image digest for one application |
| `/v1/linux-lease-grants/revoke` | same | Blocks new acquisitions of that image |
| `/v1/linux-lease-runner-approvals` | `{binding, domainId, backend, images: [{id, revision, arch, digest}]}` | Maps one current binding to one [resource domain](model-controller.md#reservations-and-limits), one backend and the exact images it has installed |
| `/v1/linux-lease-runner-approvals/revoke` | `{binding}` | Blocks new placement and claims; existing assignments keep reservations and report authority |

`backend` is `kubevirt` or `appleVirtualization`. An approval refuses images of
another backend. Graphics and accessibility capabilities (`screenshot`,
`displayStream`, `input`, `hierarchy`) are refused with `capability_unsupported`;
they are never substituted by host access. Approvals belong to one generation; a
reenrolled runner inherits none. Nothing is discovered or approved automatically.

## Application routes

| Route | Credential | Result |
| --- | --- | --- |
| `GET /v1/environments/templates` | application | Granted images with `available` (a current approval serves the digest), `runtime` (`kubevirt` or `apple`) and the application's limits |
| `POST /v1/leases` | application | `201` lease for new admission, `200` for an identical replay |
| `GET /v1/leases[?after=<id>]` | application | At most 100 owned leases in ID order with `nextCursor` |
| `GET /v1/leases/{id}` | owner or lease key | Lease view |
| `POST /v1/leases/{id}/credential` | owner only | `{id, credential}`; body `{}` |
| `POST /v1/leases/{id}/renew` | owner or lease key | `{mutation, lease}`; body `{id, expectedRevision, ttlSeconds}` |
| `POST /v1/leases/{id}/release` | owner or lease key | `{mutation, lease}`; body `{id}` |

**Acquisition.** The lease ID is application-chosen and globally unique. An identical
replay returns 200. A changed body under the same ID is a 409. Another application
reusing the ID is a 409 and never takes the lease over. Admission runs in one
transaction:

1. The application needs an unrevoked grant for the exact image digest (403).
2. `requiredCapabilities` outside the image's set are `capability_unsupported` (409).
3. `resources` overrides may only raise the image size (400). `ttlSeconds` defaults
   to and is bounded by the application's limits (400). Linux acquisition and
   renewal require integer `ttlSeconds >= 30`. Smaller TTLs return 400
   `linux_ttl_below_minimum`. Acquisition also rejects an application default or
   maximum below 30 seconds with that code, even with an explicit override;
   values are never silently clamped. This consumer contract change applies only
   to Linux leases, not other lease kinds or generic application limits.
4. Active leases and held reservations (including terminal but unreclaimed ones) are
   bounded by the application's limits (429).
5. Placement considers only domains with a current approval serving the image
   and room beside every held reservation, including model-job reservations
   (503 `capacity_unavailable` otherwise). It minimizes the highest CPU, memory
   or disk reservation fraction after adding the request, then total fractions,
   then domain ID. Selection and reservation share the same transaction. The
   lease remains pinned to that domain even when later load or approvals change.

**Credentials.** Acquisition returns no key. The owner obtains one through the
explicit credential route; each call mints a fresh opaque key and revokes the
previous one. Only a domain-separated SHA-256 hash is stored. Keys never appear in
URLs, mutation receipts or stored bodies. The route is not idempotent: after an
unknown outcome, call it again deliberately. Ended leases cannot issue keys (410).

**Lifecycle.** `state` (lifecycle), `runtimeState` (observed execution) and
`cleanup` (reclamation) are separate. TTL starts at acquisition. Every lease
transaction first applies, per active lease: application revocation → `released`;
`now >= expiresAt` → `expired`; provisioning past its deadline → `failed`. Expiry
therefore wins over a renewal at the exact deadline. Renewal requires the current
`revision`, never shortens the deadline and is capped by the maximum lifetime fixed
at admission. Lifecycle and deadline changes increment `revision`. A terminal lease
never reopens: renewal is a 409 and release is an idempotent 200. Mutation receipts
are keyed by `(application, lease, action, id)`; a replay returns the original
receipt with the current lease view.

Release, expiry and failure are intent. A never-claimed lease is reclaimed in the
same transaction, because that transaction excludes every claim. A claimed lease
keeps its reservation, and `cleanup` stays `pending`, `running` or `blocked`, until
the bound runner reports positive stop, storage removal and guest-credential
erasure. If the binding was revoked or superseded, the view shows `runtimeState:
unknown` and cleanup reason `recovery`, and the reservation stays held. There is no
automatic failover, reassignment or operator reconciliation in this slice.

## Runner wire interface

Every route is `POST` with `Authorization: Bearer <runner credential>`, a single
`Content-Length`, a JSON object of at most 1 MiB and no `Origin` header. Each
request has a 20-second deadline. Errors use `{error, message, code, requestId,
retryable, outcome?}`. A 4xx is a definite rejection. A 503 or a lost reply leaves
the effect uncertain: replay the identical request.

`binding` is `{controllerId, runnerId, generation, incarnationId}` from enrollment.
The credential is re-verified inside the same SQLite `BEGIN IMMEDIATE` transaction
as every effect.

### Assignment

```json
{
  "id": "<assignment UUID>", "claimId": "<runner claim UUID>", "leaseId": "<lease UUID>",
  "memberId": "<per-lease member UUID>", "domainId": "<resource domain UUID>",
  "sequence": 0, "closed": false,
  "image": { "id": "linux-dev", "revision": "1", "arch": "amd64", "backend": "kubevirt", "digest": "sha256:<64 hex>" },
  "resources": { "cpu": 2, "memoryMiB": 4096, "diskGiB": 20 },
  "capabilities": ["command", "files"], "requiredCapabilities": ["command"],
  "lease": { "state": "provisioning", "revision": 1, "expiresAt": 1798800000, "controllerNow": 1798798200 },
  "stopRequested": false
}
```

- `image.backend` is `kubevirt` or `appleVirtualization` (a Linux guest on Apple
  Virtualization). It is fixed by the operator catalog entry and must equal the backend
  the binding's approval names. The guest OS is always Linux; there is no host-process
  substitution.
- `image` is immutable and digest-pinned. Resolve it only against operator-installed
  local inventory by exact digest. Never download, never treat the label as a path.
- `resources` are already reserved in `domainId` by admission. Do not exceed them.
- `lease.expiresAt` and `controllerNow` are Unix UTC seconds. Enforce
  `expiresAt - controllerNow` as a local monotonic authorization deadline; stop
  execution when it elapses without a newer revision. A same or lower `revision`
  never extends a deadline.
- `stopRequested` is true once the lease is terminal (released, expired, failed).
  It is intent, not evidence.

### Routes

| Route | Body | 200 result |
| --- | --- | --- |
| `/v1/runners/linux-leases/claim` | `{binding, claimId}` | `{assignment: Assignment \| null}` |
| `/v1/runners/linux-leases/assignments` | `{binding}` | `{assignments: Assignment[]}` (unclosed, this exact binding) |
| `/v1/runners/linux-leases/report` | `{binding, assignmentId, sequence, receipt}` | `{assignmentId, sequence, lease: {state, revision, expiresAt, controllerNow}, runtimeState, cleanup, stopRequested, released, failureReason}` |

**Claim.** Approvals are `{binding, domainId, backend, images}`; one binding serves one
backend. Persist `claimId` before sending. Replaying a recorded `claimId` for the
same binding returns the same assignment; for another binding it is a 409. Requires
an unrevoked Linux lease approval for this exact current binding (403). Selects the
oldest unclaimed `provisioning`, unexpired lease pinned to the approval's domain whose
image (id, revision, arch, backend, digest) the approval serves. The claim adopts the lease's
existing reservation; it never reserves twice. `null` records nothing.

**Report.** `receipt`:

```json
{
  "leaseId": "<lease UUID>", "memberId": "<member UUID>", "backend": "kubevirt", "imageDigest": "sha256:<64 hex>",
  "observedRevision": 1,
  "runtimeState": "starting | running | stopped | unknown",
  "ready": { "command": false, "pty": false, "files": false },
  "failure": null,
  "executionStopped": false, "storageRemoved": false, "credentialsErased": false,
  "cleanup": "pending | running | blocked | complete"
}
```

`failure` is `null`, `"provisioning"`, `"runtime"` or `"deadline"`. All fields are required; unknown
fields are refused.

- `sequence` starts at 1 and advances by exactly one. Persist `(sequence, receipt)`
  before sending. Resending the last accepted sequence with an identical receipt (key
  order irrelevant) is a replay; anything else at that sequence, a skipped/stale
  sequence, or a new report after the assignment closed is a 409.
- `leaseId`, `memberId` and `backend` must match the assignment; `imageDigest` must equal
  the pinned digest (409 `image_mismatch`). `observedRevision` is 1..current and never decreases.
- Runtime is forward-only: `starting` < `running`/`unknown` < `stopped`; `stopped` is
  sticky. A `ready` capability may be true only with `runtimeState: running`, and only for a
  catalogued capability.
- The lease becomes `ready` only from a `running` receipt with every
  `requiredCapabilities` entry explicitly true, while still `provisioning` and before
  expiry/provisioning deadline in the same transaction. No receipt implies readiness.
  Lifecycle stays separate: consumer `members[].ready` requires the latest report to
  confirm every required capability, and becomes false when that evidence is withdrawn
  or runtime/binding becomes unknown. A later valid report can restore member readiness.
- `failure: deadline` on an active lease ends it as `expired` only when
  controller `now >= expiresAt - DEADLINE_REPORT_TOLERANCE` (10 seconds).
  This covers the satellite's 2-second guest margin, 1-second report cadence and
  7 seconds of bounded scheduling delay and modest clock skew, and is below the
  30-second minimum TTL. Earlier deadline reports end as `failed`; the runner
  report acknowledgment exposes `failureReason: deadline_too_early` only when that
  deadline receipt caused the failed transition. The reason is stored durably in
  an additive nullable column; existing rows keep null. Later receipts cannot
  change it, including deadline receipts after provisioning failure. A renewal
  accepted after a satellite fenced its old deadline cannot revive that guest:
  its stale deadline report fails the renewed lease when outside the tolerance.
  Other failures on an active lease end it as `failed`. Terminal lifecycle and
  revision remain unchanged by later deadline reports. No report extends or
  resurrects a lease. Renewal inside the final guest margin may not reach the
  guest before its authority ends; that lease then expires. `runtimeState: stopped` on an active
  lease requires `failure`. Cleanup fields other than `pending`/false are refused
  while the lease is active.
- Evidence flags never revert, and `cleanup: complete` is sticky.
- Only `cleanup: complete` with `runtimeState: stopped`, `executionStopped`,
  `storageRemoved` and `credentialsErased` all literally true, on a terminal lease,
  from the binding the assignment was claimed under, releases the reservation
  (`released: true`) and closes the assignment. Stop alone never releases.
- `runtimeState: unknown` keeps the reservation. Report it whenever state cannot be
  positively established. Never re-run or recreate a lease.

Errors: another binding's credential 401; a valid binding other than the
assignment's (including a reenrolled newer generation) 403; a revoked binding 401,
so its leases show `runtimeState: unknown` and keep reservations until operator
reconciliation (not implemented). There is no automatic failover or reassignment.

### Open integration gates

Image ingestion/installed-inventory verification, VM boot, PTY and file
execution, guest credential erasure and native stop evidence belong to the runner
adapter and require separate fixture and native acceptance. The
[command operation contract](linux-command-operations.md) defines the implemented
TypeScript command ledger and runner wire, without native execution acceptance.

The [Rust Apple satellite](../crates/apple-satellite/README.md) implements this wire
for `appleVirtualization`. `fixtures/apple-satellite/public-api.mjs` drives it
against this controller over TLS with a fake native helper; that is fixture
evidence, not VM or native acceptance. KubeVirt has no runner adapter yet.

## Reservations and limits

Leases reserve in the same `resource_domains`/`resource_reservations` ledger as model
jobs, once, at admission, with `kind: "linux-lease"` and the lease as owner. A claim
adopts that reservation and refuses to hand out a lease whose reservation is not
held. Release requires the lease owner. Model-job claims see lease reservations and
vice versa, so one physical budget is never offered twice. For explicitly mapped hosts and runner domains, the physical capacity facade
combines reservations from both ledgers. Unmapped inventory retains independent
accounting; do not offer the same physical capacity through unmapped entries.

Only additive tables are created: `linux_lease_images`, `linux_lease_grants`,
`linux_lease_runner_approvals`, `linux_leases`, `linux_lease_mutations` and
`linux_lease_assignments`. Legacy rows are not read, converted or adopted.

The controller has a one-second [waiting-request admission timer](requests.md).
Lease expiry is applied when a lease route or queued acquisition runs. A model-job claim does not refresh leases, so an expired, unclaimed lease
holds its reservation until the next lease transaction; this is conservative and
never double counts. [Durable command operations](linux-command-operations.md) add
scoped submission/get and bound runner poll/report routes, with three additive
operation tables. Not implemented: sessions, paired members,
operator reconciliation of revoked runners' leases, mutable catalog entries,
tombstone retention, and cleanup retry metadata (`attempts` is always 0).

## Verification

```sh
npm --prefix coordination run typecheck
npm --prefix coordination run build
npm --prefix coordination test
```

`coordination/test/linux-lease-controller.test.ts` starts real `main.js` controller
processes on a disposable SQLite file over loopback HTTP and drives consumer routes
through `ConsumerClient`/`LeaseClient`. A test-only `--import` preload
(`test/fixture-clock.ts`) makes the controller clock a fixture file, so deadlines are
exact without sleeps. It covers:

- Backend/digest pinning, headless capability denial and explicit-report readiness.
- Roles, ownership, ID takeover refusal, quotas, key rotation and absence of keys
  from stored state.
- Concurrent lease admission and model-job claims across two controller processes
  against one domain: exactly one reservation results.
- Exact expiry boundary, capped renewal, renewal and release replay, provisioning
  failure and deadline, and release only after full cleanup evidence.
- Lost acquire, renew, claim and report replies with exact replay after SIGKILL
  restarts; `unknown` retention; revoked and newer-generation denial; no failover;
  fresh-lease key and member isolation; retained legacy rows.

These fixtures are source evidence only. They do not show VM execution on either
backend, image ingestion, guest access, native stop or cleanup, TLS deployment or
release acceptance.

<a id="st-535-assignment-and-transfer-wire-unimplemented-contract"></a>

## ST-535 assignment and transfer wire (controller implementation)

Controller status: implemented in TypeScript, with additive legacy-compatible
storage and portable tests. Runtime and native acceptance remain separate gates.

This controller extension is for the direct-boot Apple adapter only; KubeVirt has
no dispatch implementation. Native acceptance is still required.
The [consumer transfer routes](consumer-api.md#st-535-linux-file-routes-unimplemented-contract),
[guest data frames](guest-wire.md#st-535-data-protocol-contract-unimplemented)
and [egress policy](linux-egress-policy.md) form the same contract.

### Assignment additions and compatibility

Add required `workspaceIOVersion:1`, `egress:{enabled,policy:"public-https-v1"}`
and `workspace:{bytes,overheadBytes}` to new workspace assignments. Values are
immutable admission snapshots, not supplied by consumers; size accounting is
specified in the boot-bundle contract. Assignment does not carry a host path,
serial or data nonce: the satellite generates and durably binds those to its
fresh boot attempt. Image registration and approval each gain optional
`workspaceIOVersion:1`; the catalog image value is immutable and binds its verified
bundle-v2 digest. Absence means legacy image/adapter. Only an explicit v1 approval can receive v2 bundle images;
old images and in-flight assignments keep their existing schema and cleanup
rules. No optimistic dispatch of new fields to strict old decoders.

Application `linuxEgress` is defined in [applications](applications.md#st-535-application-egress-grant-unimplemented-contract).
Snapshot its enabled value at acquisition, including durable queued-request
admission; an idempotent acquisition replay returns the original snapshot.
Egress is neither a requested capability nor a consumer acquisition field.
Denied/default-off egress does not prevent offline commands/files. A runner
without enforcement policy v1 cannot accept any workspace assignment, even one
with egress off. Operator deny-CIDR configuration and its digest are journaled
locally before launch, never accepted from guest/consumer input.

Additive storage must preserve old rows: nullable workspace version, workspace
JSON and egress JSON on leases/assignments; existing rows are v1 legacy (no disk
or proxy inferred). Add a transfer ledger and serialized step ledger with foreign
keys to the exact assignment/lease/member/boot/digest, submitted key generation,
canonical intent digest, step request and first terminal receipt. Persist all
handoff transitions in SQLite BEGIN IMMEDIATE before returning work. Bound byte
payloads are transient spool records (at most one 64 KiB chunk per assignment),
not argv or general response logging. No automatic conversion of running boots.

### Controller ↔ satellite step transport

Use existing runner HTTPS authentication, exact enrollment binding, 1 MiB JSON
request/response ceiling, 20-second per-request deadline and no redirects/proxies.
Every route below is POST; `owner` abbreviates required flat fields
`binding,assignmentId,bootAttempt,bundleDigest`, matching operations/poll's
registered immutable boot. Controller rechecks the exact current binding inside
each transaction. No new inbound host listener or runner WebSocket is required.

| Route under `/v1/runners/linux-leases/transfers` | Exact body | 200 response |
| --- | --- | --- |
| `/poll` | `{...owner,pollId}` | `{transfer:null-or-work,lease,cancelRequested}` |
| `/report` | `{...owner,transferId,step,receipt}` | `{transferId,step,state}` |

`lease` has the same state/revision/expiresAt/controllerNow fields as command
poll. `cancelRequested` is true after authorization loss or invalidation. Work is
exactly `{id,leaseId,memberId,assignmentId,bootAttempt,bundleDigest,step,request,startBefore,deadlineAt,state}`.
Work state is `queued`, `succeeded`, `failed` or `unknown`;
only a previously unseen queued handoff may execute. Terminal poll replays return
request:null after payload erasure; queued work always has the full request.
Transfer poll may register
the boot tuple first using the same atomic immutable registration as command
poll; files-only acquisition does not depend on first submitting a shell.
`request` and `receipt` use the guest transfer variants verbatim. The satellite
validates all owner fields, translates no paths, and streams that single bounded
step over 1025. The guest UUID equals the controller transfer id. The satellite
journals work before sending any bytes, then journals receipt before reporting.

Each submitted step fixes startBefore=min(submitTime+120s, lease expiry).
Dispatch fixes deadlineAt=min(dispatchTime+120s, lease expiry); units are Unix
UTC seconds, as for lease expiry. Satellite derives a conservative monotonic
remaining duration from the poll request's send time and controllerNow, subtracts
transport elapsed time and the existing guest safety margin, and sends the
remaining duration in transferRequest.remainingMs. Guest and satellite cancel
locally at that deadline. Renewal never extends a step's deadline. Large-file finish
verification that exceeds this bound is unknown, not a successful partial hash.
No progress/bulk data rides lease heartbeat or control 1024.

Poll IDs follow operation poll semantics: persist before sending; a null poll
records nothing; nonnull pins this poll ID forever to the exact transfer/step.
Exact replay retrieves current stored work/state, never a second handoff. A new
poll ID cannot claim a dispatched step. Receipt is authenticated only from the
original owner and dispatched step. First terminal result wins, including
controller-generated unknown. Report response state is the step ledger state.
Same report replay returns the stored result; changed duplicate after an accepted
runner receipt is 409. A late report after controller-generated unknown returns
the stored unknown without adopting the supplied result. New work requires current files readiness, unrevoked
application and submitted lease-key generation, valid binding/approval/image,
unexpired lease and a live data channel. Revocation/rotation invalidates pending
work, not merely the HTTP connection. Never allow a body to choose another owner.

For upload, controller validates one caller chunk and persists it until the
satellite reports its next offset; it then erases those bytes, retaining request
hash/offset and receipt. For download, a read report carries up to 64 KiB base64;
controller retains only that latest read payload until the next step is admitted
or the transfer ends. Consumer fetches it through its step receipt. Controller
computes incremental upload/download hashes during normal operation; after
restart it need not reconstruct a streaming hash to redispatch anything. Guest
final byte/hash verification remains mandatory and is compared with the caller's
finish hash. Controller must not claim verified download from partial bytes.

One active transfer and one pending step per assignment; command lane is separate
so a shell can produce files while a transfer runs. Unknown transfer blocks that
transfer lane for the rest of the boot; it does not block commands/control. Definite
terminal transfers free the lane. A failed step ends the transfer as failed and
closes/removes owned staging; unconfirmed cleanup is retained for lease cleanup.
An abort of a created transfer may be completed in the controller without a guest
effect; otherwise it is a serialized guest step, not cancellation of unknown work.
Further steps on a completed transfer are
rejected except exact receipt replay. Controller spool is bounded globally to
64 MiB decoded bytes; exhaustion is 503 `transfer_backpressure` before admission,
with no handoff. Poll responses return promptly (no long polling); data polling
has a separate bounded worker and cannot queue ahead of heartbeat/renewal/stop.
At most one poll/report request in flight for data per assignment.

### Loss, invalidation and cleanup

A lost HTTP response permits replay of the identical stored request to retrieve
its receipt, never re-execution. A caller may retry a pending step using the same
step/body; the controller does not hand it out twice. Controller crash/restart
fails undispatched steps with `controller_restarted` and makes dispatched steps
without accepted receipts unknown. Even if the satellite later supplies success,
first-terminal-wins preserves that unknown. Queued data bytes are erased on
invalidation. The controller asks the still-running satellite to abort the
transfer; it does not infer guest rollback from deletion of its spool.

Satellite restart never reconnects/recreates a boot or transfer. Existing lease
recovery fences the VM; any step whose receipt was durably recorded may replay
only that receipt, and all other handed-off work is unknown. A live process may
retry an exact lost report, while enforcing local deadlines independently. Runner
credential/binding loss keeps reservations held for operator reconciliation.
Data-channel loss alone leaves commands, heartbeat, renewal, expiry and stop
operational: undispatched transfer work fails `data_channel_lost`; handed-off
work without a definite receipt becomes unknown. Current files readiness is
withdrawn. No new transfer for that boot; existing receipts remain readable.
Application revocation, lease-key rotation, expiry and release invalidate pending
steps (failed before handoff, unknown afterward), send priority transferCancel, close guest transfer descriptors
and egress flows. A lease heartbeat response carries cancellation to the satellite
even if data is gone; guest EOF must independently stop pending file publication.

Workspace assignments add required `workspaceRemoved` and `dataPlaneClosed`
booleans to lease cleanup receipts (not transfer reports). They start false and
are monotonic. `storageRemoved:true` additionally covers workspace.raw, partial
allocation/staging, both relay socket paths and private launch/native state.
`dataPlaneClosed:true` requires all satellite outbound sockets, data/transfer
workers, relay descriptors and owned data listeners to be closed/joined.
`workspaceRemoved:true` requires positive helper exit/lock/handle release and
identity-checked unlink of the owned disk plus parent directory flush; absence
alone after an uncertain create/start is insufficient. Shared image files are
never deleted. Complete cleanup needs both new flags plus all existing stop,
storage and credential flags, under the original current binding. Reject
`cleanup:complete` with either false. Native fencing starts immediately; data
teardown has a 2-second bound, after which uncertain closure means blocked cleanup
and held capacity, never delayed fencing or inferred release.

### Acceptance still required

Portable contract fixtures must cover exact schemas/version downgrade refusal,
step/poll/report replay, byte cursor/hash checks, controller/satellite restart,
rotation/revocation races at publication, spool/credit exhaustion, timeout parity,
files-only boot registration and data loss with continuing commands/renewal.
Policy fixtures need mixed DNS answers, rebinding, all denied families/embedded
forms, current host interface addresses and route-query failures. No fixture
establishes VM isolation or native filesystem durability.

Separately authorized native acceptance must clone a public HTTPS repository,
verify its exact commit before execution, run npm ci/test with pinned lockfile,
round-trip empty/binary/multichunk files with hashes, exercise disk-full and
replacement staging, reject host/LAN/tailnet/metadata/other-guest targets, and
reject another application's keys. Test expiry during build/transfer, data-only
disconnect, positive raw-disk removal and held capacity on uncertain cleanup.
Route-change monitoring, router-public-IP hairpin denial, physical preallocation
and guest/host flush semantics remain explicit gates. No native experiment or
acceptance evidence is supplied by this documentation.
