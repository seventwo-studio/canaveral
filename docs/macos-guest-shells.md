# macOS guest terminal sessions

The native `CanaveralGuest` helper implements independent PTYs behind the same
authenticated bridge as files and accessibility. The internal Python
`GuestChunkShells` adapter translates common shell controls into this protocol.
The internal [common access adapter](macos-guest-access.md) connects these
protocols to provider/runner interfaces with isolated coverage. Production
provider connection/bootstrap and native acceptance remain unfinished. This
source addition enables no macOS image admission or consumer lease execution.

## Independent terminals and bounded I/O

Production creates the service and native processes only after the existing
virtual-guest guard. The guard runs again on each service request and before
native PTY creation. Each shell receives its own new POSIX process session,
controlling terminal, initial dimensions and guest working directory. The
production command is the guest's interactive `/bin/zsh`; its environment includes
the guest HOME, standard executable paths, terminal type, locale and temporary
directory rather than inherited service secrets.

`POST /v1/shell/open` takes `session`, `cols` and `rows`. The other endpoints are
`read` (`session`, `offset`), `write` (`session`, `text`), `resize` (`session`,
`cols`, `rows`) and `close` (`session`). Fields are exact, queries are refused,
and requests fit a 16 KiB control body. Authentication and browser Origin checks
happen before service dispatch. The Python adapter supplies default 80 × 24
initial dimensions for the existing common `shell-open` operation.

There is no product shell-count cap. Each PTY drains independently through a
read-event source into a 64 KiB ring. Slow consumers receive explicit truncation
and the new byte offset; lost bytes cannot be recovered. Output is binary data
encoded as base64 only on this internal HTTP hop. Shared consumer sessions retain
their existing binary WebSocket messages. Native readiness events drive draining;
there is no fixed per-character sleep. Native process/descriptor availability
still constrains admission.

Input is UTF-8 text, including newline and control bytes, subject to the common
text and wire envelope. NUL is refused. A successful write reports bytes accepted
by the PTY; it does not confirm command execution. Partial/failed input is never
automatically replayed. Terminal resizing accepts integer dimensions from 1
through 500. The adapter validates response identity, byte cursors, output bounds,
truncation, exit metadata and positive resize/close acknowledgements.

## Durable identity and interruption

The helper synchronizes a private `starting` receipt before launching a process,
then records `open`. An identical open on a live terminal returns its identity
without launching another shell. Changed original dimensions conflict. Closed,
interrupted or restarted sessions never reopen under the old UUID. No PID is
recovered from disk or signalled after restart. A restarted helper cannot prove
cleanup of its old process sessions; that requires the separate execution fence.

Exit observation uses `waitid` without reaping. This keeps the direct-child
identity pinned until owned group cleanup is checked. A read reports exit only
when the PTY has ended and direct-child exit is observed. A delayed or failed
observation remains unknown.

## Close and fencing limits

Close blocks further input before attempting cleanup. Through the held PTY, the
kernel signals its current foreground job; the implementation never signals a
separately observed foreground PGID that could have been reused. It also signals
the owned leader's process group while the leader remains an unreaped direct
child. Group observation is restricted to that pinned group. Unavailable,
changing or oversized observation data cannot establish closure.

On Darwin, a zombie-only process group can return `EPERM` from group signalling.
The helper accepts that case only after observing the exited direct child and
verifying that the pinned group contains no live members. An actual permission
failure with live or unverifiable members remains unconfirmed. This distinction
follows the [Apple XNU group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c).
Foreground signalling uses the [PTY kernel ioctl](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty_dev.c)
through a small typed C bridge for the integer vararg Swift cannot call directly.

The helper acknowledges close only after the direct child is reaped, PTY
descriptor closure is confirmed and the final `closed` receipt is synchronized.
A failed journal write does not prevent stopping a still-owned process; failed
final receipt publication retains an unconfirmed close for reconciliation.
Bounded waiting keeps uncertain terminals tracked. Batch revocation fences all
input and signals all tracked shells before waiting against one shared deadline.
Explicit helper quit awaits that cleanup; an unconfirmed result keeps the helper
alive and reports the problem.

This is terminal cleanup, not a complete guest execution fence. Background jobs
in other groups, new sessions, detached commands, helper crashes, forced app exit
and VM failure require the separate native deadline/VM stop and owned cleanup
contract. Closing a PTY does not establish lease disk/credential erasure, fresh
lease isolation or quota release. Ordinary lease admission remains gated.

## Verification scope

Swift fixtures cover authentication, durable-before-launch identity, duplicate
and conflicting opens, restart refusal, malformed input, uncertain writes,
receipt substitution, batch stop failure/retry and journal failure. Disposable
Darwin child processes verify a controlling terminal, resize, Ctrl-C, binary
buffer bounds/truncation, waitable exit, nine simultaneous independent native
PTYs and close of a foreground job that ignores hangup. These processes use
separate temporary HOME/working directories. They are not live VM tests.

Python fixtures exercise common control translation, response and UTF-8 byte
validation, bounded output, truncation, cleanup acknowledgements, nine session
identities and no retry after lost mutation responses. A deterministic transcript
from the actual Swift manager with a fake process backend checks all five
controls against the Python adapter. It establishes protocol compatibility,
not a network boundary or real guest delivery.

Native installation/bootstrap, approved guest connectivity, common display and
accessibility integration, concurrent-load latency measurements, lease deadlines,
interruption/expiry cleanup and all-platform acceptance remain open under the
full execution plan.
