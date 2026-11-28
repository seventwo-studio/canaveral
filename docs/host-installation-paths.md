# Host installation paths

Accepted product direction. Canaveral OS and automatic OS rollouts are planned.
The existing runner onboarding flow is the foundation for the helper path.

**Hosts → Add host** should offer two choices. Both enroll with the same
Canaveral controller and use the same host inventory, scheduling, health and
maintenance controls. Placement depends on each host's advertised capabilities,
health, capacity and workload-specific eligibility. Native qualification of a
runtime is a separate, recorded step (see [runtime qualification](runtime-qualification.md))
and is not a placement input. On Kubernetes, [canaverald enrolls selected nodes](cluster-hosts.md)
as hosts and uses host libvirt for VMs.

| Path | Onboarding | Update ownership |
| --- | --- | --- |
| **Install Canaveral Helper** | Install the runner on an existing Linux, macOS or Windows host. Select supported runtimes, check prerequisites and enroll using a scoped setup credential. | On supported, configured Linux and macOS installations, Canaveral can update its own components under the operator's policy. Windows hosts can enroll, but the managed-runtime bootstrap installer refuses Windows because its ACL handling is not accepted. The operator manages the OS, system dependencies and reboots. |
| **Install Canaveral OS** | Boot a signed Linux installer on a dedicated node, confirm the target disk locally, apply declarative node configuration and enroll the built-in runner. | Canaveral manages the OS and its bundled runtime as a release. The operator selects the release channel and rollout policy. |

Kubernetes owns daemon updates for DaemonSet installations.

See [runner onboarding](infrastructure.md#connect-a-runner) and
[managed runtime updates](runtime-updates.md) for current implementation and
platform acceptance limits.

## Automatic OS rollout proposal

Use two boot slots for signed releases. Preserve node identity, credentials,
update receipts and workload data outside the slots. Both OS versions must
read that state during the rollback window. Incompatible state migrations
require a separate rollout.

Start with canaries by hardware and runtime class. Count offline, draining and
trial nodes against the same availability budget. Check compatible spare capacity
and storage replica health before draining another node. Expand in waves after a
healthy soak period and pause the release after an unexpected rollback.

1. Verify and stage the candidate in the inactive slot, retaining the verified
   previous slot.
2. Close admission and let active leases finish. Move persistent workloads only
   after fencing the old writer and verifying the replacement. Defer if a
   workload cannot safely stop or move within policy.
3. Confirm drain and storage ownership. Wait for the remaining fleet to stay
   healthy through the stabilization window before rebooting.
4. Boot the candidate as a bounded trial with tenant admission closed. Verify
   boot identity, networking, storage and runtime health. Run and clean up a
   disposable workload. Commit and reopen admission after fresh controller
   reconciliation.
5. Fall back if the trial fails or expires, including when the controller is
   unreachable. Use bootloader fallback for failures before userspace. The
   admission fence survives the rollback: a trial attachment or cleanup whose
   outcome is uncertain stays unresolved on the previous slot too. Verify the
   previous slot, then reopen admission only after fresh controller
   reconciliation of the node's assignments, storage ownership and pending
   operations. If either fails, keep the node drained and alert the operator.

The first native milestone is a disposable Linux fleet that exercises a
successful rollout, broken boot, failed workload probe, controller disconnect,
and interrupted activation. Verify that rollback preserves identity and volume
contents and that an unsafe drain defers reboot. Host-local volumes with
verified stops are sufficient for this milestone. Portable volumes can let
eligible workloads move during a drain.

## Persistent storage proposal

Give Linux data volumes an identity independent of the VM and allow one writable
attachment at a time. Start with snapshots after a verified stop and backups to
operator-configured off-host object storage. A stop alone does not identify the
data: a snapshot or backup requires positive matches for the source assignment
and its volume, and uses credentials scoped to that volume's backup location.
Restore into a fresh volume, bound to the same owner, on a compatible
replacement host, verify its contents and measure recovery time and
the amount of data lost since the last backup. Test with the source host offline.

Evaluate whether Longhorn can provide recoverable volumes for the current
host-libvirt deployment on Kubernetes. Automatic failover of the same volume
requires a backend that can revoke the old host's write access before
reattachment, including when the old host is unreachable. A missed heartbeat
does not establish that fence. See [current host recovery limits](power-and-recovery.md#planned-maintenance-and-same-host-recovery)
and [cold capture](images.md#cold-capture).
