# Consumer HTTP contract

The packaged [OpenAPI document](../canaveral/schemas/consumer-api.openapi.json)
describes the implemented application/lease HTTP interface using
[OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) and JSON Schema 2020-12.
Load it without a controller connection or optional validator dependencies:

```ts
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("canaveral/schemas/consumer-api.openapi.json", "utf8"));
```

The JSON file is the canonical wire artifact; update it alongside endpoint changes
and run the corresponding TypeScript contract checks. Reading it does not contact
the controller or enable an unsupported route. Runtime support remains bounded
by the controller modules and provider implementations described in this guide.

## Covered endpoints

| Operation | Credential |
| --- | --- |
| Discover the pinned catalogue; acquire and list leases | Application key |
| Inspect, renew or release an owned lease | Application key or that lease's current key |
| Rotate a lease key | Application key |
| Submit or inspect a durable member operation | That lease's current key |
| Create, inspect or close a member session | That lease's current key |
| Attach the consumer WebSocket peer | That lease's current key and session generation |

Credentials are opaque bearer secrets, not OAuth scopes or JWT claims. The
contract introduces no enrollment or host-approval policy. Administrative,
host-runner, model, image-import and dashboard endpoints are outside this document.
These routes do not imply additional consumer integrations.

Acquisition currently creates a `primary` member. Naming a member explicitly in
session requests does not implement paired phone/watch acquisition. Capabilities
describe adapter contracts; readiness and live platform support remain separate.
Ordinary runners still cannot advertise consumer lease execution.

The [durable operation contract](consumer-operations.md) describes scoped commands,
retained receipts and uncertain effects.

The WebSocket entry describes its HTTP upgrade only. The packaged
[session control schema](session-protocol.md) covers direction-specific JSON
envelopes. RFB, PTY, file and accessibility binary streams retain their [outbound transport](access-transport.md),
[visual SDK](visual-sdk.md) and [accessibility](scoped-accessibility.md) contracts.
The snapshot JSON Schema covers accessibility payloads independently.

## Client behavior beyond shape validation

Persist caller-owned acquisition, mutation, operation and session UUIDs before dispatch.
Reuse the same identity and body after uncertainty; a retryable error does not
authorize a new side effect. Stream disconnect never authorizes input replay.
Credential rotation is a separate, non-idempotent operation: it revokes the old
lease key and sessions. Do not use it as a credential lookup or automatically
retry it. Credential responses must not be logged.

A mutation replay returns the original mutation receipt alongside the current
lease view. Their state, revision and deadline can differ. Terminal lease state
does not establish positive cleanup or release retained reservations. Resource
minima, memory granularity, application-specific limits, total lifetime, ownership
and readiness require controller checks beyond JSON shape.

Normal errors contain `error`, `message`, `code`, `requestId` and `retryable`.
Unexpected service failures still return an error-only 503 object; clients must
accept that existing response. A 429 includes `Retry-After: 60`. HTTP responses
are not cacheable. Browser-origin requests are rejected; credentials do not
belong in URLs. Remote deployments require operator TLS termination.

## Verification and remaining scope

Contract tests validate the OpenAPI structure, local schema references and
component metaschemas. Temporary controller fixtures check catalogue, acquisition
and replay, durable operation delivery/revocation, pagination, quota errors, credential rotation, session capabilities,
attach states, exact expiry, renewal replay with a newer lease view, blocked
cleanup, role/ownership errors and the legacy 503 response. Negative schema cases
reject malformed UUIDs, unsupported capabilities, invalid resource values,
unexpected host fields and session secret leakage.

These are fixture proofs, not separate-network TLS or native environment
acceptance. Binary interoperability, live client examples, recovery and
portable release acceptance remain open. Provider acceptance must be recorded separately from portable fixture results.

The additive [durable waiting request API](requests.md) accepts over-requested lease intent through `/v1/requests`; direct lease acquisition retains its existing errors.

<a id="st-535-linux-file-routes-unimplemented-contract"></a>

## ST-535 Linux file routes (controller implementation)

Controller status: implemented in TypeScript, with additive legacy-compatible
storage and portable tests. Runtime and native acceptance remain separate gates.

These routes are implemented by the TypeScript Linux controller and included in
the packaged OpenAPI and TypeScript lease-key client.
They apply only to a workspace-v2 direct-boot Linux `primary` member with latest
`ready.files:true`. No session/WebSocket or absolute guest path is accepted.
Existing session binary framing remains unchanged. Reuse the transfer library's
bounded copying, guard and canonical base64 semantics; Linux dispatch and relative
path validation are new. This interface uses 64 KiB chunks (the existing wire
chunk limit), not the generic 512 KiB guest adapter's envelope.

