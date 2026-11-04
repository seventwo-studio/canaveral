#!/usr/bin/env bash
set -euo pipefail
VM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$VM_ROOT"
MODE="${1:-run}"
case "$MODE" in run|--build-only|--verify) ;; *) echo "Usage: $0 [--build-only|--verify]" >&2; exit 2 ;; esac
VM_SIGNING_IDENTITY="${CANAVERAL_SIGNING_IDENTITY:-}"
if [[ -z "$VM_SIGNING_IDENTITY" ]]; then
  VM_IDENTITIES=()
  while IFS= read -r fingerprint; do [[ -n "$fingerprint" ]] && VM_IDENTITIES+=("$fingerprint"); done < <(/usr/bin/security find-identity -v -p codesigning | /usr/bin/awk '/"Apple Development:/ { print $2 }')
  [[ "${#VM_IDENTITIES[@]}" == 1 ]] || { echo "Set CANAVERAL_SIGNING_IDENTITY to a stable Apple Development identity." >&2; exit 1; }
  VM_SIGNING_IDENTITY="${VM_IDENTITIES[0]}"
fi
[[ "$VM_SIGNING_IDENTITY" != "-" ]] || { echo "Stable signing is required for guest permissions and Keychain." >&2; exit 1; }
swift build --disable-sandbox
VM_BIN="$(swift build --show-bin-path)"
VM_MANAGER="$VM_ROOT/dist/Canaveral Machines.app"
mkdir -p "$VM_MANAGER/Contents/Helpers"
for product in CanaveralMachineHost CanaveralGuest CanaveralMachinesApp; do
  case "$product" in
    CanaveralMachineHost) bundle="$VM_MANAGER/Contents/Helpers/CanaveralMachineHost.app"; identifier=app.canaveral.machine-host; ui=true ;;
    CanaveralGuest) bundle="$VM_ROOT/dist/Canaveral Guest.app"; identifier=app.canaveral.guest; ui=true ;;
    *) bundle="$VM_MANAGER"; identifier=app.canaveral.machines; ui=false ;;
  esac
  mkdir -p "$bundle/Contents/MacOS"
  cp "$VM_BIN/$product" "$bundle/Contents/MacOS/$product"
  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>$product</string>
<key>CFBundleIdentifier</key><string>$identifier</string>
<key>CFBundleName</key><string>$product</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><$ui/>
<key>NSScreenCaptureUsageDescription</key><string>View this virtual guest desktop.</string>
</dict></plist>
PLIST
  /usr/bin/codesign --force --sign "$VM_SIGNING_IDENTITY" --timestamp=none --entitlements Virtualization.entitlements "$bundle"
done
/usr/bin/codesign --verify --deep --strict "$VM_MANAGER"
if [[ "$MODE" != "--build-only" ]]; then /usr/bin/open "$VM_MANAGER"; fi
if [[ "$MODE" == "--verify" ]]; then sleep 2; pgrep -x CanaveralMachinesApp >/dev/null; fi
