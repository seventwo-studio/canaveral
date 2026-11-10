# Local guest workspace and accessibility

The local workspace supports Linux desktop VMs alongside Android emulators and
configured iOS simulators. It uses the existing authenticated operation API for
files, shells and native accessibility data. Displays use one authenticated dashboard WebSocket/RFB contract and viewer. These are local delivery capabilities,
not completion of consumer leases or every platform/backend combination.

## Linux desktop setup

New Linux management helpers acknowledge `push` and streamed uploads with
`durable: true` only after syncing file contents and the published directory
entry. This adds no per-file size limit; bounded discrete operation envelopes
remain separate from the streaming drive. Older running helpers do not report
this acknowledgement and are not silently upgraded. A committed file is not a
claim that an application's unrelated in-memory state has been saved.

New assignments receive current management-helper code and per-instance access
credentials, even from an older base image. This does not mutate the immutable
image or replay a captured source's custom installation commands. Provisioning
syncs guest/access state and its completion marker before publishing readiness.
The controller retains the durable preparation receipt separately from live
`guestConnectionReady`; current runners probe the guest connection after restart
before reporting ready. Legacy unreported connection readiness remains null.

Install the TypeScript runtime dependencies, then use an already installed
compatible ARM64 Linux cloud disk and signed Apple runner. Local launch requires
that the selected provider is wired to the TypeScript host; otherwise it must
return an explicit unsupported result before creating resources:

```sh
npm --prefix coordination ci --ignore-scripts
npm --prefix coordination run build
node coordination/dist/src/cli.js local \
  --android-sdk "$HOME/Library/Android/sdk" \
  --linux-image /absolute/path/ubuntu-arm64.qcow2 \
  --apple-runner /absolute/path/CanaveralVMRunner
```

The controller and dashboard remain bound to loopback on 8875 and 8876. The Linux
runner has separate state and storage under `state/local/`; the original Android
identity and devices are retained. The generated Linux image uses 2 vCPUs, 4 GiB
memory and at least 32 GiB disk. Review the generated host limits alongside any
other runners on the same physical machine. Installed images and runtimes are not
downloaded by the launcher. Guest preparation installs XFCE, TigerVNC, AT-SPI,
screenshot tools through the guest's package manager. The TypeScript/Rust guest
service must be installed before readiness can be acknowledged; a legacy helper
payload is not an implicit runtime fallback.

The guest desktop account has passwordless sudo for full administration of this
owned VM. Each assignment receives its own guest service token and SSH host key;
the host pins that preinstalled public key instead of trusting an SSH scan.
The helper and VNC listen only on guest loopback. HTTP control travels through an
SSH forward and requires the guest token. VNC travels over private SSH stdio to
the gateway; it opens no unauthenticated host VNC listener. Neither guest tokens
nor host connection addresses are returned to browser JavaScript.

Preparation readiness is acknowledged by the assigned host only after it reaches
the authenticated helper over verified SSH and observes the completed preparation
marker. This Linux access mode does not require exposing the local controller to
the guest. Existing cloud-init callback behavior is retained for other images.

## Headless Linux setup

A Linux image with `guestAccess: true` and `mode: headless` receives the
`canaveral-headless.service` profile. Its service requires the matching Rust or
TypeScript guest runtime, curl and OpenSSH without
XFCE, VNC or AT-SPI. The existing guest account and file paths stay compatible
with shell and file access. Switching profiles disables only the other Canaveral
service. New assignments refresh managed helper code while preserving source
image recipes and application files.

The authenticated health response includes `mode`. Headless readiness requires
an explicit matching mode and `ready: true`; a legacy mode-less response is
accepted only for desktop images. A running/prepared guest without positive
connection readiness is not ready for consumer access. Headless shell and file
capabilities remain available; display, screenshot, input and hierarchy are
unsupported and rejected before opening graphical transports. Isolated recipe,
helper, catalogue and concurrent PTY fixtures pass. Native provisioning and the
full consumer lease lifecycle remain acceptance gates.

## Workspace behavior

**Desktop** opens the live display in view-only mode. **Take control** enables
mouse, dragging, scrolling and keyboard input in that connection. **Release
control** returns it to view-only mode. This is an input mode for that client,
not an exclusive cross-client ownership lock. Fit/actual-size, fullscreen and
clipboard-to-guest controls are available. Escape remains guest input rather than
closing the workspace. Clipboard extensions depend on the guest/client support.