Only this lease's **current key** may submit steps or read receipts/bytes, including
after key rotation or lease termination. Application, administrator and runner
keys cannot use these routes. The owning application must be unrevoked. A new
current key may inspect older receipts but never resume an invalidated transfer.
Authentication/authorization is rechecked for every request and immediately before
handoff/publication. Foreign lease/transfer IDs are hidden by 404.

All requests use bearer auth, no Origin, one Content-Length, JSON ≤131072 bytes,
20-second HTTP deadline, no cache and no automatic redirects. UUIDs are canonical
lowercase nonnil UUIDs; integers are safe nonnegative integers. Paths and guest
file eligibility use the [guest confinement contract](guest-wire.md#st-535-data-protocol-contract-unimplemented).
No arbitrary environment, host path, egress policy or assignment field is accepted.

| Method/path under `/v1/leases/{leaseId}/transfers` | Exact JSON body | Result |
| --- | --- | --- |
| `POST /` | `{id,member:"primary",direction:"upload",path,bytes,sha256,replace}` or `{id,member:"primary",direction:"download",path}` | 201 new transfer, 200 identical replay; returns Transfer |
| `GET /{id}` | none | 200 Transfer |
| `POST /{id}/steps` | `{step,request}` | 202 admitted/pending step, 200 completed exact replay; returns Step |
| `GET /{id}/steps/{step}` | none | 200 Step |

Creation durably records intent only; it does not execute a guest open. Client
then sends step 1 `beginUpload` or `beginDownload`, exactly matching creation
fields (or `abort` to abandon an unopened transfer without guest work). Steps increase by one; use the guest request variants for `write`, `read`,
`finish`, `abort`. A second in-flight step is 409 `step_pending`; a different active
transfer is 429 `transfer_busy`. Caller persists transfer UUID and exact step
bodies before dispatch. Replays are idempotent by UUID/step/normalized-body hash;
changed intent is 409 `idempotency_conflict`. Identical replay returns current
state and never repeats guest effects, even for terminal/unknown transfers.

Transfer is exactly `{id,leaseId,member,direction,state,offset,bytes,sha256,durable,updatedAt,error}`.
States are `created`, `writing`, `reading`, `committed`, `verified`, `aborted`,
`failed`, `unknown`. `bytes` is declared upload size or discovered download size
(null until begin); `sha256` is expected upload hash or final verified download
hash (null until finish). `durable` is true only for committed uploads. `error`
is null or `{code,outcome:"failed"|"unknown"}`. updatedAt is ISO-8601 UTC.
Step is exactly `{id,step,state,receipt,updatedAt}`; state is `queued`, `dispatched`,
`succeeded`, `failed`, `unknown`; id is transfer UUID, receipt is null until
terminal, then the guest receipt or a controller failure/unknown receipt. No
credentials, private paths, argv or machine identifiers appear. Final step receipts
and transfer state remain inspectable for the same retention lifetime as operations.

Only the latest successful read step includes its receipt's `data`. Admission of
the next step discards previous read bytes; fetching/replaying an older read then
returns 410 `chunk_evicted` and never reads that offset again. Client must persist
and hash bytes before advancing. Finish/abort discard the last payload. Receipts
retain offset/size/hash metadata, not a permanent artifact store. A download is
complete only after client verifies total bytes/hash and receives `verified` for
its finish request. Upload succeeds only on `committed` with durable true and the
exact expected size/hash. A 202 or a successful chunk is no publication evidence.

There is no separate product file-size cap: size must fit workspace raw bytes and
safe integer range. Available ext4 space may be smaller; replacing a file needs
room for old and staged bytes. Empty files are valid. Each read/write transfers
1..65536 decoded bytes except an EOF read's empty result. Chunk hashes are retained
for replay comparison; finish SHA-256 is 64 lowercase hex digits. Declared count,
finish count/hash and observed cursor must agree. No seek, append, recursive
copy, directory creation or file deletion API is introduced.

Errors use the existing envelope with `retryable:false` except transient
pre-admission backpressure (503, retryable true). Validation: 400 `invalid_request`,
`invalid_path`, `invalid_cursor`; auth: 401 `invalid_credential`, 403
`credential_role`; unavailable capability/readiness: 409 `capability_unsupported`,
`files_not_ready`; terminal authorization: 410 `lease_ended`; payload: 413
`chunk_too_large`. File failures are durable failed step receipts, not HTTP
transport errors: `not_found`, `path_denied`, `not_regular`, `hardlink_denied`,
`destination_exists`, `disk_full`, `size_mismatch`, `digest_mismatch`,
`source_changed`, `io_error`, `deadline`, `authorization_lost`,
`controller_restarted`, `data_channel_lost`. Unknown receipts use
`publication_unknown`, `transport_unknown` or `deadline`; HTTP uncertainty is
inspected by UUID/step before further action. Never automatically allocate a new
UUID to repeat an unknown upload. Unknown blocks the file lane until lease ends;
release still requires positive cleanup, not an abort or failed transfer receipt.
