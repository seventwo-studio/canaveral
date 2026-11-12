# Linux public HTTPS egress policy

ST-535 experimental implementation. This defines `public-https-v1` for
workspace-v2 Linux direct boot. Full native acceptance is false; the required
cloned-route refusal blocks public CONNECT on the tested Mac. The guest has
**no NIC**; direct boot attaches no NAT device, without changing EFI or macOS
guest networking. Missing guest drivers or guest firewall
rules are not the boundary. Only loopback HTTP CONNECT → data vsock 1025 → Rust
satellite outbound TCP is permitted. The helper never listens on host vsock.

## Proxy and target grammar

PID1 brings up loopback and binds `127.0.0.1:18080` before commands. When the
assignment grant is off, the listener still returns 403 for CONNECT and opens no
flow. Only HTTP/1.1 CONNECT authority-form is accepted, one request per connection,
with a 8192-byte header ceiling and 5-second header deadline. No request body,
transfer encoding, pipelining, proxy authentication, userinfo, percent escapes or
URL path/query/fragment. Reject ambiguous duplicate Host/Content-Length headers;
Host, if present, must equal the CONNECT authority. Non-CONNECT gets 405; malformed
syntax gets 400; a syntactically valid port other than 443 gets **403**
`port_denied`, never a generic disconnect. Authority is `fqdn:443`,
`canonical-ipv4:443` or `[canonical-ipv6]:443`. Do not accept IPv6 zone identifiers.
After satellite `opened`, return 200 Connection Established then relay opaque
bytes; no TLS interception or certificate substitution. Neither proxy nor
satellite follows redirects. A tool following an HTTPS redirect must open a new
CONNECT, independently checked. Plain HTTP forwarding, UDP, DNS forwarding,
SOCKS, transparent TCP and CONNECT to port 22 are absent.

Hostnames are ASCII case-insensitive LDH labels of 1..63 bytes, starting/ending
alphanumeric, at least two labels, total ≤253 bytes excluding one optional final
root dot. Normalize to lowercase and append exactly one root dot for DNS;
never use search domains, mDNS or a relative-name resolver fallback. Reject
empty labels, underscores, Unicode (caller may supply valid LDH A-labels), and
suffixes `.local`, `.localhost`, `.internal`, `.home.arpa`, `.lan`, including the
suffix name itself. Reject single-label and numeric shorthand, octal and hex IP
notations; dotted all-numeric input must be canonical four-component decimal
IPv4 (no leading zeros except zero itself, octets 0..255), never a hostname.
Also reject alternate legacy inet_aton-recognized numeric forms before DNS.
IPv6 literals must equal lowercase RFC5952 canonical spelling with compressed
longest zero run and no dotted-decimal embedded suffix; brackets belong only to
HTTP authority syntax, not the data `open.host` field. Satellite reparses every
host independently; guest validation conveys no authority.

## Satellite enforcement

Egress defaults off. Every open checks the immutable assignment grant and the
current unexpired/unrevoked local authority. Satellite owns resolution and uses no
ambient proxy, HTTP client or connect-by-name API for TCP. A bounded resolver
worker may use system getaddrinfo for both families on the normalized absolute
name (with its trailing root dot). Resolution plus connect has a 10-second budget
and at most 64 terminal A/AAAA answers. Overflow, incomplete results, errors or an
empty result deny. System resolution does not expose CNAME chains, so this mode
does not check CNAME targets: every terminal address must pass the same policy.
A timed-out lookup must not permit replacement workers to accumulate without bound.
Evaluate **every** terminal address across both families; any denied answer
rejects the whole name, not merely that answer. Pin an allowed address from this
set and connect by sockaddr only; fallback may use another already vetted answer
inside the same deadline, never a new resolution. Check getpeername matches.

The following denials are cumulative and cannot be relaxed by application policy:

- All prefixes in the IANA IPv4 and IPv6 Special-Purpose Address Registries,
  including globally reachable entries; also unspecified, reserved/unallocated,
  multicast and limited broadcast ranges. Ship reviewed versioned tables with
  source date/content digest, test nested entries, and fail closed if tables
  cannot load. Never use only a language runtime's is_global/is_private helper.
- Thus RFC1918, 127/8, 169.254/16 (including metadata 169.254.169.254), CGNAT
  100.64/10, documentation, benchmarking, IPv6 loopback/link-local/ULA and tailnet
  fd7a:115c:a1e0::/48 are denied. Embedded IPv4 forms `::ffff:0:0/96`,
  `64:ff9b::/96`, `2002::/16` and `2001::/32` are denied in their entirety;
  this version does not attempt safe embedded-address extraction exceptions.
