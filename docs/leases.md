# Environment lease contract

Implementation contract. Native acceptance limits are described below.
The controller implements application-scoped single-member acquisition, inspection,
listing, scoped credential exchange, renewal, release and session admission with
a paired WebSocket relay. Terminal cleanup coordination, the owned Apple cleanup
worker and provider-independent unstarted-assignment cleanup have fixture coverage.
Full provider deadline enforcement, paired environments and live consumer acceptance
remain open. [Durable consumer operations](consumer-operations.md) have controller/runner
fixture coverage. Current administrative runners do not advertise lease execution
protocol 1, so they cannot accidentally accept consumer leases before those paths
are implemented. Fixture hosts explicitly opt into that protocol for lifecycle tests.

## Ownership and compatibility

A consumer application owns leases. A lease owns one environment, whose members
are machine assignments. Initially an environment has one member; an iPhone/watch
environment has two named members and a persisted pairing identity. One assignment
cannot belong to multiple leases. Existing administrative machines are not adopted
or expired automatically. Existing `/v1/machines` behavior remains compatible.

The consumer principal has a template allowlist and aggregate CPU, memory, disk
and active-lease limits. Admission checks these and host capacity in the same
SQLite transaction as creation. Paired environments reserve all members on a
compatible host atomically. No partial placement is reported as successful.
Placement stays pinned through host loss. No failover without positive fencing.

Consumer credentials authorize catalogue discovery and creation. Separate opaque
lease credentials authorize only that lease's inspection, renewal, release and
access. Store only credential hashes; issue credentials through authenticated
exchange, never URLs, logs or persisted operation bodies. A consumer can exchange
its credential for a fresh lease credential after a lost response. Rotation revokes
the previous credential. Sessions are subordinate to lease authorization, never a
way to extend it. Operators retain recovery access through a separate boundary.

## Lifecycle

`state` is consumer lifecycle, `runtimeState` is observed execution, and `cleanup`
is reclamation. These must remain separate. A stale host produces unknown runtime
state without extending the lease or freeing reservations.

| Current state | Trigger | Result |
| --- | --- | --- |
| absent | admitted acquisition | `provisioning`, resources reserved |
| provisioning | all members booted, prepared and required capabilities ready | `ready` |
| provisioning or ready | unrecoverable provisioning/runtime failure | `failed`, access revoked, cleanup queued |
| provisioning or ready | authenticated renewal before expiry | same state, deadline and revision updated |
| provisioning or ready | release | `released`, access revoked, cleanup queued |
| provisioning or ready | controller time reaches deadline | `expired`, access revoked, cleanup queued |
| failed, released or expired | repeated release | unchanged, successful idempotent response |
| terminal state | renew or new access | conflict; cannot resurrect |

Acquisition starts the TTL immediately, including provisioning. The operator
configures default/max TTL, max total lifetime and provisioning deadline; discovery
returns their effective values. Requests use integer seconds within those limits.
Renewal sets `expiresAt = controllerNow + ttlSeconds`, capped by maximum lifetime;
it cannot shorten the current deadline. The controller atomically checks expiry,
revision and renewal. At `now >= expiresAt`, expiry wins. All timestamps are UTC.
`revision` is an integer incremented on lifecycle/deadline changes.

Authorization checks expiry on every request, even if the expiry worker is down.
Runners receive a bounded authorization deadline for access and execution, enforce
it locally and close sessions/stop owned commands when it elapses without renewal.
Clock synchronization and bounded skew are host prerequisites. Controller restart
must process expired records before allowing access. A disconnected host cannot
be trusted to have cleaned up; reservations stay held until evidence arrives.

Cleanup progresses `pending -> running -> complete`, or `blocked` with a safe
reason and retry metadata. Failed cleanup never changes terminal lease state.
Default disposition for new leases is destroy, with no reuse until owned runtime,
storage and device identities are positively reclaimed. Stop is not deletion.
Future retention requires an explicit operator policy and separate storage owner;
it is not an implicit fallback. Expiration immediately closes access; reclamation
may finish later. Late receipts cannot restore access or overwrite newer state.
Keep terminal metadata and idempotency tombstones; define their retention before
production rather than allowing a duplicate acquisition to recreate an old lease.

## HTTP surface

The lifecycle and session admission/inspection/close paths below are implemented.
The controller also implements the paired session transport described in
[outbound access](access-transport.md), including outbound PTY/file provider
workers and display input. The durable operation endpoints below have fixture coverage;
complete execution cancellation, live cleanup acceptance and other provider cleanup remain open.
HTTPS and bearer authentication are
required for remote access. Browser access continues through an authenticated
gateway; do not remove existing direct-origin protections.

