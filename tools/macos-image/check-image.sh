#!/bin/sh
# Final identity check for a macOS desktop image. Run inside the prepared guest
# immediately before shutting it down for export:
#   sudo sh check-image.sh
# It fails when the image would give every clone a shared credential, key or
# leftover launch state, or when the helper would not start in a desktop session.
# CANAVERAL_CHECK_ROOT and CANAVERAL_CHECK_PATH exist only for portable tests.
set -u
PATH="${CANAVERAL_CHECK_PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"; export PATH
root="${CANAVERAL_CHECK_ROOT:-}"
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
app="$root/Applications/Canaveral Assigned Guest.app"
helper="/Applications/Canaveral Assigned Guest.app/Contents/MacOS/CanaveralAssignedGuest"
agent="$root/Library/LaunchAgents/app.canaveral.assigned-guest.plist"

# The assigned helper must be installed and start in the logged-in session.
[ -x "$root$helper" ] || fail "The assigned guest helper is not installed in /Applications."
codesign --verify --strict "$app" >/dev/null 2>&1 || fail "The assigned guest helper's signature does not verify."
if [ ! -f "$agent" ] || ! grep -Fq "<string>$helper</string>" "$agent"; then fail "The assigned guest LaunchAgent is missing or starts another program."; fi

# The manual helper stores a reusable credential in the login Keychain.
[ ! -e "$root/Applications/Canaveral Guest.app" ] || fail "The manual Canaveral Guest app is installed."
for plist in "$root"/Library/LaunchAgents/*.plist "$root"/Library/LaunchDaemons/*.plist "$root"/Users/*/Library/LaunchAgents/*.plist; do
  [ -f "$plist" ] || continue
  if grep -Fq "Canaveral Guest.app" "$plist"; then fail "$plist starts the manual Canaveral Guest app."; fi
done

for home in "$root"/Users/*; do
  [ -d "$home" ] || continue
  case "$(basename "$home")" in Shared|Guest) continue ;; esac
  state="$home/Library/Application Support/Canaveral Guest"
  # Launch markers and journals belong to one launch only. A boot during preparation
  # leaves only the empty service lock, which carries no identity.
  if [ -d "$state" ] && [ -n "$(ls -A "$state" 2>/dev/null | grep -vx guest-helper.lock)" ]; then fail "$state holds helper state from an earlier launch."; fi
  if [ -e "$home/.ssh/authorized_keys" ] || [ -e "$home/.ssh/authorized_keys2" ]; then fail "$home/.ssh grants key login."; fi
  keychain="$home/Library/Keychains/login.keychain-db"
  if [ -f "$keychain" ] && security find-generic-password -s app.canaveral.guest "$keychain" >/dev/null 2>&1; then fail "$keychain holds the manual helper credential."; fi
done
if [ -n "$(ls -A "$root/private/var/root/.ssh" 2>/dev/null)" ]; then fail "/var/root/.ssh is not empty."; fi
for key in "$root"/private/etc/ssh/ssh_host_*; do
  [ -e "$key" ] && fail "SSH host keys exist; every clone would share them." && break
done

# Remote services would turn the shared auto-login password into a network credential.
if disabled=$(launchctl print-disabled system 2>/dev/null); then
  for service in com.openssh.sshd com.apple.screensharing; do
    printf '%s\n' "$disabled" | grep -Eq "\"$service\" => (disabled|true)" || fail "$service is not disabled."
  done
else fail "Cannot read disabled system services."; fi
if [ -f "$root/private/etc/RemoteManagement.launchd" ] && grep -q enabled "$root/private/etc/RemoteManagement.launchd"; then fail "Remote Management is enabled."; fi

# The helper runs in the desktop session, which must start without a password prompt.
fdesetup status 2>/dev/null | grep -q "FileVault is Off" || fail "FileVault must be off for automatic login."
user=$(defaults read "$root/Library/Preferences/com.apple.loginwindow" autoLoginUser 2>/dev/null) || user=""
[ -n "$user" ] || fail "Automatic login is not enabled."
[ -f "$root/private/var/db/.AppleSetupDone" ] || fail "Setup Assistant has not finished."

if [ "$failures" -gt 0 ]; then echo "Image identity check failed ($failures)." >&2; exit 1; fi
echo "Image identity check passed for automatic login user $user."
