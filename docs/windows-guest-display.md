# Windows display primitives and held input

`Win32Desktop` in `coordination/src/guest/windows/desktop.ts` validates physical-pixel
capture and bounded input batches through an injected `DesktopAPI`. It supplies
no production GDI/SendInput binding; the native behavior below is required of an
assigned-guest bridge.
It chooses no endpoint, credentials, enrollment or image/lease admission. The
owner supplies current authorization and optional explicit release authority.
A production native binding requires 64-bit Windows; injected APIs are also the
portable fixture boundary. This component must run in the assigned guest, never on its host as a
guest-transport fallback.

## Capture and native resource ownership

Operations stay on one retained worker thread, use a nonblocking request lane
and temporarily establish per-monitor-v2 DPI awareness. The backend checks the
interactive WinSta0 window station, Default worker/input desktops and the input
desktop's active flag. Secure/alternate/inactive desktops are refused; it does
not switch desktops, elevate or prompt for permissions. These observations do
not replace native session/isolation acceptance.

Capture uses the virtual desktop's physical bounds, including negative origins.
A top-down 32-bit DIB receives BitBlt with SRCCOPY/CAPTUREBLT, followed by GdiFlush.
Geometry must remain unchanged. BGRX pixels become an RGB PNG using bounded row
compression; frames share the existing 4096-pixel dimension and sub-4-MiB
TightPNG envelope. No image-library dependency is added. Cursor composition,
large-frame tiling, HDR, protected content and native multi-monitor/RDP behavior
remain unverified or unfinished. A successful capture is not evidence that an
inaccessible application's content is empty.

Acquired desktop/DC/bitmap resources are retained until their release succeeds.
Pending GDI batches are flushed before objects are released. The original bitmap
selection is restored before deletion, then DCs and the owned desktop handle are
released and thread DPI restored. Borrowed station/thread-desktop handles are
never closed. Failed cleanup fences new operations and preserves remaining
resources for explicit close on the same worker thread. Cross-thread cleanup
cannot manufacture a positive result. Authorization is checked after encoding,
so expired authorization does not receive a late frame.

Microsoft documents [DIB ownership and synchronization](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createdibsection),
[BitBlt](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt),
[GDI batch flushing](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-gdiflush)
and [thread DPI contexts](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext).

## Input and uncertainty

Fixed-width INPUT/MOUSEINPUT/KEYBDINPUT structures preserve the intended Windows
64-bit layouts. Keyboard primitives accept virtual keys, scan codes/extended
flags and UTF-16 Unicode units. Pointer positions normalize captured pixel
coordinates onto the entire virtual desktop; button edges and wheel data remain
separate events. Invalid/contradictory flags and malformed batches are rejected
before dispatch. The batch limit bounds protocol memory, not machine/shell/file
capacity.

Before ordinary input, current physical geometry must match the supplied frame
geometry. SendInput must report the complete batch length. Partial results,
exceptions, changed geometry, revocation or cleanup failure after dispatch report
an unknown outcome and permanently fence further ordinary input. No input is
automatically replayed. Read-only capture remains available after an input-only
fault while authorization/resources still permit it.

Explicit release authority can send only key-up/button-up events, without moving
the pointer, after ordinary authorization ends. Release does not revive a fenced
input context or establish complete held-state recovery. Observed authorization
loss remains sticky even if the predicate later becomes true. `close()` confirms
graphics/desktop/DPI resource release only; it does not release held input or
prove lease fencing or guest cleanup.

