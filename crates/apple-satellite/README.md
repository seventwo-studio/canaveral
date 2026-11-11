# Rust Apple satellite (Linux guests)

This executable supervises the existing signed CanaveralVMRunner helper over its
CLI and private files. It creates no listener, downloads nothing, and requires no
Python runtime. It speaks the `linux-lease-runner` wire of the
[TypeScript Linux lease controller](../../docs/linux-lease-controller.md) and is
fixture-tested against that controller. It is not native VM acceptance. The
crate builds only on Unix; on other hosts the binary exits as unsupported.

## Build and enroll

Use Rust 1.99.1 (rust-toolchain.toml), macOS 26+ with hardware virtualization,
and a separately operator-built/signed helper from script/build_apple_runner.sh.
Building/installing/signing the helper and starting a VM require separate
operational authorization. These commands are instructions, not native evidence:

```sh
cargo build --locked -p canaveral-runner-client -p canaveral-apple-satellite
# approval.json comes from explicit controller administrator approval.
target/debug/canaveral-runner-client prepare /ABS/identity https://controller.example < approval.json
target/debug/canaveral-runner-client consume /ABS/identity https://controller.example /ABS/ca.pem < binding.json
target/debug/canaveral-apple-satellite run-once /ABS/satellite.json
```

Keep the config 0600 and parent directories private. Use canonical absolute paths
(no symlink ancestors). Identity and satellite state must be disjoint directories (neither contains the other).
The identity API holds its own exclusive lock and checks the complete expected
binding and HTTPS origin. No code reads identity credentials into satellite state.
A null CA uses system roots; a PEM bundle adds trusted roots. Redirects, ambient
proxies and unverified TLS are refused. Never clone identity/run state between hosts.

Example config (replace placeholders and UUIDs):

```json
{
  "origin": "https://controller.example",
  "identity": "/ABS/identity",
  "binding": {
    "controllerId": "00000000-0000-0000-0000-000000000001",
    "runnerId": "00000000-0000-0000-0000-000000000002",
    "generation": 1,
    "incarnationId": "00000000-0000-0000-0000-000000000003"
  },
  "state": "/ABS/new-satellite-state",
  "helper": "/ABS/CanaveralVMRunner",
  "helperSha256": "sha256:REPLACE_WITH_64_HEX",
  "signingRequirement": "anchor apple generic and identifier \"REPLACE\" and certificate leaf[subject.OU] = \"REPLACE\"",
  "ca": "/ABS/ca.pem",
  "inventory": [{
    "credentialFree": true,
    "image": {
      "id": "linux-installed",
      "revision": "1",
      "arch": "arm64",
      "backend": "appleVirtualization",
      "digest": "sha256:REPLACE_WITH_64_HEX"
    },
    "path": "/ABS/installed-linux.raw"
  }],
  "maxCpu": 4,
  "maxMemoryMiB": 8192,
  "maxDiskGiB": 40
}
```

Inventory `format` is optional: `efiRaw` (default, omitted from retained journal
fingerprints) or `bootBundle` (below). EFI raw inventory is operator-installed, standalone EFI-bootable raw Linux disk media,
with host-matching architecture (arm64 or amd64). No installer ISO, backing file,
external credential file or network image is accepted. The credentialFree field
is an operator attestation about this exact digest: the reusable image contains
no guest secrets that would survive deleting a lease's private disk. Generalizing
and qualifying the installed image remains an operator/native acceptance gate.
Artifacts must be regular files with one link and no write permission bits;
directories must resist substitution. Pin the SHA-256 of the actual signed
helper file, not its bundle or unsigned build. `signingRequirement` is
requirement-language text (passed to `codesign -R` as `=TEXT`); preflight rehashes
the helper after verification and runs `check`, all before any controller contact. Config/binding/inventory changes
on an existing state directory fail closed. Do not delete state to bypass a hold.

### Direct boot bundles

A `bootBundle` entry's `path` is an operator-installed guest bundle v1 `manifest.json`;
`image.digest` is `sha256:` plus its canonical digest, computed by the Rust
guest-protocol canonicalizer (never a Foundation encoding). The kernel, initrd and
rootfs are the manifest's relative paths beside it. They are shared, read-only and never
copied, and cleanup never deletes them. v1 requires arm64, an initrd, and
`root=/dev/vda rootfstype=erofs ro`. These also need a pinned bootstrap builder:

