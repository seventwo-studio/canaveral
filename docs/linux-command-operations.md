# Experimental Linux command operations

The TypeScript controller implements durable shell-operation submission and receipts
on direct-boot Linux assignments served by an explicitly approved
`appleVirtualization` runner with command capability. The TypeScript controller owns this ledger; Rust runners own execution.
The controller and SDK tests use disposable SQLite files and fake runner peers;
they establish no native VM execution, fencing, image delivery or cleanup acceptance.
KubeVirt command dispatch, PTY and files are outside this tranche.

## Public contract

Only the lease's **current scoped key** authorizes either route. Application,
administrator and runner credentials cannot execute or inspect operation receipts.
The owning application must still be unrevoked. A current key can inspect receipts
after rotation or lease termination; the previous key cannot.

`POST /v1/leases/{leaseId}/operations` takes exactly:

```json
{"id":"<UUID>","member":"primary","action":"shell","arguments":{"argv":["printf","hello"]}}
```

The UUID, member, action and argv form the canonical intent. argv is a nonempty
string array, without NULs, with a nonempty executable and at most 65536 bytes in
its JSON encoding. New intent returns 201; identical replay returns 200; changed
intent returns 409. Another lease's operation UUID is hidden with 404.
`GET /v1/leases/{leaseId}/operations/{id}` returns the same public receipt:

```json
{"id":"<UUID>","leaseId":"<UUID>","member":"primary","state":"queued","updatedAt":"2027-01-15T08:00:00.000Z"}
```

States are `queued`, `succeeded`, `failed`, `unknown`. `result` is optional and
contains only the execution fields below. No runner or member machine identifiers,
credentials or argv appear in public receipts. Do not log argv, command output or
credential exchanges; the private database necessarily stores intent and results.

Admission requires an active ready lease, a running runtime, an actual latest
`ready.command: true` report and a current exact runner binding/approval serving
the pinned image in the lease's domain. One queued/dispatched or unknown operation
occupies the assignment lane; another submission returns 429. Replays never
redispatch, including terminal replays.

## Runner contract

