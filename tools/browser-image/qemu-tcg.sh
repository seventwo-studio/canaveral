#!/bin/bash
# Ubuntu's ARM64 libguestfs selects host CPU and GIC even without /dev/kvm.
set -eu
args=("$@")
for index in "${!args[@]}"; do
  case "${args[index]}" in
    virt,*accel=kvm:tcg*)
      args[index]=${args[index]/accel=kvm:tcg/accel=tcg}
      args[index]=${args[index]/gic-version=host/gic-version=3}
      ;;
    host)
      if (( index > 0 )) && [[ ${args[index-1]} == -cpu ]]; then args[index]=max; fi
      ;;
  esac
done
exec /usr/bin/qemu-system-aarch64 "${args[@]}"
