# Android and iOS devices

Mobile devices use the existing machine inventory, immutable templates, placement,
resource ledger and start/stop lifecycle. Use `provider: android` for Android SDK
emulators and `provider: ios` for Xcode simulators. Templates use `mode: device`
and `os: android` or `ios`. The optional dashboard can create, start and stop them;
UI, app and file control uses the CLI/API. Locally attached displays also use the
[shared streaming workspace](guest-access.md#shared-display-and-control-contract),
with the same viewer and control lifecycle as VMs.

Device providers are native host processes. The central controller needs no mobile
SDK, direct adb connection, macOS privileges or inbound route to the device host.
Separate runners can offer VM and mobile capacity on the same physical host; divide
their host limits so their combined reservations fit that host. Persist both
agent state and device storage, under one operating-system account, across restarts.
Never share a state directory between runners.

## Host prerequisites

For Android on Linux or macOS, install the Android SDK platform-tools, emulator,
command-line tools (`cmdline-tools/latest/bin/avdmanager`), Java and the exact system
image in the template. Accept SDK licences through the owner's normal setup.
Enable host acceleration (KVM on Linux, supported Apple hardware on macOS).
The adapter uses the SDK's classic `avdmanager` and `emulator` interfaces; newer
Android CLI interfaces are not used. These interfaces are documented but deprecated
upstream, so retain compatible installed SDK tools for this adapter.

Copy [host-android.json](../examples/host-android.json), set absolute SDK/storage
paths and choose a profile installed in that SDK. The example image is ARM64;
on AMD64 set `arch: amd64` and use an `x86_64` system image. Runtime installation
and downloads happen before enrollment, rather than during device reconciliation.
The host checks that the required tools and offered system-image directories exist.

For iOS, use a native Mac with full Xcode, its selected developer directory and
installed simulator runtime/device type. Install `idb` and `idb_companion`; the
companion must be on the agent's PATH. Configure the idb executable in
[host-ios.json](../examples/host-ios.json), or omit `idb` to resolve it on PATH.
Run the agent as the account that owns these simulators, with access to CoreSimulator.
An iOS simulator build (`.app`) is required; an iPhone device build is incompatible.
The runtime and device type in [ios-phone.json](../examples/templates/ios-phone.json)
are examples to replace with identifiers available in the installed Xcode.

Each Android assignment creates an independent AVD under configured storage with a
private `ANDROID_AVD_HOME`. It receives explicit CPU, RAM and data-partition sizes.
It launches without a window, audio or snapshots and retains app data across stops.
Each iOS assignment creates its own simulator in the account's standard device set,
with a saved UDID and unique assignment name. All subsequent commands target that
UDID. Existing personal/project devices are neither imported nor adopted.

iOS CPU, memory and disk values are scheduling reservations. CoreSimulator manages
actual resources; Canaveral cannot impose VM-style CPU/RAM/disk limits on it. Allow
headroom for Xcode services and runtimes. Android memory/cores/data size also exclude
SDK binaries, system images and emulator overhead. Shared runtimes are owner-managed.

Enroll a runner using the normal credential flow:

```sh
python3 -m canaveral --url https://canaveral.example.internal host \
  --config /private/canaveral/host-ios.json \
  --state /private/canaveral/ios-agent \
  --enrollment-token-file /private/canaveral/enrollment.token
```

Provision with a stable caller UUID, then wait until `machines` reports ready:

```sh
python3 -m canaveral --token-file ./secrets/admin.token create test-phone \
  --template ios-phone --request-id 307cd365-a75d-43a8-aefb-1f23b22b8aa2
```

Use `android-phone` for the Android example. Mobile templates pin their public
`device` definition (system image/profile or iOS runtime/device type), so changing
either requires a new revision. Mobile templates do not accept VM image sources or
cloud-init/SSH preparation. Ready means the OS has finished booting; it does not
mean an application has been installed or passed its tests.

## Device control

Operations are authenticated administrator actions. Submit one operation with a
stable request UUID; read its receipt to obtain `queued`, `succeeded`, `failed` or
`unknown`. Submission is asynchronous, with normal five-second host polling latency.
This interface provides screenshots and discrete input, rather than a video stream.

```sh
python3 -m canaveral --token-file ./secrets/admin.token device \
  307cd365-a75d-43a8-aefb-1f23b22b8aa2 screenshot \
  --request-id dc2934dd-dbab-494f-a709-8b97b5754717

python3 -m canaveral --token-file ./secrets/admin.token operation \
  dc2934dd-dbab-494f-a709-8b97b5754717 --output ./screen.png
```

For actions with arguments, supply a JSON object using `--arguments-file path.json`
(or `-` for stdin). Keep text and app/file contents out of command-line arguments.

| Action | Arguments | Platform behavior |
| --- | --- | --- |
| `screenshot` | none | PNG data |
| `hierarchy` | none | Android UI XML or iOS accessibility JSON |
| `tap` | `x`, `y` | Android pixels; iOS points |
| `swipe` | `x`, `y`, `toX`, `toY`, `durationMs` | One gesture, 1–10000 ms |
| `text` | `text` | Android single-line ASCII via input; iOS keyboard text via idb |
| `key` | `key` | Android key name/code; iOS HID code or button name such as `HOME` |
| `rotate` | `orientation` | `PORTRAIT`, `PORTRAIT_UPSIDE_DOWN`, `LANDSCAPE_LEFT`, `LANDSCAPE_RIGHT` |
| `apps` | none | Installed app inventory |
| `install` | `artifact` | Host-configured artifact ID, for an APK or simulator `.app` |
| `launch` | `app` | Android `package/activity`; iOS bundle ID |
| `terminate`, `uninstall` | `app` | Package/bundle ID |
| `open-url` | `url` | Open URL/deep link on this device |
| `permission` | `app`, `permission`, `state` | Android runtime permission or iOS privacy service; `grant`/`revoke`, plus iOS `reset` |
| `location` | `latitude`, `longitude` | Set simulated coordinates |
| `logs` | none | Android last 200 logcat lines or iOS last minute |
| `push` | `path`, `data`, optional `app` | Write one file from base64 data; at most 512 KiB |
| `pull` | `path`, optional `app` | Read one file as base64; at most 4 MiB |
| `shell` | `argv` | Android guest command with literal arguments; unavailable on iOS |
| `accessibility` | none | Normalized native tree, properties, bounds and screen capture |
| `accessibility-action` | `snapshotId`, `nodeId`, `nativeAction` | Revalidate a recent native target before input |
| `list-files` | `path`, optional `app` | Up to 2,000 directory entries; Android absolute guest paths or iOS app-container paths (`.` for root) |
| `shell-open` | `session` UUID | Android persistent PTY; up to eight per device |
| `shell-read` | `session`, `offset` | Base64 bytes, next byte offset, truncation and exit state |
| `shell-write` | `session`, `text` | Send input to that Android shell |
| `shell-resize` | `session`, `rows`, `cols` | Resize the PTY, dimensions 1–500 |
| `shell-close` | `session` | Close that owned connection |

The [local dashboard](dashboard.md#local-create-and-control) exposes these actions
through its authenticated same-origin gateway. Shells are volatile and remain
scoped to the machine and runner process. Started action receipts still prevent
replay after a crash; opening an old session UUID does not restore a lost process.

Example tap arguments: `{"x": 180, "y": 300}`. Example installation arguments:
`{"artifact": "development"}`. Artifact IDs resolve only through the private host
`artifacts` mapping. Stage app builds on the host through the normal build/file
delivery process; control requests cannot name arbitrary host files or SDK targets.
Android file paths are absolute guest paths, subject to adb's guest permissions.
iOS requires `app` and a path relative to its data container; traversal and symlink
escapes are rejected. Push overwrites one file and requires its parent to exist.
These are small-file operations; large app bundles use the host artifact mapping.

`operation --output` saves binary data to a new file and refuses to overwrite an
existing file. Otherwise the API/CLI returns base64 in `result.data` with a
`mediaType`. Command output is bounded to 4 MiB; encoded results are at most 6 MiB.
If JSON escaping exceeds that envelope, a small `unknown` receipt preserves
heartbeat delivery without replaying the action.
Receipts, screenshots and file contents persist in the private controller database
and host operation receipts; protect their backups like device data.

## Delivery and recovery

`POST /v1/machines/{id}/operations` accepts `id`, `action`, and `arguments`.
`GET /v1/operations/{id}` returns the receipt. Both use the existing administrator
token or account-session boundary. Enrollment, guest and host credentials cannot
submit/read operations. Host heartbeats deliver one queued action and acknowledge
one result at a time, preserving FIFO on each host and bounding heartbeat bodies.
Only the assigned host can report a result. Heartbeat request bodies permit 8 MiB;
ordinary POST bodies retain the 1 MiB limit.

New actions require a running device and a fresh host. Each host queue permits up
to 32 pending actions. An action expires 120 seconds after submission and fails if
not started by then, or if the device is stopped. Keep host/controller clocks
synchronized. A stop cannot undo an already started action. During disconnection,
no new action begins after the host's normal contact lease expires.

Before executing, the runner saves a fingerprint and started receipt. Repeated
delivery returns the saved result. A crash, timeout or uncertain command failure
reports `unknown` and never silently replays that UUID. Inspect device state before
submitting a new operation ID. The first controller receipt is durable; a later
stale result cannot replace it. No automatic retry claims exactly-once effects.

Device creation also preserves uncertain outcomes. For Android, inspect the owned
`launch.json`, `endpoint.json`, private AVD and `emulator.log`; an unresolved launch
is not spawned again. Confirm the recorded emulator/process is gone before manually
clearing a launch/endpoint receipt. A stopped device releases compute only after
an acknowledged shutdown, disappearance from adb and exit of the recorded emulator
process; disks remain reserved. An adb outage or failed shutdown alone cannot
release reservations. Stop/start retains the same AVD.
For iOS, a lost create response leaves `create-started.json`; verify the exact
assignment's device before restoring its `simulator.json` UDID receipt. Never point
a receipt at a personal or different assignment's device. Unknown/missing/replaced
resources require inspection rather than automatic adoption. Deletion, snapshots
and migration remain outside the existing machine lifecycle.

The portable tests exercise real HTTP delivery, credential separation, large
screenshot receipts, crash/timeout replay protection and fixture SDK ownership/
provisioning. Live provision, boot, input, app/file transfer, stop/restart and agent
reconnect acceptance is still required on each configured Android and iOS host.

Upstream contracts: [Android emulator options](https://developer.android.com/studio/run/emulator-commandline),
[AVD creation](https://developer.android.com/tools/avdmanager),
[idb target and app commands](https://fbidb.io/idb/commands/) and
[idb UI automation](https://fbidb.io/idb/ui/).

## Android process resource accounting

New launches publish version 2 boot/assignment receipts and, when positively
available, the child process birth time. Read-only
[resource attribution](android-runtime-ownership.md) uses this evidence after a
runner restart without querying ADB or adopting another AVD. Legacy or incomplete
receipts keep simulator metrics unknown. This does not enable leased execution,
change stop semantics or establish native cleanup.
