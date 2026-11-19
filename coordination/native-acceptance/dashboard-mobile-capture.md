# Dashboard mobile capture trial, 19 November 2026

Driver: `dashboard-mobile-capture.mjs ios|android`, run on the Mac Studio homelab from this PR's branch. The gateway relay and dashboard capture code were unchanged across the runs. The 20-second Android run used the final 5–20 second length list. Coordination, the Rust mobile helper and the dashboard assets were built from that tree. Each run started a disposable loopback controller, enrolled one native HostRunner (`videoEncoder` set to `/opt/homebrew/bin/ffmpeg`), created one disposable device as an invited ordinary account, and drove the real dashboard gateway and assets in Playwright Chromium 1.64.1. The driver traces native pipe failures and prints runner log messages; it prints no credentials.

Tools: Xcode 27.2, iPhone 18 Pro on iOS 27.2; Android API 36 Google Play ARM64 image, `pixel_8` profile; FFmpeg 9.0.2 with libx264; idb-cli 1.7.8 with idb-companion under Homebrew Python 3.14.10.

Device interaction used only the T3 device tools. The disposable device was found with `device_list`, opened with `device_open`, and Settings was driven with its `agent-device` command during each recording. Simulators and emulators that existed before the trial were not opened, booted or changed. After every run, `device_list` showed the six stock iOS simulators and Pixel_API_36, all shut down, and the Device panel was empty.

## Results

| Check | iOS | Android |
| --- | --- | --- |
| Named screenshot through the dashboard, downloaded | Passed | Passed |
| Recording verified in the page, previewed and downloaded | **Failed** (shown as a failure) | Passed |
| ffprobe frames and duration, full FFmpeg decode | Not reached | Passed |
| Session finished with positive cleanup after success | Not reached | Passed |
| Leaving the page mid-recording closes the session | Not reached | Closed; cleanup not reported |
| Device deletion confirmed, baseline inventory restored | Passed | Passed |

### Android (run 1fP0xf, 02:09–02:12 CET)

Machine 8486f67c-006c-4579-992f-dd475710c980 ran as emulator-5554 (AVD cvm-8486f67c-…) in the runner's private AVD home.

- Screenshot: the page showed `Screenshot 1080 × 2400`. Its download link saved `android-trial-screenshot.png`: a valid PNG, 186,780 bytes.
- Recording, 15 s requested: the page showed `Recording verified · 288 frames · 9.6 s · 576 × 1280 · 3.2 MiB · capture session released`. Chromium played the preview (readyState 4, duration 9.6, 576 × 1280, no media error).
- The downloaded MP4 is 3,328,386 bytes, SHA-256 69bd8c5d…0b21. ffprobe `-count_frames` reported h264 Constrained Baseline, 576 × 1280, 288 frames and 9.600000 s. `ffmpeg -v error -xerror -i FILE -f null -` exited 0 with empty stderr.
- Session be3da16a-… reached `finished` with `cleaned=1`. The host reservation returned to the machine's own 2 CPU, 4096 MiB and 12 GiB.
- Leaving the page: a second 15 s recording was started and the page closed after attachment. Session 30fe58b8-… became `disconnected` within 30 s. The runner did not report cleanup within 60 s: `Android capture connection closed without positive guest completion; inspect the bounded recorder before reopening`. The host kept the session's extra 1 CPU and 256 MiB. This is the existing documented Android early-cancellation limit; see [mobile control](../../docs/mobile-control.md#native-video-sessions). The Playwright context did not observe the page's unload `close` request, so whether the keepalive POST or the socket close ended the session is not distinguished.
- Deletion 01323889-… is complete. The runner's AVD directory is empty, and the stock `~/.android/avd` listing, `.ini` digests, inode and `config.ini` digest match the baseline.

A 20-second run (2m0Jv5, 02:18–02:21 CET, machine 14391bbc-…) scrolled Settings throughout. The page showed `Recording verified · 595 frames · 19.8 s · 576 × 1280 · 6.1 MiB · capture session released`. ffprobe reported 595 frames and 19.833333 s, Chromium reported duration 19.833333, and the FFmpeg decode was clean. The session finished with `cleaned=1`, leaving the page gave the same result as above, deletion was confirmed and the inventory restored.

An earlier run (AmPAnu, 02:02–02:06 CET, machine b67ba58a-…) gave the same results. It produced a 4,819,477-byte recording with 564 frames over 18.8 s; ffprobe agreed and decoding was clean. That driver version asserted cleanup after leaving the page and stopped there. Its teardown still confirmed deletion and inventory restoration.

