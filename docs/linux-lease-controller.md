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
state with the Python controller. Python runtime paths remain authoritative.

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
   to and is bounded by the application's limits (400).
4. Active leases and held reservations (including terminal but unreclaimed ones) are
   bounded by the application's limits (429).
5. Placement reserves the VM size in the first domain, in ID order, that has a
   current approval serving the image and room beside every held reservation,
   including model-job reservations (503 `capacity_unavailable` otherwise). The
   lease is pinned to that domain.

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
| `/v1/runners/linux-leases/report` | `{binding, assignmentId, sequence, receipt}` | `{assignmentId, sequence, lease: {state, revision, expiresAt, controllerNow}, runtimeState, cleanup, stopRequested, released}` |

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

`failure` is `null`, `"provisioning"` or `"runtime"`. All fields are required; unknown
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
- `failure` on an active lease ends it as `failed`. `runtimeState: stopped` on an active
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
vice versa, so one physical budget is never offered twice. The lease ledger does not
read the legacy `hosts`/`host_limits`/`leases` tables; do not offer the same
physical capacity to both.

Only additive tables are created: `linux_lease_images`, `linux_lease_grants`,
`linux_lease_runner_approvals`, `linux_leases`, `linux_lease_mutations` and
`linux_lease_assignments`. Legacy rows are not read, converted or adopted.

The controller has no background timer. Expiry is applied when any lease route
runs. A model-job claim does not refresh leases, so an expired, unclaimed lease
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
