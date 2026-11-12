#!/bin/bash
# Run in BUILD after fetch-experimental.sh. Trust acquisition is experimental.
set -euo pipefail
mkdir -m700 signature-keyring
export GNUPGHOME="$PWD/signature-keyring"
gpg --auto-key-locate clear,wkd --locate-keys autosigner@kernel.org
gpg --export B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1 > inputs/kernel-key.gpg
gpg --status-fd 3 --output inputs/kernel-sums.txt --decrypt inputs/kernel-sha256sums.asc 3>kernel.status
grep -q '^\[GNUPG:\] VALIDSIG B8868C80BA62A1FFFAF5FDA9632D3A06589DA6B1 ' kernel.status
curl -fLS https://raw.githubusercontent.com/nodejs/release-keys/HEAD/gpg/pubring.kbx -o inputs/node-keys.kbx
gpg --no-default-keyring --keyring "$PWD/inputs/node-keys.kbx" --status-fd 3 --output inputs/node-sums.txt --decrypt inputs/node-sums.asc 3>node.status
grep -q '^\[GNUPG:\] VALIDSIG C82FA3AE1CBEDC6BE46B9360C43CEC45C17AB93C ' node.status
(cd inputs; grep ' linux-6.12.117.tar.xz$' kernel-sums.txt | sha256sum -c -; grep ' node-v24.11.0-linux-arm64.tar.xz$' node-sums.txt | sha256sum -c -)
