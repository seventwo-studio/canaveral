# Get started with Canaveral

Canaveral runs virtual machines, mobile simulators and local model workloads on
hardware you operate. The controller keeps track of users, workloads and
capacity. The `canaverald` agent connects out to the controller, reports what
its host can run and executes assigned work. The CLI and optional dashboard
show the resulting inventory.

## Try the controller locally

You need Git and Node.js 24.11 or later. This walkthrough uses a fresh SQLite
database and a loopback listener, so you can try it without a hypervisor,
model weights or a Kubernetes cluster.

```sh
git clone https://github.com/seventwo-studio/canaveral.git
cd canaveral
npm --prefix coordination ci --ignore-scripts
npm --prefix coordination run build
node coordination/dist/src/cli.js init ./state/quickstart/credentials
node coordination/dist/src/cli.js serve \
  --bind 127.0.0.1 --port 8765 \
  --database ./state/quickstart/controller.sqlite3 \
  --admin-token-file ./state/quickstart/credentials/admin.token \
  --enrollment-token-file ./state/quickstart/credentials/enrollment.token
```

From a second terminal in the checkout, query the controller.

```sh
node coordination/dist/src/cli.js --url http://127.0.0.1:8765 \
  --token-file ./state/quickstart/credentials/admin.token hosts
```

The first response is `{"hosts":[]}`. Keep the generated credentials private.
Use Ctrl-C to stop the controller. To restart it, rerun `serve` with the same
files. Run `init` once per data directory.

## Add execution capacity

- **Linux with KVM and libvirt.** Prepare a guest image and configure the
  daemon's storage, capacity and template bindings. [Native host setup](running.md#native-controller-and-hosts)
- **macOS and Windows.** Run the Apple Virtualization or Hyper-V backend on
  the host OS. Android and iOS use their own installed tools. [Platform and runtime prerequisites](running.md#installation-and-target-boundaries)
- **Local model inference.** Check the engine and host combination, then
  provision a pinned engine and model. [Managed model runtimes](model-runtimes.md)
- **Kubernetes.** Run the controller with persistent storage and TLS, then
  enroll a daemon on selected Linux nodes. The VM profile needs host libvirtd,
  KVM and prepared storage. For a cluster whose nodes lack these prerequisites,
  run a native VM host on a separate Linux server and connect it over HTTPS.
  [Controller deployment](self-hosting.md#kubernetes) · [Kubernetes hosts](cluster-hosts.md)

On a configured host, inspect its hardware, offers and runtime checks before
enrollment.

```sh
node coordination/dist/src/canaverald.js --config ./host.json \
  --state ./state/host --inventory
```

## Install a release

Choose a version from [GitHub Releases](https://github.com/seventwo-studio/canaveral/releases).
The release's `release.json` records the image and deployment digests. For a
GitOps deployment, use the signed OCI deployment bundle, supply your own TLS,
credentials and storage, and check that Flux reports both `SourceVerified=True`
and `Ready=True` for the selected digest. [Release signature contract](../script/README.md#deployment-signature-contract)

If you already run Canaveral with KubeVirt, pin your current release before
selecting a version that removes that provider. Plan guest cutover and recovery
while the old worker can still act on its assignments. Preserve the controller
database, controller identity, credentials and guest disks. The libvirt
profile requires its own enrollment and prepared images. [Backup and recovery](self-hosting.md#operate-and-recover)

## Contribute

Canaveral is MIT licensed. To report a problem, include the Canaveral version,
host OS and architecture, the backend, the steps you ran and the error code or
sanitized logs. [License](../LICENSE) · [GitHub issues](https://github.com/seventwo-studio/canaveral/issues)

For code changes, start with the checks for the component you touched. The
technical guide points to source contracts and records which runtime paths
have been exercised on real hardware. [Developer commands](../script/README.md) · [Technical guide](project-guidance.md)
