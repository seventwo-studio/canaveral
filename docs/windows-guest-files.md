# Windows pinned files and verified downloads

`WindowsRoot` in `coordination/src/guest/windows/files.ts` provides handle-based
ownership validation for Windows listing, reads and transfer transactions through
an injected `WindowsFileAPI`. The caller supplies an approved guest drive and root
components. The TypeScript component is not a file server or enrolled provider,
and supplies no production Win32 binding. The native behavior below is required
of the guest bridge; it selects no credentials, public path namespace or image
admission. Missing native operations must fail closed.

`WindowsRoot` construction opens nothing. `start()` pins the selected drive and
each configured directory component, retaining their handles. `pin(parts)`
accepts relative components and opens each through `NtCreateFile.RootDirectory`,
never by concatenating an absolute destination path. Separator, traversal,
alternate-stream, NUL, ambiguous trailing-dot/space and invalid Unicode inputs
are rejected. UNC/device strings cannot be reinterpreted as drive bindings.

The native API requests synchronous read/list/attribute access, no handle
inheritance and read-only sharing. Each opened object is inspected by handle:
it must be a disk file/directory, not reparsed or delete-pending. Each component
must stay on the bound volume. A pinned regular file records its volume and
128-bit file ID, size, native write/change times, link count and attributes.
Metadata is checked before and after each bounded read. Native IDs are
observations, not enrollment credentials or cross-lease authorization tokens.
Microsoft documents [directory-relative NtCreateFile opens](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)
and [handle-based file information](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).

Reads use 64-bit offsets and buffers no larger than 512 KiB; no total file-size
cap is added. Directory enumeration parses bounded UTF-16
`FILE_ID_EXTD_DIR_INFO` pages, preserving file IDs, attributes and reparse tags.
Listings bound entry count, encoded metadata and work between native calls,
with explicit truncation. These are buffer/metadata limits, not a drive upload
limit. A native call itself can still block and needs external worker supervision.

Root/pin ownership is registered before native opens begin. Close fences new
operations and retains handles while an open/read/metadata operation is in
flight. Failed release remains false and tracked for retry; a partly closed pin
cannot read through a released/reused handle. The root cannot restart or adopt
another object after fencing. Directory cleanup failures fence the root and are
reported explicitly. Only retained handles are closed; nothing is renamed or
deleted by this component.

## Common download transactions

`WindowsDownloads` in `coordination/src/guest/windows/downloads.ts` implements the existing
`GuestChunkFiles` list and download routes over a started `WindowsRoot`. The
owner injects a guest-path resolver and current assignment authorization. No
public namespace, service endpoint or production provider binding is selected.
Each UUID is reserved before opening and remains bound to its original path.
Conflicting paths, old cursors and wrong phases are refused without replay;
each transfer has a nonblocking operation lane so another transfer can proceed.

Reads advance in at most 512 KiB chunks and hash the returned bytes. Finishing
starts a second pinned-source pass, also at most one chunk per verification
request. Source identity and metadata checks surround reads; the complete second
digest must match the first. A verified receipt is available only after handle
release is positively confirmed. Uncertain release preserves ownership and a
cleanup-pending state; an explicit verification request may retry release without
rereading data. A repeated finish observes its existing state without advancing
another verification step. There is no total file-size product cap; byte cursors
must fit the common protocol's exact integer range.

Authorization is checked before dispatch and before acknowledgements. Observed
revocation permanently fences ordinary operations on this manager; restoring a
predicate cannot revive it. An explicitly supplied cleanup predicate permits
abort only, never reads or verification. Source failures fence the transfer and
retain any unconfirmed handle release. An unknown partial open cannot acknowledge
abort until the owner confirms root shutdown. Owner shutdown refuses late read
acknowledgements and reports pending native cleanup instead of assuming success.

Records are volatile within one worker generation. A new manager cannot resume
unknown IDs or cursors. The service must invalidate prior bindings after a worker
restart; durable receipts and recovery across restarts remain an integration
requirement. Bounded messages do not imply bounded total transfer-history memory.
Upload staging, publication and durability are not implemented by this read
manager and are explicitly unsupported.

