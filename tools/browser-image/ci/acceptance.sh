#!/bin/bash
# Run as root on the disposable ARM64 CI runner.
set -euo pipefail
umask 077
base=$(realpath "${1:?expected built qcow2}")
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
guest=
cleanup() {
  if [[ -n $guest ]]; then
    kill "$guest" 2>/dev/null || true
    wait "$guest" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
cd "$work"
qemu-img create -q -f qcow2 -F qcow2 -b "$base" disk
cp /usr/share/AAVMF/AAVMF_VARS.fd vars.fd
export LIBGUESTFS_BACKEND=direct
accel=(-accel tcg -cpu max)
if [[ -c /dev/kvm ]]; then
  accel=(-accel kvm -cpu host)
else
  export LIBGUESTFS_HV="$here/../qemu-tcg.sh"
fi
virt-customize --no-network -a disk --mkdir /root/trial \
  --upload "$here/guest.sh:/root/trial/guest.sh" \
  --upload "$here/session.mjs:/opt/worker/trial.mjs" \
  --upload "$here/../verify-isolation.sh:/root/trial/isolation.sh" \
  --upload "$here/trial.service:/etc/systemd/system/trial.service" \
  --link /etc/systemd/system/trial.service:/etc/systemd/system/multi-user.target.wants/trial.service

timeout --kill-after=15s 25m qemu-system-aarch64 -machine virt "${accel[@]}" -smp 2 -m 4096 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.fd \
  -drive if=pflash,format=raw,file=vars.fd -drive if=virtio,format=qcow2,file=disk \
  -nic none -display none -serial none -monitor none -no-reboot &
guest=$!
guest_status=0
wait "$guest" || guest_status=$?
guest=
# The guest writes the marker only after both browser lifecycles pass.
stage=$(virt-cat -a disk /root/trial/result) || stage=unknown
if (( guest_status != 0 )); then
  case "$stage" in credentials|startup|session|isolation|passed) ;; *) stage=unknown ;; esac
  echo "Browser guest exited with status $guest_status during $stage" >&2
  exit "$guest_status"
fi
case "$stage" in
  passed) ;;
  credentials|startup|session|isolation) echo "Guest failed during $stage" >&2; exit 1 ;;
  *) echo "Missing guest acceptance receipt" >&2; exit 1 ;;
esac
virt-cat -a disk /root/trial/page.png > page.png
test "$(identify -format '%m %wx%h' page.png)" = 'PNG 96x64'
convert -size 48x64 xc:'#135389' xc:'#e7a729' +append -depth 8 rgb:expected.rgb
convert page.png -depth 8 rgb:actual.rgb
cmp expected.rgb actual.rgb
