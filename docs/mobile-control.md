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
use cases require access through the job's own scoped credentials. Native lease
isolation and unattended recording remain open acceptance items.

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
not supported by this administrative artifact API. Ordinary native runners retain
their consumer execution gate pending native fencing and cleanup acceptance.

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
changes terminate authorization. Consumer lease keys do not authorize these routes.

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
or bypass that acceptance gate.

Existing [device controls](devices.md) cover gestures, text, app lifecycle, logs,
accessibility, permissions, location, small files and Android shells. iOS has no
general guest shell; exposing the Mac host shell would violate simulator scope.
Network-condition control, reset/delete/snapshot capabilities and broader native
inputs require explicit platform adapters and acceptance rather than claims of
platform parity.

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