## Exclusive upload staging foundation

`windows_staging.Win32Staging` extends the native file API with fresh relative
creation, bounded write calls, file flush and handle-based disposition.
`WindowsStage.create` requires an explicitly bound root using that API, relative
parent components, declared byte length and authorization predicate. It chooses
only a random internal temporary name and never adopts an existing file.
Publication uses the retained handle in the separate step below. The existing
read-only file worker does not dispatch this component yet.

Native creation requests `FILE_CREATE`, exclusive sharing, read/write/delete
access, synchronous I/O, write-through and no-follow behavior, with no allocation
size. Each parent remains pinned on the root volume. Object identity and
non-reparse directory attributes are checked; directory times and size may change
when the component creates its own child. A fresh stage must be a regular,
single-link file on that volume. The root owns the stage and its handle chain
before native opens begin. Registration and its operation lock prevent root
shutdown from forgetting an in-flight create or write.

Writes accept exact sequential cursors and at most 512 KiB at once. Confirmed
partial native writes advance only by their reported length; bad/zero counts,
changed metadata and revoked authorization fence the stage. Loss after write
dispatch reports an unknown outcome and never replays bytes. Staging length is
not preallocated and has no product file-size cap beyond the common protocol's
exact integer range. Finishing requires the received length/digest, flushes the
file and starts a bounded second-pass digest check. A ready stage still has
`durable: false`; this is not a committed upload receipt.

Before publication dispatch, close marks only the owned stage handle for deletion,
then releases that handle and its pinned parents. Failed disposition or close
keeps the object registered for explicit cleanup retry. Once disposition succeeds,
retry only closes the remaining handle; it does not query/write/delete a new path.
Cleanup confirms owned-handle release, not power-loss durability or secure erasure
of guest data. After publication dispatch, the preservation rules below apply.

Microsoft documents [fresh native creation and access options](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile),
[file flushing](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex)
and [delete-on-close disposition](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information).
The documented file flush is not treated here as proof of a complete destination
namespace durability/recovery protocol. Publication durability, journal/receipt
recovery, interruption reconciliation and supervised
common upload dispatch still need implementation and native proof. No volume
flush privilege, enrollment policy or storage exception is selected implicitly.
The native calls must run in the assigned guest under supervision.

## Same-directory publication source

After verified staging, `WindowsStage.publish(name)` accepts one simple component
and invokes `NtSetInformationFile(FileRenameInformation)` through the retained
file handle. A counted UTF-16 name and NULL RootDirectory select the object's
existing directory. ReplaceIfExists requests replacement without POSIX/readonly
override flags. No source or destination is opened by an absolute path; no copy,
path-string or alternate-API fallback is attempted. The temporary source name
itself is refused as a destination. Microsoft documents the [same-directory
rename form and access requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).

Publication records its attempt before native dispatch. A positive native result
records `publication_known`; handle metadata and authorization are then checked
around a file flush. The returned state is `published` with `durable: false`,
never the common protocol's durable committed receipt. Native sharing/rename
compatibility and a complete namespace durability barrier still need proof.

Any missing result or error after dispatch reports an unknown outcome, refuses
replay and preserves the object. If the native rename result is unknown, close
retains the entire handle chain and reports false pending reconciliation. If the
native result was positive, close may release handles while preserving the
destination, even when a later flush or authorization check withheld the receipt.
The cleanup flag is independent of the mutable status string, so errors cannot
send a potentially published handle through staging-disposition cleanup.
Repeated publication is a pre-effect refusal and preserves its prior status.

These records are volatile; no crash journal or cross-worker recovery exists yet.
Durable intent/receipts, native outcome reconciliation, common upload dispatch,
service binding and target-filesystem acceptance remain required before upload
admission. A process exit or a successful handle close is not publication
durability evidence.

## Private file worker

