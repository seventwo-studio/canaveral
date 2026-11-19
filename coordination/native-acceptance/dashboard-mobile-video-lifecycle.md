# Dashboard mobile video lifecycle trial, 19 November 2026

Follow-up to the [dashboard mobile capture trial](dashboard-mobile-capture.md). It
checks the two lifecycle fixes on the Mac Studio homelab: captures longer than
30 seconds, and machine deletion while a video session lacks positive cleanup.
Android only; iOS recording stays out of scope because idb's stop still exits 1, as
recorded in the capture trial.

Driver: `CANAVERAL_TRIAL_SECONDS=60|180 node dashboard-mobile-capture.mjs android`,
run from this PR's branch. Coordination, the Rust mobile helper
(`prepare_native.mjs debug`) and the dashboard assets were built from that tree.
As before, each run started a disposable loopback controller, enrolled one native
HostRunner (`videoEncoder` `/opt/homebrew/bin/ffmpeg`), created one disposable
Android device as an invited ordinary account, and drove the real dashboard gateway
and assets in Playwright Chromium. After a recording the driver leaves the page
mid-recording, which leaves an uncleaned session. It then stops the machine,
requests deletion, tries abandonment as the owner and as the administrator, and
deletes the machine.

Tools: Android API 36 Google Play ARM64 image, `pixel_8` profile; FFmpeg 9.0.2 with
libx264.

Device interaction used only the T3 device tools. Before the runs, `device_list`
showed six iOS simulators and Pixel_API_36, all shut down, and an empty Device panel.
The disposable emulator was opened with `device_open`. Settings was opened and
scrolled with its `agent-device` command (`swipe … --pattern ping-pong`). The panel
was closed with `device_close` before deletion. Pre-existing devices were not
opened, booted or changed. After both runs `device_list` showed the same baseline.

## Results

| Check | 60 s run | 180 s run |
| --- | --- | --- |
| Screenshot through the dashboard, downloaded | Passed | Passed |
| Recording past 30 s verified in the page and downloaded | Passed | Passed |
| Static screen for longer than 30 s during the recording | 35 s, passed | 3 × 40 s, passed |
| ffprobe frames and duration, clean FFmpeg decode | Passed | Passed |
| Session finished with positive cleanup | Passed | Passed |
| Deletion refused while the left-page session was uncleaned | 409 | 409 |
| Owner abandonment refused, administrator abandonment recorded | 403, recorded | 403, recorded |
| Deletion completed, reservation released, baseline restored | Passed | Passed |

### 60-second run (NShDoV, 03:09–03:13 CET)

Machine 8892e6c8-fed0-4215-8441-2ca792d278a9 ran as emulator-5554 (AVD
cvm-8892e6c8-…).

- Screenshot: `Screenshot 1080 × 2400`; the downloaded PNG is 188,185 bytes.
- Recording, 60 s requested. Settings was scrolled from 03:10:33 to 03:10:42, left
  static until 03:11:17 and scrolled again until 03:11:26. The page showed
  `Recording verified · 1633 frames · 54.4 s · 576 × 1280 · 16.8 MiB · capture
  session released`. Chromium played the preview (readyState 4, duration 54.433333,
  no media error).
- The MP4 is 17,645,233 bytes, SHA-256 5278451a…181d. ffprobe `-count_frames`
  reported h264 Constrained Baseline, 576 × 1280, 30/1, 1633 frames and 54.433333 s.
  `ffmpeg -v error -xerror -i FILE -f null -` exited 0 with empty stderr.
- Session 8eca5955-… reached `finished` with `cleaned=1`.
- Leaving the page: session 094233a5-… became `disconnected` with `cleaned=0`. The
  runner again reported `Android capture connection closed without positive guest
  completion`, and the host kept its extra 1 CPU and 256 MiB.
- After shutdown the owner's deletion returned HTTP 409. The owner's
  `video-sessions/{id}/abandon` returned 403. The administrator's abandonment
  returned the session with `cleaned:false` and `resolution` `abandoned`, its reason
  and `decidedBy` `{kind:"session", username:"admin"}`. The host still reserved
  1 CPU and 256 MiB after abandonment.
- The same deletion UUID then completed. The host reserved 0 CPU, 0 MiB and 0 GiB.
  The runner's AVD directory is empty, and the stock `~/.android/avd` listing,
  `.ini` digests, inode and `config.ini` digest match the baseline.

### 180-second run (aniI2Q, 03:13–03:19 CET)

Machine c5943df9-fb6b-4217-b28a-40b3575f9307 ran as emulator-5554 (AVD
cvm-c5943df9-…).

- Screenshot: `Screenshot 1080 × 2400`; 186,610 bytes.
- Recording, 180 s requested, the backend maximum. Settings was scrolled for about
  10 s at 03:14:56, 03:15:47, 03:16:34 and 03:17:21, and left static for 40 s
  between them. The page showed `Recording verified · 4589 frames · 153.0 s ·
  576 × 1280 · 39.4 MiB · capture session released`. Chromium reported duration
  152.966667.
- The MP4 is 41,298,509 bytes, SHA-256 992bc8c7…5052. ffprobe reported 4589 frames
  and 152.966667 s; the FFmpeg decode was clean.
- Session 84e585f7-… reached `finished` with `cleaned=1`.
- Leaving the page left session fefb4edf-… `disconnected` with `cleaned=0`. Deletion
  returned 409, owner abandonment 403, and administrator abandonment was recorded.
  The reservation stayed at 1 CPU and 256 MiB until the deletion completed, then
  fell to zero. Deletion was confirmed and the inventory restored.

### Re-run after the review fixes (Pjf3ib, 03:28–03:32 CET)

The broker then changed so that any received frame counts as liveness, and so that
it refuses a video acknowledgement before the host's `finish`. The 60-second run was
repeated on that head (commit 1d13bcc) with machine dcfb9378-ebaa-4fb2-ac1f-a0ad476ddda9.
Settings was scrolled from 03:29:19 to 03:29:28, left static until 03:30:04 and
scrolled until 03:30:12. The page showed `Recording verified · 1717 frames · 57.2 s ·
576 × 1280 · 15.8 MiB · capture session released`. ffprobe reported 1717 frames and
57.233333 s, and the FFmpeg decode was clean. Session 85707038-… finished with
`cleaned=1`. The left-page session 4744ec51-… again gave deletion 409, owner
abandonment 403 and a recorded administrator abandonment, with 1 CPU and 256 MiB
held until the deletion completed and zero afterwards. Deletion was confirmed, the
runner's AVD directory is empty and the inventory was restored.

The encoded duration again follows emitted frames: the static tail after the last
scroll is not represented (54.4 s of 60 s, 153.0 s of 180 s). Static stretches
inside the recording are present in the timeline.

## Open

- ~~Android positive cleanup after early cancellation~~: fixed and natively verified
  on 19 November 2026 in the [recording cleanup trial](dashboard-android-recording-cleanup.md).
- iOS recording: unchanged, see the capture trial.
- Whether the page's unload close or the socket close ended the left-page session is
  still not distinguished; the Playwright context again observed no close request.
- Requested versus encoded duration on Android; remote hosts, consumer leases,
  unattended recording, and decoding outside Chromium and FFmpeg.

Private trial state remains under the user temporary directory as
`dashboard-android-capture-*`. It is not committed.
