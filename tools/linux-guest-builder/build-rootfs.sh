#!/bin/bash
# Linux arm64; mmdebstrap uses an unprivileged user namespace, never host sudo.
set -euo pipefail
: "${BUILD:?absolute build directory required}"
RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$RECIPE_DIR/signature-policy.sh"
cd "$BUILD"
INPUTS="$BUILD/inputs" bash "$RECIPE_DIR/verify-source-inputs.sh"
export SOURCE_DATE_EPOCH=1793491200 LC_ALL=C TZ=UTC
mkdir -p inputs/debs
cp /usr/share/keyrings/debian-archive-keyring.gpg inputs/debian-archive-keyring.gpg
base=https://snapshot.debian.org/archive/debian/20261101T000000Z
curl -fLS "$base/dists/bookworm/Release" -o inputs/Release
curl -fLS "$base/dists/bookworm/Release.gpg" -o inputs/Release.gpg
gpgv --keyring "$BUILD/inputs/debian-archive-keyring.gpg" --status-fd 3 inputs/Release.gpg inputs/Release 3> inputs/debian-release.status 2> debian-signature.log
require_primary_signature inputs/debian-release.status "$DEBIAN_PRIMARIES"
# apt independently validates Release -> Packages -> each .deb digest.
mmdebstrap --mode=unshare --variant=minbase --architectures=arm64 --format=tar \
  --keyring="$BUILD/inputs/debian-archive-keyring.gpg" \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --include=bash,coreutils,git,ca-certificates \
  --skip=essential/unlink --customize-hook='copy-out /var/cache/apt/archives '"$BUILD/inputs/debs" \
  --customize-hook="copy-in $BUILD/inputs/node-v24.11.0-linux-arm64.tar.xz /tmp/" \
  --customize-hook="copy-in $BUILD/repo/target/aarch64-unknown-linux-musl/release/canaveral-guest-agent /sbin/" \
  --customize-hook="copy-in $BUILD/recipe/rootfs-customize.sh /tmp/" \
  --customize-hook='mkdir -p "$1/usr/local"; tar -xJf "$1/tmp/node-v24.11.0-linux-arm64.tar.xz" -C "$1/usr/local" --strip-components=1' \
  --customize-hook='chroot "$1" /bin/sh /tmp/rootfs-customize.sh' \
  --customize-hook="copy-out /tmp/packages.txt $BUILD" \
  --customize-hook="copy-out /tmp/probe-shell.txt $BUILD" \
  --customize-hook="copy-out /tmp/probe-git.txt $BUILD" \
  --customize-hook="copy-out /tmp/probe-node.txt $BUILD" \
  --customize-hook='rm -f "$1/tmp/node-v24.11.0-linux-arm64.tar.xz" "$1/tmp/rootfs-customize.sh" "$1/tmp/packages.txt" "$1/tmp/probe-shell.txt" "$1/tmp/probe-git.txt" "$1/tmp/probe-node.txt"' \
  bookworm rootfs.tar "deb [check-valid-until=no] $base bookworm main"
mkfs.erofs --quiet -T "$SOURCE_DATE_EPOCH" -U 3414215f-8063-4db0-9b6d-092dad50bd8b --tar=f rootfs.erofs < rootfs.tar
fsck.erofs rootfs.erofs