- Every address currently assigned to any host interface, regardless of scope
  or route, plus operator-configured extra deny CIDRs. Refresh interface evidence
  at each connect; unavailable/incomplete evidence denies. Deny CIDRs include
  site public addresses and router public/hairpin destinations where applicable.

Immediately before connect, ask the host kernel for the selected route to the
pinned address. Permit only a route whose actual prefix is default (`0/0` or
`::/0`), with a gateway and no on-link/direct flag. Deny any more specific route,
including VPN/tailnet/tunnel/utun-specific routes and public LAN prefixes. A
tunnel/utun selected **default** may pass the route rule but all address/interface
and operator denials still apply. A cached/cloned specific host route does not
count as default by inference; inability to identify the real route fails closed.
Repeat this check for each attempted vetted address, at connect time, and verify
peer/address/interface evidence after connect before `opened`. A race or query
error refuses the flow. Errors reveal only fixed codes, never local interfaces,
DNS answer sets or route details to the guest. No payload/URL/credential logging.

Map data open errors to CONNECT: invalid_target→400; port_denied/egress_denied/
destination_denied/route_denied→403; limit→503; connect_timeout→504;
connect_failed→502. Responses contain only the fixed code and close the stream.
Once 200 is sent, later errors close the stream. Flow/byte/deadline ceilings are
in [guest wire](guest-wire.md#st-535-data-protocol-contract-unimplemented).

## Open isolation and compatibility gates

Every live flow must revalidate its pinned address against current interface
addresses, deny CIDRs and kernel route evidence at intervals of at most two
seconds. Any denial or unavailable evidence closes the flow with `route_denied`.
The satellite live TCP reactor consumes these decisions using native interface
and route evidence; portable tests cover revalidation scheduling.
Native route-change closure remains unproven; this assignment does not change
host routes without operator authorization. A route can change between checks. A router's public address can hairpin to a private service even when
its route is default; operators must deny all such site public CIDRs. The policy
cannot discover arbitrary router translations. DNS and route fixtures do not
prove host/LAN/tailnet/other-guest isolation. The absolute ST-535 isolation goal
remains unaccepted until these limits are reviewed and native adversarial tests
cover this host's routing and hairpin topology. Do not advertise a categorical
isolation guarantee from these connect-time checks alone.

Only proxy-aware HTTPS to public port 443 works. Git HTTPS and npm proxy behavior,
CA trust, redirects, package scripts, pinned-commit checkout and actual npm ci/test
require native acceptance. SSH, UDP and tools ignoring proxy variables fail.
No claim is made for GitHub Actions, containers, native-addon toolchains or private
registries. The proxy cannot inspect encrypted traffic to distinguish HTTPS from
other protocols on 443, or prevent a public server from acting as an application
relay; a trusted public service can itself fetch private resources elsewhere.
This policy controls the satellite's direct destinations, not remote service
behavior. Host firewall changes and deployment are outside this contract.

## Implementation boundary

Rust connects the strict target/CONNECT grammar, no-NIC configuration, guest
loopback listener, bounded resolver, native route/interface evidence and
satellite TCP/data reactor. Native denial cases passed; public CONNECT failed
the required post-connect route check. These observations do not establish full
egress or isolation acceptance.
Transfers move at most 64 KiB per serialized step, a known throughput limit.

### ST-535 data closure and bounded route evidence (2026-11-12)

`dataPlaneClosed` requires every outbound flow socket, relay descriptor,
data reactor thread and transfer worker to be closed/joined. Timed-out
getaddrinfo threads are excluded: they hold no guest-reachable socket and
are capped at four. This exclusion does not cover route-evidence workers.

Periodic live-flow revalidation is hard-bounded by its two-second period.
If getifaddrs/RTM_GET evidence has not completed within that period, the
satellite closes all live flows with `route_denied`. A stalled evidence
worker prevents positive joined cleanup evidence; it is never replaced by
an unbounded series of workers. Native acceptance remains required.

### Native route incompatibility observed (ST-535, 2026-11-12)

On the authorized Mac, an RTM_GET query before TCP connect reported a default
route with a gateway. Immediately after connect, the kernel reported a cloned
/32 host route (HOST and WASCLONED). The unchanged policy correctly refused it
with `route_denied` before opening the guest tunnel. Thus allowed CONNECT, git
clone and npm installation did not pass native acceptance. Treating that clone
as a default route by inference would violate this contract; no such exception
is implemented. Public HTTPS acceptance needs a separately reviewed policy and
route-evidence design. This observation does not authorize host route changes.

Static reserved/operator-denied destinations are classified before requesting
route evidence, so unavailable route evidence cannot hide a known
`destination_denied` refusal. Darwin's compact all-ones IPv4 host netmask is
recognized as /32; it remains a specific/direct route and is still denied.
