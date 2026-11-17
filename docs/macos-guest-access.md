# macOS common guest access adapter

The TypeScript guest adapters connect the native helper's file, terminal, display
and accessibility protocols to provider and runner interfaces. Their binding is
`GuestHelperBinding` in `coordination/src/control/session-protocol.ts`. Production
macOS guest connection/bootstrap, admission and native acceptance remain open.

## HTTPS request transport

`GuestHTTPS` in `coordination/src/guest/https.ts` implements the binding's request
callable. Its constructor accepts `origin`, `credential`, optional `caFile` and a
timeout in seconds (default 20); its `call` property is the request function. It requires HTTPS with certificate and hostname
verification, using system trust or an explicitly supplied CA file. Legacy
callers must already have verified that the endpoint and credential belong to
the current guest assignment and boot. The version 1 verified factory below
authenticates a trusted expected tuple and pins the helper incarnation. The
transport does not discover guests,
enroll identities, provision a proxy or decide trust policy.

Each call opens an independent connection, so a shell read cannot serialize
display capture or another terminal. It uses no environment proxy, follows no
redirect and performs no automatic retry. JSON requests fit the native helper's
1,000,000-byte parser envelope. Responses are bounded to 64 MiB, including
base64 display frames; errors use a 4 KiB envelope. These limits bound individual
protocol messages, not total file size or shell count. File chunks remain
streamed through the existing transfer adapter.

Malformed/truncated responses, timeouts and lost acknowledgements leave a POST
with `outcome=unknown` and `retryable=false`. Binding error redaction preserves
that outcome, including authorization ending before acknowledgement. Recognized
pre-effect display refusals retain their typed codes; arbitrary helper error
messages never enter public receipts. Socket timeouts and remaining-time checks
bound I/O; they do not supply native lease expiry or command cancellation.

The HTTPS tests use ephemeral certificates and private loopback listeners.
Common runner file transfers, independent shells, accessibility snapshots and
owned RFB input also run against synthetic helper responses over those sockets.
This establishes transport integration, not a real macOS guest, a separate
network/proxy boundary or production provider binding.

## Assignment binding

A provider supplies a resolver accepting its machine, image and assignment
folder. The resolver returns `GuestHelperBinding(request, authorized, cleanupAuthorized?)`. It must pin requests to the authenticated guest's
verified destination and current assignment/boot/lease identity. `request(path, null)` performs a read; `request(path, object)` posts the exact JSON object.
The transport must enforce bounded responses, verified TLS where applicable,
timeouts and typed helper refusals. The adapter selects no address, trust store,
credential, enrollment or initial setup policy.

Authorization is checked before dispatch and after acknowledgement. Revocation
during a request leaves its outcome unconfirmed. Calls are not automatically
replayed. Private transport exception text is replaced before entering common
operation receipts. Only recognized pre-effect display refusal codes survive.

An explicitly supplied cleanup predicate may authorize release of held input or
closure of an owned terminal after ordinary authorization ends. It must still
validate the same owned assignment. It is used for every cleanup request,
including normal release, and must return true when that cleanup is valid. It
cannot authorize new input, file publication or inspection. Without that explicit
predicate, cleanup uses ordinary authorization and may remain unconfirmed after
revocation. This is not native lease deadline enforcement or disk erasure.

## Common services

- Files use `GuestChunkFiles` for bounded, verified upload/download and native
  directory listing. Simulator app-container arguments are refused. The common
  runner validates upload finish before publication and emits download finish
  only after verification. No total file-size cap is added.
- Terminals use `GuestChunkShells` with independent session UUIDs. No shell-count
  cap is added. Native helper closure must be positively acknowledged.
- Displays use `GuestStreamScreen` through the shared RFB endpoint. The runner
  passes session authorization into the display connection, so buffered native input
  cannot rely solely on a still-current machine assignment after its session
  ends. Cleanup remains separately bound to ownership.
- Accessibility uses the native flat snapshot directly. Provider selection must explicitly bind the macOS inspection adapter; a source
  label alone cannot select or authorize a native transport. Source, coordinates, schema and byte envelope
  are checked. Snapshot identities and native handles retain helper semantics;
  screenshots travel separately on the display connection. Read-only inspection
  never claims or resets input.

