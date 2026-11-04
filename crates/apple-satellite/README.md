# Rust Apple satellite (Linux guests)

This executable supervises the existing signed CanaveralVMRunner helper over its
CLI and private files. It creates no listener, downloads nothing, and uses no
Python production code. It speaks the `linux-lease-runner` wire of the
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

Inventory is operator-installed, standalone EFI-bootable raw Linux disk media,
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
exact pending report, and local expiry fences without controller contact. A
report can block for up to the identity client's 15-second request deadline; the
native authorization guard independently ends execution at the deadline meanwhile.

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

Command, PTY and files readiness remain false and runtime is reported `unknown`
until stop is proven: this slice supplies no actual guest probe or guest-access
transport. Boot alone cannot make a lease ready, even with no required
capability. Provisioning timeout, cancellation and controller expiry therefore
remain expected outcomes until guest access is integrated.

## Verification and native gates

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p canaveral-apple-satellite -p canaveral-runner-client --bins --examples --locked
npm --prefix coordination ci --ignore-scripts && npm --prefix coordination run build
# macOS, Node 24, openssl and codesign; disposable loopback TLS and identities only.
node fixtures/apple-satellite/public-api.mjs coordination target/debug/canaveral-apple-satellite \
  target/debug/canaveral-runner-client target/debug/examples/fixture-helper
```

Rust unit tests use fake helper subprocesses and disposable directories.
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
never relaunches and keeps `unknown` reservations, and stale-binding refusal.

This is fixture evidence only. Real Linux boot on each advertised
Mac/architecture, the signed production helper's requirement and behavior,
suspend/partition beyond expiry on real hardware, positive native disk-handle
release, guest credential hygiene/cleanup, real guest probes, shared domain
contention and prepare duration on real images remain unaccepted native gates.
