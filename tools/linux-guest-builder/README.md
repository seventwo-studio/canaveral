# Experimental native Linux artifacts (ST-534)

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
   over `limactl shell`. Run `fetch-experimental.sh` from `build`, then
   `verify-signatures.sh`. Do not build on signature failure. Kernel checksums
   must verify under `B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1`; Node checksums
   under `C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C`. The WKD/kernel and HTTPS/Node
   key acquisition is experimental trust material, not production key approval.
   Preserve key bytes and signature status logs. Rust archive hashes are explicit
   pins acquired from the official distribution; this recipe checks their hashes,
   not Rust detached signatures.
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
   `Release.gpg` with the Debian archive keyring and lets apt verify the signed
   package index and every archive. Only the immutable snapshot's Valid-Until
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

   Run Cargo from the repository. Preflight establishes bytes/header evidence only;
   the independent signature logs cover the narrower upstream checks. Repeat
   assembly into another new directory and compare every output's hash to verify
   deterministic assembly. Delete that temporary duplicate after comparison.
   Fixed epoch, UUID, locale, timezone and ownership constrain filesystem builds;
   whole-distribution/compiler reproducibility is not claimed by this experiment.
7. Build native erofs-utils separately on the host:

   ```sh
   OUTPUT="$WORK/host-erofs" bash "$REPO/tools/linux-guest-builder/build-host-erofs.sh"
   ```

   This uses upstream erofs-utils `1.8.6` as republished by Debian, with SHA256
   `5b221dc3fd6d151425b30534ede46fb7a90dc233a8659cba0372796b0a066547`.
   The initial host build linked only `libSystem`; no Homebrew runtime library is
   needed. Copy `mkfs/mkfs.erofs` into a private `bin` directory with exclusive
   creation, set mode **0500**, flush, `chflags uchg`, and pin its actual hash.
   Boot data is 0400; the builder requires owner execute, so 0400 fails satellite
   admission. Do not weaken that check. Test the exact satellite invocation with
   an empty environment, a 0700 source directory and a 0400 `launch.json`:
   `--quiet --all-root -T 0 -U BOOT_ATTEMPT DESTINATION SOURCE`.
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
