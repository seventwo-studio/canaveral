# macOS guest file transactions

The native `CanaveralGuest` helper implements chunked file listing, uploads and
downloads through its authenticated HTTP bridge. The internal Python
`GuestChunkFiles` adapter translates this protocol into the shared transfer
reader/result interfaces. A provider must still supply the authenticated,
assignment-bound transport; the adapter chooses no address or credentials.
Neither addition enables macOS image admission or consumer leases.

## Paths and bounded transfers

The native app checks that it runs inside a virtual guest before creating the
service, and the service checks that guard again on each request. Native access
uses the guest app's filesystem permissions. Production paths are absolute guest
paths. Tests substitute a confined temporary root and never expose the host root
through a running helper.

Requests use `POST /v1/files/<operation>` with exact JSON fields. The existing
bridge rejects incorrect credentials and browser Origin headers before file
service dispatch. Queries and unknown fields are refused. Each transfer uses a
UUID; responses return that identity. Upload/download begin binds the identity
to its original request. A conflicting begin cannot reuse it.

| Operation | Fields | Result |
| --- | --- | --- |
| `list` | `path` | Path, sorted entry metadata and explicit truncation after 2,000 entries |
| `upload/begin` | `id`, `path`, `size` | Fresh receiving state and declared byte count |
| `upload/chunk` | `id`, `offset`, base64 `data` | Exact next byte offset |
| `upload/finish` | `id`, `bytes`, `sha256` | First bounded verification step, or completed publication |
| `upload/verify` | `id` | Next bounded verification step, or completed publication |
| `download/begin` | `id`, `path` | Pinned regular source and byte count |
| `download/check` | `id` | Source identity check without consuming bytes |
| `download/chunk` | `id`, `offset` | Next bounded base64 chunk and offset |
| `download/finish` | `id` | First bounded second-pass verification step |
| `download/verify` | `id` | Next verification step, or verified byte count and digest |
| `status` | `id` | Private journal state, size and available digest |
| `abort` | `id` | Confirmed cleanup where ownership is known, or explicit refusal |

Individual chunks contain at most 512 KiB; requests fit the existing bounded HTTP
body. Total file size has no product cap. Lengths use the common protocol's exact
nonnegative integer range, through `2^53 - 1`, and remain subject to filesystem
and available storage constraints. Begin does not preallocate the declared file.
Directory listing limits and transfer chunk limits bound individual responses.

Symlinks resolve inside the service root, then directory components open through
pinned descriptors with no-follow checks. Listing reports symlinks without
reading their targets. A download checks its original path, canonical parent,
opened descriptor and directory entry; alias retargeting, parent replacement,
file replacement or observed content metadata changes refuse verification.

## Publication and verification

Uploads write a private staging file in the destination directory. The old
destination remains visible while bytes arrive. Finish checks the declared
length and SHA-256, synchronizes staged bytes, then reads the staged content again
in bounded steps. Verification pins the staging inode, single-link identity,
size and modification/change times. These checks repeat before rename.

The helper synchronizes a private `publishing` receipt before rename. It then
renames through the pinned parent, synchronizes that directory and publishes a
synchronized `committed` receipt. Only that confirmed result reports
`durable: true`. Identical completed finish replay returns the receipt without
performing another rename; different byte counts/digests conflict. A publication
whose response or synchronization fails is not automatically repeated.

Downloads check identity around each chunk and perform a bounded second pass
before acknowledging the final digest. The Python adapter also checks response
identity, exact offsets, base64 shape, bounded verification progress and the
received-byte digest. A shared worker can then emit its existing verified finish
message. Source verification is not an immutable filesystem snapshot: bytes
already forwarded cannot be retracted, and an unrelated actor with the same
guest account can still race filesystem operations.

## Recovery and cleanup limits

Journals are private files in a private directory, atomically replaced and
synchronized. Transfer descriptors/cursors remain volatile. A helper restart
never reopens a pending transfer or resumes its writes. Pending status requires
inspection; it does not establish completion.

Explicit abort removes only the staging inode identified by its receipt and
parent binding. A live transfer retains its original parent descriptor even if
that directory moves. After restart, changed parent identity or unrecorded
staging ownership refuses cleanup. Abort never removes a published destination
and refuses uncertain publication. A replaced staging file, symlink receipt or
foreign parent is retained rather than treated as owned cleanup.

The Python adapter never automatically retries a mutation after a lost response.
It attempts explicit abort on failure only while still authorized. Revocation
stops further transport calls. Open transfers still need explicit close/abort or
helper shutdown; automatic lease-scoped transfer reclamation and interrupted
helper ownership recovery remain unfinished. Closing file handles does not
establish VM execution fencing or lease disk/credential erasure.

## Evidence and remaining gates

Disposable Swift filesystem tests cover binary/empty files, large declared
lengths, atomic replacement, digest rejection, malformed requests, exact cursor
checks, duplicate/conflicting requests, staging replacement/mutation/hard links,
publication interruption, restart, owned cleanup, parent rebinding and symlinks.
Python adapter fixtures cover bounded reads, malformed helper responses,
interruption, revocation and verification. An exported transcript of actual
Swift service responses passes the Python upload/download adapter, including a
524,325-byte binary round trip. No native guest is involved in these fixtures.

The guest executable compiles; it has not been installed, launched or promoted as
a signed release artifact. The internal [common access adapter](macos-guest-access.md) now has common-runner
transfer coverage. Production macOS provider connection/bootstrap, native
screen/control delivery, permission checks, lease cleanup/isolation
and real filesystem acceptance remain open. The helper also implements
[independent terminal sessions](macos-guest-shells.md) with isolated coverage.
The full acceptance plan remains the delivery boundary.
