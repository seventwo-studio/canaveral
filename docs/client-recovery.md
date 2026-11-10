# Consumer lifecycle, file and session recovery

## Unconfirmed HTTP mutations

The HTTP client does not automatically retry. A connection failure, incomplete
HTTP response or lost reply after a mutation raises `ConsumerError` with
`outcome: "unknown"` and `retryable: false`. A valid UUID in the request body's `id`
is preserved as `requestId`. Local failures before dispatch can still have no
outcome metadata. Unknown means completion was not confirmed; it does not mean
the controller rolled back. A malformed successful JSON response uses
`response_invalid` with the same mutation uncertainty. These are SDK errors;
controller error response shapes remain unchanged.

Persist the complete request before dispatch. Inspect the known lease/session/operation
after an interrupted acquire, session creation or durable command submission. Renewal/release inspection can
show the current revision, deadline, terminal state and existing cleanup intent.
If the application explicitly resubmits an idempotent request, use the identical
UUID and original arguments, including the original renewal expected revision.
Do not replace them with a new ID or current revision to manufacture another
operation. Replay returns the existing mutation record with the current lease
view, which may have advanced since the lost response.

Credential exchange is different: `ConsumerClient.scopedLease(leaseId)` rotates a key
without an idempotency UUID. Losing its response can invalidate the previous key
without returning a usable replacement. The client reports an unknown outcome
with no invented request ID and does not rotate again automatically. The owning
application can inspect the lease with its application credential; any subsequent
rotation is a separate explicit mutation and can revoke other scoped users.

Nine fixtures cover transport and JSON failures plus actual disposable
controller acquire, renew, release, credential rotation, session creation and durable operation submission.
They discard the response after server completion, then verify inspection,
unchanged mutation/generation/cleanup identities and absence of automatic replay.
These fixtures do not establish separate-network or native cleanup acceptance.

## Staged file downloads

`LeaseClient.downloadToFile(requestId, member, path, destination, options)` stages a download privately in the selected existing directory.
It publishes the destination only after the existing streaming client verifies
source completion, byte count and SHA-256. It does not rotate credentials, renew
or release the lease, reconnect a stream or retry a request.

```ts
import { LeaseClient } from "canaveral-machines/sdk";

const lease = LeaseClient.fromCredentialFile({ baseUrl, leaseId, credentialFile });
const result = await lease.downloadToFile(sessionId, "primary", guestPath, localPath);
```

Persist the session UUID before dispatch. The returned object is the verified
download finish message. Its digest covers file contents, not a local filesystem
crash-recovery guarantee. Files stream in bounded buffers without a new total
file-size cap.

## Publication behavior

The default refuses an existing destination, including a dangling symlink, before
creating a session. On POSIX, publication without replacement uses an atomic hard
link; Windows uses a no-replace native handle rename. A destination created by
another writer during transfer remains untouched. There is no fallback to an
overwrite or partial copy when the selected operation is unsupported.

Pass `{ replace: true }` explicitly to publish with atomic replacement. The old file
remains available throughout receipt and verification. A failed transfer, digest
check or file flush does not replace it. A verified replacement is a new private
file, with mode 0600 on POSIX; it does not inherit the old file's permissions.
Select a destination directory controlled by the consuming application.

The client flushes the private stage before publication. Linux binds child
operations through the retained `/proc/self/fd` directory descriptor. Darwin uses
the installed `canaveral-mobile-native` Rust helper, whose scoped stdio RPC retains
directory and stage descriptors for `openat`, `linkat`, `renameat`, cleanup and
directory synchronization. The initial selected-directory alias is resolved once;
renaming that directory afterward cannot redirect publication into a replacement
directory. Stage identity checks prevent adoption or cleanup of a foreign
temporary entry. Set `options.helperPath` to an absolute helper path when it is
not installed in the usual build location or on `PATH`.

Windows uses the shipped supervised Win32 bridge: the selected drive, ancestor
directories and private stage retain native handles, volume/file identities and
metadata checks. Publication renames the stage handle relative to the retained
parent, with replacement disabled unless requested. A definite collision is
reported separately from a lost rename acknowledgement. File buffers are flushed;
Windows omits POSIX directory synchronization. An uncertain rename never triggers
another publish or disposition of the potentially published file.

