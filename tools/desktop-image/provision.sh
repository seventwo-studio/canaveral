#!/bin/sh
# Runs inside the build container. Installs a credential-free XFCE/TigerVNC base;
# each VM's account, SSH keys and guest token come from its own preparation seed.
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive
# Use the same signed Debian archive snapshot on every build. Guest preparation
# runs apt-get against it again, so its package list resolves to these versions.
rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list
echo 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261002T000000Z/ trixie main' >/etc/apt/sources.list
policy=/usr/sbin/policy-rc.d
if [ -e "$policy" ] || [ -L "$policy" ]; then mv "$policy" "$policy.desktop-build"; fi
printf '#!/bin/sh\nexit 101\n' > "$policy"
chmod 0755 "$policy"
apt-get update
# Exactly the desktop preparation profile in coordination/src/guest/access.ts,
# installed with recommends as its first-boot apt-get install would.
apt-get install -y curl openssh-server xfce4 xfce4-terminal tigervnc-standalone-server dbus-x11 at-spi2-core x11-utils scrot xz-utils
tar xJf /opt/desktop-build/node.tar.xz --strip-components=1 -C /usr/local
rm /opt/desktop-build/node.tar.xz
/usr/local/bin/node -e 'if (parseInt(process.versions.node, 10) < 24) process.exit(1)'
for binary in /usr/bin/Xtigervnc /usr/bin/xfce4-session /usr/bin/xfce4-terminal /usr/bin/xdpyinfo /usr/bin/dbus-run-session /usr/bin/scrot /usr/sbin/sshd /usr/bin/cloud-init; do
  [ -x "$binary" ] || { echo "Missing desktop binary: $binary" >&2; exit 1; }
done
ls /usr/lib/*/libatspi.so.0 >/dev/null
# Smoke-start the same X server the guest service uses, on a private display.
/usr/bin/Xtigervnc :9 -geometry 1440x900 -depth 24 -SecurityTypes None -localhost yes &
server=$!
ready=false
for attempt in $(seq 1 50); do
  if xdpyinfo -display :9 >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
kill "$server" 2>/dev/null || true; wait "$server" || true
rm -rf /tmp/.X11-unix /tmp/.X9-lock
[ "$ready" = true ] || { echo "Xtigervnc did not start" >&2; exit 1; }
# The guest service starts its own Xvnc session; no display manager or console login.
if [ -e /etc/systemd/system/display-manager.service ]; then rm /etc/systemd/system/display-manager.service; fi
systemctl set-default multi-user.target
# Keep the snapshot indexes: preparation re-runs apt-get update against the same
# snapshot, and already-installed packages make its install a no-op.
apt-get clean
rm "$policy"
if [ -e "$policy.desktop-build" ] || [ -L "$policy.desktop-build" ]; then mv "$policy.desktop-build" "$policy"; fi
# Shared identities would let one instance impersonate another.
rm -f /etc/ssh/ssh_host_*
: > /etc/machine-id
if [ -f /var/lib/dbus/machine-id ] && [ ! -L /var/lib/dbus/machine-id ]; then rm /var/lib/dbus/machine-id; fi
