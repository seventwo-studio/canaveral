# Warm devices and device baselines

Implemented 21 November 2026 for [Android emulator leases](mobile-control.md#android-emulator-leases).
A **warm pool** keeps devices of the leased kinds booted and checked, so a lease gets one
without waiting for a boot. A **baseline** is a saved, prepared device state that every
device of one lease image starts from.

The [native trial](../coordination/native-acceptance/mobile-parity.md) verified immediate warm adoption on one Mac.
The baseline-backed emulator booted, but the prepared setting was absent in the clone.
See [limits and open native questions](#limits-and-open-native-questions) and
[iOS follow-ups](#follow-ups).

Every guarantee of an Android lease is unchanged. A device serves one lease and is then
destroyed. Its deadline is enforced by the native supervisor, independently of the runner
and the controller. Stop proof gates storage removal, credential erasure and the release
of its reservation. The isolation launch flags, the readiness probe and the refusal of
debuggable images apply to every device that is handed out, warm or cold, with or without
a baseline.

## Warm pool

### Host opt-in

A host runs warm devices only when its operator says so, with the host's own bounds:

```json
{ "leaseWarmPool": { "maxDevices": 2, "maxAgeSeconds": 3600 } }
```

- `maxDevices` (1 to 64): the most warm devices this host will run at once.
- `maxAgeSeconds` (60 to 86400): the longest any warm device may exist on this host.

`leaseWarmPool` is valid only on a host that already advertises
[Android lease execution](mobile-control.md#host-configuration). The host publishes the two
numbers in its offer as `warmPool`. It enforces them itself: a warm assignment for a
template outside its `leaseImages`, on a host without the opt-in, or beyond `maxDevices`
is never started and reports `error`, whatever the controller sent. See the
[leased host example](../examples/host-android-warm-pool.json) and its
[pinned template](../examples/templates/android-phone-leased.json).

### Targets and headroom

An administrator sets, per host, how many warm devices to keep for each lease image:

```json
{ "targets": [{ "templateId": "android-phone-leased", "templateRevision": "1", "arch": "arm64", "count": 2, "maxAgeSeconds": 1800 }],
  "headroom": { "cpu": 2, "memoryMiB": 2048, "diskGiB": 8 } }
```

- `targets` is the host's complete list; sending it replaces the previous one. A target
  names a lease image the host advertises. `count` is 0 to the host's `maxDevices`, and
  the counts together may not exceed it. `maxAgeSeconds` is optional, at least 60 and at
  most the host's own maximum, which is also its default.
- `headroom` is optional and stays as it was when omitted. The pool leaves this much of
  the host's capacity unreserved when it creates a warm device. It is how an operator
  reserves running slots for cold boots and other work: capacity is counted in CPU,
  memory and disk here, not in slots.

Targets are fixed numbers. They are not learned from usage.

### One ledger

A warm device is an ordinary machine row on its host, created by the pool with the lease
image's default size. Every capacity ledger therefore already counts its CPU, memory and
disk, exactly once: host limits, a mapped [physical domain](infrastructure.md#host-and-runner-physical-budget),
the resource categories and maintenance drains. The pool creates a device only when the
ledger has that much free beyond the headroom, so it never overspends a host.

A warm device has no owner, no lease, no lease key and no consumer. Machine actions refuse
it with 409 `warm_pool_device`: start and stop, deletion, power-off, device operations,
app uploads, recordings and baseline saves. Administrators see it in the machine list,
marked `warm`, and in the pool state.

A lease takes a warm device over by becoming the owner of that same machine row. Nothing
is released and nothing is reserved again, so an admission and a warm device can never
count the same capacity twice or not at all. The lease's member is then the warm device's
machine; a cold lease keeps the machine identity derived from its lease UUID.

### States

| State | Meaning |
| --- | --- |
| `booting` | Created. The host is creating the AVD, booting it under the supervisor and running the readiness checks. |
| `ready` | Booted, checked and offered to leases. |
| `adopting` | Claimed by one lease in its admission transaction. Not ready for that lease until the host proves the hand-over. |
| `adopted` | The lease's device. Its row stays as provenance; the lease's own cleanup removes it. |
| `retiring` | Given up by the pool. Its reservation is held until the host proves the stop and the removal. |
| `removed` | Proven gone and released. |

A device leaves `booting` or `ready` for `retiring` when it stops or fails a check, is not
ready within 300 seconds, reaches its age, exceeds a lowered target, loses its target or
its lease image, sits on a draining or disabled host, or holds capacity a waiting request
needs. Giving a device up uses the machine deletion receipt: the host fences the hold,
waits for the supervisor's stop proof, removes the storage and reports completion. Only
that report releases the reservation. Once the controller has acknowledged it, the host
erases the device's local journal, so recycling leaves nothing behind on the host.

### The warm hold

A warm device runs under the same detached `lease-supervise` helper as a leased one, with
the same launch flags, so it is network-isolated from its first boot. Its owner is a
**warm hold**, not a lease. The supervisor's records name a `warmId` where a lease's name
a `leaseId`; a record never has both, and neither owner accepts the other's
authorization.

The hold has one fixed deadline: the device's maximum age, counted from its creation and
capped by the host's own `maxAgeSeconds`. The host publishes it once, as an absolute
deadline on the boot's continuous clock. Nothing renews it. With the runner or the
controller gone, the supervisor alone stops the device at that deadline, writes its stop
receipt and exits. A renewing keep-alive was considered and left out: it would stop the
pool on every controller restart, and it would be a second deadline mechanism to prove.
The cost is that a warm device can outlive a lost runner by up to its maximum age.

A warm device is ready only after the same checks as a leased device, by its own
warm-phase report: booted, package manager answering, owned serial, a user build
(`ro.debuggable=0`) and the negative guest-to-host probe recorded for that boot. A device
that fails the image check or the probe is fenced, never offered, and its failure counts
as a failed boot.

### Adoption

Admission looks for a `ready` warm device of exactly the lease's pinned image and exactly
its requested size, on a host that is online, healthy, not draining and still eligible,
and at least 20 seconds before the hold's deadline. If there is one, the lease claims it
in the same transaction that creates the lease; otherwise the lease gets a cold boot as
before. `lease_members.machine` is unique, so one device cannot have two leases, even
under concurrent admission. A request with other resources than the image's defaults
always cold boots.

The claim alone does not make the lease ready. The controller resets the device's
readiness and ignores every report that names the earlier warm binding. The host then
hands the device over:

1. It writes an adoption journal that binds machine, hold, lease and boot.
2. It replaces the hold's authorization with the lease's identity, revision and deadline,
   naming the hold in `adoptedFrom`. It refuses when the hold is fenced, expired or from
   another boot, or when the lease's own authorization has ended.
3. The supervisor accepts that owner change once: only from a warm hold, only for a lease
   that names exactly this hold, and only while both the hold and the lease's terms are
   current. It rewrites its record with the lease and the adopted hold, durably, and from
   then on enforces only the lease's deadline. That record is the commit point and the
   host's only proof of adoption. Any other owner change, including a second lease, is a
   fence and stops the device.
4. Only after seeing that record does the host rebind its own launch record and
   assignment record to the lease. It then runs the ordinary lease readiness check again
   under the lease. The isolation receipt is accepted only for the same boot, so a device
   is never handed out on a check made under another boot.
5. The host reports the device ready with the binding it describes and its origin,
   `warm`. Only then does the controller mark the hand-over complete and the lease become
   `ready`.

The storage of a pool device is bound to its warm hold for its whole life. The lease
binding lives in the launch record, the adoption journal and the supervisor's records.

### When adoption cannot happen

A failure either leaves a clean warm device or ends in a proven removal:

- **Before the authorization is replaced** nothing has changed. If the lease is already
  ending, the warm device is still a clean warm hold and the lease's cleanup removes it.
- **The warm device is proven stopped before the supervisor adopted it** (it crashed, was
  fenced or its hold expired). It was never handed out. The host removes its storage
  through a journaled quarantine, kept outside the storage so an interrupted removal
  resumes first, and then cold boots a fresh device for the lease under the same machine
  and the same reservation. The lease view then says `cold`. Because the reservation is
  the same row, the fallback never waits for capacity and never overspends.
- **The supervisor is gone without a stop receipt and the emulator may still run.** Nothing
  can be proven, so the lease fails at once and its cleanup waits for stop proof, as for
  [any lost supervisor](mobile-control.md#unprovable-cleanup-and-recovery).
- **The lease ends while it is still adopting.** The device is the lease's to clean up.
  The host binds its local records to the lease, fences whatever owner the supervisor
  still enforces, and the usual stop proof, storage removal and credential erasure
  release the reservation.

A device that the supervisor has adopted is a leased device in every respect: if it stops,
the lease fails and is never relaunched.

### Waiting requests win

Admission always runs before the pool refills, and the pool never refills in a host
heartbeat. A waiting [request](requests.md) that was refused for capacity takes precedence
over warm devices:

The pool gives up only the devices needed on one eligible host, starting with unresponsive
devices, then booting ones, then the oldest ready devices. It holds back refills when
pending removals can serve the request. A ready or recently booting pool device of the
same image and size can serve the request directly. For Linux leases and model jobs, the
pool checks eligible runner domains with a physical mapping to a host.

The given-up device's capacity is free only after its proven removal. Direct
`/v1/leases` acquisition does not wait and therefore reclaims nothing: it adopts a ready
warm device or gets 503 as before.

### Recycling and back-off

Twenty seconds before its hold's deadline a `ready` device stops being offered and is
given up; the pool then boots its replacement. A warm device never serves two leases and
never returns to the pool.

A failed boot (an error, a stop or the 300-second timeout while `booting`) is counted per
host and lease image. The next attempt waits 15 seconds, then 30, 60 and so on, to at most
10 minutes. A device that becomes ready resets the count. The last error and its time
stay visible in the pool state. A device that stops passing readiness checks is withheld
immediately and retired after 60 seconds if it stays unready.

An unproven removal pauses new boots for that image on that host and retains the
reservation. The target reports `paused.reason: "removal_unproven"` with the machine ID.
A missing, stale or incompatible baseline also pauses the target.

### Restart and loss

- **Runner restart.** The runner finds the supervised warm device again from its launch
  record and the supervisor's lifetime lock. It is not relaunched and not duplicated.
- **Controller restart.** Targets, devices and their reservations are rows in the
  controller database. Warm devices keep running under their holds meanwhile.
- **Host loss.** The device's reservation stays on the ledger until the host returns and
  proves the removal. The supervisor has stopped the device at its deadline by then.
- **Runner loss during a hand-over.** The adoption journal and the supervisor's record
  make it resumable: the runner finishes the rebinding, or finds the stop proof and falls
  back to a cold boot.

### What a consumer sees

Each lease member has an optional `source`: `warm` when the device was taken over from
the warm pool, `cold` when it was booted for the lease. It is absent while a claimed warm
device is still being handed over. Nothing about the host, the pool or the hold is
exposed. The SDK exports `memberSource(lease)`.

### API and CLI

All routes need administrator authority.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/warm-pool` | Every host that has warm devices enabled, targets or live devices |
| `GET /v1/hosts/{host}/warm-pool` | One host |
| `POST /v1/hosts/{host}/warm-pool` | Replace the host's targets and, optionally, its headroom |

A host's state holds `enabled`, `limits` (the host's own bounds), `headroom`, `targets`
and `devices`. Each target reports `count`, `maxAgeSeconds`, `ready`, `booting`,
`retiring`, `failed` (consecutive failed boots), `nextAttemptAt`, `lastError` and
`lastErrorAt`. Each device reports its machine, image, state, reason and times.

```sh
canaveral warm-pool
canaveral warm-pool show HOST_UUID
canaveral warm-pool set HOST_UUID --request-file ./targets.json
```

## Baselines

### An explicit operator choice

A baseline carries whatever its preparer installed, signed in to or configured to every
lease that uses it: apps, accounts, tokens, settings and device identifiers. Every device
made from it starts with the same identity. Canaveral does not inspect or clean that
content. Reaching it is therefore deliberately narrow:

- Administrators can list and remove baselines. An administrator saves a device their
  account owns. The operator credential can save a device that has no user owner.
  The receipt records `savedBy` and, for removal, `removedBy`.
- Only a pinned template names a baseline, by name, revision and digest. That reference is
  part of the template's immutable public definition, so pointing at another baseline
  needs a new template revision.
- An application reaches a baseline-backed image only through its
  [template allowlist](applications.md). An ordinary account cannot create a device from
  such an image; an administrator can, for example to prepare the next revision.

### Saving

```sh
canaveral baseline save MACHINE_UUID --name signed-in --revision 1 --request-id UUID
```

`POST /v1/machines/{machine}/baselines` with `{id, name, revision}`. The machine is an
account-owned Android device that the administrator prepared through the existing
[device actions](devices.md#device-control). It must be stopped: both its desired state
and the host's confirmed observation, on a connected host. A leased device and a warm
pool device are refused, as is a device with a deletion intent, queued operations or an
unresolved save. The same UUID replays; the same name and revision cannot be saved twice
on a host. A name is lower-case letters, digits, `.`, `_` and `-`.

The host checks again on its own account. It captures only its own current, stopped,
unleased assignment, under the assignment lock, when no launch, endpoint, stop or
supervisor record remains and no process on the host names the device's AVD. While the
save runs the device cannot be started or deleted.

The existing stop for an account-owned emulator is the console's kill, not a guest
shutdown. Guest writes that were not flushed are lost, so run `sync` through the `shell`
action before stopping a device you intend to save.

### What is stored

The host copies the stopped AVD's disk state into
`<storage>/baselines/<name>/<revision>/`: every regular file under the AVD directory
except the device's own configuration (`config.ini`, `hardware-qemu.ini`, `AVD.conf`),
per-launch and lock files, logs and quick-boot `snapshots`. A link in the AVD directory
refuses the capture. Each file is hashed while it is copied, zero regions stay sparse,
and the copy is abandoned if the source changes underneath it.

The manifest records each file's size and SHA-256, the device definition, architecture
and data-partition size, and the identity of the installed system image. The baseline's
**digest** covers all of that. The whole directory is published by one rename; a failure
before it removes the staging directory and stores nothing. Afterwards the files and
directories are read-only and nothing in Canaveral writes to them. A baseline is replaced
as a whole by saving a new revision.

Baselines are stored per host. The bytes never reach the controller, which holds the
identity, the binding and the disk charge. While a save runs it holds twice the device's
data size plus 2 GiB of the host's disk; a stored baseline is charged its logical size,
rounded up to whole GiB. An interrupted save is `unknown`: it keeps its charge, and its
source device stays stopped, until an administrator removes the baseline, which also
clears whatever the save left on the host.

### Binding and staleness

A baseline is bound to the exact system image package, device profile, architecture and
data-partition size it was made from, and to the installed system image's own identity:
the SHA-256 of its `source.properties` and `build.prop`. The SDK manager replaces an
image in place under the same package name; those two files change when it does.

A baseline is **stale** when that identity no longer matches, or the system image is no
longer installed. A stale baseline, a missing one, another digest than the template pins,
or another device definition or data size is refused in two places:

- The controller places a baseline-backed image only on a host whose last inventory lists
  exactly that baseline, made from the template's own device definition, and not stale.
  Otherwise the host is not eligible: a direct lease gets 503 and a request waits.
- The host refuses before it creates anything, so a refusal leaves no partial device. The
  lease or warm boot fails with the reason.

`GET /v1/baselines` shows each baseline's image binding, whether its host still stores it
(`present`) and its `stale` state with a reason.

### Devices from a baseline

A template names its baseline:

```json
{ "id": "android-phone-signed-in", "revision": "1", "os": "android", "arch": "arm64", "mode": "device",
  "minimum": { "cpu": 2, "memoryMiB": 2048, "diskGiB": 8 },
  "device": { "systemImage": "system-images;android-35;google_apis_playstore;arm64-v8a", "profile": "pixel_8" },
  "baseline": { "name": "signed-in", "revision": "1", "digest": "<sha256 from the baseline list>" } }
```

List it in the host's `templates` and `leaseImages` like any lease image. Its `diskGiB`
must be the size the baseline was saved with.

Every device of that image, cold or warm, is a fresh AVD from `avdmanager` that receives
its own copy of the baseline's files before first boot. The copy is a copy-on-write clone
where the filesystem has one; otherwise each file is copied and its digest rechecked in
the same pass. The stored files' full digests are verified once per runner process and
again whenever a file's identity changes. Each copied qcow2 overlay must resolve to its own copied base image. The runner uses
`qemu-img rebase -u` when the overlay records the source device's path and reads the
backing path again before booting. Unsupported overlays, missing tools and failed
verification stop the clone. Partial copies are journaled for device cleanup. The device then goes through the ordinary supervised launch and
readiness checks. A lease writes only to its own copy, which is destroyed with it.

### Removing

```sh
canaveral baseline remove BASELINE_UUID --request-id UUID
```

`POST /v1/baselines/{id}/remove` with `{id}`. Removal is refused with 409
`baseline_referenced` while a template in the host's current offer names the baseline, or
while any device on that host that is not yet removed was made from such a template: a
live lease, a warm device or an account-owned machine. The host refuses again while any
of its configured templates or current assignments names it. Withdraw the template from
the host first. Nothing else removes a baseline: not a lease, not recycling, not a failed
clone.

### API and CLI

All routes need administrator authority.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/machines/{machine}/baselines` | Save a stopped, account-owned device: `{id, name, revision}` |
| `GET /v1/baselines` | Every baseline with its image binding, stale state and references |
| `GET /v1/baselines/{id}` | One baseline |
| `POST /v1/baselines/{id}/remove` | Remove an unreferenced baseline: `{id}` |

States are `saving`, `ready`, `failed`, `unknown`, `removing` and `removed`.

## Verification

Rust unit tests in `lease_supervisor.rs` cover the owner rule (a record names a lease or a
warm hold, never both), a warm hold stopped at its own deadline with no host update, one
adoption with the lease's deadline then enforced, a second owner change fenced, and
adoptions refused for another hold, an expired or fenced hold and an ended lease.

[android-warm-pool.test.ts](../coordination/test/control/android-warm-pool.test.ts),
[android-warm-lifetime.test.ts](../coordination/test/control/android-warm-lifetime.test.ts)
and [android-baselines.test.ts](../coordination/test/control/android-baselines.test.ts)
run the real controller, `HostRunner` and `lease-supervise` helper against stand-in
processes. They cover:

- a lease adopting a warm device without another boot, with the same emulator process,
  boot and supervisor, and a cold boot when the pool is empty;
- one warm device under two concurrent admissions;
- capacity counted once, headroom, a full host, a waiting request for another image
  taking a warm device's capacity, and no refill ahead of a waiting request;
- the warm hold enforced with the runner gone, recycling by age, and back-off after
  failed boots;
- a warm device that died before adoption (removed with proof, cold boot under the same
  reservation) and a lease that ended before adoption (cleaned up with proof);
- runner and controller restart, expiry and release of an adopted device with the usual
  cleanup proof, and the host's own gates;
- saving, listing and removing a baseline; refusals for a running device, a leased
  device, non-administrator keys, a duplicate, a stale or mismatched baseline and a
  referenced one; a lease and a warm device starting from the baseline without changing
  it; and the isolation probe and the debuggable check fencing warm and baseline-backed
  devices.

## Limits and open native questions

The first [native trial](../coordination/native-acceptance/mobile-parity.md#android-baseline-state) found the prepared
setting absent in a clone that booted. Open checks include:

- Where the prepared state was lost, whether a copied AVD needs `qemu-img rebase`
  on other emulator versions, and how encryption keys, modem state and Google Play
  services behave on a copy.
- Whether an idle emulator stays healthy, booted and isolated for its whole maximum age,
  and what it costs in CPU and memory while idle.
- The range of adoption times under load. The native trial's immediate
  adoptions took about 1.6–2.2 seconds from admission to ready.
- Whether `source.properties` and `build.prop` identify every in-place system image
  change. A system image without them is treated as unchanged.
- Sparse copies and copy-on-write clones of multi-gigabyte images on the host's real
  filesystem, and their timing.

Known limits of the implementation:

- A baseline is crash-consistent at best, because the existing stop is not a guest
  shutdown.
- Clones of one baseline share the guest's identifiers and accounts.
- Warm devices appear in the administrator machine list. The dashboard has no warm pool
  or baseline view and offers its usual actions on them, which the controller refuses.
- A direct `/v1/leases` acquisition reclaims nothing.
- A retired or adopted warm device leaves a machine tombstone in the controller
  database, like every lease. Tombstones are not pruned.
- A lost runner can leave a warm device running for up to its maximum age.
- The supervised emulator's resource usage is still not attributed by the
  [runtime ownership](android-runtime-ownership.md) sampler.
- A baseline cannot be moved or copied between hosts.

## Follow-ups

- **iOS simulators.** Warm devices and baselines for iOS simulator leases are not
  implemented. The controller's pool and baseline tables carry no Android assumption: a
  provider joins by advertising `warmPool` in its offer and implementing the warm hold,
  the adoption and the capture. The simulator's shared-host isolation class needs its own
  review first.
- Targets learned from usage, a dashboard view, events and alerts for the pool.
- A native trial of each item under [open native questions](#limits-and-open-native-questions).
