# Linux agent boot bundle v1

This slice provides a Rust PID1 agent, framing, lease enforcement, a bounded local bundle assembler, minimal Linux bootstrap source and an explicitly gated Linux namespace fixture. Swift direct-kernel preparation and Rust satellite integration are fixture-covered. Kernel/rootfs production builds, signature trust, artifact installation and native end-to-end acceptance remain open. Apple Virtualization and KubeVirt remain the intended backends. Existing EFI/raw image compatibility remains unchanged for future integration. Canaveral services require no Python interpreter.

## Bundle contract

`canaveral_guest_protocol::bundle::Manifest` is the executable schema and verifier. Required fields: version=1, id, revision (positive safe integer), arch=`arm64`, kernel {path,sha256,size}, initrd (same artifact object or null), rootfs (same artifact object), commandLine (exact trusted string), agentVsockPort=1024, protocol=1, toolVersions. Paths use ASCII letters, digits, dot, underscore, hyphen and slash, with no empty, dot or dot-dot components, and are relative beneath the bundle directory; sizes are bytes and SHA256 strings are lowercase hex. File verification rejects escapes, changed sizes and changed digests. Verify artifacts from a trusted, immutable directory; the verifier does not protect a concurrently attacker-writable bundle.

The trusted base `commandLine` is at most 1993 printable ASCII bytes and rejects single/double quotes, a standalone `--` token and any preexisting `canaveral.launch=` token. The launcher addition is exactly 54 bytes (space, key and canonical UUID); the trailing NUL brings the maximum to ARM64’s 2048 bytes. This is a kernel argument string, never a consumer shell command. Native direct boot additionally requires unambiguous `root=/dev/vda rootfstype=erofs ro` tokens and rejects `rw`. The format’s existing `ro` canonical fixture remains valid.

The kernel is an **uncompressed ARM64 Linux Image**, not EFI, PE, bzImage or gzip. The root filesystem is read-only EROFS. `initrd` is optional for the format; bootstrap requirements can make it necessary for a particular launcher. Neither this schema nor a successful hash check proves a kernel or filesystem boots.

`toolVersions` has exactly three keys: `shell`, `git`, `node`. Each value is the exact trimmed first stdout line of its separate exit-zero probe; shell is the capability line `canaveral-shell-v1`, Git includes `git version `, Node is `v24.11.0`. This is not the package-lock schema: release package/compiler/kernel pins remain required recipe inputs below. All manifest string values are printable ASCII (bytes 0x20..0x7e); pins are nonempty, at most 128 bytes, without surrounding whitespace. Unknown keys and duplicate keys are rejected. Incoming JSON order/whitespace and equivalent string escapes may vary; validation precedes canonicalization.

`image.digest` is lowercase SHA256 over canonical bytes. Object keys are sorted by unsigned ASCII byte order at every level: top-level `agentVsockPort,arch,commandLine,id,initrd,kernel,protocol,revision,rootfs,toolVersions,version`; artifact `path,sha256,size`; pins `git,node,shell`. Emit `{`, `}`, `:`, `,` without spaces, integers in unsigned decimal without leading zeroes, and absent initrd as `null`. Strings have double quote delimiters; escape only quote as `\"` and backslash as `\\`, leave slash and every other printable ASCII byte unchanged. Emit UTF-8 with no BOM or trailing newline. No floating-point numbers, Unicode normalization or library-dependent escaping participates. Swift JSONEncoder defaults, including slash escaping, are not this byte contract.

The exact no-newline [known byte fixture](../crates/guest-protocol/fixtures/canonical.json) includes quote, backslash and slash cases; its [SHA256](../crates/guest-protocol/fixtures/canonical.sha256) is the independent Swift compatibility target. Canonicalization is implemented explicitly rather than delegated to serde string escaping. The manifest contains no self-digest. Artifact verification still requires trusted immutable files, and cannot prove that a kernel boots.

## Trusted per-launch configuration

Before executing `/sbin/canaveral-guest-agent` as PID1, trusted bootstrap must mount a separate EROFS launch medium at `/etc/canaveral`, with mount root `/`, `ro,nosuid,nodev,noexec`, and a device distinct from rootfs. The agent checks actual kernel mountinfo, the opened directory/file device against that mount, and the block device's sysfs serial. A baked rootfs file, same-device bind mount, subdirectory bind mount, writable medium, symlink, nonregular file or unsafe permissions is rejected before tools or commands execute. Directory is uid 0 mode 0700; `launch.json` is uid 0 mode 0400, opened relative to the no-follow directory descriptor with no-follow/nonblocking flags, at most 16384 bytes. uid 1000 commands cannot read it. This protects the launch binding from commands, not from guest root.