**Files** navigates the guest filesystem, shows available size/modified metadata,
filters entries and previews UTF-8 text. Binary files can be downloaded. Drive uploads and downloads stream without a per-file size cap. Available guest
storage and filesystem constraints apply. Uploads use a temporary file and replace
the destination only on completion; interruption cleans up the temporary file.
The browser shows upload progress and cancellation. Inline previews and directory
listings remain bounded; these bounds do not cap file transfers. Guest account
permissions apply.

**Terminals** opens independent persistent PTYs. Each retains its own working
directory, environment and processes; output uses byte offsets and a bounded
64 KiB tail. There is no application-defined shell count cap; users and agents decide how
many sessions to open.
The local terminal uses an authenticated WebSocket for direct input/output,
independent of the durable machine-operation queue. Reads poll the attached PTY
at roughly 50 ms; keystrokes are sent immediately, with no 80 ms input debounce
or one-second browser output poll. Writes are ordered per connection, never
automatically replayed after disconnect. Resize messages share that connection.
Established terminal streams do not occupy the short HTTP request pool or impose
a shell count cap. They require a locally attached runner; remote interactive
shell routing still needs the outbound broker. Shell creation/closure retain
durable operation receipts.
Closing the workspace requests closure. Browser reload/sign-out can leave a PTY
until its ten-minute activity timeout. Linux PTYs live inside the guest; losing
the host transport does not promise to terminate detached guest processes.

The live desktop gateway has no application-defined connection-count cap.
Established screen streams release the short HTTP request slot, as terminal
streams do; available operating-system resources remain the limit. It checks
same-origin upgrade requests and a valid administrator account session
before opening a guest channel. It rechecks session validity, owned machine state
and attached host freshness while connected. Logout, stopping the guest or losing
contact closes the channel. Remote runners without a locally attached connector
use the separate [outbound transport](access-transport.md), whose consumer-lease
and cross-network acceptance remain open.
Provider connections close even if the WebSocket upgrade or stream fails.
Disposable gateway fixtures keep 40 screen streams open while ordinary inventory
requests still succeed; they do not establish native provider scale or throughput.

## Native accessibility for machines and simulators

Submit `accessibility` through `POST /v1/machines/{id}/operations`, then poll
`GET /v1/operations/{operationId}` as with other durable operations. CLI callers
can use `device <machine-id> accessibility --request-id <uuid>`. The command name
is retained for compatibility even when the target is a Linux VM.

A snapshot includes:

- `snapshotId`, `capturedAt`, native `source` and `coordinateSpace`;
- a flat `nodes` list with snapshot-local `id`, `parentId`, depth, role, name,
  native identifier, states, actions, bounds and native properties;
- `truncated`, coverage limitations and unavailable-node counts where available;
- a PNG `frame` captured alongside the inspection for agents that need visual
  context. Capture and tree traversal are sequential, not an atomic OS snapshot.

Linux uses the desktop session's AT-SPI bus; Android uses UI Automator XML; iOS
normalizes idb's accessibility output. Linux/Android bounds use screen pixels;
iOS bounds use points. Linux text/value/description information is included when
its interfaces expose it. Android password text is redacted. Custom-rendered
controls, applications without accessibility support and unavailable nodes can
be missing; an empty tree never proves that the desktop has no controls.
Inspection is bounded by node/depth limits and the operation result envelope.

The workspace's **Inspect** panel refreshes automatically while visible, with
a pause control. Reads do not overlap or run while the page is hidden. Live
inspection uses a transient read endpoint and omits PNG payloads; durable agent
snapshots still include their screen capture. Recent snapshot targets remain
valid independently for 15 seconds unless the native target changes. The panel searches roles, labels, identifiers and native
properties, shows element details and copies the structured JSON. Returned
native actions can be submitted as `accessibility-action` with `snapshotId`,
`nodeId` and `nativeAction`. Linux resolves the native object again and checks its
identity and bounds before invoking an exposed AT-SPI action. Simulators currently
expose click targeting through revalidated native bounds. Targets expire after
15 seconds; changed or expired targets require another inspection. IDs are not
stable selectors across snapshots. Durable action receipts retain existing
uncertain-outcome/no-silent-replay behavior.

