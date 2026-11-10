# Application identities

The [packaged OpenAPI contract](consumer-api.md) describes implemented consumer
HTTP requests and responses, including credential roles and compatibility limits.

Implemented controller API. Application identities are
separate from the administrator account and runner identities. They authorize
only their pinned image catalogue and owned lease lifecycle endpoints. They do
not authorize host inventory, administrative machines, inference, enrollment,
image imports or other applications' leases.

An administrator creates an application with `POST /v1/consumers`:

```json
{
  "id": "9415f91b-569d-4d93-a09d-8f7f903a8463",
  "name": "Build agent",
  "templates": [{"id": "ubuntu-desktop", "revision": "4", "arch": "arm64"}],
  "limits": {
    "resources": {"cpu": 4, "memoryMiB": 8192, "diskGiB": 96},
    "activeLeases": 2,
    "defaultTTLSeconds": 1800,
    "maxTTLSeconds": 3600,
    "maxLifetimeSeconds": 86400,
    "provisioningTimeoutSeconds": 900
  }
}
```

The image revision must already exist in the controller catalogue. An empty
allowlist is valid and permits no acquisition. Repeated creation under an existing
application UUID returns conflict rather than another secret. Inspect the existing
record after an uncertain response, then rotate its credential if needed.

The creation response returns `credential` once. Only its hash is stored. Keep it
in the consuming application's secret store or a protected file; do not put it in
a URL, browser storage, command arguments or committed configuration. List responses
never contain credentials. No existing administrator account is replaced.
Application credentials currently remain valid until rotated or revoked; automatic
application-key expiry is not implemented. Lease deadlines independently bound
subordinate lease access.

Administrative paths are:

| Method and path | Behavior |
| --- | --- |
| `GET /v1/consumers` | List application policy and revocation state |
| `POST /v1/consumers` | Create a pinned policy and return its credential once |
| `POST /v1/consumers/{id}/credential` | Rotate credential; body `{}`; previous application credential stops working |
| `POST /v1/consumers/{id}/revoke` | Revoke identity; body `{}`; cannot reactivate by rotation |

The application credential authorizes `GET /v1/environments/templates` and the
[implemented lease lifecycle subset](leases.md). Catalogue entries include pinned
capabilities and availability; availability requires an online, healthy host that
explicitly advertises lease execution protocol 1. Ordinary administrative runners
remain unavailable for consumer placement until deadline enforcement and owned
cleanup are implemented. A catalogue capability is a template contract, not proof
that a particular machine is ready or that an unimplemented platform adapter works.

Revocation invalidates application and subordinate lease authorization. Active
leases transition to released with cleanup pending on the controller's next
transaction. Host reservations remain until positive reclamation. Credential
rotation changes only the application credential; rotate a lease credential at
`POST /v1/leases/{id}/credential` to invalidate its previous scoped key.

Current policy is immutable. To change an allowlist or limits, create a new
application and revoke the old identity under an explicit migration plan. An
in-place policy editor and application dashboard are not implemented yet.

## TypeScript lifecycle and access SDK

The [consumer SDK](consumer-sdk.md) loads private application or lease credentials,
discovers the catalogue and manages leases with caller-owned mutation UUIDs.
`coordination/src/sdk.ts` adds scoped sessions, terminals, display, accessibility
and streaming files to the HTTP client in `consumer-client.ts`. No SDK method
silently retries input, renews a lease or substitutes operator credentials.

`ConsumerClient.fromCredentialFile({baseUrl, credentialFile, caFile?})` loads an
application key. `LeaseClient.fromCredentialFile({baseUrl, leaseId, credentialFile,
caFile?})` loads an existing lease key without rotation. The explicit
`scopedLease(leaseId)` exchange rotates the scoped key; losing its response can
revoke the previous key without returning a usable replacement. Inspect with the
application key before deliberately exchanging again. Never log key responses.

`createSession({id, member, capability})`, `session(id)`, `closeSession(id)` and
`connectSession(metadata)` retain exact lease/member/generation bindings. Sessions
use `canaveral-session-v1`, controls bounded to 16 KiB and binary messages bounded
to 64 KiB. Reconnection uses a new session ID and never replays unconfirmed input.
Closing a stream does not release its lease.

[Terminals](terminal-sdk.md) have independent input/output and resizing.
[Display](visual-sdk.md) keeps view-only capture separate from exclusive input and
durable action receipts. [Accessibility](scoped-accessibility.md) returns a complete,
integrity-checked native snapshot without taking input ownership. Streaming uploads
require a durable finish; downloads require count/digest and source verification.
`downloadToFile` adds private staging and explicit replacement policy; see
[recovery](client-recovery.md) for publication uncertainty.

All these methods require a supported controller route and a bound, eligible
provider. Portable SDK fixtures do not enable consumer placement on ordinary native
runners, qualify detached-command cancellation or establish live platform parity.
