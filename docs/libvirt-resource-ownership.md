# Libvirt runtime resource attribution

2026-11-03 source/fixture checkpoint. This adds process accounting to the existing
host observer; it does not establish native Linux acceptance or enable leases.

## Ownership and scope

The libvirt adapter now provides `resource_processes` for assigned administrative
and leased VMs. The collector checks assignment/storage fingerprints and exact
native domain UUID, name and owned writable disk. Leases additionally require
their immutable boot binding, current kernel boot and native ownership metadata.
Filesystem/device passthrough is outside this collector's supported scope.

A dedicated native libvirt connection issues only the fixed read-only QMP
`query-cpus-fast` command. Its host thread IDs must resolve to one QEMU process,
whose executable matches native XML and whose arguments carry the assigned UUID.
This is a live identity anchor, not adoption by process name, saved PID or cgroup
name. The [QMP reference](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html#command-query-cpus-fast)
defines the returned host thread IDs. The [libvirt monitor API](https://libvirt.org/html/libvirt-libvirt-qemu.html#virDomainQemuMonitorCommand)
permits state-querying commands but requires its existing monitor access
permission. The collector never grants permissions or exposes arbitrary commands.

The anchor's kernel membership selects only the matching libvirt VM cgroup,
including its helper subgroups. Both systemd scopes and non-systemd consumer names
are recognized, including truncated systemd guest names. The native domain ID
and QMP process anchor qualify that path; a matching name alone is insufficient.
The [libvirt layout](https://libvirt.org/cgroups.html) distinguishes VM consumers
from shared partitions. Sibling VMs and the containing host slice are excluded.

The current implementation requires an unambiguous full cgroup-v2 mount and the
corresponding PID namespace visibility. It reads each regular domain's process
list and handles threaded subtrees through their domain root's process list, as
specified by the [kernel cgroup-v2 interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
PID entries are deduplicated; there is no total process-count cap. Metadata reads
use bounded records. No global process scan or device SDK call runs.

## Measurement and uncertainty

The collector validates native identity, kernel boot and cgroup membership before
and after collection. Returned process wrappers recheck process birth, QEMU
executable/arguments, group identity and membership after counters are read. The
last VM process also rechecks full membership, withholding partial totals when
another helper appeared during measurement. Identities also found in the runner
tree are measured once. Failed explicit VM identities cannot reappear as generic
runner services in the same sample.

Memory remains summed process RSS, not unique physical memory or guest allocation.
CPU remains normalized to measured host CPU count; its first observation, missing
host CPU count, invalid counters or counter rollback cannot invent usage. These
samples remain separate from configured budgets, reservations and host totals.
Inventory and counter reads are not an atomic kernel snapshot.

Missing native libraries/permissions, unsupported or partial cgroup mounts,
unreadable members, changed ownership and uncertain native replies make the VM
category unavailable. A repeated owned inactive-domain observation can establish
no current QEMU usage for the supported single-process case. An inactive domain
with an external TPM helper stays unknown because SHUTOFF alone does not prove
that helper exited. Missing domains and missing metadata are not empty samples.

Collection runs in the existing single background observer, outside heartbeats.
A blocked native call does not start replacement observers or delay heartbeats;
it can leave resource data stale. Observation creates no runtime receipts, takes
no runtime locks, signals no process, changes no cgroup membership and adjusts no
capacity or cleanup state.

## Evidence still required

Twenty-six new fixtures use fake native drivers/processes and private fake proc/
cgroup trees. They cover scoped helper inclusion, sibling exclusion, threaded
groups, PID reuse, migration, membership churn, domain/boot/lease changes, unknown
metrics, native response parsing and handle release. Source, binary and memory
operations are real where appropriate; there is no real libvirt/QEMU connection.

Native Linux acceptance must verify installed libvirt/QEMU versions, kernel/PID
namespace visibility, actual scope layout and helper placement, restart recovery,
counter responsiveness and totals against host observations. Cgroup-v1 and
unavailable native interfaces remain explicitly unknown. This fixture checkpoint
does not close host accounting or the wider execution goal.