iOS normalization and targeting have fixture coverage; live iOS acceptance remains
open. Windows/macOS accessibility providers and their guest connections are not
implemented by this Linux slice. Machine responses expose capability flags so
clients can distinguish configured guest/device features.

## Shared display and control contract

`GET /api/v1/machines/{id}/desktop` upgrades to a same-origin authenticated
WebSocket carrying binary RFB 3.8 for every attached display. The dashboard uses
one viewer, connection lifecycle, view-only default, Take/Release control,
fit/actual size, fullscreen and reconnect controls for VMs and simulators.
Switching away from the display closes its connection and releases client input;
returning reconnects in view-only mode. Native accessibility uses the same
inspection endpoint and normalized node schema across providers.

Linux forwards its native VNC session. Android and iOS adapters serve native PNG
captures using negotiated TightPNG encoding through a private socket, without
creating screenshot operation receipts. Capture is demand driven, limited to at
most four captures per second; actual SDK latency can be lower. This is an
initial live frame stream, not a high-frame-rate video encoder. Display rotation
uses RFB DesktopSize updates. Native VNC input remains continuous; simulator
left-clicks become taps, drags and wheel events become discrete swipes. SDK
commands are serialized and never automatically replayed on connection loss.
Simulator keyboard translation supports printable ASCII, arrows, Enter, Tab,
Backspace and Delete, with Home/Back toolbar navigation. Modifier shortcuts,
multitouch, pressure, mouse hover and arbitrary Unicode input are not implemented
by this adapter. iOS pointer coordinates convert screenshot pixels to native
points using idb's reported display density. Each gesture uses one density
observation for all its endpoints, so separate metadata reads cannot distort a
swipe. Missing, boolean, nonpositive or nonfinite density and unrepresentable
coordinates refuse input before native dispatch. This does not make metadata
sampling atomic with device rotation or prove native coordinate delivery.
See [idb target metadata](https://github.com/facebook/idb/blob/main/idb/common/types.py)
and [target describe](https://github.com/facebook/idb/blob/main/idb/cli/commands/target.py).

| Platform | Shared display/control | Files / shells / accessibility |
| --- | --- | --- |
| Prepared Linux desktop | Native VNC stream; continuous mouse/keyboard | Guest filesystem / independent PTYs / AT-SPI |
| Android emulator | TightPNG frame stream; translated touch and keys | Guest permissions / independent PTYs / UI Automator |
| iOS simulator | Same adapter/viewer; live acceptance still open | App container / no shell / idb accessibility |
| Windows and macOS VM | Guest access adapter remains open | Guest services and native accessibility remain open |
| Headless Linux without guest access | No graphical display claimed | Access-service provisioning remains open |
| TV and paired Watch | Runtime/schema and live acceptance remain open | Do not infer support from the phone adapters |

Machine `capabilities.desktopStream` describes configured provider support, not
proof that every dashboard has an attached connector or that preparation is
complete. The workspace uses declared capabilities to select supported services.
Existing compatibility responses without capability flags retain a fallback.
Remote providers still need an outbound broker before this local display route
can reach them. The unified contract does not mark those platforms delivered.

Local display connections and outbound broker workers now use the same
runner-owned input arbiter. New viewers start view-only; Take control waits for
the runner's acknowledgement. Other viewers cannot bypass that state with raw
RFB input. Release/disconnect resets native held input or cancels an unfinished
simulator gesture. Uncertain resets block further ownership until boot recovery
is positively established. See [display ownership](access-transport.md#display-ownership)
for the protocol, receipt and fixture verification limits. Queued discrete input
now acquires the same exclusive claim. The active viewer sends accessibility
actions through its owned stream, while read-only inspection remains independent.
Receipt inspection is read-only and never retries input. The updated Linux helper
reports definite target-validation refusals separately from uncertain execution;
older guest helpers require an explicit update before relying on that distinction.

## Image revision availability

A host may set `offerTemplateRevisions` to keys such as
`ubuntu-desktop@3:arm64`. Only those installed definitions are offered for new
creation; other configured revisions remain available to reconcile existing
assignments. Public immutable definitions and machine ownership must still match.
This compatibility setting is not a substitute for the planned base/derived image
catalogue or VM-to-image capture workflow.


## Streaming file API

Attached local providers expose `POST /api/v1/machines/{id}/files/upload` with a
raw file body, `Content-Length`, a percent-encoded guest path in
`X-Canaveral-Path`, and `X-Canaveral-App` for iOS app containers. The endpoint
streams in bounded buffers and has no total file-size limit. Administrator
credentials or same-origin account cookies authorize access; cookie writes retain
CSRF checks and active transfers recheck authorization. No upload is automatically
retried after an uncertain response.

Each upload authorization callback checks the attached machine/lease even while
the account lookup is cached for one second. The cache uses suspend-aware elapsed
time on macOS/Linux. Uploads and downloads recheck after a blocking source read
and before forwarding its bytes. A cancelled local atomic upload retains the old
destination and removes its temporary; a cancelled download closes its source and
ends short rather than forwarding the late bytes. A guest upload whose response
arrives after authorization ends is uncertain: publication may already have
occurred, so it receives no success acknowledgement and is not automatically replayed.

Downloads use `GET /api/v1/machines/{id}/files/download/{destination}`, where
`destination` is URL-safe base64 of JSON `{ "path": "...", "app": "..." }`.
They stream to the browser download manager. The destination contains file
metadata, never credentials. The dashboard verifies source identity before success
headers (including empty files), then holds back the final block until a second
verification succeeds. Replacement or in-place mutation detected by the provider
ends the response short; earlier bytes cannot be retracted. Authorization is
checked again after verification, since the check can block. This is a metadata
consistency check, not an immutable filesystem snapshot or a browser-side digest.
Sources without verifiable identity are refused before file delivery. Older Linux
guest helpers need an explicit update. The Android adapter now checks device,
inode, mode, size and nanosecond modification/change timestamps. Its guest script
opens the file once and checks both that descriptor and the path before emitting
a per-transfer completion marker. The host strips and verifies the marker before
reporting completion, and checks path identity again. No host-side file copy or
total size cap is added. Android images without the required `stat` timestamp
format or descriptor support fail verification; native acceptance remains open.
The marker is necessary because [ADB's legacy exec-out implementation](https://android.googlesource.com/platform/packages/modules/adb/+/882334464c178849d2322711424d2836d4593fe4/client/commandline.cpp)
does not carry the remote command's exit status. A successful host process alone
cannot acknowledge a complete download. Fixture scripts cover replacement,
in-place changes, failed reads, excess bytes, missing markers and completion
timeouts, including the RunnerSession finish/digest path. They do not contact an
emulator. Android upload durability remains a separate gate. A
[native upload helper](android-transfer.md) now has cross-built artifacts and
configured provider/worker/SDK fixture coverage; native acceptance remains pending.

iOS streaming uses directory descriptors and refuses
symlink traversal outside the selected app container. The legacy JSON `push` and
`pull` operations retain their bounded control-message envelopes; the drive UI
uses the streaming endpoints instead.

Shell I/O uses the shell manager's own locks, so slow accessibility or UI actions
do not hold the guest server's general control lock ahead of terminal reads and
writes. Failed SSH forwarding attempts use exponential retry backoff from two to
sixty seconds; a successful guest response clears it. This avoids repeatedly
opening clients while a guest SSH service is unavailable. These changes apply to
the current helper payload; existing guests retain their installed helper until
explicitly updated or recreated.

Closing simultaneous PTYs signals them as a batch and waits outside the session
manager lock, so another terminal can continue reading and writing during the
termination grace period. A process whose termination is uncertain remains in
the closing registry for retry; it is not reported as successfully closed.

## Guest service bundle prerequisites

Prepared Linux bases must provide Node.js 24 or later at `/usr/local/bin/node`. Guest recipes verify that interpreter before service readiness; distribution `nodejs` packages are not used as an implicit version source. Build the TypeScript service bundle with `node script/build_guest_bundle.mjs`, supplying Linux ELF helpers for the target architecture. The private operator bundle supports up to 4096 files and 128 MiB; public preparation payload limits remain 100 files and 200 KB. Native AT-SPI requires a glibc-linked helper, libatspi, GLib/GObject and the desktop session bus.
