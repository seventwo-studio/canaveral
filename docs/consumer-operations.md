# Durable consumer operations

The controller supports `POST /v1/leases/{leaseId}/operations` and
`GET /v1/leases/{leaseId}/operations/{operationId}`. Both require the lease's
current scoped bearer key. Application and host credentials do not authorize
guest operations. This is isolated controller/runner implementation; ordinary
runners remain gated for consumer execution pending native fencing and cleanup
acceptance.

## Submission and recovery

Persist the complete request before dispatch:

```json
{
  "id": "28885879-d08a-44dc-9d23-1a78c1d14942",
  "member": "primary",
  "action": "shell",
  "arguments": {"argv": ["printf", "hello"]}
}
```

A new intent returns 201; the identical UUID, member, action and arguments return
200 with its current receipt. Changed arguments conflict. An ID belonging to
another lease or an administrative operation is hidden. The response contains
`id`, `leaseId`, `member`, `state`, `updatedAt` and, after completion, `result`.
It omits host addresses, host/machine identifiers and credentials. Guest command
output in `result` can contain sensitive application data.

```python
operation = lease.create_operation(operation_id, 'primary', 'shell',
                                   {'argv': ['printf', 'hello']})
receipt = lease.operation(operation_id)
```

`lease` is an existing `LeaseClient`. Neither method retries, polls, rotates a key,
renews or releases automatically. An unconfirmed HTTP response retains the
request UUID through the existing SDK error contract. Inspect that ID, or
explicitly resubmit the identical request. Never infer that an unknown effect
failed or issue a new UUID as an automatic retry.

The [command example](../examples/lease_operation.py) accepts a persisted request
file or an operation UUID to inspect, using an existing private lease-key file.
It prints receipt metadata without guest output or credentials. Its help path
is checked; native consumer execution remains unverified.

## Capability and execution boundaries

The implemented common subset covers screenshot, hierarchy, accessibility and
accessibility actions; tap, swipe, text and keys; directory listing and bounded
push/pull; guest commands and shell open/read/write/resize/close. Existing
argument validation and native adapters remain authoritative. App installation,
launch, permissions and other mobile administrative actions are outside this
consumer subset. iOS shell and headless graphical operations remain unsupported.

Submission requires a ready member, an online enabled host and explicit pinned
image/runtime lease eligibility. Each intent has a 120-second start window,
bounded by lease expiry. Renewal does not extend this command window. The
existing per-host queue holds at most 32 pending discrete operations; this does
not limit shell count or total transferred file size. Use the streaming PTY and
file sessions for interactive or large transfers.

The controller durably marks dispatch before returning an assignment. Loss of
readiness, eligibility, credential generation or authorization cancels pending
delivery. A never-dispatched operation becomes `failed`; an operation dispatched
without a completed receipt becomes `unknown`. Release, expiry and application
revocation use the same distinction. Restoration does not resurrect an intent.
The current scoped key can inspect old receipts after termination or rotation.

The runner checks local eligibility, the exact current assignment, pinned lease,
readiness, contact freshness and deadline before execution. It rechecks after
waiting for the provider's receipt lock. Native input shares the existing
exclusive display-control arbitration. Existing durable started/completed
receipts prevent replay after duplicate delivery or runner restart. The first
terminal controller receipt wins, including an uncertain outcome; a late success
cannot overwrite it.

These rules stop new queued effects and preserve uncertainty. They do not prove
that an in-flight command or detached guest process stopped. Native execution
fencing, owned cleanup and fresh-lease isolation remain separate requirements in
the [lease contract](leases.md). Explicit member targeting does not implement
paired acquisition.

## Verification

Disposable HTTP, SDK and runner fixtures exercise FIFO delivery, identical replay,
restart persistence, first-receipt wins, ownership/role checks, wrong-host reports,
credential rotation, readiness/eligibility withdrawal, release, exact expiry,
renewal without command extension, bounded queue admission and local rechecks
without replay. OpenAPI tests validate real response shapes and reject malformed
requests and unexpected host fields. Headless fixtures verify graphical denial
while guest commands remain available. No live runner or device was used.
