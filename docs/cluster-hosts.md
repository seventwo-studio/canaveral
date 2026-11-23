# Run canaverald on Kubernetes nodes

Canaverald runs on explicitly selected Linux nodes. The DaemonSet keeps its
identity, locks and recovery journals on the node. A replacement on the same node
uses that state. Use the host's native service manager for macOS.

The CPU profile stages CPU inference. The Rust model executor has its own bound
runner enrollment and application grants. See [model runtimes](model-runtimes.md)
and [runner enrollment](runner-enrollment.md). The VM profile mounts host libvirt,
KVM and VM storage for administrative machines. Consumer libvirt leases require
a production native connection, supervisor and owned-storage adapters. The
controller's bound Linux lease API currently admits Apple Virtualization.
Native acceptance of administrative VM startup remains open. The hosted test
reached a durable prepared state, but the definition command could not reopen
the Node child process's standard input. Keep the owned state for inspection if
the controller reports an unknown assignment.
Containerd operations, Android and GPU execution are outside this deployment.

## Select and prepare nodes

Copy the CPU overlay at `deploy/kubernetes/canaverald` or the VM overlay at
`deploy/kubernetes/canaverald/vm` into your site configuration. Both target the
same DaemonSet and ConfigMap. Choose one profile per installation. For a mixed
cluster, give each site's profile distinct DaemonSet selectors and names and
distinct configuration names, and maintain disjoint node labels.

Set `controller` to the controller's verified HTTPS URL. Create the namespace
first, then install its public CA certificate as a ConfigMap.

```sh
kubectl apply -f deploy/kubernetes/canaverald/base/namespace.json
kubectl -n canaverald create configmap canaveral-controller-ca --from-file=ca.crt
```

Pin the published `ghcr.io/seventwo-studio/canaveral/canaverald` image by digest
in your overlay. Use the image index digest attested by the tagged release
workflow. The example's `canaverald:local` refers to a source-built image
imported into a test cluster. Set the host name and offer to match the intended
enrollment, and reserve enough CPU, memory and node storage for both the daemon
and its workloads. Use separate configurations where nodes require different
offers.

Create a separate single-claim connection setup for each node. Run the CLI
with operator credentials and the exact host configuration for that node. A setup
expires after 30 minutes if it has yet to be claimed.

```sh
NODE_EXTRA_CA_CERTS=/protected/ca.crt canaveral --url "$controller" \
  --token-file "$operator_token_file" connection-setups create \
  --config host.json --id "$setup_uuid" --output-file /protected/per-node-token
```

Deliver the token to the intended node through protected input, then write it
to the private state directory before attaching the node label.
See [runner enrollment](runner-enrollment.md#kubernetes-node-bootstrap).

```sh
sudo bash script/provision_cluster_node.sh < /protected/per-node-token
kubectl label node NODE canaveral.dev/host-profile=cpu
kubectl apply -k SITE_OVERLAY
kubectl -n canaverald get pods -l app.kubernetes.io/name=canaverald
kubectl -n canaverald exec daemonset/canaverald -- canaverald runtimes status \
  --config /etc/canaverald/host.json --state /var/lib/canaverald --json
```

Provisioning takes place on the node. It creates `/var/lib/canaverald` with
owner `10001:10001` and mode `0700`, and writes `bootstrap/enrollment-token` at
mode `0600`. The daemon removes the token after successful enrollment. Verify
the enrolled ID, offer and advancing heartbeats on the controller. Pod readiness
checks local enrollment state. Keep the private token out of Kubernetes
manifests, logs and shared Secrets.

## Pod Security and VM authority

Kubernetes Pod Security Baseline and Restricted both reject `hostPath`. The
dedicated `canaverald` namespace uses PSA `enforce=privileged` to allow the
mounts, with Restricted audit and warnings. Namespace enforcement is coarse.
Limit workload creation and modification there to trusted cluster operators
and restrict any admission exception to these workloads and paths:

- Both profiles mount the existing private state directory.
- The VM profile additionally mounts `/var/run/libvirt/libvirt-sock`,
  `/dev/kvm` and `/var/lib/libvirt/images/canaveral`. Keep the storage path
  identical on the node and in the pod so libvirtd can resolve the daemon's disks.

Both profiles run as UID 10001 with all capabilities dropped, RuntimeDefault
seccomp and service account token mounting disabled. Keep privileged containers,
host namespaces, and kubelet and container runtime sockets out of this
namespace's workload permissions.

For VM nodes, install and start host QEMU and libvirtd. Set the node label to
`vm` and patch the VM overlay with the numeric supplemental group authorized
to use the socket. Check the QEMU account's storage access and provide signed or
digest-verified templates at the configured paths. A process that can connect to
the writable system libvirt socket has host-level libvirt authority even with a
read-only bind mount. Delegate that authority only on dedicated, trusted nodes.
QEMU runs on the host, so account for its resources independently of pod limits.
Administrative starts use host libvirtd and can keep running through pod
replacement. Verify the same host ID, domain and owned disk when the pod returns.
Stop an administrative machine through Canaveral and confirm the observed stop
before maintenance. A stop retains the disk and its reservation. Verified
administrative deletion and connection-bound AUTODESTROY require native adapters
that the current daemon does not ship.

## Upgrades, recovery and removal

Apply the reviewed image digest and configuration. OnDelete leaves existing pods
in place until you replace them. Before touching each node, begin a Canaveral
maintenance drain and wait for `safeToPowerOff`. Delete that pod, confirm the
replacement reports the same ID and fresh heartbeats, and resume the drain once
the controller indicates it is safe. Use the same drain before cordoning or
draining a node for infrastructure work. Kubernetes owns daemon updates in this
profile. The daemon has a 90-second shutdown budget. The pod allows 120 seconds before Kubernetes
forcibly terminates it.

A `kubernetes_bootstrap_token_invalid` response calls for checking token file
ownership, mode and links. With `kubernetes_bootstrap_recovery_required`, restore
the original token and preserve the identity and enrollment intent. The daemon
returns `kubernetes_managed_updates_disabled` for direct self-updates and
`kubernetes_containerd_disabled` for containerd operations.
`libvirt_runtime_not_configured` is expected on a CPU-profile pod.

Keep the original state for interrupted claims, crash recovery and uncertain
operations. If the daemon exits with `host_shutdown_incomplete`, verify
workload and storage state independently before resuming admission. A replacement node needs its own enrollment after fencing and
retiring the old host. After a hard termination, check the controller
reservations and establish independent stop and cleanup proof before clearing
any state. For a failed claim, inspect the setup and preserve the staged identity,
token and journals for the exact retry. See
[host maintenance and recovery](power-and-recovery.md).

To uninstall, drain and verify every host's safe-to-power-off status, then remove
the node labels and delete the DaemonSet. The hostPath survives uninstall.
Retain it privately for same-node recovery or, after verifying cleanup and
retiring the identity, explicitly purge it and any owned VM storage on the node.