The trusted launcher must append exactly one `canaveral.launch=<canonical bootAttempt UUID>` to the manifest commandLine when constructing the effective boot command line, and attach only the fresh launch medium with virtio block serial equal to the first 20 lowercase hex digits of the UUID without hyphens (virtio serial's 20-byte limit). The full UUID must match the config's bootAttempt. The boot command line and attached device topology are trusted launcher inputs; device inequality alone is not provenance, and these checks are not a cryptographic attestation. The public manifest commandLine is the base string; this one launch nonce suffix is the only permitted launcher addition.

`launch.json` contains `binding` (leaseId, memberId, revision, bootAttempt, bundleDigest), `workspaceBytes` (16MiB..1GiB) and `manifest` (the complete canonicalizable manifest). The agent recomputes the manifest digest and rejects mismatches; probes use its fixed `toolVersions`, never independent launch pins. This binds data within the trusted launch tuple; it does not prove the running rootfs/kernel matches the manifest. The Rust Apple satellite now verifies launcher artifacts and provisions an immutable, nonce-bound medium per launch through a pinned operator builder, with fixture coverage only. Actual mkfs.erofs output, initrd mount delivery, sysfs serial support and boot delivery on Swift and KubeVirt remain native acceptance gates. The KubeVirt runner adapter remains unimplemented. Never bake this file into hashed artifacts or derive trusted scope from hello.

Rootfs must already be read-only, with `/proc`, `/sys`, `/dev`, `/tmp`, `/run`, `/workspace`, `/etc/canaveral` precreated. Bootstrap retains PID1 through switch-root. The agent mounts proc/sysfs/devtmpfs and bounded tmpfs filesystems, probes tools, listens on vsock 1024, accepts only host CID 2 and never accepts a replacement session. Production refuses non-Linux/non-PID1 invocation; no host execution or test-bypass feature is shipped.

Initial workspace: disposable tmpfs, uid/gid 1000, explicit byte bound, nosuid/nodev. Child commands run as uid/gid 1000 with no supplementary groups, closed stdin and a cleared environment. This is volatile storage; workspace block-device formatting is absent. A later block workspace needs a strict device path, fresh disposable identity, expected size and durable ownership evidence before any destructive operation. Retained or arbitrary `/dev/vdb` must never be guessed or formatted.

The agent owns the guest PID namespace. Commands get separate process groups; production PID1 also kills all its namespace descendants on termination, including escaped groups, and reaps children before confirming a receipt. Unconfirmed termination or lost receipts require native fencing and recovery. Guest receipts cannot authorize VM release or replacement. While a command runs, PID1 enumerates its direct children and reaps each adopted orphan by PID, excluding the retained command leader. It never uses waitid(P_ALL, WNOWAIT), where a waitable leader could hide other zombies. The leader remains unreaped until after final group/namespace signals.

## Operator kernel/rootfs build contract (construction remains external)

The [experimental Linux guest builder recipe](../tools/linux-guest-builder/README.md)
provides a bounded disposable Lima builder, a committed minimal arm64 kernel
fragment, diagnostic-only init, signed upstream input checks, Debian snapshot
rootfs construction, native macOS erofs-utils construction and immutable
installation. It feeds the existing assembler and preflight below. Its pins are
experimental operator choices, not production trust decisions; successful
construction does not close native acceptance or production signature gates.

A release builder must supply all these inputs, without defaults: Debian snapshot timestamp and signed Release digest/trust root; exact arm64 package versions and SHA256 values for bash, coreutils, git, ca-certificates and transitive packages; official Node `v24.11.0` linux-arm64 tarball SHA256 and signature verification material; Rust `1.99.1` toolchain/target archive SHA256 values; kernel source version/archive SHA256, committed config and patch digests; EROFS tool version/digest; bootstrap source/digest and trusted configuration-medium contract. Unknown checksums are **required inputs**, not placeholder pins or floating defaults. Fixture version values in unit tests are synthetic, never release inputs.

1. In an isolated authorized release builder, verify the pinned Debian snapshot metadata and every package digest before extracting packages into a fresh staging root. Do not install packages at boot. Include /bin/sh, Git, CA certificates and all shared libraries. Fix locale, timezone, file order, ownership and SOURCE_DATE_EPOCH to explicit release inputs.
2. Verify the official pinned Node tarball; extract Node to `/usr/local/bin/node` with its support files. Run separate argv probes and check each exit code and expected version. A compound shell command's final status is not proof that all tools work.
3. Build `canaveral-guest-agent` from the public source revision and Cargo.lock using Rust 1.99.1 and `aarch64-unknown-linux-musl`, `--locked --release`. Verify the resulting ELF is static; copy it as `/sbin/canaveral-guest-agent`. No Python production daemon or host executable bridge belongs in this root.
4. Build the pinned minimal kernel with virtio MMIO/PCI, virtio block, virtio vsock transport, EROFS, ext4, tmpfs, procfs, sysfs and devtmpfs **built in**, plus the selected architecture/console/bootstrap requirements. Include PID namespace support and `CONFIG_PROC_CHILDREN=y`; command supervision reads `/proc/self/task/1/children` to reap adopted descendants. Produce uncompressed `arch/arm64/boot/Image`. EROFS root must be mounted `ro`; ext4 support does not authorize formatting any workspace device.
5. Precreate mount points and uid/gid 1000 metadata; assemble deterministic EROFS using the pinned tool and fixed metadata. If needed, produce a deterministic bootstrap initrd from audited source. Keep per-launch configuration external to hashed artifacts. Package no private credentials, retained disks or parent repository history.
6. Record artifact paths, actual byte sizes and computed hashes, exact kernel command line and all tool pins in manifest v1. Canonicalize and compute image.digest. Publish only after a separate authorized boot/ownership/expiry/disconnect/backpressure acceptance run on each backend.

## Bounded local authoring

`canaveral-boot-bundle assemble --recipe FILE --inputs DIR --output NEW_DIR` consumes an operator-built uncompressed ARM64 Linux Image, EROFS rootfs and static AArch64 bootstrap ELF. Authoring requires a Unix host; Windows binaries refuse the operation explicitly. It never executes these files, probes tools, downloads packages, builds a kernel/rootfs or verifies package signatures. Provenance declarations are required evidence fields; they do not establish signature trust, the transitive package closure or rootfs contents. The controller and host runtime use TypeScript, with Rust execution components.

The version 1 recipe is strict JSON (at most 1 MiB): duplicate keys at every depth and unknown fields are errors. Required top-level fields are `version=1`, `id`, `revision`, `commandLine`, `toolVersions` (the manifest's three exact probe lines), `epoch` (unsigned 32-bit seconds), `kernel`, `rootfs`, `bootstrap`, `provenance`. Each artifact is `{path,sha256,size}` with the manifest's relative path and lowercase SHA256 rules. Bounds are kernel 256 MiB, rootfs 8 GiB, bootstrap 64 MiB. Root arguments must include exactly one each of `root=/dev/vda rootfstype=erofs ro` and no `rw`. All release digests must come from the operator; synthetic test pins are not release inputs.

Every provenance pin is `{identity,sha256}`: a nonempty trimmed printable ASCII identity (up to 512 bytes) and an explicit lowercase SHA256. `provenance` requires:

- `debian`: `{snapshot,release,signingKey,signature,packages}`. Snapshot is `YYYYMMDDTHHMMSSZ`; the three metadata/trust fields are pins. `packages` is a nonempty pin array with identities `package=exact-version:arm64` (or `:all`), including bash, coreutils, git and ca-certificates. Operators must enumerate and verify all transitive packages independently.
- `node`, `nodeSignature`, `nodeSigningKey`: pins, with Node identity exactly `node-v24.11.0-linux-arm64.tar.xz`.
- `rust`: pin array containing the host `rust-1.99.1-<host>.tar.xz` toolchain archive and `rust-std-1.99.1-aarch64-unknown-linux-musl.tar.xz` target archive.
- `kernelSource`, `kernelConfig`, `erofsTool`, `bootstrapSource`: pins identifying exact versions/source revisions and content. Bootstrap source evidence must include its Cargo.lock. `kernelPatches` is an explicit pin array, empty only when no patches apply. Duplicate identities within arrays are rejected.

The assembler walks input/output ancestry with no-follow directory descriptors, rejects traversal, symlinks, nonregular files and artifact hardlinks, and requires directories controlled by root/current uid without group/other write access (root-owned sticky ancestors allowed). Use real absolute paths: resolve macOS `/tmp` or `/var` aliases yourself. Inputs and directory entries must stay under the trusted operator's control during assembly; same-user malicious filesystem mutation is not an isolation boundary. It streams bounded copies, compares descriptor identity/change metadata and exact hashes, then rehashes staged copies. Header checks reject malformed ARM64 Image, EROFS and ELF data; EROFS header checks are not a filesystem verifier or mountability proof. Bootstrap must be little-endian ELF64 AArch64 ET_EXEC, with bounded program headers, an executable entry segment and no PT_INTERP or PT_DYNAMIC. Build a static non-PIE MUSL executable for this contract.

Output contains `Image`, `rootfs.erofs`, `initrd.cpio`, canonical `manifest.json`, no-newline `image.digest`, and normalized `recipe.json`. Manifest canonicalization/digest reuse guest-protocol. The uncompressed newc archive has sorted entries `dev`, `etc`, `etc/canaveral`, `init`, `newroot`, `proc`, `sys`, then trailer; uid/gid 0, fixed inode sequence, explicit epoch, directory mode 0700, init mode 0500, zero padding and a 512-byte archive boundary. Identical pinned input bytes and recipe produce identical artifact bytes across source paths and umasks. This is artifact assembly determinism, not distro build reproducibility.

Files are flushed, then a private staging directory is published atomically using rename-without-replacement, and the parent is flushed. Existing outputs, including incomplete directories, are never adopted/replaced. Error cleanup removes only known files in the owned staging directory. A crash may leave private staging; there is no scavenger or automatic recovery. If publication succeeds but the final directory flush fails, the command reports an error and leaves the complete output in place for operator inspection. Mode 0400 does **not** set filesystem immutable flags: separate authorized operator installation and helper admission are still required.

## Read-only production-input preflight

The [wrapper](../script/verify_linux_boot_inputs.mjs) invokes the Rust `verify-inputs` command with locked, offline dependencies and at most two Cargo jobs:

```sh
node script/verify_linux_boot_inputs.mjs \
  --recipe /private/build/recipe.json \
  --inputs /private/build/inputs \
  --evidence /private/build/evidence.json
```

The argument order shown is required. Rust/toolchain and cached dependencies must already be installed; the wrapper does not provision them. Evidence is strict JSON `{"version":1,"files":[{"role":"debian.release","path":"Release","size":123}]}`. This fragment illustrates one entry only: enumerate every provenance pin using dotted roles and zero-based indices, such as `debian.signingKey`, `debian.packages[0]`, `node`, `nodeSignature`, `rust[0]`, `kernelSource` and `kernelPatches[0]`. Paths are relative to inputs, sizes are exact bytes and hashes come from the recipe. Missing, duplicate or unknown roles fail. Kernel/rootfs/bootstrap artifacts are also checked against recipe hashes and bounded format rules.

Exit zero proves local byte equality only. JSON reports recipe/evidence digests, checked file count and `localDigestsVerified: true`; `cryptographicSignaturesVerified`, `debianTransitiveClosureVerified` and `productionBuildReady` remain **false**. Matching key or signature file bytes does not verify a signature. Review `missingBuildInputs` and independently authorize trust roots, signature validation, package closure, reproducible construction and native boot acceptance. No output bundle is assembled or installed by preflight.

Wrapper fixtures establish argv/error handling only, not execution of Rust validation or production readiness. Report actual Rust check results separately for the delivered revision.

## Minimal bootstrap source and handoff

`canaveral-bootstrap` refuses non-Linux or non-PID1 invocation before privileged effects. Linux PID1 uses direct libc syscall interfaces, no shell or utility execution, no device formatting and no fallback shell. It mounts temporary proc/sysfs/devtmpfs, requires one canonical nonnil `canaveral.launch` UUID and the root arguments above, then mounts `/dev/vda` as read-only EROFS at `/newroot`. Rootfs mountpoints must already exist as root-owned nonsymlink directories.

Discovery scans at most 256 block entries per pass, for at most 200 passes separated by 10 ms. Selection requires exactly one whole block device, distinct from root, with EROFS superblock UUID equal to the full bootAttempt and sysfs serial equal to its first 20 lowercase UUID hex digits, matching satellite `mkfs.erofs -U`. It never assumes `/dev/vdb`. The filesystem root is mounted at future `/etc/canaveral` with `ro,nosuid,nodev,noexec`, then checked for uid 0, mode 0700 and the selected device.

Handoff unmounts temporary dev/sys/proc, changes cwd into the future root, moves that root mount to `/` with MS_MOVE (retaining its nested launch mount), chroots into the moved root, changes cwd to `/`, and execs `/sbin/canaveral-guest-agent` with an empty environment as PID1. The agent remains responsible for mounting its own proc/sys/dev and validating launch.json. No old-root directory descriptor is retained; initramfs storage is not recursively reclaimed by this bounded bootstrap. Errors terminate PID1; they never continue into a shell. These source-level properties and cross-compilation do not establish native handoff acceptance.

Header layouts were checked against official Linux [EROFS definitions](https://github.com/torvalds/linux/blob/master/fs/erofs/erofs_fs.h), [ELF definitions](https://github.com/torvalds/linux/blob/master/include/uapi/linux/elf.h) and [ARM64 Image definitions](https://github.com/torvalds/linux/blob/master/arch/arm64/include/asm/image.h).

## Verification gates

Ordinary workspace clippy/tests automatically include boot-bundle through its workspace membership; no native CI job is added. Its portable tests independently decode newc entries, compare assembly bytes across paths/umasks, reject invalid recipes/headers/links/existing publication, check input-change metadata and exercise pure nonce/device selection and host refusal. Linux AArch64 MUSL compilation checks cfg-gated source without executing it. These fixtures do not establish native acceptance.

Ordinary workspace tests validate protocol, canonical bytes, binding, exact probe comparison, host refusal and Linux mount-contract parsing. They never run namespace-wide kills on the host. The example `namespace-supervision` includes the production runtime source with normal compilation: no test replacement for kill(-1), waitpid(-1), privilege drop or reactor paths. It checks inherited original namespace descriptors and refuses unless it is Linux PID1 in distinct PID, mount and network namespaces. It mounts only private namespace tmpfs/proc, then tests real uid 1000 execution, missing executable/cwd, symlink cwd escape, zero-credit silent exit, late/unknown cancel, timeout, active cancel, setsid escape, repeated orphan reaping during a long command, and stalled-output/fragmented-input expiry. It is namespace coverage, not microVM acceptance or a boot-mount test.

Exact proposed action for a separately approved disposable Linux test lane (not added to untrusted PR CI):

```sh
cargo build -p canaveral-guest-agent --example namespace-supervision --locked
```

Running the example requires a matching namespace launcher with the explicit
`CANAVERAL_NAMESPACE_FIXTURE=1` gate. If that launcher is absent from the release,
the execution gate is unavailable; compilation is not a substitute. The lane
requires user namespaces, subordinate uid/gid mappings covering guest uid 1000, `newuidmap/newgidmap` policy and unprivileged private mounts. OS denial is an explicit failed gate: do not use sudo, relax host protection, mount on the host, or substitute a host process test. If policy requires privileged execution, approval for that disposable lane is still required. Existing PR CI only compiles the example through clippy --all-targets and runs ordinary tests. Fresh Linux CI, the namespace fixture, real boot delivery and Apple Virtualization/KubeVirt native acceptance must be reported independently. No new VM, image, container or native experiment was performed.

ST-534 native diagnostic and lease observations, including the 4 KiB launch-medium
requirement and corrected kernel fragment, are recorded in the [native evidence record](../coordination/native-acceptance/README.md).
These experimental observations do not establish production trust/signing, networking,
file transfer, concurrent shared-rootfs use, power-loss recovery or ordinary host lease admission.

## ST-535 workspace launch contract (unimplemented)

Bundle v2 keeps v1 artifact fields/canonical ASCII encoding and adds
`dataVsockPort:1025`, `dataProtocol:1`; `version` becomes 2, `protocol` remains 1
and `agentVsockPort` remains 1024. `toolVersions` gains `mkfsExt4` (exact first
line of `/usr/sbin/mkfs.ext4 -V`, captured from its documented output stream).
Canonical keys, including tool keys, sort lexicographically. The builder recipe
also becomes v2 and requires pinned e2fsprogs plus its transitive package closure;
no floating package version is supplied here. New known-byte/digest fixtures are
required; v1 bytes/digests never change. Kernel must support loopback TCP, vsock,
ext4 and openat2. There is no virtio NIC. v1 inventory continues its existing
behavior but cannot advertise ST-535 workspace/files/egress support.

Launch v2 is exactly `{version:2,binding,manifest,workspace,egress,data}`.
`binding` retains the existing fields and `manifest` must be v2.
`workspace` is `{serial,bytes,overheadBytes}`; serial is a fresh independent UUID's
first 20 lowercase hex digits, distinct from launch-medium serial, and bytes is
an exact multiple of 4096. `egress` is `{enabled,policy:"public-https-v1"}`;
`data` is `{port:1025,nonce}` with a fresh cryptographically random 32-byte nonce
encoded as 64 lowercase hex digits. This replaces v1 workspaceBytes, not an
optional fallback. The 16 KiB launch-file limit and trusted EROFS delivery stay.
Data hello binds the initial launch revision; only control renew changes current
authority, and it covers both streams without refreshing the immutable nonce.

The controller fixes `overheadBytes=67108864` (64 MiB) at acquisition and
`bytes=floor((diskGiB*1073741824-overheadBytes)/4096)*4096`, with a 16 MiB minimum.
This overhead charges bounded per-lease launch/native metadata and journals;
implementations must fail closed if those exceed it. Shared immutable image
storage is operator infrastructure outside the per-lease disk budget. Any extra
host staging must be charged within overhead or separately reserved before use;
this tranche streams file bytes and requires no whole-file host copy. ext4's own
metadata consumes the raw disk's logical bytes, so usable free space is smaller.

Satellite exclusively creates `workspace/workspace.raw` below its owned state,
mode 0600, one link, no symlink ancestors, journaling intent and inode identity
before helper prepare. Guarantee physical space for the entire logical disk
using real host preallocation (Darwin F_PREALLOCATE or an equally strong
reservation), then set exact length and flush file/parent. A sparse truncate or
free-space sample alone is insufficient. Refuse launch if the filesystem cannot
guarantee reservation; never thin-provision against admission's held capacity.
Partial allocation failure needs owned deletion proof before reporting removal.
The helper attaches this exact file read-write, serial pinned, without copying.
Writable media are inode/ownership/length pinned, not immutable/hash pinned.

Guest discovers exactly one whole block device with that serial and exact byte
size, distinct from root and launch medium, with no partition table, existing
filesystem/swap signature or holders. Ambiguity or a signature fails boot; no
force/reuse or guessed /dev/vdc. Only then run pinned mkfs.ext4 once, mount ext4 at
/workspace with nosuid,nodev (executable), chown uid/gid 1000 mode 0700, and create
`.canaveral`, `home`, `tmp`, `.npm` with safe ownership. Never reformat on recovery.
A consumed boot attempt is never relaunched. Files readiness requires this mount,
strict file-confinement support and dataReady; command readiness requires writable
workspace plus both initial handshakes. Native format/flush/serial acceptance is
still open. Deletion is reclamation, not cryptographic secure erasure.

### ST-535 schema implementation boundary

The Rust manifest canonicalizer validates v2 data fields and the `mkfsExt4` pin;
known bytes/digests live in `crates/guest-protocol/fixtures/canonical-v2.*`.
`launch-v2.json` exercises the separate closed workspace launch schema. Existing
v1 canonical bytes/digest are unchanged and legacy launch rejects a v2 manifest.
These are schema fixtures, not native acceptance. The v2 recipe now accepts
the mkfsExt4 pin; builder scripts verify the snapshot package closure and kernel
config. The native helper implements workspace attachment and the data relay.
PID1 formatting/mounting and end-to-end runtime integration remain unimplemented. The gated satellite v2 prepare path
creates workspace.raw exclusively, journals intent and device/inode identity,
reserves physical space using Darwin F_PREALLOCATE with F_ALLOCATEALL, then sets
exact length and fsyncs file/parent. Unsupported reservation fails closed. Cleanup
requires positive stop proof and identity-checked unlink with durable deletion
intent and parent fsync. Unidentified creation is retained for reconciliation.
It generates the independent serial/data nonce and builds launch v2; helper
prepare receives version:2 and workspace:{path,serial,bytes}, without workspaceBytes.
Portable lifecycle tests inject allocation; they do not establish Darwin physical
reservation, ext4 durability or native attachment acceptance.
Satellite inventory explicitly refuses v2 before a claim; no v1 downgrade occurs.
