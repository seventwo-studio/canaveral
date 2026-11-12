# Guest protocol 1

Status: executable guest core. The Rust Apple satellite implements host hello/ready/renew and [lease-scoped discrete commands](linux-command-operations.md), exercised through the TypeScript consumer API with a fake guest over verified TLS. This is fixture coverage; native boot and acceptance remain outstanding. Apple Virtualization and KubeVirt remain the intended backends; KubeVirt command integration is not implemented. No Python production agent is introduced.

Transport: one AF_VSOCK stream on port 1024, accepted only from HOST_CID (2). One session per launch, no reconnect authority. Every frame is a four-byte unsigned big-endian JSON byte length (1..1048576), then UTF-8 JSON. Unknown fields, invalid types, noncanonical UUIDs and versions other than 1 fail closed. See `canaveral-guest-protocol` for exact field names. All numeric values are integers within JavaScript's safe range.

Host sends `hello`: version, binding {leaseId, memberId, revision (>0), bootAttempt (UUID), bundleDigest (lowercase SHA256 hex)}, remainingMs (>0). This binding must exactly match `/etc/canaveral/launch.json`, provisioned by the trusted launcher through an immutable per-launch config. It is not sufficient to supply an arbitrary hello. The launcher must authenticate the VM identity and bind the accepted stream to its native authorization before sending hello. Host CID restricts transport origin, not tenant authentication. Guest root can subvert guest enforcement; the native VM deadline guard remains the ultimate fence.

Host samples a conservative remaining duration after deducting transport/publication latency and safety margin; never send host absolute monotonic time. Guest applies it to local CLOCK_BOOTTIME (includes suspend). `renew` repeats the entire binding, with a strictly higher revision, before expiry. Expiry/disconnect/protocol error are sticky and end the session; no reconnect restores authority. `ready` echoes the accepted binding after separate successful `/bin/sh -c "printf 'canaveral-shell-v1\n'"`, `/usr/bin/git --version`, and `/usr/local/bin/node --version`. Debian sh does not implement --version. Each probe has its own argv and exit-code check; the trimmed first stdout line must exactly equal its shell/git/node pin in the manifest whose canonical digest matches binding.bundleDigest. This is trusted-tuple binding, not proof of the running image.

`exec`: version, id (canonical UUID), argv (nonempty strings), cwd (absolute beneath /workspace), env (string map), timeoutMs (>0). One active exec, stdin closed, environment cleared with fixed PATH `/usr/local/bin:/usr/bin:/bin` and supplied env (PATH overrides and duplicate env JSON keys are rejected); no host shell interpolation. Exec UUIDs must be strictly increasing by UUID bytes within the session, permitting replay rejection with bounded state and no execution-count cap. `credit`: version, bytes (1..1048576); outstanding credit is capped at 1048576 and counts decoded output bytes. Credit is session-wide and initially zero. `cancel`: version, id. Cancel of the active id terminates it; cancel of the last completed/spawn-failed id is an idempotent no-op. Unknown cancel ids receive `rejected` {version,id,reason:"unknownCommand"} echoing only the supplied id; no active identity is disclosed. One rejection may wait behind a partial output frame; further queued rejections close the stream rather than grow memory. The host must fully receive `ready` before the first exec, and any pending `rejected`, `spawnFailed` or `exit` control frame before sending another exec. Sending exec while a guest control frame remains unsent closes the session; there is no command queue. Other invalid/overlapping commands close the session. No implicit replay.

A definite pre-exec failure (missing executable/cwd, rejected symlink cwd, or failed spawn setup) returns `spawnFailed` {version,id} without executing the program or ending the session. The id is consumed; no implicit retry. Post-spawn setup failures remain unknown and fence the session.

Guest `output`: version, id, stream (`stdout` or `stderr`), seq (zero-based across both streams per exec), data (standard padded base64). `exit`: version, id, status (nullable integer), signal (nullable integer), timedOut, durationMs, stdoutBytes, stderrBytes, terminationConfirmed. A null status/signal with terminationConfirmed=false is an unknown receipt, never release proof. Confirmed receipts require group termination and reaping, including descendants; guest kill alone never proves native VM release. Output is drained before exit, with byte counts for emitted bytes. Backpressure stalls output and completion, never expiry/cancel/disconnect supervision. EOF and control receipts require no output credit, so a silent command completes at zero credit. Transport writes retain frame offsets; an unknown receipt is either completely written before closure or cut short by a closed stream, never followed by an interleaved frame. The reactor uses readiness polling with deadline-derived timeouts capped at 25ms for leader/orphan supervision, rather than a fixed 2ms sleep. Transport work per wake remains bounded. Fixed-size queues and pipes bound memory; there is no total-output cap.

