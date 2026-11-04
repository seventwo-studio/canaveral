# TypeScript consumer HTTP SDK

`coordination/src/consumer-client.ts` (export `@canaveral/coordination/consumer-client`)
is a small Node 24 client for the application/lease subset of the
[consumer HTTP contract](consumer-api.md). It uses only the Node standard library.

| Class | Credential | Operations |
| --- | --- | --- |
| `ConsumerClient` | Application key | `catalogue`, `listLeases`, `acquireLease`, `inspectLease`, `renewLease`, `releaseLease`, `rotateLeaseCredential` |
| `LeaseClient` | One lease's current key | `inspect`, `renew`, `release` for its bound lease |

`LeaseClient` has no catalogue, listing, acquisition or credential-rotation method, and each
client sends only its own bearer. `rotateLeaseCredential` is the explicit owner-only exchange:
it is not idempotent, is never retried, revokes the previous lease key, and its result must not
be logged. After an unknown outcome, call it again deliberately. Sessions, durable operations,
WebSocket and binary workers, and administrative, host or model endpoints are not implemented.

```ts
const client = new ConsumerClient({ baseUrl: "https://compute.example", applicationKey, caFile });
const request = { id: persistedUuid, templateId, templateRevision, arch: "amd64" };
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
