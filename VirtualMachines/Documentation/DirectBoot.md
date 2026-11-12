# Native direct Linux boot v1

`Preparation.directBoot` is an optional operator-only inventory entry. Existing EFI/raw and Apple native macOS paths retain their configuration. Direct boot requires a leased Linux headless machine. This component does not download or build a kernel/rootfs or bridge a host shell.

The inventory resolver must verify the guest bundle v1 manifest and its artifact pins using the guest-protocol verifier before invoking preparation. Swift does not parse or canonicalize that manifest: `bundleDigest` is the resolver's verified canonical digest, never a Swift JSONEncoder digest. The Rust canonical.json / canonical.sha256 fixture remains authoritative for any future Swift manifest interpreter.

Inventory fields are version=1, revision (positive safe integer), kernel, initrd, rootfs, launchMedium (each absolute path, lowercase SHA256 and exact byte size), bundleDigest, commandLine (the exact verified manifest base string), leaseID, memberID, bootSessionID, bootAttempt, launchFilesystemUUID and workspaceBytes. These are trusted host-resolved fields, not consumer-selected paths. The resolver must match kernel/initrd/rootfs to the manifest and launchMedium to the complete fresh launch tuple. `memberID` is this machine's UUID. `bootSessionID` is the native host boot session; `bootAttempt` is a fresh canonical guest UUID. The launch filesystem UUID is operator inventory evidence, not read or attested by Swift.

Installed files must be private single-link regular files, owner root or the helper uid, mode 0400 (no write or group/other bits), with a filesystem immutable flag. Every path component must be nonsymlink and controlled by the trusted operator; root-owned sticky ancestors are permitted for a private installation beneath /private/tmp. The operator must keep directory entries stable throughout verification and VM lifetime. Hashing cannot protect against that trusted operator replacing an entry concurrently. Swift checks sizes/digests and ARM64 Image/EROFS magic; these checks do not prove bootability. Shared rootfs is attached read-only as the first block device (/dev/vda), never copied or converted.

## Trusted bootstrap delivery

The Rust Apple satellite prepares the fresh launch EROFS medium for each launch with the operator's pinned `mkfs.erofs` builder (see its README); the local `canaveral-boot-bundle` assembler now packages an operator-built static AArch64 bootstrap into a deterministic initrd (see [authoring contract](../../docs/linux-boot-bundle.md)). Bootstrap source is implemented; the operator still builds/pins kernel, rootfs and bootstrap binary and installs the artifacts. Assembly does not set immutable flags or establish helper admission. Swift only attaches these pinned files. Null initrd is explicitly unsupported in v1. No mounting, filesystem creation, formatting or image generation occurs in preparation.

The launch medium must contain uid 0 directory mode 0700 and uid 0 launch.json mode 0400, at most 16384 bytes. Its JSON must contain binding {leaseId, memberId, revision, bootAttempt, bundleDigest}, workspaceBytes and the complete manifest. The trusted initrd must mount this medium's filesystem root at /etc/canaveral with ro,nosuid,nodev,noexec, distinct from the EROFS root device, and retain PID1 through switch-root into /sbin/canaveral-guest-agent. A baked launch file is insufficient. Bootstrap selects exactly one separate whole block device whose EROFS superblock UUID equals the full bootAttempt and whose sysfs serial equals its first 20 lowercase UUID hex digits. It never guesses a workspace device. It unmounts temporary proc/sys/dev before MS_MOVE/chroot/exec handoff, preserving the nested launch mount; the guest agent mounts its own proc/sys/dev. Signature trust, kernel/rootfs production, installation and native PID1 handoff remain operator acceptance gates.

The base commandLine is printable ASCII, at most 1993 bytes, without single/double quotes or a standalone `--` token. The appended space plus `canaveral.launch=` and UUID is exactly 54 bytes; with a NUL, the effective line fits ARM64’s 2048-byte limit. Required root=/dev/vda, rootfstype=erofs and ro tokens cannot be hidden behind quotes or the kernel’s `--` separator. No shell consumes this string.

