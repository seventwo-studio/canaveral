# public-https-v1 destination table

`public-https-v1.cidrs` contains every prefix (including nested and globally
reachable entries) in the IANA [IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
and [IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/),
both last updated 2025-10-09, reviewed 2026-11-12. Multicast ranges are additional
denials. IPv6 outside 2000::/3 is also denied by code. The SHA-256 of the exact
UTF-8/LF table is `2d8b719c77f473e854167deff0eb2d551ff1f7df34d3bb52be8aba88465f6130`.
The policy constructor verifies this digest and fails closed on parsing errors.
Registry reachability exceptions never override a denial.

`egress::Policy` checks terminal answer sets, interface addresses, operator CIDRs
and supplied route evidence. `egress::Live` schedules decisions at two-second
intervals and retires affected IDs with `route_denied`. Tests supply synthetic
evidence; a native evidence provider, TCP relay and reactor wiring are still
required. These decisions do not currently enforce a live guest egress boundary.
A production reactor must close each returned flow before sending further bytes.
Native route changes, interface discovery completeness, physical topology and
router public-IP hairpin denial require operator acceptance. No host routes or
firewall rules are modified by this crate.

`ipv6-allocated.cidrs` is the ALLOCATED subset of the IANA
[IPv6 global-unicast registry](https://www.iana.org/assignments/ipv6-unicast-address-assignments/),
last updated 2025-10-10, reviewed 2026-11-12. Its SHA-256 is
`e4d88628225247190ed94324edd90a1cead5c9317b857cedb7ea6b772199bbb3`.
IPv6 outside that subset is denied, including reserved holes inside 2000::/3.
Membership never overrides the special-purpose, interface or operator denials.