External applications may pass `options.files`, implementing the exported
`DownloadFiles`/`DownloadDirectory` interfaces, instead of using platform bridge
discovery. The adapter must preserve exclusive creation, bounded writes, pinned
directory/stage identities, atomic publication and owned cleanup. A missing helper
or required bridge operation fails before a download session is created.
Disposable Darwin filesystem/helper and injected Windows-handle fixtures cover
these publication and recovery paths. Native Windows/filesystem compatibility and
crash recovery remain acceptance gates; successful return is not a portable
power-loss proof.

The lower-level `download(..., writer)` retains its existing behavior. Its
caller-owned writer can contain partial bytes on failure. Use it when the
application owns staging or another transactional sink.

## Errors and inspection

| Code | Meaning |
| --- | --- |
| `download_destination_exists` | The existing or concurrently created destination was not replaced. |
| `download_destination_failed` | Local I/O failed before publication; this operation did not replace the destination. |
| `download_publication_uncertain` | Publication was attempted, or directory synchronization failed after publication. Inspect the local destination before another attempt. |
| `download_temporary_cleanup_failed` | Temporary-file cleanup was not confirmed. Inspect the selected directory; the file may remain private there. |

Transfer errors keep their original status and code. Before publication their
message states that the destination was not replaced. Local errors correlate to
the persisted session UUID; existing server correlation IDs are preserved. No
error code triggers an automatic retry. A publication error can occur after the
new destination exists; the client must not claim rollback in that case. A
temporary filename collision never authorizes removing the pre-existing file.

Download tools should load an existing lease key and require an explicit session
UUID. Print only correlation identifiers, completion state, byte count and digest;
keep credentials and file contents private. Replacement must be explicit. A
successful local help command does not establish live transfer acceptance.

From a checkout, run `npm run build`, then
`node examples/lease_download.ts --help`. The TypeScript examples import the
emitted SDK JavaScript under `coordination/dist/src`, so Node's ordinary type
stripping does not encounter implementation-only TypeScript syntax. The SDK tests
invoke the five `node examples/lease_*.ts --help` entry points from the checkout;
they do not substitute separately compiled example copies.

## Session worker failures

Upload, download, accessibility and display clients preserve received worker
failure codes. `Error.outcome` is `unknown` for these controls; `requestId`
identifies the access session, or the active display action when one is in flight.
Worker errors have `retryable: false`. This is diagnostic metadata, not proof that
nothing executed or permission to submit a replacement request.

| Code | Recovery meaning |
| --- | --- |
| `capability_unsupported` | The worker reports missing access support; inspect the existing session before selecting another environment. |
| `session_incomplete` | Completion was not confirmed. Inspect state before another attempt. |
| `upload_publication_uncertain` | Commit may have published the file; inspect the guest destination before retrying. |
| `session_protocol_error` | A received worker error control was malformed or unrecognized; completion remains unknown. This code is local to the SDK. |

The client uses fixed diagnostic messages rather than forwarding provider text.
Unexpected fields or a claimed successful outcome in an error control cannot
become a success result. A cached received refusal stops subsequent writes. Raw
`SessionConnection.receive()` clients still obtain JSON controls. If a disconnect
loses the worker message before receipt, the original transport failure can remain;
the SDK does not invent a more specific reason or reconnect to recover it.

The lower-level stream can contain partial output before an error. Staged local
downloads retain the worker code/outcome and preserve the destination when the
failure occurs before publication. Local uncertain publication also exposes
`outcome: "unknown"`. Other errors may leave `outcome` unset (`undefined`), which means
unreported rather than confirmed absence of effects. HTTP error response shapes
remain unchanged.

Display action/receipt waits also expose an unknown outcome after a timeout,
dispatch failure or disconnect. Untyped socket/EOF failures become
`session_incomplete`; existing typed error codes remain intact. The interrupted
display closes, and input is never replayed. Open a new view-only display session
and call `receipt(originalActionId)` to inspect the existing durable record.
A fixture drops a successful acknowledgement after provider completion and
recovers the receipt this way, verifying one provider invocation. Real native
crash recovery remains unverified.

## Verification

Disposable fixtures cover multichunk and empty downloads, interruption and bad
digest preservation, competing writers, explicit replacement, file and directory
sync failures, a lost replacement receipt, cleanup failure, temporary-name
collision and POSIX directory renaming. A separate real controller/broker/runner/
SDK fixture verifies complete publication and rejection after source mutation.
These checks do not exercise retained machine data, real native adapters or
separate-network TLS. Broader lease/session/input recovery and release acceptance
remain separate acceptance requirements.