Swift sets the launch virtio block identifier to the first 20 lowercase UUID hex digits and appends exactly one canaveral.launch=<lowercase bootAttempt> nonce. Actual Linux sysfs serial delivery remains a native acceptance gate. Workspace v1 is guest tmpfs, 16 MiB through 1 GiB, with at least 64 MiB of the reserved RAM left for other uses. This minimum is a bound, not a memory sizing recommendation. Nothing formats a block device.

## Lifetime and transport

The existing positive native lease guard remains mandatory and independent. An exclusive attempt receipt prevents retries only within the retained machine directory, including after uncertain starts. Before start, Swift fsyncs the receipt and directory metadata, then requests Darwin F_FULLFSYNC through the receipt to flush the drive cache. Power-loss recovery has not been tested. Deleting or replacing state removes this local guard; it does not preserve a global attempt ledger. The parent Rust satellite must retain its own durable attempt journal and prohibit automatic re-preparation or reuse of a consumed launch tuple. New attempts require an explicitly authorized fresh tuple and medium; there is no automatic reconnect or retry. State is private under the machine's lease/host-session/attempt binding.

After VZ start returns, direct-started.json records event=started with a continuous-clock timestamp, lease/member/host-session/attempt and the agent socket path. This is VMM started, not guest ready. The timestamp is sampled after listener creation. There is no EFI variable store or graphics device for this path.

A fresh private /private/tmp/canaveral-<UUID>/agent.sock listener (0600, parent 0700) avoids the Unix socket path limit without changing process cwd. The published absolute path identifies that per-machine boot's agent.sock. Peer credentials must report the helper’s uid before a stream consumes the one session or opens a guest connection; rejected peers leave the listener available. Exactly one authorized local stream connects through this VM's VZ virtio socket device to fixed guest port 1024; Apple's host-originated connection supplies HOST_CID. Because the agent listens only after boot and its tool probes, a failed guest connect is retried every 250 ms for at most 60 s while the relay is not stopped. Local bytes wait in the accepted stream's socket buffer meanwhile. Native connect-failure semantics before the guest listens remain unaccepted. No arbitrary socket path or guest port is accepted. Relay storage is 64 KiB total, with partial-write offsets, directional backpressure and EOF half-close. Stop shuts down relay descriptors and closes the native connection; cleanup waits for the worker to close its descriptors after its bounded poll interval. Runtime stop/error/release cleanup retains existing status, console and lock behavior. Socket closure alone never proves VM release.

After a helper crash, a published socket directory may remain pending cleanup. Startup never scans or deletes other socket directories. The parent must retain the exact owned published path and binding, establish positive native VM stop, verify directory ownership, and remove only that path. Cleanup is not stop proof.

The parent Rust satellite authenticates ownership before opening the socket, sends hello with a conservatively bounded duration, awaits guest ready, forwards renewals, and requires earlier guest control frames to be consumed before any exec through its command client. Consumer route integration and its public fixtures are documented separately; this component supplies transport only. Swift neither frames nor interprets guest messages. Consumer routing remains outside this component. Satellite integration is fixture-tested with a fake helper relay and guest; no VM ran.

The same-uid credential check is covered with socketpairs; a live foreign-uid rejection before guest connect remains an integration gate. Optional-image Runner request decoding and relay drain before stopped-status publication are source/build checked; no helper or VM was executed.

Compilation, artifact verification and unprivileged Unix socketpair tests establish no native acceptance. Socketpair coverage includes 4 MiB byte-exact traffic in both directions, backpressure, half-close and stalled stop; it does not establish VZ descriptor shutdown semantics. Shared read-only rootfs use by multiple VMs on one host remains unproven. Trusted initrd mount delivery, filesystem UUID selection, real block serial, PID1/tool probes, end-to-end vsock, stalled relay shutdown, independent expiry and stop/handle release require separately authorized native acceptance. Production namespace supervision remains a separate gate.

## Authorized native diagnostics