The encoded duration differs from the requested length: 9.6 s and 18.8 s for 15 s requests. screenrecord emits frames only when the screen changes, and the encoder timestamps on host arrival. The MP4 therefore spans the first to the last emitted frame. A static tail is not represented, and startup delay can lengthen the result. Duration is reported, not enforced.

### iOS (run pvdN3s, 02:07–02:09 CET)

Machine e15c6bfc-9a1a-4c75-a7fd-4513d221a3a4 ran as disposable simulator 15030b9e-f55b-49ac-91b5-a35a3db2b0f7 (cvm-e15c6bfc-…).

- Screenshot: the page showed `Screenshot 1206 × 2622`. The downloaded PNG is 332,406 bytes and shows the simulator's Settings screen.
- Recording, 15 s requested: failed. The page showed `Native video capture did not complete. The recording is incomplete. Session 2871ab98-… was closed.` and offered no MP4 link. The session is `disconnected` with `cleaned=0`. The host kept the extra 1 CPU and 256 MiB, and the runner journal is `unknown`, `cleaned:false`.
- Cause, from the driver's native trace: at the duration limit, the provider interrupts `idb video-stream` with SIGINT and requires exit 0. idb exited 1 (`Native capture did not acknowledge graceful termination`), so the provider reported `Native iOS video did not stop cleanly`. FFmpeg then exited 255 and the capture became unknown.
- idb's exit status was reproduced without a device. Under the installed Python 3.14.10, idb-cli 1.7.8's own `signal_handler_generator` and `drain_coroutines` exit 1 after a SIGINT stop. `drain_coroutines` gathers the cancelled consumer task, and the resulting `asyncio.CancelledError` is not caught by its `concurrent.futures.CancelledError` handler. This shows an upstream idb and Python incompatibility on this host. The real run's stderr was not captured, so the identity of the two failures is inferred.
- Deletion is complete, and the simctl inventory matched its 14-entry baseline.

Two earlier iOS runs (c2vPTO at 01:53–01:57 and mPyB0T at 01:57–02:01 CET) gave the same screenshot and recording failure. The first is where the cause was traced. In both, deletion was confirmed and inventory restored. One of those screenshots, taken on the home screen, was 3,389,547 bytes, close to the 4 MiB device-output limit.

### Session liveness, found during the trial

Fixed after this trial; see the [video lifecycle trial](dashboard-mobile-video-lifecycle.md), which recorded 60- and 180-second clips. The observation below is kept as found.

The offered lengths were reduced from 5–60 to 5–20 seconds. The controller broker pings each session peer every 10 seconds and closes a peer after 30 seconds without a pong. The runner's session client answers pings only while it reads a message. Native capture reads `ready` first and the consumer's `ack` last, and nothing between them. A portable experiment on the built tree attached an idle host client with heartbeats. Its session ended 30 seconds after attachment, whether the consumer attached through the dashboard relay or directly to the controller. The gateway is therefore not the cause. Longer captures need the runner to keep answering pings during capture.

### Controller observation

Fixed after this trial: deletion is now refused until positive cleanup or an administrator abandonment; see the [video lifecycle trial](dashboard-mobile-video-lifecycle.md). The observation below is kept as found.

The controller confirmed deletion of each machine while its uncleaned video session remained. Those sessions keep 1 CPU and 256 MiB reserved on the disposable host. This follows the existing rule that unknown native cleanup retains its reservation. Machine deletion does not wait for video cleanup.

## Open

- iOS recording: idb's stop exits 1 under Python 3.14, so no iOS MP4 has been produced. The options are an idb runtime that exits 0 after SIGINT, an upstream fix, or a reviewed provider change to its stop proof. Each is a separate decision. This trial does not change the provider.
- ~~Android: positive cleanup after early cancellation~~: fixed for Cancel and leaving the page and natively verified on 19 November 2026 in the [recording cleanup trial](dashboard-android-recording-cleanup.md). Failure paths share the same cleanup but were not provoked natively.
- Leaving the page natively: which of the unload keepalive close or the socket close ended the session.
- ~~Session liveness during capture~~: fixed and natively verified on 19 November 2026 in the [video lifecycle trial](dashboard-mobile-video-lifecycle.md).
- Recorded duration versus requested duration on Android; iOS pacing is unmeasured.
- Screenshots of larger displays may exceed the 4 MiB device-output limit.
- Remote hosts, consumer leases, unattended recording, and decoding outside Chromium and FFmpeg.

Private trial state remains under the user temporary directory as `dashboard-{ios,android}-capture-*`. It is not committed.
