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
