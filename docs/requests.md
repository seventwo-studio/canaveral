# Durable waiting requests

Applications opt into `/v1/requests` when capacity may be full. Direct lease
acquisition is unchanged: it still returns 503 `capacity_unavailable`. LeaseState
has no waiting value. Model jobs retain their separate queue and do not participate
in this fairness policy.

| Method and route | Result |
| --- | --- |
| POST /v1/requests | 201 for new intent; 200 for exact normalized replay |
| GET /v1/requests | Own requests, at most 100, UUID `after` cursor and `nextCursor` |
| GET /v1/requests/{id} | Current own request |
| POST /v1/requests/{id}/cancel | Empty object; cancel waiting or release admitted lease |

Every route requires the application credential. Another application's UUID is
404, including submission; scoped lease, host and administrator keys cannot act
as application keys. Persist the UUID and complete envelope before sending it.

The envelope has `id`, `kind` (`lease` for the generic host path or `linux-lease`
for approved runner domains), `intent` (the existing acquisition body without
`id`), integer `priority` (default 0), optional UTC RFC3339 `deadline` and optional
opaque `source` object, limited to 4096 UTF-8 bytes. Source can carry repository,
pull request, commit and run context; it drives no behavior. Unknown fields or
kinds return 400; `request_kind_unsupported` names the supported paths. The request
UUID becomes the lease UUID. Do not use it for another direct acquisition.

## States and clocks

`waiting` transitions to `admitted`, `cancelled`, `expired` or `rejected`.
Only admission reserves resources. Waiting stores no credential and no placement.
An admitted response has `target` equal to the lease UUID and `admittedAt`; inspect
that lease for provisioning, runtime and cleanup. Cancellation after admission
keeps the request admitted and releases its lease through the existing lifecycle.
It never certifies cleanup or frees held reservations by itself. Repeated
cancellation is safe. SQLite serializes cancellation and admission: cancellation
wins if it acquires the write boundary while the request is still waiting.

`deadline` bounds waiting only; expiry wins at `now >= deadline`. Lease TTL,
maximum lifetime and provisioning clocks start at admission. Expiry of waiting
intent is evaluated inside the admission transaction. A past deadline produces
an expired request without execution. Revocation cancels the application's
waiting requests and retains the existing lease revocation/cleanup behavior.

## Admission and fairness

The control worker is the single queue owner. It already instantiates both generic
and Linux lease implementations. Admission calls those implementations with a live
application lookup, under one BEGIN IMMEDIATE pass; each attempt uses a savepoint.
Grants, allowlists, application limits, health, drains and physical capacity are
therefore checked by the existing acquisition code at admission. A failed attempt
cannot leave a partial reservation or roll back another request's admission.

Applications take round-robin turns, persisted across restart. Within an
application, higher priority precedes FIFO sequence. A request that does not fit,
or an application at quota, is skipped for the current scan cycle; subsequent
requests remain eligible. There is no aging. Passes attempt at most 256 requests;
a persisted scan continuation prevents a long unfit prefix from starving the
rest of the queue across passes. Submission, control mutations (including host
heartbeat and limits), identity-worker mutation completion (including approvals,
release and reclamation), startup and a one-second timer trigger passes. SQLite
serializes all ledger writers even when direct acquisitions use another worker.

Administrators set `limits.maxWaitingRequests` (default 100, maximum 1000) and
`limits.maxRequestPriority` (default 0, range 0..1000000) when creating an
application. Existing policies use these defaults. Priority may be negative down
to -1000000; values above the application maximum are rejected with 400
`request_priority_invalid`. Policy remains immutable; changing it follows the
existing application migration contract.

## Replay and failures

Replay compares kind, normalized intent, priority, deadline and source. Object key
order, capability order, default priority and default TTL normalize consistently.
The same UUID and normalized envelope returns its current state; a change returns
409 `request_conflict`. Tombstones are retained. Inspect or replay identical intent
after a lost response; never invent another UUID to resolve an uncertain outcome.

A waiting cap returns actionable 429 `request_waiting_limit`, with retryability
and Retry-After. Cancel outstanding intent or wait before submitting more. This
cap is distinct from admission quota: acquisition 429 and 503 leave intent waiting
for a later pass. Other acquisition ServiceErrors reject only that request; the
stable code appears in `reason`. Missing or removed grants are permanent rejection.
An unexpected storage failure rolls back the pass; retry by inspection or exact
replay after recovery. Ordinary structured errors retain the consumer error and
uncertain-operation contracts. The SDK never automatically retries or polls.

## Upgrade and backup boundary

This feature creates only new tables (`requests`, `request_scheduler`,
`request_scan`) and partial indexes for waiting order and deadline. It neither
alters nor converts existing tables. Old databases and old application policy JSON
remain usable. Held reservations, application/runner identities, assignment and
mutation receipts remain authoritative across upgrade and restart. Queue order,
scan position and request tombstones are durable in the same SQLite database.

Back up the complete database at a quiescent controller boundary before cutover,
including existing ledgers and the new queue tables. Never restore a queue without
its lease/reservation ledgers, run an older writable controller concurrently, or
infer reclamation from a request state. Fixture upgrade/reopen checks are not an
operator backup/restore exercise or native execution acceptance.

## Opt-in example

```ts
const { request } = await client.submitRequest({
  id: persistedUuid, kind: "linux-lease",
  intent: { templateId: "linux-dev", templateRevision: "1", arch: "amd64", ttlSeconds: 600 },
  deadline: "2026-12-01T12:00:00Z", source: { repository: "team/project", run: "42" },
});
// Later, explicitly inspect; the SDK does not poll.
const current = await client.inspectRequest(request.id);
```
