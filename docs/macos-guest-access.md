# macOS common guest access adapter

`GuestHelperAccess` connects the native helper's file, terminal, display and
accessibility protocols to the existing provider and runner interfaces. It has
isolated common-worker coverage. No production provider currently constructs it;
provider connection/bootstrap, admission and native acceptance remain open.

## HTTPS request transport

`GuestHTTPS(origin, credential, ca_file=None, timeout=20)` implements the
binding's request callable. It requires HTTPS with certificate and hostname
verification, using system trust or an explicitly supplied CA file. The caller
must already have verified that the endpoint and credential belong to the
current guest assignment and boot. The transport does not discover guests,
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
folder. The resolver returns `GuestHelperBinding(request, authorized,
cleanup_authorized=None)`. It must pin requests to the authenticated guest's
verified destination and current assignment/boot/lease identity. `request(path,
None)` performs a read; `request(path, object)` posts the exact JSON object.
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
  passes session authorization into `desktop_session`, so buffered native input
  cannot rely solely on a still-current machine assignment after its session
  ends. Cleanup remains separately bound to ownership.
- Accessibility uses the native flat snapshot directly. The explicit internal
  `inspection_systems` declaration lets `inspect_provider` and the common runner
  select this adapter for macOS. Source, coordinates, schema and byte envelope
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
filesystem, networking, expiry or isolation behavior. Native bootstrap, verified
transport, permission/readiness checks, input/inspection refresh, capture/clone
and the full lease lifecycle still require implementation or native acceptance
under the six-workstream plan.
