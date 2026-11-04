# macOS held display input component

The shared RFB viewer sends button masks, pointer movement and individual key
press/release events. The existing macOS helper's `/v1/desktop/action` implements
discrete clicks, text, scrolls and named shortcuts. It cannot yet carry the full
held-input stream faithfully.

`GuestDisplayInput` now implements the native held-input state machine needed by
that stream. `MacInputBackend` implements native key resolution and event posting.
The guest app now connects both through authenticated stream routes. The
controller and bridge have fake-device coverage; native posting is compiled only.
The internal common RFB adapter now has isolated viewer/SDK coverage; production
provider binding and platform admission remain unfinished. This helper
protocol is not completed common display support.

## Input and recovery

The controller maintains independent held keysyms, resolved native keys, modifier
sides, mouse buttons and normalized pointer position. Pointer masks produce
movement, button edges and vertical/horizontal wheel events. Movement while a
button remains held stays a drag; releasing it does not become a synthesized
click. Left, right, middle and the auxiliary mask button remain distinct.

Key-down resolves a native key once. Repeated presses and later key-up/reset
retain that native identity even if the guest keyboard layout changes. Left and
right modifiers remain independent; releasing one side preserves the other.
Unowned key-up sends no event. State and input have protocol bounds; these do not
add machine, file-size or shell-count limits.

Before dispatch, a caller-supplied persistence callback must save an uncertain
union of the old and possible next held state. This includes keys/buttons that
might fail to release. Failed persistence prevents posting. Failed native posting
or final persistence keeps input fenced until explicit reset. Reset posts only
releases, with ordinary keys before modifiers; button reset uses the guest's
current cursor rather than moving it to an old coordinate. Recovered state never
replays presses and requires explicit reset before accepting more input.

The native device supplies a private synchronized held-input journal. Its directory
and record are opened without following symlinks; recovery rejects malformed,
nonregular, oversized and unknown-version state. Missing held-state evidence for
a previously ready owner cannot establish release after restart. Reset of held
input does not prove cancellation of an unconfirmed command, text effect, lease
deadline or all guest execution.

## Authenticated helper stream

The existing bridge checks its credential and browser Origin before dispatch.
It now exposes:

| Route | Request | Response |
| --- | --- | --- |
| `GET /v1/display/frame` | Empty body, no query | `frame` (existing PNG frame), `displayID`, logical `bounds` |
| `POST /v1/display/take` | `streamId` UUID | Matching `streamId`, current `sequence`, `state: owned` |
| `POST /v1/display/input` | `streamId`, next `sequence`, `frameId`, `event` | Matching identity/sequence and `posted: true` |
| `POST /v1/display/release` | `streamId` | `released: true` only after reset and synchronized closure |

Event fields are exact: `key` has `keysym` and boolean `down`; `pointer` has captured
pixel `x`, `y` and byte `buttons`; `text` has `text`. Requests fit a 16 KiB body.
Integers must be exact nonnegative protocol values; pointer positions stay inside
the captured pixel dimensions. Input frames expire 15 seconds from before capture
using the suspend-aware clock. Clock rollback, late captures across input/control
change, stale identities and changed native display geometry refuse dispatch.
The cache retains only frame metadata, not a history of PNG payloads.

One stream owns held input. A repeated live take returns its existing identity;
a different owner is refused. Human-owned or uncertain native control cannot be
overridden by stream take. Legacy and accessibility input cannot bypass an active
or blocked stream owner; read-only inspection/viewing remains available. Control
handoff serializes with posting input, persists a pending marker before waiting,
resets owned held state and confirms the new control state only after its writes
are synchronized. Concurrent control transitions are refused. A wait that cannot
finish within its bound stays uncertain.

Sequences start at one. Exact replay of the most recently acknowledged sequence
returns that live acknowledgement without posting again; changed or older replay
and skipped sequences are refused. These are bounded volatile raw-input receipts,
not durable per-input action UUID receipts. Helper restart never resumes input or
replays a press. Durable per-stream attempt/owner records keep the old stream
blocked until explicit matching release or native control recovery. Failed input
blocks further events/take. A successful release for an old closed identity never
resets a newer owner.