```json
{
"inventory": [{"credentialFree": true, "format": "bootBundle", "path": "/ABS/bundle/manifest.json",
  "image": {"id": "linux-coding", "revision": "1", "arch": "arm64",
            "backend": "appleVirtualization", "digest": "sha256:REPLACE_WITH_MANIFEST_DIGEST"}}],
"bootstrapBuilder": {"path": "/ABS/bin/mkfs.erofs", "sha256": "sha256:REPLACE_WITH_64_HEX"}
}
```

Artifact proof runs each `run-once` before any claim. It walks every component without
following symlinks, and requires owner root or this uid, no unsafe ancestors, one link,
mode 0400, the exact pinned size, the Darwin immutable flag and file magic (ARM64 Image,
EROFS). This idle check is metadata only, not a content proof. Admission hashes every
artifact once and journals its identity (device, inode, size, ctime, flags, mode, owner).
The identity is rechecked before prepare, and any change fails closed. Contents cannot
change while the immutable flag is set, and clearing it changes ctime and flags. Within
that boundary, the trusted operator must not swap directory entries. The helper re-hashes
at prepare and at start.

Each launch consumes a fresh boot attempt UUID with launch intent. It then builds
`workspace/bootstrap/launch.erofs` containing only `launch.json` (binding, workspace bytes,
manifest). The staging root is one 0700 directory holding one 0400 file. The builder is
the operator-installed erofs-utils `mkfs.erofs` (or an equivalent with the same CLI),
pinned by hash, run without a shell or environment, with fixed argv
`--quiet --all-root -T 0 -U BOOT_ATTEMPT DESTINATION SOURCE`, a 1 MiB file-size rlimit and
a 30 s bound. `--all-root` records uid/gid 0 for the guest's ownership checks. The
filesystem UUID is the boot attempt, matching the helper's serial and nonce. The output
must be an owned single-link file of at most 1 MiB with the EROFS magic. It is then made
mode 0400, flushed with F_FULLFSYNC, set user-immutable, hashed, and pinned as Swift's
`launchMedium`. Missing or mismatched builder pins fail before any claim. No image,
kernel, initrd or filesystem tool is built, downloaded or installed here.

The prepare request uses the helper's `directBoot` shape: pins for kernel, initrd, rootfs
and launchMedium, plus the lease revision, filesystem UUID, bundle digest, base command
line, lease, member, host boot session, boot attempt and workspace bytes.

The controller owns domain-wide VM/model admission. Local maxima only reject
oversized assignments; they do not advertise or reserve additional capacity.
Use one exclusive satellite state per approved binding/backend and retain it
through restart. The machine lives below state/workspace/MEMBER_UUID (uppercase,
as required by Swift MachineStore), never in the operator's VM library.

## Supervision and recovery

`run-once` performs one claim attempt; an operator supervisor invokes it again.
The claim ID is synced before sending and replayed exactly after a lost reply. A
definite `null` records nothing, so the next attempt reuses the ID without aging
a later assignment. The authorization deadline starts at the send time of the
claim request that produced the assignment: a replayed claim returns the
controller's current clock, so replay cannot add time. Report replies apply the
same rule to renewals. Continuous Mach time includes sleep. Each native
authorization binds member, lease, revision, boot attempt and host boot
identity; expiry wins renewal, including a late reply. The Swift helper
independently fences execution if the Rust process dies.

Before launch intent, an assignment that is not admissible (image not installed
or changed, resources outside the local or native limits, terminal or expired
lease, host reboot since the claim) is declined: nothing was created, so a single
`failure: provisioning` receipt reports positive stop/removal and the controller
releases the reservation. An assignment with a foreign claim ID or invalid
identity is held, not reported.

Launch intent is synced before workspace creation, prepare and run. Interrupted
prepare or uncertain launch is never retried. Restart fences the machine and
reports `unknown`; it does not infer stop from a missing PID. No automatic
reassignment or state reset is implemented. An operator must reconcile held work.
Heartbeat reports run every second while the guest runs; a lost reply keeps the
exact pending report, and local expiry fences without controller contact. All controller calls during supervision use one scoped background worker with one
in-flight request and capacity-one request/response channels. Heartbeat, poll and
operation-report stalls never block guest pumping, cancellation or local expiry.
The worker borrows the locked identity; it joins after fencing and stop proof,
with the transport's 15-second bound. The identity lock remains held throughout.
The native authorization guard independently ends execution at the deadline.

