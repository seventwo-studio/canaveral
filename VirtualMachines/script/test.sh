#!/usr/bin/env bash
set -euo pipefail
VM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$VM_ROOT"
swift test --disable-sandbox
swift build --disable-sandbox --product CanaveralVMCheck
VM_BIN="$(swift build --show-bin-path)"
codesign --force --sign - --entitlements Virtualization.entitlements "$VM_BIN/CanaveralVMCheck"
"$VM_BIN/CanaveralVMCheck"
python3 -B -m unittest discover -s GuestHelpers -p 'test_*.py'
