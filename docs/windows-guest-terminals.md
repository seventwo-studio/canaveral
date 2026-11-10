# Windows ConPTY source component

`ConPTY` and `WindowsTerminalWorker` in
`coordination/src/guest/windows/terminal.ts` implement session validation, separate
I/O lanes and supervised terminal protocol calls. Native creation, ConPTY handles,
job containment and process cleanup require an injected `TerminalAPI` or qualified
worker transport. No production Win32 binding or completed Windows shell service
is implied. The native behavior below is required of that bridge; the TypeScript
component selects no guest or credentials and enables no image/lease admission.

The caller supplies a session UUID, absolute Windows executable, argument vector
and working directory inside its guest. There is no host-shell fallback.
Construction opens nothing; an explicit shell-open request is a separate operation, allowing the
owner to retain the object and retry cleanup even when startup fails. Each
object has an independent pseudoconsole, unnamed job and output reader. There
is no total shell-count cap or automatic recreation after failure.

The native implementation uses 64-bit Windows APIs with fixed-width Win32
structures. It configures `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, creates the child
suspended with both the pseudoconsole and job-list startup attributes, verifies
job membership and then resumes its retained thread handle. The job is attached
during creation, rather than adopting a running process afterward. Handles are
not inherited and no breakaway job option is enabled. No saved PID is signaled.
Microsoft documents the [pseudoconsole startup sequence](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
and [job-list startup attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

Output drains independently of input into a 64 KiB ring. Reads return the common
base64 byte stream and absolute cursor with explicit truncation, exit state and
optional exit code. Input is bounded to 16 KiB per call, and confirmed partial
writes advance only the remaining bytes. Interrupted input or resize fences
further input and reports `outcome=unknown`; no command is replayed. These are
buffer bounds, not limits on command duration, total output or session count.

Close fences new input, terminates the owned job if needed and waits for its
active-process count to reach zero. It retains handles while any input/resize
call is still using them; a stuck writer leaves cleanup unconfirmed. It keeps draining output while closing the
pseudoconsole, then confirms reader exit and handle releases. Missing native
evidence or a failed release returns false and retains handles for retry. A
failed/absent reader's output pipe is closed before native console shutdown.
This follows Microsoft's [ClosePseudoConsole drain requirement](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole).

Native creation, pipe writes, resize and console close can block. The separate
`WindowsTerminalWorker` isolates these calls in an owned subprocess. A guest
service must refuse replacement until cleanup is confirmed. Neither component
implements controller lease expiry, guest disk erasure or quota release.

## Private terminal worker

`WindowsTerminalWorker` binds one session UUID to caller-supplied executable,
arguments, directory and assignment-authorization predicate. Its `control`
method uses the existing `GuestChunkShells` validator and common responses.
The authorization predicate must be fast, thread-safe and bound to the current
assignment; the component does not choose that identity or its enrollment policy.
It opens no network listener, chooses no credentials/enrollment and refuses
production construction on a non-Windows operating system. This component runs
inside the assigned guest; a host agent must not use it as a guest-transport
fallback. Test command injection is an
internal fixture seam, not a host command API.

Length-bounded, request-correlated stdio IPC has independent read, input and
lifecycle lanes. One pending input does not block output polling. Extra work in
a busy lane receives a pre-effect busy refusal instead of unbounded buffering;
the child also bounds response/native-operation slots. These bounds are per
terminal protocol buffers, not a total shell-count cap. Each terminal has its
own process and lanes.

One native child owns the console/job and output ring. Separate pipe writer and
response-reader threads in the parent support out-of-order acknowledgements.
Timeout, active/idle authorization loss, invalid correlation or malformed results
permanently close the worker. Nothing recreates a failed process or replays input.
A confirmed native input error can fence further input while preserving output
reads and an explicit close attempt.

Worker exit alone never sets `cleanup_confirmed`. A successful common close
requires the child's positive native cleanup acknowledgement and confirmed
worker/thread exit. A failed constructor can acknowledge a positively unstarted
session because construction opens no native console/job/application. Otherwise
failed/uncertain close remains unknown even after forced worker termination.
Killing the helper is not independently observed native job/descendant fencing.
Repeated close can return a positively recorded cleanup result for the same
session without another native operation. Unknown cleanup is never promoted by
that receipt path.

## Evidence and remaining gates

Required portable cases use native-shaped API doubles and reader threads to
cover independent sessions beyond eight, UTF-8 and partial input, concurrent
output during blocked input, bounded cursors, startup failures, uncertain
input/resize, cleanup retry, Win32 structure layouts and startup-attribute
marshalling. The common `GuestChunkShells` adapter also validates the component's
open/write/read/resize/close responses and cursors. No Windows DLL, real
pseudoconsole, job or shell was invoked.

Private-worker conformance requires disposable child processes with
ConPTY-shaped doubles to cover common lifecycle, independent reads during
blocked input, lane readiness, uncertain input/cleanup, malformed acknowledgements,
session binding, failed construction, startup timeout, active/idle revocation,
and nine independent workers. Equivalent TypeScript/Rust portable coverage must
be established for the installed implementation.
This establishes development-host process/IPC behavior, not Windows kernel,
ConPTY, job-object or pipe semantics.

Native Windows API/ABI and descendant containment, interactive PowerShell/cmd
behavior, Ctrl+C, resize, Unicode/VT output, backpressure, worker-crash cleanup
and shutdown/pipe semantics remain unverified. Native terminal-worker acceptance,
authenticated guest service/assignment binding and the common shell/provider
connection still need implementation. Native lease/expiry/reset/isolation and
the full Windows installation/capture workflow remain open. See the unchanged
execution goal and acceptance path.