A supervised stop requires the direct helper process to exit (or a failed prepare
process to have been reaped), an unlocked native runtime lock and a system lsof
scan proving no handles on the owned workspace. Missing tools, permission errors,
a held disk/lock or unknown child state retain the reservation. The positive
stop proof is durable: after a partition, a later `run-once` reports it, waits for
terminal controller acknowledgment and then cleans up. Cleanup deletes only the
descriptor-relative owned workspace, including writable disks and guest credential
material; it never traverses symlinks or deletes source images/unrelated VM
directories. Deletion intent is synced first; an interrupted deletion resumes,
and an absent workspace counts as removed only after that intent. Intent/report
receipts are synced before sending; the exact pending report is replayed after
reply loss, including after completed deletion. After the controller releases the
reservation, the next `run-once` starts a new journal with a new claim ID.
Deletion does not promise forensic erasure of physical media; encrypted host
storage and snapshot/backup policy remain operator concerns.

EFI raw leases report readiness false and runtime `unknown` until stop is proven. Boot
alone cannot make a lease ready, even with no required capability.

For boot bundles, after the helper publishes `direct-started.json` (VMM started), the
satellite accepts only a record bound to this lease, member, host boot session and boot
attempt. The record must name the exact private `/private/tmp/canaveral-UUID/agent.sock`
form. Directory and socket ownership and modes, then the peer uid, are verified before
hello. The published path is journaled. Hello carries the exact launch binding with
`remainingMs` taken from the same continuous lease deadline, minus a 2 s margin. Queued
bytes must drain within 1 s, and ready must arrive within 30 s. Relay delivery beyond
the margin (the helper retries the guest connect while the agent boots) can leave the
guest's own deadline later than the host's. The guest deadline is still at most
ready-arrival time plus `remainingMs`, and the native lease guard independently ends the
VM at the host deadline. Ready must echo the binding
exactly; the guest sends it only after its separate, manifest-bound tool probes. The
receipt then reports `running` with `ready.command` true, only for images that catalogue
`command`. Before ready it reports `starting`. Each newer lease revision is forwarded as
`renew` only while the prior guest authority is still live; a late revision cannot
revive it. Readiness is published only after the bounded read pass has checked for an
already-readable disconnect or protocol failure. Guest I/O is nonblocking with bounded buffers, so a stalled relay never delays
fencing, renewal or reporting. A disconnect, protocol violation, identity or version
mismatch, stalled write, handshake timeout, renewal that cannot be delivered, or lapsed
guest authority withdraws readiness permanently: runtime becomes `unknown` and the VM is
fenced. A restart never reconnects; recovered launches report `unknown` and never relaunch.
After positive stop, the satellite removes the exact journaled relay directory if it is
still owned and contains only `agent.sock`. Our stream is closed before stop proof, so the
helper's relay never waits on it. The owned workspace (including the immutable medium) is
deleted after terminal acknowledgment.

### Experimental command operations

Only direct-boot assignments with observed command readiness poll the closed runner
`operations/poll` route. The immutable assignment/boot/digest tuple and a durable
poll UUID bind every handoff. Null replies reuse that UUID. Each new operation is
journaled before any guest exec or credit; the public UUID maps to a separate
strictly increasing guest UUID. Exact poll replays never execute again. Terminal
receipts remain durable until acknowledged and are retried exactly after reply loss.
Recovery of any received intent without a terminal receipt marks it unknown, fences
the lease, and never reconnects or executes. Existing journals default to an empty
operation lane; their existing launch-intent recovery still prevents execution.

Commands use `/workspace`, empty supplied environment, closed stdin, no PTY and a
requested timeout from 1 to 3600000ms (default 30000ms), shortened by remaining
guest authority at dispatch (including its 2s margin). The timeout is immutable
on replay, and later lease renewal does not extend an active command deadline. The controller start window is checked against request-send time, so reply
latency cannot extend it. Output sequence and final observed byte counts must agree.
Capture totals at most 262144 bytes across stdout/stderr. Initial credit is 65536
bytes; consumed output replenishes equal credit even after capture fills. Receipts
use canonical padded Base64 and record observed counts and truncation. No result is
reported as successful without confirmed termination and exit zero. Spawn failure
is a definite failed receipt; uncertain termination omits result, blocks the lane
and fences. Cancellation, authorization loss, guest failure and local timeout never
supply reservation-release evidence. Separate native stop/cleanup proof remains
mandatory.

