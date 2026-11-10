# Running Canaveral

Run the control plane on any supported Python host, in Docker or in Kubernetes. Native host agents run where their hypervisor is installed. macOS guests stay on Apple hardware. A Linux container does not add Hyper-V or Apple Virtualization to its host; Docker Desktop on a Mac is not the Apple host backend.

## Native controller and hosts

Use Python 3.9+ and run `python3 -m canaveral` from the checkout, or install the package and use `canaveral`. `python3 -m canaveral init ./secrets` creates private credential files. It refuses to overwrite existing files. Start `serve` as in the root README; its default bind address is loopback. For access from other machines, provide a TLS proxy and set `--bind` to the intended private interface. Persist `--database` and keep administrator credentials with the owner.

Use [user accounts and scoped personal API tokens](accounts-and-tokens.md) for
normal machine access. Users own private machines; admins manage all users and
machines. Keep operator and runner-enrollment credentials separate. Back up an
existing controller database before its first upgrade to the user account schema.

Copy an example from `examples/` into a private host configuration. Set a deliberate host capacity limit, correct architecture, bootable base image paths and immutable revision IDs. Use reusable template files and preparation recipes as described in [Configurable computers](templates.md). Remove templates that are not installed. On each host:

```sh
python3 -m canaveral --url https://canaveral.example.internal host \
  --config /etc/canaveral/host.json --state /var/lib/canaveral/agent \
  --enrollment-token-file /etc/canaveral/enrollment.token
```

Deliver the enrollment file through your normal secret-management channel. After successful enrollment the agent can restart without the enrollment argument using its saved per-host identity. Keep its state private and persistent. Do not reinitialize identity on each launch.

For Linux, install KVM, libvirt, `virsh`, `qemu-img` and matching EFI firmware. Desktop guests need graphical prepared images; Windows 11 templates also need suitable firmware and `swtpm`. The configured libvirt network must exist. The service account must have local libvirt access and access to the template/storage directories. Let the host's libvirt ownership and SELinux/AppArmor policies govern runtime disk access; do not place the disks under the private agent-credential directory. `deploy/systemd/canaveral-host.service` is an editable service example.

For Windows, enable Hyper-V on a supported host edition, install Python and use prepared Generation 2 VHDX templates plus an existing virtual switch. Run the agent under an account authorized for Hyper-V. Configure private state/storage paths in the Windows example. For first-boot preparation, use a base with Cloudbase-Init enabled and a ConfigDrive recipe. Windows guests require appropriate usage rights; Microsoft's [Enterprise evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise) lasts 90 days. Canaveral does not bypass activation or licensing.

For Apple hosts on macOS 26+, run `./script/build_apple_runner.sh`. It builds and signs `dist/CanaveralVMRunner` with the existing Apple Development identity; set `CANAVERAL_SIGNING_IDENTITY` if identity selection is ambiguous. Configure its absolute path and private disk storage in `host-apple.json`. macOS templates use a local compatible IPSW and Apple silicon. Linux templates use standalone raw or supported QCOW2 disks for the host architecture. The retained QCOW2 importer has its documented 16 GiB virtual-size limit; use raw images for larger templates. Whole-GiB memory is required. Increase template minimums if an IPSW requires more resources; provisioning never silently exceeds the reservation. Native runners retain their own runtime locks and keep running when the Python agent exits. Check a machine's `runner.log` and native status before clearing an uncertain `runner-launch.json` receipt.

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

Android emulator and iOS simulator runners use native SDKs rather than the VM
backends above. See [mobile devices](devices.md) for host prerequisites, examples,
control operations and acceptance. The controller can stay in Docker or Kubernetes.

The Compose example keeps state and credentials in separate named volumes, with private credentials readable by the container's fixed user:

```sh
docker compose --profile setup run --rm init
docker compose up -d orchestrator
docker compose run --rm --no-deps orchestrator \
  --url http://orchestrator:8765 --allow-http \
  --token-file /run/credentials/admin.token hosts
```

