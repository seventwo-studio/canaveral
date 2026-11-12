#!/bin/sh
# Invoked inside mmdebstrap's chroot, with no host paths or credentials.
set -eu
export LC_ALL=C TZ=UTC
dpkg-query -W -f='${Package}=${Version}:${Architecture}\n' > /tmp/packages.txt
mkdir -p /usr/local /sbin /proc /sys /dev /tmp /run /workspace /etc/canaveral
chmod 700 /etc/canaveral
chown 1000:1000 /workspace
chmod 755 /workspace
/bin/sh -c 'printf "canaveral-shell-v1\n"' > /tmp/probe-shell.txt
/usr/bin/git --version > /tmp/probe-git.txt
/usr/local/bin/node --version > /tmp/probe-node.txt
rm -f /etc/machine-id
rm -rf /var/log/* /var/cache/apt/archives/*
test ! -e /etc/canaveral/launch.json
printf 'canaveral\n' > /etc/hostname
printf '127.0.0.1 localhost\n::1 localhost\n' > /etc/hosts
: > /etc/resolv.conf
