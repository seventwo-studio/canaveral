# Guest protocol 1

Status: executable guest core. The Rust Apple satellite implements host hello/ready/renew and [lease-scoped discrete commands](linux-command-operations.md), exercised through the TypeScript consumer API with a fake guest over verified TLS. This is fixture coverage; native boot and acceptance remain outstanding. Apple Virtualization and KubeVirt remain the intended backends; KubeVirt command integration is not implemented. No Python production agent is introduced.

Transport: one AF_VSOCK stream on port 1024, accepted only from HOST_CID (2). One session per launch, no reconnect authority. Every frame is a four-byte unsigned big-endian JSON byte length (1..1048576), then UTF-8 JSON. Unknown fields, invalid types, noncanonical UUIDs and versions other than 1 fail closed. See `canaveral-guest-protocol` for exact field names. All numeric values are integers within JavaScript's safe range.

Host sends `hello`: version, binding {leaseId, memberId, revision (>0), bootAttempt (UUID), bundleDigest (lowercase SHA256 hex)}, remainingMs (>0). This binding must exactly match `/etc/canaveral/launch.json`, provisioned by the trusted launcher through an immutable per-launch config. It is not sufficient to supply an arbitrary hello. The launcher must authenticate the VM identity and bind the accepted stream to its native authorization before sending hello. Host CID restricts transport origin, not tenant authentication. Guest root can subvert guest enforcement; the native VM deadline guard remains the ultimate fence.

Host samples a conservative remaining duration after deducting transport/publication latency and safety margin; never send host absolute monotonic time. Guest applies it to local CLOCK_BOOTTIME (includes suspend). `renew` repeats the entire binding, with a strictly higher revision, before expiry. Expiry/disconnect/protocol error are sticky and end the session; no reconnect restores authority. `ready` echoes the accepted binding after separate successful `/bin/sh -c "printf 'canaveral-shell-v1\n'"`, `/usr/bin/git --version`, and `/usr/local/bin/node --version`. Debian sh does not implement --version. Each probe has its own argv and exit-code check; the trimmed first stdout line must exactly equal its shell/git/node pin in the manifest whose canonical digest matches binding.bundleDigest. This is trusted-tuple binding, not proof of the running image.

`exec`: version, id (canonical UUID), argv (nonempty strings), cwd (absolute beneath /workspace), env (string map), timeoutMs (>0). One active exec, stdin closed, environment cleared with fixed PATH `/usr/local/bin:/usr/bin:/bin` and supplied env (PATH overrides and duplicate env JSON keys are rejected); no host shell interpolation. Exec UUIDs must be strictly increasing by UUID bytes within the session, permitting replay rejection with bounded state and no execution-count cap. `credit`: version, bytes (1..1048576); outstanding credit is capped at 1048576 and counts decoded output bytes. Credit is session-wide and initially zero. `cancel`: version, id. Cancel of the active id terminates it; cancel of the last completed/spawn-failed id is an idempotent no-op. Unknown cancel ids receive `rejected` {version,id,reason:"unknownCommand"} echoing only the supplied id; no active identity is disclosed. One rejection may wait behind a partial output frame; further queued rejections close the stream rather than grow memory. The host must fully receive `ready` before the first exec, and any pending `rejected`, `spawnFailed` or `exit` control frame before sending another exec. Sending exec while a guest control frame remains unsent closes the session; there is no command queue. Other invalid/overlapping commands close the session. No implicit replay.

A definite pre-exec failure (missing executable/cwd, rejected symlink cwd, or failed spawn setup) returns `spawnFailed` {version,id} without executing the program or ending the session. The id is consumed; no implicit retry. Post-spawn setup failures remain unknown and fence the session.

Guest `output`: version, id, stream (`stdout` or `stderr`), seq (zero-based across both streams per exec), data (standard padded base64). `exit`: version, id, status (nullable integer), signal (nullable integer), timedOut, durationMs, stdoutBytes, stderrBytes, terminationConfirmed. A null status/signal with terminationConfirmed=false is an unknown receipt, never release proof. Confirmed receipts require group termination and reaping, including descendants; guest kill alone never proves native VM release. Output is drained before exit, with byte counts for emitted bytes. Backpressure stalls output and completion, never expiry/cancel/disconnect supervision. EOF and control receipts require no output credit, so a silent command completes at zero credit. Transport writes retain frame offsets; an unknown receipt is either completely written before closure or cut short by a closed stream, never followed by an interleaved frame. The reactor uses readiness polling with deadline-derived timeouts capped at 25ms for leader/orphan supervision, rather than a fixed 2ms sleep. Transport work per wake remains bounded. Fixed-size queues and pipes bound memory; there is no total-output cap.

The initial workspace is tmpfs with an explicit byte capacity in launch.json; it is disposable, volatile, and not persistent storage. Block workspaces are deferred until strict path, fresh disposable identity, expected size and ownership evidence are implemented. No code formats a guessed or retained device.

## ST-535 data protocol contract (unimplemented)

The following is a required future interface, not executable behavior or native
acceptance. Control protocol 1 above remains unchanged. Workspace-capable images
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
both drained halves close and retire the flow. Unknown IDs, data before opened,
excess credit, sequence gaps and data after halfClose are protocol violations.
Terminal frames already queued for a just-retired ID may be discarded; retain at
most 16 such IDs until the next open, then reject stale traffic.

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

Uploads create exclusive private staging under `.canaveral/transfers/ID` on the
workspace filesystem, mode 0600. No destination becomes visible before finish.
After size/hash/identity and current authorization checks: fsync staged file,
rename into the pinned destination parent, then fsync that directory and staging
parent. `replace:false` uses atomic no-replace; `replace:true` may replace only a
revalidated eligible regular file. A publication race must fail closed. Success
means durable at the guest filesystem boundary, not proven host power-loss safety.
Failure before rename is `failed`; uncertain rename or subsequent fsync is
`unknown`, never an automatic retry or rollback claim. Existing destination and
staged replacement both consume workspace space. Abort cannot undo publication.

Data disconnect closes descriptors and flows; undispatched steps fail, dispatched
steps without a definite receipt become unknown. Losing data alone never kills a
running shell or prevents renewal. Expiry/revocation/stop closes every flow and
transfer; data shutdown gets at most 2 seconds and never delays native fencing.
The satellite retains reservations until separate positive cleanup evidence.

### ST-535 implementation boundary

`guest-protocol::data` implements closed frame/request/receipt schemas, a poisoned
131072-byte decoder, canonical payload checks, separate flow and transfer IDs,
credit/budget accounting, half-close decisions, step replay and cursor/hash
validation. `guest-agent::workspace` supplies portable discovery/identity decisions
and Linux openat2 read confinement primitives. None is connected to PID1's v1
control reactor. The data listener, authenticated handshake, file worker and
publication/durability path remain unimplemented. No files readiness is advertised.
The known throughput limit is 64 KiB per serialized transfer step.
