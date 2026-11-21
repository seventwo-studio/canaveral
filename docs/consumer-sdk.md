# TypeScript consumer HTTP SDK

`coordination/src/consumer-client.ts` (export `@canaveral/coordination/consumer-client`)
is a small Node 24 client for the application/lease subset of the
[consumer HTTP contract](consumer-api.md). It uses only the Node standard library.

| Class | Credential | Operations |
| --- | --- | --- |
| `ConsumerClient` | Application key | `submitRequest`, `inspectRequest`, `listRequests`, `cancelRequest`, `catalogue`, `listLeases`, `acquireLease`, `inspectLease`, `renewLease`, `releaseLease`, `rotateLeaseCredential` |
| `LeaseClient` | One lease's current key | `inspect`, `renew`, `release`, `createOperation`, `operation` for its bound lease |

`memberSource(lease, member?)` returns `"warm"`, `"cold"` or `undefined` for a lease member:
whether its device was taken over from the host's
[warm pool](warm-pool-and-baselines.md#what-a-consumer-sees) or booted for the lease.

`LeaseClient` has no catalogue, listing, acquisition or credential-rotation method, and each
client sends only its own bearer. `rotateLeaseCredential` is the explicit owner-only exchange:
it is not idempotent, is never retried, revokes the previous lease key, and its result must not
be logged. After an unknown outcome, inspect the lease before deliberately exchanging again.
The companion `coordination/src/sdk.ts` extends these clients with private credential
file loaders, `scopedLease`, session creation/attachment, streaming files,
lease-key app installs (`uploadApp`, `appArtifact`, `deleteAppArtifact`, `installApp`),
MP4 recording (`video`) and live screen views (`live`) for leased Android emulators
([lease recording and large installs](mobile-control.md#lease-recording-and-large-installs),
[live screen views](visual-sdk.md#live-screen-views)),
[port tunnels](#lease-port-tunnels) (`tunnels`),
[terminals](terminal-sdk.md), [display](visual-sdk.md) and
[accessibility](scoped-accessibility.md). Administrative, host and model routes use
separate interfaces. The SDK does not establish provider eligibility.

An [iOS simulator lease](mobile-control.md#ios-simulator-leases) uses the same install
methods with `format: "ios-app-tar"` and refuses recording. Its catalogue entry
(`CatalogueImage.isolation`), lease (`Lease.isolation`) and member carry `"shared-host"`: the
lease is not isolated from the Mac host that runs it. The clients reject a reply that names
any other isolation class, so an unknown class is never read as a stronger one.

```ts
const client = new ConsumerClient({ baseUrl: "https://compute.example", applicationKey, caFile });
const request = { id: persistedUuid, templateId, templateRevision, arch: "amd64" as const };
const { created, lease } = await client.acquireLease(request);
```

## Identity and mutations

The caller owns every mutation UUID and persists the complete request before dispatch.
The SDK generates no identifiers and never retries, polls, rotates or renews. The
[agent surfaces](agent-surfaces.md) (`canaveral mcp`, `canaveral lease hold`) are the layer
that waits, renews and releases for a caller, on top of these clients. Request
bodies are serialized deterministically, so an explicit replay with the same object sends
identical bytes (`created` is false for a 200 replay). For renewal, replay with the original
`expectedRevision`. Unknown request fields, malformed UUIDs and bodies over 1 MiB are
rejected locally before any network use.

## Errors

All errors extend `ConsumerError` (`code`, `outcome`, `requestId`, `retryable`).

- `ConsumerConfigurationError`: invalid options or request, raised before dispatch.
- `ConsumerServiceError`: the controller's structured error, or its legacy error-only 503.
  Exposes `status` and `retryAfterSeconds`; controller text is truncated and any echo of the
  credential is redacted.
- `ConsumerProtocolError`: redirect (`redirect_refused`), non-JSON (`content_type_invalid`),
  malformed or unrecognised JSON or status (`response_invalid`), oversize (`response_too_large`).
- `ConsumerTransportError`: `timeout`, `connection_failed`, `tls_verification_failed`.

For a mutation, `outcome === "unknown"` after any timeout, connection loss, incomplete,
oversize, non-JSON or unrecognised reply, redirect, or 5xx/408 reply: the controller may
have applied it. Inspect the lease, or deliberately replay the identical request. Only a 4xx
structured service reply or a certificate failure (raised during the handshake, before
request bytes) leaves `outcome` unset. Reads never set it. `retryable` on SDK-raised
errors is always false.

## Transport

HTTPS verifies chain and hostname with TLS 1.2 or later. `caFile` or `ca` (PEM) replaces the
default trust store for that client, as in [verified TLS clients](tls-clients.md); it is
validated at construction and refused with an HTTP origin. Verification cannot be disabled.
Plain HTTP requires `allowLoopbackHttp: true` and an IP-literal loopback host (127.0.0.0/8
or ::1); there is no remote plaintext fallback. Credentials must be opaque URL-safe tokens
and are never placed in URLs; base URLs with userinfo, query or fragment are refused. Redirects
are never followed and their bodies are not read. Each request opens a fresh connection and
has a total timeout (default 30 s, maximum 300 s) and a response limit (default 4 MiB, maximum
16 MiB), checked against `Content-Length` and while streaming. Environment proxies are ignored.
Success replies are checked for the fields the SDK relies on; extra fields are preserved.

## Verification and limits

`coordination/test/consumer-client.test.ts` runs against loopback fixture servers: every
operation and scoped bearer, byte-identical replay, local rejection, service/protocol errors,
dropped, truncated and stalled replies with exactly one request, redirects, and TLS with a
generated CA (default trust, unrelated CA and hostname mismatch refused). The TLS test needs
`openssl` on `PATH`. `coordination/test/linux-lease-controller.test.ts` also drives the SDK against real loopback
[TypeScript Linux lease controller](linux-lease-controller.md) processes. These are fixtures
against the documented contract, not
separate-network TLS or native acceptance. Catalogue availability and lease readiness do not
establish native execution: ordinary runners remain gated for consumer lease execution.

Successful acquisition replies must identify the caller-owned lease UUID. Renewal
and release replies must match both the requested lease and mutation UUID; mismatches
leave the mutation outcome unknown. TLS errors after certificate verification also
leave mutation outcomes unknown.

## Linux command operations

The experimental [Linux operation contract](linux-command-operations.md) adds two
methods only to `LeaseClient`:

```ts
const { created, operation } = await lease.createOperation({
  id: persistedUuid, member: "primary", action: "shell", arguments: { argv: ["printf", "hello"] },
});
const receipt = await lease.operation(persistedUuid);
```

Persist UUID and intent before submission. `created` distinguishes 201 from exact
200 replay. Neither method retries, polls, renews or releases. Submission uses the
existing mutation error contract: unrecognized or lost replies leave outcome
unknown. Explicitly inspect or replay the same UUID and intent. Responses are
checked for operation and lease identity, member, state, UTC update time and result
evidence. Application clients have no operation methods; only the current scoped
key may submit or inspect, including old receipts after lease termination. Treat
command arguments and returned output as private. These methods have controller
and fake-peer fixture coverage, without native execution acceptance.

The [waiting request contract](requests.md) is opt-in. Request methods use only the application key, preserve caller UUIDs, and never poll or retry. `submitRequest` accepts `kind: "model-job"` with a `ModelJobIntent` (`{adapter, model, digest, prompt, maxTokens}`) for [queued model calls](requests.md#queued-model-calls); request views of that kind return a `ModelJobRequestIntent` (`{adapter, model, digest, promptDigest, maxTokens}`), never the prompt. Types and methods are also exposed through `sdk.ts`.

Request views carry `position`, the request's place in the controller's attempt order while it waits, and lease views carry `name`, the caller's label. Both are optional in the SDK types because an older controller omits them. `inspectRequest(id, { waitSeconds })` asks the controller to hold one read for 1 to 15 seconds until the request's state, position or reason changes; it is a single bounded request, and it is refused when the wait does not leave five seconds inside the client's `timeoutMs`. The controller refuses a held read beyond its limits with 429 `request_wait_limit`, which the SDK reports as a retryable `ConsumerServiceError` with `retryAfterSeconds`; a controller that predates held reads answers 400. See [position and waiting](requests.md#position-and-waiting).

`listEvents`, `followEvents` and `usage` read the application's own
[event history](events.md) and [usage](usage.md) with the application key.
`listEvents` returns one page and its `cursor`; a filtered page can be short or
empty with `more: true`, in which case read again from `cursor`. `followEvents` is
an async iterator over one server-sent event stream and never reconnects. It
returns `{reason, cursor}` for an ordinary end (`stream_lifetime`,
`controller_closing` or `aborted`), throws a service error when the credential is
no longer accepted (`unauthenticated`, `forbidden`) or the controller reports
`unavailable`, and throws a transport error when the connection stops without an
end message. If retention removed history after `after`, it calls `onTruncated`
and continues, or throws `events_truncated` when no handler was given. `onCursor`
reports the position of a quiet stream. Resume with `after` set to the returned
cursor or the last `sequence` received. Stop iterating or abort its `signal` to
close it. `usage` returns the JSON report; request CSV from the
route directly. A lease key cannot call these methods. Fixture coverage only.

Linux lease acquisition and renewal require integer `ttlSeconds >= 30`, bounded
by the application's maximum. The controller returns 400
`linux_ttl_below_minimum` below this minimum. Acquisition also refuses a
configured default or maximum below 30 seconds without clamping. This is a Linux
consumer contract change; other lease kinds and generic application limits keep
their existing bounds. The SDK preserves this structured service error.

## Lease port tunnels

`LeaseClient.tunnels` (also exported as `@canaveral/coordination/tunnel-sdk`) opens
[port tunnels](mobile-control.md#lease-port-tunnels) between a leased Android emulator and
the machine the SDK runs on. It uses only the lease's current key.

```ts
// The app on the device reaches Metro on this machine at localhost:8081.
const tunnel = await lease.tunnels.open({
  id: persistedUuid, member: "primary", direction: "reverse", devicePort: 8081,
  target: { host: "127.0.0.1", port: 8081 },
});
// This machine reaches port 9229 on the device through a loopback listener.
const inspect = await lease.tunnels.open({ id: otherUuid, member: "primary", direction: "forward", devicePort: 9229 });
console.log(inspect.local); // { host: "127.0.0.1", port: <ephemeral> }
const end = await tunnel.closed; // { reason, code?, state? }; never rejects
```

- `open(request, { timeoutMs?, signal? })` creates (or replays) the tunnel, attaches and
  resolves once the runner has installed the device mapping. A reverse request must name
  `target: { host?, port }` (an IP literal or host name; default host `127.0.0.1`). A
  forward request may name `listen: { host?, port? }`; it defaults to `127.0.0.1` and an
  ephemeral port, and another address is the caller's explicit choice to expose the device
  port there. The target and listener stay on the caller's machine and are never sent.
- The returned `LeaseTunnel` has `local`, `stats`, `closed` and `close()`. It stays open
  until it is closed, the process exits, or the lease ends or its key is rotated.
- `create`, `connect`, `inspect`, `list` and `close` are the separate steps.
- Nothing is retried. If the create reply is lost, `open` rejects with
  `outcome: "unknown"`; inspect the UUID or deliberately call `open` again with the same
  UUID and request, which attaches the one saved tunnel. A tunnel is attached once: a UUID
  whose tunnel already attached or ended is refused locally with `tunnel_ended`, and a new
  tunnel needs a new UUID.
- Controller refusals keep their `code` (`tunnels_not_permitted`, `capability_unsupported`,
  `member_not_ready`, `tunnel_port_busy`, `tunnel_limit`, `lease_ended`). A mapping the
  runner could not create rejects with `tunnel_mapping_failed`, and a local listener that
  cannot bind with `tunnel_listen_failed`.

The command-line equivalent is `canaveral tunnel`
([example](mobile-control.md#sdk-cli-and-metro)). Fixtures with a stand-in adb cover this
client; nothing has run against a real emulator.

## Linux workspace transfers (ST-535)

`LeaseClient` exposes `createTransfer`, `transfer`, `createTransferStep` and
`transferStep` for current-key-only workspace-v2 access. `uploadWorkspaceFile`
and `downloadWorkspaceFile` are exported by the consumer-client entry point.
Supply the transfer UUID, a durable `TransferJournal.save` callback, and a bounded
wait callback (optionally an AbortSignal). The helper saves intent and each exact
step before dispatch, hashes chunks incrementally, and requires final committed
or verified evidence. Downloads await the caller's durable chunk sink before
advancing and evicting the previous read. Publication of a local downloaded file
remains the caller's responsibility after verification.

No mutation is automatically retried. A transport failure or unknown receipt
stops the helper; inspect the persisted UUID/step with the current lease key.
Do not rerun a helper on a partially completed download or assign a new UUID to
repeat an uncertain upload. Recovery uses the low-level stored step and receipt;
a 410 chunk_evicted means those bytes must already be in the durable sink.
Unknown transfers hold their file lane until lease termination. Commands have a
separate lane and workspace commands accept `arguments.timeoutMs` (1..1800000,
default 30000). Legacy images retain the old command shape and timeout.
