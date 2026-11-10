# KubeVirt workload ownership and resource usage

KubeVirt reports namespace-wide utilization separately from the current runner's
assigned VM pods. `usage.cluster.metrics` and ResourceQuota values still include
other namespace workloads. The optional `usage.cluster.canaveral` report has
`scope: assigned-vm-pods`, ownership coverage and its own CPU/memory/pod metrics.
An assigned workload is included in the namespace total; the two values must not
be added together. Neither observation changes placement reservations or host limits.

## Creation identity

New VM creation saves `kubevirt-create.json` in the private assignment directory
before issuing the create. It binds a creation UUID to the canonical machine ID,
namespace/name, lease ID and assignment fingerprint. The request carries the
creation UUID and fingerprint as annotations. The successful JSON response pins
the Kubernetes VM UID in `kubevirt-owner.json`.

After a lost response, reconciliation can recover that UID only from the object
matching the saved request and its annotations. A different incarnation, changed
binding or same-name object without the creation identity is refused. A pending
request blocks automatic recreation and repeated preparation-Secret mutations.
Absent VM state does not confirm stop while creation is unresolved or a same-name
VMI still exists.

Legacy administrative VMs retain their existing control path, but labels alone
do not create a new ownership receipt or qualify their usage. Observation never
adopts a VM or writes ownership evidence. Existing unknown identities need
separate review; restarting a runner does not establish measured ownership.

## Owned pod graph

The collector requires matching local assignment and VM ownership receipts,
the current VM UID and creation annotations, and controller references from
VMI → VM and pod → VMI. Pod-owned support pods are followed recursively through
their parent UID. Controller kind, API version, namespace, names and UIDs must
agree. Labels may corroborate a binding; they cannot replace it. Contradictory
labels, duplicate identities, cycles and missing support parents with known VMI
identity withhold the owned total.

Migration source and target pods both count toward observed usage. They remain
one admitted machine in the reservation ledger. Verified support pods and their
containers also count once. This is the assigned VM pod subtree, not a complete
Canaveral cluster total: shared cluster services, CDI import/provisioning pods
outside that subtree, physical node utilization and storage bytes need their own
ownership/measurement contracts. Worker process metrics retain `scope: runner`.

## Coverage and change detection

Namespace and owned totals use the same initial pod inventory and Metrics API
response. A namespace can be incomplete while the owned subset has complete
measurements. The owned subset requires all active verified pods, their regular
containers and running init/ephemeral containers. Finished pods add no usage.
Duplicate, missing, stale or malformed readings withhold the total.

Owned readings require a positive Metrics API averaging window of at most 120
seconds, entirely after that pod's creation time. A provided metrics UID must
match the inventory UID. When the API omits it, the collector also relies on the
creation/window checks and repeated inventory identity. The existing timestamp
freshness bounds still apply.

A second VM/VMI/pod inventory and local-receipt read verifies that relevant
identities, ownership, pod membership and container coverage stayed unchanged.
Churn withholds the owned total. These reads are not an atomic cluster snapshot
and cannot prove native fencing, object deletion or quota release. Successful
empty inventories/metrics can establish measured zero; missing APIs, partial
lists, unknown assignments or missing ownership never become zero.

The environment worker passes a copied assignment snapshot to the collector.
If its ownership-relevant assignment state changes before publication, only the
owned portion is replaced with unavailable evidence; namespace observations stay
separate. Collection uses bounded read commands outside heartbeats. Existing
controllers accept legacy reports without the optional owned field; new reports
require the updated controller validator.

## Dashboard and verification

The host/orchestrator overview shows **Canaveral VM workloads** separately from
namespace utilization and quotas. It reports unknown ownership/metrics explicitly
and preserves fractional CPU cores. Source changes are built and tested privately;
activation of served assets remains a separate operation.

Disposable provider, controller-validation and worker fixtures cover creation
response loss, single-create recovery, UID replacement, failed creates, orphaned
VMIs, read-only ownership, unrelated namespace workloads, migration/support pods,
spoofed labels, churn, metrics windows/UIDs, incomplete lists, absent metrics,
empty scope and assignment changes. Dashboard fixtures check separate totals,
unknowns, small CPU measurements and narrow layouts. No live cluster was queried
or changed. Real cluster accounting, native lifecycle/cleanup and other runtime
attribution remain acceptance gates.

The graph follows the Kubernetes
[OwnerReference contract](https://kubernetes.io/docs/reference/kubernetes-api/definitions/owner-reference-v1-meta/)
and the KubeVirt
[launcher/support pod controller references](https://github.com/kubevirt/kubevirt/blob/main/pkg/virt-controller/services/template.go),
checked 2026-11-03. Compatibility with an installed cluster still needs native
acceptance.
