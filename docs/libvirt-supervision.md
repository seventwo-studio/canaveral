# Libvirt lease supervision component

The internal `libvirt_supervision` module implements a one-use deadline supervisor,
domain ownership validation, private execution journals and a dedicated native
libvirt connection. A companion C source implements Linux kernel deadlines.
The libvirt provider now prepares and launches this component for leased
assignments through a dedicated child entry point. The path has isolated fixtures.
Linux kernel behavior, real libvirt/QEMU behavior and native lease acceptance
remain unverified. Ordinary consumer lease admission remains disabled.

## Execution ownership

`LibvirtLeaseBinding` binds a machine, lease, supervisor boot, host boot,
assignment fingerprint and absolute owned disk path. The journal stores a digest
of the path rather than its text. `bind_domain_xml` adds namespaced ownership to
a new definition; it refuses rebinding an existing lease marker. It does not
write a domain or modify a live definition.

Before execution the supervisor validates the UUID, name, exact boot/lease
metadata and one owned writable disk. Additional media must be read-only CD-ROMs
in that storage directory. Filesystem and host-device passthrough are refused.
The native connection also requires an inactive domain with no managed save,
snapshot or checkpoint state. Unknown native query results prevent boot.
Provider and child wiring verify assignment/storage receipts, lease identity and
the original storage-directory/disk device and inode through the ownership
predicate. XML matching alone is not that proof. A changed URI or storage location
fences the previous owned execution rather than querying another namespace.

The state directory must already be private and owned. `SupervisorJournal` holds
an exclusive process-lifetime lock and pins a directory descriptor. Reads refuse
linked, public, nonregular, malformed or oversized records. Publication writes a
private temporary file through that descriptor, synchronizes it, renames it and
synchronizes the directory. Directory replacement cannot redirect a write.

Preparation explicitly creates one `prepared` receipt. Startup requires that
exact unused receipt and persists its attempt before native creation. Missing,
foreign, interrupted and retired history cannot authorize a restart. Failed
pending publication prevents creation; lost create/resume acknowledgements are
never replayed. Receipts contain identifiers, hashes, phases and bounded reasons,
not native error text or guest data. They do not claim positive runtime cleanup.

## Deadline and connection lifetime

The supervisor checks the current host boot, owned assignment, suspend-aware
clock and exact authorization binding before execution. Same-revision updates
cannot extend the deadline. Revision rollback, clock rollback, late renewal,
revocation and expiry fence execution. Authority is sampled again after slow
metadata reads and between paused creation and resume.