Only the current command's capture/report is retained in the main journal.
Completed UUIDs are retained in assignment-bound, append-only history buckets with
fixed-memory scans; they are never evicted to admit another command. There is no
execution-count cutoff. Older inline history is migrated durably before it is
removed from the journal. A partial or replaced history file fails closed; no
automatic repair or history garbage collection is implemented. Disk use grows
with retained tombstones. Polling is at most five times
per second when controller calls complete promptly; heartbeat scheduling takes
priority. No public proxy, PTY, file transport or boot replacement is implemented.

Positive native cleanup can release resources independently of command reporting.
An unacknowledged command receipt remains in the released journal and is replayed
before a new claim may replace that journal. A failed or mismatched acknowledgment
retains the old evidence rather than discarding it during cleanup or restart.

Journal timings (claimed, admitted, medium built, prepared, VMM started, guest ready) are
continuous-clock milestones; fixture values are not performance claims.

## Verification and native gates

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p canaveral-apple-satellite -p canaveral-runner-client --bins --examples --locked
npm --prefix coordination ci --ignore-scripts && npm --prefix coordination run build
# macOS, Node 24, openssl and codesign; disposable loopback TLS and identities only.
node fixtures/apple-satellite/public-api.mjs coordination target/debug/canaveral-apple-satellite \
  target/debug/canaveral-runner-client target/debug/examples/fixture-helper \
  target/debug/examples/fixture-bootstrap-builder
```

Rust unit tests use fake helper subprocesses, socketpairs and disposable directories.
Command tests cover the real supervision poll/exec/report path, lost report replies,
bounded/truncated capture, sequence/count failures, restart after received intent,
legacy journals, cancellation while controller I/O stalls and local fencing during
an active command with a stalled poll. This is experimental Rust fixture coverage,
separate from native acceptance. The TypeScript controller owns authorization
and reservations; the Rust satellite owns bounded execution and reports.
`fixtures/apple-satellite/public-api.mjs` (required CI job
`apple-satellite-conformance`) starts the real TypeScript controller with TLS and
a fixture clock, enrolls a disposable runner through the Rust identity client,
configures an immutable Apple image, grant, one-VM domain and approval, acquires
and releases leases through the public consumer SDK, and runs the real satellite
binary against `examples/fixture-helper.rs`. That helper is copied, ad-hoc signed
and pinned by the fixture; it mirrors the native CLI schemas and lease guard but
starts no VM. It covers preflight failures before any controller contact, CA
trust, lost claim and report replies after commit, never-ready receipts, the
reservation held until cleanup evidence, controller expiry, local deadline
enforcement by the helper's guard while a stalled controller blocks the satellite,
with durable-stop recovery, crash recovery that
never relaunches and keeps `unknown` reservations, and stale-binding refusal. Its
direct-boot section uses a fresh binding and domain with byte-fixture artifacts set
immutable. `fixture-bootstrap-builder` writes a **simulated** EROFS medium (magic, a
not-mountable label and launch.json); it is never mountable. The helper's protocol-faithful
fake guest validates hello against that launch.json. Covered: builder, digest and
immutability failures before any claim; DirectBoot pins and bindings; ready only after
the bound guest ready; renewal forwarding; wrong guest identity; stalled handshake with
controller expiry; release that cleans only owned state; and crash with a lost report
that replays without relaunch or exec while the reservation is held. Rust unit tests add a
wrong guest protocol version, local expiry during a stalled handshake while the controller
is unreachable, and start-record and relay binding checks.

This is fixture evidence only. Real Linux boot on each advertised
Mac/architecture, the signed production helper's requirement and behavior,
suspend/partition beyond expiry on real hardware, positive native disk-handle
release, guest credential hygiene/cleanup, real guest probes, shared domain
contention and prepare duration on real images remain unaccepted native gates. Direct
boot adds these: real `mkfs.erofs` output mounted by the audited initrd, filesystem UUID
selection, virtio serial delivery, the real helper relay and vsock, foreign-uid relay
rejection, and the timings on real images. The separate
[boot-bundle assembler](../../docs/linux-boot-bundle.md) packages a pinned bootstrap
binary into an initrd; kernel/rootfs construction and native bootstrap qualification
remain open. All installed boot artifacts still require operator pins and immutable
installation before satellite admission.
