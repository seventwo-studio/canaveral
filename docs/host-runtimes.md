# Host runtime backends

Run the registry on the host as the daemon service account. The same
`--config FILE` and `--state DIR` options identify the host as when starting
`canaverald`. The registry does not contact the controller or initialize host
state.

```sh
canaverald runtimes status --config ./host.json --state ./state --json
canaverald runtimes install ollama --config ./host.json --state ./state --dry-run
canaverald runtimes verify ollama --config ./host.json --state ./state
canaverald runtimes remove ollama --version VERSION --config ./host.json --state ./state --dry-run
```

`list` and `status` show the same backend records as the `runtimes` section
of host inventory. Without `--json`, the command prints a table. Mutations
return a nonzero exit status if they fail or their outcome is unknown. JSON
mutation output includes the result and any plan returned by the executor.
Only install and remove accept `--dry-run`.

| Backend | What the daemon checks |
| --- | --- |
| Apple Virtualization | Apple silicon, macOS 26 or later, and the executable Swift runner. It checks the runner signature, virtualization entitlement and native Virtualization framework support. The runner ships through managed updates. |
| libvirt | Linux KVM device, versions of virsh, qemu-img and QEMU, and KVM capabilities through the local libvirt URI. The version column shows the virsh version. Operators install the system packages. |
| containerd | The root installer's receipt and common system paths for existing containerd or Docker installations. Verification checks the installed files against the receipt. |
| Ollama and llama.cpp | The Rust model executor reports compatibility, installation and package verification. Install prepares the bundled catalog version, and remove requires a specific version. The executor protects versions referenced by live or unresolved work. |
| vLLM and MLX-LM | Reserved entries with unavailable packages pending qualification of their hermetic builds. |

Apple Virtualization and libvirt support detection only.

On Linux amd64 and arm64, run `canaveral-host-installer containerd plan` to
inspect the pinned assets and paths. Use the standalone root-owned installer
for installation and removal. It verifies installed files, manages a private
systemd service and socket, and checks every namespace for tasks and container
records before upgrade or removal. `canaverald` reads the receipt to report
the installation status. A `verified` result confirms trusted receipt ownership
and matching SHA-256 digests, ownership and permissions for four binaries, the
configuration and the systemd unit. Use the root installer to check service and
socket health. Follow the
[installer README](../crates/host-installer/README.md) to install the binary as
root, then run `sudo canaveral-host-installer containerd install`.

To enable model runtime management, put this block in the host config and
substitute the actual paths.

```json
"modelExecutor": {
  "binary": "/opt/canaveral/bin/canaveral-model-execution",
  "config": "/etc/canaveral/model-executor.json"
}
```

Both paths must be absolute and free of links. Root or the daemon account must
own both files and every ancestor directory. Group and other users must have
no write access. The binary must be executable and the config readable. The executor enforces its private config rules and
owns the runtime store, catalog and package validation.

Model runtime status and verification show the catalog version, the verified
active version, and each installed package's digest, verification result and
`referenced` flag. Run install with an updated executor to select a new catalog
pin. Reinstall to repair an unreferenced package. Reconcile retained work
before removing a referenced version.

The executor quarantines unsafe cache entries (`runtime_cache_entry_unsafe`)
and refuses unsafe loader paths (`runtime_loader_path_unsafe`). Use Ollama
only on trusted single-tenant hosts. Its loopback API is unauthenticated and
Go bypasses proxies for loopback destinations. See [Rust model execution](rust-model-execution.md).

- `absent` means the required installation was not found.
- `installed` means tools or a receipt indicate installation.
- `verified` means the backend passed its local checks or the executor reports a verified package.
- `unavailable` means the platform, package or configuration prevents use. See the blocker for details.
- `failed` means a check rejected its input or found a definite problem.
- `unknown` means the daemon could not establish status or confirm the outcome. Inspect status before retrying a mutation.

Native qualification is a separate, reviewed decision (see
[runtime qualification](runtime-qualification.md)). Local checks cannot
establish it or grant controller placement. The controller's
`canaveral runtimes` command continues to manage mobile runtimes through the
controller.

## Native acceptance

Linux and macOS are the supported `canaverald` host platforms for this milestone.

