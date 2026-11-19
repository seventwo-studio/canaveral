# Android emulator lease trials: two agents, one emulator, 2026-11-19

The project's original acceptance case: two agents, one Mac host with capacity for exactly one emulator. Agent A leases the emulator, installs a real APK and drives it. Agent B's request waits. A disconnects and its lease expires. A's credential stops working, cleanup is proven and B receives a clean, usable emulator.

Driver: [android-lease-agents.mjs](android-lease-agents.mjs). The run used the `feat/android-emulator-leases` working tree on top of main 5b758f4, before its first commit, with the debug `canaveral-mobile-native` build installed by `script/prepare_native.mjs debug`. It ran 12:36–12:42 UTC on the Mac Studio (14 CPUs, 36 GiB RAM, about 109 GiB free disk).

## Setup

- The driver started an ephemeral loopback controller and an in-process Android `HostRunner` in a private temporary directory. The runner had `leaseClockHelper` and `leaseSupervisor` set to the built helper, `leaseProtocol: 1` and one Android lease image.
- The host capacity was exactly the template minimum: 2 CPUs, 4096 MiB and 12 GiB. That is one emulator.
- The template was `system-images;android-36;google_apis_playstore;arm64-v8a` with the `pixel_8` profile. Its AVDs were created in the runner's private `ANDROID_AVD_HOME`.
- There were two applications (`agent-a`, `agent-b`). Each submitted one `kind: "lease"` request through `/v1/requests` and replayed it once with the same UUID; both replays returned 200.
- The APK came from [dashboard-android-app.sh](dashboard-android-app.sh). It was 8,589 bytes, package `test.canaveral.dashboardtrial`, SHA-256 `fb70d17c…6ee0`, signed with a single-use key.
- Baseline from the T3 device tools: the only Android device was `Pixel_API_36`, shut down. `~/.android/avd` held only `Pixel_API_36.avd` and `Pixel_API_36.ini`.

## Result

| Step | Time (UTC) | Outcome |
| --- | --- | --- |
| A admitted | 12:36:54.5 | Lease `3b666184…92ab`, machine `92a11b70…3f2c`, TTL 240 s |
| A ready | 12:37:30.4 | `state: ready`, member `running`, `ready: true` only after boot completion, package manager and AVD ownership checks. The emulator ran under its supervisor (emulator PID 22336, supervisor PID 22335). |
| A drives the device with its lease key | 12:37:51.6 | `push` of the APK to `/data/local/tmp`, `shell pm install -r` returned `Success`, `launch` of `.TrialActivity` succeeded, `hierarchy` contained "Canaveral dashboard install trial", and `screenshot`, `tap` and `logs` succeeded. |
| B waits | 12:37:56.6 | B's request was `waiting`; the host had 2 CPUs, 4096 MiB and 12 GiB reserved |
| Observation | 12:38 | T3 `device_list` showed `emulator-5554` named `cvm-92a11b70…`. `device_screenshot` showed the "Trial" app with its label. The panel was closed without shutdown. |
| A disconnects | 12:38:17.4 | No renewal, release or further calls; `expiresAt` 12:40:54.398 |
| Native stop | ≤ 12:40:56.6 | `lease-stopped.json` had reason `expired`, `groupAbsent: true` and exit status 0. The emulator PID was gone, and `pgrep -f cvm-92a11b70…` found nothing. |
| A's key refused | 12:40:56.6 | `tap` 410 `lease_ended`, `screenshot` 410 `lease_ended` |
| A cleanup proven | 12:40:58.8 | Lease cleanup `complete` (attempt 2). Private storage and the AVD registration were removed; no processes remained. |
| B admitted | 12:40:58.8 | Lease `45e7a84e…46d4` on new machine `595824ae…3882` |
| B ready | 12:41:35.6 | The trial package was absent from `apps`; `screenshot` and `tap` succeeded; A's key on B's lease returned 401 |
| Observation | 12:41 | T3 `device_screenshot` of `cvm-595824ae…` showed a fresh home screen. The panel was closed without shutdown. |
| B released | 12:42:06.5 | Cleanup `complete`; host reservation 0 CPU, 0 MiB, 0 GiB |