Run initialization once. It intentionally fails if credential files already exist. The host-published port is bound to `127.0.0.1`; add your private TLS proxy for remote use. Internal Compose HTTP is explicitly enabled in the example CLI call. Export an enrollment file to a protected local destination if registering native hosts, for example by redirecting `docker compose run --rm --no-deps --entrypoint cat orchestrator /run/credentials/enrollment.token` directly to that file; do not paste credentials into chat or command-line flags.

The [optional web dashboard](dashboard.md) runs separately with `python3 -m canaveral dashboard` or `docker compose --profile dashboard up -d`. It is not required by the orchestrator. Kubernetes has a separate opt-in `deploy/kubernetes/dashboard.json` Deployment and internal Service.

Build the worker images when needed:

```sh
docker build --target orchestrator -t canaveral:local .
docker build --target libvirt -t canaveral-libvirt:local .
docker build --target kubevirt -t canaveral-kubevirt:local .
```

A Linux libvirt worker container must reach the host's libvirt Unix socket and see image/disk paths at the same absolute paths as the host daemon. Mount only the intended socket, template directory, VM storage and private agent-state volume. The orchestrator itself does not require host virtualization privileges or access to host disks. The KubeVirt image uses `kubectl`; set `KUBECTL_VERSION` at build time to a version compatible with your cluster. The Apple and Hyper-V agents run natively.

## Kubernetes

`deploy/kubernetes/orchestrator.json` defines a namespace, one controller Deployment, a state PVC and internal Service. Build/publish or load `canaveral:local` into the target cluster, then replace the image reference as appropriate. Create a Secret from local private files before starting the Deployment:

```sh
kubectl create namespace canaveral
kubectl -n canaveral create secret generic canaveral-credentials \
  --from-file=admin.token=./secrets/admin.token \
  --from-file=enrollment.token=./secrets/enrollment.token
kubectl apply -f deploy/kubernetes/orchestrator.json
```

Use one replica with the included Recreate strategy and persistent local/block storage for SQLite. The controller does not need Kubernetes API access. Add a private TLS ingress for external native hosts. A local `kubectl -n canaveral port-forward service/orchestrator 8765:8765` permits using the normal CLI against loopback.

Running VMs inside Kubernetes requires a working KubeVirt + CDI installation, virtualization-capable nodes, suitable firmware, storage and prepared template PVCs. It is separate from merely running the Canaveral orchestrator in a pod. KubeVirt handles KVM access and pod scheduling; the controller pod is not privileged. macOS VM creation continues through separate Apple hosts, not generic Kubernetes Linux nodes.

Edit `deploy/kubernetes/worker-kubevirt.json` for the intended templates, architectures, pool capacity limit and worker image. Its default examples require `linux-server-template` and `linux-desktop-template` PVCs in `canaveral-guests`. Source PVCs must be offline and their sizes must fit the advertised minimums. Build/load the worker image, create the namespace and a separate enrollment-only Secret there, then apply:

```sh
kubectl create namespace canaveral-guests
kubectl -n canaveral-guests create secret generic canaveral-enrollment \
  --from-file=enrollment.token=./secrets/enrollment.token
kubectl apply -f deploy/kubernetes/worker-kubevirt.json
```

The worker StatefulSet retains its host identity on a PVC and uses namespace-scoped access to VM resources and source-volume cloning. Its state is separate from individual VM root disks. Do not scale one pool configuration into multiple independent offers with the same capacity; divide the capacity deliberately. The in-cluster example explicitly permits private HTTP to the controller Service. Template VMs use independent CDI-cloned disks and `Always`/`Halted` run strategies. Console/VNC access uses `virtctl` and your existing Kubernetes credentials. Guest/network access and Windows secure-boot/TPM storage need acceptance against the cluster's actual KubeVirt configuration.

These files are deployment inputs, not evidence of an installed cluster or successful VM boots. The implementation does not automatically deploy into a current kubeconfig context.
