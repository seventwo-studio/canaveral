# Remote mobile control and CI builds

Accepted requirements, 17 November 2026: Android emulators and iOS simulators run
on a machine and expose controls through Canaveral. Support both local and remote
hosts; host selection is deferred. Interactive viewing and automated inspection
have equal priority. Builds produced by CI or another machine must be installable
through Canaveral without a direct connection to the simulator host. Broad control
includes app installation, accessibility, files, supported shells, location,
network conditions, permissions and lifecycle.

Delivery and acceptance are tracked in
[ST-600](https://linear.app/seventwo/issue/ST-600/deliver-remote-mobile-build-installation-and-screen-capture-sdk).
The retired mobile roadmap is historical context, not a source of active scope.
Smooth video at roughly 30 fps and MP4 recordings are required for the finished
API; PNG/APNG alone does not satisfy that requirement.

On 18 November 2026 the requested use cases expanded to exclusive device leases
for parallel coding agents and unattended CI and automation jobs. One intended
workflow installs a CI build and records the app's screens for marketing. These
use cases require access through the job's own scoped credentials. Android emulator
leases are now enabled; see [Android emulator leases](#android-emulator-leases). Since
19 November 2026 a lease key can also install large builds and record MP4 of its own
emulator ([lease recording and large installs](#lease-recording-and-large-installs)).
Since 21 November 2026 iOS simulators can be leased too, as an operator opt-in under a
declared `shared-host` isolation class for trusted code; see
[iOS simulator leases](#ios-simulator-leases). That path is fixture-covered only.

## Current implementation

The administrative API now stages builds on the controller, bound to one immutable
machine assignment. The assigned runner retrieves the verified bytes through
outbound authenticated requests and executes a durable installation operation.
Neither the CI client nor a request selects a host filesystem path, adb serial or
simulator UDID. The existing operator-configured `install` action remains available
for builds already present on the host.

Use a private personal API token with `machines:access` for owned machines, or the
existing operator credential. Other users, enrollment credentials, guest credentials
and unrelated hosts cannot read these artifacts. Application/lease credentials are
not supported by these administrative routes, and they refuse uploads for leased machines.
A leased Android emulator or iOS simulator takes uploads through its lease key on the same
contract; see [lease recording and large installs](#lease-recording-and-large-installs).

| Operation | Endpoint | Body |
| --- | --- | --- |
| Reserve upload | `POST /v1/machines/{machine}/app-artifacts` | `{id, format, bytes, sha256}` |
| Read upload receipt | `GET /v1/app-artifacts/{id}` | none |
| Append/repeat chunk | `POST /v1/app-artifacts/{id}/chunks` | `{offset, data}`; base64 bytes |
| Verify and publish | `POST /v1/app-artifacts/{id}/complete` | `{}` |
| Install published build | `POST /v1/machines/{machine}/operations` | `{id, action:"install-uploaded", arguments:{artifact}}` |
| Read installation receipt | `GET /v1/operations/{id}` | none |
| Remove uploaded bytes | `POST /v1/app-artifacts/{id}/delete` | `{}` |
| Inspect an uncertain install | `POST /v1/machines/{machine}/operations` | `{id, action:"inspect-install", arguments:{operation, artifact}}` |
| Resolve its artifact cleanup | `POST /v1/operations/{install}/resolve` | `{id, decision, inspection, reason}` |

Upload receipts contain `id`, `machineId`, `format`, `bytes`, `sha256`, `received`,
`state` and `chunkBytes`. States are `uploading`, `ready` and `deleted`. The upload
UUID permanently identifies its original machine, format, byte count and lowercase
SHA-256. Changing that intent returns conflict. Chunks must arrive sequentially at
512 KiB offsets; only the final chunk may be shorter. Repeating an identical saved
chunk is safe. Conflicting bytes, gaps, early completion and checksum mismatches
cannot publish a build. Read `received` after an uncertain upload response and
resume the same intent. Completion is idempotent; installation is a separate intent.

The runner-only route is
`GET /v1/hosts/{host}/app-artifacts/{artifact}/operations/{operation}`, with
`/chunks/{offset}` for payload reads. Every request revalidates the enabled assigned
host, immutable machine binding and exact pending install operation. The host
independently verifies the full digest before installation commit. There is no
arbitrary URL fetch or direct inbound device-host requirement.

### CI commands

Android accepts one APK; split APK sets and AAB conversion are not implemented.
iOS accepts an **iOS Simulator** `.app`, packaged as an uncompressed POSIX ustar
archive containing exactly one top-level `Name.app` directory:

```sh
COPYFILE_DISABLE=1 tar --format ustar -cf Development.app.tar Development.app
```

The archive must contain a nonempty regular `Info.plist`. Paths, headers, checksums,
padding and end markers are validated. Symlinks, hardlinks, special files, duplicate
paths, traversal, PAX/GNU extensions and multiple app roots are rejected. Builds
using those features need a compatible CI packaging step; they are not extracted
through an unrestricted host `tar` command. Executable files retain executable
permissions within the private stage. iPhone `.ipa` builds cannot be substituted
for simulator builds.

Upload from the build machine, using a saved caller UUID:

```sh
canaveral --url https://canaveral.example.internal --token-file ./ci.token \
  app-upload MACHINE_UUID ./development.apk --format apk --request-id ARTIFACT_UUID

canaveral --url https://canaveral.example.internal --token-file ./ci.token \
  app-upload MACHINE_UUID ./Development.app.tar --format ios-app-tar \
  --request-id ARTIFACT_UUID
```

Choose the command matching the target platform. `app-upload` pins and hashes the
regular source file in bounded buffers, refuses changes during upload and resumes
only confirmed chunks of the same intent. It does not install. For TypeScript,
`uploadAppArtifactFile` is exported from `canaveral-machines/app-artifacts`; supply
an authenticated client with `request(method,path,body)` and
`{machineId,id,format,file}`. The existing CLI client is one implementation.

Put `{"artifact":"ARTIFACT_UUID"}` in a JSON arguments file, then submit and inspect
installation with a separate saved UUID:

```sh
canaveral --url https://canaveral.example.internal --token-file ./ci.token \
  device MACHINE_UUID install-uploaded --request-id OPERATION_UUID \
  --arguments-file ./install.json

canaveral --url https://canaveral.example.internal --token-file ./ci.token \
  operation OPERATION_UUID
```

Android streams into one owned PackageManager session, verifies the staged count,
source identity and digest, then commits. An unconfirmed commit is never abandoned
or automatically replayed. iOS privately stages and verifies the archive, extracts
it, rechecks the owned booted simulator and installs the resulting app. The install
operation remains authorized for at most 30 minutes, including transfer; it retains
the normal contact freshness and stop checks. Native command timeouts can end it
earlier. Other device operations keep their two-minute queue expiry.

### Storage and uncertain installation

Each artifact is limited to 2 GiB. The controller reserves at most 8 GiB and 128
active uploads, storing bytes in bounded private SQLite chunks. The controller
database and backups contain private app builds. Deleting payloads makes SQLite
pages reusable; it does not promise to shrink the database file.

Before accepting an upload, Canaveral reserves additional simulator-host scratch
disk: twice the declared bytes, rounded to GiB, plus 1 GiB for bounded extraction
metadata. This reservation participates in ordinary and mapped physical-host
capacity accounting. iOS extraction permits at most 100,000 entries, including
implicit directories, and extracted file bytes cannot exceed archive bytes.
Filesystem overhead and actual runtime storage still need native measurement.

A pending or uncertain install blocks additional install attempts against the same
artifact. The same operation UUID returns its original receipt without dispatching
again. A fresh UUID is permitted only after positive cleanup, an operator
resolution (below), or proof that an earlier failed operation was never dispatched. This prevents one reserved stage
from covering multiple retained attempts. Successful receipts include
`installed:true`, `sha256`, `bytes` and `artifactCleaned:true`.

`app-artifact ARTIFACT_UUID --delete` removes uploaded payloads and releases scratch
only when every prior attempt has positive cleanup, was never dispatched, or has an
operator resolution. An `unknown` install retains bytes and reservations until then.
Do not retry with a new artifact UUID to bypass an uncertain operation.

### Resolving an uncertain install

Recovery never changes the install's own outcome: its receipt stays `unknown` (or
`failed`), and nothing is retried. It decides only whether the artifact's host
scratch may be released. Two steps keep evidence and decision separate.

1. **Inspect.** The machine owner submits the device action `inspect-install` with
   `arguments:{operation, artifact}` naming a terminal install on the same machine
   that still lacks cleanup. It uses the ordinary operation queue, UUID replay and
   receipts, so the device must be running on a fresh host. The owning runner
   answers under the assignment lock, read-only, from its private journal for that
   install (`operations/{install}.json`, matched by binding fingerprint) and its
   staging state. The succeeded result is
   `{operation, artifact, providerReceipt, stagedArtifacts, artifactCleaned}`.
   `providerReceipt` is `absent`, `partial` (an interrupted journal write), `started`
   or the saved report state. `stagedArtifacts` is `absent` or `present` for iOS,
   which stages in private `.artifact-*` directories of the assignment's storage.
   It is `not-inspectable` for Android, whose staging lives in an emulator package
   session. `artifactCleaned` is true only when the journal is absent, because the
   provider never started that install; or the saved report, whatever its state,
   recorded `artifactCleaned`; or the platform shows that no stage remains. A failed
   or unknown install report records `artifactCleaned:true` only when the failure
   provably preceded any stage: the controller download could not be opened, or on
   Android the failure came before `pm install-create`. A busy lock or a mismatched
   journal makes the inspection `unknown`; submit another inspection UUID later.
   Inspection removes nothing. Evidence is read from the runner's current storage
   root, so changing a runner's configured storage root voids inspection for
   installs journaled under the old root; abandon those instead.
2. **Decide.** `POST /v1/operations/{install}/resolve` with
   `{id, decision, inspection, reason}` records one append-only decision per install.
   `cleanup-confirmed` requires `inspection` to name a succeeded `inspect-install`
   of this exact install with `artifactCleaned:true`. The machine owner may record
   it. `abandoned` accepts `inspection` as optional evidence (`null` permitted) and
   requires administrator authority, because it releases scratch whose native
   cleanup is unproven. The operator then owns any residue, for example by deleting
   the machine. An abandoned install still blocks another install of the same
   artifact, so one reservation never covers two stages; it unblocks only artifact
   and machine deletion. `cleanup-confirmed` also requires the inspection to name
   the install's artifact. Both decisions need a non-empty `reason` of up to 1000 characters.
   The controller stores the deciding principal (`kind`, `userId`, `username`) and
   time.

Repeating the same request UUID and body returns the saved decision, so a lost
response is safe to retry. A different body under that UUID, or a second UUID for
an already resolved install, returns conflict. Other accounts receive not-found,
including when a request UUID already names a resolution they cannot see.
`GET /v1/operations/{install}` then includes `resolution`. Deleting the artifact
remains a separate, explicit step; only that step releases the reservation.
CLI: `device MACHINE inspect-install --request-id UUID --arguments-file FILE`, then
`operation INSTALL --resolve-file FILE`. The dashboard does not yet expose resolve.

Machine deletion is refused while any install on that machine is queued or lacks
positive cleanup or a resolution. Deletion removes the storage and journals that
inspection reads. Order recovery as inspect, resolve, delete the artifact, then
delete the machine if wanted. A stopped machine must be started to inspect it; an
administrator may abandon without inspection instead.

Native acceptance of inspection is open. iOS stage enumeration and the absent-journal
rule are fixture-covered only. No native check yet establishes that an Android
package session left by an uncertain commit is gone.

## Screens, input and recordings

The existing mobile display adapter transports TightPNG/RFB through authenticated
WebSocket display sessions, with view-only capture and exclusive input ownership.
The [visual SDK](visual-sdk.md) now provides `display.frames()` for pull-driven PNG
frames and `display.record()` for bounded streamed APNG recordings. Output uses
backpressure and does not buffer an entire recording. APNG is an animated image,
not MP4. Abort, rotation, disconnection or sink failure leaves incomplete output.

The screenshot adapter captures at no more than four frames per second. A separate
native H.264 path now supports a 30 fps encoded output target and fragmented MP4
over administrative WebSocket sessions. It uses Android screenrecord or iOS idb
native video capture, with an operator-configured FFmpeg encoder. No SDK, encoder
or runtime is downloaded automatically. Configure an absolute `videoEncoder` path
in each mobile runtime and provide FFmpeg with libx264. The actual host must also
pass its existing mobile prerequisites.

### Native video sessions

`POST /v1/machines/{machine}/video-sessions` accepts
`{id,fps:30,durationSeconds,bitRate}`. The duration is 1–180 seconds; bitrate is
100,000–20,000,000 bits per second. A saved UUID identifies that exact intent and
creator credential. Read with `GET /v1/machines/{machine}/video-sessions/{id}`;
close with `POST /v1/machines/{machine}/video-sessions/{id}/close` and `{}`.
A disconnected capture cannot reattach or silently roll over to another clip.

The response contains the machine, session and generation identities, options,
`attachBefore`, `authorizationDeadline`, `cleaned` (positive native cleanup was
reported) and, once decided, `resolution` (below). The creator attaches within 30 seconds
at `/v1/machines/{machine}/video-sessions/{id}/{generation}`; the assigned runner
attaches outbound at `/v1/hosts/{host}/video-sessions/{id}/{generation}`. Both use
header credentials and the existing `canaveral-session-v1` WebSocket protocol.
The consumer must use the same currently authorized credential that created the
session; account revocation, scope changes, host loss, stop, expiry and assignment
changes terminate authorization. Consumer lease keys do not authorize these machine
routes; a lease key records its own emulator through the lease routes in
[lease recording and large installs](#lease-recording-and-large-installs).

After broker readiness, the host sends `{type:"video",mediaType:"video/mp4",
codec:"avc1",fps:30}`, then binary MP4 bytes in messages no larger than 64 KiB.
Message boundaries are not MP4 box or frame boundaries. Binary input from the
consumer is forbidden.

Each broker peer is pinged every 10 seconds and dropped after 30 seconds without
receiving any frame from it. Counting every frame, not only pongs, keeps a peer
whose pong waits behind media still in socket buffers on a slow link. Ping and pong
frames have their own small output queue, so they never fail for lack of queue
space behind media. The broker refuses a consumer message before the host's
`finish` has been relayed; an early `ack` ends the session and is never a
completion proof. The runner's session client keeps
one bounded read outstanding at all times, so it answers pings while it only
sends media; at most one received message waits for the caller. A capture may
therefore run to the 180-second maximum. Android emits no frames while the screen
is static, so native and encoder reads wait until the capture deadline (duration
plus 10 seconds) rather than a fixed 30 seconds; the deadline still bounds every
stall. The host finishes with `{type:"finish",bytes,sha256,
cleaned:true}`; the consumer verifies the complete content and replies
`{type:"ack"}`. An interrupted or unverified file remains incomplete. The
[video SDK](visual-sdk.md#native-mp4-video) exposes both byte iteration for live
playback and a writer for recording the same stream as an MP4 file.

FFmpeg transcodes with one thread, H.264 baseline, yuv420p, a 30 fps filter, short
GOPs and approximately 250 ms MP4 fragments. Output preserves aspect ratio within
a 1280-pixel edge and has no audio. The encoded stream is bounded to 512 MiB. The
encoder uses host-arrival timestamps because the Android raw stream does not
include capture timestamps. This is not proof of exact capture timing, a measured
30 fps, a latency budget or browser decoder compatibility.

One session reserves one additional CPU and 256 MiB of scheduling capacity; at most
four uncleaned sessions are admitted per host and one per machine. These are
reservations, not hard process limits. Real decoder/encoder memory, CPU and
resolution overhead need host acceptance. Capture does not hold the device input
lock: existing administrative input and app controls remain independent. Configure
`pollIntervalSeconds:0.25` when using the queued input API interactively; the normal
default is five seconds. Direct low-latency display input retains its separate
input-ownership contract.

The runner journals capture before native dispatch and never automatically repeats
it after interruption. Positive native-source and encoder cleanup is reported
separately from successful recording delivery, so a failed recording can release
capacity when cleanup is proven. Unknown native cleanup retains the reservation
and blocks another capture for that machine. The runner may repeat a saved positive
cleanup receipt without reopening capture. A controller restart disconnects old
generations. iOS uses idb's graceful signal/stop protocol and confirms its retained
child exit; companion termination remains a native acceptance check.

#### Android recorder cleanup after early cancellation

An exited host `adb` client does not prove that the guest recorder stopped:
screenrecord can keep running on the device until its time limit. The Android
capture shell therefore first prints one identity line on stdout, the guest kernel
`boot_id` and its own `/proc/<pid>/stat`, then `exec`s screenrecord, which keeps
that PID and start time. The provider strips the line before encoding. A capture
without a valid identity line never reports cleanup. Output goes to stdout only;
the capture creates no guest file, so there is no temporary file to remove.

After a cancel, close, failure, authorization loss or deadline, the runner closes
its adb client. It then stops the recorder only while it still holds the
machine's assignment, the same one that started the capture (fresh controller
contact, desired `running`, no deletion, unchanged assignment fingerprint and
lease), and after `emu avd name` confirms the serial is still the machine's AVD.
One guest shell compares the boot id, PID and start time (`/proc/<pid>/stat`
field 22) and signals only on an exact match, with SIGTERM and then, after 3
seconds, SIGKILL. A name match such as `pkill` is never used, and other
screenrecord processes are never touched. Cleanup is positive only if the PID is
absent, holds a process with another start time, the boot id changed, or the
process is a zombie with no remaining threads. Probes start within 6 seconds;
SIGKILL is always sent before giving up and is always followed by at least one
probe, so one cleanup takes at most about 6 seconds plus a few bounded adb calls
(5 seconds for each ownership check, 10 seconds for each probe). The guest
reports its own evidence; a compromised guest can only affect its own
reservation. The remaining gap between reading `/proc` and `kill` is the
narrowest a shell allows without a pidfd. A matching process in an unexpected command, an unreadable `/proc` entry,
an unreachable or foreign device, lost assignment authority or a timeout reports
unknown. The result is computed once per capture, so a repeated close returns the
same outcome. A capture that already ended with EOF and a zero remote exit needs no
guest step.

Unknown cleanup is not retried later: the journal stays `unknown` and the session
keeps its reservation until an administrator abandons it (below). Stopping the
machine ends assignment authority, so a capture cancelled by a stop is also left
unknown unless its cleanup completed first.

### Deleting a machine with a video session

Machine deletion is refused (409) while any video session on that machine is
live, or ended without positive cleanup and without an abandonment. Deletion would
remove the device whose recorder the runner still has to stop and prove clean.
A session whose host never attached needs no cleanup. Retrying the refused
deletion with the same request UUID is safe once the session is cleaned.

Recover in this order:

1. **Close** the session (`POST .../video-sessions/{id}/close`), or stop the
   machine. Either ends capture authorization.
2. **Wait** for the runner's positive cleanup receipt. `cleaned` becomes true, the
   reservation is released and deletion is allowed.
3. **Abandon** only when cleanup stays unknown, for example when the device was
   unreachable during cleanup, when the machine was stopped before cleanup ran, or
   for an iOS capture whose idb stop was unconfirmed: `POST /v1/machines/{machine}/video-sessions/{id}/abandon` with
   `{reason}` (1–1000 characters). This needs administrator authority, because
   it accepts unproven native cleanup. The machine owner receives 403 and other
   accounts 404. The session must already be closed, and its authorization
   deadline (`authorizationDeadline`) must have passed, so a runner that is still
   tearing the recorder down can report cleanup first. An earlier request returns
   a retryable conflict. The decision is append-only
   and stores the reason, the deciding principal (`kind`, `userId`, `username`)
   and the time in `resolution`. Repeating the same reason returns the saved
   decision, so a lost response is safe to retry; a different reason, a live
   session or a session with positive cleanup returns conflict.
4. **Delete** the machine. Abandonment unblocks only this deletion. It still
   blocks another capture on that machine, and the session keeps its 1 CPU and
   256 MiB reservation, and its host slot, until the deletion completes. The
   operator owns any residue, which the device's deletion removes.

A positive cleanup receipt that arrives after abandonment is still recorded and
releases the reservation as usual. Sessions left uncleaned on machines deleted
before this rule existed can be abandoned in the same way; because their deletion
is already complete, abandonment releases their reservation immediately.

### Dashboard capture

Owners capture from machine details through the existing `screenshot` operation
and these video-session routes; see [owner mobile capture](dashboard.md#owner-mobile-capture).
The dashboard gateway relays the consumer attachment for a same-origin cookie
session only. The page acknowledges a recording only after the finish receipt,
SHA-256 and its MP4 structure check pass, and closes the session on cancel,
failure, close or unload.

On 19 November 2026 the [first native trial](../coordination/native-acceptance/dashboard-mobile-capture.md)
on the Mac Studio homelab passed Android screenshots and verified 15-second
recordings: ffprobe frame counts and durations matched the page, FFmpeg decoded
cleanly and positive cleanup released the session reservation. iOS screenshots
passed. iOS recording failed: idb-cli 1.7.8 exits 1 after the provider's SIGINT
stop under Python 3.14, so the provider correctly reports unknown cleanup and
retains the reservation. Android cancellation still lacks positive cleanup, so
leaving the page closes the session but keeps its reservation. Android encoded
duration follows emitted frames, not the requested length.

That trial found two lifecycle defects, both now fixed (see
[native video sessions](#native-video-sessions) and
[deleting a machine with a video session](#deleting-a-machine-with-a-video-session)).
The runner answered broker pings only while reading, so captures were cut off
about 30 seconds after host attachment and the dashboard offered at most 20
seconds. It now offers 5, 10, 15, 30, 60, 120 and 180 seconds. The upper bound is
the backend's own maximum and Android screenrecord's time limit; at the
dashboard's 4 Mbit/s a 180-second file is about 86 MiB, within its 128 MiB
in-memory limit. Machine deletion also no longer proceeds while a session lacks
positive cleanup. The same day's [follow-up trial](../coordination/native-acceptance/dashboard-mobile-video-lifecycle.md)
verified 60- and 180-second Android recordings through the dashboard, each with
static stretches longer than 30 seconds, by ffprobe and a clean FFmpeg decode. It
also confirmed that deletion was refused (409) while a left-page session was
uncleaned, that the owner could not abandon it (403), and that after an
administrator's abandonment the deletion completed and released the reservation.

The runner now stops and confirms the exact Android recorder after early
cancellation (see [Android recorder cleanup](#android-recorder-cleanup-after-early-cancellation)).
The [recording cleanup trial](../coordination/native-acceptance/dashboard-android-recording-cleanup.md)
of the same day confirmed it natively. Cancel and leaving the page each reached
`cleaned=1` within about 5 seconds and released the reservation, with no recorder
left on the guest. A new recording on the same machine then verified, and the
machine was deleted without abandonment. It also showed that the guest recorder
keeps running after the host adb client closes, so the runner's SIGTERM is needed.

The local attached display path and consumer lease display keep their prior
contracts. Administrative native video does not enable consumer lease execution
or bypass that acceptance gate. Lease recording has its own routes and rules below.

Existing [device controls](devices.md) cover gestures, text, app lifecycle, logs,
accessibility, permissions, location, small files and Android shells. iOS has no
general guest shell; exposing the Mac host shell would violate simulator scope.
Network-condition control, reset/delete/snapshot capabilities and broader native
inputs require explicit platform adapters and acceptance rather than claims of
platform parity.

## Android emulator leases

Enabled 19 November 2026 for Android emulators only. An agent or CI job submits a
`kind: "lease"` [request](requests.md) (or a direct `/v1/leases` acquisition) for an
Android template. The request waits while the host is full, is admitted in the shared
fair order and then gets a booted, checked, network-isolated emulator to itself. The
lease follows the generic [lease contract](leases.md). iOS simulators are leased under their
own opt-in and isolation class ([iOS simulator leases](#ios-simulator-leases)). Physical
devices still refuse leased execution.

Coding agents and CI jobs need not call these routes themselves. The
[agent surfaces](agent-surfaces.md) provide an MCP server, a CLI lease that is held and
renewed, lease-key commands and a [CI recipe](agent-surfaces.md#ci-recipe).

### Host configuration

A host advertises lease execution only when all of these hold. Every other runtime,
and any partial configuration, keeps refusing `leaseProtocol` and `leaseImages`.

- The provider is `android`, or a `macos`/`linux` host with the `android` runtime enabled.
- `leaseClockHelper` is an absolute path to an installed `canaveral-mobile-native`. This
  is the suspend-aware native lease clock described in [leases](leases.md).
- The Android runtime sets `leaseSupervisor` to an absolute path to the same helper.
- `leaseProtocol: 1`, and every `leaseImages` entry is
  `{id, revision, arch, runtime: "android"}` naming an offered Android template.

```json
{ "provider": "android", "androidSDK": "/ABS/sdk", "storage": "/ABS/devices",
  "leaseClockHelper": "/ABS/canaveral-mobile-native", "leaseSupervisor": "/ABS/canaveral-mobile-native",
  "leaseProtocol": 1, "leaseImages": [{ "id": "phone", "revision": "1", "arch": "arm64", "runtime": "android" }],
  "leaseIsolationPorts": [8443] }
```

Size the host's `capacity` to the number of emulators it may run. Requests beyond that wait.
`leaseIsolationPorts` is optional. It lists more host loopback ports, such as a
separately served dashboard, that the readiness probe must find unreachable from the
guest; see [Guest network isolation](#guest-network-isolation).

The host enforces this gate itself and does not rely on the controller. A leased
assignment whose runtime is not Android, or whose template is not an advertised
`leaseImages` entry, is never started: the host stops it and reports `error`, which
fails the lease. Consumer operations and sessions for such an assignment are refused.

Run the host so that stopping or restarting it does not kill the detached lease
supervisors. On Linux, add the drop-in
`deploy/systemd/canaveral-host.service.d/android-leases.conf` (`KillMode=process`)
to the example unit on hosts that lease Android emulators; the default
`control-group` mode would kill every supervisor and emulator on a service restart.
The base unit keeps `control-group`, so hosts without Android leases still clean up
every helper when the service stops. Linux lease hosts have no native acceptance yet.

Lease images must be user builds. Readiness refuses a guest whose `ro.debuggable` is
not `0` and fences the lease: a userdebug or eng guest can get root and act as adbd
toward the host's shared adb server without using the network, which the slirp
restriction below does not cover. Google Play system images are user builds; plain
Google APIs images are not.

### Guest network isolation

The emulator's default user-mode networking (slirp) maps the guest address `10.0.2.2`
to the host's `127.0.0.1`. An unrestricted guest can therefore reach the host's adb
server on 5037 and use adb smart sockets (`host:transport:<serial>` and `shell:`) to
get a shell on any other emulator or USB device the server knows. It can also reach
other emulators' console and adb ports, the controller, the dashboard and every other
loopback service, as well as the LAN. The native check on 19 November 2026 confirmed
this on the Mac Studio with emulator 37.2.13: a stock guest connected to the host's adb
server, the T3 server and a canary listener.

Leased emulators therefore run with **no guest network at all**. Every leased launch
appends these emulator flags (`LEASE_ISOLATION_ARGUMENTS` in the Android provider),
and they are part of the launch binding:

| Flags | Effect |
| --- | --- |
| `-network-user-mode-options restrict=on,ipv6=off`, `-wifi-user-mode-options restrict=on,ipv6=off` | Slirp drops every guest packet that leaves the virtual network, on both the radio (`eth0`) and Wi-Fi (`wlan0`) interfaces. That covers the host alias, the internet, DNS and IPv6. |
| `-feature -WiFiPacketStream` | Wi-Fi uses the emulator's own restricted slirp instead of `netsimd`. With netsim, `netsimd` runs its own unrestricted slirp, so the restrict options did not apply: on the native check the guest still reached the host. |
| `-feature -BluetoothEmulation`, `-feature -Uwb` | With netsim Wi-Fi, Bluetooth and UWB off, no `netsimd` starts. `netsimd` is a host-wide daemon whose virtual radio medium is shared between emulators, so it would be a cross-lease channel. |
| `-crash-report-mode disabled`, `-no-metrics` | No `crashpad_handler` starts. It runs outside the emulator's process group (parent PID 1, its own group), so the supervisor could not stop it. |

With these flags the native check found only the `qemu-system-aarch64` process for
the emulator: no `netsimd` and no `crashpad_handler`. Inside the guest, every TCP
connection to `10.0.2.2` was refused (5037, the emulator's own console and adb ports,
the T3 server and a canary). UDP to a host canary, IPv6 and the internet were also
unreachable. Without `restrict=on` but with the other flags, every one of those ports
was reachable again, so `restrict=on` is the operative control. adb, `pm install`,
screenshots and input work without guest networking, because adb uses the emulator's
own pipe.

Consequence: apps under test on a leased emulator have no internet access and cannot
reach any service on the host or the LAN. Tests that need a backend cannot use Android
leases yet. Providing controlled egress (for example through a filtering proxy) is
future work and needs its own isolation review.

A future emulator could ignore or rename these flags. The readiness probe below
therefore checks isolation on every leased boot and fails closed.

None of this applies to an iOS simulator lease. A simulator has no guest network to
restrict, so that class has no isolation flags and no isolation probe; see
[iOS simulator leases](#ios-simulator-leases).

### Independent deadline and stop proof

The runner never spawns a leased emulator itself. It writes a version 2 `launch.json`
with `supervised: true`, then starts `canaveral-mobile-native lease-supervise <storage>`
detached in its own session. The launch request (emulator argv and environment)
travels on stdin. The supervisor:

- takes an exclusive `flock` on `<storage>/lease-supervisor.lock` before anything else
  and holds it for its whole life. The descriptor is close-on-exec, so the emulator
  never inherits it. The kernel releases the lock however the supervisor ends,
  including SIGKILL. The runner tests it with a non-blocking try-lock
  (`canaveral-mobile-native lease-status <storage>`), so supervisor liveness never
  depends on a PID that could be reused;
- validates the request, reads the authorization and samples the clock, all before
  spawning. If anything fails before spawn it exits with the dedicated status 75 and
  has spawned nothing. That status is the only exit status that proves nothing was
  spawned;
- starts the emulator in a dedicated process group and records
  `lease-supervisor.json` (machine, lease, launch boot, boot session, supervisor and
  emulator PIDs). The emulator's output goes through a pipe into `emulator.log`, which
  keeps at most 16 MiB per launch and then drops further output;
- every 100 ms reads the private `lease-authorization.json` the runner publishes.
  That file binds machine, lease, launch boot, OS boot session, lease revision, an
  absolute deadline on the continuous clock (Mach continuous time or
  `CLOCK_BOOTTIME`) and a fence flag. Same or older revisions never extend the
  deadline, and a renewal first seen after expiry is ignored;
- stops the emulator when the deadline passes, the file is fenced, missing, malformed
  or bound to another assignment or boot, the clock fails, or the supervisor receives
  SIGTERM. It writes a sticky `lease-fenced.json`, sends SIGTERM to the group, waits
  5 s, then sends SIGKILL. The leader stays an unreaped child until every signal is
  sent, so its process group ID cannot be reused. Every path after spawn ends in this
  stop, which cannot return early: an error while waiting counts as "not yet exited"
  and the SIGKILL loop continues;
- writes `lease-stopped.json` (`groupAbsent: true`) only after the leader is reaped
  and the whole group is gone, then releases the lock by exiting. It never exits while
  a group member may survive. It refuses a second launch in the same storage, and a
  second supervisor while the first holds the lock.

Because the supervisor is detached, deadline enforcement continues when the runner
process or the controller is lost. The runner's own lease guard also fences locally at
the deadline without the controller and publishes the fence immediately.

Device commands for a leased assignment are refused with 410 unless the supervisor
holds its lock, no `lease-fenced.json` or `lease-stopped.json` exists, and
`lease-authorization.json` is unfenced, on the current boot session and before its
deadline on the native clock. This holds whatever the runner still believes.

Stop proof for cleanup is positive only:

- a matching `lease-stopped.json`, with the supervisor's lock free; or
- a launch that never spawned: no launch at all, a supervisor exit with status 75
  before any launch record, or the automatic recovery below; or
- a free supervisor lock and a recorded emulator PID that is absent, with the
  emulator's process group absent too.

Anything else stays unknown. PIDs are only observed, never signalled after recovery.

The runner starts the adb server during its environment check, before any lease. With
netsim and crash reporting disabled, the emulator starts no helper outside its process
group. The native trial checks for leftover `netsimd`, `crashpad_handler` and
`qemu-system` processes. A future emulator that adds a helper which leaves the group
would not be covered by the group stop proof; the trial's leftover check is the guard
against that.

### Readiness

A leased emulator reports `running` with `accessReady: true` only after all of these:

1. It has finished booting (`sys.boot_completed=1`).
2. Its package manager answers `pm path android`.
3. `emu avd name` proves the serial is the lease's own AVD.
4. A negative guest-to-host probe passes. The runner opens a fresh canary listener on
   the host's `127.0.0.1`. From the lease's own `adb shell` it then tries
   `nc 10.0.2.2 <port>` for each of these ports:
   - 5037 (the adb server);
   - the emulator's own console and adb ports;
   - the controller's port, taken from the host's controller URL;
   - every `leaseIsolationPorts` entry;
   - the canary.

   Isolation is proven only when every attempt fails with exit status 1 and a
   recognized connection error, and the canary saw no connection. The result is
   recorded in `lease-isolation.json` for that launch.

Until then the emulator reports `starting` with a detail; an inconclusive probe (for
example, `nc` missing) keeps it starting until the provisioning timeout fails the
lease. If any port is reachable, or the canary sees a connection, the runner fences
the supervisor at once and reports `error`. The lease fails without ever becoming
ready, and no credential exchange can reach that guest.

The controller requires that positive access check for mobile lease members. The lease
becomes `ready`, and its member shows `ready: true`, only after a checked device,
never from inventory or a bare emulator process.

Step 4 is specific to Android. An iOS simulator lease has no network isolation probe,
because there is nothing to probe: its readiness is described under
[iOS simulator leases](#simulator-readiness).

### Scoped control

The application exchanges its key for a lease-scoped credential
(`POST /v1/leases/{id}/credential`). Only that credential authorizes
`POST /v1/leases/{id}/operations` and `GET /v1/leases/{id}/operations/{op}`. Operations target
member `primary` and resolve to that lease's own machine, host and AVD:

| Need | Action | Capability |
| --- | --- | --- |
| Install a build | Upload it through the lease key, then `install-uploaded` (any size up to 2 GiB; see below). Small APKs may still use `push` (up to 512 KiB) and `shell` `["pm","install","-r",path]`. | files (`push`/`shell` also command) |
| Launch, stop, list or remove apps | `launch`, `terminate`, `apps`, `uninstall`, `open-url` | command |
| Screens | `screenshot` (PNG), `hierarchy` | screenshot, hierarchy |
| Input | `tap`, `swipe`, `text`, `key` | input |
| Orientation and simulated position | `rotate` (portrait or landscape), `location` (latitude, longitude) | input |
| App permissions | `permission` (`grant` or `revoke` one permission of one app) | command |
| Logs | `logs` (last 200 logcat lines) | command |
| Record | MP4 video session (see below) | displayStream |

App lifecycle, logs and app permissions need `command` because the Android shell
already grants them. iOS has no shell capability. Its app lifecycle and logs use
`files` under the [iOS scoped control](#ios-scoped-control) contract.
Since 21 November 2026 a lease key can also rotate its emulator, set its simulated
position and grant or revoke an app permission. These use the same argument checks,
fenced provider path and receipts as the administrative actions of the same name,
and reach only the lease's own emulator. They apply to device images only, and a
lease key cannot `reset` a permission: the Android provider grants or revokes, so
a reset is refused with 400 instead of being queued to fail. Operator-configured
`install` and `inspect-install` stay administrative. The three lease-key actions have portable
fixture coverage against the real controller, runner and lease supervisor with a
stand-in adb; no native emulator run exercised them through a lease key. Operations keep
the durable receipt semantics: the same UUID replays its receipt without running
again; a changed body is 409; an operation in flight when authorization ends is
`unknown` and is never replayed. Rotating the credential revokes the previous one.

The lease shell runs inside the guest. Because the guest has no network path, a shell
command or an installed APK cannot reach the host's adb server or any other host
service.

The administrative app-artifact and video routes and dashboard capture do not accept
lease credentials. Lease file sessions and the live display stream are still not
accepted natively for Android leases.

### Lease recording and large installs

Enabled 19 November 2026 for the CI and marketing-capture workflow: a job leases an
emulator, installs its real build, drives named screens, takes PNGs (`screenshot`) and
records a playable MP4, all with its lease key. Both paths extend existing mechanisms
rather than adding parallel ones.

**Large installs reuse the uploaded-app path**, not the lease file session. The upload
path already provides what a build install needs: caller-UUID intents, sequential
512 KiB chunks, digest-checked publication, host scratch reservations, streaming into one
owned PackageManager session with a verified size and digest before commit, the
never-replayed `unknown` receipt of an uncertain commit, and positive artifact cleanup.
A file session only delivers bytes into the guest; installing them would then be an
unjournaled `pm install` shell command with no digest check against the upload and no
cleanup evidence. The lease file session also needs the separate native transfer
helper, which has no Android lease acceptance.

| Operation | Endpoint | Body |
| --- | --- | --- |
| Reserve upload | `POST /v1/leases/{lease}/app-artifacts` | `{id, member, format:"apk", bytes, sha256}` |
| Read receipt | `GET /v1/leases/{lease}/app-artifacts/{id}` | none |
| Append or repeat a chunk | `POST /v1/leases/{lease}/app-artifacts/{id}/chunks` | `{offset, data}` |
| Verify and publish | `POST /v1/leases/{lease}/app-artifacts/{id}/complete` | `{}` |
| Install | `POST /v1/leases/{lease}/operations` | `{id, member, action:"install-uploaded", arguments:{artifact}}` |
| Release the upload | `POST /v1/leases/{lease}/app-artifacts/{id}/delete` | `{}` |

Receipts add `leaseId`. Chunk, completion, replay and install rules are those of the
[administrative upload](#current-implementation). The install operation is authorized for
at most 30 minutes, and never beyond the lease. An upload binds one lease member, and only
that lease's install of that member may read it from the controller. The runner reads it
only while the lease is ready. The provider rechecks the lease supervisor, not only the
AVD identity, between install stages (after the install session is created, after
staging, and before and after commit); during streaming, the runner's lease guard and
the controller's per-chunk lease check apply. One application's lease uploads may
declare at most 2 GiB in total across its leases (a quarter of the controller-wide 8 GiB
upload pool), so one lease key cannot reserve the whole pool. Rotating the lease key
during an install marks it `unknown`; its upload stays held until lease cleanup. Administrative routes neither read nor install
lease uploads.

An iOS simulator lease uses the same upload routes with `format: "ios-app-tar"` (the
simulator `.app` archive described under [CI commands](#ci-commands)); see
[iOS simulator leases](#ios-scoped-control). Lease recording is Android only.

**Recording reuses the native video session** (#67, #68, #72): the same table, the same
`canaveral-session-v1` broker and MP4 verification, the same host reservation (one CPU
and 256 MiB), the same one-session-per-machine and four-per-host slots and the same
exact-recorder cleanup.

| Operation | Endpoint | Body |
| --- | --- | --- |
| Create or replay | `POST /v1/leases/{lease}/video-sessions` | `{id, member, fps:30, durationSeconds, bitRate}` |
| Read | `GET /v1/leases/{lease}/video-sessions/{id}` | none |
| Close | `POST /v1/leases/{lease}/video-sessions/{id}/close` | `{}` |
| Attach (WebSocket) | `/v1/leases/{lease}/video-sessions/{id}/{generation}` | lease key header |

Receipts add `leaseId`, `member` and `hostCleaned` (below). The SDK exposes both paths
on `LeaseClient`: `uploadApp`, `appArtifact`, `deleteAppArtifact`, `installApp` and
`video` (`create`, `connect`, `inspect`, `close`, `record`); see the
[video SDK](visual-sdk.md#recording-a-leased-emulator-with-its-lease-key).

#### Scope

Only the lease's current key reaches these routes; the application key, operator and
account credentials and another lease's key get 401. Another lease's upload or session
is not found (404), and an install naming an upload of another lease or member is refused
(409). New uploads, chunks, publication and recordings need a ready, unexpired lease with
a checked member (410 `lease_ended` after it ends, 409 `member_not_ready` before
readiness). A recording stays authorized only while the lease is ready, its key unrotated,
its application active and its device checked; the runner additionally requires its own
lease guard and, about once a second, a held supervisor lock and an unfenced, unexpired
native authorization. Expiry, release, a fence, supervisor loss or a key rotation
therefore ends a recording within about a second: the stream stops without a finish
receipt, and the SDK reports `session_disconnected` or `video_incomplete`. Reading receipts and deleting
clean uploads remain available to the current key after the lease ends.

#### Reservations and cleanup proof

A recording or upload keeps its reservation until cleanup is proven, after the lease ends
too:

- **Recording.** As for administrative sessions, positive cleanup is the runner's proof
  that the native recorder and the encoder stopped. When the lease ends first, the guest
  recorder's stop cannot be proven by adb: the supervisor fences and stops the emulator.
  The runner then reports `hostCleaned`: its own encoder exited. The session becomes
  `cleaned` only when both that receipt exists and the lease's own cleanup has proven
  the emulator's whole process group gone and its storage removed. If the encoder exit
  is unconfirmed, the session stays held after lease cleanup. An administrator may then
  abandon it through the machine route
  (`POST /v1/machines/{machine}/video-sessions/{id}/abandon`, after its deadline), which
  releases it once the lease's cleanup is complete, as deletion does for owned machines.
- **Upload.** An upload that was never installed has no native stage and is released as
  soon as the lease ends. An install attempt is clean when it succeeded with
  `artifactCleaned`, was never handed to the runner, or its emulator was proven stopped
  and removed by lease cleanup. An interrupted or `unknown` install therefore holds its
  upload until the lease's cleanup completes. It is never replayed. Within a live lease,
  `delete` releases an upload whose attempts are all clean; an unclean attempt blocks
  both deletion and a repeat install of the same upload.
- **Unprovable cleanup.** When the lease's own cleanup is blocked (for example after
  supervisor loss with a surviving emulator), its recordings and uploads stay held with
  it. Follow [unprovable cleanup and recovery](#unprovable-cleanup-and-recovery); the
  reservations are released with the lease's cleanup proof.

Accounting: each held recording counts one CPU and 256 MiB, and each held upload its host
scratch (`1 + ceil(2 × bytes / GiB)` GiB), against the application's resource limits,
alongside its leases. A request that would exceed them is refused with 429 before any
reservation, and so are new leases while held recordings or uploads use the budget. A
lease holds at most four uploads at once. The host-wide limits still apply: four held
recordings per host, one per machine, and 8 GiB and 128 uploads per controller. Size the
host's capacity for the recording (one CPU and 256 MiB) and upload scratch beside its
emulators; otherwise those requests get 409.

The [native capture trial](../coordination/native-acceptance/android-lease-capture.md) of
19 November 2026 ran this workflow on the Mac Studio with a Google Play API 36 emulator.
Through the lease key it installed a real 1,511,885-byte APK in three chunks, took two named
1080×2400 PNGs and recorded a 30-second MP4 that ffprobe read as 820 H.264 frames over
27.3 s and FFmpeg decoded without errors. A second recording started 45 s before expiry
ended with the lease. The session held its reservation (`hostCleaned`, not `cleaned`)
until the lease's cleanup proved the emulator's group gone about 3 s later; the host
reservation then returned to zero. Release, key rotation and supervisor loss during a
recording, interrupted installs and uploads, and limit refusals are fixture-covered only.
Runner or controller loss during a lease recording is not covered.

### Expiry, release and loss

At expiry or release the controller refuses the old credential at once (410
`lease_ended` for operations, 401 after rotation), fails queued operations, ends
recordings and further uploads, and issues the cleanup intent. The runner fences the supervisor. Cleanup then requires
the stop proof above before it removes the AVD storage and its `ANDROID_AVD_HOME`
registration through the recoverable quarantine path. It then erases the
assignment's credential directory, and only then reports completion. The controller
releases the host and application reservations only on that report.

The runner's fence is conservative: it can fall a fraction of a second before the
controller's expiry. If its fence report arrives first, the lease ends `failed`
instead of `expired`, and the device answers 409 `member_not_ready` in between. Both
outcomes revoke access. A lease is never relaunched: an emulator that stops while its
lease is active reports `error`, which fails the lease.

**Renew early.** The supervisor accepts a renewal only if it sees the newer revision
before its current deadline. A renewal that reaches the host after that deadline
(for example, sent in the last second, or delayed by a slow heartbeat) cannot revive
the emulator: the supervisor has already stopped it and the lease ends `failed`.
Renew well before expiry, for example when a third of the TTL remains, and allow at
least a few heartbeat intervals. `canaveral mcp` and `canaveral lease hold` renew at
that point for the leases they hold ([agent surfaces](agent-surfaces.md#what-the-session-does-for-the-caller)).

- **Controller loss:** the runner keeps its persisted deadline, fences locally and the
  supervisor stops the emulator. Cleanup completes when the controller returns.
- **Runner loss:** the supervisor alone stops the emulator at its deadline. The
  reservation stays held until a runner restarts, recovers the lease guard and proves
  cleanup. A restarted runner recovers a running supervised emulator without
  relaunching it, using its conservative recovered deadline.
- **Supervisor loss** (killed or crashed without a stop receipt): nothing enforces the
  deadline any more, so the lease ends at once. Device commands get 410 as soon as
  the lock is free. On its next reconcile the runner fences the authorization and
  reports `error`, which fails the lease. Cleanup then waits for stop proof (below).

### Unprovable cleanup and recovery

If the supervisor is gone while its emulator group survives, cleanup reports
`blocked` with reason `execution_pending`. The host, application and lease
reservations stay held and the runner retries with backoff. There is no administrator
override that releases them without proof.

Recovery:

1. Confirm that `canaveral-mobile-native lease-status <storage>/<machine>` reports
   `"supervisor": "free"`, so no supervisor is running.
2. Inspect `<storage>/<machine>/lease-supervisor.json`. It names the emulator
   `childPid`, which is also its process group ID.
3. Confirm the process is the lease's emulator (its argv contains
   `-avd cvm-<machine>`), then stop that process group.
4. On its next retry the runner observes the emulator and its group absent, removes
   storage, erases credentials and reports completion.

A reused PID that still shows as present keeps cleanup blocked. Wait for it to
disappear; never signal an unidentified process to unblock cleanup.

**Launch intent without a supervisor record.** The runner can crash between writing
`launch.json` and the supervisor's record, or the supervisor can fail without status 75.
In those cases `lease-supervisor.json` does not exist and the runner recovers
automatically:

- If the lock is held, a supervisor is still starting and the runner waits.
- If the lock is free or absent, the runner lists every process command line (`ps -axww`).
- If no process contains `lease-supervise <storage>` or `-avd cvm-<machine>`, it records
  `nothingRunning: true` in `launch.json` as positive proof. Cleanup then proceeds and
  the lease fails, because a lease is never relaunched.
- If such a process exists, cleanup stays blocked. Identify it, as in step 3 above,
  and stop it; the next retry completes.

### Verification

[android-leases.test.ts](../coordination/test/control/android-leases.test.ts) runs a
real loopback controller and `HostRunner` with the native lease clock and the real
`lease-supervise` helper. It drives stand-in emulator processes (each with a
grandchild in its group) through fake adb and avdmanager. It covers:

- acquisition through queued requests and checked readiness, including the isolation
  probe and the launch flags;
- scoped control, a second lease waiting on a full host, and expiry while in use
  with the old key refused;
- proven cleanup and a clean hand-over;
- controller loss and runner loss with independent deadline enforcement;
- renewal, lost replies and UUID replay, and runner and controller restart without
  relaunch;
- cross-lease denial and a foreign serial refused by the provider;
- supervisor loss mid-lease: immediate 410, a failed lease, a reservation held until
  the operator recovery;
- a supervisor that fails with an ordinary status after spawning (cleanup blocked
  while the emulator survives) and a launch that left only its intent (automatic
  recovery);
- a guest that reaches host loopback (a real canary connection): fenced, never ready;
- the host's own lease gate for non-Android runtimes and unadvertised templates;
- supervisor refusal of ended authorization and relaunch;
- lease-key install of a 1.3 MB APK in three chunks and MP4 recording, with replayed
  lost replies, refused keys of another lease, the application and the operator, the
  per-lease upload cap and key rotation;
- expiry mid-recording (released only after lease cleanup), key rotation (the runner's
  exact-recorder proof) and release mid-recording, supervisor loss mid-recording, an unconfirmed encoder exit held until administrator abandonment,
  expiry mid-upload and mid-install (the never-installed upload released at once, the
  interrupted install's upload only after lease cleanup), and application limits.

`lease_supervisor.rs` unit tests cover the lifetime lock, the refusal before spawn, a
clock failure after spawn that still stops the whole group, and the log cap.

The native trials of 19 November 2026 ([record](../coordination/native-acceptance/android-lease-agents.md))
ran the two-agent, one-emulator case on the Mac Studio with a real API 36 emulator
and APK. The second run added the guest-to-host probe from a lease shell, supervisor
loss mid-lease and the leftover-helper check. Host and controller loss, renewal,
restart and supervisor failures during launch are fixture-covered only. The
supervised emulator's resource usage is not attributed by the
[runtime ownership](android-runtime-ownership.md) sampler, because its launch has
no recorded process birth time.

## iOS simulator leases

Enabled 21 November 2026 as an operator opt-in. An agent or CI job leases an iOS simulator
the way it leases an Android emulator: a `kind: "lease"` [request](requests.md), or a direct
`/v1/leases` acquisition, for an iOS template. It gets an exclusive, single-use simulator that
was created for the lease, a deadline enforced without the runner or the controller, and
removal only on proof.

This path is covered by portable fixtures only. No leased simulator has been created, booted
or deleted on real CoreSimulator; see [native acceptance is open](#native-acceptance-is-open).

### Decision: shared-host isolation by operator opt-in

Accepted by the owner on 21 November 2026.

**Reason.** A simulator is not a guest. Its apps are ordinary processes of the Mac host's
user. They use the host's network, can read every file that user can read and can reach host
services, including other simulators and other leases on the same host. An Android lease
fences its guest by removing the guest's network; nothing comparable exists for a simulator.

**Decision.** iOS simulator leases run in a declared isolation class, `shared-host`, for
trusted code only:

- A host advertises an iOS lease image only when that lease image itself declares
  `"isolation": "shared-host"` in the host's configuration. Without the declaration the host
  keeps refusing, whatever else is configured. There is no default, no host-wide switch and no
  environment variable that supplies it. The controller applies the same rule to the offer a
  runner reports: an iOS selector without the declaration is rejected and never eligible.
- Only an application whose immutable policy allowlists the template can lease it. The
  declaration does not widen any allowlist.
- The class is visible. The consumer sees `isolation: "shared-host"` on the template in
  `GET /v1/environments/templates`, and on the lease and its member in `GET /v1/leases/{id}`.
  The operator sees it in the host's `leaseImages` (`GET /v1/hosts`) and on the lease in the
  administrative system view.
- Everything else matches the Android lease contract: a single-use device created for the
  lease, an independent deadline, positive stop and removal proof before the reservation is
  released, credentials scoped to the lease, uncertain operations never replayed, and cleanup
  blocked rather than assumed.

Never describe an iOS lease as isolated from its host. Lease a simulator only to code you
would run as that Mac account yourself.

### iOS host configuration

A host advertises iOS lease execution only when all of these hold. Any partial configuration
keeps refusing `leaseProtocol` and `leaseImages`.

- The host runs macOS, and its provider is `ios`, or `macos` with the `ios` runtime enabled.
- `leaseClockHelper` is an absolute path to an installed `canaveral-mobile-native`.
- The iOS runtime sets `leaseSupervisor` to an absolute path to the same helper, and
  `idbCompanion` to an absolute path to `idb_companion`. `xcrun`, when set, is absolute; the
  supervisor otherwise uses `/usr/bin/xcrun`.
- `leaseProtocol: 1`, and every iOS `leaseImages` entry is exactly
  `{id, revision, arch, runtime: "ios", isolation: "shared-host"}` naming an offered iOS template.

```json
{ "provider": "ios", "storage": "/Users/operator/Canaveral/ios", "idb": "/opt/homebrew/bin/idb",
  "idbCompanion": "/opt/homebrew/bin/idb_companion",
  "leaseClockHelper": "/ABS/canaveral-mobile-native", "leaseSupervisor": "/ABS/canaveral-mobile-native",
  "leaseProtocol": 1,
  "leaseImages": [{ "id": "ios-phone", "revision": "1", "arch": "arm64", "runtime": "ios", "isolation": "shared-host" }] }
```

Size the host's `capacity` to the number of simulators it may run; requests beyond that wait.
iOS CPU, memory and disk are scheduling reservations, as for owned simulators
([devices](devices.md)).

Keep `storage` short. Each lease's control socket is `<storage>/<machine>/idb.sock`, and macOS
limits a Unix socket path to 104 bytes. When `storage` plus 46 bytes exceeds 100 bytes, or the
path contains a colon, the environment check fails: the host reports failed health and takes
no new work until the path is shortened. The same check fails when `idb_companion` is missing,
or when the installed helper cannot inventory a simulator's process tree (an older
`canaveral-mobile-native`), since such a host could never prove a stop.

The host enforces the gate itself and does not rely on the controller. A leased iOS
assignment whose template is not an advertised, declared `leaseImages` entry is never started:
the host stops it and reports `error`, which fails the lease. The provider checks the
declaration and the operating system again before every leased command. Neither check reads
the host's configuration for the platform: only test fixtures can inject one, in code.

Run the host so that stopping or restarting it does not kill the detached lease supervisors.
How a macOS launchd job treats them is not verified; see
[native acceptance is open](#native-acceptance-is-open).

### Device ownership

Each lease gets its own CoreSimulator device set, `<storage>/<machine>/device-set`, and one
simulator created in it for the lease (`simctl --set <device set> create`). Xcode, Simulator
and a plain `simctl` do not list it.

Every later command names that device set (`simctl --set <device set> ...`). idb reaches the
simulator only through the lease's own companion socket; it never looks a leased simulator up
by UDID in the account's default device set. For a lease the runner never reads, changes or
deletes anything in the default device set, so a personal or project simulator cannot be
adopted, touched or deleted.

Ownership is rechecked before every command. The device set must hold exactly one simulator.
Its UDID must match the creation receipt (`simulator.json`), its name must be `cvm-<machine>`,
its runtime and device type must match the pinned template, and its data path must lie inside
the device set. Anything else refuses the command. The next reconcile then fences the lease
and reports `error`, which fails it.

Nothing is adopted. A creation whose outcome is uncertain is never repeated: the lease fails
at its provisioning timeout, and cleanup removes whatever the attempt left in the device set.

### Simulator deadline and stop proof

The lease supervisor is the same `canaveral-mobile-native lease-supervise <storage>` process as
for Android, with the same authorization file, lifetime lock, refusal status 75, sticky fence
marker and 100 ms check ([independent deadline and stop proof](#independent-deadline-and-stop-proof)).
Two things differ.

**The supervised child is the lease's control companion**, not the simulator:
`idb_companion --udid <udid> --device-set-path <device set> --grpc-domain-sock <storage>/idb.sock`,
in its own process group. Its output goes to `companion.log`, capped at 16 MiB.

**The simulator is not a child of the supervisor.** CoreSimulator starts a simulator's
`launchd_sim` through launchd, so there is no process group the supervisor could own. Killing
the supervisor's own `simctl` client does not stop what CoreSimulator already began for it. The
supervisor therefore uses two sources and needs both:

- **CoreSimulator's own state for the device**, read with
  `simctl --set <device set> list devices --json`: `Shutdown`, `Booting`, `Booted` and so on, or
  absent from the set. A query that is not answered is never read as shut down.
- **The process table** (`ps`), for the simulator's process tree.

#### Tree membership, and what can be signalled

A member of the simulator's tree is exactly one of these. They are also the only processes the
supervisor can ever signal.

1. The device's own `launchd_sim`: a process named `launchd_sim` whose argument is a path inside
   the lease's device directory, `<device set>/<UDID>`.
2. A process whose command line begins with that device directory: an executable started from
   inside the lease's own device, as an installed app is.
3. A process recorded earlier as a member, while its PID still holds a process with the
   recorded start time.
4. A live descendant of any member.

A process that only mentions the device set is not a member and is never signalled: an
operator's `tail` or shell, the runner's own `simctl --set` calls, the companion, or a path that
merely contains the device directory. The supervisor and its ancestors are never members.

Every signal is sent only after that PID's start time was read again immediately before it
(`ps -p <pid>`) and matched the recorded one. Without a pidfd the gap between that read and the
signal cannot be closed, only kept that narrow.

#### What the supervisor does

- It refuses to start (status 75) unless CoreSimulator reports the device `Shutdown` and no
  member exists. That also refuses a host whose CoreSimulator does not answer.
- It records `lease-supervisor.json`, which names the device set and the UDID, and starts a
  sampling thread. That thread takes the inventories: every 250 ms until the device's
  `launchd_sim` has been seen, then every 2 s. It saves the members (PID and start time) in
  `lease-tree.json`, so that a process which outlives `launchd_sim` is still found after it
  has been reparented.
- The supervision loop only reads what the sampling thread last recorded. An inventory is
  bounded at 10 s, and even a stalled one cannot delay the deadline, fence and signal check.
- Only then does it boot the simulator, with `simctl --set <device set> boot <udid>`. The boot
  may take up to 120 s and the deadline is checked throughout. `simctl` output goes to
  `simulator.log`. The runner never boots a leased simulator and never uses `bootstatus -b`.
- It stops when the deadline passes, the authorization is fenced, missing, malformed or bound
  elsewhere, the clock fails, it receives SIGTERM, the companion exits, the boot is refused or
  times out, or the device's `launchd_sim` disappears on its own. It also stops, with reason
  `unobserved`, when CoreSimulator accepted the boot but the device's `launchd_sim` never
  appeared in the process table within 30 s: a simulator whose stop could not be proven does
  not keep running.

#### The stop

1. It writes `lease-fenced.json`. Device commands are refused from here on.
2. It stops the companion's process group (SIGTERM, 5 s, SIGKILL) and waits until the group is gone.
3. It then repeats the following, every 500 ms, and **does not return on absence of evidence**:
   - it takes an inventory and records every member in it, including any that a member started
     during the stop;
   - it reads the device's state from CoreSimulator;
   - while that state is anything but `Shutdown` or absent, it asks for
     `simctl --set <device set> shutdown <udid>` (at most 30 s), and asks again every 5 s;
   - 5 s after the first shutdown request, or after the stop began when none was needed, it
     forces whatever members remain. It first stops them (SIGSTOP), re-reading the inventory
     until no member is left running, so that none can start another process between an
     inventory and its signal. Then it kills them (SIGKILL);
   - the stop is proven only when CoreSimulator reports the device `Shutdown` (or absent) and
     no member is present, in every sample of a 5 s settling period of at least five
     consecutive samples. Any other sample starts the period again.
4. It writes `lease-stopped.json`, then releases the lock by exiting. Beside `groupAbsent` the
   receipt carries `deviceState`, `settledSeconds`, `treeAbsent`, `treeObserved`, `treeForced`,
   `bootStatus` and `shutdownStatus`.

While the device is `Booting`, or CoreSimulator does not answer, the supervisor keeps its lock
and keeps going, however long the process table stays empty. A boot that a fence interrupted
and that completes later is therefore shut down by the same supervisor. The settling period
covers the moment after its `simctl` client was killed in which CoreSimulator may already hold
the boot request while still reporting `Shutdown`.

`treeAbsent` is true only when the settling period completed, the tree record lost no member
(more than 1,024 alive at once marks it `truncated`), and one of these holds:

- the device's `launchd_sim` was observed at some point (`treeObserved`), so its absence means
  something; or
- the boot command was never sent or returned a definite failure, and CoreSimulator
  gave no indication that the device left `Shutdown`. If the boot was interrupted,
  timed out or lost its exit status, cleanup requires an observed tree.

A simulator that CoreSimulator booted but whose `launchd_sim` was never seen gets
`treeAbsent: false` and `treeObserved: false`. The premise that the tree is visible in the
process table did not hold for it, so an empty table proves nothing. It is reported as
unproven, never as absent, and its cleanup stays blocked.

#### What the proof establishes

When the receipt was written, on this host and among the processes this macOS account can see:

- CoreSimulator reported the device `Shutdown`, or no longer listed it, throughout the
  settling period;
- no member of the tree was present throughout that period, and the device's `launchd_sim`
  had been seen earlier (or the device never left `Shutdown`);
- the companion's process group was absent.

#### What it does not establish

- **A process that a member started and that outlived it unrecorded.** A member can start a
  child and exit, or the child's parent can exit, between two samples. The child then names
  nothing, descends from nothing and is not found. The target sampling intervals are 250 ms before the tree is first observed, 2 s
  during the lease and 500 ms between graceful stop passes. Process inventory
  and CoreSimulator calls can extend the gap between stop samples. It exists for the whole lease, not only at its end. The forced path closes it
  by stopping members before killing them; the graceful path cannot.
- **Work handed to the host outside the tree**: a launchd job the simulated code registered, a
  host service that launchd started on its behalf, a file it wrote outside the device set, or
  anything it did to another process of the same account.
- **Processes of other accounts**, whose command lines are not visible.
- **The premise itself.** That `launchd_sim` is named and argued as assumed, and that
  CoreSimulator's state changes as assumed, was never checked on a real host. Where the premise
  fails, the result is unproven and blocked, as above.
- **The settling period.** Five seconds is a judgement; no real boot was interrupted to time it.

These limits follow from the `shared-host` class; the supervisor does not hide them.

#### What the runner accepts for cleanup

Positive evidence only. An unanswered question is a negative answer.

- **With the supervisor's receipt.** The receipt itself must state the proof: `groupAbsent` and
  `treeAbsent` true, and `deviceState` `Shutdown` or `absent`. A fresh check must agree:
  CoreSimulator still reports the device `Shutdown` or gone, and
  `canaveral-mobile-native lease-simulator-status <storage> <device set> <udid>` still shows no
  member. The command's exit status (`shutdownStatus`) is not evidence either way; the
  device's state is.
- **Without a receipt** (the supervisor was lost). The companion's PID and process group must be
  positively absent. The device's `launchd_sim` must have been observed, by the supervisor's
  record or by the runner since, unless no supervisor record exists, in which case no boot was
  ever issued. And the device must be `Shutdown` or gone with no member present in every
  check of a 5 s settling period (at least three checks, at most one a second).
- **A launch that never reached a supervisor.** CoreSimulator must report every simulator in
  the lease's device set `Shutdown`.

A held lock, a receipt without the proof, a device CoreSimulator does not report as shut down,
an unavailable inventory, a tree that was never observed or a record that lost members all
stay unproven. The proof is recorded once it holds; storage is single-use and nothing boots
that simulator again.

### Simulator readiness

A leased simulator reports `running` with `accessReady: true` only after all of these:

1. CoreSimulator lists it as `Booted` in the lease's own device set.
2. It is owned, by the checks under [device ownership](#device-ownership).
3. Its boot has finished: `simctl bootstatus <udid>` returns.
4. The install service answers: `simctl listapps <udid>`.
5. The launch service answers: the device's launchd runs `simctl spawn <udid> launchctl print system`.
6. The lease's companion describes this UDID as booted (`idb --companion <socket> describe`).

The result is recorded once per launch in `lease-ready.json`, with `isolation: "shared-host"`
and `networkIsolation: "not-probed"`. Until then the simulator reports `starting` with a
detail, and the provisioning timeout fails a lease that never becomes ready. A companion that
answers for another device fences the lease.

**There is no network isolation probe for this class.** Android's readiness proves that the
guest cannot reach the host. A simulator shares the host's network and nothing restricts it,
so there is no such claim to check. A leased iOS app can reach the internet, the LAN, the
controller and every loopback service of the host.

### iOS scoped control

The application exchanges its key for a lease-scoped credential, exactly as for Android. Only
that credential authorizes the lease's operations, which resolve to the lease's own simulator.

| Need | Action | Capability |
| --- | --- | --- |
| Install a build | Upload the simulator `.app` archive through the lease key with `format: "ios-app-tar"`, then `install-uploaded` | files |
| Launch, stop, list or remove apps, open a URL | `launch`, `terminate`, `apps`, `uninstall`, `open-url` | files |
| Logs | `logs` (the simulator's last minute, at most 1,000 lines and 512 KiB) | files |
| App-container files | `list-files`, `push` (up to 512 KiB), `pull` (up to 4 MiB), each with `app` | files |
| Screens | `screenshot` (PNG), `hierarchy`, `accessibility`, `accessibility-action` | screenshot, hierarchy |
| Input | `tap`, `swipe`, `text`, `key` | input |

iOS has no shell capability: `command` and `pty` stay `false` for an iOS template, and
`shell` and the `shell-*` actions are refused with `capability_unsupported`. App lifecycle and
logs therefore cannot depend on `command` as they do on Android. On an iOS member they need
`files`, the capability that already covers installing a build and reading its app container.
This is a mapping, not a new capability: the capability set on the wire is unchanged.

`install` (a host-configured artifact), `permission`, `location` and `rotate` are not lease
actions on either platform.

**What a lease holder sees of the host.** `simctl` output carries the host's layout, so a
lease result is not passed through raw:

- `apps` returns `apps`, a list of `{bundleId, name, version, type}`, and `output`, the bundle
  identifiers one per line. The raw listing, with each app's absolute host paths, is never
  returned; a listing that cannot be read fails the action.
- `logs` returns the last 1,000 lines (at most 512 KiB) with `truncated`. In it, and in every
  other text result, the device directory, the device set, the lease's storage, the storage
  root, the runner's state directory and the account's home are replaced by `<device>`,
  `<device-set>`, `<lease>`, `<storage>`, `<state>` and `<home>`, and the device's UDID by `<udid>`.

Still exposed under this class: the log text of every process in the simulator, system and
app, which can include the Mac's host name, runtime paths under `/Library/Developer` and
anything a process chose to log; host process IDs (`launch` prints one); and app-container
file names. This is tidiness, not a boundary: code running in the simulator can read the
host's files and environment directly.

The upload, chunk, publication, replay and install rules, the four-uploads-per-lease and
2 GiB-per-application limits and the release-only-on-proof rules are those of
[lease recording and large installs](#lease-recording-and-large-installs). The archive is
staged and extracted in a private `.artifact-*` directory of the lease's own storage. The
provider rechecks the supervisor and the simulator's identity before staging, before
`simctl install` and after it. An app-container path must resolve inside the lease's device
set.

**Lease recording is refused on iOS** (`409 capability_unsupported` on
`POST /v1/leases/{id}/video-sessions`, and again in the provider). It was left refused rather
than wired and marked unaccepted. The administrative iOS recording path fails natively at
idb's stop (idb-cli 1.7.8 exits 1 after the graceful interrupt), so every lease recording
would end with unproven cleanup. Its capture process is also not scoped to the lease's device
set. The administrative video and app-artifact routes refuse a leased simulator, as they
refuse a leased emulator.

The leased live display stream and lease file sessions are not accepted for iOS leases, as for
Android.

### iOS expiry, release and loss

At expiry or release the controller refuses the old credential at once, fails queued
operations and issues the cleanup intent, as for Android. The runner fences the supervisor,
whose stop takes at least its 5 s settling period. Cleanup then needs the stop proof above. With it, the runner deletes the simulator through
CoreSimulator (`simctl --set <device set> delete <udid>`, only when the set holds nothing but
this lease's shut-down simulator), removes the whole storage directory through the recoverable
quarantine path, erases the assignment's credential directory and only then reports
completion. The controller releases the host and application reservations on that report.

A lease is never relaunched. The conservative fence, the "renew early" rule and the outcomes
of controller loss and runner loss are those of the
[Android section](#expiry-release-and-loss). A restarted runner recovers a running leased
simulator without creating or booting anything.

**Supervisor loss** (killed or crashed without a stop receipt): nothing enforces the deadline
any more, so the lease ends at once. Device commands get 410 as soon as the lock is free. On
its next reconcile the runner fences the authorization and reports `error`, which fails the
lease. Cleanup then waits for stop proof.

### Simulator cleanup recovery

While stop proof is missing, cleanup reports `blocked`, the host, application and lease
reservations stay held and the runner retries with backoff. There is no administrator override
that releases them without proof. The reasons are:

- `execution_pending`: the supervisor's lock is held (it is still stopping, or waiting for a
  device that is `Booting` or for a CoreSimulator that does not answer), the simulator's tree
  or the companion is still present, the inventory is unavailable or `unknown`, CoreSimulator
  does not report the simulator as `Shutdown`, the settling period has not passed, or the tree
  was never observed;
- `ownership`: the device set holds a simulator the lease did not create. Nothing is deleted;
- `storage_removal`: the device set could not be listed, or the delete was not confirmed.

Recovery after supervisor loss:

1. Confirm that `canaveral-mobile-native lease-status <storage>/<machine>` reports
   `"supervisor": "free"`, so no supervisor is running.
2. Read `<storage>/<machine>/lease-supervisor.json`. It names the device set and UDID
   (`simulator`) and the companion's `childPid`, which is also its process group ID.
3. Shut the lease's own simulator down in its own device set:
   `xcrun simctl --set <device set> shutdown <udid>`. Never run this without `--set`.
4. Confirm that the companion's command line names `--device-set-path <device set>`, then stop
   that process group.
5. Check `canaveral-mobile-native lease-simulator-status <storage>/<machine> <device set> <udid>`.
   Once it answers `"tree": "absent"` with `"observed": true`, and CoreSimulator lists the
   simulator as `Shutdown`, the runner's settling period starts. After it, the next retry
   deletes the simulator, removes storage, erases credentials and reports completion.

**A supervisor that does not exit.** While its lock is held after a fence, the supervisor is
still enforcing: it is waiting for CoreSimulator to report the device `Shutdown`. Check
`simulator.log` and `xcrun simctl --set <device set> list devices`. Do not kill the supervisor
to unblock cleanup; shut the simulator down in its own device set and it finishes by itself.

**A tree that was never observed.** A receipt with `treeObserved: false` and `treeAbsent: false`,
or a lost supervisor whose `lease-simulator-status` shows `"observed": false`, has no automatic
recovery. It means that the device's `launchd_sim` never appeared in the process table in the
assumed form, so the runner cannot tell a stopped simulator from an invisible one. The
reservations stay held. This is the outcome to expect if the process-table premise does not
hold on a real host, and it is the first thing a native trial has to settle.

A reused PID that still shows as present keeps cleanup blocked. Wait for it to disappear;
never signal an unidentified process to unblock cleanup.

### iOS lease verification

[ios-leases.test.ts](../coordination/test/control/ios-leases.test.ts) runs a real loopback
controller and `HostRunner` with the native lease clock, the real `lease-supervise` helper and
the SDK. `simctl`, idb and the companion are stand-ins. The stand-in `simctl boot` leaves a
detached stand-in `launchd_sim` with one child, neither of which is a child of the supervisor.
It covers:

- refusal without the declaration, with another class, off macOS and without the supervisor
  or companion, by the host and by the controller;
- the host's own gate for an unadvertised template and for a selector that lost its declaration;
- refusal for an application that is not allowlisted, directly and queued;
- queue then admit on a one-simulator host, and the isolation class in the catalogue, the
  lease view, the host offer and the administrative lease list;
- lease-key screenshot, input, hierarchy, accessibility, app lifecycle, logs, app-container
  files and a two-chunk `ios-app-tar` install, with UUID replay;
- refusal of shell, recording and administrative routes, and of another lease's key, the
  application key and the operator on lease-key routes;
- expiry in use, the stop receipt, deletion through CoreSimulator and a clean hand-over;
- renewal, and a runner restart that recovers the live simulator without creating or booting;
- supervisor loss: immediate 410, a failed lease and a reservation held until the tree is gone;
- runner loss: the supervisor alone shuts the simulator down at its deadline;
- a lease released while its simulator is still booting: the boot completes late, the same
  supervisor shuts it down, and no receipt or removal comes first;
- a simulator whose processes do not name their device: reported unproven, cleanup blocked;
- cleanup blocked while the inventory is unavailable or `unknown`, despite a stop receipt;
- a boot that fails, and a foreign simulator in a lease's device set (fenced; removal refused);
- the provider's own refusal without the declaration or off macOS, before any native call;
- `apps` and `logs` without host paths or the device identity;
- in every scenario, that no command reached the default device set.

The stand-in `launchd_sim` is named and argued like the real one. That is the unverified
premise the proof rests on, so the fixtures show the mechanism, not that the premise holds.

`lease_supervisor.rs` and `simulator_tree.rs` unit tests run real stand-in processes under the
real supervisor loop. They cover a graceful shutdown with its settling period, a tree member
that outlives its parent, a shutdown command that fails (with a bystander that only mentions
the device left alone), a simulator that stops by itself, a refused boot, an interrupted boot
that completes late, a device that stays `Booting` longer than the settling period, a booted
simulator whose tree is never observed, a stalled inventory that does not delay the fence,
a foreign, occupied or unreported device refused before anything spawns, a command killed at
its limit with its pipe still open, and a signal refused for a PID with another start time.

### Native acceptance is open

Nothing in this section has run against real CoreSimulator, Xcode or idb. The repository's
policy required operator authorization for native runs, and none was given for this work. The
flags used were read from `simctl` and `idb_companion` help text and from the idb 1.7.8 client
source, not from a run. The [unexecuted trial plan](../coordination/native-acceptance/ios-lease-simulators.md)
turns the list below into checks. Each of these needs a native trial before an iOS lease is relied on:

- creating, booting, shutting down and deleting a simulator in a private device set under the
  host's service account, including long or space-containing storage paths and whether
  CoreSimulator leaves files outside the device set (for example under `/private/tmp`);
- whether `launchd_sim` is named and argued as assumed and installed apps run from inside the
  device directory, which the tree identification depends on, and how fast a real tree
  changes between samples;
- what CoreSimulator reports while a boot is in flight and after its client was killed, and
  whether five seconds of `Shutdown` with an empty tree is long enough to rule out a late boot;
- whether `simctl shutdown` works on a device that is still `Booting`, and whether it returns
  only after the tree is gone;
- whether stopping and killing `launchd_sim` and its tree leaves CoreSimulator reporting the
  device `Shutdown`. If it keeps reporting `Booted`, the supervisor never finishes;
- `idb_companion` started before the boot with `--device-set-path` and `--grpc-domain-sock`,
  and `idb --companion <socket>` for `describe`, `ui` input and `ui describe-all`;
- the readiness probes on a fresh device, and how long a first boot takes;
- that restarting the host under launchd leaves the detached supervisors running;
- several leased simulators booted at once, and their real CPU, memory and disk use, which
  nothing attributes or limits;
- controller loss, runner loss, supervisor loss, renewal and expiry in use on a real simulator;
- the leased live display stream, lease file sessions and lease recording.

## Acceptance boundaries

Portable tests exercise real temporary HTTP/controller workers and an outbound
runner with a device-free provider, plus Android PackageManager pipe fixtures,
iOS archive/filesystem fixtures, native video source fixtures, a bounded synthetic
encoder, actual WebSocket relay and SDK frame/APNG/MP4-envelope verification. They verify transfer,
authorization, digest, ownership, deduplication, reservations and failure handling.
They do not prove an APK or simulator build runs on an actual device, or that a
real encoder produces playable video. The Android dashboard trial of 19 November
2026 produced FFmpeg-encoded MP4s that ffprobe, FFmpeg and Chromium decoded; iOS
encoding remains unaccepted. Android recorder cleanup with an unreachable device,
foreign AVD, lost assignment or SIGKILL escalation is fixture-covered only; the
native trial exercised SIGTERM cleanup after Cancel and leaving the page.

Host choice is deferred. Before production use, verify each selected host's SDK,
acceleration, Xcode selection, installed runtime and input/accessibility support;
then test real CI build delivery, installation, launch, frames/recordings, concurrent
input, reconnect, cancellation, expiry and positively owned cleanup. Keep resource
overhead, iOS scheduling-only limits and unsupported capabilities explicit. No
native simulator trial, service enrollment or deployment is recorded as completed.