`busy`, `reset-uncertain` and stale-frame refusals have distinct internal codes
before input dispatch. An ownership acknowledgement reserves the input channel;
it does not grant macOS permissions or confirm application command completion.
The existing native permission checks still apply to each actual effect. The
private protocol supplies no endpoint/credential enrollment policy, lease
admission or consumer authorization fallback.

## Native backend

Native keyboard resolution and posting check the existing virtual-guest guard
and Accessibility permission without prompting. Ordinary Unicode uses Unicode
keyboard events. Modified printable shortcuts resolve through the guest's active
Unicode keyboard layout; the implementation does not assume ANSI labels for
those shortcuts. Named navigation, modifier, function and keypad keys use SDK
virtual-key constants. Unresolvable shortcuts are refused before posting.

The backend constructs all native events before posting the first one. It carries
modifier state, key repeats, pointer dragging, button numbers and wheel axes;
text is split into bounded UTF-16 event strings without splitting a scalar.
Geometry must name the captured main display and its bounds, and those must still
match immediately before posting. The bridge still needs to supply the actual
capture-bound geometry and freshness checks.

Lock-key toggle state, input-method/dead-key behavior, all keyboard layouts,
coordinate scaling and event ordering require further implementation or native
validation. Caps Lock is currently refused rather than mapped to incorrect
momentary-modifier semantics. A compiled Core Graphics call is not proof that a
particular guest application receives the intended event.

## Verification and remaining integration

Sixteen fake-backend tests cover continuous dragging, independent buttons/wheel
axes, modifier sides/chords, repeat and layout changes, Unicode, invalid native
resolution, pending/final journal failures, partial release/button swaps,
failed reset and restart. They post no host input and query no keyboard layout,
permissions or native UI. The native backend is compiled only.

The stream route, capture binding, private journals, control handoff and legacy
exclusion now have isolated coverage. `GuestStreamScreen` translates helper frames
and full key/button edges to the common private RFB socket. Native ownership is
confirmed before the viewer receives `owned`. Ordered reset must be positively
acknowledged; an uncertain claim/input/reset blocks new ownership. Only typed
busy/stale read-only captures can retry within a bounded deadline. Mutations
never automatically retry or refresh to unseen pixels.

Semantic actions use the same stream owner and wait behind preceding raw events.
They execute inside durable provider operation receipts. Native semantic input
requires neutral held state, checks frame or inspected-target freshness and
persists its own pending/completed receipt. Uncertain results remain blocked.
The [common access adapter](macos-guest-access.md) connects this socket to the
runner through an injected assignment binding, without selecting a destination
or credentials. A committed Swift fake-device transcript is replayed through the
Python adapter; common broker/SDK fixtures exercise two viewers, PNG decoding,
held modifiers, dragging, semantic receipts and interruption. These fixtures do
not admit a macOS image or run a guest.

Frames currently require positive dimensions through 4096 pixels and a PNG below
the TightPNG 4 MiB payload boundary. Large-frame tiling or another negotiated
encoding remains unfinished; this is a display envelope limit, not a drive cap.
Production transport/bootstrap and real click/drag/keyboard delivery, frame/input latency,
accessibility refresh and the complete lease lifecycle remain open under the
full acceptance plan.

Twenty-seven stream fixtures exercise ownership,
held-event continuity, replay/conflicts, pixel bounds, expiry/rollback, late
capture, native failure, restart, retired identities, reset/journal failures,
missing recovery state, authentication, human control and concurrent handoff.
Five real-filesystem journal fixtures separately check private permissions,
synchronized state/recovery, symlink/nonregular refusal, malformed records and
publication failure. Fake devices handle every input; no native UI or keyboard
layout API is executed by those fixtures. The guest executable compiles with the
new app wiring but has not been installed, launched or accepted in a real guest.

Shutdown permanently fences the bridge before waiting for already-posting input
and control transitions, then resets the owned stream. New queued requests are
refused, including legacy input; cleanup retry never reopens the bridge. A marker
that was already uncertain is retained across shutdown. The app retains an
exclusive state-directory lock for its entire process lifetime, acquired after
the virtual-guest guard and before keychain/services. A second helper cannot
share those journals or reset the first helper's keys on its own failed startup.
Three temporary-file lock fixtures cover exclusivity, independent state roots
and symlink/nonregular refusal. Native app termination/locking behavior still
needs real-guest acceptance.
