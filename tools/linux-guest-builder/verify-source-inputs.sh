#!/bin/bash
# Complete downloaded executable-input gate; reruns verify existing bytes too.
set -euo pipefail
RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$RECIPE_DIR/signature-policy.sh"
: "${INPUTS:=$PWD/inputs}"
cd "$INPUTS"
export GNUPGHOME="$INPUTS/signature-keyring"
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
fetch() { test -f "$2" || curl -fLS --retry 2 --max-time 600 "$1" -o "$2"; }
test -s kernel-key.gpg
gpg --batch --import kernel-key.gpg
gpg --batch --yes --status-fd 3 --output kernel-sums.txt --decrypt kernel-sha256sums.asc 3>kernel.status
require_primary_signature kernel.status B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1
fetch https://raw.githubusercontent.com/nodejs/release-keys/HEAD/gpg/pubring.kbx node-keys.kbx
gpg --batch --yes --no-default-keyring --keyring "$INPUTS/node-keys.kbx" --status-fd 3 --output node-sums.txt --decrypt node-sums.asc 3>node.status
require_primary_signature node.status C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C
grep ' linux-6.12.117.tar.xz$' kernel-sums.txt | shasum -a256 -c -
grep ' node-v24.11.0-linux-arm64.tar.xz$' node-sums.txt | shasum -a256 -c -
# Independently enforce operator byte pins as well as upstream signatures.
printf '%s\n' \
 '74e99aa5e60e242e0a165fed8cb2ea0d054bf7a401f01861d403d75733456613  linux-6.12.117.tar.xz' \
 '33a6673b2c7bffeae9deec7f9f8b31aad9119b08f13d49b2ca3ee3bebfe8260f  node-v24.11.0-linux-arm64.tar.xz' | shasum -a256 -c -
DEBIAN_ARCHIVE_KEYRING="$INPUTS/debian-archive-keyring.gpg" INPUTS="$INPUTS" bash "$RECIPE_DIR/verify-build-inputs.sh"
