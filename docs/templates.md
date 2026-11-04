# Image preparation compatibility

Images and base images define the starting computer. The existing template CLI
and JSON definitions remain an internal compatibility format for base OS,
architecture, headless/desktop mode, resources and guest preparation. Hosts bind
that definition to local storage or a Kubernetes base PVC. Canaveral clones the
base, boots the VM, runs preparation and reports readiness. See the
[base and captured image contract](images.md) for the product workflow.

`examples/templates/` contains development Linux, Linux desktop, Windows development and macOS development recipes. The Linux package examples target Debian/Ubuntu package names. Adapt packages, access, resource sizes and image bindings to the chosen distribution. Configure login credentials through your existing secret-management process; public SSH keys can be included in Linux recipes. Examples do not contain passwords or private keys.

## Define and offer a template

A reusable JSON definition has these fields:

- `id`, `revision`, `os` (`linux`, `windows`, `macos`, `android`, `ios`), `arch` (`amd64`, `arm64`) and `mode` (`headless`, `desktop`, `device`). Mobile templates require `device` mode and an immutable SDK `device` definition; see [mobile devices](devices.md). VM templates use headless/desktop mode.
- `minimum` and optional `defaults`, each specifying `cpu`, `memoryMiB` and `diskGiB`. Defaults must satisfy the minimum and any `memoryStepMiB` constraint.
- Optional `source`, selecting a local `path` or HTTPS `url`, a `format` (`raw`, `qcow2`, `vhdx`, `ipsw`) and the exact `sha256` of the base artifact.
- Optional `prepare`, selecting a driver and guest setup steps.

Validate a definition without contacting an orchestrator:

```sh
python3 -m canaveral template validate examples/templates/linux-development.json
```

Reference it in a host configuration as shown in `examples/host-with-templates.json`:

```json
{
  "templateFile": "templates/linux-development.json",
  "bindings": {"image": "/var/lib/canaveral/base/linux-amd64.qcow2"}
}
```

Paths in `templateFile` are relative to the host configuration file. Bindings provide provider-local paths, networks, PVCs and SSH connection settings; they cannot replace the public recipe. A host can retain multiple revisions of an ID, and cluster pools can offer different architecture variants. Retain definitions for VMs already assigned to that host. Changing the recipe, defaults or verified artifact under an existing ID/revision/architecture is rejected; publish a new revision.

The host advertises resource defaults, preparation driver and a digest of the recipe/artifact contract. It keeps image paths, preparation command contents and SSH key paths local. The digest of a checksum-pinned source depends on its hash/format, so mirrors or local paths can differ across hosts.

For a `source`, configure the native host's `imageCache` directory so its hypervisor can read cached images. The agent resolves sources before offering capacity. You can also cache a base explicitly:

```sh
python3 -m canaveral template prepare my-template.json --cache /var/lib/canaveral/base-cache
```

This command validates and caches the base artifact. Guest software preparation runs on each spawned VM. Downloads use HTTPS; redirects cannot downgrade transport or introduce URL credentials. Cache names are derived from the checksum. A mismatch never publishes the image, and a corrupted existing cache entry is not overwritten. Host-local images without `source` remain supported as owner-managed bases.

Cache verification uses the same guarded regular-file checksum as the image
library. Existing symlinks, FIFOs and directories are refused. An owner-configured
local source symlink is resolved once, then preparation pins its regular file and
checks descriptor/path identity, size, modification time and change time before
and after copying. Reads stop at the initial size; source changes prevent
publication. Zero regions are copied sparsely without changing logical contents.

Publication never replaces a competing entry. A competing regular file with the
expected checksum can be reused; other existing data stays intact for inspection.
The new file is synchronized before publication and its directory afterward on
POSIX. An unconfirmed link or directory synchronization reports
`image_cache_publication_uncertain` with an unknown outcome and no automatic
retry; a visible entry is retained. Native Windows/filesystem and power-loss
acceptance remain open. Checksum validation alone does not establish a bootable
image or an atomic snapshot of a changing source.

KubeVirt templates use a `pvc` binding and omit `source`; import the base PVC through your cluster's image workflow. Canaveral/CDI clones it into an independent VM root disk. The same guest preparation recipe can then run on that clone.

## Linux preparation

Set `prepare.driver` to `cloud-init`. The base needs cloud-init with NoCloud support and Python 3. Canaveral attaches a per-instance CIDATA seed with a unique instance ID. The recipe can specify:

- `packages`: package names for apt, dnf or apk. Use package names appropriate to that image.
- `user` and optional `sshAuthorizedKeys`: configure a Linux account and its public keys.
- `files`: absolute guest paths with inline `content` and optional octal `mode` (default `0600`).
- `commands`: ordered guest shell commands. Each command fails the preparation if it exits unsuccessfully.
- `timeoutSeconds`: how long the host waits for a preparation receipt after the guest starts running, or for its SSH setup command to finish (default 1800).