| Suite | Full matrix |
| --- | --- |
| [Model acceptance](../.github/workflows/model-acceptance.yaml) | llama.cpp and Ollama install, verification, generation, repair and removal on Ubuntu 24.04 x64 and ARM64 and macOS 15. |
| [Host acceptance](../.github/workflows/host-acceptance.yaml) | containerd lifecycle and libvirt detection on Ubuntu 24.04 x64 and ARM64. Apple Virtualization detection on macOS 15 and 26. |
| [Daemon acceptance](../.github/workflows/daemon-acceptance.yaml) | Service enrollment, inventory, restart with the saved identity and shutdown under systemd on Ubuntu 24.04 x64 and ARM64 and launchd on macOS 15. |

Pull requests run path-filtered smoke checks. The full suites run on pushes to
`feat/runtime-acceptance*`, nightly and by manual dispatch. Each cell uploads
a JSON evidence record identifying the commit and runner image.

Hosted ARM Ubuntu lacks KVM. Hosted macOS lacks nested virtualization, so the
Apple detection cells assert blockers only. Containerd crash recovery has
fixture coverage only.

Artifacts expire after 90 days. Copy evidence from trusted runs into the
committed records described in [runtime qualification](runtime-qualification.md).
A backend reports `qualified` only for an exact pin and scope that a reviewed
entry in `qualification/promotions.json` promotes. The executor and the daemon
compile that promotion in at build time. No pin is currently promoted. Ollama
remains blocked until hosts enforce isolation.

## Local blocker codes

| Code | Surface | Meaning | Operator action |
| --- | --- | --- | --- |
| `apple_entitlement_missing` | local | The Swift runner lacks the Apple virtualization entitlement. | Restore the signed runner from a managed release. |
| `apple_os_unsupported` | local | The host runs a macOS version earlier than 26. | Upgrade macOS before using the runner. |
| `apple_runner_missing` | local | The host has no Swift runner at the configured absolute path. | Set the path to the signed runner. |
| `containerd_foreign_install` | local | An existing system containerd or Docker installation was found. | Review ownership and service conflicts before installing. |
| `containerd_receipt_file_mismatch` | local | An installed file differs from its receipt. | Inspect the reported drift before repairing with the root installer. |
| `containerd_receipt_invalid` | local | The installer's receipt could not be trusted or parsed. | Check receipt ownership, mode, paths and format. |
| `containerd_root_installer_required` | local | This operation belongs to the dedicated root installer. | Use the root-owned `canaveral-host-installer containerd` command. |
| `libvirt_kvm_missing` | local | The host has no KVM character device at /dev/kvm. | Enable KVM on the host. |
| `libvirt_kvm_probe_failed` | local | The local libvirt KVM capability check did not pass. | Check KVM and libvirt access as the service account. |
| `libvirt_tools_missing` | local | At least one of virsh, qemu-img and QEMU is missing. | Install the missing system tools. |
| `libvirt_uri_invalid` | local | The configured libvirt URI does not select a local connection. | Use qemu:///system or qemu:///session. |
| `model_executor_config_invalid` | 400, local | The host's model executor block or its paths are invalid. | Check the config fields and file permissions. |
| `model_executor_invalid_report` | local | The model executor output violated the report contract. | Check that the daemon and executor versions match. |
| `model_executor_not_configured` | local | The host has no model executor configuration. | Add modelExecutor to the host config. |
| `model_executor_refused` | local | The executor rejected its configuration or arguments. | Check the executor config and CLI arguments. |
| `runtime_detect_only` | local | The backend supports local detection only. | Inspect its status using the runtime registry. |
| `runtime_platform_unsupported` | local | This backend does not support the host platform or architecture. | Use a host with a supported platform and architecture. |
| `runtime_probe_failed` | local | A required probe could not establish backend status. | Check host prerequisites and permissions. |
| `runtime_probe_invalid_output` | local | Probe output could not be decoded or recognized. | Check the installed tool version before retrying. |
| `runtime_probe_missing` | local | The configured probe executable could not be found. | Check the executable's location and configuration. |
| `runtime_probe_output_limit` | local | Probe output exceeded the allowed byte limit. | Inspect the tool output and verify status before retrying. |
| `runtime_probe_timeout` | local | The probe did not finish before its deadline. | Inspect local runtime state before retrying. |
