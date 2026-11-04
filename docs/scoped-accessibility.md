# Scoped native accessibility

`LeaseClient.accessibility(request_id, member='primary')` retrieves a normalized
native snapshot through a read-only lease session. It requires a ready member and
the configured `hierarchy` capability. It does not claim display input, send UI
actions, use operator credentials or require the image decoder. Current adapters
cover Linux AT-SPI, Android UI Automator and iOS accessibility, with fixture
evidence rather than live platform acceptance.

```python
lease = LeaseClient.from_credential_file(url, lease_id, private_lease_key_path)
tree = lease.accessibility(inspection_session_id, 'primary')
```

The result includes `snapshotId`, `capturedAt`, `source`, `coordinateSpace`, `nodes`,
`truncated` and `coverage`, plus provider fields such as Linux `unavailableNodes`.
Nodes preserve parent/depth, role, name, identifier, states, actions, bounds and
the complete returned `properties` dictionary. Linux states may be a list;
simulator states are a map. Unknown native fields remain available. Images are
omitted; use the display SDK for PNG captures.

An empty or truncated tree does not prove that all controls are exposed. Existing
adapters bound depth and node count; the normalized envelope allows 2,000 nodes
and depth 30. The transport does not silently drop nodes or properties. It refuses
snapshots exceeding 6 MiB as a whole; this is an inspection response envelope,
not a drive/file-size limit. `max_snapshot_bytes` can choose a smaller client budget.

The [snapshot schema](../canaveral/schemas/accessibility-snapshot.schema.json) uses
[JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema). The SDK also
requires unique node IDs, parents preceding children and consistent depths.
Bounds must be finite with nonnegative dimensions, or null. Malformed snapshots,
incomplete transfers and digest mismatches return errors instead of partial trees.
The schema ships inside the Python package; `inspection_protocol.snapshot_schema()`
loads it without a controller connection or a runtime JSON Schema dependency.

## Wire contract

Create a session with `capability: accessibility` and attach the existing
`canaveral-session-v1` peers. The consumer sends only `{"type":"begin"}`. The worker
returns `{"type":"begin","schema":"canaveral-accessibility-v1","size":1234}`,
exactly that many UTF-8 JSON bytes in binary messages of at most 64 KiB, then
`{"type":"finish","bytes":1234,"sha256":"<digest>"}`. The consumer verifies
completion before parsing or returning the tree. Consumer binary input is forbidden;
extra begin fields cannot request an action.

Exact lease/member/host/generation bindings, key revocation, controller-contact
freshness and expiry apply. Authorization is checked before/after native capture,
during chunks and before finish. Workers hold the assignment gate and persist an
attempt receipt, without snapshot data, labels or provider paths. Disconnect never
replays an attempt; explicitly create a new inspection session to refresh. Older
controllers may reject this capability; there is no administrative fallback.

## Inspect, then act

Take display ownership before inspecting when the tree is intended for input:

```python
with lease.display(display_session_id) as display:
    if display.take_control() == 'owned':
        tree = lease.accessibility(inspection_session_id)
        node = next(n for n in tree['nodes'] if n['identifier'] == 'continue')
        result = display.action(action_id, 'accessibility-action', {
            'snapshotId': tree['snapshotId'],
            'nodeId': node['id'],
            'nativeAction': 'click',
        })
        display.release_control()
```

Choose an action listed by the node; simulators currently expose semantic click.
Snapshot/node IDs belong to their inspected member. Providers revalidate identity
and geometry before input and reject stale or moved targets. Successful transfer
does not make an old target fresh. Persist the action UUID before dispatch; unknown
outcomes require receipt recovery, not replacement action IDs. Read-only inspections
can run while another viewer owns input and do not reset that ownership.

Simulator targets also require an unchanged parent chain, source and coordinate
space. An identical button inside a different window cannot reuse the inspected
target. Invalid parent links, duplicate IDs, nonfinite bounds and zero-area targets
are refused. Ancestor comparisons are conservative: changed parent metadata can
require another inspection even when the button itself looks unchanged.

Simulator and Linux guest caches use the shared suspend-aware elapsed clock for
their 15-second action lifetime, starting before native capture. Wall-clock
`capturedAt` remains display metadata and cannot extend that lifetime after a
clock adjustment. Slow capture consumes the lifetime; exact expiry and elapsed
clock rollback reject input. Cached snapshots are private copies, and caller
mutation cannot rewrite the inspected target. The Linux action worker follows the
complete captured path from desktop to target and compares the same native
role, name, identifier, states, actions, bounds and properties used by capture.
Missing or ambiguous paths/actions are rejected before invocation. Its original
suspend-aware start/expiry interval crosses the subprocess boundary; the worker
checks it again after native resolution, immediately before `doAction`.

Context travels through bounded stdin rather than process arguments. Validation
uses runtime checks that remain active under optimized Python. Exit 42 confirms
refusal before invocation; invocation failure, false completion or lost process
completion remains unknown. These are freshness checks before native dispatch,
not an atomic lock on the guest UI or cancellation of an action already invoked.
The UI can still change between validation and delivery; native cancellation and
suspend acceptance remain separate gates. Generated Linux helpers include the
capture, action, cache and clock dependencies.
Existing guests have not been updated by these source changes.

The [inspection example](../examples/lease_accessibility.py) uses an existing private
lease key and writes a new private JSON file. It does not rotate keys, acquire
machines, renew a lease, claim input or retry. Only counts and snapshot/output
identities are printed. The display example also uses an existing lease key, so
neither revokes another client's sessions. Help paths are verified; neither example
has been run against a live leased machine.

Fixtures cover the real controller/broker/runner/SDK path with synthetic native
trees, large payloads, truncation, read-only behavior, key-file loading, expiry,
malformed requests and a snapshot-to-click/stale-target sequence. Linux/iOS shapes
and JSON Schema have separate checks. Linux worker fixtures use synthetic AT-SPI
objects, including generated helper subprocesses under optimized Python, changed
ancestors and expiry during native resolution. They do not contact a native
accessibility service. Actual native delivery, cross-network TLS,
Windows/macOS/TV/Watch adapters and phone/watch pairing remain acceptance gates.
Ordinary live runners still cannot advertise consumer lease execution.

## macOS native helper foundation

The [macOS guest helper](macos-guest-accessibility.md) now emits the shared snapshot
shape and revalidates native actions through its own guest-only bridge. A Swift
fake-device snapshot passes this schema and the Python SDK receive path. The
internal [common access adapter](macos-guest-access.md) now passes native-shaped
snapshots through the runner with schema/digest checks using an injected guest
binding. No production provider constructs that binding yet. Guest transport,
bootstrap and native acceptance remain open; image and lease admission stay gated.
