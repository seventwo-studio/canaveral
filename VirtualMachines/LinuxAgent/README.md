# Linux guest worker

The classic worker now uses the Rust `canaveral-guest-agent` transport and the
Node TypeScript implementation in `../../crates/guest-agent/worker.ts`. The
systemd service runs worker-only mode. It cannot invoke inference, send user
messages, delegate work or reach desktop tools. The default Rust PID1 entry
point, its length-prefixed protocol on vsock 1024 and its namespace supervisor
remain separate. Readiness probes require shell, Git and Node only.

The classic wire contract stays newline-delimited JSON on vsock 7777: one
request per connection, response `{output: ...}` or `{error: ...}`. Rust admits
only host CID 2 and forwards to a private per-process Unix socket. Both legs
bound concurrent sessions to 16; the Node leg rejects frames over 10 MB. This
transport is private to the guest/host pairing, not a public controller endpoint.

`workerTool` accepts `name`, `arguments`, `taskID`, `invocationID` and up to 1000
`projects`. Its tools are `files_list/read/search/write/delete` and
`commands_run`. Project IDs and task IDs are UUIDs. Existing SQLite `state` and
FTS `notes` schemas are retained. A new `classic_worker_cancellations` table
persists task cancellation. Successful invocations return a durable result on
retry; changed arguments and uncertain invocations fail closed. Disconnect
cancels the task, including future dispatch. `snapshot` omits processed request
IDs, while `guestHistory` includes them for migration.

Commands use an isolated guest shell, cleared environment, closed stdin, a
60-second deadline, a 64 KiB output limit and process-group cancellation.
The output limit retains the first 64 KiB. Exit waits for bounded pipe draining.
Commands can modify their own guest account; this is not a sandbox against
malicious same-user code. In particular, a process that creates a new session
can escape group cancellation. The systemd cgroup fences the service on stop,
but a command receipt does not establish termination of escaped descendants or
VM release. PID1 protocol-1 supervision has the stronger namespace-wide fence.

## Installation inputs

An operator must supply a Linux ELF guest-agent built for the guest architecture,
Node 24.11+ installed at `/usr/local/bin/node`, and the TypeScript source installed
at `/opt/seven/seven-agent.ts`. The unit starts:

```text
/sbin/canaveral-guest-agent --worker-only --guest-confirmed
```

Run as the unprivileged `seven` account, with private `/var/lib/seven` state.
The unit blocks direct IP networking through `RestrictAddressFamilies` and
uses `KillMode=control-group`. `LinuxAgentVM.prepare` and `updateRuntime` now
require `agentBinary: Data` in addition to the TypeScript `script` and service
`unit`. Their seed includes the configured ELF and TypeScript source; the cloud
disk must already contain Node. No package download or runtime compilation occurs
at boot. The runtime receipt hashes the installed TypeScript bytes.

The TypeScript `Agent` class also ports the former coordination loop for callers
that explicitly supply a `Relay`. It retains private model output, durable
messaging and typing leases, bounded independent delegates, inbox wakeups,
profile rules, exact preapproval, research limits, reminders, responsibilities,
project files, memory search and restart reconciliation. The installed
worker-only entry point does not enable that loop. No native host inference
relay is wired by this port.

## Desktop helper

`../GuestHelpers/linux_desktop.ts` ports the authenticated loopback bridge,
takeover state, recent-frame ownership and durable uncertain input receipts.
Its guest-gated CLI uses installed `/usr/bin/xdotool` and `/usr/bin/import`
(ImageMagick) for X11 capture and input. It does not install these tools.
Wayland is unavailable; native text input currently accepts ASCII, newline and
tab only, and shortcut keys are explicitly bounded. Input tool failure leaves
an uncertain receipt and never silently replays input.

The default bridge uses `NativeAccessibility` and the Rust guest-agent's
`--atspi-inspect --guest-confirmed` / `--atspi-action --guest-confirmed` modes.
Rust dynamically loads the public libatspi D-Bus client. It reads native roles,
state sets, attributes, text/value interfaces, action names and screen extents.
It disables and clears native caches before revalidation and omits password and
protected text/value content. Required guest libraries are `libatspi.so.0`,
`libgobject-2.0.so.0` and `libglib-2.0.so.0` (Debian's `libatspi2.0-0`,
`at-spi2-core` and GLib dependencies). Loader handles remain until process exit
because GObject retains static type callbacks. No npm or Cargo dependency is added.

Install a **dynamically linked glibc Linux** guest-agent for desktop use. The
static MUSL PID1 artifact cannot load desktop shared libraries and remains the
separate boot artifact. The desktop executable defaults to
`/sbin/canaveral-guest-agent`; `CANAVERAL_ATSPI_HELPER` can select another absolute
installed path when both variants coexist. The helper retains the desktop's
`DBUS_SESSION_BUS_ADDRESS`, `AT_SPI_BUS_ADDRESS`, `DISPLAY`, `XAUTHORITY` and
`XDG_RUNTIME_DIR`. Native entry points refuse root, PID1, non-Linux and missing
guest confirmation. They never start a host bus or use a fallback implementation.

`GET /v1/accessibility/inspect` returns snapshot-local IDs and native paths.
Traversal is bounded to 1500 nodes, depth 25, three seconds and a 6 MiB envelope.
At most 16 snapshots are retained for 15 seconds. Missing native bus/root is an
error. Coverage limits remain explicit; sequential reads are not an atomic OS snapshot.

`POST /v1/accessibility/invoke` takes `id`, `snapshotId`, `nodeId`, `nativeAction`
and optional `human`. It obeys takeover state and journals uncertainty before
launching the worker. Rust resolves and re-reads every inspected ancestor and
target, requires exactly one matching action, retains its native interface and
checks CLOCK_BOOTTIME expiry immediately before one invocation. Code 42 is
confirmed refusal; 43 is uncertain invocation. Neither is reexecuted with the
same input ID, including after restart. Each attempt invalidates inspected
frames and snapshots. Each subprocess has a five-second SIGKILL deadline and
bounded standard I/O; timeout/disconnect is uncertain and never retried.

`NativeAccessibility.capture/perform` is also exported for guest server control
dispatch. Direct `perform` callers must retain the controller's durable input
journal; the bridge endpoints provide their own. The wider guest service must
install the configured glibc artifact and connect its native dispatch to this
adapter. The synchronous `describe`, `captureAccessibility` and
`performAccessibility` APIs remain available for fixtures. Portable coverage
does not establish native D-Bus/session or desktop acceptance.

## Portable checks

From the repository root, with the coordination development dependencies installed:

```sh
node --test crates/guest-agent/worker.test.ts VirtualMachines/GuestHelpers/linux_desktop.test.ts
coordination/node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --erasableSyntaxOnly --target ES2023 --module NodeNext --moduleResolution NodeNext --types node --typeRoots coordination/node_modules/@types --rewriteRelativeImportExtensions crates/guest-agent/worker.ts crates/guest-agent/worker.test.ts VirtualMachines/GuestHelpers/linux_desktop.ts VirtualMachines/GuestHelpers/linux_desktop.test.ts
cargo test -p canaveral-guest-agent --lib --locked
```

These fixtures cover worker recovery, cancellation, file confinement, delivery,
delegate concurrency, approval gates, stale frames and changed native targets.
They do not establish EFI provisioning, Linux vsock transport, native X11 or
AT-SPI behavior, process cleanup across escaped sessions, or VM ownership/release.
The JavaScript namespace gate is `fixtures/guest-agent/namespace.mjs`; it remains
a separately authorized Linux experiment and has not been run by these checks.
