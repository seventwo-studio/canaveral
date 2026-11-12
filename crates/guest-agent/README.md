# Guest agent

ST-535 workspace boot support is partial. PID1 accepts the closed launch-v2
schema, configures loopback using Linux ioctls, and provisions the independently
identified workspace. V1 retains its tmpfs and control-session behavior.

Workspace discovery uses kernel sysfs serial and size, rejects ambiguous matches,
partitions, holders and any device backing an existing mount (including root and
the launch medium), and checks the opened block descriptor's identity and size.
The first and last 1 MiB must read as zero, as must 4 KiB at the btrfs mirror
offsets of 64 MiB and 256 GiB when present. These windows cover primary/backup
partition tables and common ext4, XFS, btrfs and swap signatures. The scan reads
at most 2 MiB + 8 KiB regardless of capacity. Fresh satellite creation and
preallocation establish blank media; this scan is defense in depth. Read errors
and premature EOF in scanned windows fail boot. No force or reuse path is provided.
The pinned `/usr/sbin/mkfs.ext4 -V` stderr first line is checked before
formatting; formatting runs once with a bounded timeout. Failure never retries.
Formatting and mounting use PID1's pinned device descriptor via procfs.

The ext4 mount must be writable, executable, nosuid and nodev on the expected
device. Workspace and `.canaveral`, `.canaveral/transfers`, `home`, `tmp`, `.npm` are uid/gid 1000 mode
0700. PID1 pins the workspace root and probes strict openat2 confinement support.
Any provisioning failure fails boot.

V2 binds HOST_CID-only, one-shot control/data listeners (1024/1025) after
provisioning and probes, before any command. Data hello must match the initial
launch binding and nonce exactly. Control ready waits for the complete dataReady
echo; renewal and expiry continue independently while waiting. Later data loss or
violation withdraws local files readiness and closes all proxy sockets, while
the initial handshake latch allows commands to continue. No data reconnect is
possible. Never relaunch a consumed boot attempt: formatted media is rejected.

The independent data thread uses nonblocking sockets, bounded decoding/output
slots (including a reserved control slot), per-flow receive accounting, a global
budget and strictly increasing flow IDs. At most 16 proxy clients/flows exist.
A rotating cursor moves at most 64 KiB payload per flow per turn; connect and
payload-idle deadlines are 10 and 120 seconds. Half-close drains before shutdown.

Loopback CONNECT on 127.0.0.1:18080 enforces the shared strict HTTP grammar,
8192-byte header ceiling, five-second header deadline and fixed error responses.
The listener opens no flow without the launch grant. It returns 200 only after
satellite opened, then relays opaque bytes under explicit credits. V2 commands
use /workspace, fixed PATH, workspace HOME/TMPDIR/npm cache and grant-scoped proxy
variables; command-supplied environment/cwd overrides are rejected.

File requests execute on a dedicated worker through a bounded single-step queue.
The reactor retains exact request/receipt replay for up to 128 transfer IDs and
closes data rather than evicting replay authority. It continues proxy/control
processing during hashing and fsync. Per-step CLOCK_BOOTTIME deadlines are fixed
at acceptance; replay cannot extend them. Raw thread-local setgroups and
setfsuid/setfsgid drop filesystem authority to uid/gid 1000 without changing
PID1's real/effective IDs or other threads' credentials. Worker shutdown cancels
publication and does not join blocked filesystem calls.

The worker supports staged no-replace uploads, cursor and incremental hash checks,
a second full hash pass, pinned downloads with identity/change detection, abort,
and cancellation. Publication fsyncs the file and both directories. Cancellation
inside the publication window or failed post-rename durability returns unknown.
An unknown receipt blocks subsequent file effects. No additional crate is needed:
the protocol Cursor supplies both hash passes.

This remains partial and satellite v2 admission must stay gated. Existing-target
`replace:true` deliberately returns `destination_exists`; atomic eligible-target
replacement still needs a race-safe design. Parent/staging reachability and file
identity are rechecked, but native adversarial rename/staging races remain an
acceptance gap. Replay receipts are process-local, not restart recovery evidence.
The frozen protocol Replay helper retains full requests rather than compact
request digests. Digest-backed retention and the 128-ID limit need integration
and memory-budget review. Native
fault injection must qualify cancellation, ENOSPC and uncertain rename/fsync,
worker credential isolation, and shutdown while syscalls are blocked.

Portable tests and Linux cross-checks establish no native acceptance. An
authorized native run must verify actual sysfs serial/device provenance, fresh
media, formatting without prompts, pinned mkfs version, ext4 flags/ownership,
openat2 support, loopback address/route, failures on ambiguous/used disks and
fresh-attempt behavior. It must also verify both vsock handshakes, HOST_CID
enforcement/no reconnect, control renewal/expiry during data backpressure or loss,
proxy half-close/idle behavior and real Git/npm HTTPS with system CA trust.
Satellite destination/route enforcement and complete file execution remain
separate acceptance requirements.
