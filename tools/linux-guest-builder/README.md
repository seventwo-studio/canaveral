# Experimental native Linux artifacts (ST-534 / ST-535)

This recipe builds arm64 direct-boot inputs for Apple Virtualization. It does not
qualify an image for production or run a lease. All pins are experimental operator
choices. Keep `productionBuildReady`, production signature approval, and native
acceptance false. Review the [bundle contract](../../docs/linux-boot-bundle.md),
[wire contract](../../docs/guest-wire.md), and [satellite admission
rules](../../crates/apple-satellite/README.md) before use.

## Prerequisites and ancestry

Use macOS arm64 with Lima VZ, Node, Rust 1.99.1 (Cargo at `~/.cargo/bin`), Xcode
command line tools, autoconf, automake, libtool and pkgconf. These are operator
prerequisites, not silently provisioned by the recipe. No Python code is used.
The disposable Debian builder provisions its own dependencies as guest root;
no host sudo, security changes, services or signing identities are needed.

Before downloading anything large, inspect every component of the build and
installation paths with `stat`/`lstat`. Reject symlinks, foreign ownership, and
writable ancestors unless root-owned and sticky. Both Rust `private::walk` and
Swift `PinnedBootFile.verify` accept root/current-uid directories without group
or other write bits. A root-owned `/Users` at 0755 is accepted without sticky.
The final directory should be current-uid 0700. `/tmp` is a symlink on macOS;
use `/private/tmp` explicitly if choosing that location. `install.mjs` repeats
ancestry checks but assumes a trusted operator keeps entries stable throughout.

Use a canonical path without spaces, outside the checkout. Examples below use
`$HOME/.canaveral-native`; every build/output directory must be new. Do not reuse
satellite runtime state or an existing VM. Limit concurrent work to this VM's
4 CPUs / 8 GiB / 40 GiB. Check free RAM and disk first.

## Build

1. Create private host work directories. Set `REPO` to the canonical checkout,
   `WORK` to a private new work directory, and `DEST` to the new installation
   directory (default `$HOME/.canaveral-native/artifacts/bundle`). Choose and
   record a public source commit in `REV`. Never archive a dirty worktree or
   include credentials/history. Save `git archive "$REV"` as `$WORK/source.tar`
   and the exact commit as `$WORK/source-revision.txt`.
2. Start a dedicated uniquely named builder:

   ```sh
   VM="canaveral-artifacts-$(date +%s)-$(openssl rand -hex 4)"
   limactl start --yes --name="$VM" "$REPO/tools/linux-guest-builder/lima.yaml"
   ```

   Record `VM` for cleanup. The template has one checksum-pinned Debian cloud
   image and no floating fallback, mounts or container runtime. Guest package
   tools come from the image's authenticated Debian repositories; their versions
   must be recorded for compiler-level reproduction. Existing VMs are unrelated.
3. In the guest user's home, create `build`, extract `source.tar` into `build/repo`
   and copy this recipe directory to `build/recipe` using `limactl copy` or tar
   over `limactl shell`. Initialize a private GPG home, acquire the kernel key
   with `gpg --auto-key-locate clear,wkd --locate-keys autosigner@kernel.org`,
   and export `B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1` to
   `build/inputs/kernel-key.gpg` after fetching inputs. Retain the authenticated
   builder Debian archive keyring as `build/inputs/debian-archive-keyring.gpg`. Run `fetch-experimental.sh` from `build`, then
   `INPUTS="$PWD/inputs" bash recipe/verify-source-inputs.sh`. Do not build on signature failure. Kernel checksums
   must verify under `B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1`; Node checksums
   under `C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C`. The WKD/kernel and HTTPS/Node
   key acquisition is experimental trust material, not production key approval.
   Preserve key bytes and signature status logs. `verify-build-inputs.sh` also
   verifies both Rust archive detached signatures under pinned fingerprint
   `108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE`. It authenticates erofs-utils
   through Debian trixie's signed Release, SHA256 Sources index, exact 1.8.6-1
   source entry and .dsc SHA256. All three existing archive pins must also match.
   Key acquisition and pin selection remain experimental, not production approval.
   Missing signatures, mismatches or unavailable verification tools stop the build.
   The Rust build repeats authentication before executing install.sh.