The native C adapter opens a new local QEMU connection and requests
`PAUSED | AUTODESTROY` together. Every temporary domain handle is explicitly
freed before connection closure. Libvirt documents connection-bound destruction,
including client crash or disconnect, in
[`virDomainCreateWithFlags`](https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainCreateWithFlags).
Its [connection reference counting](https://libvirt.org/html/libvirt-libvirt-host.html#virConnectClose)
is why releasing the connection handle alone must not leave domain references.
The component never attempts destruction by a saved PID or a new connection's
UUID lookup after losing ownership. Real driver behavior still needs proof.

`linux_lease_deadline.c` is intended only for the dedicated child process holding
that connection. It installs a parent-death signal with a parent-identity recheck,
then an absolute `CLOCK_BOOTTIME` timer delivering `SIGKILL`. The Linux interfaces
document [suspend-aware timers](https://man7.org/linux/man-pages/man2/timer_create.2.html),
[absolute expiration](https://man7.org/linux/man-pages/man2/timer_settime.2.html)
and [parent-death signaling](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html).
Parent-death signaling follows the creating thread, and credential changes can
clear it; production wiring must preserve those constraints. The C shim refuses
reuse in a forked process, does not expose disarming, and prevents renewal after
its previous deadline has elapsed. Revocation attempts to shorten the armed
deadline before journal publication or native close, so either may block without
consuming the previous authorization duration. A failed update retains the prior
timer. This source-level mechanism is not yet accepted Linux behavior.

## Evidence and remaining integration

Twenty-five fixtures exercise ownership, paused-start ordering, renewal/expiry,
clock changes, startup interruption, lost acknowledgements, kernel-arm failure,
journal recovery and native C API argument/handle behavior. The C API fixtures
use fake libvirt functions and real temporary memory allocations. On macOS the
kernel source compiles with warnings treated as errors and its unsupported branch
refuses execution. This is not Linux timer or real libvirt evidence.

The Linux branch of the kernel fixture is prepared to terminate only its own
disposable child at expiry. It has not run in this macOS checkpoint. No real
libvirt connection was opened and no device was started, stopped or inspected.

## Provider and dedicated child

The provider requires an explicit absolute `leaseDeadlineLibrary` path for leased
preparation. The private artifact is bound to its SHA-256 and checked for ownership,
unsafe aliases/permissions, bounded size and changes during hashing. The child
opens it without following a leaf symlink and loads through its pinned descriptor,
so path replacement cannot substitute another inode after verification.

`script/build_linux_lease_deadline.py --output /absolute/private/new/deadline.so`
prepares an uninstalled Linux build. It refuses an existing destination, publishes
without overwriting a race-created file and prints artifact/source hashes. Only
its help path has been run in this macOS checkpoint; the Linux build and installed
artifact delivery remain native gates. This option grants no lease eligibility.

Environment reports now distinguish deadline artifact inspection from native
consumer lease acceptance. `libvirt_readiness.deadline_artifact` reads a bounded,
owned, unlinked-alias-free ELF snapshot without loading code. It checks the
64-bit little-endian shared-library layout, host architecture, table bounds and
the two required exported functions in executable code sections, then binds the
snapshot to SHA-256. This does not verify dynamic dependencies, function ABI or
timer behavior. The `libvirtLeaseArtifact` health capability means only that this
inspection passed. A missing artifact warns; a configured invalid artifact fails
checks without exposing its private path or contents. A separate native-verification
warning keeps expiry, suspend, teardown, restart and fresh-lease isolation open.
Ordinary consumer admission remains disabled regardless of this artifact check.

Eight fixtures use synthetic ELF metadata and malformed/private-file cases. They
explicitly refuse library loading during inspection and cover both host
architectures, mutation, aliases, special files and redacted health reports.
There was no native Linux artifact execution or installation in this checkpoint.

Preparation refuses existing domains, partial disks and unexplained prior state.
It binds newly prepared storage and a single domain definition before requesting
definition through libvirt. A lost definition acknowledgement does not repeat disk
creation or definition: reconciliation must find the exact owned inactive domain
before it can launch its unused supervisor. Per-assignment reconciliation is
exclusive; deadline publication uses a separate lock and remains independent.

The parent persists its launch attempt before spawning
`python -m canaveral.libvirt_supervisor_child`, then records the child's PID and
creation time. A failed spawn or unconfirmed birth is never automatically retried.
The child checks its parent, private launch/preparation history, host boot and
assignment ownership before entering the core. It closes inherited helper and
reconciliation descriptors at spawn. The native connection is confined to this
child, which must not fork after opening it.

The publisher converts the existing guard's remaining duration into the shared
suspend-aware clock, subtracting sampling time and the existing 250 ms safety
margin. It checks the host boot before and after sampling, preserves same-revision
deadlines, latches expiry/revocation and synchronizes bounded private JSON. A slow
ordinary reconciliation cannot prevent independent publication. Stopped assignments
publish a fence without guest preparation or a `virsh shutdown/start` fallback.

Readiness requires both a running owned domain and the specifically recorded
supervisor's process birth, parent, user, executable and arguments. Observation
never signals a recovered PID. Lost ownership and a fenced child record propagate
a sticky fence through the independent updater. An in-progress parent birth
publication is distinguished by its lock. Reaping uses only retained child process
objects. These are isolated wiring checks, not native process attribution proof.

## Stopped observation and auxiliary state

New leased definitions explicitly place NVRAM at `nvram.fd` and emulator TPM
state at `tpm-state` within their owned storage directory. The TPM backend retains
that state until explicit cleanup. The XML validator rejects external firmware
or TPM paths, unimplemented varstore, additional TPM backends and external TPM
encryption secrets. Administrative definitions retain their existing path.
The [domain XML contract](https://libvirt.org/formatdomain.html) documents these
separate writable resources; explicit emulator TPM source placement requires
libvirt 10.10 or later and the documented swtpm prerequisites. Actual installed
compatibility remains a native environment/readiness gate.

`libvirt_stop.confirm_stopped` requires a matching fenced authorization, unchanged
assignment/storage and namespace, and the original supervisor's exit with an
exclusive execution-journal lock. A PID with a different creation time proves
only that the original child is gone; it never authorizes signalling its
replacement. Missing birth publication remains unknown. An unused preparation
without any launch intent can instead be observed and permanently retired while
the lock prevents a delayed child from entering.

The observer validates the exact inactive domain and absence of saved execution,
snapshot and checkpoint state through the native adapter. It rechecks launch,
storage, context and host boot after observation and requires connection closure.
Missing, unreadable, changed or uncertain evidence produces no stop receipt.
Provider stop reports use this observation where available. It reports storage
handles as **unknown** and performs no erasure. The separate remover below must
establish its own storage-handle and teardown evidence.
Reboot recovery requires the separate evidence path below. A missing domain
before initial positive stop remains unproven rather than adopted.

The controller now holds CPU/RAM as well as disk reservations for unreclaimed
leases. A stopped runtime report cannot bypass application quotas or host/shared
admission budgets; only matching cleanup completion releases the reservation.
Physical usage samples and administrative stop behavior remain distinct.

Twenty-two additional fixtures cover publishing, child setup and provider wiring,
including unknown spawn/birth, lost definition acknowledgements, private artifact
checks, namespace changes, concurrent reconciliation and independent fencing.
All drivers, spawns and child native factories are injected fakes. The fixtures
neither open libvirt nor install a fatal kernel timer in the test process.

The storage transaction below now implements owned erasure and interruption
recovery, including host reboot, with isolated coverage. Native QMP/cgroup-v2
resource attribution also has [isolated coverage](libvirt-resource-ownership.md);
actual helper placement and restart accounting remain unverified. Reviewed Linux shim delivery and environment readiness still need
target-platform verification.
Then verify blocked RPCs, parent loss, disconnect, suspend and actual VM/detached
command fencing on approved disposable Linux capacity. Positive runtime exit,
closed handles and owned disk/NVRAM/TPM/saved-state removal must precede quota
release and fresh-lease isolation. The complete acceptance plan
and its runtime authorization boundary remain in force.

## Storage handle guard

The internal `libvirt_storage_handles` component now pins a private storage tree
and attempts a Linux write lease on every regular file. It requires the original
root device/inode, owned directories/files, one link per file and unchanged
descriptor/path metadata. It refuses symlinks, special files, device boundaries,
unsafe permissions and unsupported environments. Descriptor exhaustion or partial
acquisition closes the partial guard and leaves storage untouched.

Linux documents that a [write file lease](https://man7.org/linux/man-pages/man2/F_SETLEASE.2const.html)
requires no other open descriptors for that file. The kernel exposes a requested
break through `F_GETLEASE` before forced downgrade or release. The guard checks
that state; it does not infer exclusivity from an empty process scan. It selects
SIGURG notification only when its disposition is default or ignored, without
changing a process-wide handler. Forked copies cannot validate or explicitly
unlock the parent's lease. Descriptors are closed on execution of another program.

Eighteen isolated fixtures exercise tree races, existing-open acquisition failure,
break detection, changed signal/owner, descriptor exhaustion, partial release,
fork identity and unsupported-platform refusal. File-lease operations are fakes
over real temporary files; no Linux kernel contention test has run. All 74
libvirt-focused fixtures pass in this checkpoint.

The guard is now used by the provider's teardown transaction below. A held guard
gives only a temporary check, not reusable stop or deletion evidence. QEMU-owned
files or filesystems that cannot grant the lease remain
unconfirmed. Actual driver, filesystem, mapping, break-timeout and late native
operation behavior still require approved disposable Linux acceptance. Consumer
lease admission remains disabled; native cleanup acceptance is outstanding.

## Owned storage transaction and recovery

`libvirt_removal.remove_storage` requires a terminal, stopped lease and its exact
cleanup intent. It retains the execution-journal lock throughout teardown, binds
the immutable specification and launch history to the deletion receipt, and
requires the same host boot, fenced authorization, namespace and assignment.
Initial stop observation must succeed before any rename. A private pinned parent
and the original storage/disk inodes bind the same-filesystem quarantine.

The remover acquires file leases on the quarantined tree before native teardown.
The native adapter validates the exact inactive persistent domain and refuses
managed-save, snapshot or checkpoint state. It undefines using KEEP_NVRAM and
KEEP_TPM, leaving owned files for the guarded eraser. An active-domain race would
leave a transient domain and fail the subsequent UUID-absence check. Only a fresh
VIR_ERR_NO_DOMAIN lookup establishes absence; RPC, permission and connection
errors do not. The [undefine contract](https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainUndefineFlags)
documents why undefine alone is not positive stop evidence.

Before changing file contents, the transaction synchronizes an external JSONL
manifest of every owned path and inode and binds its digest into the receipt.
There is no total file-count limit; each metadata record has a bounded path
envelope. All files are truncated and synchronized while their leases remain
held. This is logical erasure, not physical media sanitization. The transaction
persists cleared-content evidence before allowing unlink. Path removal uses the
platform's protected directory remover, verifies pinned files are empty and
unlinked, synchronizes the parent, and rechecks fencing and native absence before
publishing storage completion.

Recovery before unlink requires the complete original inode manifest. Recovery
after unlink began permits only remaining empty manifest-owned entries; missing
storage counts only with the exact durable cleared-content/removing receipt.
Uncertain file synchronization, changed context, new contents, replaced inodes,
unknown handles and conflicting paths retain an incomplete receipt. A changed
kernel boot requires the separate recovery path below, never reuse of old process
or clock evidence.

The generic cleanup pipeline now calls this libvirt remover and erases assignment
credentials only after storage completion. A dedicated cleanup fencer publishes
revocation without entering preparation or reacquiring the shared assignment
gate; it reaps only retained supervisor process handles. Ordinary consumer
admission remains disabled. This wiring and its interruption fixtures establish
source behavior only; actual Linux lease, QEMU, swtpm and filesystem acceptance,
detached-command fencing and fresh-lease isolation remain required.

## Host-reboot recovery

`libvirt_reboot` keeps the original binding's host boot ID and records the observed
kernel boot separately. The production source remains the fixed Linux
`/proc/sys/kernel/random/boot_id` file. The [Linux random interface](https://man7.org/linux/man-pages/man4/random.4.html)
documents this kernel-generated value. A different boot ID establishes that old
processes cannot survive; it does not establish native domain state, closed file
handles or storage erasure.

Before initial teardown, recovery requires a matching terminal cleanup intent,
current fenced local authorization, original owned storage and exclusive execution
ownership. It publishes a zero-deadline fence and retires the execution preparation,
then synchronizes a private reboot receipt bound to assignment, specification,
launch history, cleanup ID and fenced authorization digest. It never converts an
old monotonic deadline into time on the new boot, restarts a supervisor or queries
a historical PID. Same-boot deadline publication remains independent of the
supervisor's execution lock.

Positive reboot stop evidence additionally requires a fresh exact inactive-domain
observation without saved execution state, successful connection closure, unchanged
kernel boot and context, and synchronized execution/reboot stop receipts. An
active domain, missing initial domain, malformed history or uncertain publication
leaves stop unconfirmed. Restoring the original boot ID after reboot history has
been recorded is rejected.

For an existing validated removal intent, a later reboot refreshes native evidence
for that intent's phase: planned quarantine requires the exact inactive domain;
quarantined storage permits typed absence after a lost retirement acknowledgement;
retired/clearing/removing/completed storage requires fresh typed absence. Every
phase retains the original manifest, inode, empty-content and handle requirements.
The deletion receipt advances its observed boot only after fresh stop evidence.
Repeated reboots and interrupted receipt publication can retry this sequence;
no missing path or old PID substitutes for evidence.

Twenty-three new isolated fixtures cover initial reboot fencing, unknown native
state, lost fence/stop publication, changed kernel context, stale history,
preparation retirement, lock contention and recovery during quarantine, content
clearing and partial unlink. Kernel boot IDs, native drivers and file leases are
injected; filesystem/journal transitions use real private temporary files. No
actual host was rebooted. Linux kernel/driver acceptance, real host restart and
fresh-lease isolation remain open, and ordinary consumer admission stays disabled.
