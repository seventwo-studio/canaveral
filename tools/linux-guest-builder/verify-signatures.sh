#!/bin/bash
# Complete downloaded executable-input gate; reruns verify existing bytes too.
set -euo pipefail
RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$RECIPE_DIR/signature-policy.sh"
: "${INPUTS:=$PWD/inputs}"
cd "$INPUTS"
rm -f authenticated-inputs.json
export GNUPGHOME="$INPUTS/signature-keyring"
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
fetch() { test -f "$2" || curl -fLS --retry 2 --max-time 600 "$1" -o "$2"; }
require_pinned_keyring "$INPUTS/debian-apt-keyring.gpg"
INPUTS="$INPUTS" bash "$RECIPE_DIR/verify-source-inputs.sh"
gpgv --keyring "$INPUTS/debian-apt-keyring.gpg" --status-fd 3 Release.gpg Release 3>debian-release.status
require_primary_signature debian-release.status "$DEBIAN_PRIMARIES"
fetch https://snapshot.debian.org/archive/debian/20261101T000000Z/dists/bookworm/main/binary-arm64/Packages.xz debian-Packages.xz
awk '$3=="main/binary-arm64/Packages.xz" && length($1)==64 {print $1 "  debian-Packages.xz"; found=1} END {if(!found) exit 1}' Release | shasum -a256 -c -
xz -dc debian-Packages.xz > debian-Packages
# Bootstrap the already authenticated Node distribution on a fresh Linux builder.
if ! command -v node >/dev/null 2>&1; then
  test "$(uname -s)" = Linux && test "$(uname -m)" = aarch64
  node_tool=$(mktemp "$INPUTS/verification-node.XXXXXX")
  trap 'rm -f "$node_tool"' EXIT
  tar -xJOf node-v24.11.0-linux-arm64.tar.xz node-v24.11.0-linux-arm64/bin/node > "$node_tool"
  chmod 700 "$node_tool"
else
  node_tool=$(command -v node)
fi
"$node_tool" "$RECIPE_DIR/verify-debian-packages.mjs" "$INPUTS" "$INPUTS/debian-Packages"
"$node_tool" "$RECIPE_DIR/verify-input-inventory.mjs" "$INPUTS" "$RECIPE_DIR"