4. Set `BUILD` to the guest's absolute `build` path. Run:

   ```sh
   BUILD="$PWD" bash recipe/build-rust.sh
   INPUTS="$PWD/inputs" OUTPUT="$PWD/kernel-build" bash recipe/build-kernel.sh
   OUTPUT="$PWD/diagnostic" bash recipe/build-diagnostic.sh
   BUILD="$PWD" bash recipe/build-rootfs.sh
   BUILD="$PWD" bash recipe/export-inputs.sh
   ```

   Kernel `6.12.117` starts with allnoconfig and the committed `arm64.config`;
   every requested built-in is checked after Kconfig resolution. Record the
   resolved config too. There are no patches or modules. Rust uses locked source,
   1.99.1, static non-PIE MUSL and two Cargo jobs. Diagnostic init is a separate
   static C executable: it prints `CANAVERAL-DIAGNOSTIC-ONLY-v1` to hvc0, lists
   block serials and powers off. **Never catalogue the diagnostic initrd for leases.**
5. The rootfs uses Debian bookworm at snapshot `20261101T000000Z`, verifies
   `Release.gpg` with a keyring exported only from the pinned Debian primary
   fingerprints and re-inspected after export. Apt uses that restricted keyring
   and an empty additional trusted-key directory. A loopback-only mirror serves
   exactly the verified Release and SHA256-authenticated Packages index; it fetches
   only index-listed archives and checks their SHA256 before returning any bytes
   to apt, before extraction or maintainer scripts. No upstream metadata is
   forwarded. Apt also verifies this same signature/index/archive chain. Only the immutable snapshot's Valid-Until
   time check is disabled. All 117 installed package identities in the initial
   experiment matched the retained archives, including the complete essential
   closure. `export-inputs.sh` requires equality of these sets on every build.
   Node is the official `24.11.0` linux-arm64 distribution. Separate chroot probes
   must exit zero; their exact lines generate `toolVersions`. No boot-time package
   installation occurs. The image contains precreated mountpoints and uid/gid 1000
   workspace metadata, with no launch configuration, machine-id or private keys.
   Debian's locked account metadata is not a login credential. No host directories
   or keyrings other than the public Debian archive keyring enter the rootfs.
6. Copy `source.tar` and `source-revision.txt` into guest `inputs`. Copy `inputs`
   back to `$WORK/inputs` and retain signature logs, ELF inspection, package lists,
   build logs, Lima configuration, compiler/tool versions and diagnostic outputs.
   Run on the host:

   ```sh
   node "$REPO/tools/linux-guest-builder/write-recipe.mjs" "$WORK/inputs"
   ~/.cargo/bin/cargo run --locked -p canaveral-boot-bundle --bin canaveral-boot-bundle -- \
     verify-inputs --recipe "$WORK/inputs/recipe.json" --inputs "$WORK/inputs" \
     --evidence "$WORK/inputs/evidence.json" > "$WORK/preflight.json"
   ~/.cargo/bin/cargo run --locked -p canaveral-boot-bundle --bin canaveral-boot-bundle -- \
     assemble --recipe "$WORK/inputs/recipe.json" --inputs "$WORK/inputs" --output "$WORK/bundle"
   ```

   Run the complete `verify-signatures.sh` gate after export and before assembly.
   Run Cargo from the repository. Preflight establishes bytes/header evidence only;
   the independent signature logs cover the narrower upstream checks. Repeat
   assembly into another new directory and compare every output's hash to verify
   deterministic assembly. Delete that temporary duplicate after comparison.
   Fixed epoch, UUID, locale, timezone and ownership constrain filesystem builds;
   whole-distribution/compiler reproducibility is not claimed by this experiment.