| Method and path | Credential | Purpose |
| --- | --- | --- |
| GET /v1/environments/templates | consumer | permitted templates, revisions, members, capabilities and limits |
| POST /v1/leases | consumer | idempotent acquisition |
| GET /v1/leases | consumer | own leases only, paginated |
| GET /v1/leases/{id} | consumer owner or lease | inspect lifecycle, members, readiness and cleanup |
| POST /v1/leases/{id}/credential | consumer owner | mint/rotate scoped credential |
| POST /v1/leases/{id}/renew | consumer owner or lease | renewal with expected revision |
| POST /v1/leases/{id}/release | consumer owner or lease | revoke access and request cleanup |
| POST /v1/leases/{id}/sessions | lease | negotiate supported shell/file/visual session |
| GET /v1/leases/{id}/sessions/{sessionId} | lease | inspect owned session metadata |
| POST /v1/leases/{id}/sessions/{sessionId}/close | lease | close an owned session with `{}` |
| POST /v1/leases/{id}/operations | lease | Submit or replay a durable discrete device/command operation |
| GET /v1/leases/{id}/operations/{operationId} | lease | Inspect an owned operation receipt |

Acquisition example (UUIDs are caller-generated):

```json
{"id":"b7682a27-b32e-472a-8a4d-f54a98a6d962","templateId":"linux-development","templateRevision":"1","arch":"arm64","ttlSeconds":1800,"requiredCapabilities":["command","files"]}
```

Return 201 for new admission, 200 for an identical retry. Example response shape:

```json
{"id":"b7682a27-b32e-472a-8a4d-f54a98a6d962","state":"provisioning","runtimeState":"pending","revision":1,"expiresAt":"2026-11-02T13:30:00Z","cleanup":{"state":"notRequested"},"members":[{"name":"primary","state":"pending"}],"capabilities":{"command":true,"pty":false,"files":true,"screenshot":false,"displayStream":false,"input":false}}
```

Capabilities describe the pinned template contract, not current readiness. Each
member exposes its own capabilities and file scopes; pair readiness requires both
members and pairing. Never infer a device shell from host process access. iOS
initially exposes app-container files and discrete visuals/input, without shell.
Headless templates expose no display capability. PTY, command, hierarchy,
screenshots, live display and input are distinct capabilities. Advertise formats,
coordinate units, file roots, transfer limits and session concurrency limits.

Renew body: `{"id":"<request UUID>","expectedRevision":1,"ttlSeconds":1800}`.
Release body: `{"id":"<request UUID>"}`. Persist mutation receipts transactionally.
An identical retry returns its original receipt plus current lease state; a changed
body under the same request UUID returns 409. Scope request identity to the owning
consumer and operation. Lease IDs remain globally unique and cannot be taken over.
Unknown fields and invalid types are 400, unauthenticated 401, forbidden action
403, missing or other-owner resource 404, expired lease access 410, state/revision/
capability conflict 409, admission limits 429 and no eligible capacity 503.
Errors contain stable `code`, safe `message`, `requestId` and explicit retryability.
Unsupported capability uses `capability_unsupported`; it never executes on the host.

`GET /v1/leases` returns at most 100 owned leases in UUID order with `nextCursor`;
pass that UUID as `?after=...`. List results are current pages, not a snapshot across
concurrent acquisitions. Mutation and acquisition tombstones currently have no
automatic deletion. Existing administrative machines are never adopted. Their
capacity remains in the same host/shared ledgers. Lease-owned machine identities
cannot be restarted through the administrative desired-state endpoint.

Single-member admission, host/shared budgets and aggregate application quotas run
inside the same SQLite transaction. Failed admission rolls back the machine too.
Stopped and terminal-but-unreclaimed leased CPU, memory and disks still count
against application and host/shared reservation limits until matching cleanup
completion. Observed runtime usage remains separate from these held reservations.
Every store transaction refreshes expiry, provisioning failures and readiness;
restart persists expiry before serving requests. Lifecycle authorization checks do
not depend on an expiry worker.

The runner persists leased assignment deadlines separately from administrative
machines. Live enforcement uses suspend-aware elapsed time on macOS/Linux, subtracts heartbeat round-trip
time, rejects excessive controller/runner skew and never extends a deadline from a
stale revision. A fenced assignment cannot be reopened by a late renewal. Restart
uses conservative wall-clock recovery, persists expired fences and blocks rollback
from reopening them. Missing/changed ownership fences the retained assignment.
Offline reconciliation processes those stop intents while administrative VMs
survive controller loss. Local stream callbacks and new discrete operations reject
fenced assignments; a fenced report ends a still-active controller lease.

