# Scoped TypeScript terminal SDK

`LeaseClient.terminal(requestId, member = "primary", timeoutMs = 30_000)` creates
and attaches one PTY session with the existing lease key. The member must be ready
and advertise `pty`. There is no iOS shell or fallback to a host process. Persist
the session UUID before dispatch. The SDK does not rotate keys, renew or release
leases, reconnect or replay input.

```ts
import { LeaseClient } from "../coordination/src/sdk.ts";

const lease = LeaseClient.fromCredentialFile({ baseUrl, leaseId, credentialFile });
const terminal = await lease.terminal(sessionId);
try {
  await terminal.resize(120, 40);
  await terminal.write("pwd\n");
  const output = await terminal.receive(1_000);
} finally {
  terminal.close();
}
```

Each attachment owns its PTY. Separate terminals have independent input, output
and resizing. Reads serialize with reads and writes with writes; a blocked reader
must not prevent input. Admission still requires available resources and a valid,
ready lease. No SDK shell-count limit substitutes for resource accounting.

`write(text)` sends exactly that text. NUL, malformed Unicode and oversized controls
are refused locally rather than split silently. The wire permits up to 16,000
characters within a 16 KiB encoded control. `resize(columns, rows)` requires integers
from 1 through 500. Successful dispatch does not prove guest execution or completion;
PTY writes have no durable per-command receipt. Sending the same command again can
execute it again, including after a write error.

Output is raw bytes, with at most 64 KiB per binary message. UTF-8 characters and
terminal escapes can span messages; callers own incremental decoding. A truncation
control records an output gap. An exit control records the reported exit code,
which can be null. A receive timeout returns null and does not prove completion.
Timeouts are milliseconds; zero polls queued output. Factory timeouts are positive
and bounded.

`close()` is idempotent and closes only this attachment. It does not release the
lease or close other terminals. Disconnect requests owned-shell cleanup but is not
proof of detached-process termination. Cancellation, worker errors and interrupted
I/O must not replay input. Errors retain the session `requestId`, known code and
`outcome: "unknown"` when completion is unconfirmed. Open a new session explicitly
after inspection; a disconnected session does not resume a process.

Portable cases must cover independent PTYs, concurrent read/write, resize,
truncation, exit metadata, expiry, interruption and cleanup uncertainty. Native
delivery, detached-command fencing and separate-network acceptance remain open.
An SDK session method alone does not make a provider eligible for consumer leases.