The generated guest script installs packages, creates the account, writes files and runs commands in that order. Include application-specific checks in the final commands if readiness requires a service to be healthy. The desktop example installs XFCE and xrdp; configure the intended desktop authentication/access in the recipe or base image. Enabling RDP alone does not create a usable login credential.

Native Linux hosts need `genisoimage` or `mkisofs` for seed media; the Docker libvirt target includes it. Apple hosts use `hdiutil`. KubeVirt references a per-VM Secret via cloud-init rather than embedding the preparation credential in its public VM definition.

## Windows preparation

Set `prepare.driver` to `cloudbase-init`. Supply a bootable Windows base with Cloudbase-Init's ConfigDrive metadata service and user-data plugin enabled. Canaveral supplies a CONFIG-2 disk with OpenStack metadata and `#ps1_sysnative` PowerShell user data. Files and ordered PowerShell commands prepare the guest; use native Windows commands for package installation and user/remote-access setup. POSIX file modes do not configure Windows ACLs.

The Hyper-V agent builds seed media with Windows IMAPI; libvirt uses ISO tools and KubeVirt uses a ConfigDrive Secret. Windows base installation, licensing and physical Hyper-V/Cloudbase-Init acceptance remain separate from recipe generation. Canaveral does not bypass product activation or provide a permanently licence-free Windows image.

## SSH preparation and macOS

Set `prepare.driver` to `ssh` for an image with usable SSH access. Configure a private backend binding:

```json
{
  "ssh": {
    "host": "cvm-{id}.vms.example.internal",
    "user": "operator",
    "identityFile": "/private/canaveral/operator-key",
    "knownHostsFile": "/private/canaveral/known-hosts"
  }
}
```

`{id}` expands to the full assigned VM UUID so connection names retain its uniqueness. Guest networking/DNS must make that address reachable. The Unix account needs noninteractive sudo. Windows SSH preparation invokes PowerShell. Host keys are verified strictly; Canaveral does not accept unknown keys or clear changed keys automatically. SSH preparation writes files and runs commands in the guest, then the assigned host records success.

For a macOS clone, bind a clean shutdown standalone `.raw` base disk plus its matching `macOSAuxiliaryStorage`, `macOSHardwareModel` and `macOSRestoreImage` files. The runner copies the disk and auxiliary storage, uses the base hardware model, creates a unique machine identity and checks the reserved resources and configuration before allowing boot. The base must have the intended account/SSH access configured; prepare custom software after boot with the recipe. An IPSW-only template performs a fresh macOS installation and still needs initial account/setup access before SSH preparation can succeed. macOS clone boots and first-login behavior require acceptance with the actual image on Apple hardware.

## Request and observe a prepared computer

Register an agent with the template references, then inspect offerings and request a version:

```sh
python3 -m canaveral --token-file ./secrets/admin.token templates
python3 -m canaveral --token-file ./secrets/admin.token create development \
  --template linux-development --template-revision 1 \
  --request-id 730111ad-aaee-421f-99c6-25e408489102
```

Omit resource flags to use the template defaults, or override individual resources with `--cpu`, `--memory-mib` and `--disk-gib`. The selected values and recipe are pinned to this request UUID. Retrying that UUID preserves the original allocation even if newer revisions/defaults are offered later.

`machines` separates runtime from preparation. A booted VM can report `observed: running`, `preparation.state: pending`, and `ready: false`. Linux and Windows seeds send a scoped ready receipt only after setup succeeds. Set the host's `guestOrchestratorURL` to the controller origin reachable from guests; localhost in a guest refers to that guest. HTTPS is required for remote endpoints unless the host explicitly enables trusted private HTTP. This address can differ from the agent's own control-plane URL. Guest callbacks cannot administer hosts or machines.

Preparation completion is durable. A stale pending heartbeat cannot undo it. Timeouts and SSH failures report failed preparation without claiming readiness; the VM remains available for inspection. Receipts can still establish success after a transient timeout. Preparation scripts keep per-instance started/completed markers. If a command was interrupted, inspect the partial state before clearing its marker; it is not silently replayed. Retain private host state, seed media and credentials across agent restarts. Scripts and preparation data can contain sensitive per-instance values; keep template secrets out of repository files and use your normal runtime secret-management channel.

## Source contracts

The implementation uses [cloud-init NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html), [Cloudbase-Init user data](https://cloudbase-init.readthedocs.io/en/master/userdata.html) and [KubeVirt startup data](https://kubevirt.io/user-guide/user_workloads/startup_scripts/). Apple requires preserving a macOS VM's [auxiliary storage alongside its disk](https://developer.apple.com/documentation/virtualization/vzmacauxiliarystorage). These contracts guide preparation; generated configuration and local fixture checks do not replace real guest boot, application and login acceptance.
