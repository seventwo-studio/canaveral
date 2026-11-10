# Self-hosting Canaveral

The controller stores inventory and assigns work. Host runners connect outbound and report results. Operators provide persistent storage, credentials and HTTPS termination. Native runtime acceptance remains platform-specific.

For a controller using a private CA, the host runner accepts `host --ca-file`;
the Python SDK and its consumer examples accept the same explicit bundle.
See [verified TLS client and host setup](tls-clients.md). This option does not
install system trust or change enrollment approval.

## One server

Use Python 3.9+ and the checkout's declared dependencies. From a release checkout,
install the package, create credentials once and start the controller:

```sh
python3 -m pip install -e .
python3 -m canaveral init ./secrets
python3 -m canaveral serve \
  --database ./state/orchestrator.sqlite3 \
  --admin-token-file ./secrets/admin.token \
  --enrollment-token-file ./secrets/enrollment.token
```

In another terminal, verify authenticated access:

```sh
python3 -m canaveral --token-file ./secrets/admin.token hosts
```

An empty list means the controller works and has no execution capacity yet.
For everyday machine access and automation, create a user account and a scoped
[personal API token](accounts-and-tokens.md). Keep the operator credential for
bootstrap, recovery and administration. Users see only their own machines; admins
can manage every user's machines.
For a Linux server with KVM/libvirt, copy `examples/host-libvirt.json` to
`host.json`. Keep only installed templates. Set the actual architecture,
absolute image and disk paths, libvirt network, immutable template revision and
a host capacity limit that leaves room for the operating system and hypervisor.
Install libvirt, `virsh`, `qemu-img`, EFI firmware and `genisoimage` or `mkisofs`
when using cloud-init. Give the runner account the required libvirt/disk access.
Then enroll a native runner on that same server:

```sh
python3 -m canaveral host --config ./host.json --state ./state/host \
  --enrollment-token-file ./secrets/enrollment.token
```

For automatically prepared Linux guests, start from
`examples/templates/linux-server.json`, replace its SSH public key, and bind a
matching cloud-init image with a verified checksum. Template files and bindings
are described in [templates.md](templates.md). A generic OS installer is not
already a prepared, remotely accessible template.

Once `hosts` reports the runner online and `templates` lists the installed offer:

```sh
python3 -m canaveral --token-file ./secrets/admin.token templates
python3 -m canaveral --token-file ./secrets/admin.token create first-computer \
  --template linux-server --request-id 69bfc625-76c6-4642-86c7-5e4a6c84dd44
python3 -m canaveral --token-file ./secrets/admin.token machines
```

Choose a new UUID for each computer; keep the same UUID and specification when
retrying that creation. Inspect the inventory before starting another request.
Run the controller and runner under your service manager for unattended use;
`deploy/systemd/canaveral-host.service` is a host-service example.

### Docker on the same server

The source-build Compose setup uses named volumes and needs no site-specific
registry or secret manager:

```sh
docker compose --profile setup run --rm init
docker compose up -d orchestrator
docker compose run --rm --no-deps orchestrator \
  --url http://orchestrator:8765 --allow-http \
  --token-file /run/credentials/admin.token hosts
```

Run initialization once; it refuses to replace existing credentials. The API is
published only on loopback. A native Linux runner on this server can use that
loopback API after receiving the enrollment file through a protected local file:

```sh
umask 077
docker compose run --rm --no-deps --entrypoint cat orchestrator \
  /run/credentials/enrollment.token > ./enrollment.token
python3 -m canaveral host --config ./host.json --state ./state/host \
  --enrollment-token-file ./enrollment.token
```

The controller container needs no hypervisor privileges. A native runner or the
separately configured libvirt worker provides VM execution. Docker Desktop on a
Mac does not provide the Apple backend. Add the optional dashboard with
`docker compose --profile dashboard up -d`; bootstrap its first administrator
using [dashboard.md](dashboard.md).

## Kubernetes homelab

The controller needs one persistent volume, its operator/enrollment Secret and
one replica with a Recreate strategy. It does not need Kubernetes API access or
KubeVirt. Use `deploy/kubernetes/orchestrator.json` for a direct installation,
or the release artifact's namespace-free `orchestrator/` Kustomization for your
own GitOps setup. Select the matching immutable image digest from `release.json`.
The `dashboard/` stage is optional. Follow the concrete namespace, credential,
image and persistent-storage steps in [running.md](running.md#kubernetes).

To offer Kubernetes VM capacity, first install compatible KubeVirt and CDI and
verify KVM on eligible nodes. Import a bootable image into an offline template
PVC, matching the guest architecture and intended bootstrap mechanism. Then
adapt `deploy/kubernetes/worker-kubevirt.json` with:

- The released `images.kubevirt` image, or your own build of Docker's `kubevirt`
  target with kubectl compatible with the cluster.
- The actual guest namespace, architecture, template PVCs and storage class.
- One deliberate pool capacity limit and persistent worker identity.
- An enrollment-only Secret, namespace-scoped VM/clone/secret permissions and
  your network policies. Guests must reach the configured preparation endpoint.

Keep controller, worker state, base templates and guest disks persistent. The
example's capacity and image paths are configuration inputs, not discovered
hardware or installed images. Start with a small guest and verify actual boot,
preparation, login and retained disk identity across stop/start before expanding.

## Add other machines

A Mac uses the signed Apple runner; Windows uses native Hyper-V; another Linux
server uses libvirt. Each runner gets the central API URL, enrollment credential,
local configuration and private persistent state. It connects outbound; it does
not need an inbound Canaveral listener. Use private HTTPS when the API leaves
loopback. Network discovery and certificate issuance are supplied by your own
networking setup. See [native prerequisites](running.md#native-controller-and-hosts).

Advertise each physical capacity once. VM and embedded inference work can
share one Mac/Linux host identity and capacity ledger. Inference uses explicitly
installed pinned local models; it is optional and needs neither a VM backend nor
a separate inference service. See [inference.md](inference.md).

## Operate and recover

The current controller is a single SQLite writer, not an HA control plane.
Preserve its database, operator credential, administrator account and each host's
identity. Back up the database consistently and test restoration independently
of storage replication. Keep encryption keys separately if your storage uses
them. Updating an image is not permission to reseed or delete controller state.

Running and ready are different: required preparation must finish before the VM
is ready. Stops retain disks; deletion, snapshots, migration and automatic
reassignment after uncertain host loss are not implemented. Drain a host to
block new assignments. Inspect uncertain runner receipts and positively fence
old processes before repair; never erase receipts to make a job run again.

Portable tests validate the API, accounts, enrollment, placement and generated
backend configuration. They do not prove guest boots on your hardware. Keep
those installation-specific results separate from a successful source build.
