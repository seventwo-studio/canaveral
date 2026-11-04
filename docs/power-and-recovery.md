# VM power off and native recovery

Implemented local Apple runtime behavior, 2026-11-02. Normal **Stop** requests a
graceful guest shutdown. **Power off** is a separate, explicit administrative
operation. It cuts power and may discard unflushed guest/application state. It is
not automatically substituted for an unsuccessful graceful shutdown.

`POST /v1/machines/{id}/power-off` accepts only `{"id":"<request UUID>"}` and
returns the durable request state. Repeat the same UUID after an uncertain
response. Another machine or changed operation cannot reuse it. An unresolved
request blocks another power-off intent, restart and capture. Lease-owned machines
use lease cleanup rather than this administrative endpoint. Other runtimes return
`capability_unsupported`; the current dashboard offers this action for Apple VMs.

The controller keeps compute reserved until the host reports stopped with the
matching power-off UUID. A stale stopped observation alone cannot acknowledge the
request. Disks remain reserved after power off. The dashboard asks for explicit
confirmation and preserves the request UUID across interrupted responses.

## Native control

The rebuilt signed runner reports `runnerProtocol: 1`, actual Apple VM state and a
stop reason. This is its native control protocol, distinct from the still-disabled
consumer lease execution protocol. A boot-bound private control file requests
Apple's `VZVirtualMachine.stop()` operation. An old request cannot target another
native launch. Successful stop is recorded before releasing the runtime lock.
Ordinary shutdown sends one accepted guest request instead of repeatedly pressing
the virtual power button.

For old runners without this control protocol, explicit power off verifies the
PID's executable, exact run-directory arguments, owner and creation time against
the saved launch. Only the configured runner or an explicitly configured
`legacyRunners` path is eligible. The termination intent is persisted before the
signal. An uncertain request is never replayed against a PID. Process identity
mismatches and PID reuse do not cause an unrelated process to be signalled.

Legacy completion requires original process exit, the native runtime lock and an
inspection showing every disk handle closed. A remaining helper/disk handle or an
unavailable inspection retains reservations. Recovery can complete a previously
uncertain stop once those positive checks succeed. The private fenced-stop receipt
is bound to that boot; a later launch or native status invalidates it.

Cold capture records `consistency`: `guest-shutdown`, `crash-consistent`, or
`stopped-disk` when no stronger stop reason was reported. Forced/error stops are
crash-consistent. This does not establish application-level consistency or preserve
writes that were never committed. Capture holds the runtime lock and never repairs
or modifies its source disk.

## Verified scope

Two Linux VMs were recovered using the legacy process/disk
fence. Their original workspace VM and Android emulator remained running. Native
power-off and restart were then verified on a task-created VM using the new runner.
A durable-write acknowledgement was tested across immediate native power-off and
restart, including recovery of pinned SSH access. Source/clone preservation and
owned deletion remain separate acceptance gates; this does not establish cleanup
of every provider or release storage merely because a VM stopped.

Apple documents that a [shutdown request](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/requeststop())
does not prove the guest has exited. Its native [stop operation](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:))
is used only for explicit power off here.

## Owned storage deletion

The administrative API now accepts `POST /v1/machines/{id}/delete` with a stable
`{"id":"<request UUID>"}`. This implementation supports Apple Linux/macOS VM
storage only. It requires a connected host and confirmed stopped state, rejects
unresolved power-off/capture operations and cannot delete lease-owned assignments.
There is no dashboard deletion action yet. Retrying the same UUID returns its
durable state; another intent cannot replace it.

The host checks both assignment and storage fingerprints, takes the native
runtime lock and verifies shutdown and closed disk handles. It writes a durable
intent outside the disk tree, atomically moves the owned directory to a private
removal path, then removes it using symlink-safe directory traversal. Restart can
finish an interrupted move/removal. Missing storage without a matching durable
receipt is blocked, rather than assumed reclaimed. It never stops a running VM
or removes another assignment's directory. A deletion tombstone prevents stale
reconciliation from recreating storage or restarting the assignment.

The controller holds disk reservations through queued, blocked and uncertain
outcomes. Only a matching completed receipt releases the disk reservation and
removes the machine from active inventory, allocations and resource categories.
The machine's creation identity and deletion receipt remain as tombstones, so an
old create request cannot recreate it. Assignment metadata, including private
guest-access material, is currently retained; deletion is not yet credential
erasure. Automatic lease cleanup and other runtime adapters remain open.

Fixture tests cover wrong ownership, active locks/open disk handles, symlink
boundaries, interruption recovery, matching acknowledgements, retained capacity,
restart and stale reports. Cross-provider deletion, credential erasure and automatic lease cleanup require further native acceptance.

New lease-bound Apple VM metadata also has an independent native execution guard.
It self-terminates at its continuous-clock deadline and cannot be revived by a
late authorization file. This is distinct from an operator power-off intent and
does not apply to retained administrative machines. Native watcher-process tests
pass, but running-VM expiry and automatic cleanup are still acceptance gates;
see [native lease execution](leases.md#native-apple-execution-deadlines).

Terminal leases now have a separate automatic Apple cleanup worker and controller
completion contract. It erases owned disks and per-assignment credentials, then
waits for a matching acknowledgement before reservations are reclaimed. The
administrative deletion API above continues to retain assignment metadata.
Fixture recovery passes; live consumer cleanup and other provider adapters remain
open. See [owned lease cleanup](leases.md#owned-lease-cleanup).
