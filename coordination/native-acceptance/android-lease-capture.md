# Android lease capture trial: large install and MP4 through the lease key, 2026-11-19

The CI and marketing-capture case: a job leases an emulator, installs its real build, drives named screens, takes PNGs and records a playable MP4, all with its lease key. A second recording then outlives the lease; expiry must end it, cleanup must be proven and the reservation released. See [lease recording and large installs](../../docs/mobile-control.md#lease-recording-and-large-installs).

Driver: [android-lease-capture.mjs](android-lease-capture.mjs). The run used the `feat/lease-android-record-install` working tree on top of main 9ccdc97, before its first commit, with the debug `canaveral-mobile-native` build installed by `script/prepare_native.mjs debug`. It ran 15:10–15:16 UTC on the Mac Studio, with emulator 37.2.13 and Homebrew FFmpeg with libx264.

## Setup

- The driver started an ephemeral loopback controller and an in-process Android `HostRunner` in a private temporary directory, with the lease clock and supervisor set to the built helper, `leaseProtocol: 1`, one Android lease image and `videoEncoder` set to `/opt/homebrew/bin/ffmpeg`.
- Host capacity was 3 CPUs, 4352 MiB and 14 GiB: one emulator (2 CPUs, 4096 MiB, 12 GiB), plus one recording (1 CPU, 256 MiB) and one upload's scratch (2 GiB). The application's resource limits were the same.
- The template was `system-images;android-36;google_apis_playstore;arm64-v8a` (a user build, as #77 requires) with the `pixel_8` profile. Its AVD was created in the runner's private `ANDROID_AVD_HOME`.
- The APK came from [dashboard-android-app.sh](dashboard-android-app.sh) with `TRIAL_PADDING_BYTES=1500000`, which adds a stored random asset. It was 1,511,885 bytes (three 512 KiB chunks), package `test.canaveral.dashboardtrial`, SHA-256 `553653fd…acdfb`, signed with a single-use key and accepted by `apksigner verify`.
- Every lease call after the credential exchange used the SDK `LeaseClient` with the lease key: `uploadApp`, `installApp`, `operation`, `createOperation`, `deleteAppArtifact` and `video.record`.
- Baseline from the T3 device tools: the only Android device was `Pixel_API_36`, shut down. No `netsimd`, `crashpad_handler`, `qemu-system`, `screenrecord` or `ffmpeg` process ran.

## Result

| Step | Time (UTC) | Outcome |
| --- | --- | --- |
| Lease ready | 15:11:27.2 | Lease `da06f019…2632`, machine `c6ffd71f…0f66`, TTL 300 s (expiry 15:15:51.272). Isolation probe passed. Emulator PID 14285 under supervisor PID 14283. |
| Upload | 15:11:27.3 | `uploadApp`: 3 chunks, `state: ready`, SHA-256 matched. Host reservation 2 CPUs, 4096 MiB, 14 GiB (12 GiB emulator + 2 GiB scratch). Replaying the upload intent returned 200. |
| Install | 15:11:34.3 | `install-uploaded` succeeded: `{installed: true, sha256: 553653fd…, bytes: 1511885, artifactCleaned: true}`. Replaying the operation UUID returned the same receipt (`created: false`). `apps` listed the package. |
| Upload released | 15:11:34.3 | `deleteAppArtifact` → `deleted`; reservation back to 12 GiB. |
| Named screens | 15:11:51.2 | `screen-launcher-home.png` (after `KEYCODE_HOME`) and `screen-trial-app.png` (after `launch`): both valid PNG, 1080×2400. `hierarchy` contained "Canaveral dashboard install trial". |
| 30-second MP4 | 15:11:51.2–15:12:23.3 | `video.record` (30 s, 4 Mbit/s) while the driver alternated `KEYCODE_HOME` and `launch` every 3 s. Finish receipt: 7,631,732 bytes, `cleaned: true`; the written file's SHA-256 matched the receipt. Session `finished`, `cleaned: true`. |
| ffprobe | 15:12:23 | MP4 (`mov,mp4,…`), H.264 Constrained Baseline, 576×1280, yuv420p, 30/1 average frame rate, 820 frames, duration 27.33 s. `ffmpeg -f null` decoded with no errors. A frame decoded at 10 s showed the launcher. |
| Observation | 15:12 | T3 `device_list` showed `emulator-5554` named `cvm-c6ffd71f…`. `device_screenshot` showed the Play image's launcher. The panel was closed without shutdown. |
| Second recording | 15:15:06.3 | `video.record` for 135 s, started 45 s before the lease's expiry. |
| Recording ended | 15:15:50.4 | The stream ended without a finish receipt (SDK `session_disconnected`) 0.84 s before the controller's expiry time, after 12,839,346 bytes. No host `screenrecord` adb client or `ffmpeg` process remained. |
| Held until proof | 15:15:52.4 | Lease `failed` (the runner's conservative fence reported before the controller's expiry, as documented for #77). Session `disconnected`, `hostCleaned: true`, `cleaned: false`. Reservation still 3 CPUs, 4352 MiB, 12 GiB. |
| Cleanup proven | 15:15:55.5 | `lease-stopped.json`: reason `fenced`, `groupAbsent: true`. Lease cleanup `complete` (attempt 2), storage removed. Session `cleaned: true`. Reservation 0 CPU, 0 MiB, 0 GiB. A new recording request returned 410 `lease_ended`. |

The first recording's encoded duration (27.33 s for a 30 s capture) follows the frames Android emitted, as recorded in the earlier dashboard trials; the screen was static between the driver's changes.

After the trial, a portable test found that the runner's same-assignment check for early recorder cleanup compared the whole lease record, whose controller clock changes on every heartbeat, so a leased capture cancelled while its lease was still live could not prove its recorder stopped. The check now compares the lease identity. The trial did not exercise that path: its first recording ended at its own time limit, and its second ended with the lease, whose stop proof settled it.

The partial file of the second recording held 42.5 s of decodable fragmented MP4. It has no finish receipt and is incomplete by contract.

## Baseline restored

After the runner and controller closed, the driver found no leftover supervisor, `-avd cvm-` emulator, `netsimd`, `crashpad_handler`, `qemu-system`, `screenrecord` or `ffmpeg` process. `~/.android/avd`, `Pixel_API_36.ini`, the `Pixel_API_36.avd` inode and its `config.ini` SHA-256 matched the baseline. T3 `device_list` again showed only `Pixel_API_36` (shut down) for Android. The private trial directory was kept for inspection (`TRIAL_KEEP_DIRECTORY`) and then deleted by hand, together with the copied trial log and the APK build directory.

No pre-existing device was started, stopped or inspected beyond the T3 device list. The leased emulator was driven only through Canaveral lease operations and the lease-key SDK. T3's `device_open` was used only to take one screenshot.

## Not verified by this trial

- The runner's own exact-recorder proof after expiry. Here the lease's stop proof settled the recording; the portable suite covers both paths, supervisor loss mid-recording and an unconfirmed encoder exit.
- An install interrupted by expiry or supervisor loss, an upload interrupted by expiry and application-limit refusals. Fixture only.
- Release and key rotation mid-recording: fixture only. Runner or controller loss during a lease recording: not covered.
- Recordings at 180 s through a lease, concurrent leased recordings on one host, Linux hosts, other emulator versions, iOS and the release build of the helper.
