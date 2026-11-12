#!/bin/bash
# Public primary release-key pins; subkey identity alone never authorizes a release.
RUST_PRIMARY=108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE
DEBIAN_PRIMARIES="B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8 4D64FEC119C2029067D6E791F8D2585B8783D481 04B54C3CDCA79751B16BC6B5225629DF75B188BD 41587F7DB8C774BCCF131416762F67A0B2C39DE4"
require_primary_signature() {
  awk -v pins="$2" '
    BEGIN {n=split(pins,p," "); for(i=1;i<=n;i++) allowed[p[i]]=1}
    $1=="[GNUPG:]" && $2=="VALIDSIG" {if (NF!=12 || !allowed[$12]) bad=1; else found=1}
    END {exit (!found || bad)}
  ' "$1"
}
