#!/usr/bin/env bash
# Collect host-side libvirt, QEMU and AppArmor evidence after the cluster
# acceptance run. It runs on the disposable runner, never on a real node.
# Every collector is best effort; output is redacted of token-shaped strings.
set -uo pipefail
umask 077
out=${1:?usage: diagnostics.sh <output-directory>}
mkdir -p "$out"

redact() { sed -E 's/[A-Za-z0-9_-]{43,}/[redacted]/g'; }
# collect <file> <command...>: record the command, its output and its exit status.
collect() {
  local file=$1; shift
  { printf '$ %s\n' "$*"; "$@" 2>&1; printf '[exit %s]\n' "$?"; } | redact > "$out/$file"
}
here=$(dirname -- "${BASH_SOURCE[0]}")

collect host.txt bash -c 'uname -a; cat /etc/os-release; id libvirt-qemu; id canaverald; getent group canaveral-vm canaveral-libvirt kvm; ls -l /dev/kvm; nproc; free -m'
collect packages.txt bash -c 'dpkg-query -W libvirt-daemon-system libvirt-daemon-driver-qemu qemu-system-x86 ovmf apparmor 2>&1'
collect units.txt bash -c 'systemctl --no-pager status libvirtd.service libvirtd.socket virtqemud.service virtqemud.socket virtlogd.service 2>&1 | head -n 120'
collect libvirt-config.txt sudo bash -c 'grep -Ev "^[[:space:]]*(#|$)" /etc/libvirt/qemu.conf /etc/libvirt/libvirtd.conf; ls -l /etc/systemd/system/libvirtd.socket.d; ls -l /run/libvirt/libvirt-sock'
collect firmware.txt bash -c 'ls -l /usr/share/qemu/firmware /usr/share/OVMF; sudo ls -l /var/lib/libvirt/qemu/nvram'
collect networks.txt bash -c 'sudo virsh --connect qemu:///system net-list --all; sudo virsh --connect qemu:///system net-dumpxml default'
collect storage.txt sudo bash -c 'find /var/lib/libvirt/images/canaveral -maxdepth 2 -printf "%M %u:%g %s %p\n"; for disk in /var/lib/libvirt/images/canaveral/*/disk.qcow2; do [[ -f "$disk" ]] && qemu-img info --force-share "$disk"; done'
# The daemon journals record each administrative phase; only the phase is copied.
collect daemon-phases.txt sudo bash -c 'find /var/lib/canaverald /var/lib/canaverald-cpu-acceptance -name "libvirt-*.json" 2>/dev/null | while read -r file; do printf "%s phase=%s\n" "$file" "$(jq -r ".phase // \"(none)\"" "$file")"; done'
collect domains.txt bash -c 'sudo virsh --connect qemu:///system list --all --uuid --name'

for domain in $(sudo virsh --connect qemu:///system list --all --name 2>/dev/null | grep '^cvm-'); do
  collect "$domain.state.txt" sudo virsh --connect qemu:///system domstate --reason "$domain"
  collect "$domain.dominfo.txt" sudo virsh --connect qemu:///system dominfo "$domain"
  collect "$domain.xml" sudo virsh --connect qemu:///system dumpxml "$domain"
  collect "$domain.inactive.xml" sudo virsh --connect qemu:///system dumpxml --inactive "$domain"
  collect "$domain.qemu.log" sudo cat "/var/log/libvirt/qemu/$domain.log"
done
collect apparmor-profiles.txt sudo bash -c 'aa-status 2>&1 | grep -E "libvirt|containerd|profiles are"; ls -l /etc/apparmor.d/libvirt; for f in /etc/apparmor.d/libvirt/libvirt-*.files; do [[ -f "$f" ]] && { echo "== $f"; cat "$f"; }; done'
collect apparmor-denials.txt sudo journalctl -k --no-pager -o short-precise --grep 'apparmor="DENIED"'
collect libvirtd.journal.txt sudo journalctl --no-pager -o short-precise -u libvirtd.service -u libvirtd.socket -u virtqemud.service -u virtlogd.service
collect dmesg.txt bash -c 'sudo dmesg --ctime | tail -n 300'
# Replays the daemon's pre-start checks inside the pod; the daemon itself logs no refusal reason.
collect daemon-probe.json bash -c "kubectl -n canaverald exec -i daemonset/canaverald -- node --input-type=module - < '$here/libvirt-probe.mjs'"
collect canaverald-pods.txt kubectl -n canaverald get pods -o wide
collect canaverald.log bash -c 'for pod in $(kubectl -n canaverald get pods -o name); do echo "== $pod"; kubectl -n canaverald logs "$pod" --all-containers --tail=400; kubectl -n canaverald logs "$pod" --all-containers --previous --tail=200 2>/dev/null; done'
exit 0
