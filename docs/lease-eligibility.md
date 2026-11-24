# Runtime and image lease eligibility

Controller and worker contract, 2026-11-03. Fixture coverage establishes scoped
eligibility and withdrawal behavior. Native deadline/cancellation/cleanup
acceptance remains open; ordinary `Agent` configuration still rejects both
`leaseProtocol` and `leaseImages` before creating runner state. There are two exceptions.
Since 2026-11-19 a supervised Android host accepts Android selectors; see
[Android emulator leases](mobile-control.md#android-emulator-leases). Since 2026-11-21 a
supervised macOS host accepts iOS selectors that each declare the `shared-host` isolation
class; see [iOS simulator leases](mobile-control.md#ios-simulator-leases).

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

Each entry has exactly `id`, `revision`, `arch` and `runtime`. An iOS entry, and only an iOS
entry, has a fifth field, `isolation`; see [isolation class](#isolation-class). It must uniquely
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

## Isolation class

Accepted decision, 2026-11-21. An iOS simulator app is an ordinary process of the Mac host's
user, with the host's network and files, so a leased simulator cannot be fenced from its host.
iOS simulator leases are therefore operator opt-in under a declared class, for trusted code
only. The declaration is part of the selector:

```json
{ "id": "ios-phone", "revision": "1", "arch": "arm64", "runtime": "ios", "isolation": "shared-host" }
```

- `shared-host` is the only value, and `runtime: "ios"` is the only runtime that takes it.
- An iOS selector without it is refused by the host at start-up and rejected by the controller
  in the offer. There is no default, no host-wide switch and no environment variable.
- A selector of any other runtime that carries `isolation` is rejected.
- The controller matches the complete selector, so an iOS image is eligible on a host only
  while that host's selector carries the declaration. Withdrawing it has the effects under
  [enforcement and withdrawal](#enforcement-and-withdrawal).
- The declaration does not replace the application's template allowlist. Both must admit a lease.
- The controller shows the class to the consumer as `isolation: "shared-host"` on the catalogue
  entry and on the lease and its member. A template without a declared class has no such field.

Nothing may describe an iOS lease as isolated from its host.

## Lease tunnel declaration

Since 2026-11-21 a host that offers lease execution may additionally declare
`"leaseTunnelProtocol": 1`. It offers [lease port tunnels](mobile-control.md#lease-port-tunnels)
for its Android lease images. The declaration is separate and explicit:

- Absent, it grants nothing. A persisted or re-sent offer without it offers no tunnels,
  and `leaseProtocol: 1` alone never implies them.
- It is refused without `leaseProtocol: 1`, with any value other than 1, and on a runner
  whose Android storage path cannot hold a tunnel socket.
- It is refused when the host also offers an Android template that is not one of its
  lease images, by the runner at startup and by the controller for the offer. A host that
  declares tunnels runs leased and supervised warm Android emulators only: the host's adb
  server is reachable by every local process and by an emulator without lease isolation,
  and through it a reverse tunnel reaches the lease holder's machine
  ([boundary](mobile-control.md#boundary)). Offering both on one host needs a
  runner-private adb server, which is not implemented.
- It also turns on the adb mapping check of lease readiness. A host without the
  declaration behaves as before tunnels and does not detect a reverse mapping that other
  adb tooling created ([readiness](mobile-control.md#readiness)).
- The controller requires it when a tunnel is opened and on every later authority check.
  Withdrawing it ends the affected tunnels (`disconnected`) like a withdrawn image
  selector ends sessions. The runner enforces its own declaration independently.
- It is a runner contract, not evidence of native acceptance. One
  [native trial](../coordination/native-acceptance/mobile-parity.md#android-port-tunnels)
  carried a single request each way; everything else has fixture coverage only.

An application additionally needs `limits.tunnelsPerLease` above zero
([applications](applications.md)).

## Enforcement and withdrawal

The same binding check applies to:

- Consumer catalogue availability and leased placement.
- New session admission and both attachment peers.
- Persisted session refresh, live-session queries and the read-only frame check.
- Runner session authorization before provider access and while streaming.
- [Live view](mobile-control.md#live-screen) admission, every relayed message of a
  lease's live view and the runner's own capture authority. A lease's live view
  additionally requires an Android image; other leased runtimes have none.

An existing assignment must still match the complete pinned public image
definition in the current offer. A matching selector cannot authorize a stale or
changed image contract. Administrative creation and installed-image inventory
remain independent of consumer eligibility.

Withdrawing one selector disconnects only its affected sessions, removes pending
attachments from heartbeat delivery and rejects new sessions or acquisition for
that image. A lease's live views end with `host_unavailable`; their shared capture
keeps its reservation until its cleanup proof, like every other reservation here. The frame check reads current persisted eligibility without waiting
for a session refresh transaction. The local worker also closes affected sessions
when its own declaration changes before the controller receives a heartbeat.

Restoring support cannot resurrect a disconnected stream or replay its attempt;
the consumer needs a new session identity. Acquisition retries still return the
original lease receipt without placing another machine. Withdrawal alone does
not claim a VM stopped, erase storage, end the lease or release reservations.
Those require the existing lifecycle and positive cleanup contracts.

## Warm devices and baselines

Eligibility also bounds the [warm pool](warm-pool-and-baselines.md). A warm device is
kept only for an image the host lists in `leaseImages`, and only on a host whose offer
carries `warmPool` (from the host's `leaseWarmPool`). Withdrawing the selector or the
opt-in gives the host's warm devices up; it never turns one into a lease.

A template may pin a device `baseline` by name, revision and digest. That reference is
part of the immutable definition this page binds, so a baseline-backed image is a
distinct revision that an application must be allowlisted for. A host is eligible for
such an image only while it stores exactly that baseline, made from the template's own
device definition and not stale.

## Evidence and remaining work

The iOS selector gate, the isolation class in consumer views and the host's own refusal are
covered by [ios-leases.test.ts](../coordination/test/control/ios-leases.test.ts). That is
fixture evidence only; no leased simulator has run on real CoreSimulator.

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