A production private file worker must move the pinned root and read/download
manager into one retained subprocess inside the assigned guest. The generic
transport is `coordination/src/guest/windows/ipc.ts`; it does not supply the native
worker executable or service binding. The owner supplies the approved
drive, root components, guest-path resolver and current authorization predicate.
The resolver runs in the parent; validated relative components cross private,
length-bounded, UUID-correlated stdio IPC. Credentials, enrollment and the public
path namespace remain the owning service's responsibility. Production construction
requires Windows. An injected command is an internal fixture seam, never a host
command API or a guest-files fallback on the host.

Construction launches no child. A validated request lazily opens its root once;
failed roots and transfer cursors are never recreated. One request lane per
binding refuses concurrent work as busy before dispatch. Independent bindings
have independent child processes and can proceed separately. Replies support
bounded chunk data and the existing bounded directory metadata envelope. Pipe
writes and reads occur on the supervisor thread, so a stalled native call or
pipe cannot indefinitely hold the caller. Timeout, active/idle authorization loss,
malformed acknowledgements and uncertain native failures permanently stop/fence
the owned child. No file operation is retried or adopted automatically.

`shutdown()` requests positive native root/handle release before stopping the
child. A false release keeps cleanup pending and allows explicit cleanup retry,
while refusing further file operations. A positive native acknowledgement is
retained if process termination is unconfirmed, so a later shutdown can finish
stopping that same process. `cleanup_confirmed` requires both the positive native
receipt (or a positively unstarted context) and confirmed worker/thread exit.
`close()` is forced supervision only; process exit without a native receipt
leaves cleanup unknown. A hung close or read may therefore need external native
cleanup evidence even after the helper exits. No worker-local timeout proves
lease expiry, guest disk erasure or quota-release eligibility.

The child has no independent assignment deadline or authenticated listener. Its
read-only operations depend on the owning service/supervisor connection. Uploads,
durable restart recovery and production service/provider binding remain required.

## Evidence and remaining work

Required portable cases use filesystem API doubles and worker threads to cover native
structure widths and relative-open marshalling, Unicode directory records,
unsafe names/reparse/type/volume refusal, metadata changes, bounded large-offset
reads, enumeration limits, open/read/close races and uncertain release. The
large-file case uses virtual metadata for a 64 GiB file; it allocates only bounded
read buffers. No Windows DLL, drive or native filesystem was accessed.

Common file adapter cases must exercise with binary and empty
downloads, bounded verification steps, cursor/path conflicts, metadata and digest
changes, short reads, uncertain cleanup, large virtual sources, authorization,
concurrent transfers, shutdown during reads and failed-open cleanup. These use
the pinned-file component with filesystem API doubles. They establish protocol
interoperability in isolation, not native Windows filesystem behavior.

Worker cases must use disposable subprocesses with the same
file manager and filesystem doubles to cover shared-adapter downloads and
large listings, busy refusal, independent bindings, active/idle revocation,
timeouts/crashes, malformed replies, blocked large pipe writes and positive versus
unknown native/process cleanup. This establishes development-host IPC behavior;
Windows kernel handles, pipe cancellation and native filesystem semantics remain
unverified.

Staging cases must use filesystem/thread/FFI doubles for fresh relative
creation, binary/empty and virtual large sources, bounded partial writes,
digest/metadata refusal, pre/post-dispatch revocation, name collisions,
open/write/close races and retained disposition/close failures. No native Windows
file was created, written, flushed or deleted.

Publication cases must use the same doubles for replacement, Unicode/empty
files, retained-handle marshalling, pre-effect refusal, lost/negative native
results, flush/identity failures, revocation and close races. They check that
cleanup preserves every potentially published target and that unknown ownership
cannot disappear behind a positive root-close result. No native rename or
power-loss/restart durability was tested.

Windows API/ABI, filesystem sharing compatibility, directory rename/reparse
races, mapped-file mutation and kernel I/O behavior require native acceptance.
The second-pass digest protocol has isolated coverage; native source stability
still needs proof. Native staging/publication acceptance, upload durability and
common upload integration, durable restart recovery,
native file-worker acceptance, authenticated guest service, public path/provider
binding and native lease cleanup remain to implement or verify. The component
must run inside the assigned guest, never as a host-file fallback. The full
execution goal and acceptance path
remain unchanged.
