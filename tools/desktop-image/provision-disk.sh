#!/bin/bash
# Invoked by build.sh inside its private mount namespace.
set -euo pipefail
tmp=$(realpath "$1")
here=$2
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

install -d -m 0700 "$root/opt/desktop-build"
cp "$tmp/node.tar.xz" "$root/opt/desktop-build/node.tar.xz"
cp "$here/provision.sh" "$root/opt/desktop-build/provision.sh"

# nspawn supplies private PID, mount, /dev, /proc and /run views. Build-time
# package downloads use host networking. No checkout or host credentials bind in.
# The guest resolver may be a symlink into an unpopulated /run.
resolver=$root/etc/resolv.conf
if [[ -e $resolver || -L $resolver ]]; then mv "$resolver" "$tmp/resolv.original"; fi
install -m 0644 /etc/resolv.conf "$resolver"
systemd-nspawn --quiet --settings=no --register=no --link-journal=no \
  --directory="$root" --as-pid2 --resolv-conf=off \
  /bin/sh /opt/desktop-build/provision.sh
rm -r "$root/opt/desktop-build" "$resolver"
if [[ -e $tmp/resolv.original || -L $tmp/resolv.original ]]; then mv "$tmp/resolv.original" "$resolver"; fi

# Per-instance identity comes from first boot: cloud-init creates SSH host keys
# and the Canaveral preparation recipe installs the assignment's pinned key.
# Fail the build if the provisioning container left any shared identity behind.
if compgen -G "$root/etc/ssh/ssh_host_*" >/dev/null; then echo 'Shared SSH host keys remain in the image' >&2; exit 1; fi
[[ ! -s $root/etc/machine-id ]] || { echo 'A machine ID remains in the image' >&2; exit 1; }
[[ ! -e $root/var/lib/dbus/machine-id || -L $root/var/lib/dbus/machine-id ]] || { echo 'A D-Bus machine ID remains in the image' >&2; exit 1; }
[[ ! -e $root/home/desktop ]] || { echo 'The desktop account must be created per instance' >&2; exit 1; }