The initial workspace is tmpfs with an explicit byte capacity in launch.json; it is disposable, volatile, and not persistent storage. Block workspaces are deferred until strict path, fresh disposable identity, expected size and ownership evidence are implemented. No code formats a guessed or retained device.

<a id="st-535-data-protocol-contract-unimplemented"></a>

## ST-535 data protocol contract

The following interface is implemented for experimental workspace-v2 boots.
Full native acceptance remains false; see the implementation boundary below.
Control protocol 1 above remains unchanged. Workspace-capable images
use bundle/launch version 2 as defined in [boot bundles](linux-boot-bundle.md#st-535-workspace-launch-contract-unimplemented).
There is no downgrade to tmpfs or NAT if v2 negotiation fails.

PID1 binds both AF_VSOCK listeners, 1024 (control) and 1025 (data), before any
consumer command can run. Only HOST_CID is accepted. The helper initiates both
connections; it never listens on host vsock. Local helper Unix relays remain
private and same-uid authenticated. Guest processes cannot create host channels.
Exactly one authenticated data connection is consumed per boot; no reconnect.
Before command readiness, control hello/ready and data hello/dataReady must both
complete, even with egress disabled. Data loss later withdraws files readiness
and closes all proxy flows, but does not withdraw command readiness or fence the
control session. Control renewal, expiry and stop remain independent.

Data frames use the existing four-byte big-endian JSON framing, with a **131072
byte** JSON limit and `version:1` (a separate data protocol). Reject unknown or
duplicate keys, invalid directions/types, noncanonical lowercase nonnil UUIDs,
noninteger/unsafe numbers and malformed padded standard base64. Every frame has
`type,version`; the table lists its other exact fields. A protocol violation
permanently closes data, never control. Partial frames retain write offsets.

| Type | Direction | Fields and meaning |
| --- | --- | --- |
| `dataHello` | host → guest | `binding,nonce`; binding equals the launch's initial control binding; nonce is 64 lowercase random hex digits from launch.json |
| `dataReady` | guest → host | `binding,nonce`; exact echo after workspace mounted/verified; no other frames precede it |
| `open` | guest → host | `id,host,port`; opens a proxy flow, port must be 443 |
| `opened` | host → guest | `id`; only after policy, route and peer checks and successful TCP connect |
| `data` | either | `id,seq,data`; seq starts at zero independently per sender, increases by one; decoded length 1..65536 |
| `credit` | either | `id,bytes`; grants decoded receive capacity, increment 1..262144; starts at zero |
| `halfClose` | either | `id`; sender has no more bytes, following its last data; receiver drains then shuts down the corresponding write half |
| `close` | either | `id`; aborts both halves and discards buffered data; receiver echoes once, no close loop |
| `error` | host → guest | `id,code`; terminal open refusal or flow failure; codes `invalid_target`, `port_denied`, `egress_denied`, `destination_denied`, `route_denied`, `connect_failed`, `connect_timeout`, `idle_timeout`, `limit` |
| `transferRequest` | host → guest | `id,step,request,remainingMs`; id is the controller transfer UUID; remainingMs is positive and never beyond current lease/step authority |
| `transferCancel` | host → guest | `id,reason`; reason is `authorization_lost`, `deadline` or `stop`; cancels that transfer even during an in-flight step |
| `transferReceipt` | guest → host | `id,step,receipt`; the exact step result, including bounded bytes for reads |

Flow IDs are guest-generated strictly increasing UUID byte values, never reused
within a boot. At most 16 flows including connecting/closing flows. Each direction
has at most 262144 outstanding decoded credit per flow. Each endpoint has a global
4 MiB decoded-byte budget across proxy and transfer buffers plus issued receive
credit; return credit only when bytes leave the buffer. Encoded buffers and frame
parsers have an additional hard 8 MiB endpoint ceiling. Stop reading producer
sockets when credit/budget is unavailable. No unbounded pending-open queue.
Reserve one 131072-byte control-frame slot independently of payload budget; bounded
round-robin work (at most 64 KiB payload per flow per turn) prevents starvation.
Connect (including DNS) is limited to 10 seconds; a flow with no payload progress
for 120 seconds closes, including credit stalls. Half-close is directional;
valid replenishment credit may cross halfClose after the local producer has
reached EOF. Accept it without resuming reads, retaining bounded credit accounting
(up to 262144); unknown/retired IDs keep the rules below. Both drained halves
close and retire the flow. Unknown IDs, data before opened,
excess credit, sequence gaps and data after halfClose are protocol violations.
A guest-initiated Close retains the flow in a closing state until the host's
ordered Close acknowledgement. Already granted payload is sequence/credit checked
and discarded, without new credit or reopening TCP. Closing flows retain their
budget and count toward the 16-flow ceiling, with a fixed 10-second close deadline
independent of payload progress. Acknowledgement releases the remaining credit.
Late opened/error/close/credit/data/halfClose frames for retired proxy IDs are
discarded after frame validation. Each endpoint retains only the highest opened
ID and at most 16 live flows: a nonzero ID at or below that high-water mark
which is not live is retired (including skipped IDs, which can never be opened).
Nil and IDs above the high-water mark remain protocol errors. Live flow
sequence, credit and phase checks remain strict. Close acknowledges a peer
Close once; an acknowledgement of a locally initiated Close is never echoed.

Transfers share the data connection, not proxy IDs or proxy credit. Exactly one
transfer step is in flight per assignment, each carrying at most 65536 decoded
bytes and one bounded receipt; this slot participates in the global budget.
Only a controller-issued UUID received on the authenticated host channel can
start file work. Guest-originated transferRequest is forbidden. The satellite
must not expose a direct local consumer transfer API. A step is `{step,request}`
where step is a positive increasing integer, beginning at 1; remainingMs is translated
to a guest CLOCK_BOOTTIME deadline and cannot be extended by replay. transferCancel
uses the reserved control-frame slot, requires no payload credit and may interrupt
a step; unknown/finished transfer IDs are idempotent no-ops. The receiver retains
the last request digest and receipt for exact replay without repeating effects.
Changed replay or a gap closes data; an old step cannot execute again.

Exact request variants (the `action` discriminator is required):

| Action | Additional fields | Successful receipt |
| --- | --- | --- |
| `beginUpload` | `path,bytes,sha256,replace` | `{state:"writing",offset:0}` |
| `beginDownload` | `path` | `{state:"reading",offset:0,bytes}` |
| `write` | `offset,data` | `{state:"writing",offset}` (next offset after fully written bytes) |
| `read` | `offset,maxBytes` | `{state:"reading",offset,data}` (next offset, maxBytes 1..65536) |
| `finish` | `bytes,sha256` | `{state:"committed",bytes,sha256,durable:true}` for upload; `{state:"verified",bytes,sha256}` for download |
| `abort` | none | `{state:"aborted"}` after closing descriptors and removing owned staging |

The satellite retains guest ownership across successful begin/read/write steps.
If it refuses a later step locally (including missed startBefore or expiry during
journal persistence), it sends transferCancel and reports unknown, preserving the
lane for the rest of the boot. Idle transferCancel queues descriptor closure but
has no closure acknowledgement, so sending it cannot justify a definite failure.
A local receipt must not suppress cancellation of the still-open guest transfer.
If the controller acknowledges unknown, or failed against a local writing/reading
receipt, the satellite preserves that receipt, blocks the lane and queues
transferCancel for the opened guest transfer. It retries until cancellation is
queued; the blocked lane and unsent cancellation survive journal replay. A
successful step acknowledgment alone does not end guest ownership.

All unsuccessful steps return `{state:"failed",code}` or
`{state:"unknown",code}`; codes are defined in the consumer contract. Finish
uses exact total bytes and lowercase SHA-256, including empty files. Read returns
nonempty bytes until declared EOF; at EOF it returns empty data. Write chunks
are nonempty, canonical padded base64, at most 65536 decoded bytes. Offsets must
equal the accepted cursor, and never exceed declared size. Finish is forbidden
before exact EOF. The guest hashes bytes incrementally; finish also rechecks
source/staged identity and content before success. Verification may run in bounded
slices but has no intermediate success receipt. Its reactor must continue control,
renewal and expiry while hashing or fsync is in progress. Cancellation must prevent any subsequent rename; if cancellation races a rename
or durability check, return unknown. A step's lost receipt
never authorizes repeating publication after process restart.

Path is a nonempty UTF-8 relative path, at most 4096 encoded bytes, with no empty,
`.` or `..` component, NUL, backslash, leading/trailing slash or reserved first
component `.canaveral`. Parent directories must already exist. PID1 pins the
/workspace root descriptor after mount and performs file work as uid/gid 1000
without supplementary groups. Every path lookup uses openat2 with
RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV;
unsupported openat2 fails files readiness. No realpath/string-prefix fallback.
Use O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC, fstat before/after I/O; require regular files,
uid 1000, one link, same workspace device. No directories, devices, FIFOs, sockets,
symlinks, hardlinks or mount crossings. Pin parent descriptors; revalidate their
reachability from workspace before publication. Detect source inode/size/mtime/
ctime/link changes through final rehash and report `source_changed`; concurrent
commands can mutate files, so downloads are verified copies, not filesystem
snapshots. Hostile guest root is outside guest-file integrity guarantees.

Uploads create exclusive staging under `.canaveral/transfers/ID` on the
workspace filesystem, mode 0600. No destination becomes visible before finish.
After size/hash/identity and current authorization checks: fsync staged file,
rename into the pinned destination parent, then fsync that directory and staging
parent. `replace:false` uses renameat2 RENAME_NOREPLACE. `replace:true` inspects
the destination relative to the pinned parent without following links: an absent
entry or regular file (any owner permitted by workspace uid access rules, any
link count) permits renameat; symlinks fail `path_denied`, other types fail
`not_regular`. Replacing a regular hardlink removes only that directory entry.
A same-tenant destination entry change between inspection and rename may be
replaced. All operations remain relative to pinned workspace descriptors.

Uid 1000 commands in the same lease are the tenant's own code and may mutate
workspace files, including writable `.canaveral` staging, before or after
publication. Guarantees are confinement (no access outside `/workspace`, no
symlink, hardlink or mount escape, no root-privileged access) and that `committed`
means bytes verified through the staged descriptor were fsynced and renamed.
It does not assert that concurrent tenant code left those bytes unchanged.
Adversarial parent/staging rename hardening beyond confinement is not a goal.
Success means durability at the guest filesystem boundary, not proven host
power-loss safety. Failure before rename is `failed`; uncertain rename or
subsequent fsync is `unknown`, never an automatic retry or rollback claim.
Existing destination and staged replacement both consume workspace space.
Abort cannot undo publication. Guest replay retains only the SHA-256 of the
canonical last request and its last receipt per transfer, at most 128 transfers;
the oldest terminal transfer is evicted first, never an in-flight transfer.

Data disconnect closes descriptors and flows; undispatched steps fail, dispatched
steps without a definite receipt become unknown. Losing data alone never kills a
running shell or prevents renewal. Expiry/revocation/stop closes every flow and
transfer; data shutdown gets at most 2 seconds and never delays native fencing.
The satellite retains reservations until separate positive cleanup evidence.

### ST-535 implementation boundary

PID1 now connects the v2 workspace, both vsock listeners, authenticated data
handshake, file worker and publication path to the control reactor. The
satellite verifies the exact private data.sock sibling, runs its independent
data reactor and requires joined closure evidence before releasing capacity.
The known throughput limit is 64 KiB per serialized transfer step.

The authorized experimental Mac run in the [native evidence record](../coordination/native-acceptance/README.md#st-535-native-evidence-2026-11-12)
observed ext4 format/mount, both handshakes, files readiness, verified round trips,
no-replace/disk-full refusal and expiry of an opened upload. File workers use raw
thread-local setresgid/setresuid syscalls to drop all real/effective/saved IDs to
1000, clear capabilities and prevent privilege regain, without changing PID1.
A root-capable Linux namespace regression checks those properties.

These observations do not establish host power-loss durability, native data-only
disconnect behavior or public egress acceptance. Public CONNECT currently fails
the required post-connect cloned-route check. Full native acceptance remains false.

### ST-535 data closure and bounded route evidence (2026-11-12)

`dataPlaneClosed` requires every outbound flow socket, relay descriptor,
data reactor thread and transfer worker to be closed/joined. Timed-out
getaddrinfo threads are excluded: they hold no guest-reachable socket and
are capped at four. This exclusion does not cover route-evidence workers.

Periodic live-flow revalidation is hard-bounded by its two-second period.
If getifaddrs/RTM_GET evidence has not completed within that period, the
satellite closes all live flows with `route_denied`. A stalled evidence
worker prevents positive joined cleanup evidence; it is never replaced by
an unbounded series of workers. Native acceptance remains required.
