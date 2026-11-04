# Scoped terminal SDK

`LeaseClient.terminal(request_id, member='primary', timeout=30)` creates and
attaches one PTY session using the existing lease credential. The member must be
ready and advertise `pty`; this does not create an iOS shell or fall back to host
process access. Persist a new session UUID before dispatch. No credential rotation,
lease acquisition/renewal/release or automatic reconnect occurs.

```python
from canaveral.sdk import LeaseClient

lease = LeaseClient.from_credential_file(url, lease_id, private_lease_key_path,
                                       ca_file=private_ca_bundle)
with lease.terminal(first_session_id) as first, lease.terminal(second_session_id) as second:
    first.resize(120, 40)  # columns, rows
    first.write('pwd\n')
    output = first.receive(timeout=1)
    second.write('printf "independent terminal\\n"\n')
```

Each attachment owns its PTY. The SDK adds no shell-count cap; admission still
requires a valid ready lease and available controller/runner resources. Separate
terminals can read/write independently. Within one terminal, reads serialize with
other reads and writes serialize with other writes, while a blocked reader does
not hold input or resizing. The transport retains its bounded message queue.
Pillow and a display session are not required.

## Input and output

`write(text)` sends exactly the supplied Unicode text, including any newline or
control characters. NUL and invalid UTF-8 text are rejected. The existing wire
contract permits up to 16,000 characters within a 16 KiB encoded JSON control;
Unicode escaping can hit the byte envelope sooner. Oversized input is refused
locally without dispatch or silent splitting. Applications choose smaller explicit
writes. `resize(cols, rows)` requires integer dimensions from 1 through 500.
These are per-message protocol bounds, not total output or file-size limits.

A successful write/resize confirms transport dispatch, not guest execution or
command completion. PTY input has no durable per-write acknowledgement or action
UUID. Sending a command again can execute it again, even when the first write
raised an error. Use a guest/application protocol when command completion and
reconciliation require stronger evidence.

`receive(timeout=30)` returns one of:

- Raw output `bytes`, at most 64 KiB per message. UTF-8 characters and terminal
  escape sequences may cross messages; applications own incremental decoding.
- `{'type': 'truncated'}` when the worker reports an output gap. The sticky
  `terminal.truncated` flag remains true; previously lost output is not recovered.
- `{'type': 'exited', 'exitCode': 0}` when the worker reports terminal end. The code
  can be `None` when unavailable. The client records `exited`/`exit_code` and closes
  the attachment. This is not positive proof that detached commands or all guest
  descendants were reclaimed.
- `None` when the receive timeout elapses. Zero polls already queued output;
  timeout alone does not close the terminal or establish command completion.

Factory `timeout` must be positive and covers peer-readiness waiting. Socket
connection and blocked writes retain transport timeouts. Receive timeouts must
be finite and nonnegative. Invalid local input/options keep an existing terminal
usable.

## Interruption and cleanup

An interrupted input/output operation closes the attachment. Known worker error
codes survive; untyped socket/EOF failures become `session_incomplete`.
`Error.request_id` identifies the session, `outcome='unknown'` and
`retryable=False`. Malformed output uses `session_protocol_error`. Cancellation
closes without masking the cancellation or replaying input. These statements do
not turn partial writes into confirmed non-execution.

`close()` is idempotent and disconnects the owned attachment; context-manager exit
also closes it. The runner attempts owned-shell cleanup after disconnect. Local
close and an exit event do not prove cleanup: inspect the session and lease when
reclamation matters. Closing one terminal does not release the lease or close its
other terminals. A disconnected session does not resume a process after restart;
open a new session explicitly, without replaying unconfirmed input.

Nine isolated SDK fixtures cover validation, raw fragments, truncation, exit
metadata, blocked-reader input, interrupted/cancelled dispatch, worker errors,
expiry and nine simultaneous fixture PTYs with independent resize/input and
confirmed owned cleanup. They use disposable controller/broker/runner state and
fixture processes only. Native guest delivery, separate-network operation,
detached-command fencing and portable platform acceptance remain open. Ordinary
live runners still reject consumer lease execution.