7. Build native erofs-utils separately on the host:

   ```sh
   INPUTS="$WORK/inputs" OUTPUT="$WORK/host-erofs" bash "$REPO/tools/linux-guest-builder/build-host-erofs.sh"
   ```

   The host requires gpg, gpgv, xz and an authenticated Debian archive keyring
   (set `DEBIAN_ARCHIVE_KEYRING`); it repeats the same signature chain before
   extracting source. The authenticated inputs include the Rust archives.
   This uses upstream erofs-utils `1.8.6` as republished by Debian, with SHA256
   `5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547`.
   The initial host build linked only `libSystem`; no Homebrew runtime library is
   needed. Copy `mkfs/mkfs.erofs` into a private `bin` directory with exclusive
   creation, set mode **0500**, flush, `chflags uchg`, and pin its actual hash.
   Boot data is 0400; the builder requires owner execute, so 0400 fails satellite
   admission. Do not weaken that check. Test the exact satellite invocation with
   an empty environment, a 0700 source directory and a 0400 `launch.json`:
   `--quiet --all-root -b4096 -T 0 -U BOOT_ATTEMPT DESTINATION SOURCE`.
8. Install with `node tools/linux-guest-builder/install.mjs "$WORK/bundle" "$DEST"`.
   Capture stdout to an external report. It exclusively creates private files,
   flushes, sets 0400 and user-immutable, and verifies single-link metadata.
   Generate the exhaustive checksum report outside the hashed trees:

   ```sh
   node tools/linux-guest-builder/report.mjs "$WORK/inputs" "$DEST" "$BIN" > "$WORK/pin-report.json"
   ```

   `BIN` is the private builder directory. Native boot, launch-medium mounting,
   serial delivery, vsock, readiness, ownership and fencing remain separate gates.
   Stop and delete only the dedicated builder after copying evidence out:
   `limactl stop "$VM"` then `limactl delete --yes "$VM"`.

## Reinstall and removal

Never update pins in place while a lease may hold a file. Stop and positively
reconcile dependent leases first. Install a new release into a new private
directory; verify its hashes/admission and explicitly update operator inventory.
To remove an old release, apply `chflags nouchg` to its explicitly enumerated files,
then remove those files and the empty owned directory. The executable builder
also needs `nouchg` before replacement/removal. Do not recursively clear flags or
remove shared runtime state. Keep input/evidence bytes until native acceptance
and review are complete, then delete disposable build trees and caches according
to the operator's retention policy.

ST-534 native integration requires `CONFIG_PROC_CHILDREN=y` for PID1 orphan
supervision; tool probes and readiness alone did not exercise that interface.
The recipe verifies the resolved built-in. `CONFIG_DEBUG_INFO_NONE=y` is the
resolved Kconfig choice for builds without debug information. Native findings
and still-open production gates are in the [evidence record](../../coordination/native-acceptance/README.md).

ST-534 review authenticated the exact existing Rust archives and erofs-utils
source; all hashes matched the experimental pins, so installed artifacts were
retained without rebuilding. Signature status and chain evidence remain private
with the native review run.

Run `node --test tools/linux-guest-builder/signature-gates.test.mjs` for the
portable refusal regression: failed detached-signature verification must stop
before the Rust installer destination is created. This does not substitute for
running real upstream signature verification on the pinned archives.

### Primary-key and complete-input gate (ST-534)

All successful `VALIDSIG` records must name a pinned **primary** key in the final
status field. Rust key bytes are inspected before import; multiple or mismatched
primary keys are refused. The Rust pin is
`108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE`.
The Debian primary allowlist covers bookworm archive
`B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8`, bookworm stable
`4D64FEC119C2029067D6E791F8D2585B8783D481`, trixie archive
`04B54C3CDCA79751B16BC6B5225629DF75B188BD` and trixie stable
`41587F7DB8C774BCCF131416762F67A0B2C39DE4`.
Both snapshot and erofs Release status files are checked against this list.
Keyring membership alone never authorizes a signature. The complete gate also
refuses any non-pinned primary in `debian-apt-keyring.gpg`; retain that exported
keyring with the inputs. `verified-mirror.test.mjs` covers exact metadata, encoded
package names and refusal of corrupt or unlisted archives.