Semantic input carries the owning display connection's stream/frame context and
an ordered barrier behind preceding raw events. It executes inside existing
durable provider operation receipts. Uncertain dispatch is not replayed, and
legacy helper input is never a fallback for missing stream ownership.

## Remaining gates

The resolver is an internal integration seam, not a completed transport or public
configuration option. No production provider binds it yet. `guestAccess` image
admission remains Linux-only, and ordinary runners still refuse consumer lease
execution. These changes do not admit macOS images or grant host enrollment.

Fixtures exercise common upload/download, accessibility transfer, RFB/semantic
input, distinct terminals, authorization changes, explicit cleanup, malformed
snapshots, missing bindings and private-error redaction. They use injected fake
guest responses and temporary files; they prove no real guest input, permission,
filesystem, networking, expiry or isolation behavior. Native bootstrap, production
endpoint binding, permission/readiness checks, input/inspection refresh, capture/clone
and the full lease lifecycle still require implementation or native acceptance
before provider acceptance.

## Version 2 helper identity challenge (ST-593; supersedes ST-591 wire v1)

`verifiedGuestHelperBinding(expected, endpoint, credential, authority, options)`
returns the existing `GuestHelperBinding` after a verified TLS identity read and fresh challenge proof.
The internal resolver must supply `expected()` from independently trusted state:
exact keys `version: 1`, `machineId`, `leaseId`, `fingerprint`, `launchId`.
UUIDs are lowercase canonical strings; the fingerprint is 64 lowercase SHA256
hex digits pinned to the assignment receipt (`assignmentFingerprint` on Apple).
`launchId` is an opaque future provider-minted UUID. It must not come from a
host boot clock, endpoint response, or guest assertion. Owned launch-media delivery is described below; no production transport/resolver is bound yet.

`DesktopBridge` accepts an optional immutable `GuestAssignmentContext`. A new
assignment requires a new helper instance. Each helper creates a fresh incarnation
UUID. The guest app stays in legacy manual mode with no environment, file or
public enable switch. Its reused cloned Keychain desktop credential is neither a
fresh assignment secret nor evidence of tenant isolation.
Bound mode uses the transport's credential shape: 32–4096 printable ASCII
characters without spaces. The legacy guest app retains its existing credential
rules. The shared vector uses a credential valid in both implementations.

Assignment-bound helpers accept only authentication v2. The historical
`fixtures/guest-binding-v1.json` remains unchanged as downgrade evidence; v1 is
superseded and has no fallback. Assignment schema remains `version: 1`.
Legacy manual Bearer mode and CanaveralGuestApp are unchanged; no public switch
selects bound mode.

Each explicit TypeScript resolution generates 32 cryptographically random bytes
and encodes them as canonical unpadded base64url (43 characters). Identity is
exactly `GET /v1/identity`, no query and an empty body, with:

`Authorization: Canaveral-Binding-v2 <nonce>.<identityRequestMAC>`

Ordinary requests use `Authorization: Canaveral-Binding-v2 <requestMAC>`.
All MACs are HMAC-SHA256 keyed by the credential's UTF-8 bytes, encoded as
canonical unpadded base64url. Nonce and MAC fields must each decode to exactly
32 bytes and re-encode identically. Lengths are checked before decoding;
padding, alternate encodings, extra fields and mixed versions are refused.

Canonical messages are UTF-8 with fixed-order LF-separated lines, including a
final LF. There is no JSON canonicalization. The common prefix is:

```
Canaveral-Binding-v2
<purpose>
1
<machineId>
<leaseId>
<fingerprint>
<launchId>
```

Purpose `identity-request` appends one nonce line; `identity-response` appends
nonce then incarnation lines; `request` appends one incarnation line. Each
appended line also ends in LF. The literal `1` is the assignment schema version,
not the handshake version. Shared `fixtures/guest-binding-v2.json` pins exact
bytes, MACs for all three purposes and the deterministic identity response DTO.
Both real implementations verify these vectors. Swift tests pin the producer's
output to the shared DTO, which TypeScript tests parse and verify by default.
Setting `CANAVERAL_IDENTITY_DTO` for the Swift and TypeScript tests also checks
the actual emitted Swift response.

