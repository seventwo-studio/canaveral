# Base and captured image contract

The artifact library, reservation/build contracts and dashboard/API publication have fixture coverage. Native configured-file capture and independent clone isolation require further acceptance; fixture results do not establish these guarantees.

## Image identity and media

The [base image registry](image-registry.md) discovers official publisher images
and imports a pinned artifact onto a selected host. It is separate from captured
images and does not substitute an installer for an installed boot disk.

Each imported image receives a caller UUID, display name, OS, architecture,
headless/desktop mode, minimum VM resources and explicit media type. Installer
media (`iso`, `ipsw`) is distinct from an installed boot disk (`raw`, `qcow2`,
`vhdx`). A valid container header is not proof that the OS will boot or that a
runtime can expose its installer console. Per-runtime acceptance remains explicit.

The host stores immutable artifacts under SHA-256-derived names and private image
definitions in its protected state directory. Import reads fixed-size buffers,
preserves zero regions as sparse file holes and publishes only a complete,
checksummed artifact. Interruption or authorization loss removes the temporary
upload. The same image UUID and identical metadata/content is idempotent; another
artifact or specification cannot overwrite it. Public metadata never exposes
host-local paths, preparation contents or credentials.

Image definitions adapt to the internal immutable template API for compatibility.
Public names and `mediaType` survive normalization. Private bindings retain source
paths; recipe/artifact digests remain the public integrity contract. Catalogue
publication must be acknowledged by the controller, with storage reserved, before
new definitions can be advertised for VM creation. A host-local artifact alone
does not establish admission or successful publication.

The agent verifies registered artifact checksums before provisioning. Hashing
requires a regular file and pins one descriptor, checking device/inode, size,
modification and change times against both the descriptor and directory entry.
It reads the initial logical size in fixed buffers, so a growing tail cannot
extend the scan indefinitely. Symlinks, FIFOs, directories, replacement and
observed mutation cannot become verified artifacts. A verified file is cached
only while its identity metadata stays unchanged. This runs in reconciliation,
outside the heartbeat path; it is not an atomic filesystem snapshot.

New references to existing artifacts use the same verification. An identical
image-UUID retry returns its original metadata; it is not a fresh health proof
of the stored bytes. Invalid existing artifacts are preserved for inspection,
without publishing a new reference. POSIX fixtures cover change-time checks;
native Windows mutation behavior remains unverified.

The compatibility [base preparation command](templates.md) also uses guarded
cache verification and publishes without replacing a competing entry. Configured
local source links remain supported by resolving once and pinning the regular
file; cache entries themselves must be regular files. Its fixture coverage and
publication uncertainty contract do not establish installer or native boot
acceptance.

## Cold capture

Initial capture is disk-only, after desired and observed state are both stopped
on a connected host. Runtime-specific ownership and positive stopped/fenced
checks are required. Running-memory snapshots are outside this initial contract.
For Apple/Linux, capture holds the native runner's own runtime lock and requires
the existing assignment and native-preparation receipts.
Its stopped status must belong to the latest recorded native launch. A prepared
Linux guest also receives a graceful poweroff request through its pinned guest
connection, recorded before dispatch so a lost response cannot replay it. Neither
the request receipt nor a disconnected SSH session proves the native VM stopped.
An explicit [power-off recovery](power-and-recovery.md) can instead establish a
positive process/disk fence. Its captures are labelled crash-consistent. This is
separate from graceful shutdown and never an automatic fallback.

The build keeps a durable started receipt. It stages its manifest until the copy,
source identity/size/modification checks and pinned configuration validate.
The copy reads one pinned regular-file descriptor. Device/inode, size,
modification time and change time must match both that descriptor and the source
directory entry before/after copying and after the provider context exits.
Where supported, no-follow/nonblocking opens prevent a substituted symlink or
FIFO from becoming the source. An ordinary write followed by restored modification
time is still rejected by the change-time check on the tested POSIX filesystem.
These checks supplement the provider fence; they do not create an atomic filesystem
snapshot or establish native Windows change-time behavior.

The derived manifest remains staged until the provider has successfully exited
its capture context and source checks still match. Publication synchronizes the
containing directory on POSIX. Failure while releasing the fence quarantines the
staged manifest; an unconfirmed directory sync after publication reports unknown
rather than a clean failure. Both retain reservations and block source restart.
A published derived image records its source-machine provenance. A
verified published manifest can recover a lost final receipt without repeating
capture; its image UUID, name, source-machine identity and checksum must match.
Partial or changed copies never become advertised images; uncertainty
retains storage reservations and requires positive recovery rather than replay.

Source restart is blocked while capture is queued, running or unresolved. Image
storage is reserved transactionally alongside other allocations under the host disk limit, with
an initial extra GiB for container metadata. Completed immutable artifacts are
charged once per host/content hash/format. Same-format aliases share one artifact;
different formats retain distinct stored files and charges even for identical
bytes. This matches the existing ledger and does not change accounting rules.
Unconfirmed disk effects retain their charge.
Stopped source disks retain their original reservation independently of images.

Seven isolated integrity fixtures exercise descriptor/path swaps (including
symlink/FIFO substitution), restored timestamps during copy, changes/failures at
fence exit, publication sync uncertainty, independent artifact bytes and lost-receipt
identity checks. A controller fixture confirms that uncertain capture retains its
disk reservation and blocks source restart. These use disposable files and a fake
runtime; the retained native capture/clone and per-platform gates below remain open.

## Clone identity and current runtime gates

Captured disks preserve configured OS state. The Linux guest-access recipe
generates fresh broker tokens and pinned SSH host keys per assignment; this is
not full guest identity generalization. Machine ID, DHCP identity, application
credentials and simultaneous independent-clone behavior require explicit
verification before consumer isolation can be claimed. Image capture must not
silently modify the source VM to make the copy usable.

The initial Apple capture adapter handles Linux disks. macOS capture additionally
needs restore/base dependencies, auxiliary storage and hardware-model artifacts,
with a fresh VM platform identity. Other adapters must prove their native cold
capture paths. Apple installer interaction currently lacks an API console before
guest services start; guest VNC cannot substitute for that console. These gates
remain open even though the existing native runtime can boot installer media.
