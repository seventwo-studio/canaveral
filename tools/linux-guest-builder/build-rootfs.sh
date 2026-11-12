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
export_pinned_keyring /usr/share/keyrings/debian-archive-keyring.gpg "$BUILD/inputs/debian-apt-keyring.gpg"
# apt's signature verifier may drop privileges; expose only public key bytes.
apt_keys=$(mktemp -d)
chmod 755 "$apt_keys"
mkdir "$apt_keys/empty"
cp inputs/debian-apt-keyring.gpg "$apt_keys/pinned.gpg"
chmod 644 "$apt_keys/pinned.gpg"
trap 'rm -rf "$apt_keys"' EXIT
base=https://snapshot.debian.org/archive/debian/20261101T000000Z
curl -fLS "$base/dists/bookworm/Release" -o inputs/Release
curl -fLS "$base/dists/bookworm/Release.gpg" -o inputs/Release.gpg
gpgv --keyring "$BUILD/inputs/debian-apt-keyring.gpg" --status-fd 3 inputs/Release.gpg inputs/Release 3> inputs/debian-release.status 2> debian-signature.log
require_primary_signature inputs/debian-release.status "$DEBIAN_PRIMARIES"
# Bind apt to these exact authenticated bytes, before any maintainer script runs.
curl -fLS "$base/dists/bookworm/main/binary-arm64/Packages.xz" -o inputs/debian-Packages.xz
awk '$3=="main/binary-arm64/Packages.xz" && length($1)==64 {print $1 "  inputs/debian-Packages.xz"; found=1} END {if(!found) exit 1}' inputs/Release | shasum -a256 -c -
xz -dc inputs/debian-Packages.xz > inputs/debian-Packages
node_tool="$BUILD/verification-node"
tar -xJOf inputs/node-v24.11.0-linux-arm64.tar.xz node-v24.11.0-linux-arm64/bin/node > "$node_tool"
chmod 700 "$node_tool"
rm -f mirror.port
"$node_tool" "$RECIPE_DIR/verified-mirror.mjs" "$BUILD/inputs" "$BUILD/mirror.port" &
mirror_pid=$!
trap 'kill "$mirror_pid" 2>/dev/null || true; wait "$mirror_pid" 2>/dev/null || true; rm -rf "$apt_keys"; rm -f "$node_tool" mirror.port' EXIT
for attempt in $(seq 1 100); do test ! -s mirror.port || break; kill -0 "$mirror_pid"; sleep 0.1; done
test -s mirror.port
mirror="http://127.0.0.1:$(cat mirror.port)"
mmdebstrap --mode=unshare --variant=minbase --architectures=arm64 --format=tar \
  --keyring="$apt_keys/pinned.gpg" --keyring="$apt_keys/empty" \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --include=bash,coreutils,git,ca-certificates,e2fsprogs,netcat-openbsd \
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
  --customize-hook="copy-out /tmp/probe-mkfsExt4.txt $BUILD" \
  --customize-hook='rm -f "$1/tmp/node-v24.11.0-linux-arm64.tar.xz" "$1/tmp/rootfs-customize.sh" "$1/tmp/packages.txt" "$1/tmp/probe-shell.txt" "$1/tmp/probe-git.txt" "$1/tmp/probe-node.txt" "$1/tmp/probe-mkfsExt4.txt"' \
  --customize-hook='printf "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261101T000000Z bookworm main\n" > "$1/etc/apt/sources.list"' \
  bookworm rootfs.tar "deb [check-valid-until=no signed-by=$apt_keys/pinned.gpg] $mirror bookworm main"
mkfs.erofs --quiet -T "$SOURCE_DATE_EPOCH" -U 3414215f-8063-4db0-9b6d-092dad50bd8b --tar=f rootfs.erofs < rootfs.tar
fsck.erofs rootfs.erofs
