#!/usr/bin/env bash
set -euo pipefail
source fixtures/host-runtimes/evidence.sh

work=$(mktemp -d)
host_config="$work/host.json"
daemon=$PWD/coordination/dist/src/canaverald.js
cat > "$host_config" <<'JSON'
{"name":"host-acceptance","provider":"native","templates":[],"capacity":{"cpu":1,"memoryMiB":1024,"diskGiB":1},"runtimes":{"libvirt":{"uri":"qemu:///session"}}}
JSON

if [[ "$RUNNER_OS" == Linux ]]; then
  begin "Install libvirt and host QEMU"
  case "$(uname -m)" in
    x86_64) emulator=qemu-system-x86 ;;
    aarch64) emulator=qemu-system-arm ;;
    *) exit 1 ;;
  esac
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    "$emulator" qemu-utils libvirt-clients libvirt-daemon-system libvirt-daemon-driver-qemu
  update_evidence --arg version "$(virsh --version)" '.packageVersion = $version'
  echo "::endgroup::"

  begin "Check KVM device and prepare runner access"
  kvm=false
  if [[ -c /dev/kvm ]]; then
    kvm=true
    printf 'KERNEL=="kvm", OWNER="%s", GROUP="kvm", MODE="0660"\n' "$(id -un)" |
      sudo tee /etc/udev/rules.d/99-canaveral-kvm.rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger --name-match=/dev/kvm --action=change --settle
    test -r /dev/kvm
    test -w /dev/kvm
  fi
  update_evidence --argjson device "$kvm" '.kvmDevicePresent = $device'
  echo "::endgroup::"

  begin "Check libvirt registry detection"
  test "$(id -u)" -ne 0
  "$daemon" runtimes status --config "$host_config" --state "$work/state" --json | tee "$work/registry.json"
  update_evidence --slurpfile registry "$work/registry.json" \
    '.registryStatus = ($registry[0][] | select(.id == "libvirt"))'
  if [[ "$kvm" == true ]]; then
    if ! jq -e 'any(.[]; .id == "libvirt" and .state == "verified" and .qualified == false)' "$work/registry.json"; then
      virsh --connect qemu:///session domcapabilities --virttype kvm
      exit 1
    fi
  else
    jq -e 'any(.[]; .id == "libvirt" and .state == "installed" and .blocker.code == "libvirt_kvm_missing")' \
      "$work/registry.json"
  fi
  echo "::endgroup::"
else
  begin "Check Apple Virtualization registry detection"
  test "$(uname -m)" = arm64
  test "$(id -u)" -ne 0
  release=$(/usr/bin/sw_vers -productVersion)
  "$daemon" runtimes status --config "$host_config" --state "$work/state" --json | tee "$work/registry.json"
  update_evidence --slurpfile registry "$work/registry.json" --arg release "$release" \
    '.registryStatus = ($registry[0][] | select(.id == "apple-virtualization")) | .macOSVersion = $release'
  case "$release" in
    15.*) code=apple_os_unsupported; state=unavailable ;;
    26.*) code=apple_runner_missing; state=absent ;;
    *) echo "Unexpected macOS release $release" >&2; exit 1 ;;
  esac
  jq -e --arg code "$code" --arg state "$state" \
    'any(.[]; .id == "apple-virtualization" and .state == $state and .blocker.code == $code and .qualified == false)' \
    "$work/registry.json"
  echo "::endgroup::"

  if [[ "$release" == 26.* ]]; then
    begin "Observe Virtualization framework support"
    # Observe the framework directly. The registry still requires its signed runner.
    supported=$(swift "$(dirname "$0")/vz-supported.swift")
    echo "VZVirtualMachine.isSupported=$supported"
    update_evidence --arg supported "$supported" '.frameworkSupport = $supported'
    [[ "$supported" == true || "$supported" == false ]]
    echo "::endgroup::"
  fi
fi
