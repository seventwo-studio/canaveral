#!/bin/sh
# Installs the assigned guest helper inside a macOS guest that is being prepared as
# a Canaveral desktop image. Run from the extracted bundle directory:
#   sudo sh install-guest.sh
# It installs only the helper app and its LaunchAgent. It adds no account, key,
# credential or network service; each VM's credential arrives on its launch media.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH
here=$(cd "$(dirname "$0")" && pwd)
app="Canaveral Assigned Guest.app"
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
# The manual helper keeps a reusable credential in the login Keychain; a clone would copy it.
if [ -e "/Applications/Canaveral Guest.app" ]; then
  echo "Remove /Applications/Canaveral Guest.app and its Keychain item before preparing an image." >&2; exit 1
fi
codesign --verify --strict "$here/$app"
rm -rf "/Applications/$app"
ditto "$here/$app" "/Applications/$app"
xattr -dr com.apple.quarantine "/Applications/$app" 2>/dev/null || true
chown -R root:wheel "/Applications/$app"
chmod -R go-w "/Applications/$app"
install -m 0644 -o root -g wheel "$here/app.canaveral.assigned-guest.plist" /Library/LaunchAgents/app.canaveral.assigned-guest.plist
plutil -lint /Library/LaunchAgents/app.canaveral.assigned-guest.plist >/dev/null
echo "Installed /Applications/$app and its LaunchAgent."
echo "Next: allow Screen Recording and Accessibility for Canaveral Assigned Guest, enable automatic login,"
echo "then run: sudo sh check-image.sh"
