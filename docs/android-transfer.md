# Android native upload primitive

The [native transfer helper](../canaveral/native/android_transfer.c) implements
checked upload staging and publication. The Android provider now integrates it
when an operator configures a validated helper manifest. Provider and end-to-end
fixtures pass; real device execution remains unverified. No helper has been
installed or run on a real device by this work. Ordinary runners still cannot
advertise consumer lease execution.

Toybox's current [sync implementation](https://raw.githubusercontent.com/landley/toybox/master/toys/lsb/sync.c)
calls global `sync()` without a checked per-file result. A successful rename plus
that command is insufficient evidence for Canaveral's durable upload receipt.
The helper instead calls file and directory `fsync` and reports their failures.

## Protocol

The process accepts `upload`, an absolute destination path, a known byte count
and a fresh canonical UUID as separate arguments. Its private pipe protocol is:

1. The host sends exactly the file bytes. The helper creates a same-directory
   private temporary file exclusively, writes and synchronizes it, then emits
   `CANAVERAL_TRANSFER_V1 STAGED <uuid> <bytes>` followed by a newline.
2. The host must recheck assignment/lease authorization and device ownership
   before sending `COMMIT <uuid>` followed by a newline and stdin EOF.
3. The helper rejects a mismatched commit or trailing input. It rechecks the
   staged descriptor and directory entry, atomically renames through the open
   directory descriptor, closes the file and synchronizes the directory. Only
   then does it emit `CANAVERAL_TRANSFER_V1 COMMITTED <uuid> <bytes>` and exit zero.

Only the configured host adapter may translate that exact committed receipt into
the public upload finish. It must check authorization again before acknowledging
success. Missing receipt, timeout, nonzero exit or lost authorization after commit
is uncertain; publication may have occurred. Neither process failure nor a lost
receipt authorizes replay under a new operation identity or claims rollback.

Native pipe messages are bounded metadata, not the public WebSocket control
protocol. Files stream in 64 KiB buffers without full-file staging in host RAM.
Counts retain the existing safe JSON integer representation. The helper uses a
30-second timeout while awaiting pipe input; it does not enforce a consumer lease
deadline or fence detached commands. VM/device deadline enforcement and native
lease acceptance remain separate gates.

The destination stays unchanged before commit. Cancellation attempts to remove
only the helper's exclusive temporary inode. A foreign temporary collision or
replacement is not deleted. Cleanup is best effort, not proof of post-crash
reclamation. After rename the helper never removes the destination as rollback.
Directory descriptors keep publication bound to the original parent if its path
moves. Actual Android filesystem, emulator-storage and power-loss behavior still
need acceptance; successful syscalls alone are not that proof.

## Build without deployment

Use an already installed Android NDK:

```sh
node script/build_android_transfer.mjs \
  --ndk /path/to/installed/ndk \
  --output-dir ./dist/android-transfer
```

The script builds PIE executables for Android API 26+ on `arm64` and `amd64`.
It checks ELF architecture and writes a SHA-256 manifest. Test-only fault
injection is excluded from these artifacts. It downloads no toolchain and
does not push, install or execute a helper. The retained C source is an intentional
native dependency; SDK runtime use does not require a native compiler.

## Configure the Android runtime

Set `transferHelperManifest` to the absolute path of the generated `manifest.json`
in the physical host's Android runtime options. Legacy standalone Android runner
configuration accepts the same field. The manifest is local operator configuration;
a consumer request cannot select helper binaries or paths. Configuration changes
and starting/reloading an actual runner require their existing authorization.

The provider snapshots the selected binary, verifies checksum, ELF architecture,
API level and absence of test hooks, then creates a fresh private helper directory
on the owned device. It pushes the snapshot, verifies the installed checksum and
launches a bounded bidirectional ADB pipe without a PTY. It validates exact staged
and committed receipts, checks authorization and device ownership before commit
and before success, and completes short pipe writes. Authorization lost after a
commit attempt produces `upload_publication_uncertain`; it never claims rollback.

Helpers use exclusive per-transfer directories. Cleanup removes the known helper
file and attempts a nonrecursive directory removal; unexpected entries remain.
No guest cleanup commands run after authorization ends. Deferred helper cleanup
does not invalidate file synchronization, but successful upload is not proof that
all helper resources were reclaimed. Lease/device cleanup and real cancellation
acceptance remain separate gates.

With no manifest, the direct legacy drive path retains its existing behavior and
reports `durable: false`. The consumer runner explicitly refuses that known
unsupported durable-upload path before guest mutation. A configured invalid
manifest fails rather than falling back to an unconfirmed write.

Host environment reports include an `android-upload-helper` check and an
`androidUploadHelper` capability. Missing configuration is a warning, an invalid
configured artifact is a failed prerequisite, and valid configured artifacts are
reported as validated for the offered images. This is artifact validation, not
proof of Android ABI execution or native platform acceptance. The helper artifact
size bound is a control/tooling envelope, not a drive upload-size limit.

The installed NDK 30.0.14904198 successfully cross-compiled both artifacts in
isolated temporary output. Host-native tests compiled the same source with
strict warnings and exercised real disposable files, multichunk/empty payloads,
commit/EOF/timeout rules, inode mutation, foreign collisions, renamed parents
and injected synchronization/publication/receipt failures. Host conformance is
not Android ABI execution or guest acceptance.

Additional fixtures execute the provider against fake ADB mapped entirely to
disposable host files, running the host-compiled C helper. They cover metadata,
installation identity, authorization transitions, native sync/receipt failures,
short writes and cleanup behavior. A real temporary controller/broker/runner/SDK
path verifies multichunk/empty durable finishes, digest refusal before native
commit, and unsupported configuration without guest mutation. These checks do
not invoke adb or an emulator.

Real Android helper installation, filesystem compatibility, power-loss behavior,
guest process cancellation and separate-network acceptance remain open. Real
device tests and any change to running guests require their own approval.