Both routes are POST, using the current runner bearer and exact enrollment
`binding: {controllerId,runnerId,generation,incarnationId}`. Authentication,
ownership, validity refresh, registration and dispatch commit in one SQLite
`BEGIN IMMEDIATE` transaction. HTTP body/deadline/error limits are those of the
[lease controller](linux-lease-controller.md#runner-wire-interface).

`/v1/runners/linux-leases/operations/poll` takes exactly:

```json
{"binding":{},"assignmentId":"<UUID>","bootAttempt":"<UUID>","bundleDigest":"<64 lowercase hex>","pollId":"<UUID>"}
```

The first eligible poll registers the assignment's immutable boot UUID and bundle
digest. The digest equals the assignment image digest without `sha256:`. Assignments
never relaunch or reconnect; boot replacement is refused. The assignment itself
binds lease, member and exact runner generation/incarnation.

The response has exactly these outer fields:

```json
{
  "command": {
    "id":"<operation UUID>","leaseId":"<UUID>","memberId":"<UUID>","assignmentId":"<UUID>",
    "bootAttempt":"<UUID>","bundleDigest":"<64 lowercase hex>",
    "arguments":{"argv":["printf","hello"]},"startBefore":1800000120,
    "timeoutMs":30000,"state":"queued"
  },
  "lease":{"state":"ready","revision":2,"expiresAt":1800000300,"controllerNow":1800000000},
  "cancelRequested":false,
  "stopRequested":false
}
```

`command` may be null. A null poll creates no poll receipt, and the same poll UUID
may claim later. A nonnull receipt permanently pins poll UUID to this exact
assignment, boot, digest and operation. A lost-response replay returns that command
with its current state, including after completion or lease ending. It never
returns a different command. Poll UUIDs cannot cross bindings or assignments.
New poll UUIDs cannot claim already dispatched work.

`startBefore` is persisted at submission as `min(submitTime + 120s, lease expiry)`;
renewal never extends it. Dispatch records a server deadline of
`min(dispatchTime + 35s, lease expiry, startBefore + 35s)`. Dispatch requires current
readiness, backend/image eligibility, approval, binding, application and the key
generation that submitted the operation. Ended/closed assignments dispatch no new
work. Existing handoffs remain retrievable by their current owner for cancellation
without active readiness. `cancelRequested` is true on authorization/lease loss,
invalidated work, or a failed/unknown command. `stopRequested` separately means
the assignment lost established readiness or its owner/approval/image eligibility.
Initial provisioning without readiness returns no command and never requests a
stop solely for missing readiness. The satellite replays pending reports and
flushes current readiness before operation polling; replaying an older starting
report cannot move a poll ahead of the fresh ready report. Upgrade the controller
and satellite together for this distinction.
A terminal lease fences with no failure. On an active lease, `stopRequested`
fences with `failure: runtime`, ending the lease as failed before cleanup. A
revoked/superseded runner binding cannot authenticate; local deadlines still fence
it, while the controller retains unknown runtime and capacity for reconciliation.

With an active eligible lease and only `cancelRequested`, the satellite cancels
the matching in-flight guest command, never launches a cancelled handoff, and
keeps serving the lease. It waits for positive termination evidence; missing or
uncertain termination still fences under the existing safety rules. A confirmed
local result can acknowledge an already failed/unknown controller operation
without fencing, even when the guest exits and authority rotates before
cancellation delivery; the controller keeps its first terminal
result, including an unknown lane that cannot accept further commands. Key
rotation invalidates the operation, not the lease.

`/v1/runners/linux-leases/operations/report` takes exactly:

```json
{"binding":{},"assignmentId":"<UUID>","bootAttempt":"<UUID>","bundleDigest":"<64 lowercase hex>","operationId":"<UUID>","receipt":{"state":"succeeded","result":{"stdoutBase64":"b2s=","stderrBase64":"","exitCode":0,"signal":null,"timedOut":false,"durationMs":1,"stdoutBytes":2,"stderrBytes":0,"truncated":false,"terminationConfirmed":true}}}
```

It returns `{operationId,state}`. Reporting requires the original dispatched
operation, registered boot and exact current runner ownership, including for
closed assignments and terminal replays. A different binding is always denied.
The first terminal outcome wins forever, including server-generated unknown;
later reports return the stored outcome without replacing result evidence.

`receipt.state` is `succeeded`, `failed` or `unknown`. If present, `result` has
exactly the fields in the example. Base64 must be canonical standard padded
encoding; combined decoded capture is at most 262144 bytes. Duration and observed
byte counts are nonnegative safe integers. Observed counts must cover captured
bytes and equal them when `truncated` is false. Counts may exceed capture when
truncated. Exit code and signal are integers or null; the other flags are booleans.
Success requires exit code zero, no signal, no timeout and confirmed termination.
Failure with result requires confirmed termination and a nonzero exit, signal or
timeout. Failure without result represents definite pre-exec spawn failure.
Unknown omits result and supplies no stop or release evidence.

## Recovery and implementation boundaries

Every lease transaction refreshes pending operations before and after its effect.
Expiry, application revocation, key rotation, readiness withdrawal, stale binding
or approval/image ineligibility fails undispatched work and marks dispatched work
unknown. Undispatched start-window expiry fails; dispatched deadline expiry becomes
unknown. Restoring readiness does not resurrect an invalidated intent. Unknown
keeps the lane blocked for the assignment's remaining lifetime. No timeout clears
it and no operation receipt releases a resource reservation. Only the separate
positive lease cleanup protocol can release resources.

The additive tables are `linux_operations`, `linux_operation_boots` and
`linux_operation_polls`; existing lease state is preserved. No background timer is
required: all lease and operation interactions refresh validity conservatively.

Runner execution must durably record received intent before effects, map public
UUIDs to separate increasing guest exec UUIDs, and never repeat exec after crash.
Use `/workspace`, empty supplied environment, closed stdin and at most 30000ms
bounded by remaining authority. Drain output with bounded credit after the shared
256KiB capture limit and report truncation/counts explicitly. Controller I/O must
not block guest pumping, renewal, cancellation or local expiry. Lost reports retain
and retry the exact receipt. Unknown execution fences the lease. The native
deadline guard remains the ultimate fence; controller receipts do not prove it.

`coordination/test/linux-operations.test.ts` covers HTTP roles, SDK checks, durable
replay after lost replies/restart, immutable boot and poll ownership, malformed
results, first-terminal-wins, key/readiness/approval/application/runner invalidation,
start-window nonextension, expiry and retained unknown lanes/reservations. These
are experimental TypeScript fixtures, separate from Rust fixture coverage and
native acceptance. No native experiment is part of these checks.

`fixtures/apple-satellite/public-api.mjs` exercises the controller, TypeScript SDK,
Rust runner identity and satellite over verified loopback TLS with a fake helper
and guest. It checks synthetic command output, explicit replay after a lost submit
reply, exact report replay, 18 sequential commands in one credit window, and a crash
during an unfinished command without duplicate exec. The helper emits canned
protocol receipts; it starts no VM and executes no guest program. Portable Rust
tests separately cover truncation, output sequence/count validation and local
fencing while controller I/O stalls. Neither fixture establishes native execution.

<a id="st-535-long-commands-and-environment-unimplemented-contract"></a>

## ST-535 long commands and environment (controller implementation)

Controller status: implemented in TypeScript, with additive legacy-compatible
storage and portable tests. Runtime and native acceptance remain separate gates.

Workspace-v2 extends public `arguments` to `{argv,timeoutMs?}`. timeoutMs is an
integer 1..1800000 (30 minutes); omitted means 30000. Normalize the default before
canonical intent comparison, so omitted and explicit 30000 replay identically.
Other values/fields are 400 `invalid_request`. Existing argv and one-command-lane
rules and 262144-byte combined capture remain. Full logs should be redirected
into workspace files and retrieved with the file API. No public environment or
working-directory override is introduced; cwd remains /workspace.

Keep startBefore=min(submitTime+120s, lease expiry), without renewal extension.
For workspace-v2 dispatch, freeze
`executionDeadlineAt=min(dispatchTime+requestedTimeoutMs/1000,lease expiry)` and
server receipt deadline=min(executionDeadlineAt+5s,lease expiry). Replace the old
35-second constant together in controller and satellite. Runner command keeps
`arguments:{argv}`, top-level `timeoutMs` is the normalized requested timeout and
gains `executionDeadlineAt` (Unix UTC seconds). Replay pins both fields. Satellite
checks the 1..1800000 bound, derives conservative remaining time using the poll
send time/controllerNow and elapsed time, and sends guest exec timeout equal to
min(requested timeout, remaining execution deadline, remaining lease authority
minus its 2000ms safety margin). The margin does not shorten the command deadline.
If the minimum is nonpositive before exec, return a definite failed result with
timedOut:true, empty output and terminationConfirmed:true; no exec or lease fence
is needed.
It never starts after startBefore or extends this command on renewal. Expiry,
revocation/cancel and the independent native fence still win. A definite timeout
with confirmed descendant termination is failed/timedOut; unconfirmed execution
or receipt deadline is unknown. No timeout frees an unknown lane or reservation.
Legacy boots keep the old 30000/35000 contract; no new field reaches old decoders.

Workspace-v2 command environment is supplied by the trusted runtime after clearing
ambient variables: fixed PATH as before, HOME=/workspace/home,
TMPDIR=/workspace/tmp, npm_config_cache=/workspace/.npm. Create/check these
writable uid/gid 1000 directories before readiness. With the acquired egress grant
only, add HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy, each exactly
`http://127.0.0.1:18080`, and NO_PROXY=`localhost,127.0.0.1,::1`. Without the grant,
none of these proxy variables is supplied. Proxy listener port is fixed, not a
consumer override. Keep system CA trust in the pinned rootfs; never inject host
credentials or disable TLS verification. HTTP_PROXY does not provide plain HTTP
forwarding: only CONNECT to 443 is accepted. Package installers must use HTTPS.
A compromised command may ignore proxy settings but has no NIC or host listener.
Loss of data makes networking/files unavailable while commands and control remain
usable; it does not itself cancel an otherwise authorized command.

Public operation receipts include `dispatchedAt` (UTC timestamp) once the runner
has received the command. It remains present on terminal receipts. This proves
handoff, not successful guest execution; native expiry acceptance requires this
receipt before expiry plus independent native cleanup evidence.
