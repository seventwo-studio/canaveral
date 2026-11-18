# Dashboard APK installation trial, 2026-11-18

PR 63 at 91a9060. The host had 36 GiB of RAM and 116 GiB of available disk before provisioning. The sole Android device in the local Device panel inventory was Pixel_API_36, shut down.

The ephemeral loopback controller enrolled the native Android HostRunner and assigned an ordinary Android machine. The SDK preflight passed. The Android provider provisioned cvm-75817d30-9b4c-4e40-b38c-444a97265a6a from the installed API 36 Google Play ARM64 image. Its AVD registry lived under the runner's private storage in ANDROID_AVD_HOME. Device discovery after provisioning still returned only Pixel_API_36. The required device_open workflow needs a discovered ID for the disposable device. The trial stopped before boot.

The trial process closed the controller and runner and removed its temporary directory, including the AVD. The directory's absence was verified separately. Final inventory still showed only the shutdown Pixel_API_36. Dashboard submission, the installation receipt, exact package identity on device, and controller-driven removal after a running session remain unverified.

## Result, 18 November 2026 (23:32–23:36 CET)

Revision 5a5b62d with no product code changes. Coordination and dashboard assets were built from that tree. The fixture APK came from the new dashboard-android-app.sh: package test.canaveral.dashboardtrial, 8,589 bytes, SHA-256 f16f1491…0554, signed with a single-use key.

Device discovery: T3 device_list does not read the runner's private ANDROID_AVD_HOME, but it lists running emulators found through adb. When Canaveral's provider had booted the owned AVD, device_list showed emulator-5554 named cvm-0f9ec2f2-91c3-4368-ac1c-dbeb6d0afa22, and device_open accepted that ID. The provider boots first and the device tools attach afterwards. No product change, AVD-home redirection or stock AVD change was needed. The driver now prints the serial and waits for a launch-confirmation file, as the iOS driver does. Its direct `adb shell pm list packages` check was removed.

Private state: dashboard-android-install-owIZ7J in the user temporary directory. Machine 0f9ec2f2-91c3-4368-ac1c-dbeb6d0afa22, deletion 2be62c9c-515a-4c08-b3b7-37da0e52ce3b.

- Upload: passed. The invited ordinary account uploaded the APK through the machine detail page. The dashboard created upload bd63d648-9906-48cf-b8c7-533b9c9640fa and install operation edc6908a-ff41-4f37-ac95-300a6a1ebda2 on the assigned machine and host.
- Install receipt: passed. The receipt was succeeded with installed true, artifactCleaned true, and the APK's SHA-256 and byte count (8,589).
- Package observed: passed. The device_open command (`agent-device apps`) listed test.canaveral.dashboardtrial. `agent-device open test.canaveral.dashboardtrial` launched it. The accessibility snapshot and a device_screenshot both showed the "Trial" title and the text "Canaveral dashboard install trial". The panel was then closed without shutdown.
- Shutdown: passed. The owner requested stopped and the controller reported the machine observed as stopped. No emulator process remained.
- Controller-confirmed deletion: passed. Replaying the saved deletion UUID returned complete, and the machine_deletions row is complete. The provider's storage directory and AVD registry entry are absent.
- Upload storage released: passed. The upload reads as deleted through the owner API, with 0 reserved disk and 0 chunks.
- Inventory restored: passed. The ~/.android/avd listing, Pixel_API_36.ini, the Pixel_API_36.avd inode and the config.ini SHA-256 matched the baseline. Afterwards device_list showed only Pixel_API_36 for Android, shut down.

The emulator was not driven with adb or the emulator CLI. On first use the device tool installs its own snapshot helper on the device being inspected; that was the disposable emulator, which was then deleted.

An earlier run at 23:13–23:21 (state dashboard-android-install-CCGNil) was not previously recorded. Its controller database shows a succeeded 8,532-byte install with artifactCleaned true, a deleted upload and a complete deletion. That run included no device_open observation.

### Unverified

- Split APKs, AAB, native video, input, consumer leases and remote hosts.
