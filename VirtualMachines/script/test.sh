#!/usr/bin/env bash
set -euo pipefail
VM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Unit tests and portable Rust guest recovery fixtures do not start a VM or sign
# artifacts. Native framework acceptance is an explicitly selected operator task.
swift test --package-path "$VM_ROOT" --disable-sandbox
cargo test --manifest-path "$VM_ROOT/../Cargo.toml" -p canaveral-guest-agent -p canaveral-guest-protocol --locked -j 2
if [[ "${1:-}" == "--native-acceptance" ]]; then
  swift build --package-path "$VM_ROOT" --disable-sandbox --product CanaveralVMCheck
  VM_BIN="$(swift build --package-path "$VM_ROOT" --show-bin-path)"
  codesign --force --sign - --entitlements "$VM_ROOT/Virtualization.entitlements" "$VM_BIN/CanaveralVMCheck"
  "$VM_BIN/CanaveralVMCheck"
elif [[ "$#" != 0 ]]; then
  echo "Usage: $0 [--native-acceptance]" >&2
  exit 2
fi