Microsoft documents [SendInput counts and UIPI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput),
[keyboard units/flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
and [virtual-desktop mouse coordinates](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput).
An insertion acknowledgement does not prove that the intended application
processed an event; elevated/secure targets are not bypassed.

## Held input and recovery

`windows_held_input.WindowsHeldInput` now translates held keysyms and RFB button
masks into the native batches above. It requires caller-supplied, side-effect-free
key resolution, authorization and durable-save callbacks. Its versioned record
contains retained native key descriptors, held buttons, transient Unicode
release candidates and a blocked marker. The save callback must durably persist
the exact record in the assigned owner/generation scope before returning `true`.
No Windows journal implementation, storage path or owner/enrollment policy is
selected by this state machine.

Key-down resolves once; repeats and later release/reset retain the original
descriptor across layout changes. Left/right modifiers remain independent;
unowned key-up posts nothing. Distinct keysyms cannot share the same canonical
native descriptor. Pointer movement preserves dragging, button swaps produce
separate release/press edges, and wheel pulses do not become held buttons.
Conflicting directions and invalid Unicode/native descriptors are refused before
effects. State metadata and batch bounds do not impose machine/file/shell caps.

Before each native batch, the callback must confirm a blocked union of the old
and possible next held state, including keys/buttons that may fail to release.
Only confirmed native posting, final persistence and current authorization
establish the next unblocked state. Failure keeps the union blocked and never
replays input. A recovered record always starts blocked, including a neutral
record. Missing evidence for a previously ready context must be refused by the
owning service rather than passed here as a fresh context.

Text requires neutral held state and keeps the common 16,000-byte UTF-8 control
envelope. Bounded batches preserve surrogate pairs and record candidate Unicode
releases before posting. Failure stops later batches; reset only releases those
candidates and cannot undo or confirm text already received by an application.
Reset posts ordinary key releases before modifier releases and then button-ups,
without cursor movement. Both reset posting and final neutral persistence must
be confirmed. Explicit cleanup authority may reset after ordinary revocation;
it cannot revive ordinary access. A native backend fenced by unknown input still
needs retirement even after held-state reset succeeds.

## Native keyboard resolution

`windows_keys.WindowsKeys` now supplies the held controller's side-effect-free
resolution callback. Native construction requires 64-bit Windows 10 version
1607 or newer so ToUnicodeEx's no-state-change flag is supported. Resolution
stays on one retained worker thread, checks assignment authorization and never
sets foreground focus, selects a layout or posts input.

Named navigation/function/modifier keys map through Windows virtual-key constants
and the foreground thread's active input locale. MapVirtualKeyEx returns the
scan and E0 extended distinction; unsupported/E1/missing mappings are refused
without a virtual-key fallback. Left/right modifier keys remain distinct, and
keypad Enter retains its extended flag. Lock toggles, Pause, numeric-keypad
state and unrecognized legacy keysyms remain unsupported rather than described
as implemented.

Ordinary Unicode keysyms produce literal UTF-16 descriptors, including retained
surrogate pairs, without consulting the keyboard layout. Ctrl/Alt/Windows
shortcuts resolve BMP characters through VkKeyScanEx and validate the producing
state through ToUnicodeEx with flag 4. Extra shortcut modifiers are preserved;
no missing modifier press is synthesized. Letter case may differ for a raw
shortcut while punctuation must still match its required Shift state. The
held-state modifier observation retains a right-Alt bit for AltGr mapping;
left Alt alone cannot satisfy a layout's Ctrl+Alt requirement. Dead-key,
multi-character and unresolvable modified input is refused before posting.

Foreground window/thread/layout observations must match after resolution. An
immutable validation closure is then checked after pending-state persistence,
immediately before a new key-down. Changed observations block the held context
without posting. Repeat, key-up and recovery use the stored descriptor and do
not resolve again. Observations are not owned handles or authorization tokens;
they do not freeze focus/layout or establish native application-event delivery.

Microsoft documents [character/required-modifier mapping](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-vkkeyscanexw),
[extended scan mapping](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-mapvirtualkeyexw),
[foreground-thread input locales](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getkeyboardlayout)
and [non-mutating Unicode translation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-tounicodeex).
Real layouts, AltGr/IME/dead-key/lock-state behavior and focus races still need
native acceptance; these APIs do not bypass UIPI or the display ownership gate.

## Evidence and required integration

Twenty keyboard cases use layout/library doubles for Unicode, modified shortcuts,
modifier sides, AltGr, keypad Enter, scan/mapping refusals, changing foreground
observations, pre-post validation, retained repeats/releases, revocation and
Windows-version gating. The resolver/held-state/native-primitive chain is also
covered with injected libraries. No keyboard layout or native input on this
machine or a Windows guest was queried or posted.

Twenty-four held-state cases use persistence/backend doubles, including two
paths through Win32Desktop with injected library doubles. They cover retained
key identity, modifiers, dragging/wheels, uncertain button swaps, save/post/reset
failures, Unicode batching, recovery, authorization races, busy refusal and
malformed state/resolution. No journal was written to a Windows filesystem and
no native key/button was posted.

Twenty tests use native-shaped library/structure doubles. They cover top-down
PNG/color conversion, negative geometry, pointer edges, keyboard/Unicode fields,
partial input, pre/post-dispatch revocation, release-only cleanup, topology and
desktop changes, retained cleanup failures, construction failure, worker-thread
confinement and protocol bounds. No screen, host input, native desktop, Windows
DLL or Windows GDI/USER resource was accessed by these tests.

The common RFB ownership adapter still needs a Windows service binding with
fresh frame IDs/expiry, input sequences, exclusive owner/handoff, native keyboard
layout acceptance and an actual assignment-bound durable Windows journal for
the held-state controller. Native reset/restart acceptance, supervised worker interruption,
durable semantic action receipts and UIA exclusion/coordination remain required.
Native clicks, dragging, shortcuts/layouts, Unicode, capture latency and session
behavior must be accepted in an approved guest. The existing common adapter is
not connected by this primitive, and no Windows consumer capability is enabled.
See the unchanged execution goal and acceptance path.
