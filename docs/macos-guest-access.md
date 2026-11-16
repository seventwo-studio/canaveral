# macOS common guest access adapter

The TypeScript guest adapters connect the native helper's file, terminal, display
and accessibility protocols to provider and runner interfaces. Their binding is
`GuestHelperBinding` in `coordination/src/control/session-protocol.ts`. Production
macOS guest connection/bootstrap, admission and native acceptance remain open.

## HTTPS request transport

`GuestHTTPS` in `coordination/src/guest/https.ts` implements the binding's request
callable. Its constructor accepts `origin`, `credential`, optional `caFile` and a
timeout in seconds (default 20); its `call` property is the request function. It requires HTTPS with certificate and hostname
verification, using system trust or an explicitly supplied CA file. Legacy
callers must already have verified that the endpoint and credential belong to
the current guest assignment and boot. The version 1 verified factory below
authenticates a trusted expected tuple and pins the helper incarnation. The
transport does not discover guests,
enroll identities, provision a proxy or decide trust policy.

Each call opens an independent connection, so a shell read cannot serialize
display capture or another terminal. It uses no environment proxy, follows no
redirect and performs no automatic retry. JSON requests fit the native helper's
1,000,000-byte parser envelope. Responses are bounded to 64 MiB, including
base64 display frames; errors use a 4 KiB envelope. These limits bound individual
protocol messages, not total file size or shell count. File chunks remain
streamed through the existing transfer adapter.

Malformed/truncated responses, timeouts and lost acknowledgements leave a POST
with `outcome=unknown` and `retryable=false`. Binding error redaction preserves
that outcome, including authorization ending before acknowledgement. Recognized
pre-effect display refusals retain their typed codes; arbitrary helper error
messages never enter public receipts. Socket timeouts and remaining-time checks
bound I/O; they do not supply native lease expiry or command cancellation.

The HTTPS tests use ephemeral certificates and private loopback listeners.
Common runner file transfers, independent shells, accessibility snapshots and
owned RFB input also run against synthetic helper responses over those sockets.
This establishes transport integration, not a real macOS guest, a separate
network/proxy boundary or production provider binding.

## Assignment binding

A provider supplies a resolver accepting its machine, image and assignment
folder. The resolver returns `GuestHelperBinding(request, authorized, cleanupAuthorized?)`. It must pin requests to the authenticated guest's
verified destination and current assignment/boot/lease identity. `request(path, null)` performs a read; `request(path, object)` posts the exact JSON object.
The transport must enforce bounded responses, verified TLS where applicable,
timeouts and typed helper refusals. The adapter selects no address, trust store,
credential, enrollment or initial setup policy.

Authorization is checked before dispatch and after acknowledgement. Revocation
during a request leaves its outcome unconfirmed. Calls are not automatically
replayed. Private transport exception text is replaced before entering common
operation receipts. Only recognized pre-effect display refusal codes survive.

An explicitly supplied cleanup predicate may authorize release of held input or
closure of an owned terminal after ordinary authorization ends. It must still
validate the same owned assignment. It is used for every cleanup request,
including normal release, and must return true when that cleanup is valid. It
cannot authorize new input, file publication or inspection. Without that explicit
predicate, cleanup uses ordinary authorization and may remain unconfirmed after
revocation. This is not native lease deadline enforcement or disk erasure.

## Common services

- Files use `GuestChunkFiles` for bounded, verified upload/download and native
  directory listing. Simulator app-container arguments are refused. The common
  runner validates upload finish before publication and emits download finish
  only after verification. No total file-size cap is added.
- Terminals use `GuestChunkShells` with independent session UUIDs. No shell-count
  cap is added. Native helper closure must be positively acknowledged.
- Displays use `GuestStreamScreen` through the shared RFB endpoint. The runner
  passes session authorization into the display connection, so buffered native input
  cannot rely solely on a still-current machine assignment after its session
  ends. Cleanup remains separately bound to ownership.
- Accessibility uses the native flat snapshot directly. Provider selection must explicitly bind the macOS inspection adapter; a source
  label alone cannot select or authorize a native transport. Source, coordinates, schema and byte envelope
  are checked. Snapshot identities and native handles retain helper semantics;
  screenshots travel separately on the display connection. Read-only inspection
  never claims or resets input.

