# Session control contract

The packaged [session control schema](../canaveral/schemas/session-control.schema.json)
describes implemented `canaveral-session-v1` JSON text messages. Load a fresh
object without a controller connection or validator dependencies:

```ts
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("canaveral/schemas/session-control.schema.json", "utf8"));
```

The root schema accepts known control shapes. Validate a specific capability and
direction using its `$defs` entry, such as `uploadConsumer` or `displayHost`.
`Ready` is a separate broker-generated message bound to the session UUID,
generation and capability. It is not a provider acknowledgement or guest-readiness
proof. Session admission and peer attachment retain their
[HTTP contract](consumer-api.md) and [authorization rules](access-transport.md).

## Directions and binary payloads

| Capability | Consumer controls | Host controls | Binary messages |
| --- | --- | --- | --- |
| PTY | Write text; resize | Truncation; exit; worker error | Host terminal output only |
| Upload | Begin with path/size; finish with count/digest | Durable finish; worker error | Consumer file bytes only |
| Download | Begin with path | Size; finish with count/digest; worker error | Host file bytes only |
| Accessibility | Empty begin | Snapshot schema/size; finish; worker error | Host snapshot bytes only |
| Display | Take/release input; discrete action; receipt lookup | Ownership; action result; worker error | RFB in both directions |

The `x-canaveral-streams` metadata records these bindings. Binary data is carried
as WebSocket bytes, not as base64 inside JSON. Display binary messages contain an
incremental RFB stream; a WebSocket boundary is not an RFB packet boundary. PTY
output can split a UTF-8 character across messages.

The existing transport bounds JSON controls to 16 KiB of serialized UTF-8 and
binary messages to 64 KiB. Each direction queues at most one assembled message.
The schema cannot enforce serialized byte length, fragment assembly, socket
backpressure or message sequence. The relay enforces object/size and binary
direction rules; it does not validate every capability-specific schema. Workers
and clients retain their own validators. This artifact introduces no runtime
dependency or new relay behavior.

## Completion and input semantics

A file transfer starts with begin metadata and ends with the exact byte count and
SHA-256 digest. A schema-valid digest can still be wrong for the transferred
bytes. Upload finish must arrive before the worker publishes the final bytes;
only a positively durable provider result produces the host's `durable: true`
finish. Download finish follows source identity verification. Missing finish,
digest mismatch, early EOF or lost authorization means incomplete delivery.
Large files use repeated bounded chunks rather than full-file buffering.

Accessibility uses a separate [snapshot contract](scoped-accessibility.md), with
its existing 6 MiB, 2,000-node and depth limits. Inspection envelope limits are not
drive limits. The worker returns complete verified JSON or an error, not a
silently truncated transport payload.

Display actions carry a caller-owned UUID and exact argument fields. The schema
covers the currently accepted input actions, including semantic accessibility
actions; provider capabilities and current input ownership still decide whether
an action can execute. `unknown` is not permission to replay. It blocks ownership
handover until recovery; receipt lookup is read-only. Raw RFB input has dispatch
semantics rather than a durable action receipt. See the [visual SDK contract](visual-sdk.md).

Worker errors intentionally report `outcome: unknown`. They do not establish
rollback, positive shell termination, clean guest state or file publication.
Their known codes are `capability_unsupported`, `session_incomplete` and
`upload_publication_uncertain`. The SDK preserves these reasons and correlation
identities using fixed diagnostic messages; see [failure recovery](client-recovery.md#session-worker-failures).
Expiry, key rotation, host loss and controller restart remain independent stream
termination conditions. Reconnection never replays a command or input.

## Verification

Tests validate the schema metaschema and compare emitted worker messages against
direction-specific definitions. Disposable atomic uploads/downloads check the
actual content and finish digest; a shape-valid wrong digest cannot publish.
Synthetic accessibility trees cross binary message boundaries. PTY and display
fixtures check resize/output/exit, all accepted discrete action shapes, unknown
outcomes and receipt lookup without native input. A real temporary broker fixture
checks both ready messages, allowed PTY traffic and rejected consumer binary input.
Negative cases cover wrong directions, added ownership fields, NUL paths,
unsupported commands and invalid digests. A multibyte control demonstrates why
shape validation cannot replace the transport's UTF-8 byte budget.

These are isolated fixture proofs. Actual native adapters, separate-network TLS,
RFB interoperability, live client examples, recovery and portable release remain
acceptance gates. No live runner gains consumer execution support from loading
this schema.
