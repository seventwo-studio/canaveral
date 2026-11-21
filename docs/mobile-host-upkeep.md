# Mobile host upkeep

Implemented 21 November 2026, with portable fixture evidence only. This page is the
contract for three operator-facing parts of running Android and iOS hosts:

- [runtime and system-image management](#runtimes-and-system-images): list, install and remove;
- [idle upkeep](#idle-stop) and [orphan storage](#orphan-storage): stop idle devices, report and purge storage left behind;
- [memory and disk pressure](#memory-and-disk-pressure): hosts report it, and a host whose operator opts in takes no new work while under it.

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
| `POST /v1/host-operations/{id}/resolve` | Record an administrator's decision on a change that ended `unknown`; body `{id, decision, reason}` |
| `GET /v1/hosts/{host}/runtimes` | Latest listing per platform, joined with the templates and devices that use each runtime |
| `GET /v1/hosts/{host}/upkeep` | Dry run: what idle stop and an orphan purge would do, and why |

Every route needs administrator authority: the operator credential, or an
administrator account whose session or token carries the `admin` scope. A signed-in
ordinary user, a personal token without that scope (an administrator's included) and
application, lease, enrollment, host and guest credentials are refused: 403 for an
account without the authority, 401 for a credential that is not an account.

| Kind | Arguments | Effect on the host |
| --- | --- | --- |
| `runtime-list` | `{platform}` | Read-only listing |
| `runtime-install` | `{platform, identifier, acceptLicenses?, timeoutSeconds?}` | Installs one runtime or system image |
| `runtime-remove` | `{platform, identifier, timeoutSeconds?}` | Removes one unused runtime or system image |
| `storage-inspect` | `{}` | Read-only orphan report |
| `storage-purge` | `{inspection, entries}` | Removes named, proven orphans |

`platform` is `android` or `ios`. `timeoutSeconds` is 60 to 14400; installs default
to 3600 and removals to 900. A new operation is accepted only when all of these hold:

- the host's current runner advertises upkeep for that platform (409
  `upkeep_unsupported` otherwise). What a runner advertised does not outlive it: a
  heartbeat without an upkeep report, from an older runner or a host file without
  mobile runtimes, clears it, and nothing is delivered to that runner;
- the host is online;
- the host is not draining for a managed runtime update (409 `host_draining`).

### Receipts and uncertain outcomes

States are `queued`, `running`, `succeeded`, `failed` and `unknown`.

- **Replay.** The UUID names one host, kind and normalized arguments. Repeating it
  returns the receipt and never runs anything again; changing any part is 409.
- **Bounded.** The host must collect and start an operation within 120 seconds. A
  heartbeat delivers at most eight operations, and only those count as collected. One
  that was never collected becomes `failed` (`expired`): it provably did not start.
  A collected operation without a terminal receipt becomes `unknown` at its deadline,
  which is the start window plus `timeoutSeconds` plus 120 seconds.
- **A runner that will not start an operation says so.** It reports `failed`, never
  started, when the start window passed before it got to the operation (`expired`),
  including one still waiting behind another, and when it is fenced for a runtime
  update (`update_fenced`). Neither holds an update or ends `unknown`.
- **Never replayed.** The runner journals an operation before it starts. After a
  runner crash or restart the journal says started, so the runner reports `unknown`
  and runs nothing. A timeout, lost authorization or lost controller contact closes
  the installer the runner started and is `unknown` too.
- **`failed` means the change did not happen.** It is reported only when the tool
  never ran, or ran, reported a failure and the host then verified that the runtime is
  still absent (install) or still present (removal). A failed download can leave
  partial files in the SDK's or Xcode's own cache.
- **One at a time.** A host runs one install or removal per platform, and one storage
  operation, at a time. A second one is refused with 409 `host_operation_busy`.
  Android and iOS changes can overlap, and a listing never waits for a change.
- **Progress** is `{phase, percent?, updatedAt}`. `phase` is one of `starting`,
  `downloading`, `installing`, `removing`, `verifying` or `inspecting`. The percentage
  is the last one the tool printed.
- **Own operations only.** A host reports only operations that were issued to it. A
  heartbeat that reports another host's operation is refused (403) and changes
  nothing. The first terminal receipt is kept; a later report never replaces it.
- **What leaves the host.** Installer and uninstaller output never does: those
  results carry fixed codes and numbers. A listing carries what the tools report about
  each runtime, bounded in length and count: identifiers, versions, build numbers,
  `sdkmanager` descriptions and simulator runtime names, states and kinds. No result
  carries a host path.

### Settling an unknown change

An `unknown` install or removal blocks further changes for that host and platform
(409 `host_inspection_required`), and an `unknown` purge blocks further purges. It is
settled in one of two ways. Neither changes the receipt, which stays `unknown`, and
neither retries anything.

1. **Re-inspection.** A `runtime-list` of that platform that was submitted after the
   change ended, and succeeds, acknowledges it. A `storage-inspect` does the same for a
   purge. A listing that was already queued while the change ran says nothing about
   how it ended and acknowledges nothing.
2. **An administrator's decision**, for when the host can no longer be inspected: its
   platform was removed from the host file, or the host is gone.
   `POST /v1/host-operations/{id}/resolve` with `{id, decision, reason}` records one
   append-only decision. `decision` is `inspected` (the host was inspected by other
   means) or `abandoned` (the outcome is accepted as unknown). `reason` is 1 to 1000
   characters. The controller stores the deciding principal (`kind`, `userId`,
   `username`) and the time, and the receipt shows them as `resolution`. Repeating the
   same UUID and body returns the saved decision; a changed body or a second UUID is
   409. Only an install, removal or purge that ended `unknown` and has not been
   acknowledged can be resolved. Prefer re-inspection where it is possible: the
   decision is the operator's statement, not evidence.

Host operations are accepted during a manual [maintenance drain](infrastructure.md#planned-host-maintenance),
because upkeep is maintenance work. A queued or running operation blocks the
power-off verdict. One that ended `unknown` and is not yet settled is an uncertain
operation and also blocks resume. Either way of settling it above lifts that, so an
operation nobody can re-inspect cannot hold a drain forever.

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
did not find. `inspectionRequired` is true while an unknown change awaits a listing
or an administrator's [decision](#settling-an-unknown-change).
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
- nothing holds it. A device is held while it has work in flight: a queued or running
  device operation, a live video session, an upload in progress, a pending capture,
  deletion or power-off, or work only the host can see. The host lists a device as busy
  while it runs an operation, recording or relayed display for it, lists every running
  device while a local connector or locally attached viewer is in use, and still lists
  such work on the next heartbeat when it began and ended between two heartbeats;
- it has no uncertain operation, which holds it too: an uploaded-app install that lacks
  cleanup or a [resolution](mobile-control.md#resolving-an-uncertain-install), or an
  ended recording whose cleanup is unconfirmed and not abandoned;
- nothing has happened for the configured time since the latest of:
  - the controller first seeing this run;
  - **its owner's last start.** A start through the machine API counts at once, also
    when the host has not yet reported the stop before it. A device its owner starts
    right after an idle stop therefore runs for a whole idle time again;
  - a device operation (including an install) being submitted or finishing;
  - a video session's start or authorization deadline;
  - **the last heartbeat on which anything held it.** The end of in-flight work is
    activity. An upload or a local viewer has no timestamp of its own, so the hold
    itself is recorded: when it ends, the idle time starts over. A build can be
    installed right after its upload without the device being stopped in between.

The stop sets the device's desired state to `stopped`, exactly as an owner's stop
does. The host reconciles and proves it through the provider's normal path, and
compute is released only on the confirmed stop. **Nothing is deleted**: the device, its
storage, its disk reservation and its identity remain, and the owner starts it again
with the normal start. That start is refused under host pressure only on a host whose
operator set `pressure.gateRestart`; see [memory and disk pressure](#memory-and-disk-pressure).
Idle upkeep never deletes an account-owned device and never touches a leased one;
leases end by their own deadline and cleanup.

Idle stops are evaluated on a heartbeat that carries the host's policy, so a host
that is offline, or a runner that reports no policy, stops nothing.

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
  (`live`, `deleted`, `absent` or `unknown`), `wouldRemove` and `reason`. It lists
  everything a purge would remove and nothing else: a storage entry that would be
  removed carries `removes`, and the journal that goes with it is its own entry with
  `wouldRemove: true` and `removedWith`.
- `pending`: operations still queued, running or unknown and not settled.

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

An entry is `removable` only when all of this is proven:

- the directory is private and owned by the runner's account, is not a symbolic link,
  and holds the owner receipt Canaveral wrote when it created the device;
- that receipt binds this machine ID, this runner's own state directory, storage root
  and SDK or `xcrun` setting, and **this host's identity**. A host identity belongs to
  one controller; the receipt itself names no controller;
- no operation lock is present;
- **Android:** the recorded emulator process is positively absent and its serial is
  not connected; a leased launch needs the lease supervisor's stop proof; and the AVD
  registration, if there is one, points into that same storage;
- **iOS:** the receipted simulator has the assignment's name and is shut down, or is
  already gone; a simulator with the assignment's name but no receipt is not proven;
- or the entry is a removal quarantine (`.removing-…`) of a machine this host no
  longer holds, with the same receipt inside.

A removable entry lists everything a purge would remove for it, in `removes`:

| Value | What is removed |
| --- | --- |
| `device-storage` or `removal-quarantine` | The entry's own directory |
| `avd-registration` | The AVD's `.ini`, while it points at that assignment's storage |
| `simulator` | The receipted, shut-down simulator |
| `assignment-journal` | The runner's journal directory for that machine, only when it records the same assignment as the receipt |

A journal directory is reported as its own `journal` entry and is never named in a
purge. It carries `removedWith` when a removable storage entry lists it, and
otherwise says why it stays (`journal_records_another_assignment`,
`journal_without_storage_proof`).

Anything else is reported with its reason and is not removable: storage without a
receipt (`no_owner_receipt`), a receipt for another runner state, storage root, SDK
or host identity (`owner_receipt_differs`), a symbolic link (`ownership_unreadable`),
a running device (`execution_not_proven_stopped`, `device_connected`,
`simulator_running`), a quarantine of a machine the host still holds
(`assignment_retained`) and VM runtimes (`unsupported_runtime`). When the inventory is
incomplete, for example more than 100 unexplained entries, nothing is removable.

`registry` entries are AVD registrations and simulators that carry an assignment's
name (`cvm-<machine id>`) but have no storage directory, and so no owner receipt.
A name proves nothing, so they are reported (`no_storage_or_receipt`) and never
removed; an operator who recognises one removes it by hand.

Inspection removes and stops nothing. For a leased launch that provably never
started, the existing stop proof may record that fact in the launch receipt.

### Purge

`storage-purge` names `entries` of one `inspection`. The controller refuses the whole
request unless the inspection is a complete, successful `storage-inspect` of that
host from the last 15 minutes (409 `host_inspection_required`), every named entry is
`removable` there, and none has a live owner in the controller's own ledger: the
machine ID is unknown to it, or deleted (409 `storage_owner_exists`).

The host then inspects again and proves each entry at that moment. A proven orphan
is removed, and with it exactly what an inspection at that moment lists in `removes`.
An entry that is no longer proven is `refused` with its reason and left untouched. A
purge never stops an emulator or simulator and never touches storage of another
owner, another runner or a person's own devices.

The result lists each entry as `removed` with what was `removed`, as `refused` with a
reason, or as `unknown`. The operation is `unknown` when any entry may be partly
removed, and must then be [settled](#settling-an-unknown-change).

**A purge is never resumed.** It runs once; after a runner crash it is `unknown` and
nothing continues it. What it left is found by the next inspection: storage it had
already moved aside appears as a removal quarantine, and storage it had not reached is
unchanged. A new purge of that inspection finishes it.

## Memory and disk pressure

Hosts report whether they are short of memory or disk. **By default that is an
observation only.** It is shown beside host health and refuses nothing, on every
host, including one upgraded to this version. A host refuses work because of pressure
only when its own operator opts in, in the host file. The reason is plain: the
thresholds and the signals behind them have not been measured on a real host, so
turning them into refusals for every host would be a guess.

### What the host reports

Every five seconds a direct host samples, whatever runtimes it has:

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
  "gatePlacement": false, "gateRestart": false,
  "memory": { "darwinEnterLevel": "warning", "psiEnterPercent": 10, "psiExitPercent": 5, "availableEnterPercent": 5, "availableExitPercent": 10 },
  "disk": { "enterFreeGiB": 5, "exitFreeGiB": 10 },
  "enterSeconds": 10, "clearSeconds": 60
}
```

- A dimension **enters** pressure when a signal stays at or beyond its enter threshold
  for `enterSeconds`: the macOS level at or above `darwinEnterLevel`, PSI at or above
  `psiEnterPercent`, available memory at or below `availableEnterPercent`, or free disk
  at or below `enterFreeGiB`. A runner whose first sample is already there starts
  pressured, without waiting for the hold.
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
readings, the thresholds in force and `gates`, the operator's two choices below.

### Opting in to refusals

Two host-file settings, both off by default, decide what a host's pressure refuses.
They are separate because they affect different people.

| Setting | With it on, a pressured host refuses |
| --- | --- |
| `pressure.gatePlacement` | New machines, devices and generic leases, Android emulator leases included. The host is also not placement-ready: its templates are not `accepting`, lease catalogues show them unavailable, and a browser launch on that host is refused. |
| `pressure.gateRestart` | Starting a stopped machine or device that already lives on that host, by its owner or an administrator. This includes a device that idle stop stopped. |

A host with `gatePlacement` alone therefore takes no new work under pressure while an
owner can still start a device that is already there. Setting `gateRestart` as well
accepts that an owner may have to wait for the pressure to clear, also after an idle
stop. Stopping is always allowed. A gate cannot be set on a host that disabled its
report, or on a KubeVirt pool.

With a gate on, the host's state decides:

| Host's pressure | Gated work |
| --- | --- |
| `normal` | allowed |
| `pressured` | refused, `host_pressure` |
| `unknown` (the signal cannot be read) | refused, `host_pressure_unknown` |
| reported, but no new sample for 60 seconds (`stale`) | refused, `host_pressure_unknown` |

A stale or unreadable sample refuses for the same reason a stale health check does:
the last good state is no longer evidence. Sending a cached report again does not
refresh its age. The operator's gates take effect with the report that carries them,
also when no new sample was taken.

A host is never refused because of pressure when it has no gate on, when it disabled
its report, or when its current runner reports no pressure. **A runner that stops
reporting returns its host to the never-reported state**: a heartbeat without a
pressure report clears what an earlier runner reported. A managed update that is
rolled back to an older runner therefore cannot leave the host blocked by a report
that has gone stale.

What a refusal looks like:

- placement skips a refused host and uses another that fits;
- when every host that fits is refused, machine creation returns 409 with the pressure
  code, and lease acquisition returns a retryable 503 with the same code. A
  [waiting request](requests.md) stays `waiting` with `reason` `host_pressure` or
  `host_pressure_unknown` and is admitted on a later pass;
- a refused start returns 409 with the same code.

**Nothing running is stopped or shrunk**, with or without a gate. Existing machines,
devices and leases keep their desired state, credentials and reservations, and device
operations, sessions and renewals on a pressured host continue.

`GET /v1/hosts` adds `pressure` beside `health`, and `GET /v1/hosts/{id}/resources`
carries the same object. `pressure.state` is `normal`, `pressured`, `unknown`,
`stale`, `disabled` or `unreported`; `reported` is the host's own state, `gates` the
operator's choices, `placementBlocked` and `restartBlocked` the controller's decisions
and `receivedAt` the age reference. `placementReady` is false while placement is
refused. The CLI's `hosts` command prints all of it.

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
canaveral host-operation UUID --resolve-file decision.json
canaveral upkeep status HOST [--idle-stop-seconds 3600]
canaveral upkeep inspect HOST
canaveral upkeep purge HOST --inspection UUID --entry NAME [--entry NAME] --request-id UUID
```

Installs, removals and purges need a `--request-id` the operator has saved, so a lost
reply is inspected or repeated under the same UUID. `list` and `inspect` generate one
and print it when none is given. Submission returns at once; read the receipt with
`host-operation`. The resolve file is `{"id": "<mutation UUID>", "decision":
"inspected" | "abandoned", "reason": "…"}`; see [settling an unknown change](#settling-an-unknown-change).

## Compatibility

The controller adds tables only: `host_pressure`, `host_operations`,
`host_operation_resolutions`, `host_upkeep` and `machine_activity`. No existing table
changes.

- **An upgraded host changes no admission.** It samples and reports pressure, which is
  shown and refuses nothing until its operator sets a gate in the host file.
- An older runner with this controller reports no pressure and no upkeep: it is never
  refused because of pressure, accepts no host operation and has no idle stops. The
  same holds from the first heartbeat of an older runner that replaces a newer one.
- This runner with an older controller: the extra heartbeat fields are ignored.
- Downgrading the controller leaves the new tables unused. Queued host operations are
  then never delivered, and the runner starts none.

## Verification and limits

Portable tests run the real controller modules, a real `HostRunner` and the real
Android and iOS providers against stand-in processes for `sdkmanager`, `avdmanager`,
`adb`, `xcrun simctl` and `xcodebuild`, and against scripted pressure samples. They
cover:

- **Operations.** Listing with usage; install on request with progress and replay;
  refusal without the licence acknowledgement; one install per host and platform;
  `unknown` after a runner crash, a timeout, lost authorization and a silent host;
  a host's report about another host's operation being refused; only delivered
  operations counting as collected; the runner declining an operation whose start
  window passed and every operation while it is fenced for an update; refusal of a
  new operation on a host draining for an update; an advertised capability ending
  with the runner that advertised it.
- **Settling.** Re-inspection, a listing queued before the change ended
  acknowledging nothing, an unsettled `unknown` blocking drain resume, and the
  administrator's decision with its replay, conflict and recorded principal.
- **Removal.** Refused for templates, devices, leases, leftover storage and other
  people's simulators.
- **Authorization.** Refusal of a signed-in ordinary user, of personal tokens without
  the `admin` scope and of application, lease, enrollment and host keys, through the
  real HTTP path.
- **Idle stop.** Work in flight, uncertain operations, leased devices, the provider's
  own stop, the end of in-flight work and an owner's start counting as activity, and
  work shorter than a heartbeat.
- **Orphans.** Evidence, refusals for a symbolic link, another host identity and a
  quarantine the host still holds, the dry run listing what a purge removes, and a
  purge that stops part-way: a failing simulator delete, and a runner crash.
- **Pressure.** Entering and leaving with hysteresis, observation without a gate, the
  two gates separately, placement skipping a gated pressured host, a waiting request's
  reason, stale samples, and a runner that stops reporting.

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
  unmeasured starting points, which is why no host refuses work on them unless its
  operator opts in. Windows hosts report disk only.
- **Pressure scope.** Also with a gate on, Linux workspace leases and model jobs on a
  runner domain, even one [mapped](infrastructure.md#host-and-runner-physical-budget)
  to a pressured host, and embedded inference jobs are not refused for host pressure.
  A gate is per host, not per template or per kind of work. Placement among hosts
  that are not refused still ranks by reservation share, not by measured load.
- **Update-fenced runners.** A runner fenced for an update declines what it has not
  started. An operation it had already started keeps its own bounded duration, and
  the update waits for it as it does for other started work.
- **Administrator decisions.** A decision settles an `unknown` operation on the
  operator's word. The controller cannot check that the host was inspected, and
  nothing prevents a decision for a host that could have been listed instead.
- **Idle stop.** Activity the controller cannot see is covered only by the host's busy
  list, and a hold is known to the controller only from the heartbeats that report it,
  so its end is dated to the last such heartbeat. Idle stop applies to devices, not to
  VMs.
- **Orphans.** Journals without storage, VM runtime storage, name-only registrations
  and simulators, and anything without a matching owner receipt are reported but
  never purged. Purged journals leave lease cleanup and lock records of that machine
  in place. A purge that stops after deleting a simulator but before moving its
  storage leaves that storage in place without its simulator; the next inspection
  reports it and a new purge removes it.
- **Surfaces.** The dashboard does not show or drive any of this yet. There is no
  event or alert when a host enters pressure or a device is stopped.

Upstream contracts: [sdkmanager](https://developer.android.com/tools/sdkmanager),
[downloading and installing additional Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
and [Linux pressure stall information](https://docs.kernel.org/accounting/psi.html).