Before its first await or operational delegation, DesktopBridge authenticates
the exact challenge against its immutable assignment. Only then does it return
exactly `version`, `machineId`, `leaseId`, `fingerprint`, `launchId`,
`incarnation`, echoed `nonce` and `proof`, within 4 KiB. Proof is the
`identity-response` MAC, never a reflected identity-request or request MAC.
Identity authentication authorizes only this read. Identity reads have no effects
and need no durable nonce or mutation ledger. All operational endpoints require
the request MAC for that helper incarnation. Bound mode refuses plain Bearer;
legacy mode refuses binding authentication before effects.

Before constructing GuestHelperBinding, TypeScript checks the exact trusted
tuple and fresh nonce, verifies the response proof with a constant-time MAC
comparison, and rechecks live authority and expected assignment. A plausible
unsigned identity, tampering or an old response against a fresh nonce fails
closed. TLS hostname and CA verification remain required.

This proves only that a holder of the configured secret answered the fresh
client challenge. It does not prove endpoint placement or channel binding,
unique credentials across clones, or end-to-end authentication of every later
response. A proxy can relay a challenge to a secret holder. The request MAC
covers tuple and incarnation, not HTTP method, path or body; it remains a bearer
for that incarnation with no per-operation replay protection.

The verifier compares all trusted tuple values, pins the returned incarnation,
and combines `authority()` with a fresh `expected()` comparison before dispatch
and after acknowledgement. Once observed invalid, authority or expected-state
changes permanently invalidate the binding, even if values later revert. A 401,
including restart/incarnation refusal, permanently invalidates it. There is no
fallback, retry or automatic rebinding; a new explicit resolution can verify a
fresh helper. Private responses and transport diagnostics never enter identity
errors. Lost POST acknowledgements and revocation during acknowledgement retain
unknown outcomes. The verified factory supplies no separate cleanup authority;
existing binding cleanup ownership rules still apply and cleanup may remain
unconfirmed after revocation.

The helper cannot independently learn host-side revocation. This protocol does
not enforce native permissions, readiness, lease deadlines, cancellation, owned
cleanup, disk erasure or capture/clone acceptance. Production resolver/transport, native launch delivery acceptance, tenant isolation, endpoint discovery and those native lifecycle gates remain open.
`guestAccess` admission remains Linux-only. Portable protocol verification does
not establish usable or accepted macOS workspace delivery.

## Owned assignment delivery (ST-594)

The Apple provider's internal leased macOS path now constructs launch media under
its assignment/provider lock before native preparation and boot dispatch. This
path does not enable macOS admission: `guestAccess` remains Linux-only. Production
transport and resolver selection remain separate work. AssignedGuest now has the private TLS listener described below; this does not
resolve a guest route or connect the production host access path.

The provider mints a random launch UUID and 32-byte canonical unpadded base64url
credential. The original bounded guest payload was `{version:1,assignment,credential}`;
that historical format is cleanup-only. New launches use the TLS-bearing v2
format documented below;
`assignment` has the five existing identity keys. `fixtures/guest-bootstrap-v1.json`
is a public test vector, not an operational credential. The exclusive mode 0600
`guest-launch.json` receipt is the private source for a future resolver's
`expected()`. Guest responses and guest files cannot supply that trusted tuple.
The fresh secret is never a public Machine field, argument, diagnostic, base-image
change or Keychain value.

Receipt, source JSON, ISO and every intermediate stay below
`config.storage/<machine UUID>/`. The separate assignment folder retains only
existing secret-free provisioning/boot/deletion evidence. `guest-bootstrap/content`
contains only `assignment.json`. The utility is `hdiutil makehybrid -iso -joliet`
with label `CANAVERAL_BOOT`; the output is raw ISO9660, not a disk image container.
Both primary and supplementary ISO directory trees must contain exactly the
expected assignment bytes. A single Joliet descriptor with valid escape bytes
and case-exact `assignment.json` is required. Linux cloud-init uses its existing
independent path.

`planned` is durable before local staging. Identical staged input can resume with
the same secret before dispatch; a local staging failure remains eligible for
owned cleanup with closed-handle proof. The provider persists `building`
immediately before invoking the utility. Any subsequent exception, lost
acknowledgement, invalid output, crash before seal
or interrupted seal leaves a hold: no rebuild, replacement, relaunch or cleanup.
A utility might still reopen files after an interrupted host process; observing
no current handle does not prove builder exclusion. There is no reset or automatic
repair. Only confirmed utility success, validated bytes, flush, mode 0400 and a
durably recorded exact pin permit `sealed`; the file and containing directory
are flushed before that receipt. A sealed intent revalidates the pin
before reuse. A durable native launch request prevents automatic relaunch even
when a later status says stopped. Lost prepare and runner results retain the
existing uncertain-operation guards and provisioning ordering.
Fresh status from a held runtime remains observable as running or starting;
the dispatch guard prevents another launch without masking current status or
blocking lease-fence publication.

