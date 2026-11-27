# Run canaverald on Kubernetes nodes

Canaverald runs on explicitly selected Linux nodes. The DaemonSet keeps its
identity, locks and recovery journals on the node. A replacement on the same node
uses that state. Use the host's native service manager for macOS.

The CPU profile stages CPU inference. The Rust model executor has its own bound
runner enrollment and application grants. See [model runtimes](model-runtimes.md)
and [runner enrollment](runner-enrollment.md). The VM profile mounts the host
libvirt socket and VM storage for administrative machines. QEMU runs on the
host under its own account, so the pod mounts no `/dev/kvm`; the daemon checks
KVM by asking host libvirtd (`virsh domcapabilities --virttype kvm`) over the
socket. Hosted k3s acceptance booted an administrative VM with QEMU group access
to storage and exercised headless amd64 [consumer VM leases](#consumer-vm-leases).
Keep the owned state for inspection if the controller reports an unknown
assignment. Containerd operations, Android and GPU execution are outside this
deployment. [Host libvirt setup](#host-libvirt-setup)

## Select and prepare nodes

Copy the CPU overlay at `deploy/kubernetes/canaverald` or the VM overlay at
`deploy/kubernetes/canaverald/vm` into your site configuration. Release
artifacts contain the same overlays under `canaverald/` and `canaverald/vm`,
with the image already pinned. Unlike the namespace-free controller stages,
this stage creates the `canaverald` namespace and a cluster-scoped admission
policy, so its applier needs cluster-scope permissions. Both profiles target the
same DaemonSet and ConfigMap. Choose one profile per installation. For a mixed
cluster, give each site's profile distinct DaemonSet selectors and names and
distinct configuration names, and maintain disjoint node labels.

Set `controller` to the controller's verified HTTPS URL. Create the namespace
first, then install its public CA certificate as a ConfigMap.

```sh
kubectl apply -f deploy/kubernetes/canaverald/base/namespace.json
kubectl -n canaverald create configmap canaveral-controller-ca --from-file=ca.crt
```

Pin the `ghcr.io/seventwo-studio/canaveral/canaverald` image to the digest that
the signed release records in `release.json` under `images.canaverald`. The
release workflow attests that digest's build provenance and pins it in the
signed deployment artifact. The example's `canaverald:local` refers to a
source-built image imported into a test cluster. Set the host name and offer to
match the intended enrollment, and reserve enough CPU, memory and node storage
for both the daemon and its workloads. Use separate configurations where nodes
require different offers.

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
owner `10001:10001` and mode `0700`, and, as UID 10001, writes
`bootstrap/enrollment-token` at mode `0600`. Each refused check prints the
path, what it found and what it expected. The daemon removes the token after
successful enrollment. Verify the enrolled ID, offer and advancing heartbeats on
the controller. Pod readiness checks local enrollment state. Keep the private
token out of Kubernetes manifests, logs and shared Secrets.

### Replace an unclaimed token

Replace a token only while it is unclaimed: it was never used because the setup
expired, was revoked or the token was issued for the wrong offer.

1. Remove the node label or otherwise ensure no canaverald pod runs on the node.
   The script refuses while a canaverald process runs as UID 10001.
2. Revoke the old setup with `canaveral connection-setups revoke SETUP_UUID`
   and create a new one as above.
3. Run `sudo bash script/provision_cluster_node.sh replace-token < /protected/new-token`.
4. Restore the node label.

The script refuses when `identity.json` exists (the node is enrolled) or when
`enrollment-intent.json` exists (a claim may have reached the controller; keep
the original token and follow the interrupted-claim recovery in
[runner enrollment](runner-enrollment.md#kubernetes-node-bootstrap)). It also
refuses a token that is not a regular `0600` file with one link owned by
`10001:10001`. It writes the new token to a private temporary file in the
bootstrap directory, flushes it and renames it over the old token, so the
daemon reads either the complete old token or the complete new one.

## Pod Security and admission policy

Kubernetes Pod Security Baseline and Restricted both reject `hostPath`, and Pod
Security has no path allowlist. The `canaverald` namespace therefore keeps PSA
`enforce=privileged`, with `audit` and `warn` at Restricted so anything beyond
the declared host paths is reported. Enforcement comes from the
`canaverald-pod-security` ValidatingAdmissionPolicy and its binding, which
apply to every Pod create and update, including ephemeral containers, in the
namespace named `canaverald`. A Pod is rejected unless:

- no container, init container or ephemeral container is privileged;
- `hostNetwork`, `hostPID` and `hostIPC` are unset or false, and no container
  uses a host port;
- every container sets `allowPrivilegeEscalation: false`, drops `ALL`
  capabilities and adds none;
- each `hostPath` volume is exactly `/var/lib/canaverald` (type `Directory`),
  `/var/run/libvirt/libvirt-sock` (type `Socket`) or
  `/var/lib/libvirt/images/canaveral` (type `Directory`).

The policy fails closed. It needs ValidatingAdmissionPolicy (`admissionregistration.k8s.io/v1`,
GA in Kubernetes 1.30). If you change the namespace, the socket path or the VM
storage path, patch the binding's namespace selector or the policy's
`hostPath` expression to match. Restrict who can modify cluster-scoped
admission policies and workloads in this namespace to trusted cluster
operators. The acceptance run checks that a compliant Pod is admitted, that a
privileged Pod outside the namespace is unaffected, and that privileged,
extra or `DirectoryOrCreate` hostPath, host network, host PID, added
capability, missing escalation setting, host port and privileged init
container Pods are rejected.

Both profiles run as UID 10001 with all capabilities dropped, RuntimeDefault
seccomp and service account token mounting disabled. The VM profile adds only
supplemental group `10003`, the libvirt socket group below. Keep kubelet and
container runtime sockets out of this namespace.

## Host libvirt setup

VM nodes need host QEMU and libvirtd. A process that can connect to the
writable system libvirt socket has host-level libvirt authority even through a
read-only bind mount. Delegate that authority only on dedicated, trusted nodes.
QEMU runs on the host, so account for its resources independently of pod
limits.

Install the distribution packages. On Debian and Ubuntu:

```sh
sudo apt-get install --no-install-recommends libvirt-daemon-system \
  libvirt-daemon-driver-qemu libvirt-daemon-config-network libvirt-clients \
  qemu-system-x86 qemu-utils ovmf dnsmasq-base polkitd
```

Then run `sudo bash script/provision_cluster_node.sh libvirt-host`. The
acceptance run uses that command; it is idempotent and makes exactly these
changes, which you can apply through configuration management instead:

| Change | Value | Why |
| --- | --- | --- |
| Group `canaveral-vm` | GID `10002` (`CANAVERAL_VM_GID`) | Shares VM storage with QEMU, never daemon state |
| Group `canaveral-libvirt` | GID `10003` (`CANAVERAL_LIBVIRT_SOCKET_GID`) | Owns the libvirt socket; the pod's only supplemental group |
| Host account `canaverald` | UID `10001`, primary group `canaverald` (GID `10001`), no home, `nologin`, no supplementary groups | Gives polkit a name for the pod's UID |
| QEMU account | Distribution default (`libvirt-qemu` on Debian and Ubuntu, `qemu` on Fedora; `CANAVERAL_QEMU_USER`) added to `canaveral-vm` | QEMU keeps its own UID and gains only VM storage |
| `/etc/systemd/system/libvirtd.socket.d/canaveral.conf` | `[Socket]` `SocketGroup=canaveral-libvirt`, `SocketMode=0660` | Socket `root:canaveral-libvirt` `0660` |
| `/etc/polkit-1/rules.d/60-canaveral-libvirt.rules` | Grants `org.libvirt.unix.manage` to user `canaverald` only | Used where the distribution keeps `auth_unix_rw = "polkit"` |
| VM storage `/var/lib/libvirt/images/canaveral` | Owner `10001:canaveral-vm`, mode `2750` (`CANAVERAL_VM_STORAGE`) | Daemon owns it; new entries inherit the group |

The script leaves `/etc/libvirt/qemu.conf` (`user`, `group`,
`dynamic_ownership`), `/etc/libvirt/libvirtd.conf` (`auth_unix_rw`) and
`/dev/kvm` at their distribution defaults. It refuses to continue if
`qemu.conf` overrides `user`, `group` or `dynamic_ownership`, or if
`auth_unix_rw` is anything other than `polkit` or `none`, and it prints the
effective `auth_unix_rw`. The acceptance run also checks with `dpkg --verify`
that both files are unmodified. It restarts the libvirtd
sockets only when the socket or group settings change; running QEMU
processes survive that. Restart the canaverald pod afterwards, because its bind
mount still refers to the replaced socket. It finally checks that UID 10001
with group `canaveral-libvirt` can run `virsh domcapabilities --virttype kvm`,
that the QEMU account can read VM storage and that it cannot enter
`/var/lib/canaverald`.

The socket mode admits only processes in `canaveral-libvirt`, which the pod
receives from its manifest. What happens next depends on the distribution's
`auth_unix_rw`. With `polkit` (upstream, Debian, Fedora), polkit also has to
allow the connection. It resolves the connecting UID through the host account
database, not the process's supplemental groups, so the rule names the
`canaverald` account. Ubuntu's packaged `libvirtd.conf` sets
`auth_unix_rw = "none"`; the hosted acceptance run on Ubuntu 24.04 uses that
default. Then the socket's owner, group and `0660` mode are the entire
authorization: any host process or pod with `canaveral-libvirt` gets full
libvirt authority, without a second check by account. Keep that group to the
canaverald pod and root, and keep the admission policy and the namespace's RBAC
limited, because a Pod that can mount the socket and add the group has the same
authority. Canaveral does not change this setting. If
you choose other GIDs, set the same values in the VM overlay's
`supplementalGroups` and pass them to the script.

Install templates as regular files owned by `10001:canaveral-vm` with mode
`0640`, at the paths in your ConfigMap. Provide signed or digest-verified
images. The daemon state directory stays `0700` and is not readable by
`canaveral-vm`.

Each Canaveral domain carries a static DAC label without relabelling,
`<seclabel type="static" model="dac" relabel="no"><label>libvirt-qemu:canaveral-vm</label></seclabel>`,
so libvirtd neither changes ownership host-wide nor chowns the daemon's files.
The daemon creates VM directories `2750` and disks `0660` in `canaveral-vm`,
which QEMU needs to open them. The distribution's AppArmor security driver
stays enabled: libvirt confines each QEMU process in its generated
`libvirt-<uuid>` profile, and `firmware="efi"` selects the packaged OVMF
build.

On hosted Ubuntu 24.04, the machines API booted the checksum-pinned CirrOS guest.
The controller observed it running, SSH answered, and QEMU ran under the configured
account and enforced AppArmor profile. After pod replacement, the same host
reported the same running domain with its original runtime ID. An API stop
retained the disk inode and disk reservation. After the host reported
`safeToPowerOff`, removing the node label and waiting for pod termination
allowed the overlay to be uninstalled. The stopped domain, disk, and host
identity survived. [Native acceptance run](https://github.com/seventwo-studio/canaveral/actions/runs/45436151644).

On Ubuntu, libvirtd's AppArmor profile denies `ptrace read` on the
`cri-containerd.apparmor.d` profile each time the pod connects. libvirtd is
trying to inspect the connecting client process. Every libvirt call from the
pod still succeeds, and with `auth_unix_rw = "none"` no polkit subject check
depends on it, so Canaveral leaves the profile unchanged. On hosts that keep
`auth_unix_rw = "polkit"` with AppArmor enabled, the effect of the denial has
not been verified.

Administrative starts use host libvirtd and can keep running through pod
replacement. Verify the same host ID, domain and owned disk when the pod returns.
Stop an administrative machine through Canaveral and confirm the observed stop
before maintenance. A stop retains the disk and its reservation. Verified
administrative deletion remains outside this profile's lifecycle.

### Consumer VM leases

Consumer VM leases use transient domains and require Linux 6.5 or later for
Unix peer pidfds. On an amd64 VM node, declare a headless x64 Linux template with
`firmware: "bios"` and without TPM, secure boot, guest access or a preparation
recipe. Set `leaseProtocol: 1` and add the template's `id`, `revision`, `arch`
and `runtime: "libvirt"` to `leaseImages`. Enroll with that offer and verify
`leases: {eligible: true}` on the libvirt row in `canaverald runtimes status`.

The image installs the root-owned helper at
`/usr/local/lib/canaveral/canaveral-libvirt-native`. The VM ConfigMap uses it for
both `leaseHelper` and `leaseClockHelper`. The signed deployment artifact sets
`leaseHelperSha256` from `libvirtLeaseHelper.sha256.amd64` in its
`app-release.json`. The release workflow hashes the helper in each published
image platform and includes both hashes in `release.json`. For a source-built
image, replace the all-zero template value with the SHA-256 of the helper in
that image before declaring lease images. An image change requires a matching
ConfigMap pin.

When a pod exits, its guardian and connection worker exit with it. The
replacement takes the lease lock and reconciles the domain from the node-local
journal. It checks the UUID, launch nonce, lease and recorded domain ID before
destroying a matching live domain. It requires fresh proof of absence before
erasing the overlay and releasing the reservation.

The pod has neither the host PID view nor `CAP_KILL`. If libvirtd is unavailable
through a lease deadline, QEMU can keep running until libvirtd returns. The
receipt reports `libvirt-unconfirmed`, and the reservation stays held until the
fence and cleanup complete. This is an accepted in-cluster gap. The bare-metal
`canaverald.service` uses `OOMPolicy=continue` so an OOM-killed guardian fences
its own lease while canaverald continues serving the others. The bare-metal
`CAP_KILL` drop-in provides the PID-checked fallback described in
[libvirt supervision](libvirt-supervision.md).

## Upgrades, recovery and removal

Apply the reviewed image digest and configuration. OnDelete leaves existing pods
in place until you replace them. Before touching each node, begin a Canaveral
maintenance drain and wait for `safeToPowerOff`. Delete that pod, confirm the
replacement reports the same ID and fresh heartbeats, and resume the drain once
the controller indicates it is safe. Use the same drain before cordoning or
draining a node for infrastructure work. Kubernetes owns daemon updates in this
profile.

The daemon's shutdown budget, `shutdownGraceSeconds`, defaults to 120 seconds.
Tini runs as PID 1, reaps orphaned processes and forwards SIGTERM to canaverald.
Canaverald runs as Tini's child, so each lease guardian can verify its own
daemon parent inside the pod's PID namespace.
The pod's `terminationGracePeriodSeconds` is 150. Keep
`shutdownGraceSeconds` at most `terminationGracePeriodSeconds` minus 30, so the
daemon finishes its bounded cleanup before Kubernetes sends SIGKILL. The release
bundle refuses manifests that break this rule; check it again whenever a site
overlay changes either value.

A `kubernetes_bootstrap_token_invalid` response calls for checking token file
ownership, mode and links. With `kubernetes_bootstrap_recovery_required`, restore
the original token and preserve the identity and enrollment intent. The daemon
returns `kubernetes_managed_updates_disabled` for direct self-updates and
`kubernetes_containerd_disabled` for containerd operations.
`libvirt_runtime_not_configured` is expected on a CPU-profile pod.
`libvirt_kvm_probe_failed` on a VM pod means host libvirtd did not report KVM
over the mounted socket; rerun `provision_cluster_node.sh libvirt-host` on the
node.

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
