#!/bin/bash
# Invoked by build.sh inside its private mount namespace.
set -euo pipefail
tmp=$(realpath "$1")
here=$2
repo=$3
root=$tmp/root
loop=$(losetup --find --show --partscan "$tmp/disk.raw")
cleanup() {
  local result=$?
  if mountpoint -q "$root"; then umount "$root" || result=1; fi
  losetup -d "$loop" || result=1
  exit "$result"
}
trap cleanup EXIT
udevadm settle
[[ $(blkid -s TYPE -o value "${loop}p1") == ext4 ]]
growpart "$loop" 1
udevadm settle
# e2fsck status 1 means it successfully corrected filesystem errors.
e2fsck -pf "${loop}p1" || [[ $? == 1 ]]
resize2fs "${loop}p1"
mount -t ext4 "${loop}p1" "$root"

install -d "$root/opt/worker"
cp "$here/browsers.lock" "$here"/*.mjs "$repo"/coordination/{package.json,package-lock.json,src/browser-runtime.ts,src/browser-playwright.ts} "$root/opt/worker/"
cp "$here"/{browser.service,browser-launch.socket,browser-launch@.service,canaveral.slice} "$root/etc/systemd/system/"
cp "$tmp/node.tar.xz" "$root/opt/worker/node.tar.xz"
cp "$here/gateway.conf" "$root/opt/worker/browser-gateway"
cp "$here/provision.sh" "$root/opt/worker/provision.sh"

# nspawn supplies private PID, mount, /dev, /proc and /run views. Build-time
# package downloads use host networking. No checkout or host credentials bind in.
# The guest resolver may be a symlink into an unpopulated /run.
resolver=$root/etc/resolv.conf
if [[ -e $resolver || -L $resolver ]]; then mv "$resolver" "$tmp/resolv.original"; fi
install -m 0644 /etc/resolv.conf "$resolver"
systemd-nspawn --quiet --settings=no --register=no --link-journal=no \
  --directory="$root" --as-pid2 --resolv-conf=off \
  /bin/sh /opt/worker/provision.sh
rm "$root/opt/worker/provision.sh" "$resolver"
if [[ -e $tmp/resolv.original || -L $tmp/resolv.original ]]; then mv "$tmp/resolv.original" "$resolver"; fi