Native metadata contains only a separate `LaunchMediaPin`: assignment/launch
identity, path, uid, mode 0400, nlink 1, size, SHA256 and device/inode. It does not
use `PinnedBootFile` or filesystem immutable flags. The runner validates the
explicit launch and machine/lease binding, passes a validated typed argument into
`MachineConfiguration.build`, and appends a read-only virtio disk after the system
disk. Descriptor path/identity/digest verification occurs around attachment.
The runtime consumes a durable exclusive launch attempt with lease authorization
checks on both sides before VM start. Guest discovery assumes no virtio block
identifier. Missing metadata cannot cause filename-based attachment.

`CanaveralAssignedGuest` is a separate SwiftPM executable selected only by future
template qualification. It fails closed on missing/delayed media; it never chooses
the manual helper, reads or writes its Keychain credential, or displays assignment
or credential data. It requires a virtual guest and shares the manual helper's
service lock, so the two cannot bypass input/service ownership. Its mount-table
selector requires exactly one read-only `cd9660` volume with the fixed label and
only `assignment.json`; reads are bounded and reject symbolic links, extra files,
substitution, malformed or ambiguous payloads. Duplicate JSON keys and aliases
are refused. A per-launch exclusive startup marker prevents replaying a used
launch; bridge and input/shell journals are per launch. The bound bridge holds the
secret in memory. The retained media remains secret-bearing until owned erase.
The existing `CanaveralGuest` manual Keychain behavior stays separate.
Helper restart or guest reboot cannot reuse a consumed startup marker, so that
launch's assigned access remains unavailable. The ISO's read-only attachment
does not restrict its readability by other guest-local users or processes;
guest account/image qualification remains an isolation gate.

Cleanup checks builder exclusion, receipt and bootstrap-tree handle closure in
addition to assignment, runtime-lock and native stop proof before quarantine.
`building` also blocks preboot cleanup. No process-wide lsof exclusion is allowed;
there is no ad-hoc credential unlink. Existing positive-owned recursive erase
covers the whole tree and retains only secret-free deletion evidence outside it.

Portable tests use an injected ISO utility, real provider receipts and pins,
Swift parser/selector/startup coordinator, bound DesktopBridge identity producer,
typed native attachment construction, provider-written native pin decoding and
the TypeScript v2 proof parser. The cross-language script also runs in macOS CI. They
establish plumbing, not a booted guest or usable macOS access. Raw ISO and Joliet
mount/automount behavior, removable-volume TCC, startup timing, permissions,
independent deadline/cleanup/erasure enforcement, clone/capture, template
qualification, production transport/resolver and workspace/native acceptance all
remain OPEN. No native acceptance or deployment is implied by CI compilation.
VZ opens media by path. The surrounding pin checks detect ordinary substitution
but do not prove exclusion of a same-uid swap restored between those checks;
native attachment and host-ownership acceptance must cover that boundary.

After compiling TypeScript (`tsc -p coordination`), macOS portable checks can run
`node script/check_guest_bootstrap.mjs` with the intended Xcode toolchain selected.
It creates an owned library-only SwiftPM scratch package pointing at this checkout,
uses the injected ISO utility, and removes its fixture tree on completion. It does
not build an App target, execute CanaveralVMRunner, mount media or boot a VM.

## Per-launch private TLS transport (ST-596, first ST-595 slice)

New private receipts and bootstrap payloads use version 2. The assignment inside
still uses schema 1. The exact media JSON is
`{version:2,assignment,credential,tls:{pkcs12:<canonical unpadded base64url>}}`.
The parser rejects all v1 media; old receipts remain readable for owned cleanup
only. They cannot be upgraded, recertified, attached or launched. The native
`LaunchMediaPin.version` is now 2 and the runner rejects historical pins.
The historical v1 vector is retained. The v2 static vector tests syntax only;
interoperability uses fresh provider-generated identities, not that vector.
The payload remains at most 4096 bytes; the provider fixture requires at least
512 bytes of unused space.

