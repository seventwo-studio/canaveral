#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/VirtualMachines"
VM_SIGNING_IDENTITY="${CANAVERAL_SIGNING_IDENTITY:-}"
if [[ -z "$VM_SIGNING_IDENTITY" ]]; then
  VM_IDENTITIES=()
  while IFS= read -r fingerprint; do [[ -n "$fingerprint" ]] && VM_IDENTITIES+=("$fingerprint"); done < <(/usr/bin/security find-identity -v -p codesigning | /usr/bin/awk '/"Apple Development:/ { print $2 }')
  [[ "${#VM_IDENTITIES[@]}" == 1 ]] || { echo "Set CANAVERAL_SIGNING_IDENTITY to a stable Apple Development identity." >&2; exit 1; }
  VM_SIGNING_IDENTITY="${VM_IDENTITIES[0]}"
fi
[[ "$VM_SIGNING_IDENTITY" != "-" ]] || { echo "Stable signing is required." >&2; exit 1; }
swift build --disable-sandbox --product CanaveralVMRunner
VM_BIN="$(swift build --show-bin-path)"
mkdir -p "$ROOT_DIR/dist"
cp "$VM_BIN/CanaveralVMRunner" "$ROOT_DIR/dist/CanaveralVMRunner"
codesign --force --sign "$VM_SIGNING_IDENTITY" --timestamp=none --identifier app.canaveral.vm-runner --entitlements Virtualization.entitlements "$ROOT_DIR/dist/CanaveralVMRunner"
codesign --verify --strict "$ROOT_DIR/dist/CanaveralVMRunner"
echo "Built $ROOT_DIR/dist/CanaveralVMRunner"
