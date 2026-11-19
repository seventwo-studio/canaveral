# Dashboard Android recording cleanup trial, 19 November 2026

Follow-up to the [video lifecycle trial](dashboard-mobile-video-lifecycle.md), which
left Android early cancellation without positive cleanup. This trial checks the
runner's new recorder stop: after Cancel or leaving the page, it stops the exact
guest `screenrecord` it started, confirms that it exited and reports cleanup. See
[Android recorder cleanup](../../docs/mobile-control.md#android-recorder-cleanup-after-early-cancellation).

Driver: `CANAVERAL_TRIAL_EARLY_CANCEL=1 CANAVERAL_TRIAL_SECONDS=30 node
dashboard-mobile-capture.mjs android`, run on the Mac Studio homelab from this PR's
branch. Coordination and the Rust mobile helper (`prepare_native.mjs debug`) were
built from that tree, and the dashboard assets came from it unchanged. As before,
each run started a disposable loopback controller and enrolled one native HostRunner
(`videoEncoder` `/opt/homebrew/bin/ffmpeg`). It created one disposable Android
device as an invited ordinary account and drove the real dashboard gateway and
assets in Playwright Chromium. In this mode the driver:

1. starts a 30-second recording, presses **Cancel recording** after 10 seconds, and
   requires `cleaned=1` and the reservation back at the machine's own baseline;
2. does the same, but closes the page (`runBeforeUnload`) after 10 seconds;
3. records a full 30-second clip and verifies it with ffprobe and FFmpeg;
4. stops the machine, requires that no session lacks cleanup, deletes it without
   any abandonment and compares the AVD inventory with the baseline.

Before and after each cancellation, the driver lists guest processes named
`screenrecord` read-only with `adb -s <disposable serial> shell ps -A -o PID,NAME`.
`agent-device` has no process listing. Only the runner signals the guest.

Tools: Android API 36 Google Play ARM64 image, `pixel_8` profile; FFmpeg 9.0.2 with
libx264.

Device interaction used only the T3 device tools. Before the runs, `device_list`
showed six iOS simulators and Pixel_API_36, all shut down, and an empty Device panel.
Each disposable emulator was opened with `device_open`, Settings was opened and
scrolled with its `agent-device` command, and the panel was closed with
`device_close` before deletion. Pre-existing devices were not opened, booted or
changed. After the runs, `device_list` showed the same baseline and an empty panel.

## Results

| Check | Run 1 (bBb5x3) | Run 3 (RpgYCa) |
| --- | --- | --- |
| Cancel: exactly one recorder during capture, PID matches the runner's identity | Passed | Passed |
| Cancel: session `finished`, `cleaned=1`, reservation back to baseline | Passed | Passed |
| Leave page: the same | Passed | Passed |
| No `screenrecord` left on the guest after either cancellation | Passed | Passed |
| Signals the runner sent | Not recorded | SIGTERM in both cases |
| New full recording verified (ffprobe, clean FFmpeg decode, `cleaned=1`) | Passed | Passed |
| Machine deleted with no uncleaned session and no abandonment | Passed | Passed |
| Reservation 0 after deletion, AVD directory empty, inventory restored | Passed | Passed |

### Run 1 (bBb5x3, 07:22–07:25 CET)

Machine b5465802-06ae-4a49-a6eb-56562bb5099f ran as emulator-5554.

- Cancel at 07:24:07: the guest listed one recorder, PID 5243. The runner had read
  the identity boot `320ac55f-…`, PID 5243, start time 6229. Cleanup reported
  `absent`. Session 89e465bb-… reached `finished` with `cleaned=1` 5.2 s after the
  click. The page showed `Recording cancelled; no file was kept`. The reservation
  was back at 2 CPU, 4096 MiB and 12 GiB, and the guest listed no recorder.
- Leave at 07:24:27: PID 6094 (start time 8242), `absent`. Session 5ec3ccb4-…
  reached `finished` with `cleaned=1` 3.0 s after the page closed. The reservation
  was released and no recorder remained.
- Full recording: `Recording verified · 869 frames · 29.0 s · 576 × 1280 · 7.4 MiB ·
  capture session released`. The 7,772,382-byte MP4 (SHA-256 f3c79f32…fb5e) gave
  ffprobe h264 Constrained Baseline, 869 frames and 28.966667 s.
  `ffmpeg -v error -xerror` exited 0 with empty stderr. Chromium played it
  (readyState 4).
- All three sessions were `finished` with `cleaned=1`. After shutdown the
  deletion completed on the first request, without abandonment. The host then
  reserved 0 CPU, 0 MiB and 0 GiB. The runner's AVD directory is empty and the
  stock `~/.android/avd` inventory matches the baseline.

This build did not yet record whether cleanup had to signal the recorder. `absent`
alone does not show whether the recorder survived the host adb client's close.

### Run 2 (nw8N8K, 07:27–07:29 CET), driver failure

The cancellation stage passed with the new signal record. PID 5579 was still
running when the runner checked it after closing the adb client. The runner sent
SIGTERM to that PID only, and the PID was absent 0.6 s after the click. During the
leave stage the driver's own read-only SQLite poll failed with `database is
locked`. The driver then stopped and deleted the machine. Its two sessions were
both `finished` with `cleaned=1`, no abandonment was needed, the reservation fell
to zero and the inventory was restored. The driver now opens the database with a
5-second busy timeout. This run's leave stage and full recording are not counted.

### Run 3 (RpgYCa, 07:29–07:32 CET)

Machine d8866adf-cbb3-4a15-b1a1-ecda1c336179 ran as emulator-5554.

- Cancel at 07:31:03: PID 5462 (boot `fa65d4db-…`, start time 5782).
  `signalled ["TERM"]`, `absent`, `cleaned=1` 1.1 s after the click. The reservation
  was at baseline and no recorder remained.
- Leave at 07:31:19: PID 6275 (start time 7288). `signalled ["TERM"]`, `absent`,
  `cleaned=1` 0.5 s after the page closed. The reservation was released and no
  recorder remained.
- Full recording: `Recording verified · 894 frames · 29.8 s · 576 × 1280 ·
  14.3 MiB · capture session released`. The 15,012,653-byte MP4 (SHA-256
  0bf57fb9…1da2) gave ffprobe 894 frames and 29.800000 s, and the FFmpeg decode
  was clean.
- All three sessions were `finished` with `cleaned=1`. Deletion completed without
  abandonment, the reservation fell to zero, the AVD directory is empty and the
  inventory matches the baseline.

## Findings

- Closing the host `adb shell` client does not stop the guest recorder. In all
  three signal-recording cancellations (runs 2 and 3), the exact PID was still
  running when the runner checked it after its adb client had exited, and SIGTERM
  was needed. This confirms why the earlier runner could not report cleanup.
- screenrecord exited on SIGTERM within the 3-second grace each time; SIGKILL was
  not needed.
- The identity line before the H.264 stream did not affect encoding: both full
  recordings decoded cleanly.

## Open

- The unreachable-device, foreign-AVD, lost-assignment and SIGKILL escalation paths
  are fixture-covered only (unit tests, and a Linux `/proc` test against a real
  process). None was provoked natively.
- Unknown cleanup is not retried. A device unreachable during cleanup, or a machine
  stopped before cleanup ran, still needs administrator abandonment.
- iOS recording: unchanged, see the [capture trial](dashboard-mobile-capture.md).
- Whether the page's unload close or the socket close ended the left-page session
  is still not distinguished.
- Requested versus encoded duration on Android; remote hosts, consumer leases,
  unattended recording, and decoding outside Chromium and FFmpeg.

Private trial state remains under the user temporary directory as
`dashboard-android-capture-*`. It is not committed.
