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
  at `/var/lib/canaveral-host-installer/receipts/containerd.json`. A repeat
  with matching files and pins reuses the installation.
- `status` reports the receipt, per-file digests, systemd activity and socket
  presence. Indeterminate probes are `null` in JSON. Read the `result.code`
  field for drift, inactivity and pending recovery. Use root to inspect the
  socket through its private runtime directory.
- `remove` verifies the installation, checks tasks and container records in
  every namespace, disables and stops the service, and removes matching
  files. It keeps `/var/lib/canaveral-containerd` and directory scaffolding.
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

The installer refuses existing Docker, containerd, k3s or CNI files at
known system locations, foreign service definitions, drop-ins, unexpected
files in the pinned binary directory, mismatched recorded files and a
socket it cannot tie to the managed service. It uses the service's main PID,
executable and Unix peer credentials to verify socket ownership. If an
upgrade or removal cannot establish idleness, start the verified service
and check its tasks and container records. Keep other root callers away from
the socket throughout the operation so they cannot submit work while it is
being stopped.

The installer records the operation and expected file digests before
publishing installation files or stopping a service for removal. An
interrupted first install can leave files and a pending transaction
without a receipt. Rerun the same operation with the same installer release.
A retry checks any surviving files against the journal, redownloads assets
if needed, and completes the transaction. It refuses changed or unrecorded
files. Downloads always use a newly created staging directory. A forced
termination can leave private staging or temporary write files for an
operator to inspect after the installer exits.

JSON reports use schema version 1 and stable result codes. Exit 0 means
the command returned a result, including diagnostic states from `status`.
Exit 1 indicates a refused or failed operation. Exit 2 indicates invalid
usage or an unsupported platform or architecture.

Fixture tests exercise the lifecycle with in-memory downloads and
simulated systemd and ctr. Native root and systemd acceptance remains
outstanding on Linux.