The [operator acceptance harness](../../coordination/native-acceptance/README.md) is
separate from ordinary tests. Its signed session probe compares configuration validation,
invalid-kernel rejection and firmware-only VZ start/stop across execution contexts. These
observations do not establish Linux boot or production-helper acceptance. The full harness
requires installed real bundle artifacts and a real pinned `mkfs.erofs`; setup-only mode
stops before acquisition. Real boot, command and cleanup evidence must be retained in the
private run directory before closing the corresponding native gates.

ST-534's 2026-11-12 operator-authorized arm64 diagnostic boot observed the actual
20-hex launch-disk serial through Linux sysfs. The production helper now drains
pending console bytes on close and persists a final transcript, including guests
that stop before the periodic snapshot. See the [native evidence record](../../coordination/native-acceptance/README.md)
for the narrower full-lease results and remaining production gates.

## ST-535 direct boot v2 helper

For workspace-v2 preparation, directBoot.version becomes 2. Replace workspaceBytes
with `workspace:{path,serial,bytes}`; path is canonical absolute and
host-resolved under satellite-owned state, never consumer input. The data port is fixed at 1025; no data port inventory field is accepted. Kernel/rootfs/initrd/
launchMedium pins and existing boot binding stay unchanged. Swift does not parse
launch egress/nonce; the satellite binds them in the immutable v2 medium. Writable
workspace admission checks one-link regular inode, mode 0600, trusted ancestry,
exact size and distinct identity from immutable media. Satellite guarantees
physical reservation; helper must preserve and recheck its pinned inode when
attaching it read-write with the fresh 20-byte serial. No format/copy/resize occurs
in Swift. Attach after the read-only rootfs and launch medium; the guest discovers
by serial, never device order. Preparation journal must retain mutable disk
identity; cleanup cannot infer removal from a missing guessed path.

Direct-boot v2 and v1 configurations must explicitly have **zero network devices**;
remove the NAT attachment from direct boot only. EFI/raw and macOS keep existing
networking. Host vsock has no listening port. The helper initiates both 1024 and
1025 connections to the guest's prebound listeners. V2 publishes a second private
same-uid Unix relay `data.sock` beside agent.sock, with
`dataSocketPath` added to direct-started.json; validate/retain both exact owned
paths. Each relay independently has a 64 KiB buffer, bounded polling and partial
writes. Only initial connect establishment may retry within the existing 60s boot
window, before a connection succeeds; after connection loss no reconnect. Separate
data worker failure does not close control/VM or disable the native deadline
guard. Stop initiates fencing immediately, then allows data workers at most 2s to
close. Unconfirmed worker/descriptor closure blocks cleanup evidence. No native
acceptance follows from this contract or existing one-relay socketpair tests.

Direct-kernel configurations now attach no network device. EFI Linux and macOS
retain NAT; unit tests exercise all three configuration decisions. Workspace-v2
disk attachment and the independent port-1025 relay are implemented;
no native networking-isolation acceptance is implied by configuration tests.

The v2 workspace path must have no symlink components or unsafe writable ancestors.
The helper checks current uid, mode 0600, regular-file type, single link, exact
length, 4096-byte alignment and a distinct 20-lowercase-hex serial. It rechecks
inode identity around VZ attachment. Satellite-owned path entries must remain
stable throughout prepare/run; same-uid malicious replacement is outside this
trust boundary. The helper neither allocates nor copies, resizes, formats or
removes workspace media. VZ attaches it with `.uncached` caching and `.full`
synchronization, read-write, after the root and launch disks. Physical reservation
remains the satellite's responsibility, not established by helper metadata checks.

V1 retains its existing JSON fields and tmpfs bounds; v2 omits `workspaceBytes`.
Both channel listeners use mode 0600 and the same getpeereid uid check, and each
consumes one authorized local stream. Data setup/connect/pump failure affects only
data. A setup failure leaves the published data path unavailable and cannot yield
guest data readiness. Both channels stop on VM stop. Unix fixture tests cover
single accept, fixed port selection, mode, data stop with live control, and the
shared pump's backpressure/half-close behavior. They do not run a VM. Native
acceptance must verify writable-disk sysfs serial and exact size, preallocation,
format/mount, VZ flush/caching and descriptor lifetime, both vsock handshakes and
independent data-loss/control renewal behavior.
