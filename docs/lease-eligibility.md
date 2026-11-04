# Runtime and image lease eligibility

Controller and worker contract, 2026-11-03. Fixture coverage establishes scoped
eligibility and withdrawal behavior. Native deadline/cancellation/cleanup
acceptance remains open; ordinary `Agent` configuration still rejects both
`leaseProtocol` and `leaseImages` before creating runner state.

An installed image is not automatically eligible for consumer execution. A host
offering `leaseProtocol: 1` must explicitly identify each eligible image revision,
architecture and execution runtime in `leaseImages`:

```json
{
  "leaseProtocol": 1,
  "leaseImages": [
    {
      "id": "linux-desktop",
      "revision": "1",
      "arch": "arm64",
      "runtime": "apple"
    }
  ]
}
```

This fragment describes the controller protocol, not an enabled live runner
configuration. Declarations are authenticated runner contracts, not certificates
that native behavior has passed acceptance. Do not remove the ordinary runner
gate to make this example acquire a machine.

## Binding and defaults

Each entry has exactly `id`, `revision`, `arch` and `runtime`. It must uniquely
match a currently offered installed image and that image's actual configured
runtime. Physical hosts resolve runtimes through the existing platform/runtime
configuration; legacy single-runtime and KubeVirt offers bind to their adapter.
A selected legacy image cannot claim another runtime through its image metadata.

Normalization bounds declarations to the existing 100-image offer limit and
sorts them. Unknown images, wrong runtime/revision/architecture, duplicates,
missing identity fields and extra fields are rejected. Paths, credentials and
private backend settings do not belong in the selector.

Missing or empty `leaseImages` grants no eligibility. A persisted legacy
host-wide `leaseProtocol: 1` declaration with no selectors also grants none.
Selectors without the protocol are inactive. This tightens the experimental
controller contract; ordinary administrative hosts never advertised consumer
execution. No installed image, imported image, new revision or architecture
inherits eligibility from another entry.

## Enforcement and withdrawal

The same binding check applies to:

- Consumer catalogue availability and leased placement.
- New session admission and both attachment peers.
- Persisted session refresh, live-session queries and the read-only frame check.
- Runner session authorization before provider access and while streaming.

An existing assignment must still match the complete pinned public image
definition in the current offer. A matching selector cannot authorize a stale or
changed image contract. Administrative creation and installed-image inventory
remain independent of consumer eligibility.

Withdrawing one selector disconnects only its affected sessions, removes pending
attachments from heartbeat delivery and rejects new sessions or acquisition for
that image. The frame check reads current persisted eligibility without waiting
for a session refresh transaction. The local worker also closes affected sessions
when its own declaration changes before the controller receives a heartbeat.

Restoring support cannot resurrect a disconnected stream or replay its attempt;
the consumer needs a new session identity. Acquisition retries still return the
original lease receipt without placing another machine. Withdrawal alone does
not claim a VM stopped, erase storage, end the lease or release reservations.
Those require the existing lifecycle and positive cleanup contracts.

## Evidence and remaining work

Eight dedicated controller fixtures cover mixed Apple/Android offers, legacy
default denial, immutable revision/architecture/runtime binding, newly installed
images, rejected heartbeat rollback, image-specific session withdrawal, immediate
frame denial, terminal session recovery and ordinary-runner rejection. The existing
catalogue/lifecycle/session/SDK and owned-cleanup fixtures now declare eligible
images explicitly using a fixture-only helper.

A broker/runner/SDK fixture stops fixture heartbeats, withdraws eligibility
locally, and confirms that its disposable PTY is closed with a completed cleanup
receipt while the controller still has the earlier declaration. It uses a
confined shell fixture, not a guest, emulator or VM. Native command cancellation,
owned cleanup across runtimes and fresh native consumer acceptance remain the
next implementation/validation gates in the acceptance path.