A separate runner watcher checks persisted lease deadlines every 100 ms and
revokes host-owned PTYs independently of the VM reconciliation worker. Revocation
is sticky for the lifetime of the shell manager: that assignment cannot open
another PTY after a late heartbeat. It leaves administrative assignments alone.
PTY process groups are terminated in batches with one shared grace period, and
process waits run outside the shell manager lock. Tests exercise real stubborn
child processes and expiry during blocked reconciliation. This closes host PTY
clients; it does not prove cancellation of commands already running in a guest,
including detached processes behind adb or SSH.
If a PTY process cannot be terminated, it remains tracked for cleanup and its
session identity cannot be reused. A failed close is reported as uncertain;
revocation and shutdown sweeps retry the retained process rather than losing it.

### Native Apple execution deadlines

New native Apple VM metadata can bind `executionLeaseID` at preparation; an
existing administrative VM is never adopted. A leased machine cannot boot or
restart through the manager without its execution supervisor. The host still
rejects `leaseProtocol: 1`; this native mechanism does not enable consumer placement.

The native runner polls its private, bounded `lease-authorization.json` every
100 ms, including while asynchronous VM start/installation is pending. The file
binds machine UUID, lease UUID, revision, VM boot, host boot UUID and an absolute
continuous-clock deadline. Missing, malformed, changed-owner/boot or explicitly
fenced authorization ends execution. Same/stale revision cannot extend the
deadline, and expiry wins over a renewal first observed after it. A sticky native
`lease-fenced.json` prevents restart even if a later file advertises more time.

The runner intentionally exits its own process with code 70 on fencing. This is
a power cut for a destroy-on-expiry lease, not graceful guest shutdown or image
capture consistency. It attempts to persist and sync the fence first; a write
failure does not keep the process alive. Positive reclamation still requires
process exit, an available runtime lock and closed disk handles. A fence file
alone cannot release compute; disks remain reserved until owned cleanup succeeds.
PID reuse is never a reason to signal an unrelated process.

Independent per-assignment Python workers publish renewal/fence updates without
entering guest preparation or ordinary VM reconciliation. Each update verifies
assignment/storage ownership and the native lease binding; it never starts a VM
or recreates removed storage. Failure leaves the existing native deadline in
force. The native guard continues when these workers or the Python agent stop.
Stopped reconciliation also bypasses guest preparation and credential generation.

