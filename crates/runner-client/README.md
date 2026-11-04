# Explicit runner identity client

This crate implements only the TypeScript runner enrollment/identity routes. It
starts no listener, runtime, model, VM, shell, inventory or capacity advertisement.
It selects no retained host state and performs no migration. Nothing runs until
a caller invokes it. See the controller's `docs/runner-enrollment.md` for approval
and credential authority. Administrator credential delivery and rotation remain
manual integration gates; this client cannot issue approvals or rotate secrets.

## Commands

Build with the repository's pinned toolchain and lockfile:

```sh
cargo build -p canaveral-runner-client --locked
```

Use a new absolute state path under a trusted parent on a local Unix filesystem
with working advisory locks, atomic rename and file/directory fsync. All path
components must be real directories, without symlinks. Non-Unix secure storage is
explicitly unsupported. Other Unix systems and filesystem implementations still
need qualification; fixture checks run on macOS and Linux, with loopback TLS conformance on Linux. Filesystem mount
semantics cannot be established merely by the presence of Unix APIs.

The administrator first approves an exact controller/runner/generation/incarnation
binding, with a caller-selected approval UUID, through the documented controller
issue route. Deliver its exact JSON response securely to `prepare` on stdin:

```sh
target/debug/canaveral-runner-client prepare /absolute/new-runner-state https://controller.example < approval.json
```

`prepare` generates 32 random bytes, encodes the runner secret as base64url, and
saves it with the approval and origin before any network request. Existing paths
are refused even when empty. Preserve this directory after any error; do not
rerun preparation at another path to compensate for an uncertain enrollment.
Approval delivery files are operator-managed secrets, outside this client's
storage protection. Avoid placing secrets in arguments, URLs or shell history.

Subsequent commands take the exact expected binding JSON on stdin, with only
`controllerId`, `runnerId`, `generation`, and `incarnationId`. This independently
supplied expectation must match persisted state. An optional final CA PEM file
adds trust for this client without changing system trust:

```sh
target/debug/canaveral-runner-client consume /absolute/new-runner-state https://controller.example ./trusted-ca.pem < expected-binding.json
target/debug/canaveral-runner-client authenticate /absolute/new-runner-state https://controller.example ./trusted-ca.pem < expected-binding.json
```

`consume` durably marks an uncertain attempt, submits the exact saved consume
request, validates its revision-1 receipt and then authenticates the same binding.
Success is printed only after the authentication receipt is durably saved.
`authenticate` always contacts the current controller; a saved successful receipt
grants no offline authority. After a crash, timeout or lost reply, explicitly run
`authenticate` with the same state, or retry `consume` with that exact state. No
command automatically reenrolls, retries a network request or generates a changed
credential. Expired first consumption, revoked approval, rotated/revoked credential,
stale generation and mismatched receipt all fail closed. Revision updates require
a separately designed durable operator-assisted rotation workflow.

## Storage and transport boundaries

State is 0700 and files are 0600, owned by the effective Unix user. Directory
walking and file operations use no-follow directory descriptors. Regular files
must have one hard link. A persistent file lock admits one cooperative writer;
its inode and the directory pathname are rechecked before publication and sends.
Directory-relative writes cannot be redirected by a namespace swap. Observed
path/lock replacements fail closed. A malicious process running as the same user,
root, state rollback, and cloned credentials are outside this storage boundary.
The checksum detects accidental corruption, not a malicious owner who can rewrite
both data and checksum. Do not copy this identity to another runner.

Each atomic journal includes the full identity and latest phase/receipt, written
through an exclusive temporary file, file fsync, rename and directory fsync.
A failed publication poisons the open instance. Missing/corrupt files are errors,
never empty history. After acquiring exclusive ownership and validating the directory/lock, reopening
removes a leftover unpublished `identity.pending` and fsyncs the directory. No
request could have been sent based on that unpublished candidate. The committed
identity and original credential remain authoritative; the failed open instance
stays poisoned. Missing committed state is not regenerated. General torn-state
repair and deletion/retention policy are absent.
A crash during first preparation may leave unusable partial state; because prepare
never sends, it cannot have consumed approval, but recovery remains an operator gate.

Only HTTPS origins are accepted, without userinfo, paths, queries or fragments.
Rustls verifies chains and hostnames using bundled public roots plus an optional
explicit CA. Redirects and all automatic retries are disabled. Ambient proxy
variables are ignored by `no_proxy()`; explicit proxy routing is unsupported.
The client bounds JSON, CA and response bodies to 16 KiB, connects within five
seconds and applies a 15-second request deadline. HTTP parsing additionally uses
Hyper's bounded header parser. Errors omit remote bodies, URLs and secret values.
Input stdin is bounded in bytes; it has no interactive input timer.

## Verification

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build -p canaveral-runner-client --locked
(cd coordination && npm ci --ignore-scripts && npm run build)
node crates/runner-client/tests/tls-conformance.mjs
```

The Node fixture requires OpenSSL and Node >=24. It creates a temporary CA, leaf
certificate, SQLite controller and local HTTPS listener, forwarding requests to
the real TypeScript identity HTTP handler. `COORDINATION_DIR` can select another
built authoritative coordination tree. It deliberately drops a reply after the
consume commit, restarts the Rust command, authenticates and retrieves the exact
receipt. It tests hostile proxy environment settings, unrelated trust, wrong
hostname, request timeout, redirects, oversize/wrong-binding replies, credential
and cross-binding denial, rotation/revocation and newer-generation fencing.
Rust tests cover durable restart, tampering, concurrent lock ownership, unsafe
reuse, permissions, symlinks, hard links, namespace swaps and failed publication.

These are disposable loopback fixtures, not native separate-network acceptance,
proxy deployment validation, cloned-session fencing or workload stop/erasure proof.
They authorize no live enrollment, service change, deployment or acceptance closure.
