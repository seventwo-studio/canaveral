# Mobile host upkeep

Implemented 21 November 2026, with portable fixture evidence only. This page is the
contract for three operator-facing parts of running Android and iOS hosts:

- [runtime and system-image management](#runtimes-and-system-images): list, install and remove;
- [idle upkeep](#idle-stop) and [orphan storage](#orphan-storage): stop idle devices, report and purge storage left behind;
- [memory and disk pressure](#memory-and-disk-pressure): hosts under pressure take no new work.

No real `sdkmanager`, Xcode, runtime download, emulator or simulator has run this
code. See [verification and limits](#verification-and-limits).

## Host operations

Runtime changes and storage inspection are **host operations**: durable administrator
requests that travel to the host on its existing outbound heartbeat. The controller
needs no SDK and no inbound route to the host. Nothing else queues one: a lease, a
request or a machine creation never installs, downloads or removes anything.

| Method and route | Result |
| --- | --- |
| `POST /v1/hosts/{host}/operations` | 201 for a new operation, 200 for an exact replay; body `{id, kind, arguments}` |
| `GET /v1/hosts/{host}/operations` | The host's latest 50 operations |
| `GET /v1/host-operations/{id}` | One receipt, with `progress` while running and `result` when terminal |
| `GET /v1/hosts/{host}/runtimes` | Latest listing per platform, joined with the templates and devices that use each runtime |
| `GET /v1/hosts/{host}/upkeep` | Dry run: what idle stop and an orphan purge would do, and why |

Every route needs administrator authority: the operator credential, or an
administrator account whose session or token carries the `admin` scope. A user
account, an administrator's token without that scope, and application, lease,
enrollment, host and guest credentials are refused (403 or 401).

| Kind | Arguments | Effect on the host |
| --- | --- | --- |
| `runtime-list` | `{platform}` | Read-only listing |
| `runtime-install` | `{platform, identifier, acceptLicenses?, timeoutSeconds?}` | Installs one runtime or system image |
| `runtime-remove` | `{platform, identifier, timeoutSeconds?}` | Removes one unused runtime or system image |
| `storage-inspect` | `{}` | Read-only orphan report |
| `storage-purge` | `{inspection, entries}` | Removes named, proven orphans |

`platform` is `android` or `ios`. `timeoutSeconds` is 60 to 14400; installs default
to 3600 and removals to 900. A host accepts operations only after it has advertised
upkeep for that platform on a heartbeat (409 `upkeep_unsupported` otherwise) and
while it is online.

### Receipts and uncertain outcomes

States are `queued`, `running`, `succeeded`, `failed` and `unknown`.

- **Replay.** The UUID names one host, kind and normalized arguments. Repeating it
  returns the receipt and never runs anything again; changing any part is 409.
- **Bounded.** The host must collect and start an operation within 120 seconds. One
  the host never collected becomes `failed` (`expired`): it provably did not start.
  A collected operation without a terminal receipt becomes `unknown` at its deadline,
  which is the start window plus `timeoutSeconds` plus 120 seconds.
- **Never replayed.** The runner journals an operation before it starts. After a
  runner crash or restart the journal says started, so the runner reports `unknown`
  and runs nothing. A timeout, lost authorization or lost controller contact closes
  the installer the runner started and is `unknown` too.
- **`failed` means the change did not happen.** It is reported only when the tool
  never ran, or ran, reported a failure and the host then verified that the runtime is
  still absent (install) or still present (removal). A failed download can leave
  partial files in the SDK's or Xcode's own cache.
- **Re-inspection.** An `unknown` install or removal blocks further changes for that
  host and platform (409 `host_inspection_required`) until a later `runtime-list` of
  that platform succeeds. An `unknown` purge is acknowledged the same way by a later
  `storage-inspect`. The acknowledged receipt stays `unknown`; nothing is retried.
- **One at a time.** A host runs one install or removal per platform, and one storage
  operation, at a time. A second one is refused with 409 `host_operation_busy`.
  Android and iOS changes can overlap, and a listing never waits for a change.
- **Progress** is `{phase, percent?, updatedAt}`. `phase` is one of `starting`,
  `downloading`, `installing`, `removing`, `verifying` or `inspecting`. The percentage
  is the last one the tool printed. No tool output leaves the host: results carry fixed
  codes, numbers and public identifiers only, never host paths.

Host operations are accepted during a [maintenance drain](infrastructure.md#planned-host-maintenance),
because upkeep is maintenance work. A queued or running operation blocks the
power-off verdict. One that ended `unknown` and is not yet acknowledged is an
uncertain operation and also blocks resume, until the listing or inspection above.
A managed runtime update that has fenced admission starts no new operation.

## Runtimes and system images

A host only verifies that the runtimes its templates name are installed. These
operations let an operator inspect and change what is installed without a shell on
the host. Installing a runtime does not offer it: add a template that pins it to the
host file and restart the runner.

### List

`runtime-list` reports `installed` and `available`:

- **Android.** Installed system images are read from the SDK's `system-images`
  directory, so this part needs no network. Each has `identifier` (the package path,
  for example `system-images;android-35;google_apis;arm64-v8a`), `revision`,
  `compatible` (its ABI matches the host) and `devices` (storage directories on this
  host that pin it). `available` comes from `sdkmanager --list`. It is
  `{state: "unavailable"}` when that command fails, for example offline.
- **iOS.** Installed runtimes come from `simctl list runtimes`, with `version`,
  `build`, `usable` and `devices`, the number of simulators under the runtime
  including ones Canaveral did not create. Where Xcode supports it, each lists its disk
  `images` (`imageId`, `state`, `deletable`, `sizeBytes`). **Xcode has no command that
  lists every downloadable runtime.** `available` therefore names only the runtime the
  selected Xcode's own SDK selects (`scope: "selected-xcode-default"`). Other versions
  can still be installed by identifier.

`GET /v1/hosts/{host}/runtimes` returns the latest successful listing per platform
and adds `usedBy` to each installed entry, computed from the controller's ledger when
read:

- `templates`: every template the host configures that pins it, with `offered`;
- `machines`: every device placed on that host that pins it, with `leased`.

`requiredButNotListed` names runtimes that a template or device pins but the listing
did not find. `inspectionRequired` is true while an unknown change awaits a listing.
Reading the view runs no tool.

### Install

`runtime-install` runs only on this explicit request.

- **Android licences.** The request must carry `acceptLicenses: true`. Without it the
  controller refuses the request (400 `license_acknowledgement_required`) and queues
  nothing. The acknowledgement applies to that one request. The host answers the
  SDK's licence prompt only for an operation that carries it. The CLI sends it only
  for `--accept-android-licenses`.
- **Identifiers.** Android takes a system-image package for `arm64-v8a` or `x86_64`,
  the shapes a template can pin. iOS takes a runtime identifier with a version, such
  as `com.apple.CoreSimulator.SimRuntime.iOS-27-2`.
- **Commands.** Android: `sdkmanager --sdk_root=<androidSDK> --install <package>`.
  iOS: `xcodebuild -downloadPlatform iOS -buildVersion <version>`, using the runtime's
  `xcodebuild` setting or `xcodebuild` on the runner's `PATH` under its `DEVELOPER_DIR`.
- **Verified.** `succeeded` requires the host to find the runtime afterwards: the
  system-image directory, or a usable runtime in `simctl list runtimes`. A runtime that
  is already installed succeeds without running the tool.

### Remove

`runtime-remove` is refused while anything uses the runtime:

- The controller refuses (409 `runtime_in_use`) when a template the host configures,
  offered or retained, or a device or live lease placed on that host pins it.
- The host checks again before it runs anything, and reports `failed` with
  `runtime_in_use` when a configured template, an assignment it holds, or any device
  storage under its storage root pins it. That includes storage left behind by an
  assignment the controller no longer knows. Storage with an unreadable owner receipt
  counts against every runtime.
- **iOS** also refuses when any simulator exists under the runtime, including ones
  Canaveral did not create: `simctl runtime delete` shuts down booted simulators of
  that runtime. The runtime must be exactly one deletable disk image.

Commands: `sdkmanager --sdk_root=<androidSDK> --uninstall <package>`, and
`simctl runtime delete <imageId>` with the image the host's own listing named. Removal
is verified the same way as an install.

## Idle stop

Account-owned devices (templates with `mode: device`) persist until their owner stops
or deletes them. An operator can have idle ones stopped. **Idle stop is off unless
configured**, in the host file:

```json
"upkeep": { "idleStopSeconds": 7200, "templates": { "android-phone": { "idleStopSeconds": 3600 }, "kiosk": { "idleStopSeconds": 0 } } }
```

`idleStopSeconds` is 300 to 2592000 seconds, or `0` for off. A template entry
overrides the host value for devices of that template; its key must be a template the
host configures. The host advertises this policy on its heartbeat and the controller
applies it, because the controller holds the record of device activity.

A device is stopped when all of these hold:

- it is not leased, its desired and observed state are both `running`, and a policy
  applies to it;
- it has no work in flight: no queued or running device operation, no live video
  session, no upload in progress, no pending capture, deletion or power-off, and the
  host does not list it as busy. The host lists a device as busy while it runs an
  operation, recording or relayed display for it, and lists every running device
  while a local connector or locally attached viewer is in use;
- it has no uncertain operation: no uploaded-app install that lacks cleanup or a
  [resolution](mobile-control.md#resolving-an-uncertain-install), and no ended
  recording whose cleanup is unconfirmed and not abandoned;
- nothing has happened for the configured time since the latest of: the controller
  first seeing this run, a device operation (including an install) being submitted or
  finishing, and a video session's start or authorization deadline.

The stop sets the device's desired state to `stopped`, exactly as an owner's stop
does. The host reconciles and proves it through the provider's normal path, and
compute is released only on the confirmed stop. **Nothing is deleted**: the device, its
storage, its disk reservation and its identity remain, and the owner starts it again
with the normal start. Idle upkeep never deletes an account-owned device and never
touches a leased one; leases end by their own deadline and cleanup.

Idle stops are evaluated on a heartbeat that carries the host's policy, so a host
that is offline, or an older runner that reports no policy, stops nothing.

### Dry run

`GET /v1/hosts/{host}/upkeep` changes nothing. It returns:

- `idleStop.policy` and one entry per device with `idleStopSeconds`, `idleSeconds`,
  `lastActivityAt`, `wouldStop`, `reason` and `blockers`. Reasons are `idle` (it would
  be stopped), `active`, `policy_off`, `leased`, `not_running`, `work_in_flight`,
  `uncertain_operation` and `running_time_unknown`. `lastIdleStop` records the last
  time upkeep stopped that device.
- `?idleStopSeconds=N` previews that value for every device on the host, before
  anyone configures it.
- `orphans`: the latest storage inspection with, per entry, `controllerOwner`
  (`live`, `deleted` or `absent`), `wouldRemove` and `reason`.
- `pending`: operations still queued, running or unknown and unacknowledged.

## Orphan storage

An orphan is device storage on a host that no live owner explains: an AVD directory,
a simulator and its storage directory, or the storage of an ended lease. Orphans are
reported and are removed only by an explicit administrator action.

### Inspect

`storage-inspect` walks the same journal and storage roots as the
[maintenance inventory](orchestration.md#manual-maintenance-drain) and reports every
entry that no live owner on the host explains. A live owner is an assignment the
controller delivered on the last heartbeat, or a lease record the runner has not
retired. Each entry has `name`, `machineId`, `root` (`storage`, `journal` or
`registry`), `kind`, `runtime`, `owned`, `removable` and `reason`. The result also
carries `complete`, and `registries`, which says per runtime whether its device
registry could be listed.

`registry` entries are AVD registrations and simulators that carry an assignment's
name (`cvm-<machine id>`) but have no storage directory, and so no owner receipt.
A name proves nothing, so they are reported (`no_storage_or_receipt`) and never
removed; an operator who recognises one removes it by hand.

An entry is `removable` only when the owning runtime proves all of this:

- the directory is private and owned by the runner's account, and holds the owner
  receipt Canaveral wrote when it created the device, bound to this machine ID and to
  this runner's own state directory, storage root and SDK or `xcrun` setting;
- no operation lock is present;
- **Android:** the recorded emulator process is positively absent and its serial is
  not connected; a leased launch needs the lease supervisor's stop proof; and the AVD
  registration points into that same storage;
- **iOS:** the receipted simulator has the assignment's name and is shut down, or is
  already gone; a simulator with the assignment's name but no receipt is not proven;
- or the entry is a removal quarantine this runner created for that machine.

Anything else is reported with its reason and is not removable: storage without a
receipt (`no_owner_receipt`), a receipt from another runner or controller
(`owner_receipt_differs`), a running device (`execution_not_proven_stopped`,
`device_connected`, `simulator_running`), VM runtimes (`unsupported_runtime`) and
journals without storage (`journal_without_storage_proof`). When the inventory is
incomplete, for example more than 100 unexplained entries, nothing is removable.
Inspection removes and stops nothing. For a leased launch that provably never
started, the existing stop proof may record that fact in the launch receipt.

### Purge

`storage-purge` names `entries` of one `inspection`. The controller refuses the whole
request unless the inspection is a complete, successful `storage-inspect` of that
host from the last 15 minutes (409 `host_inspection_required`), every named entry is
`removable` there, and none has a live owner in the controller's own ledger: the
machine ID is unknown to it, or deleted (409 `storage_owner_exists`).

The host then inspects again and proves each entry at that moment. A proven orphan
is removed: its simulator is deleted by receipted UDID (iOS), its storage is moved
aside and erased, and its AVD registration is removed while it still points at that
storage (Android). The local journal directory of the same machine is removed with it
only when it carries the fingerprint of the assignment the owner receipt bound. An
entry that is no longer proven is `refused` with its reason and left untouched. A
purge never stops an emulator or simulator and never touches storage of another
owner, another runner or a person's own devices.

The result lists each entry as `removed`, `refused` or `unknown`. The operation is
`unknown` when any entry may be partly removed.

## Memory and disk pressure

Placement ranks hosts by reservation share. A host that is short of memory or disk
additionally takes no new work until it recovers.

### What the host reports

Every five seconds a direct host samples:

| Platform | Memory signal |
| --- | --- |
| macOS | The kernel's pressure level (`kern.memorystatus_vm_pressure_level`): normal, warning or critical |
| Linux | PSI `some avg10` from `/proc/pressure/memory` where the kernel provides it, and `MemAvailable` as a share of `MemTotal` |
| Other | None (`unsupported`); only disk is evaluated |

Disk is the free space of the tightest filesystem among the host's storage roots. A
KubeVirt pool runner reports no pressure, because its own pod is not the pool.

The state is debounced, so it does not flap. Thresholds are configurable in the host
file; these are the defaults:

```json
"pressure": {
  "memory": { "darwinEnterLevel": "warning", "psiEnterPercent": 10, "psiExitPercent": 5, "availableEnterPercent": 5, "availableExitPercent": 10 },
  "disk": { "enterFreeGiB": 5, "exitFreeGiB": 10 },
  "enterSeconds": 10, "clearSeconds": 60
}
```

- A dimension **enters** pressure when a signal stays at or beyond its enter threshold
  for `enterSeconds`: the macOS level at or above `darwinEnterLevel`, PSI at or above
  `psiEnterPercent`, available memory at or below `availableEnterPercent`, or free disk
  at or below `enterFreeGiB`. A host whose first sample is already there starts
  pressured.
- It **leaves** only after every signal stays within its exit threshold for
  `clearSeconds`: the macOS level `normal`, PSI at or below `psiExitPercent`, available
  memory at or above `availableExitPercent`, free disk at or above `exitFreeGiB`.
  Between the two thresholds the state holds. Exit thresholds must be more relaxed
  than enter thresholds.
- A signal that should exist but cannot be read makes the dimension `unknown` at once.
  When it is readable again, a pressured dimension still owes its whole clear hold.
- `"pressure": {"enabled": false}` switches the report off for that host.

The heartbeat carries the report: `state` (`normal`, `pressured`, `unknown` or
`disabled`), `reasons` (`memory`, `disk`), `since`, both dimensions with their
readings, and the thresholds in force.

### What the controller does

| Host's pressure | New placement |
| --- | --- |
| `normal`, or `disabled` by its operator | allowed |
| never reported (an older runner, or a pool) | allowed, as for a runner that reports no health |
| `pressured` | refused, `host_pressure` |
| `unknown` | refused, `host_pressure_unknown` |
| reported, but no new sample for 60 seconds | refused, `host_pressure_unknown` (shown as `stale`) |

A stale or unreadable sample blocks placement for the same reason a stale health
check does: the last good state is no longer evidence. Sending a cached report again
does not refresh its age.

This gates machines, devices and generic leases, including Android emulator leases:

- placement skips a blocked host and uses another that fits;
- when every host that fits is blocked, machine creation returns 409 with the pressure
  code, and lease acquisition returns a retryable 503 with the same code. A
  [waiting request](requests.md) stays `waiting` with `reason` `host_pressure` or
  `host_pressure_unknown` and is admitted on a later pass;
- starting a stopped machine on a blocked host is refused with the same code. Stopping
  is always allowed.

**Nothing running is stopped or shrunk.** Existing machines, devices and leases keep
their desired state, credentials and reservations, and device operations, sessions
and renewals on a pressured host continue. Pressure is admission only.

`GET /v1/hosts` adds `pressure` beside `health`, and `placementReady` is false while
placement is blocked. `GET /v1/hosts/{id}/resources` carries the same `pressure`.
`pressure.state` is one of the six states above; `reported` is the host's own state,
`placementBlocked` the controller's decision and `receivedAt` the age reference. The
CLI's `hosts` command prints it.

## CLI

```sh
canaveral runtimes show HOST
canaveral runtimes list HOST --platform android
canaveral runtimes install HOST --platform android --request-id UUID \
  --identifier 'system-images;android-36;google_apis;arm64-v8a' --accept-android-licenses
canaveral runtimes install HOST --platform ios --request-id UUID \
  --identifier com.apple.CoreSimulator.SimRuntime.iOS-27-2
canaveral runtimes remove HOST --platform android --request-id UUID --identifier IDENTIFIER
canaveral host-operation UUID
canaveral upkeep status HOST [--idle-stop-seconds 3600]
canaveral upkeep inspect HOST
canaveral upkeep purge HOST --inspection UUID --entry NAME [--entry NAME] --request-id UUID
```

Installs, removals and purges need a `--request-id` the operator has saved, so a lost
reply is inspected or repeated under the same UUID. `list` and `inspect` generate one
and print it when none is given. Submission returns at once; read the receipt with
`host-operation`.

## Compatibility

The controller adds tables only: `host_pressure`, `host_operations`, `host_upkeep`
and `machine_activity`. No existing table changes.

- An older runner with this controller reports no pressure and no upkeep: it is
  never blocked by pressure, accepts no host operation and has no idle stops.
- This runner with an older controller: the extra heartbeat fields are ignored.
- Downgrading the controller leaves the new tables unused. Queued host operations are
  then never delivered, and the runner starts none.

## Verification and limits

Portable tests run the real controller modules, a real `HostRunner` and the real
Android and iOS providers against stand-in processes for `sdkmanager`, `avdmanager`,
`adb`, `xcrun simctl` and `xcodebuild`, and against scripted pressure samples. They
cover: listing with usage; install on request with progress and replay; refusal
without the licence acknowledgement; one install per host and platform; `unknown`
after a runner crash, a timeout, lost authorization and a silent host, with
re-inspection; removal refused for templates, devices, leases, leftover storage and
other people's simulators; refusal of non-administrator credentials, also over HTTP
with real application and lease keys; idle stop with work in flight, uncertain
operations, leased devices and the provider's own stop; orphan evidence, purge
refusals and the dry run; pressure entering and leaving with hysteresis, placement
skipping a pressured host, a waiting request's reason and stale samples.

Open, and not established by those tests:

- **No native run.** The `sdkmanager`, `xcodebuild -downloadPlatform` and
  `simctl runtime` command lines follow the upstream documents below and one read of
  `simctl` help and JSON shapes on Xcode 27.2. Whether they install, verify and remove
  a real runtime, how long that takes, what they print as progress and how licence
  prompts behave are not accepted. `sdkmanager` is deprecated upstream, like
  `avdmanager`; the newer Android CLI is not used.
- **Interrupted installers.** A runner that crashes may leave the SDK's own installer
  process running. The operation is `unknown`; the host does not find or stop that
  process. List before another change.
- **iOS listings.** Only the selected Xcode's default runtime is listed as available.
  `-buildVersion` and `simctl runtime` need a recent Xcode; on older ones installs fail
  and removal reports `tool_unavailable`.
- **Pressure signals.** The parsers have fixtures; the macOS level and Linux PSI and
  `MemAvailable` readings have no native acceptance. Default thresholds are
  unmeasured starting points. Windows hosts report disk only.
- **Pressure scope.** Linux workspace leases and model jobs on a runner domain, even
  one [mapped](infrastructure.md#host-and-runner-physical-budget) to a pressured host,
  and embedded inference jobs are not gated by host pressure. Placement among
  unpressured hosts still ranks by reservation share, not by measured load.
- **Idle stop.** Activity the controller cannot see is covered only by the host's busy
  list. Idle stop applies to devices, not to VMs.
- **Orphans.** Journals without storage, VM runtime storage, name-only registrations
  and simulators, and anything without a matching owner receipt are reported but
  never purged. Purged journals leave lease
  cleanup and lock records of that machine in place.
- **Surfaces.** The dashboard does not show or drive any of this yet. There is no
  event or alert when a host enters pressure or a device is stopped.

Upstream contracts: [sdkmanager](https://developer.android.com/tools/sdkmanager),
[downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
and [Linux pressure stall information](https://docs.kernel.org/accounting/psi.html).
