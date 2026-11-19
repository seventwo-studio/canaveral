#!/usr/bin/env bash
# Builds the macOS guest bundle on an Apple-silicon Mac:
#   CANAVERAL_SIGNING_IDENTITY=<identity> bash tools/macos-image/build-guest-app.sh OUTPUT_DIR
# Screen Recording and Accessibility grants follow the app's signature, so images
# need a stable identity. --adhoc builds an ad-hoc signed bundle for packaging checks.
set -euo pipefail
adhoc=false
if [[ "${1:-}" == "--adhoc" ]]; then adhoc=true; shift; fi
[[ $# == 1 ]] || { echo "Usage: $0 [--adhoc] OUTPUT_DIR" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/tools/macos-image"
identity="${CANAVERAL_SIGNING_IDENTITY:-}"
if $adhoc; then identity=-; elif [[ -z "$identity" || "$identity" == - ]]; then
  echo "Set CANAVERAL_SIGNING_IDENTITY to a stable signing identity, or pass --adhoc for a packaging check." >&2; exit 1
fi
configuration="${CANAVERAL_SWIFT_CONFIGURATION:-release}"
swift build --package-path "$root/VirtualMachines" --disable-sandbox -c "$configuration" --product CanaveralAssignedGuest
bin="$(swift build --package-path "$root/VirtualMachines" -c "$configuration" --show-bin-path)"
mkdir -p "$1"; out="$(cd "$1" && pwd)"
bundle="$out/canaveral-assigned-guest"
rm -rf "$bundle"; mkdir -p "$bundle"
app="$bundle/Canaveral Assigned Guest.app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/CanaveralAssignedGuest" "$app/Contents/MacOS/CanaveralAssignedGuest"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CanaveralAssignedGuest</string>
<key>CFBundleIdentifier</key><string>app.canaveral.assigned-guest</string>
<key>CFBundleName</key><string>Canaveral Assigned Guest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Show this virtual desktop in the Canaveral viewer.</string>
</dict></plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null
codesign --force --sign "$identity" --timestamp=none "$app"
codesign --verify --strict "$app"
cp "$here/app.canaveral.assigned-guest.plist" "$here/install-guest.sh" "$here/check-image.sh" "$bundle/"
plutil -lint "$bundle/app.canaveral.assigned-guest.plist" >/dev/null
archive="$out/canaveral-assigned-guest-macos-arm64.tar.gz"
tar -C "$out" -czf "$archive" canaveral-assigned-guest
(cd "$out" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
cat "$archive.sha256"