macOS uses [continuous Mach time](https://developer.apple.com/documentation/kernel/1646199-mach_continuous_time),
including system sleep, in both Python and Swift. Linux lease timing uses
`CLOCK_BOOTTIME`. The Python publisher samples the native clock and subtracts
its full sampling delay plus 250 ms before publishing a deadline. It does not
serialize Python's process-relative clock as a native timestamp. This matters
for [older macOS Python clocks](https://docs.python.org/3.10/library/time.html#time.monotonic),
and prevents a sleeping host from extending a pending launch's authorization.

Verification uses separate signed native watcher processes over disposable
metadata, including expiry without Python updates, renewal, authorization-file
loss, same-revision replay, sticky restart fencing and Python/native clock
agreement. Swift tests prove boot rejection without a supervisor. Python tests
cover positive process/lock/disk checks, independent updates during blocked
reconciliation, stopped-preparation bypass and suspend-aware expiry. They do not
establish expiry of a running VM, detached guest command cancellation or live
consumer cleanup. No retained administrative machine was converted into a lease.

This remains partial runner enforcement, not full disconnected-session/command cleanup
acceptance. Other provider stop paths and access locks still need bounded
cancellation/priority, and native running-VM expiry requires live acceptance.
Automatic Apple cleanup now uses the owned deletion and credential-erasure path
below; other provider cleanup remains unimplemented. The
runner explicitly rejects configuration that attempts to advertise protocol 1
until those gates are complete. It must not be enabled just to make admission pass.

Controller eligibility now also requires explicit image revision, architecture
and runtime selectors; a host-wide protocol flag alone grants no execution.
Withdrawal closes affected sessions without claiming cleanup or freeing their
reservations. Ordinary runners also reject selector configuration until native
acceptance is complete. See the [eligibility contract](lease-eligibility.md).

### Owned lease cleanup

The separate [libvirt supervision component](libvirt-supervision.md) now has
isolated ownership, connection-lifetime and deadline-state fixtures, plus a
dedicated child entry point, private authorization publisher and provider wiring.
Its Linux kernel timer, real driver behavior and stop/storage-removal path are
not yet natively verified. Native libvirt acceptance and teardown remain open;
this does not enable ordinary consumer admission or reclamation of a possibly
executed libvirt assignment.

Release, expiry and terminal provisioning/runtime failure transactionally issue
one stable cleanup UUID per member. The lifecycle remains released/expired/failed
through pending, running, blocked and complete reclamation. Member cleanup state,
bounded reason, attempt ordinal and `retryAt` (Unix UTC seconds) are visible in
lease inspection. A composite cleanup completes only when all members complete;
the multi-member bookkeeping fixture does not implement phone/watch acquisition
or pairing. Unavailable hosts keep their reservations and pending intent.

The heartbeat delivers `leaseCleanup` with `id`, `leaseId`, `state`, `attempts`
and `notBefore`. Reports echo the IDs, an increasing `attempt` and a state.
Completion additionally requires outer runtime `state: stopped` and literal true
`executionStopped`, `storageRemoved` and `credentialsErased` flags. Wrong IDs,
missing proof flags and active-lease completion are refused. Stale attempts cannot
overwrite a newer outcome. Repeating a blocked report does not keep extending
its retry time; retries back off to at most 60 seconds. Stop alone never releases
lease quota. Matching completion frees the host/shared/application reservations, clears
the guest preparation credential hash and omits the assignment from active
inventory. Lease/member/acquisition/cleanup identities remain as tombstones.

Independent per-member cleanup workers cannot wait behind ordinary VM
reconciliation. A durable intent outside the assignment directory blocks new
leased work. Existing reconciliation, operations, PTYs, files and displays hold
shared assignment locks; cleanup requires the exclusive lock. Cancellation closes
the member's sessions, PTYs and SSH forwards without sweeping other machines.
Busy or uncertain closure retains resources and reports a bounded blocked reason.
Host preparation, connection and transfer helpers inherit the shared lock and
publish a durable launch intent before spawning. Their records contain the member,
lease and process identity, without command arguments or credentials. After runner
loss, cleanup checks PID plus creation time and waits for surviving helpers,
including tools that close inherited descriptors. Recovered PIDs are never
signalled. Missing PID publication or unreadable identity remains blocked for
recovery. Native VM execution keeps its separate deadline and positive stop proofs;
the VM process does not inherit the helper gate.
Native deadline updates remain able to fence execution, but do not overwrite the
cleanup worker's more detailed report.

The Apple worker verifies the terminal lease and assignment fingerprint, confirms
native stop, and uses recoverable, owned storage removal. A normal guest shutdown
before expiry is also eligible after process exit, runtime-lock release and closed
disk handles; it does not require a self-exit fence marker. Only after disk removal
does cleanup atomically quarantine and erase the private assignment directory,
including per-assignment guest tokens, SSH host keys, preparation material and
operation output. A separate, credential-free receipt survives rename/removal
interruptions. After disk removal, recovery resumes its matching deletion receipt
without reconciling or recreating vanished storage. Symlinks are not followed. Shared host/operator keys and unrelated
assignments are retained. Erasure means unlinking owned files, not a claim of
forensic media sanitization or deletion of separately owned image artifacts.

A durably recorded assignment that never entered execution can be cancelled
without inventing a missing-disk success. Only absent storage or a positively
owned empty storage directory is eligible through that path. Older records with
unknown execution history remain conservative.

This pre-execution path is independent of the native provider on hosts with the
implemented POSIX assignment lock. It closes sessions, obtains exclusive
assignment access and confirms helper closure before checking the durable guard.
The assignment fingerprint and lease UUID must match, and storage may contain
only its matching owner marker. Unexpected disk/runtime content is retained.
An existing deletion receipt or removal quarantine cannot be ignored.

Before removing anything, cleanup saves `evidence: never-started` in the external
intent-bound receipt. Recovery can then resume credential quarantine/erasure
after storage removal without calling the native runtime or recreating storage.
Providers without native cleanup recovery remain blocked without that evidence. A completed
receipt refuses storage or credentials that reappear. The controller releases
quota only after the same positive cleanup acknowledgement used by native
cleanup; an erasure failure keeps reservations held.

Twelve disposable fixtures cover this path, including real controller HTTP
release, failed credential erasure, retained quota, retry acknowledgement and a
new assignment. They launch no device or native provider. This is not teardown
of an assignment that may have run. The gated libvirt adapter now separately
implements native-stop observation, owned storage erasure and interruption/reboot recovery
with isolated fixtures; actual Linux kernel/driver acceptance remains open.
Windows host assignment locking remains unfinished and ordinary consumer lease
admission remains disabled. See [libvirt teardown](libvirt-supervision.md#owned-storage-transaction-and-recovery).

New Apple lease assignments persist a bound `preparing` journal before generating
guest credentials or starting storage preparation. A durable `bootRequested`
transition precedes the native launch receipt and process spawn; restart never
resets it to `preparing`. Older or unknown execution history is recorded as
`unproven`, which cannot authorize pre-boot reclamation.
With exclusive access and helpers confirmed gone, a preparing assignment can
reclaim owned partial disks or seed-only storage without booting/reconciling a VM.
The worker checks assignment/storage ownership, rejects contradictory boot records
and foreign native metadata, verifies all storage-tree handles closed and takes
the native runtime lock when present. Removal retains the same recoverable
quarantine/receipt path. Failure before any storage was created can still erase
the owned guest credentials. Unknown launches, missing ownership, unexplained
quarantines and contradictory evidence remain blocked; a missing boot receipt
alone is not positive shutdown evidence for a leased VM.

Pre-boot fixtures cover failure before storage creation, partial disks, seed-only
storage, removal interruption, a real held file handle, sticky boot transitions
and refusal of foreign ownership or unexplained quarantines. These do not verify
an interrupted native OS preparation, expiry of a running leased VM, detached
guest-command termination or fresh-lease isolation on real infrastructure.

After a matching controller acknowledgement omits the completed member, the
runner retires its persisted assignment. Retirement continues to deny access
after restart or stale redelivery, without recreating erased credentials. A new
lease uses a new member UUID and cannot use its scoped key to inspect the old
lease. The full HTTP fixture verifies release, disk removal, credential erasure,
completion acknowledgement and restart retirement. Additional fixtures cover
active readers, runner termination with surviving helpers (with and without an
inherited lock), failed storage/credential removal, retries, quota retention and
multi-member partial failure. These are disposable fixtures; native running-VM
expiry, real consumer cleanup/reuse isolation and other provider adapters remain
acceptance gates.

Leased host helpers now launch in isolated process groups and persist version 2
receipts before use. Cancellation signals only a group whose leader is still an
unreaped direct child of this process. Non-consuming child observation preserves
PID ownership even when the leader exits before descendants close output pipes.
Cancellation, pipe draining and context teardown have bounded waits. Recovery
never signals a group using a saved PID alone: legacy, malformed or uncertain
receipts keep cleanup blocked. A known leader exit does not prove group closure.
A process that deliberately escapes its group still requires native fencing;
bounded pipe timeout retains uncertainty instead of claiming successful cleanup.
Disposable process fixtures establish this host-helper behavior, not native VM
expiry or guest process isolation.

Session negotiation returns an opaque session ID and the selected transport,
without host credentials or raw host addresses. The controller relay is implemented; runner/network acceptance remains incomplete. An operation targets an explicit
member through the [scoped durable operation API](consumer-operations.md).
Retain the existing queued/succeeded/failed/unknown receipt semantics;
uncertain side effects are never automatically replayed. A session disconnect does
not release or renew a lease. Lease termination cancels queued work and prevents
new effects; in-flight uncertainty remains visible until fenced.

## Implementation and executable verification plan

Extend the store transaction boundary for consumers, environments/members, leases,
mutation receipts and session ownership. Reuse immutable templates, machine
reservations and owned provider state. Extend runner reconciliation with explicit
deletion receipts and deadline enforcement; do not reinterpret stopped as deleted.

Use the existing unittest/HTTP fixture structure with an injected clock and real
SQLite transactions. Implementation acceptance must include:

1. Acquire/retry/conflicting body and two-consumer ownership via real HTTP.
2. Simultaneous acquisition against one remaining slot and consumer quotas.
3. Renewal/release/expiry races at exact deadline, stale revisions and retry receipts.
4. Controller restart with expired leases, unavailable cleanup worker and late reports.
5. Runner disconnect past deadline with active sessions and in-flight commands.
6. Partial provisioning/cleanup, reserved disks, process fencing and retry after restart.
7. Pair admission rollback, pairing readiness and one-member failure.
8. Cross-lease operation/session/file denial and credential rotation/revocation.
9. Capability negotiation including iOS shell denial and headless display denial.
10. Existing machine, dashboard, inference and role regression suites unchanged.

Fixture success does not establish live platform acceptance. Real client-to-environment execution and cleanup require separate native evidence.
