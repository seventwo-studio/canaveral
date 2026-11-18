#!/bin/bash
set -euo pipefail
out=${1:?usage: build.sh OUTPUT.qcow2}
[[ ! -e "$out" && $(uname -sm) == 'Linux aarch64' ]] || { echo 'Requires ARM64 Linux and a new output path' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Requires root on a disposable runner' >&2; exit 1; }
for tool in qemu-img curl sha512sum sha256sum losetup growpart sfdisk udevadm e2fsck resize2fs unshare systemd-nspawn mount umount blkid; do
  command -v "$tool" >/dev/null || { echo "Missing build tool: $tool" >&2; exit 1; }
done
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
tmp=$(mktemp -d "$(dirname "$out")/.browser-image.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
base=debian-13-genericcloud-arm64-20261001-2618.qcow2
curl -fLsS "https://cloud.debian.org/images/cloud/trixie/20261001-2618/$base" -o "$tmp/base"
echo "d8470b8c6c38fead046c794b5800a5a7b96672d5bcf543cc230ceb0c4b8ace05ed341a0c8928045422243fde26b2f1f2f58e99244c65709ffda2e3d4b674dd5a  $tmp/base" | sha512sum -c -
curl -fLsS https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-arm64.tar.xz -o "$tmp/node.tar.xz"
echo "33a6673b2c7bffeae9deec7f9f8b31aad9119b08f13d49b2ca3ee3bebfe8260f  $tmp/node.tar.xz" | sha256sum -c -
qemu-img convert -f qcow2 -O raw "$tmp/base" "$tmp/disk.raw"
truncate -s 16G "$tmp/disk.raw"
mkdir "$tmp/root"
unshare --mount --propagation private bash "$here/provision-disk.sh" "$tmp" "$here" "$repo"
qemu-img convert -f raw -O qcow2 "$tmp/disk.raw" "$tmp/disk"
qemu-img check "$tmp/disk"
ln "$tmp/disk" "$out"
sha256sum "$out"
