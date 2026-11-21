# Native mobile parity trial

On 21 November 2026, an operator-authorized trial exercised Canaveral revision
`116cd52` on one arm64 Mac. Each run used a disposable loopback controller,
private runner and device storage, and at most one device. The tools were
Xcode 27.2, idb companion 1.7.8, Android Emulator 37.2.13, Android 36 Play arm64,
platform-tools 37.0.1 and the locally built native supervisor. The trial kept credentials and raw
receipts local.

## iOS simulator lease

**Passed for one normal release.** A fresh iPhone 17e on iOS 27.2 reached
`ready` about 41 seconds after admission. The private device set contained one
booted simulator. The readiness receipt recorded the boot, install, launch
and control companion checks. An `apps` operation using the lease key succeeded.
The lease advertised `shared-host`. Release completed with removal of the
device's storage and zero reservations. The default simulator inventory matched
the starting snapshot.

The run did not exercise expiry, forced shutdown, interruption during boot,
supervisor loss, launchd service restart, or scoped app install and input. See
the [iOS trial plan](ios-lease-simulators.md).

## Android warm adoption

**Passed for immediate adoption.** In each warm-pool run a real emulator became
ready in roughly 38–41 seconds. A lease adopted the same machine, emulator PID
and boot ID. The lease reported `source: warm`, and the isolation receipt was
positive. Release removed the owned storage and returned all reservations.
Long idle holds, resource usage and adoption during a runner restart remain open.

## Android runtime inventory

**Passed.** An administrator's `runtime-list` operation reached the real Android
runner and returned the installed Android 36 Play arm64 image. Runtime install
and removal, idle stop, orphan purge and pressure gating remain open.

## Android live view

**Passed through the lease SDK.** With tunnels disabled, the SDK received an
initialization segment and three media segments from the adopted emulator.
FFmpeg decoded all 167,135 bytes with no errors. The first three media segments
arrived within about two seconds of attachment. Lease cleanup completed and the
default AVD inventory matched the starting snapshot.

A combined trial on a tunnel-enabled host ended when the runner detected an
unmanaged adb mapping and fenced the lease. The lease cleanup completed. This
run establishes the mapping fence, while browser playback of a native stream,
multi-viewer timing and live capture on owned iOS remain open.

## Android baseline state

**Passed after the restore fix.** On `116cd52`, a baseline-backed clone reached
ready but returned `null` for a setting that survived a restart of the source.
The emulator recreates qcow2 disks when the AVD's system-image version cache is
missing or mismatched. The restore now writes that cache from the baseline's
digest-verified system-image metadata before starting the clone. Existing
baseline manifests and digests remain valid.
[Android Emulator disk initialization](https://android.googlesource.com/platform/external/qemu/+/emu-master-dev/android-qemu2-glue/drive-share.cpp)

In the rerun, the source retained the setting after a stop and restart. The
runner captured it, booted a lease from the pinned baseline, and the clone's
lease key read back the exact setting. The clone needed no overlay rebase,
so rebasing an absolute backing path remains unverified natively. The clone lease,
saved baseline and owned source were removed through the controller APIs.
Cleanup returned all reservations and left the default AVD inventory unchanged.

## Android port tunnels

**Passed in both directions with one connection at a time.** The guest fixture
used Android's Java socket APIs to exchange a 57-byte marker with the lease
holder through a reverse tunnel. The SDK recorded 57 bytes sent and 57 received.
A separate forward tunnel echoed the marker from a guest loopback listener.
Both closes reported `mappingRemoved: true`. No tunnel listener was exposed by
the trial on a non-loopback TCP address.

Earlier shell-based probes opened a reverse connection without a verified
payload and failed to start the forward fixture. The socket-based trial verified
both transfers. Metro integration, throughput and concurrent streams remain open.
