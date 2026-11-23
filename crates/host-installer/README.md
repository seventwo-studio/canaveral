# Canaveral host installer

Use the standalone installer on Linux amd64 or arm64 with systemd. Build or
obtain the binary from a trusted Canaveral source. Install it in a directory
tree that root owns and that other users cannot write.

```sh
sudo install -o root -g root -m 0755 canaveral-host-installer /usr/local/sbin/
canaveral-host-installer containerd plan --json
sudo /usr/local/sbin/canaveral-host-installer containerd install
sudo /usr/local/sbin/canaveral-host-installer containerd status --json
sudo /usr/local/sbin/canaveral-host-installer containerd remove
```

Run the installer directly for privileged operations. The `canaverald`
service account only reads the receipt.

- `plan` shows the compiled asset pins and destination paths without
  writing files, contacting the network or requiring root.
- `install` verifies pinned tarball and executable bytes before unpacking.
  It installs the binaries under `/opt/canaveral-containerd/<version>/bin`,
  enables and starts the unit, checks its socket, then publishes the receipt
  at `/var/lib/canaveral-host-installer/receipts/containerd.json`. All
  receipt ancestors must be root-owned, traversable by other users, and
  writable only by root. The installer creates missing ancestors with mode
  `0755`. A repeat reuses matching pins, generated config and unit, and
  recreates the boot enablement link if it is missing, including after an
  operator disables the unit. Changes to generated files require idle
  maintenance even when the pins match.
- `status` reports the receipt, per-file digests, systemd activity and socket
  presence. Indeterminate probes are `null` in JSON. Read the `result.code`
  field for drift, inactivity and pending recovery. Use root to inspect the
  socket through its private runtime directory.
- `remove` verifies the installation, checks tasks and container records in
  every namespace, stops the service, and removes matching files and the
  boot enablement link if it still matches the installer's ownership record.
  It keeps `/var/lib/canaveral-containerd` and directory scaffolding.
  Inspect and move retained state before a fresh install.

The unit keeps the socket inside a root-owned `0700` runtime directory and
runs with the pinned binary directory as its `PATH`. The CRI, NRI and opt
plugins are disabled. Native clients use the private socket. The runc shim
resolves the pinned runc on the unit's `PATH`. A native client that sets
`BinaryName` explicitly should use the pinned absolute runc path.

## Refusals and recovery

Install and remove require effective UID 0 and trusted ownership and
permissions from the resolved executable up through its ancestors. The
installer clears inherited settings at startup and supplies a cleared
environment and absolute executable paths to its child commands. Invoke it
from a trusted root context because the operating system loads the executable
before these checks can run.

The installer refuses existing Docker, containerd, k3s, RKE2, rootful Podman
or CNI files at known system locations, foreign service definitions,
drop-ins, unexpected files in the pinned binary directory, mismatched
recorded files and a socket it cannot tie to the managed service. It uses
the service's main PID, executable and Unix peer credentials to verify
socket ownership.

Install and remove share a `0600` lock file in the root-only
`/var/lib/canaveral-host-installer/private` directory. The installer creates
one boot link under `multi-user.target.wants` and records its identity in
`private/containerd.json`. Upgrade retains that link. Removal preserves
operator-created links, including replacements at the same path. A
preexisting link, or one left by an interruption before its identity was
recorded, may need manual cleanup after removal.

Before replacing or removing files, the installer checks all namespaces
for tasks and container records, stops the service to close the socket,
then looks for remaining task bundles and managed shim processes. The
offline check can see task bundles only when systemd leaves the runtime
directory in place. Pause other root clients throughout maintenance. They
can submit work before the socket closes, and the installer lock only
serializes installer processes.

The installer records the operation and expected file digests before
publishing installation files or stopping a service. It records stop
verification separately, after checking the stopped service and remaining
task state and clears it before starting the service. If a retry finds the
service stopped without that record, restart the verified service and check
its tasks and container records before retrying. An interrupted first
install can leave files and a pending transaction without a receipt. Rerun
the same operation with the same installer release. During an interrupted
install, `remove` returns `recovery_required` until the install completes.
A retry checks any surviving files against the journal, redownloads assets
if needed, and completes the transaction. It refuses changed or unrecorded
files. Downloads always use a newly created staging directory. A forced
termination can leave private staging or temporary write files for an
operator to inspect after the installer exits.

JSON reports use schema version 1 and stable result codes. Exit 0 means
the command returned a result, including diagnostic states from `status`.
Exit 1 indicates a refused or failed operation. Exit 2 indicates invalid
usage or an unsupported platform or architecture.

Fixture tests exercise the lifecycle with in-memory downloads and simulated
systemd and ctr. The host acceptance workflow exercises the real lifecycle
on disposable Ubuntu 24.04 amd64 and arm64 runners: foreign-install refusal,
cold download, systemd and private socket health, an OCI task pinned by a
multi-architecture index digest, busy refusal, same-pin reuse and removal.
It also checks receipt file hashes through the unprivileged daemon registry.
The registry's `verified` state confirms those file checks, not service or
socket health; use the root installer for health checks.

Each native cell uploads JSON evidence with its commit, runner image,
architecture, package pins and step outcomes. A passing hosted smoke does
not qualify the package for production hosts. Consult the run for the exact
commit being evaluated.

Crash recovery remains fixture-covered. Downloads finish before the durable
journal is published, and the remaining journal/write/stop boundaries have
no deterministic external pause. Killing the installer on a timer would
not prove which boundary was reached. No release CLI flag or environment
variable bypasses ownership or pauses a privileged operation for testing.