The driver first saw the supervisor's stop receipt about 2 seconds after the controller's expiry time. Both cleanups completed on their second attempt; the reason for the first attempt's outcome was not captured. Both runner lease-guard records ended `fenced` and `retired`. The runner's `machines` directory held only its lock and cleanup-receipt directories, so both assignments' credential directories had been erased.

## Baseline restored

After the runner and controller closed, `~/.android/avd`, `Pixel_API_36.ini`, the `Pixel_API_36.avd` inode and its `config.ini` SHA-256 matched the baseline. T3 `device_list` again showed only `Pixel_API_36` (shut down) for Android. No `lease-supervise` or `cvm-` processes remained. The private trial directory, the APK build directory and the copied trial log were deleted.

The driver's leftover-process check matched one PID: the operator's monitoring shell, whose command line contained the trial path. That PID was gone when inspected, and nothing referenced the trial directory, so the driver kept the directory and it was deleted by hand. The driver now looks only for supervisors (by private storage path) and `-avd cvm-` emulators.

No pre-existing device was started, stopped or inspected beyond the T3 device list. Both leased emulators were driven only through Canaveral lease operations. T3's `device_open` was used only to take screenshots.

## Run 2: review fixes (isolation, supervisor loss, leftover helpers)

The second run used the review-fix working tree on top of `4f32311`, with the rebuilt debug `canaveral-mobile-native` installed by `script/prepare_native.mjs debug`. It ran 13:41–13:47 UTC on the same Mac Studio, with the same setup, template, capacity and applications. The APK was rebuilt by [dashboard-android-app.sh](dashboard-android-app.sh): 8,589 bytes, SHA-256 `b68d9b6f…b39d`, with a fresh single-use key. The driver added three checks:

- a negative guest-to-host probe from agent A's own lease shell;
- killing agent B's supervisor mid-lease, in place of B's release;
- leftover-helper checks for `netsimd`, `crashpad_handler` and `qemu-system` before, during and after the trial.

Before the trial, a separate check on a disposable AVD (`canaveral-isoprobe`, private `ANDROID_AVD_HOME` and adb server port, deleted afterwards) showed the vulnerability with stock flags. From inside the guest, `nc 10.0.2.2` connected to the operator's adb server on 5037, the T3 server, the emulator's own console and adb ports and a host canary listener. The internet was also reachable. `crashpad_handler` ran with parent PID 1 in its own process group, outside the emulator's group. `netsimd` ran as a child of the emulator. See [Guest network isolation](../../docs/mobile-control.md#guest-network-isolation) for the flag-by-flag results.