Run `verify-source-inputs.sh` before building, with `INPUTS` set to the absolute
input directory and the authenticated Debian keyring retained there. Acquire
the kernel key through the kernel WKD and export the pinned key as
`kernel-key.gpg` on the first run. Relevant source verification repeats before kernel,
Rust, rootfs and host erofs builds. It verifies kernel, Node, Rust and erofs
signatures and pins each time, including pre-existing files.

After exporting the complete package set, run `verify-signatures.sh` with the
same `INPUTS` before accepting or installing artifacts. This complete gate fails
on missing inputs. It additionally verifies the retained snapshot Release,
its SHA256 Packages index, every retained package archive and exact package
identity set. `authenticated-inputs.json` enumerates authentication methods,
source archive provenance, Cargo.lock checksum enforcement, and hashes of all
reviewed recipe inputs. Git archive entries, modes, symlink targets and contents
must match the selected source revision; differences in tar metadata between Git
versions are ignored. Cargo still uses `--locked` to authenticate fetched registry
crates against Cargo.lock when compiling. Builder-image package tools and host
Xcode/autotools remain explicit operator prerequisites. This gate does not claim
a reproducible compiler or production trust approval.

The fingerprint refusal tests include successful GPG exits with wrong fetched
primary and wrong `VALIDSIG` primary fingerprints, unpinned Debian primary
signatures and missing complete-gate inputs. Retained experimental bytes must
pass the same gates; presence never substitutes for verification.

Run the complete gate from the maintained repository on a verifier with GPG,
gpgv, xz, Node, Git and the selected source revision's Git objects available;
a source archive extraction alone has no Git object database. After copying
inputs back in step 6, use
`INPUTS="$WORK/inputs" bash "$REPO/tools/linux-guest-builder/verify-signatures.sh"`.
A disposable Linux verifier can instead import an operator-provided Git bundle
and invoke the recipe under that checkout. Delete that verifier and bundle after
retaining signature evidence. The source-only guest build gates do not need a
Git object database. No missing verification dependency is silently skipped.

### Workspace bundle v2 (ST-535)

The maintained recipe emits version 2 and adds `toolVersions.mkfsExt4`, the exact
first line of `/usr/sbin/mkfs.ext4 -V` (stderr, captured together with stdout).
The rootfs includes e2fsprogs from the same bookworm `20261101T000000Z` snapshot.
The authorized native build resolved e2fsprogs `1.47.0-2+b2:arm64` through
the signed snapshot. [formatter-pins.json](formatter-pins.json) records its
complete ten-package Depends/Pre-Depends closure and SHA256 pins, verified
through the pinned Release → Packages → archive chain. The builder retains every
installed archive and exports exact `package=version:architecture` identities
and SHA256 pins into `packages.tsv` and recipe provenance. The installed package
set must equal the retained archive set, including the transitive closure.

The complete signature gate authenticates Release under the existing Debian
primary-key pins, then Packages and every archive. `verify-debian-packages.mjs`
also requires e2fsprogs and its recursively retained Depends/Pre-Depends closure,
recording exact identities and hashes in `formatterClosure` in
`debian-packages-verified.json`; apt enforces dependency version constraints.
`verify-input-inventory.mjs` refuses absent formatter evidence and authenticates
that report in the input inventory. Run the complete gate before generating the
recipe or assembling it; recipe pin generation alone is not authentication.

Kernel construction still uses allnoconfig plus the fragment. NET/INET provide
loopback TCP, vsock and ext4 are built in, and virtio-net is explicitly disabled.
The build checks Linux 6.12.117's unconditional openat2 implementation and generic
arm64 syscall-table entry; there is no openat2 Kconfig switch to enable.
`productionBuildReady` stays false. Native acceptance must still build and verify
the actual closure/probe, boot the v2 PID1 implementation, confirm no NIC and both
vsock listeners, format/mount the separately reserved disk once, observe its
serial/size, and test filesystem/VZ flush and independent data/control behavior.

The native v2 build disables `CONFIG_NETDEVICES` explicitly. Kconfig omits
`CONFIG_VIRTIO_NET` when that parent is disabled, so checking for its literal
“not set” line incorrectly rejected a kernel with no network device drivers.
The rootfs includes `netcat-openbsd` alongside git, npm, dd and system CAs.
