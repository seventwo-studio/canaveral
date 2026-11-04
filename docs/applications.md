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

## Python lifecycle SDK

An optional `ca_file` configures verified HTTPS and WebSocket trust consistently.
See [TLS clients](tls-clients.md) for factory/example usage and live acceptance limits.

`canaveral.sdk.ConsumerClient` loads a private application credential file, discovers
the catalogue, acquires/lists/inspects leases and exchanges a lease-scoped client.
`LeaseClient` inspects, renews and releases that one lease. It also creates,
inspects, closes and connects scoped sessions through the controller relay.
Its [terminal client](terminal-sdk.md) wraps each PTY attachment with independent
input/output, resizing and explicit exit/truncation events, without reconnect or
input replay.
Acquisition and mutation
methods require caller-owned stable UUIDs; they never silently retry a side effect.
Errors expose `status`, `code`, `request_id` and `retryable`. Received worker errors
also expose `outcome='unknown'`; see [session failure recovery](client-recovery.md#session-worker-failures).
Reuse the same UUID
and body after an uncertain outcome; a retryable flag is not permission to generate
a new acquisition identity.

The [lifecycle example](../examples/lease_lifecycle.py) acquires, inspects and
releases without printing credentials. It requires a lease-capable runner. SDK
session and transfer methods have separate fixture coverage; the lifecycle
example does not exercise them or satisfy live client-to-environment acceptance.
From the repository root, run `python -m examples.lease_lifecycle --help` for its
arguments; an application using an installed package imports `canaveral.sdk`.

`LeaseClient.create_session(request_id, member, capability)` returns persisted
metadata. `session(session_id)` inspects it and `close_session(session_id)` closes
it idempotently. `connect_session(metadata)` authenticates an outbound WebSocket,
waits for both peers to become ready and returns a context-managed connection.
That connection supports `send_control(dict)`, `send_bytes(bytes)` and
`receive(timeout)`; text controls fit 16 KiB and individual binary messages fit
64 KiB. Chunking a large file does not impose a per-file size limit. Closing a
connection does not renew or release its lease. Reconnection requires a new
session ID and does not replay unacknowledged input.

`upload(request_id, member, path, reader, size, app=None)` streams a known-length
source with an explicit finish and requires durable publication acknowledgement.
`download(request_id, member, path, writer, app=None)` requires source identity,
byte count and digest confirmation; its caller-owned destination may contain
partial bytes on failure. Neither method silently retries or limits total file
size beyond the protocol's integer representation.

`download_to_file(request_id, member, path, destination, app=None, replace=False)`
adds private staging and verified local publication. It preserves the destination
on transfer failure, refuses overwrite by default and reports uncertain publication
separately. See [download recovery](client-recovery.md) for filesystem behavior,
error codes and the example.

`LeaseClient.from_credential_file(url, lease_id, path)` loads an existing private
lease key without rotating credentials. Both client file loaders use the same
ownership/regular-file/permission checks. `accessibility(request_id, member)`
retrieves a complete, integrity-checked [native snapshot](scoped-accessibility.md)
without display ownership or the image extra. It preserves coverage/truncation
and native properties; it does not invoke input.

The controller/runner/SDK tests execute disposable PTYs and files through real
paired sockets. Existing live runners remain unavailable for consumer leases
until execution fencing and cleanup are complete. Display workers now have fixture
coverage through the broker, including owned discrete input and read-only action
receipts. The optional [Python display SDK](visual-sdk.md) adds complete PNG
captures, input ownership, keyboard/pointer dispatch and durable action/receipt
methods over that same scoped connection. Complete guest cancellation and live platform
acceptance remain open.
