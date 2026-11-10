# Controller enrollment and runner credentials

This TypeScript source and fixture foundation extends the existing identity HTTP server and its owned SQLite worker. It does not launch a service, connect a runner, register capacity or admit workloads. The caller must explicitly configure `IdentityClient` with a stable UUID `controllerId` alongside the existing state path and administrator token. Without it, runner commands fail closed. The UUID is pinned in that database; reopening it with another controller UUID fails startup. Preserve the database and controller identity together.

Only the operator credential or an authenticated administrator account session can approve enrollment and manage credentials. Consumer credentials cannot issue, inspect, revoke or consume approvals. There is no global enrollment credential, automatic discovery or adoption. The existing account and application routes are unchanged.

## Routes

All mutations use POST with a JSON object, a single Content-Length and `Authorization: Bearer <credential>`. Secrets belong in the authorization header or the documented JSON credential field, never URLs. Responses use the existing no-store and error envelope behavior. The existing HTTP limit is 1 MiB, 64 in-flight requests and a 20-second deadline; identifiers, exact fields, counters and secret syntax are also validated in the worker. Each UUID is normalized using the existing identity parser. No secret is logged or stored in cleartext by this component. Deployment must supply verified TLS before remote use.

A **binding** is the exact object `{controllerId, runnerId, generation, incarnationId}`. Both identities and the incarnation are UUIDs. Generation is an integer from 1 through the JavaScript safe integer maximum. These four fields are immutable for each stored binding.

| Route | Proof | Body or result |
| --- | --- | --- |
| `POST /v1/runner-enrollments` | Administrator | `{id, ...binding, ttlSeconds}`; TTL is an integer from 1 to 1800 seconds. Returns the approved fields, `expiresAt` in Unix seconds and a newly generated `enrollmentToken` once. |
| `GET /v1/runner-enrollments/{id}` | Administrator | Returns approved binding, expiry and `pending`, `expired`, `consumed` or `revoked` state; no hashes or secrets. |
| `POST /v1/runner-enrollments/{id}/revoke` | Administrator | `{}`; idempotently revokes this approval, including its consume replay permission. |
| `POST /v1/runner-enrollments/consume` | Enrollment token | `{id, ...binding, credential}`; runner generates and durably saves its credential before sending. Returns binding and `credentialRevision: 1`, never the credential. |
| `POST /v1/runners/authenticate` | Runner credential | Binding; returns binding and current `credentialRevision`. This endpoint proves identity only; it grants no workload or host-management operation. |
| `POST /v1/runners/credential` | Administrator | `{...binding, credentialRevision, credential}`; caller securely generates and saves a fresh replacement credential. Revision must advance by exactly one. Returns binding and revision. |
| `POST /v1/runners/revoke` | Administrator | Binding; idempotently revokes that binding. Returns binding and `revoked: true`. |

Secrets follow the existing 43–128 URL-safe ASCII character syntax. Generate at least 32 random bytes, encoded as base64url. Enrollment tokens are generated with 32 random bytes. Runner secrets cannot equal any recorded enrollment token, even after its expiry or revocation, or reuse any previously enrolled or rotated runner credential in this database. A hash history preserves this check across revocation and generations. Stored hashes use SHA-256 with separate enrollment and runner domains. Administrator secrets remain governed by the existing account/session implementation. Runner credentials cannot authorize administrative routes or enrollment consumption.

## Transactions and uncertain replies

Approval, consumption, rotation and revocation each use the existing synchronous `BEGIN IMMEDIATE` transaction inside the owned worker. Each approval can create only its approved binding. A pending token fails at `now >= expiresAt`. Two different credentials racing to consume it cannot both succeed. Competing approvals are checked again during consumption, so an earlier approval cannot override an active or newer binding.

An exact consume retry is a receipt lookup after the first durable consumption, including after token expiry. It requires the same approval token, binding and runner credential, an unrevoked approval and the still-active original credential at revision 1. A different secret or binding fails; rotation, binding revocation or a newer generation also prevents replay. This exception cannot create another binding. Identically cloned state can obtain the same receipt; it cannot be distinguished from a legitimate retry by this protocol.

After a lost issue reply, inspect the supplied approval ID and revoke it before issuing a replacement with a fresh ID. Reissuing the same ID returns conflict and never another token. After a lost consume reply, retry the saved exact request or authenticate with the saved runner credential. After a lost rotation reply, retry the exact revision and replacement credential: a matching current revision is an idempotent receipt; a different secret or stale revision conflicts. The old credential stops authenticating immediately on commit. Administrator-assisted delivery and durable runner-side application of rotations remain integration work. Rotation cannot reactivate a revoked binding.

Replacement enrollment requires explicit new administrator approval, revocation of the prior binding, a strictly higher generation and an incarnation UUID never used for that runner. Every consume rechecks these requirements. An old generation cannot authenticate, rotate or revoke the current binding. Revoking a binding does not revoke separately issued pending approvals for that runner.
An operator responding to compromise must inspect and revoke those approvals too
before approving a replacement.

This is identity fencing only: revoking a disconnected or unknown runner does not prove execution stopped, erase storage or free workload reservations. Workload stop fencing and conservative reconciliation remain required before capacity reuse.

## Compatibility and remaining gates

Enrollment adds `runner_controller_identity`, `runner_enrollments`, `runner_bindings` and `runner_credential_history`. These routes do not migrate legacy host, setup, application or workload records. A runner UUID already in the legacy `hosts` table is rejected rather than adopted. The controller requires no Python runtime. Legacy host enrollment and bound runner enrollment are separate credential protocols; neither silently converts the other.

Fixtures cover role and pair rejection, expiry boundaries, transaction races through independent workers, exact lost-response retries, rotation/revocation, restart persistence, generation regression, immutable incarnation history and retained legacy rows. These establish source behavior on disposable databases and loopback HTTP only. They do not establish native runner integration, secure credential delivery, TLS/proxy deployment, cloned-state detection, workload fencing or release acceptance. Database retention/backup policy for approval receipts and historical bindings is also future work; do not prune them without preserving replay and generation fencing.

The [Rust runner client](../crates/runner-client/README.md) provides private identity storage and authenticated outbound transport for these bindings. Provider and bounded session ownership must still enforce the same exact binding. A clone carrying the same credential, generation and incarnation is cryptographically indistinguishable here; detecting concurrent claims needs transport/session fencing and operator reconciliation. No inventory, scheduling or networking is included in this foundation; the separate [model-job controller slice](model-controller.md) re-verifies these bindings for model claims and reports.

Do not run legacy and current enrollment implementations against the same writable
database. An older endpoint may not check bound runner identities; sharing writable
state could admit a colliding UUID. Cutover requires schema compatibility checks and
explicit fencing of the previous credential authority. Preserve historical bindings
and receipt identities; replacing the executable does not establish migration safety.
