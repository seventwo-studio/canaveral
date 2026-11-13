# Running Canaveral

Run the TypeScript control plane on Node.js 24 or later, directly or in a matching container image. Native host agents run where their hypervisor is installed. macOS guests stay on Apple hardware. A Linux container does not add Hyper-V or Apple Virtualization to its host; Docker Desktop on a Mac is not the Apple host backend.

## Installation and target boundaries

Keep the production controller in Docker and update its immutable image through the external deployment workflow. Direct controller commands below remain available for development and existing operator-managed layouts. Managed host updates do not replace the controller, Node, stable bootstrap, service manager or trust roots; see [installation and recovery](runtime-updates.md#install-the-stable-bootstrap-once).

| Target/path | Required boundary |
| --- | --- |
| Docker controller | Persistent SQLite/identity/credentials; externally selected image; no runtime self-update |
| Unix initial managed installation | Offline verified expansion on current Linux/Darwin amd64/arm64; fresh private roots; generated service definition only |
| Linux host, libvirt | Native KVM/libvirt and prepared images; service account owns its private state and authorized storage |
| macOS host, Apple VM | Apple hardware and admitted native runner; native boot/stop/cleanup acceptance remains backend-specific |
| Windows host, Hyper-V | Supported host edition and Hyper-V authority; operator-provisioned private ACLs require Windows acceptance |
| Kubernetes worker, KubeVirt | Separate KubeVirt/CDI installation and scoped resource ownership; bounded execution creation remains gated on independent fencing |
| Android/iOS runners | Installed native SDKs and explicit adapter configuration; helper staging does not prove adoption or device acceptance |
| Linux direct-boot guest | ARM64 Image/EROFS/bootstrap inputs and trusted per-launch medium; native handoff acceptance remains open |
| Model runner | Existing enrollment and configured model runtime; real inference and accelerator acceptance are separate |

This matrix describes configured paths and prerequisites, not platform parity or consumer lease eligibility. Ordinary hosts still reject experimental lease declarations; retain the [eligibility gates](lease-eligibility.md). Follow the [operator acceptance steps](runtime-updates.md#operator-acceptance-prepare-only-separate-authorization-required) before claiming an installation or rollout accepted.

Hosts preparing for qualified Linux/macOS lease execution may set
`leaseClockHelper` to an absolute installed `canaveral-mobile-native` executable.
It must be a nonsymlink, single-link regular file, executable, owned by root or
the service account and not writable by group/others. Its ancestors must also be
root/service-owned and not writable by group/others; root-owned sticky temporary
directories are allowed. This selects the
[boot-bound native deadline clock](leases.md) before runner state is created;
it does not enable consumer execution or replace native fencing/cleanup checks.

## Native controller and hosts

Install dependencies with `npm --prefix coordination ci --ignore-scripts`, build
with `npm --prefix coordination run build` and run
`node coordination/dist/src/cli.js --help` from the checkout. The root npm scripts build and check the workspace; the installed `canaveral`
binary runs this compiled CLI. `node coordination/dist/src/cli.js init ./secrets` creates private credential files. It refuses to overwrite existing files. Start `serve` as in [self-hosting](self-hosting.md#one-server); its default bind address is loopback. For access from other machines, provide a TLS proxy and set `--bind` to the intended private interface. Persist `--database` and keep administrator credentials with the owner.

Use [user accounts and scoped personal API tokens](accounts-and-tokens.md) for
normal machine access. Users own private machines; admins manage all users and
machines. Keep operator and runner-enrollment credentials separate. Back up an
existing controller database before its first upgrade to the user account schema.

Copy an example from `examples/` into a private host configuration. Set a deliberate host capacity limit, correct architecture, bootable base image paths and immutable revision IDs. Use reusable template files and preparation recipes as described in [Configurable computers](templates.md). Remove templates that are not installed. On each host:

```sh
node coordination/dist/src/cli.js --url https://canaveral.example.internal host \
  --config /etc/canaveral/host.json --state /var/lib/canaveral/agent \
  --enrollment-token-file /etc/canaveral/enrollment.token
```

Deliver the enrollment file through your normal secret-management channel. After successful enrollment the agent can restart without the enrollment argument using its saved per-host identity. Keep its state private and persistent. Do not reinitialize identity on each launch.

For Linux, install KVM, libvirt, `virsh`, `qemu-img` and matching EFI firmware. Desktop guests need graphical prepared images; Windows 11 templates also need suitable firmware and `swtpm`. The configured libvirt network must exist. The service account must have local libvirt access and access to the template/storage directories. Let the host's libvirt ownership and SELinux/AppArmor policies govern runtime disk access; do not place the disks under the private agent-credential directory. `deploy/systemd/canaveral-host.service` is an editable service example.

For Windows, enable Hyper-V on a supported host edition, install Node.js 24 or later and use prepared Generation 2 VHDX templates plus an existing virtual switch. Run the agent under an account authorized for Hyper-V. Configure private state/storage paths in the Windows example. For first-boot preparation, use a base with Cloudbase-Init enabled and a ConfigDrive recipe. Windows guests require appropriate usage rights; Microsoft's [Enterprise evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise) lasts 90 days. Canaveral does not bypass activation or licensing.

For Apple hosts on macOS 26+, the operator-authorized native build command is `./script/build_apple_runner.sh`. It builds and signs `dist/CanaveralVMRunner` with the existing Apple Development identity; set `CANAVERAL_SIGNING_IDENTITY` if identity selection is ambiguous. Configure its absolute path and private disk storage in `host-apple.json`. macOS templates use a local compatible IPSW and Apple silicon. Linux templates use standalone raw or supported QCOW2 disks for the host architecture. The retained QCOW2 importer has its documented 16 GiB virtual-size limit; use raw images for larger templates. Whole-GiB memory is required. Increase template minimums if an IPSW requires more resources; provisioning never silently exceeds the reservation. Native runners retain their own runtime locks and keep running when the TypeScript host exits. Check a machine's `runner.log` and native status before clearing an uncertain `runner-launch.json` receipt.

Linux cloud-init templates can configure accounts, public SSH keys, software and workload checks during preparation. Other image types need their declared bootstrap mechanism installed or remote access configured. Disk expansion changes virtual device capacity; growing guest partitions/filesystems remains the guest's responsibility.

The headless Apple runner retains the serial console's bounded tail in private
`console.log` beside `status.json`. Use it to distinguish a firmware prompt,
guest boot failure and cloud-init failure when the hypervisor reports Running
but no guest preparation receipt arrives. This log is available after rebuilding
the native runner; controller container updates do not replace native binaries.

New KubeVirt VMs from 0.2.2 pin their NIC MAC to the Canaveral machine identity.
Earlier VM definitions may have no `macAddress`, allowing a replacement VMI to
receive a new one. Guests whose saved networking matches the original MAC can
then lose network access. Upgrading does not rewrite existing VM interfaces:
record the original MAC from the first VMI or the guest's network configuration,
stop the legacy VM, and explicitly pin that original address before restarting.
Preserve the VM, preparation Secret and disk identities. Do not infer the old
address from an already replaced VMI or recreate its disk to repair networking.

## Docker

Container and deployment files must select the Node.js runtime and the same CLI
entry point as the source release. Existing deployment inputs are configuration
examples, not proof of a completed upgrade or provider acceptance.

Android emulator and iOS simulator runners use native SDKs rather than the VM
backends above. See [mobile devices](devices.md) for host prerequisites, examples,
control operations and acceptance. The controller can stay in Docker or Kubernetes.

Set `CANAVERAL_TLS_DIRECTORY` to an absolute directory containing your TLS files before using Compose. The Compose example keeps state and credentials in separate named volumes, with private credentials readable by the container's fixed user:

```sh
docker compose --profile setup run --rm init
docker compose up -d orchestrator
docker compose run --rm --no-deps -e NODE_EXTRA_CA_CERTS=/run/tls/ca.crt orchestrator \
  --url https://orchestrator:8765 \
  --token-file /run/credentials/admin.token hosts
```

Run initialization once. It intentionally fails if credential files already exist. The host-published port is bound to `127.0.0.1`; add your private TLS proxy for remote use. Set `CANAVERAL_TLS_DIRECTORY` before running Compose. It must contain `server.crt`, `server.key` and `ca.crt`, readable by UID 10001. The server certificate must cover `orchestrator` and any external name clients use. The CLI call trusts that CA through `NODE_EXTRA_CA_CERTS`. Export an enrollment file to a protected local destination if registering native hosts, for example by redirecting `docker compose run --rm --no-deps --entrypoint cat orchestrator /run/credentials/enrollment.token` directly to that file; do not paste credentials into chat or command-line flags.

The [optional web dashboard](dashboard.md) runs separately with `node coordination/dist/src/cli.js dashboard` or `docker compose --profile dashboard up -d`. It is not required by the orchestrator. Kubernetes has a separate opt-in `deploy/kubernetes/dashboard` Deployment and internal Service.

Build the worker images when needed:

```sh
docker build --target orchestrator -t canaveral:local .
docker build --target libvirt -t canaveral-libvirt:local .
docker build --target kubevirt -t canaveral-kubevirt:local .
```

A Linux libvirt worker container must reach the host's libvirt Unix socket and see image/disk paths at the same absolute paths as the host daemon. Mount only the intended socket, template directory, VM storage and private agent-state volume. The orchestrator itself does not require host virtualization privileges or access to host disks. The KubeVirt image uses `kubectl`; set `KUBECTL_VERSION` at build time to a version compatible with your cluster. The Apple and Hyper-V agents run natively.

## Kubernetes

The namespace overlays in `deploy/kubernetes/` use the namespace-free
`deploy/orchestrator`, `deploy/dashboard` and `deploy/kubevirt` stages as their
single source. Build/load the local images or select immutable released image
references through a site overlay. Configure storage classes before applying if
your cluster has no default class. The controller and worker need persistent volumes.

Provision TLS before starting the pods. Supply a CA-signed server certificate
(`server.crt`, including intermediates), its key (`server.key`) and the trust root
(`ca.crt`). Its DNS SANs must include `orchestrator`, `orchestrator.canaveral`,
and `orchestrator.canaveral.svc`, plus any external ingress name. The dashboard
uses `https://orchestrator:8765`; the worker uses
`https://orchestrator.canaveral.svc:8765`. Your existing PKI or cert-manager can
issue these files; cert-manager is optional. Keep the key private.

For a fresh installation, run these ordered steps from a built checkout:

```sh
# Create namespaces and enforce Restricted Pod Security for the shipped pods.
kubectl apply -k deploy/kubernetes/namespaces
# One-time initialization refuses to overwrite existing credential files.
node coordination/dist/src/cli.js init ./secrets
kubectl -n canaveral create secret generic canaveral-credentials \
  --from-file=admin.token=./secrets/admin.token \
  --from-file=enrollment.token=./secrets/enrollment.token
kubectl -n canaveral create secret tls canaveral-controller-tls \
  --cert=./tls/server.crt --key=./tls/server.key
kubectl -n canaveral create configmap canaveral-controller-ca \
  --from-file=ca.crt=./tls/ca.crt
kubectl -n canaveral-guests create configmap canaveral-controller-ca \
  --from-file=ca.crt=./tls/ca.crt
kubectl -n canaveral-guests create secret generic canaveral-enrollment \
  --from-file=enrollment.token=./secrets/enrollment.token
kubectl apply -k deploy/kubernetes/orchestrator
# Optional dashboard; requires the CA ConfigMap above.
kubectl apply -k deploy/kubernetes/dashboard
```

Use one replica with the included Recreate strategy and persistent local/block storage for SQLite. The controller does not need Kubernetes API access. Add a private TLS ingress for external native hosts. For port-forward access, retain a URL hostname covered by the certificate and resolve it to loopback locally; a loopback IP URL needs its own IP SAN. Keep CA verification enabled.

Running VMs inside Kubernetes requires a working KubeVirt + CDI installation, virtualization-capable nodes, suitable firmware, storage and prepared template PVCs. It is separate from merely running the Canaveral orchestrator in a pod. KubeVirt handles KVM access and pod scheduling; the controller pod is not privileged. macOS VM creation continues through separate Apple hosts, not generic Kubernetes Linux nodes.

Set the intended templates, architectures and pool capacity in a patch to `deploy/kubevirt/configmap.json`; select the worker image in your site overlay over `deploy/kubernetes/worker-kubevirt`. Its default examples require `linux-server-template` and `linux-desktop-template` PVCs in `canaveral-guests`. Source PVCs must be offline and their sizes must fit the advertised minimums. Build/load the worker image and provision the namespace, CA and enrollment Secret above, then apply:

```sh
kubectl apply -k deploy/kubernetes/worker-kubevirt
```

The CLI accepts credentials only as regular files owned by its user with mode `0600`, and keeps host state in a directory with the same ownership and mode `0700`. Kubernetes Secret volumes are root-owned symbolic links, and a fresh volume root is not private to the process user. The controller and worker therefore copy their Secret entries into a memory-backed volume with a `stage-credentials` init container, and the worker keeps its state in `/data/host` on its PVC. An existing worker whose identity was saved at the PVC root needs `--state /data` kept, or a deliberate move of that directory, to keep the same host identity. Both pods set `fsGroupChangePolicy: OnRootMismatch`, so the kubelet adjusts group ownership only while the volume root does not yet match. The default recursive change would add group permissions to `/data/host` on every remount, and the worker would then refuse its own state. Storage drivers that ignore `fsGroup` must still give user 10001 write access to the volume root. CSI drivers that apply `fsGroup` themselves (`VOLUME_MOUNT_GROUP`) bypass this kubelet policy and need their own check that remounts keep `/data/host` private. The policy does not repair state already given group permissions by an earlier recursive mount; restore mode `0700` on such directories and `0600` on their files as user 10001 before restarting.

The worker StatefulSet retains its host identity on a PVC and uses namespace-scoped access to VM resources and source-volume cloning. Its state is separate from individual VM root disks. Do not scale one pool configuration into multiple independent offers with the same capacity; divide the capacity deliberately. The in-cluster example uses HTTPS with an explicit CA file. Template VMs use independent CDI-cloned disks and `Always`/`Halted` run strategies. Console/VNC access uses `virtctl` and your existing Kubernetes credentials. Guest/network access and Windows secure-boot/TPM storage need acceptance against the cluster's actual KubeVirt configuration.

These files are deployment inputs, not evidence of an installed cluster or successful VM boots. The implementation does not automatically deploy into a current kubeconfig context.

### Private ingress and optional network policies

Expose the orchestrator only through private TLS passthrough or TLS re-encryption.
For re-encryption, configure the proxy to verify the upstream CA and a certificate
SAN such as `orchestrator.canaveral.svc`; cleartext upstream traffic cannot reach
the TLS-only listener. Include the external API hostname in the appropriate server
certificate. Keep native runners on a private trusted access path.

Expose the dashboard through a private HTTPS proxy to Service `dashboard:8766`.
Preserve the incoming Host header and proxy the entire origin without a path
prefix. See [dashboard proxy and account setup](dashboard.md). Ingress resources
and controller annotations are installation-specific and are not in the base install.

The separately applied `deploy/kubernetes/network-policies` example denies
Canaveral namespace ingress except dashboard and worker access to the controller.
It also restricts worker egress to DNS, the controller and an example API endpoint.
Copy and edit it for your API server IPs/ports, DNS topology and guest preparation
or SSH destinations before applying. Service DNAT and NetworkPolicy ordering vary
by CNI; verify the actual API destination. A conformant cluster may have no
NetworkPolicy-enforcing CNI, so verify enforcement independently.

```sh
# Only after adapting the policy inputs and adding private ingress/runners rules:
kubectl apply -k deploy/kubernetes/network-policies
```

The file includes disabled examples for ingress-controller and external-runner
sources. Replace their selectors/CIDRs and enable them deliberately. No policy is
automatically applied by the base overlays or release bundle.

### Pod Security and OpenShift

The shipped Canaveral pods use non-root UID/GID 10001, no privilege escalation,
dropped capabilities and RuntimeDefault seccomp. Worker state and kubectl cache
live on its PVC; temporary files use an emptyDir at `/tmp` (also HOME). SSH uses
explicit state paths for keys and known hosts. The root filesystem stays read-only.
Namespace creation enforces Restricted Pod Security. KubeVirt launcher/importer
pods may need exemptions managed by the KubeVirt/CDI operator and your cluster
administrator; verify those before offering VM capacity in `canaveral-guests`.
These labels do not establish that guest pods meet Restricted.

OpenShift restricted-v2 SCC allocates UIDs and groups, so the fixed `runAsUser`,
`runAsGroup` and `fsGroup` 10001 fields conflict with its defaults. An OpenShift
overlay can remove those fields for SCC assignment, but that alone is not tested
arbitrary-UID support: the image defaults to 10001:10001 and its built-in data/home
directories are owned by that user, without arbitrary-group write permissions.
Provision writable PVC/emptyDir ownership and readable mounted keys for the
assigned group, and verify private-state ownership checks under that UID. Otherwise
use a dedicated narrowly scoped SCC permitting 10001. Neither route has native
OpenShift acceptance here; do not grant privileged access to the Canaveral pods.
