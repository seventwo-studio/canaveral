# Outbound environment access

The packaged [session control contract](session-protocol.md) defines current
JSON envelopes, peer directions and binary-message metadata. Stream sequencing,
authorization and completion rules below still apply beyond shape validation.

Implementation contract. Native acceptance limits are described below.
The controller session store, paired WebSocket relay and scoped Python session
client are implemented. The local dashboard still opens provider connections
directly from its attached agent. Outbound runner workers now attach PTYs and
streaming file, display and native accessibility providers, with durable attempt receipts and local lease fencing.
Ordinary live runners still cannot advertise lease execution protocol 1. Tests
execute disposable PTYs and files through the complete broker/runner/SDK path,
not a real VM or simulator. Live display attachment, remote network/TLS and platform
acceptance remain open.

Leased provider sessions now hold shared assignment locks for their lifetime.
Terminal cleanup closes the member's connections and requires exclusive access
before removing its guest credentials. A durable cleanup tombstone blocks new
session work and stale replay. [Owned cleanup](leases.md#owned-lease-cleanup)
has disposable HTTP/filesystem fixture coverage; it does not enable live consumer
placement or establish remote platform acceptance.

## Implemented session endpoints

All paths require bearer authentication. Only a lease-scoped credential can create,
inspect, close or attach a consumer session; an application key must exchange for
that scoped credential first. Host attachment uses the assigned host credential.

| Method and path | Purpose |
| --- | --- |
| POST `/v1/leases/{lease}/sessions` | Admit `{"id":"<UUID>","member":"primary","capability":"pty"}`; return 201 or 200 for an identical retry |
| GET `/v1/leases/{lease}/sessions/{session}` | Inspect owned session metadata |
| POST `/v1/leases/{lease}/sessions/{session}/close` | Idempotent close with `{}` |
| GET `/v1/leases/{lease}/sessions/{session}/{generation}` | Consumer WebSocket attachment |
| GET `/v1/hosts/{host}/sessions/{session}/{generation}` | Outbound runner WebSocket attachment |

WebSockets negotiate `canaveral-session-v1`. Both receive a JSON `type: ready`
control only after both upgrades succeed and authorization is rechecked. Session
states are `pending`, `attaching`, `ready`, `closed`, `expired`, `revoked` and
`disconnected`. A terminal session ID is a tombstone: identical creation retries
return its terminal state, and attachments cannot replace it. Create a fresh
session ID after disconnect; never replay uncertain terminal input.

Heartbeat `accessSessions` contains up to 100 unclaimed runner attachments per
delivery batch, including machine identity and controller time. Claimed peers
leave that batch. This bounds delivery size without imposing a session-count cap.
Public metadata contains no host address or credential. Session rows retain a
credential hash binding, not plaintext keys or stream payloads. Lease-key rotation,
application revocation, member/host loss, protocol withdrawal, lease expiry and
controller restart invalidate existing attachments.

Each forwarded payload checks a fresh read-only authorization snapshot, including
the exact lease deadline and credential binding. A separate watcher closes idle
or blocked peers when authorization ends. Read-only checks do not enter the
ordinary global write transaction. Server shutdown closes peers and waits for
their disconnection receipts; restart fences all persisted nonterminal sessions.

Fixture verification covers ownership/generation/duplicate claims, expiry,
rotation, restart/shutdown, malformed upgrades, browser-origin denial, bounded
messages, 72 simultaneous sockets with HTTP/renewal responsiveness and a blocked
64 MiB producer with bounded application memory. The SDK answers ping controls
through a background reader while its caller is idle. Its queue holds one bounded
message and applies backpressure; it never reconnects or replays input by itself.
These checks establish transport behavior. Runner tests additionally execute two
independent fixture PTYs, durable multi-megabyte/empty uploads and verified
downloads, reject missing/wrong finish controls and changed sources, and close
PTYs at the local monotonic deadline with controller polling stopped. They do
not establish live VM/simulator execution or complete lease cleanup.

## Runner provider workers and file completion

The runner consumes heartbeat attachments in a separate worker, verifies the
assignment fingerprint and pinned lease/member, then opens an outbound socket.
It persists a per-session attempt before connecting or dispatching effects.
Duplicate delivery or restart never replays an uncertain attempt. Receipts store
session identity, state and owned PTY cleanup outcome; they contain no command
text, paths, file content or credentials. New work and active connections require
the persisted monotonic lease guard, a running ready assignment and controller
contact within 20 seconds. Closing a session requests closure of its owned PTY.
This closes the client process; detached guest commands still require VM fencing.

Upload `begin` carries `path`, `size` and optional app-container `app`. Binary
messages follow, then `finish` with exact `bytes` and SHA-256. The runner withholds
the final bytes from the provider until that finish validates. Zero-length files
also require finish. Success is acknowledged only after the provider reports
durable atomic publication. A provider without a durable acknowledgement yields
an uncertain outcome rather than a false success. Android's optional
[native helper](android-transfer.md) now has provider/worker/SDK fixtures; its
real-device durability acceptance remains open. Without its manifest the consumer
worker refuses Android durable uploads before guest mutation, while direct legacy
drive uploads remain explicitly unconfirmed. Failed/short uploads use provider temporary cleanup.

Download `begin` carries `path` and optional `app`; the runner returns byte length,
bounded binary messages and a final byte count/digest after source verification.
Regular-file providers compare inode/device, size and modification/change times.
The current Linux helper supplies a private identity header and authenticated HEAD
recheck; older helpers need an update before broker download verification works.
SDK download writes into the caller's stream, which may contain partial data if
completion fails. It never reports that partial output as a complete download.

## Connection and authorization

`capability: accessibility` admits a separate read-only native-inspection session
when the member exposes `hierarchy`. It uses chunked JSON snapshot bytes and a
verified finish, rather than fitting the tree into a 16 KiB control or acquiring
display ownership. See [scoped native accessibility](scoped-accessibility.md) for
the wire contract, schema, SDK method and inspect-then-act flow.

### Display ownership

The runner and attached local dashboard share one input owner per machine.
Every new RFB connection begins view-only. A JSON control
`{"type":"input-control","action":"take"}` requests ownership; `release`
relinquishes it. The runner replies with `type: control` and a `state` of
`owned`, `busy`, `view-only`, `reset-uncertain`, `stale` or `not-ready`.
Only `owned` enables input in the dashboard. Raw key, pointer and clipboard
messages from other viewers are discarded on the runner, regardless of client UI.

Discrete input uses this same arbiter. Administrative queued tap/swipe, text/key,
accessibility actions and device/app controls acquire an exclusive temporary
claim. A busy refusal is persisted as `failed` with `input_busy`, before any
provider dispatch; redelivery of that operation ID returns the same receipt.
Read-only screenshots, accessibility inspection, files and independent shells do
not acquire display input. Arbitrary guest shell commands can affect the guest
desktop; input ownership does not sandbox processes inside a fully controlled guest.

An owning viewer instead sends an ordered JSON request on its display stream:

```json
{"type":"action","id":"<stable operation UUID>","action":"accessibility-action","arguments":{"snapshotId":"<snapshot UUID>","nodeId":"<node>","nativeAction":"click"}}
```

The runner returns `{"type":"action-result","id":"<same UUID>","state":"succeeded|failed|unknown","result":{}}`.
Only documented provider-supported input actions are admitted; a common envelope
does not add missing platform actions. The dashboard inspector uses this route
while its viewer owns control, and uses the guarded administrative queue when it
does not. Operation receipts are locked per machine/UUID across both paths before
checking or writing the started receipt. Concurrent delivery cannot execute twice.
Do not generate a replacement UUID after an uncertain outcome.

`{"type":"action-receipt","id":"<operation UUID>"}` inspects the bound machine's
local receipt without input ownership or execution. It returns the same
`action-result` envelope. Missing/incomplete receipts report `unknown`; absence
does not prove an action never ran. The lookup never resolves another machine's
folder or exposes its private fingerprint. Oversized action results preserve the
known state but replace output with `outputOmitted`, keeping the 16 KiB envelope.
The browser rejects pending input promises on disconnect and never replays them.

A provider exception after dispatch keeps the outcome unknown and blocks input
handover. Explicit pre-dispatch refusals release the temporary claim without
blocking recovery. The Linux helper distinguishes stale/moved/unavailable
accessibility targets from unconfirmed action execution with `input_rejected`;
simulator target validation uses the same distinction. Existing Linux helpers
must be updated to return that structured code. An old helper's ambiguous error
remains uncertain rather than being treated as safe to retry.

The private provider connection uses RFB 3.8 with provider-side authentication
already supplied by its protected transport. The endpoint always uses shared
initialization and replaces the private desktop name with a generic label.
Client framing is incremental and bounded; unimplemented input extensions are
rejected, and encoding negotiation only passes supported framebuffer encodings.
Public binary chunks remain at most 64 KiB. Viewing does not grant input ownership.

Release/disconnect dispatches held-key releases and a neutral pointer state on
native RFB connections. RFB supplies no execution acknowledgement for these
messages, so successful socket dispatch is not proof of guest-side execution.
Simulator adapters use an ordered private cancellation barrier instead: discarding
an unfinished gesture must not generate a tap. This barrier is never accepted
from consumer RFB input. An uncertain reset blocks subsequent owners. A persisted
active owner also becomes blocked after runner restart; only a positively newer
owned boot identity clears that uncertainty. Apple and Android launch receipts
supply boot identities; runtimes without one remain blocked pending recovery.
Receipts contain machine/viewer and boot identity metadata, never keys or content.

Fixture tests cover real broker/SDK display handshakes, server-side view-only
denial, competing viewers, fragmented input, demand-driven frames, reset failure,
restart and stale-boot fencing, and cancellation without an accidental tap.
Additional fixtures cover guarded administrative dispatch with simultaneous reads,
competing operation channels, definite stale-target rejection, durable busy
receipts, in-band action retries/receipt lookup and browser accessibility routing.
These do not establish live platform display support or close the lease cleanup gate.

Local native acceptance on 2026-11-02 additionally completed the attached Linux
clone's 1440×900 RFB handshake, acquired input ownership, refused a competing
administrative accessibility click with a persisted `input_busy` receipt, read
that receipt through the display channel and released ownership. No click or
typing reached the guest. Five retained machine identities, native boot receipts
and 189 GiB of disk reservations remained unchanged. This proves local native
arbitration, not a live consumer lease or separate-network outbound execution.

Every interactive session has its own WebSocket pair at the controller. The
consumer connects to the public session endpoint; the assigned runner connects
outbound to the host attachment endpoint. No inbound host port, guest address,
SSH credential or simulator endpoint is returned to a consumer. Independent
sessions avoid shared head-of-line blocking and require no global multiplexing
buffer. There is no configured shell-count or per-file size ceiling.

1. A lease credential creates a session for an explicit environment member and
   supported capability. The controller checks ownership, lease deadline, member
   readiness and capability inside the session-creation transaction.
2. The controller persists the session UUID, owner, member, capability, generation,
   authorization deadline and state. Creation retries use an immutable caller UUID.
   The response contains an opaque ID and supported protocol, never a credential in
   a URL. The consumer authenticates its WebSocket with an Authorization header.
   The browser gateway uses its existing authenticated, same-origin boundary.
3. The next runner heartbeat returns the pending attachment and its generation.
   The runner opens an outbound authenticated WebSocket using its host credential.
   The controller verifies the member's pinned host and the exact generation.
   A host credential cannot attach a consumer socket or inspect unrelated sessions.
4. Both peers receive `ready` only after authorization is rechecked and both sockets
   are present. Attachment expires after 30 seconds. Late or duplicate attachments
   fail without replacing a live peer or replaying an operation.
5. Each access path checks the current lease and session generation. Credential
   rotation, release, expiry, operator revocation or host loss closes both peers.
   Authorization never follows from possession of the session UUID alone.

TLS is required beyond explicitly configured trusted local development. Origin,
Host, duplicate-header and browser CSRF checks remain in force at the gateway.
Proxy headers cannot establish identity. WebSocket upgrade is not an exemption
from authentication, admission or bounded HTTP handler accounting.

## Payloads and flow control

Control messages are UTF-8 JSON objects of at most 16 KiB. Binary messages are at
most 64 KiB. Oversized, malformed or unexpected messages close that session with
a safe protocol error. Credentials and file bytes never enter persisted operation
bodies, logs or error strings. Disable WebSocket compression for relay data.

The relay streams one bounded frame at a time and blocks reads when its paired
socket cannot accept output. Its application buffer is at most 128 KiB per
direction, independent of file size or total shell output. A 30-second blocked
write closes the session instead of buffering further data. Socket worker slots
are independent of the bounded ordinary HTTP request pool. System resource
exhaustion yields an explicit retryable admission error; there is no arbitrary
product-level session cap.

| Capability | Payload contract |
| --- | --- |
| PTY | Binary terminal output; ordered JSON input/resize controls using the existing guest shell contract. Create one PTY per session. Never echo or replay unacknowledged input on reconnect. |
| Display | Binary RFB stream, including native VNC or the simulator RFB adapter. Keep shared screen coordinates, pointer and keyboard semantics. Take/release input control is authorized separately from viewing. |
| Upload | A bounded `begin` control carries member-relative file scope, destination and byte length. Stream binary chunks into an owned temporary file. Commit atomically only after exactly that many bytes and an explicit `finish`. |
| Download | A bounded metadata control identifies the authorized file and byte length; binary chunks follow. `finish` reports completion. Missing or changed source identity is an error, not silent success. |

File lengths use validated nonnegative integers. The supported JSON integer range
is a protocol representation bound, not a storage policy. Path resolution and
app-container restrictions run in the provider on the runner. Consumers never
select a host filesystem path or use a stream to escape their member's file scope.
Cancellation, expiry, short upload or authorization loss removes the owned upload
temporary. Unknown cleanup retains its receipt for recovery. No success response
precedes durable publication. Resume is not implicit; a failed transfer starts a
new session and a fresh temporary file.

Authorization is checked again after each blocking source read, before its bytes
reach the provider or consumer. An expired `begin` or empty-upload `finish` cannot
open a provider connection. Fixtures cover expiry while the final upload finish
arrives and while a download read returns: the former preserves the old atomic
destination, and the latter forwards no late bytes or successful finish. These
checks do not retract an already dispatched remote write; guest-side commit/deadline
enforcement and real disconnected cleanup remain separate acceptance gates.

Native screenshots, accessibility reads and discrete actions remain separate
bounded operations. Accessibility refresh is automatic while observed, with
bounded concurrent reads; freshness and selection identities follow the existing
normalized inspection contract. A shared interface does not invent an iOS shell,
a headless display, a Windows accessibility adapter or unsupported TV controls.

## Deadlines, disconnect and recovery

The controller sends an absolute authorization deadline plus its current time.
The runner derives a conservative monotonic deadline using measured heartbeat
round-trip time and bounded clock skew. Clock-health checks gate new leased
execution. Repeated or stale reports cannot extend the authorization deadline.
On macOS and Linux, heartbeat round-trip measurement and the 20-second controller
contact timeout use the same suspend-aware clock as execution authorization.
Contact age starts at dispatch of the last successful heartbeat, so time asleep,
network delay and local response processing all consume freshness. A delayed
response cannot make old assignments look newly authorized. Stale contact refuses
new work and closes broker access even if the lease itself has time remaining;
a fresh heartbeat can restore contact eligibility while the lease remains valid.
It cannot revive an expired lease or replay an uncertain operation.
If contact or renewal stops, the runner closes access and stops lease-owned
commands at that local deadline. It then starts owned cleanup. An unavailable
host retains its reservations until positive reclamation is reported.

Clock fixtures freeze awake time while advancing the continuous clock. They cover
heartbeat delay consuming lease authorization, slow response processing, stale
VM/device dispatch refusal, existing broker-session closure and refusal of a new
attachment. Actual host-suspend/network recovery remains a live acceptance gate.

WebSocket ping/pong detects transport loss; it never renews a lease. A dropped
socket ends its session generation. Reconnecting creates a new generation after
fresh authorization. Display reconnect starts a new RFB handshake and clears
pressed keys/buttons. The initial PTY implementation closes its shell on disconnect
and reports that fact; it does not promise output recovery. Durable discrete
operations retain their existing succeeded/failed/unknown receipts and are never
replayed because a stream reconnects.

Controller restart closes all sockets. Persisted nonterminal sessions become
disconnected before new attachment admission. The consumer must renegotiate;
an old host ticket or late socket cannot reclaim a new generation. Session
metadata tombstones preserve creation identity without preserving raw payloads.

## Required proofs

Encrypted loopback fixtures exercise all five capabilities and both peer TLS
connections, with explicit client CA bundles, hostname verification and redirect
rejection. See [TLS client evidence](tls-clients.md). This is not separate-network
or deployed reverse-proxy acceptance.

Run the relay with the controller and runner on distinct network boundaries where
the controller cannot open an inbound connection to the runner. Verify shell,
upload/download and display/input through the outbound path. Local attachment
success alone does not establish remote reachability or TLS deployment.

Automated tests must cover two consumers and two hosts, cross-lease denial,
wrong-host/duplicate/stale attachments, credential rotation, exact lease expiry,
runner disconnect beyond the local deadline, controller restart, pending attach
timeout, partial files and simultaneous interactive sessions. Slow readers must
demonstrate bounded memory while large files and unbounded terminal output stream.
Verify that many WebSockets leave ordinary HTTP health and renewal requests
responsive. Preserve existing dashboard and administrative machine access.

Live platform acceptance remains separate: Linux and Android local controls do
not prove Windows/macOS guest services, tvOS input, paired Watch lifecycle or a
native installer console. Record those gates in their platform issues.
