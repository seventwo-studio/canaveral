# macOS guest accessibility foundation

The native `CanaveralGuest` helper now implements authenticated
`GET /v1/accessibility` and `POST /v1/accessibility/action`. Its Swift client exposes
`DesktopClient.accessibility()` and `performAccessibility(...)`. This extends the
existing guest helper; it does not enable macOS consumer leases, install a helper
or establish end-to-end macOS support.

## Native capture and shared payload

`MacAccessibilityBackend` refuses native inspection and input outside a virtual
guest. It checks Accessibility permission without prompting. Capture walks native
application accessibility elements and emits the existing
`canaveral-accessibility-v1` JSON shape: snapshot UUID, Unix capture time, source
`macos-accessibility`, `screen-points`, ordered flat nodes, parent/depth links,
native roles, names, identifiers, states, bounds and properties. Root parents and
missing bounds encode as explicit JSON nulls.

Properties include bounded scalar native values, available attribute/action names,
application identity and available process launch metadata. AX element references
stay inside the guest. Structural native values are represented by the tree,
not serialized as native pointers. Secure-field names/values and arbitrary
properties are redacted; protection also applies to descendants.

The scanner bounds captures to 2,000 nodes, depth 30, a three-second collection
budget, bounded node payloads and the shared 6 MiB envelope. Native AX calls use a
short messaging timeout. Truncation and unavailable-node counts remain explicit;
custom-rendered controls and inaccessible applications may be absent. Bounds use
native screen points and can describe controls outside the primary captured
display. No new screenshot-to-point scaling guarantee is implied.

## Inspect, then act

Actions name an inspected snapshot, node and an action advertised by that node.
`click` maps to native `AXPress`; other advertised native action names retain
their native meaning. Disabled targets, unknown actions and missing/zero-area
bounds are refused.

The guest retains native element handles privately for at most 15 seconds, using
the suspend-aware native clock from before capture. Before dispatch it captures
again and verifies the same native element, semantic attributes, geometry and
entire ancestor chain. Replacement, movement, changed application/context,
expiry and a backward clock observation refuse input. An attempted native effect
retires that snapshot even when its outcome is uncertain.

Read-only inspection does not take input control or invalidate an issued desktop
frame. Accessibility and existing pointer/keyboard input share one guest input
gate. Input/control changes invalidate inspected targets, and an inspection
finishing across such a change is discarded. These helper semantics do not
replace the controller/runner's scoped display ownership.

## Receipts and interruption

Both native action paths bind request UUIDs to canonical request fingerprints,
including the action namespace. A changed payload or a UUID reused across the two
paths conflicts. Identical completed replay returns its receipt without posting
another effect. Uncertain and legacy receipts without a binding cannot authorize
replay. Journals contain request identity/status/fingerprint, not inspected labels
or native tree contents.

The guest synchronizes the pending input journal and containing directory before
dispatch, then synchronizes completion. A failed write prevents dispatch. A
takeover/return transition also has a synchronized pending marker; interruption
keeps input blocked across helper restart until an explicit control transition
is confirmed. These filesystem checks have disposable fixture coverage; they do
not establish every filesystem's power-loss behavior or native lease fencing.

## Verification and remaining integration

Swift fake-backend/device tests exercise payload shape, redaction, node/depth/byte
budgets, stale/native replacement, ancestor/process changes, sleep-age/clock
checks, advertised actions, shared ownership, late inspection, write failure,
receipt binding, uncertain replay and control-transition recovery. The native
guest executable compiles. A Swift-generated fixture passes the TypeScript
schema, semantic validator and `LeaseClient.accessibility()` chunk/digest path.
These checks invoke no native UI or guest permissions and boot no VM.

The helper also has [chunked file transactions](macos-guest-files.md) and an
internal host transfer adapter with isolated coverage, plus
[independent terminal sessions](macos-guest-shells.md). The internal
[common access adapter](macos-guest-access.md) now connects these protocols to
provider/runner interfaces through an injected assignment binding. Common-worker
fixtures cover native-shaped inspection and file transfers, independent
terminals and owned display input. The production provider still needs to supply
the authenticated guest transport and bootstrap.
The [held-input stream](macos-display-input.md) is connected to the helper
bridge and common RFB adapter with isolated coverage; native acceptance remains open.
Its `guestAccess` image admission remains Linux-only,
and ordinary lease execution stays gated. Real guest bootstrap, permissions,
automatic inspection refresh, display/coordinate behavior, files, concurrent
PTYs, expiry/cleanup/isolation and macOS image capture/clone acceptance remain
open. The existing standalone helper is not a public consumer-session fallback.

Native API references checked 2026-11-03:

- [AX messaging timeout and element/action APIs](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout)
- [Secure text-field subrole](https://developer.apple.com/documentation/applicationservices/kaxsecuretextfieldsubrole)
