# Libvirt lease supervision

Consumer VM leases on canaverald hosts run as **transient** libvirt domains, one
per lease, each supervised by a native Rust guardian. Every way a lease can end
finishes in a destroyed domain and removed overlay with proof, or in a retained
reservation whose state stays unknown until proof exists. Nothing is freed or
forgotten silently.

Administrative VMs are separate: they keep a persistent definition and ordinary
`virsh start` and shutdown, and their lifecycle is operator-owned across daemon
restarts and pod replacement. Nothing on this page applies to them except the
[VM storage contract](running.md#libvirt-vm-storage).

## Components

| Piece | Where | Role |
| --- | --- | --- |
| Lease helper `canaveral-libvirt-native` | `crates/libvirt-native` | Guardian, connection worker, proof probes, `fence`, `erase`, `check` and `clock` commands. Loads `libvirt.so.0` and `libvirt-qemu.so.0` at run time |
| Provider lease path | `coordination/src/providers/libvirt.ts` | Preparation, launch, deadline publication, reconciliation, stop and removal |
| Production adapter | `coordination/src/providers/libvirt-native.ts` | Verifies and executes the pinned helper; bound in `providers/index.ts` |
| Host gate | `coordination/src/host.ts` (`leaseOffer`, `hostOffer`, `leaseEligible`) | Advertises libvirt lease images only when every prerequisite holds |

## Helper identity

Configure the libvirt runtime with `leaseHelper` (absolute path) and
`leaseHelperSha256`. The helper must be a regular root-owned file without hard
links or group/other write permission, in root-owned directories that are not
group/other writable, and the daemon must not run as root. Pin the digest from
the release or image manifest. For every execution the daemon opens the file,
hashes those bytes, rechecks the descriptor, and runs the child through
`/proc/self/fd/3`, the same descriptor. It never runs the configured path after
hashing it. For libvirt lease offers, set `leaseClockHelper` to the same pinned
binary. The host verifies the image and the kernel's peer pidfd support before
advertising leases. Every clock sample reopens and verifies the image and runs
its `clock` command through the verified descriptor. If that fails, the host
withdraws lease offers, fences lease authority and continues reporting cleanup.
Restore the matching helper and restart the daemon to resume admission.

The helper's `dlopen` calls depend on root-owned system loader configuration,
search paths and libraries, including inside the pod image. The daemon strips
inherited loader environment variables before invoking the helper.

`canaverald runtimes status` reports `leases: {eligible: true}` on the libvirt
row when the helper verifies and the kernel supports peer pidfds. Otherwise it
reports `libvirt_lease_helper_unverified` or `libvirt_lease_kernel_unsupported`.
The host refuses to start with libvirt lease images declared on a kernel older
than Linux 6.5 (`libvirt_lease_kernel_unsupported`) or without the helper.

## Eligibility

A host advertises a libvirt lease image only when all of these hold:

- the selector `{id, revision, arch, runtime: "libvirt"}` names an offered
  template on the libvirt runtime;
- the template is headless x64 Linux with `firmware: "bios"`, without TPM,
  secure boot, guest access or a preparation recipe (the natively accepted
  template; UEFI and TPM state provisioning is not qualified for leases);
- the host is Linux 6.5 or later with the pinned helper and `leaseClockHelper`.

The host also enforces this itself: an assignment outside its advertised
libvirt lease images is never started.

## Lease lifecycle

**Preparation.** The daemon checks the lease authorization, creates the machine
directory and qcow2 overlay with the [VM storage modes](running.md#libvirt-vm-storage),
binds the domain XML to a random per-launch nonce (the binding's `bootId`),
the lease and the assignment UUID in namespaced `<metadata>`, and adds the
static DAC label. It journals that XML, the URI and the identity in
`libvirt-native-spec.json` before anything is created. Nothing is defined in
libvirt.

**Launch.** The daemon publishes the deadline in `CLOCK_BOOTTIME` seconds,
records the launch attempt, then starts one guardian with a daemon-created Unix
socket as stdin. A launch is never replayed: a failed or uncertain spawn is
fenced like any other end.

**Guardian.** The guardian:

1. takes the daemon's pidfd from its socket peer with `SO_PEERPIDFD`, after
   checking the peer's PID and UID;
2. takes the lease lock (`libvirt-native.lock`, `flock`) for its lifetime;
3. waits for the launch record that names its own PID and start time;
4. starts a connection worker whose `PR_SET_PDEATHSIG` is armed before exec;
5. persists that a create may be submitted, then grants permission to call
   `virDomainCreateXML(PAUSED|AUTODESTROY)`. After a successful reply the worker
   journals completion in `libvirt-native-create.json` and adds the proven UUID,
   nonce, lease, domain ID and (on bare metal) QEMU process birth. The guardian
   durably records the paused instance and rechecks authority before resuming it.

The worker runs the libvirt default event loop with keepalive (5 s, 3 probes)
and a close callback. Connection loss, including a libvirtd restart, ends the
worker and so fences the lease. The guardian ignores `SIGTERM`, `SIGINT` and
`SIGHUP` and ends the lease on the first of: daemon exit (pidfd), worker or
connection loss, a fenced or expired deadline, a host boot change, or the
domain leaving the running state (guest shutdown or crash). The deadline is
checked against `CLOCK_BOOTTIME` every 100 ms. It is independent of the daemon,
the controller and libvirt RPCs: the same revision can never extend it.

**Fence.** Ending the worker closes its connection, so AUTODESTROY destroys a
domain still bound to it. The fence does not rely on that. Through a fresh
connection it destroys a remaining domain only after the UUID, nonce and lease
in its metadata, the recorded domain ID and, on bare metal, the QEMU birth all
match on the same host boot. It records `stopped` with `stopProven` after a
fresh lookup returns `VIR_ERR_NO_DOMAIN`, the recorded QEMU process is gone,
and the create is known to have completed or to have never been submitted. A
new host boot also settles the earlier boot's create. Each probe runs in
its own child, bounded to 10 seconds. If libvirt cannot complete the proof on
bare metal, the guardian opens a pidfd on the recorded QEMU process, checks its
start time and sends `SIGKILL` through the pidfd. That needs `CAP_KILL` from the
[systemd drop-in](running.md#libvirt-vm-leases); without it the receipt reports
`qemu-kill-denied`. It retries for 30 seconds, then exits with the receipt
unconfirmed.

**Reconciler backstop.** A restarted daemon, or the periodic refresh, runs the
helper's `fence` command for any lease whose guardian is gone, fenced or on an
old boot. `fence` first takes the same lease lock: a live guardian makes it
return busy, so there is never a second destroyer, and acquiring it proves the
guardian is gone. An RPC submitted by its worker can still be in flight on
the server. A dead worker or repeated `VIR_ERR_NO_DOMAIN` replies provide no
completion evidence. With an uncertain create the reconciler records
`unknown`, retains the reservation and keeps probing the per-lease UUID.
If a domain appears, explicit destruction requires the durable instance
identity. A same-boot libvirtd restart does not settle a missing create reply
because the journal does not identify the libvirtd process. The reconciler
runs the same proof-gated fence with the same
`CAP_KILL` fallback. A transient domain cannot survive a host reboot or be
resurrected by `virsh start`, autostart or libvirt-guests.

**Removal.** After a durable stopped receipt (or a launch that never happened),
cleanup records its removal intent, renames the machine directory to
`.removing-<machine>-<cleanup>` and runs the helper's `erase` under the lease
lock. `erase` repeats the fresh absence lookup and takes a Linux write lease on
every file, which the kernel grants only when no other process has it open.
It accepts only the owner marker and the disk with their exact owner, group and
mode, then records `verified` with the marker's device and inode and the exact
removal intent before truncating either file. It truncates and syncs both
files, records `cleared`, unlinks them, removes the directory and records
`removed`. A retry uses the verified inodes even if the marker is already empty.
If the directory is already absent after `cleared`, the helper synchronizes
its parent and publishes `removed`. The generic cleanup then erases the assignment's journals and
credentials, and only then does the controller release the reservation.

## End paths

| End | What ends the domain | Proof of stop |
| --- | --- | --- |
| Release, cancel | Published fence, then guardian fence | Guardian receipt |
| Expiry | Guardian deadline (and the published fence) | Guardian receipt |
| Daemon crash or service stop | Guardian sees the pidfd and fences | Guardian receipt; reconciler on restart otherwise |
| Pod stop (Kubernetes) | Container exit kills the guardian and worker; AUTODESTROY | Reconciler fence on the next pod |
| Guardian killed or OOM-killed | Worker dies (PDEATHSIG); AUTODESTROY | Reconciler fence under the lock |
| Controller loss | Host guard stops renewing; deadline expires | Guardian receipt |
| libvirtd restart | Connection loss fences | Guardian fence through the restarted libvirtd |
| libvirtd down past the deadline | Bare metal: pidfd `SIGKILL` of QEMU with `CAP_KILL` | Fresh lookup once libvirtd returns |
| Host reboot | Reboot | Fresh lookup on the new boot |

Until the proof exists, the lease's reservation, storage and journals stay and
the controller reports the cleanup as blocked with `libvirt-unconfirmed` in
Kubernetes and `execution_pending` on bare metal.

## Kubernetes

In a pod there is no host PID view and no capability to signal QEMU. Ownership
proof is the UUID, nonce and lease in the metadata plus the domain ID. This
relies on the accepted trust model that every principal with the mounted
libvirt socket is trusted with host administration. A guest reaches neither
the socket nor the journal. If libvirtd is down past a lease deadline in a pod,
the guest keeps running until libvirtd returns and the fence completes: an
accepted gap. The receipt reports `libvirt-unconfirmed` and the reservation
stays held. The node-local journal survives pod replacement, so the next pod's
reconciler completes the fence. In-cluster native acceptance has not run.

## Evidence

Portable fixtures (`coordination/test/control/libvirt-leases.test.ts`) drive
the provider with a fake helper through preparation, launch, release, expiry,
revocation, daemon crash, guardian kill and OOM, a kill mid-fence,
unconfirmed proof, removal and its interruption, a fence before launch, a
host reboot, guest shutdown, foreign metadata, template refusal, helper
changes and host eligibility. Rust unit tests (`crates/libvirt-native`) cover
authority monotonicity and fencing, lock exclusivity, record privacy, pidfd
birth checks, peer pidfds, owner metadata parsing and erasure under file
leases (on Linux).

Native acceptance runs in `.github/workflows/vm-acceptance.yaml` on hosted
ubuntu-24.04 x64 with host libvirtd and KVM, canaverald as a systemd service and
a digest-pinned CirrOS guest; see [fixtures/libvirt](../fixtures/libvirt/README.md).
It covers boot evidence, release, expiry, daemon SIGKILL, a guardian OOM kill,
a guardian killed mid-fence, a libvirtd restart, a deadline while libvirtd is
frozen (the `CAP_KILL` path), an idle lease across many keepalive intervals,
refused `virsh start` and autostart, and the `CLOCK_BOOTTIME` time-namespace
offset.

[Run 45442285242](https://github.com/seventwo-studio/canaveral/actions/runs/45442285242)
(commit `9348874`, ubuntu-24.04 image 20261116.376.1, kernel 7.0.0-1017-azure,
libvirt 10.0.0, QEMU 8.2.2) passed every step. QEMU ran as `libvirt-qemu` with
group `canaveral-vm` and the guest took a DHCP lease. The domain was destroyed
0.3 s after an expiry deadline. With libvirtd frozen past the deadline, the
guardian killed QEMU through a pidfd 10.5 s after the deadline (one bounded
probe), and stop was proven once libvirtd resumed. The kernel OOM killer chose
the guardian (`oom_score_adj` 1000) inside the service cgroup, and systemd's
`OOMPolicy=stop` then stopped the unit. Under memory-cgroup pressure a guardian
can instead fence itself when its reads fail. The current acceptance step
requires a fresh kernel OOM-kill record for the guardian PID and records
self-fencing separately.

That proves one hosted kernel and libvirt build. Kubernetes pods, UEFI or TPM
guests, other distributions, arm64, suspend and real host reboots remain
unaccepted.

## Mounted host socket in Kubernetes

On a VM node, configure `provider: "libvirt"` or select `libvirt` under
`provider: "linux"` in the host config. The provider uses the system libvirt
namespace. Set `socketPath` when the socket is mounted somewhere other than
`/var/run/libvirt/libvirt-sock`. Libvirt operations and capability probes use
the explicit local Unix transport. Keep the socket path stable across restarts
and mount VM storage and templates at the same absolute paths that host
libvirtd sees.