| Step | Time (UTC) | Outcome |
| --- | --- | --- |
| Baseline helpers | 13:41:22.4 | No `netsimd`, `crashpad_handler` or `qemu-system` process |
| A admitted | 13:41:23.6 | Lease `775be664…`, machine `343e3902…`, TTL 240 s |
| A ready | 13:41:55.1 | Ready only after boot, package manager, AVD ownership and the readiness isolation probe. `lease-isolation.json` recorded `isolated: true` for ports 5037, 5554, 5555, the controller's 53442 and the canary. Emulator PID 52022, supervisor PID 52021. |
| Guest-to-host probe from A's lease shell | 13:42:18.8 | `shell` `sh -c 'nc 10.0.2.2 <port>'` for 5037, the controller port 53442, console 5554 and adb 5555: every port answered `rc=1 nc: connect: Connection refused`. The emulator argv carried `-feature -WiFiPacketStream -feature -BluetoothEmulation -feature -Uwb -network-user-mode-options restrict=on,ipv6=off -wifi-user-mode-options restrict=on,ipv6=off -crash-report-mode disabled -no-metrics`. During the lease, the only helper process was `qemu-system` PID 52022: no `netsimd` and no `crashpad_handler`. |
| A drives the device | 13:42:18.8 | `push`, `pm install -r` (`Success`), `launch`, `hierarchy` with the trial label, `screenshot`, `tap` and `logs` all succeeded without guest networking |
| B waits | 13:42:23.8 | B's request `waiting`; 2 CPUs, 4096 MiB and 12 GiB reserved |
| Observation | 13:42 | T3 `device_list` showed `emulator-5554` named `cvm-343e3902…`. `device_screenshot` showed the trial app with its label. The panel was closed without shutdown. |
| Native stop at expiry | ≤ 13:45:25.5 | `lease-stopped.json` reason `expired`, `groupAbsent: true`, exit status 0; emulator gone |
| A's key refused | 13:45:25.5 | `tap` and `screenshot` 410 `lease_ended` |
| A cleanup proven | 13:45:27.7 | Cleanup `complete` (attempt 2); storage and AVD registration removed |
| B ready | 13:45:59.1 | Lease `e01e3ff1…` on machine `6fbceec9…`; trial package absent; A's key 401 on B |
| Observation | 13:46 | T3 `device_screenshot` of `cvm-6fbceec9…` showed a fresh home screen. The panel was closed without shutdown. |
| B's supervisor killed (SIGKILL) | ≤ 13:46:25.4 (after the B observation) | A `tap` sent right after the kill was accepted by the controller but `failed` on the host: the provider refused the device with 410. The lease was `failed` 261 ms after the kill was observed, well before its 240 s TTL. A later `screenshot` returned 410 `lease_ended`. |
| B held | 13:46:30.4 | Five seconds after the failure: cleanup `blocked` with reason `execution_pending`, host reservation still 2 CPUs, 4096 MiB and 12 GiB, the orphaned emulator still alive and `lease-authorization.json` fenced |
| Operator recovery | 13:46:30.4 | The driver confirmed the orphan's argv contained `-avd cvm-6fbceec9…`, then stopped its process group |
| B cleanup proven | 13:46:31.7 | Cleanup `complete` (attempt 3); storage removed; reservation 0 CPU, 0 MiB, 0 GiB |
| Leftover helpers | 13:46:31.8 | No new `netsimd`, `crashpad_handler` or `qemu-system` process; no supervisor or `cvm-` emulator |

Baseline restored: `~/.android/avd`, `Pixel_API_36.ini`, the `Pixel_API_36.avd` inode and its `config.ini` SHA-256 matched the baseline. T3 `device_list` again showed only `Pixel_API_36` (shut down) for Android. The private trial directory, the APK build directory and the copied trial log were deleted.

The run exposed a bug in the driver's leftover check that predates the review fixes: `pgrep -f "-avd cvm-"` parsed the pattern as options, printed its usage and matched nothing. The new `qemu-system` check covered the emulators in this run, and the driver now passes `--` before the pattern. The first run's leftover result for `-avd cvm-` emulators therefore rested only on its supervisor-path check and its manual inspection.

## Not verified by these trials

- Host loss and controller loss on real hardware. The portable suite covers both with the real supervisor binary and stand-in emulator processes; natively, only the deadline expiry path ran.
- Renewal, runner restart mid-lease and lost-reply recovery against a real emulator. Fixture only.
- Lease file sessions, PTY and live display sessions. Not exercised; see [mobile control](../../docs/mobile-control.md#android-emulator-leases). Lease-key MP4 recording and large installs ran in the later [capture trial](android-lease-capture.md).
- A supervisor that fails during launch, and a runner crash between the launch intent and the supervisor record (automatic recovery). Fixture only.
- Guest isolation on Linux hosts and on emulator versions other than 37.2.13. The readiness probe fails closed there, but no native run exists.
- iOS simulators, physical devices, remote hosts, concurrent emulators on one host, and the release build of the helper.