Semantic input carries the owning display connection's stream/frame context and
an ordered barrier behind preceding raw events. It executes inside existing
durable provider operation receipts. Uncertain dispatch is not replayed, and
legacy helper input is never a fallback for missing stream ownership.

## Remaining gates

The resolver is an internal integration seam, not a completed transport or public
configuration option. No production provider binds it yet. `guestAccess` image
admission remains Linux-only, and ordinary runners still refuse consumer lease
execution. These changes do not admit macOS images or grant host enrollment.

Fixtures exercise common upload/download, accessibility transfer, RFB/semantic
input, distinct terminals, authorization changes, explicit cleanup, malformed
snapshots, missing bindings and private-error redaction. They use injected fake
guest responses and temporary files; they prove no real guest input, permission,
filesystem, networking, expiry or isolation behavior. Native bootstrap, production
endpoint binding, permission/readiness checks, input/inspection refresh, capture/clone
and the full lease lifecycle still require implementation or native acceptance
before provider acceptance.

## Version 1 helper identity fence (ST-591)

`verifiedGuestHelperBinding(expected, endpoint, credential, authority, options)`
returns the existing `GuestHelperBinding` after a verified TLS identity read.
The internal resolver must supply `expected()` from independently trusted state:
exact keys `version: 1`, `machineId`, `leaseId`, `fingerprint`, `launchId`.
UUIDs are lowercase canonical strings; the fingerprint is 64 lowercase SHA256
hex digits pinned to the assignment receipt (`assignmentFingerprint` on Apple).
`launchId` is an opaque future provider-minted UUID. It must not come from a
host boot clock, endpoint response, or guest assertion. No production source,
trusted bootstrap delivery or production resolver exists yet.

`DesktopBridge` accepts an optional immutable `GuestAssignmentContext`. A new
assignment requires a new helper instance. Each helper creates a fresh incarnation
UUID. The guest app stays in legacy manual mode with no environment, file or
public enable switch. Its reused cloned Keychain desktop credential is neither a
fresh assignment secret nor evidence of tenant isolation.

Bound authentication is `Authorization: Canaveral-Binding-v1 <MAC>`, where MAC is
unpadded base64url HMAC-SHA256 with the credential's UTF-8 bytes as key. The
canonical message is UTF-8, with these LF-separated lines and a final LF:

```
Canaveral-Binding-v1
identity OR request
machineId
leaseId
fingerprint
launchId
[incarnation, only for request]
```

The bracketed line is absent for identity, including its delimiter. There is no
JSON canonicalization or platform UUID formatting in this encoding. The shared
`fixtures/guest-binding-v1.json` pins exact bytes and both authenticators; actual
Swift and TypeScript implementations independently check it.

Only bound mode exposes authenticated `GET /v1/identity`, requiring the exact
target and an empty body. Its response has exactly the tuple keys plus
`incarnation` and fits 4 KiB. This read has no mutation journal or enrollment UUID.
Identity-kind authentication grants only this read. All other endpoints require
request-kind authentication with the pinned incarnation; endpoint bodies and
schemas stay unchanged. The bridge compares authentication in constant time
before its first await or route delegation. Bound mode refuses Bearer; legacy
helpers extract an empty bearer for the binding scheme and reject before effects.

The verifier compares all trusted tuple values, pins the returned incarnation,
and combines `authority()` with a fresh `expected()` comparison before dispatch
and after acknowledgement. Once observed invalid, authority or expected-state
changes permanently invalidate the binding, even if values later revert. A 401,
including restart/incarnation refusal, permanently invalidates it. There is no
fallback, retry or automatic rebinding; a new explicit resolution can verify a
fresh helper. Private responses and transport diagnostics never enter identity
errors. Lost POST acknowledgements and revocation during acknowledgement retain
unknown outcomes. The verified factory supplies no separate cleanup authority;
existing binding cleanup ownership rules still apply and cleanup may remain
unconfirmed after revocation.

The helper cannot independently learn host-side revocation. This protocol does
not enforce native permissions, readiness, lease deadlines, cancellation, owned
cleanup, disk erasure or capture/clone acceptance. Trusted bootstrap, credential
isolation, endpoint discovery and those native lifecycle gates remain open.
`guestAccess` admission remains Linux-only. Portable protocol verification does
not establish usable or accepted macOS workspace delivery.