`guest-launch.json.tls` privately retains `pkcs12`, exact `leafDER` (both base64url),
`serverName` and lowercase DER SHA256 `sha256`. The logical name is exactly the
lowercase launch UUID plus `.canaveral.invalid`. Every launch generates a fresh
P-256 key and self-signed CA:false leaf with only digitalSignature and serverAuth
usage and one exact DNS SAN. Node generates the key; absolute `/usr/bin/openssl`
signs and packs PKCS12. The fixed packaging password is not an authentication
credential and is nevertheless passed through a private owned file, never argv
or environment. All inputs, outputs and utility diagnostics remain inside owned
`guest-bootstrap/tls`; utility stderr/stdout are discarded except the public
certificate inspection output, directed to an owned file. All retained files
remain secret-bearing until the entire owned storage tree is erased.

Before the first utility, custody durably enters `tls-building`. It spans signing,
packing and profile validation. Any interruption or unconfirmed result keeps the
hold and blocks regeneration, replacement, launch and cleanup. Confirmed validated
completion returns to `planned` with stable TLS custody. The separate ISO `building`
hold and existing local planned-stage cleanup remain. No automatic hold reset
exists. Certificate validity is two days from signing. A guest clock behind signing
or beyond expiry refuses TLS; it never extends assignment authority. There is no
clock-skew relaxation, renewal or fallback for an existing launch.

AssignedGuest requires macOS 15+ and imports with `kSecImportToMemoryOnly=true`.
It validates the P-256 key, key match, exact name/SAN, CA:false, digitalSignature,
serverAuth and SSL trust against only that leaf. It waits at most 20 seconds for
exactly one up nonloopback interface matching the UUID-derived native MAC and
exactly one RFC1918 IPv4, consumes the startup marker, then binds only that
address on 8767. There is no automatic rebind. Readiness is announced only by
NWListener readiness. Manual LoopbackServer and the manual app are unchanged.

BoundTLSServer requires TLS 1.3. It owns and closes every delivered connection,
with 32 total and 8 unauthenticated/handshaking peers. Network.framework's native
new-connection limit decrements per delivery, rather than tracking concurrent
peers; the server uses its own concurrent admission accounting. Deadlines are
5 seconds for handshake, 5 for head/authentication, 15 for body, 30 for handler
work and 15 for response write. The head including terminator is at most 4 KiB.
Before head authentication, the total buffered initial chunk is at most 4 KiB,
including any coalesced body bytes. No further body reads occur until authentication.
Bodies remain limited to 1,000,000 bytes. Identity has no body. The dedicated
header-authentication method never dispatches an operation; DesktopBridge retains
its full-request guard. Closing sockets cancels tasks but cannot prove a native
operation stopped.

The internal pinned binding factory dials a literal address, verifies the derived
logical name and exact leaf DER, and uses only that leaf as trust with TLS 1.3.
Legacy origin/trust rules are unchanged. Factory `closeAll()` permanently rejects
new resolutions and closes all owned transports, including identity handshakes
and active requests. There is no retry, fallback or automatic rebind; lost POST
acknowledgements remain unknown.

`node script/check_guest_bootstrap.mjs` now also exercises real provider PKCS12,
Swift import/listener/DesktopBridge and Node GuestHTTPS/v2/GuestHelperAccess file
reads on localhost, plus shared MAC vectors. macOS CI runs it with jobs=2.
The disposable import uses no persistent or temporary Keychain import. On the
tested Security implementation the key nevertheless reports `isPermanent=1`;
that attribute does not establish nonpersistence. Narrow own-key lookup must be
absent or explicitly inaccessible. This is limited evidence, not a Keychain audit.

ST-595 remains open. Strict NAT lease parsing, native routing, provider binding
cache, Agent mixed-runtime wiring and the streamDownload session-authority fix
belong to the second PR. Native NAT exposure/reachability, DHCP format, guest
firewall/Local Network permission, getifaddrs behavior, TCC, automount/timing and
readiness, independent deadlines/cleanup/erasure, capture/clone/template
qualification and workspace acceptance remain open. A pinned certificate proves
possession of a launch key; it does not prove physical placement or isolation.
No admission or production guest-access gate changes here.
