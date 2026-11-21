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
Since 21 November 2026 a lease key, and the owner of an account-owned device, can
also watch a device live ([live screen](#live-screen)); that path has fixture
coverage only. iOS simulator leases remain open.

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
A leased Android emulator takes uploads through its lease key on the same contract; see
[lease recording and large installs](#lease-recording-and-large-installs).

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

The screenshot adapter captures at no more than four frames per second; a
continuous view of a device uses the [live screen](#live-screen) instead. A separate
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
lease follows the generic [lease contract](leases.md). iOS simulators and physical
devices still refuse leased execution.

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
| Watch live | Live view ([live screen](#live-screen)) | displayStream |

App lifecycle, logs and app permissions need `command` because the Android shell
already grants them. They remain unavailable to iOS, which has no shell capability.
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

The administrative app-artifact, video and live-view routes and dashboard capture do not
accept lease credentials. Lease file sessions and the lease display session (RFB) are still
not accepted natively for Android leases. The leased [live screen](#live-screen) is
implemented with fixture coverage only.

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
least a few heartbeat intervals.

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

## Live screen

Added 21 November 2026, fixture-covered only. A live view streams a running device's
screen as H.264 in fragmented MP4 until the viewer leaves or its authority ends. It
reuses the [native video pipeline](#native-video-sessions) and the session broker:
there is no second capture path and no new transport. No native run has measured
its frame rate, latency or decoder compatibility; see [open questions](#open-native-questions-for-live-views).

Terms used below:

- A **live view** is one viewer's broker session (`canaveral-session-v1`, capability
  `live`).
- The **live capture** is the one native capture of a device that all its live
  views share. It is a video session of kind `live`: it takes the same host slot and
  reservation as a recording and is released on the same proof.
- An **epoch** is one run of the native capture, at most 180 seconds (Android
  screenrecord's own limit). A longer view continues in the next epoch.

### Who may watch

| Device | Route | Credential |
| --- | --- | --- |
| Leased Android emulator | `/v1/leases/{lease}/live-views` | The lease's current key only |
| Account-owned Android or iOS device | `/v1/machines/{machine}/live-views` | Its owner or an administrator, with `machines:access` |

A leased device's screen is visible to its lease holder only. The lease route
refuses the application key, the operator, account credentials and another lease's
key with 401, as every lease session does. The machine route refuses a leased
machine with 409, so no operator or owner view of a leased device exists. On the
machine route another account receives 404, a token without `machines:access` 403,
and a view is bound to the credential that created it: another credential of the
same owner cannot read or close it. iOS simulator leases do not exist yet; their
live view arrives with them.

| Operation | Endpoint | Body |
| --- | --- | --- |
| Create or replay | `POST /v1/leases/{lease}/live-views` | `{id, member, ttlSeconds?}` |
| Create or replay | `POST /v1/machines/{machine}/live-views` | `{id, ttlSeconds?}` |
| Read | `GET .../live-views/{id}` | none |
| Close | `POST .../live-views/{id}/close` | `{}` |
| Attach (WebSocket) | `.../live-views/{id}/{generation}` | the creating credential, as a header |

`ttlSeconds` is an integer from 10 to 120 and defaults to 120. A saved UUID replays
its view with 200; a changed member or lifetime returns 409. The response contains
`id`, `machineId`, `captureId`, `generation`, `capability: "live"`, `protocol`,
`state`, `mediaType: "video/mp4"`, `codec: "avc1"`, `fps: 30`, `bitRate`,
`ttlSeconds`, `attachBefore`, `authorizationDeadline` and, for a lease, `leaseId`
and `member`. States are `pending`, `attaching`, `ready` and `ended`; an ended view
adds `endReason` and stays readable for five minutes after it ended. The viewer
attaches within 30 seconds; the assigned runner attaches outbound at
`/v1/hosts/{host}/live-views/{id}/{generation}`. A viewer needs no route to the
machine that runs the device.

Every live capture uses 30 fps and 4,000,000 bits per second, the settings of the
natively trialled dashboard recording. They are fixed so that viewers can share one
capture.

### Stream

After the broker's `ready`, the host sends `{type:"live", mediaType:"video/mp4",
codec:"avc1", fps:30}` and then complete MP4 segments. Each segment is one control
message followed by exactly `bytes` bytes in binary messages of at most 64 KiB:

| Control | Segment that follows |
| --- | --- |
| `{type:"init", epoch, bytes}` | The initialization segment (`ftyp` and `moov`) of that epoch; at most 1 MiB |
| `{type:"segment", epoch, sequence, keyframe, bytes}` | One media segment (one `moof` and its `mdat`); at most 8 MiB |
| `{type:"end", reason}` | None. The host ended the stream; see [endings](#endings) |

`sequence` counts the fragments of the epoch from zero. A viewer's first media
segment of an epoch is always a key frame segment, so a viewer that joins later
starts at the most recent key frame the runner still holds, or else at the next
one. A viewer that cannot keep up is not disconnected: the runner drops its backlog
of more than 4 MiB and continues at a key frame, which shows as a gap in `sequence`.
The first segment after any gap is a key frame segment. A new epoch starts with a new
`init`, and a consumer restarts its decoder with it. A browser page is expected to
append it to the `SourceBuffer` it already has; no browser has been tried.

Fragments and their key frames come from the encoder: the recording's FFmpeg
arguments produce fragments of about 250 ms and a key frame every second, so a
joining viewer waits up to about a second for a picture while the screen changes.
Android emits no frames while the screen is static. A viewer that joins a static
screen then receives the cached last second of video if there was one, and
otherwise nothing until the screen changes.

The viewer sends one message only, `{type:"renew"}`. The broker answers
`{type:"renewal", renewed, authorizationDeadline}` and never relays it to the host.
The reply may arrive between any two messages, including between the binary
messages of one segment. Any other viewer message, and any binary message from the
viewer, ends the session. The packaged
[session control schema](session-protocol.md) defines `liveHost`, `liveConsumer`
and `liveBroker`.

### Lifetime and renewal

A view lives for `ttlSeconds` from the moment it becomes ready. Each accepted
renewal sets its deadline to that many seconds from now; an unrenewed view ends
with `view_expired`. Until readiness, `authorizationDeadline` is the latest moment
the view could end unrenewed (the attach window plus the lifetime); it moves
earlier when readiness starts the real lifetime. Only a ready view renews. Renewal
never renews or extends a lease, a token or any other authority: a view always
ends with its authority, whatever its deadline says. A draining host
([host maintenance](dashboard.md#host-maintenance)) accepts no renewal and no new
view, so a drain waits at most one lifetime for its viewers.

The bound exists so that a forgotten but still connected viewer, such as a
background tab, does not keep an encoder and a guest recorder running. A page should
renew only while its picture is visible.

### Sharing, limits and when capture runs

- **One capture per device.** The first view of a device admits its live capture;
  later views join it and take no further slot or reservation. All viewers receive
  the same segments.
- **Capture runs only while watched.** The runner starts the native capture when a
  viewer with current authority is subscribed and stops it when the last one
  leaves or loses authority. The capture session ends with its last view.
- **Bounds.** At most four views per device, sixteen per host and eight per
  creating credential (429 `live_view_limit`). At most one live capture per device.
  A live capture is one of the host's **four** video sessions, together with
  recordings (429 when all four are held), and reserves one CPU and 256 MiB (409
  when the host lacks them). A lease's live capture also counts against its
  application's resource limits, like its recordings (429).
- **Rollover.** While viewers remain, the runner starts the next epoch when one
  ends by itself. The picture pauses for as long as the native recorder takes to
  restart. Three epochs in a row that each end by themselves within five seconds
  end the capture as failed.

### A live view beside a recording

A device never runs two native captures at once; the regime the
[native trials](#dashboard-capture) covered stays the only one. A live capture and
a recording of one device therefore coexist as follows.

- The "one per machine" rule keeps its meaning for each kind: one recording, and
  one live capture. A live capture that is still running does not refuse a
  recording. Each holds its own host slot and reservation while both exist, so a
  host sized for exactly one capture per device refuses the second with 409 or 429,
  as it refuses any session it has no capacity for.
- **A recording takes the device.** Before a recording opens its native source,
  the runner stops the live epoch and requires the same proof as for a cancelled
  recording. The recording's start is delayed by that stop, within the bounds in
  [Android recorder cleanup](#android-recorder-cleanup-after-early-cancellation);
  the native recording trial proved a cancelled recorder stopped in about five
  seconds, and the delay for a live epoch has no native measurement. The runner
  waits at most 30 seconds for the proof.
  If the stop cannot be proven, the recording captures nothing and ends with
  `session_incomplete`; its session is cleaned because it started no capture.
- **Viewers follow the recording.** While it runs, the runner also feeds the
  recording's own stream to the device's viewers, as a new epoch. A viewer who joins
  during a recording joins that stream. The recording receives exactly the bytes it
  would have received alone, and its digest, receipt and cleanup are unchanged;
  viewers see the recording's bit rate for its duration. A stream the runner cannot
  segment ends the copy for the viewers, never the recording.
- **Afterwards.** When the recording ends with positive cleanup, the live capture
  starts its own next epoch. When the recording's cleanup is unknown, the device
  has no provable capture state: the views end with `capture_unavailable`, and the
  live capture, which ran nothing unproven itself, is reported clean.
- An ended session of either kind without positive cleanup refuses a new live
  view (409 `capture_cleanup_pending`, retryable) and a new recording (409) of that
  device, as an unclean recording already refused another recording.

### Endings

A live view ends with its authority within about a second: the broker rechecks
every view on each relayed message and every 250 ms, and the runner evaluates its
own assignment and lease authority at most 250 ms apart. Leased captures also keep
the recording path's native check of the lease supervisor about once a second.

The controller records why a view ended in `endReason`:

| `endReason` | Cause |
| --- | --- |
| `closed` | The holder closed the view |
| `view_expired` | The lifetime passed without a renewal |
| `attach_timeout` | Both peers did not attach within 30 seconds |
| `lease_expired`, `lease_released`, `lease_failed` | The lease ended. A fence or supervisor loss fails the lease |
| `key_rotated` | The lease key that created the view was rotated |
| `application_revoked` | The lease's application was revoked |
| `access_revoked` | The owner route's credential was revoked or expired, lost `machines:access`, or no longer owns the device |
| `device_stopped` | The device is no longer wanted or observed running, or was deleted |
| `host_unavailable` | The host is disabled, stale or re-enrolled, or the assignment changed |
| `capture_ended` | The shared capture ended: closed as a video session, or the runner reported it finished |
| `disconnected` | A peer's socket dropped and the controller found no other cause |
| `controller_restarted` | The controller restarted; all sessions end |

The host can also end a stream it is still serving, in-band, with `{type:"end"}`
and one of `capture_failed` (the native capture or encoder failed; it is never
retried), `capture_unavailable` (a recording of the device ended without provable
cleanup) or `capture_ended` (the capture this view belongs to is ending, or was
attempted before a runner restart; open a new view). A host whose own authority
ended sends nothing more; the controller records that cause.

A device's native side can stop a moment before the runner observes the same
ending: a lease deadline is also enforced by the native supervisor. After a failed
epoch the runner therefore waits up to a second for its viewers' own authority to
lapse before it tells the remaining ones `capture_failed`, and the SDK prefers the
controller's finding that the view's lease, credential or device ended over a
reported capture failure.

The runner enforces a lease deadline and its own assignment slightly before the
controller observes the same ending. A view is therefore first recorded as
`disconnected` when its sockets dropped, or for a lease as `device_stopped` or
`host_unavailable` when the runner had already reported its fenced emulator. Both
are provisional for three seconds: any cause the controller then finds replaces
`disconnected`, and the lease's or its key's own ending replaces a lease's device
cause. At expiry a viewer thus reads `lease_expired`, or `lease_failed` when the
runner's fence report arrived first. The SDK waits out that window before it
reports a provisional reason. A credential that was rotated or revoked can no longer
read its view; the SDK reports `credential_rejected`.

### Reservations and cleanup proof

A live capture holds its slot and reservation from its first view until proof,
by the recording path's rules. A wedged encoder never frees capacity.

- **The runner's proof.** The runner journals the capture before its first
  attachment and again before native dispatch (`work/live/{capture}.json`). When
  the last viewer leaves, each epoch has either ended by itself or been stopped
  with the exact-recorder proof, and each encoder's exit was confirmed. The runner
  then reports positive cleanup through the recording's finish route. A capture
  that dispatched nothing native is positive at once.
- **A leased emulator.** When the lease ends first, the guest recorder's stop
  cannot be proven by adb. The runner reports only its encoder's exit
  (`hostCleaned`), and the lease's own proven emulator removal completes the
  cleanup, exactly as for a lease recording.
- **An owned Android device.** Stopping a watched device ends the runner's
  authority to signal the recorder. The runner then reports only its encoder's exit,
  and the session becomes clean when the device's host reports the device
  `stopped`. The host reports that only after the emulator process has exited, and
  the recorder ran inside that process. This rule applies to live captures only;
  recording cleanup is unchanged.
- **Unknown.** An unconfirmed encoder exit, an iOS source whose stop is unproven,
  a source that failed to open, or a runner that restarted mid-capture leaves the
  session uncleaned. It keeps its reservation and its host slot, blocks further
  captures of that device and blocks the machine's deletion until an administrator
  [abandons](#deleting-a-machine-with-a-video-session) it through
  `POST /v1/machines/{machine}/video-sessions/{captureId}/abandon`, at least a
  minute after the capture ended. For an owned Android device whose encoder exit
  was confirmed, stopping the device settles it instead.
- A graceful runner shutdown stops live captures first, while the runner can still
  prove each recorder stopped. A runner that is killed leaves its captures unknown.

Machine deletion is refused while the device's live capture is live or uncleaned,
as for recordings. `GET .../video-sessions/{captureId}` shows the capture with
`kind: "live"`, `cleaned` and `hostCleaned`; closing it there ends every view of
the device.

### Input beside the stream

A live view is view-only: the stream accepts no input. A viewer sends touch, keys
and orientation through the existing durable operations, with the same credential:

| Input | Action | Route |
| --- | --- | --- |
| Touch | `tap`, `swipe` | `POST /v1/leases/{lease}/operations` (capability `input`), or `POST /v1/machines/{machine}/operations` |
| Keys and text | `key`, `text` | the same |
| Orientation | `rotate` with `orientation` | the same; lease keys since this change |

No second input mechanism exists. One input acts on a device at a time: the runner
executes each operation alone under the device's assignment lock, in the host's
queue order, with the usual caller UUID, receipt and never-replayed `unknown`. For
a lease only the lease key can submit input. For an owned device the owner and
administrators can; their operations are serialized, never interleaved. Capture
does not take that lock, so input stays available while a view runs. Use
`pollIntervalSeconds: 0.25` for interactive input; the default host poll is five
seconds. A rotation's effect on a running capture has no native run: the capture
keeps the frame size it started with at least until its next epoch.

### iOS

An account-owned iOS simulator uses the same routes and stream, through the
provider's existing `idb video-stream` source. It is **off unless the host opts in**
with `liveView: true` in its iOS runtime configuration; without it the runner
answers `capability_unsupported` and holds no reservation. The reason is the
[known idb stop failure](#dashboard-capture): on an installation where idb exits 1
after the provider's stop, every live view would end with unknown cleanup, at the
latest when its first 180-second epoch ends. Its capture would then hold a
reservation, block further views and recordings of that simulator, and need
administrator abandonment. A simulator's stop does not settle it, because the
source is a host process. Enable the option only on a host where an iOS recording
reaches positive cleanup. What can be claimed for iOS is fixture coverage of the
routes, sharing, endings and accounting; no iOS live view has run natively.

### Dashboard relay

The dashboard gateway relays an owned device's live view for a same-origin cookie
session, exactly as it relays the recording attachment; see
[owner live screen](dashboard.md#owner-live-screen). The dashboard pages that show
several screens are separate work.

### Open native questions for live views

No device, emulator, simulator, adb, idb or FFmpeg ran for this work. Open:

- Frame rate and end-to-end latency of a live view, and the delay before a
  joining viewer's first picture.
- Whether a browser's Media Source Extensions accept these segments, and a new
  initialization segment at each epoch.
- Key frame detection relies on the sample flags FFmpeg writes into each fragment
  (`trun`, `tfhd`, `trex`). The dashboard's verifier read the same flags from
  natively recorded files; the runner's parser has only seen fixture fragments.
- The picture's pause at an epoch rollover, and when a recording takes over and
  hands back.
- The first picture on a static Android screen, where the encoder may not finish
  probing its input until the screen changes.
- Encoder and recorder CPU and memory for a capture that runs for hours.
- A host on which every authority check samples the native lease clock (a helper
  process): the runner shares one evaluation per device per 250 ms, measured on
  fixtures only.
- Rotation during a view, and iOS as described above.
- Runner or controller loss during a live view is not covered, as for lease
  recordings.

### Verification of live views

- [mobile-live-leases.test.ts](../coordination/test/control/mobile-live-leases.test.ts)
  uses the Android lease harness (real controller, broker, `HostRunner`, lease
  supervisor and SDK; stand-in adb, emulator and encoder). It covers ordered
  segments through a lease key; two viewers on one capture; capture stopping with
  the last viewer; refusal of the application key, the operator and another
  lease's key; the per-device viewer limit; input beside the stream; renewal,
  expiry of an unrenewed view and close; the stream ending at lease expiry, key
  rotation, release and supervisor loss, each with its reservation released only on
  proof; a wedged encoder held until abandonment; a recording before and during a
  view with never more than one recorder on the device; epoch rollover; and the
  application's resource limits.
- [mobile-live-owned.test.ts](../coordination/test/control/mobile-live-owned.test.ts)
  uses a device-free provider behind a real controller, broker, runner, dashboard
  gateway and SDK. It covers the owner, an administrator and a non-owner; viewer
  and host slot limits shared with recordings; a device stop and the Android
  settlement rule; token revocation; an unprovable iOS stop; the iOS opt-in; a
  recording beside a view; and the gateway relay with in-band renewal.
- [mobile-live-views.test.ts](../coordination/test/control/mobile-live-views.test.ts)
  runs the controller module on real SQLite with an injected clock: the lifetime
  from readiness, renewal and expiry, the attach timeout, retention of an ended
  view, a draining host, the three-second window for a dropped socket's cause, the
  viewer and row limits, recordings beside live captures, and a controller restart.
- [mobile-live.test.ts](../coordination/test/control/mobile-live.test.ts) covers
  the segmenter, key frame detection, the wire contract against the packaged
  schema and OpenAPI document, and the runner hub in isolation.

The stand-in encoder emits real MP4 box structure around opaque payloads. These
tests prove authority, sharing, ordering, limits and accounting. They do not prove
that a real stream decodes or how fast it is.

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
