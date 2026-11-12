# TypeScript consumer HTTP SDK

`coordination/src/consumer-client.ts` (export `@canaveral/coordination/consumer-client`)
is a small Node 24 client for the application/lease subset of the
[consumer HTTP contract](consumer-api.md). It uses only the Node standard library.

| Class | Credential | Operations |
| --- | --- | --- |
| `ConsumerClient` | Application key | `submitRequest`, `inspectRequest`, `listRequests`, `cancelRequest`, `catalogue`, `listLeases`, `acquireLease`, `inspectLease`, `renewLease`, `releaseLease`, `rotateLeaseCredential` |
| `LeaseClient` | One lease's current key | `inspect`, `renew`, `release`, `createOperation`, `operation` for its bound lease |

`LeaseClient` has no catalogue, listing, acquisition or credential-rotation method, and each
client sends only its own bearer. `rotateLeaseCredential` is the explicit owner-only exchange:
it is not idempotent, is never retried, revokes the previous lease key, and its result must not
be logged. After an unknown outcome, inspect the lease before deliberately exchanging again.
The companion `coordination/src/sdk.ts` extends these clients with private credential
file loaders, `scopedLease`, session creation/attachment, streaming files,
[terminals](terminal-sdk.md), [display](visual-sdk.md) and
[accessibility](scoped-accessibility.md). Administrative, host and model routes use
separate interfaces. The SDK does not establish provider eligibility.

```ts
const client = new ConsumerClient({ baseUrl: "https://compute.example", applicationKey, caFile });
const request = { id: persistedUuid, templateId, templateRevision, arch: "amd64" as const };
const { created, lease } = await client.acquireLease(request);
```

## Identity and mutations

The caller owns every mutation UUID and persists the complete request before dispatch.
The SDK generates no identifiers and never retries, polls, rotates or renews. Request
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

The [waiting request contract](requests.md) is opt-in. Request methods use only the application key, preserve caller UUIDs, and never poll or retry. Types and methods are also exposed through `sdk.ts`.

Linux lease acquisition and renewal require integer `ttlSeconds >= 30`, bounded
by the application's maximum. The controller returns 400
`linux_ttl_below_minimum` below this minimum. Acquisition also refuses a
configured default or maximum below 30 seconds without clamping. This is a Linux
consumer contract change; other lease kinds and generic application limits keep
their existing bounds. The SDK preserves this structured service error.

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
