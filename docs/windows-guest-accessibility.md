# Windows native accessibility component

`coordination/src/guest/windows/accessibility.ts` implements `WindowsInspections`
with an injected `WindowsUIAAPI`. It validates capture, retained targets and guarded
Invoke-pattern actions. It does not provide a production COM binding, enrolled
Windows service or provider connection, and enables no image or lease capability.

The native bridge must load UI Automation and create its COM client in a fresh MTA
worker, establish a physical-coordinate DPI context and restore it on exit. It must
refuse other operating systems and incompatible initialized workers. There is no
host or pixel-input fallback. The native behavior below is the bridge contract;
TypeScript fixtures against an injected API do not establish native execution.

Capture uses the UIA control view and the common accessibility snapshot shape:
`windows-uia`, `screen-pixels`, native runtime IDs, AutomationId, localized role,
control type, process/class/framework identifiers, states, bounds and supported
Invoke actions. Nonprotected value controls also expose bounded values and
read-only state. Password labels/help/value patterns and protected descendants
are omitted. No image bytes are embedded in inspection responses.

Traversal bounds node count, depth, elapsed time between native calls and the
serialized snapshot envelope. Unavailable providers mark partial coverage while
usable siblings remain visible. Empty/unavailable roots are errors. Native COM
can block inside a provider; the separate `WindowsWorker` supervisor bounds the
API wait rather than assuming the traversal deadline can interrupt a native call.

`WindowsInspections` retains one current snapshot and its original COM handles
in the same worker thread. Refresh invalidates the preceding snapshot. An action
consumes its context, checks the 15-second lifetime, rewalks every ancestor,
compares current properties and native identities with the retained handles,
and invokes the retained target only. A supplied runtime ID or serialized parent
path alone cannot authorize input. Disabled, protected, offscreen, empty-bounds,
changed and expired targets are refused before invocation. Exceptions after
invocation begins produce `outcome=unknown`, never automatic replay. Cross-thread
use of the retained context is refused.

Microsoft documents that [UIA runtime IDs can be reused over time](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getruntimeid).
The worker therefore retains native references rather than reconstructing an
action from an ID. The implementation follows Microsoft's [dedicated MTA client
guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
and [physical/logical coordinate distinction](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling).

## Owned worker lifetime

`WindowsProcessWorker` in `coordination/src/guest/windows/ipc.ts` provides lazy
private-process transport with explicit command, authorization and `timeoutMs`
options. A production guest service must bind it to the qualified native worker. A private, length-prefixed JSON pipe keeps capture and action
on the same MTA thread and retains the original inspection handles. Request
UUIDs correlate every acknowledgement; no command is retried or replayed. IPC
requests are limited to 16 KiB and responses to the snapshot envelope plus
bounded protocol metadata. These are message bounds, not file or shell limits.

A dedicated I/O thread owns pipe reads/writes. Another request receives a typed
busy refusal instead of queuing behind a blocked native provider. Timeouts,
authorization loss, malformed framing or mismatched acknowledgements close the
worker permanently. Revocation is also observed while idle. A new worker must
capture a new snapshot; it cannot adopt old native handles. Authorization must
be a fast, thread-safe predicate supplied by the eventual assignment owner.

Shutdown signals only the retained child process object and checks its exit,
with bounded terminate/kill waits. A process creation that completes after close
is stopped before request dispatch. `close()` returns true only after the child
has stopped and the I/O thread has exited; an unconfirmed start/stop remains
false. The component never signals a saved PID, desktop application or system
UIA provider. Interrupting this helper cannot undo an already-posted Invoke
action or prove that guest execution ended. A dispatched invocation without a
valid acknowledgement remains `outcome=unknown`, including a worker timeout.
If close remains false, the caller must retain that worker and confirm its stop
before creating a replacement for the same assignment.

The internal command injection exists for disposable test workers; it is not a
host command API or an enrollment/configuration option. Production construction
requires Windows. This module opens no listener and selects no guest identity,
credentials, display owner or admission policy.

## Evidence and remaining integration

Required portable cases use UIA-shaped doubles and cover the packaged JSON
schema, native property projection, protected content, partial/depth/byte
coverage, parent/identity changes, recycled IDs with replaced handles, expiry,
worker-thread affinity, single-use actions and uncertain invocation. They load
no Windows DLL, initialize no COM apartment and interact with no desktop.

Supervisor conformance requires disposable subprocesses on the
development host to cover retained inspection/action context, busy refusal,
non-reading and stalled fixture children, timeout/revocation, late startup, framing/correlation,
cleanup and unknown invocation results. They do not prove Windows pipe/process
handle behavior or native COM cancellation.
The retained fixture cases define portable coverage requirements; passing them
against the TypeScript/Rust implementation must be established separately.

Native acceptance requires an approved disposable Windows guest, interactive
user session, installed helper dependencies and actual provider behavior across
frameworks, elevation/secure-desktop boundaries and DPI/monitor changes. Windows
native supervisor acceptance, authenticated guest service/assignment binding,
common display ownership, durable action receipts, automatically refreshed
consumer inspection sessions, supervised [ConPTY terminal integration](windows-guest-terminals.md),
files/display and native lease cleanup
still need integration or implementation. Native UIA calls and ABI assumptions
remain unverified on Windows. See the full acceptance path.
