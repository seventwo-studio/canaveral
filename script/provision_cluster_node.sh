#!/usr/bin/env bash
# Prepare a selected Linux node for canaverald. Run as root on that node.
#
#   provision_cluster_node.sh [token] < per-node-token    Write a new setup token.
#   provision_cluster_node.sh replace-token < new-token   Atomically replace an unclaimed token.
#   provision_cluster_node.sh libvirt-host                 Apply the VM-node host libvirt setup.
#
# docs/cluster-hosts.md lists every change these commands make.
set -euo pipefail
umask 077

state=/var/lib/canaverald
daemon_uid=10001
daemon_gid=10001
daemon_user=canaverald
vm_group=canaveral-vm
vm_gid=${CANAVERAL_VM_GID:-10002}
socket_group=canaveral-libvirt
socket_gid=${CANAVERAL_LIBVIRT_SOCKET_GID:-10003}
storage=${CANAVERAL_VM_STORAGE:-/var/lib/libvirt/images/canaveral}
socket=/run/libvirt/libvirt-sock
socket_dropin=/etc/systemd/system/libvirtd.socket.d/canaveral.conf
polkit_rule=/etc/polkit-1/rules.d/60-canaveral-libvirt.rules

fail() { printf 'provision_cluster_node: %s\n' "$*" >&2; exit 1; }
usage() { fail "usage: $0 [token|replace-token|libvirt-host] (tokens are read on stdin)"; }

[[ "$(id -u)" == 0 ]] || fail "Run as root on the selected node."
mode=${1:-token}
[[ $# -le 1 ]] || usage

read_token() {
  [[ ! -t 0 ]] || fail "Provide the setup token on stdin, for example: < /protected/per-node-token."
  token=$(head -c 512)
  token=${token%$'\n'}
  [[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail "The setup token on stdin is malformed; expected 43-128 URL-safe base64 characters and one optional newline."
}

prepare_state() {
  if [[ ! -e "$state" && ! -L "$state" ]]; then
    mkdir -m 0700 -- "$state" || fail "Could not create $state."
    chown "$daemon_uid:$daemon_gid" -- "$state" || fail "Could not assign $state to $daemon_uid:$daemon_gid."
  fi
  [[ ! -L "$state" ]] || fail "$state is a symbolic link; replace it with a real directory."
  [[ -d "$state" ]] || fail "$state exists but is not a directory."
  local actual
  actual=$(stat -c '%u:%g:%a' -- "$state")
  [[ "$actual" == "$daemon_uid:$daemon_gid:700" ]] ||
    fail "$state is $actual (uid:gid:mode); expected $daemon_uid:$daemon_gid:700. Fix ownership and mode before provisioning."
}

# The token is written by the daemon UID so root never creates files the daemon must trust.
write_token() {
  local replace=$1
  if [[ "$replace" == 1 ]] && pgrep -u "$daemon_uid" -f canaverald >/dev/null; then
    fail "A canaverald process is running on this node. Remove the node label or delete the pod before replacing its token."
  fi
  # shellcheck disable=SC2016 # Expand paths in the unprivileged process.
  printf '%s\n' "$token" | setpriv --reuid "$daemon_uid" --regid "$daemon_gid" --clear-groups \
    env REPLACE="$replace" STATE="$state" EXPECTED="$daemon_uid:$daemon_gid" bash -euc '
    umask 077
    fail() { printf "provision_cluster_node: %s\n" "$*" >&2; exit 1; }
    bootstrap="$STATE/bootstrap"
    target="$bootstrap/enrollment-token"
    [[ ! -e "$STATE/identity.json" && ! -L "$STATE/identity.json" ]] ||
      fail "$STATE/identity.json exists: this node is enrolled. Never replace its token; see Upgrades, recovery and removal in docs/cluster-hosts.md."
    [[ ! -e "$STATE/enrollment-intent.json" && ! -L "$STATE/enrollment-intent.json" ]] ||
      fail "$STATE/enrollment-intent.json exists: a claim may have reached the controller. Keep the original token and follow the interrupted-claim recovery in docs/runner-enrollment.md."
    if [[ ! -e "$bootstrap" && ! -L "$bootstrap" ]]; then
      mkdir -m 0700 -- "$bootstrap" || fail "Could not create $bootstrap."
    fi
    [[ ! -L "$bootstrap" && -d "$bootstrap" ]] || fail "$bootstrap must be a real directory."
    actual=$(stat -c "%u:%g:%a" -- "$bootstrap")
    [[ "$actual" == "$EXPECTED:700" ]] || fail "$bootstrap is $actual (uid:gid:mode); expected $EXPECTED:700."
    if [[ "$REPLACE" == 1 ]]; then
      [[ ! -L "$target" && -f "$target" ]] || fail "No regular unclaimed token exists at $target; use the token command for a first token."
      actual=$(stat -c "%u:%g:%a:%h" -- "$target")
      [[ "$actual" == "$EXPECTED:600:1" ]] || fail "$target is $actual (uid:gid:mode:links); expected $EXPECTED:600:1. Inspect it before replacing."
    else
      [[ ! -e "$target" && ! -L "$target" ]] || fail "A setup token is already provisioned at $target. Use replace-token to replace an unclaimed token."
    fi
    pending=$(mktemp "$bootstrap/.enrollment-token.XXXXXX") || fail "Could not create a temporary token file."
    cleanup() { rm -f -- "$pending"; }
    trap cleanup EXIT
    cat > "$pending" || fail "Could not write the temporary token file."
    sync -- "$pending" || fail "Could not flush the temporary token file."
    if [[ "$REPLACE" == 1 ]]; then
      # rename(2) swaps the whole file: the daemon sees the old or the new token, never a partial one.
      mv -T -f -- "$pending" "$target" || fail "Could not replace $target."
    else
      ln -T -- "$pending" "$target" || fail "Could not publish $target."
    fi
    sync -- "$bootstrap" || fail "Could not flush $bootstrap."
  '
}

ensure_group() {
  local name=$1 gid=$2 entry
  if entry=$(getent group "$name"); then
    [[ "$(cut -d: -f3 <<<"$entry")" == "$gid" ]] ||
      fail "Group $name exists with GID $(cut -d: -f3 <<<"$entry"), expected $gid. Set the documented GID override consistently."
  elif entry=$(getent group "$gid"); then
    fail "GID $gid already belongs to group $(cut -d: -f1 <<<"$entry"). Choose a free GID and set it in the overlay."
  else
    groupadd --system --gid "$gid" "$name" || fail "Could not create group $name with GID $gid."
  fi
}

install_file() {
  local path=$1 mode=$2 content=$3
  if [[ -f "$path" && "$(cat -- "$path")" == "$content" ]]; then return 1; fi
  install -d -m 0755 -- "$(dirname -- "$path")" || fail "Could not create $(dirname -- "$path")."
  printf '%s\n' "$content" > "$path.canaveral-new" || fail "Could not write $path."
  chmod "$mode" -- "$path.canaveral-new"
  mv -f -- "$path.canaveral-new" "$path" || fail "Could not install $path."
}

libvirt_host() {
  local command
  for command in virsh systemctl getent groupadd useradd usermod setpriv stat; do
    command -v "$command" >/dev/null || fail "$command is required; install the host libvirt packages listed in docs/cluster-hosts.md."
  done
  systemctl cat libvirtd.socket >/dev/null 2>&1 || fail "libvirtd.socket is not installed; install libvirt-daemon-system."
  systemctl is-active --quiet polkit.service || systemctl start polkit.service ||
    fail "polkitd is not running; install and start polkitd so libvirt can authorize the daemon account."
  [[ "$vm_gid" =~ ^[1-9][0-9]*$ && "$socket_gid" =~ ^[1-9][0-9]*$ && "$vm_gid" != "$socket_gid" ]] ||
    fail "CANAVERAL_VM_GID and CANAVERAL_LIBVIRT_SOCKET_GID must be distinct positive integers."
  [[ "$storage" == /* && "$storage" != *..* ]] || fail "CANAVERAL_VM_STORAGE must be an absolute path."

  local qemu_user=${CANAVERAL_QEMU_USER:-} candidate
  if [[ -z "$qemu_user" ]]; then
    for candidate in libvirt-qemu qemu; do
      if getent passwd "$candidate" >/dev/null; then qemu_user=$candidate; break; fi
    done
  fi
  if [[ -z "$qemu_user" ]] || ! getent passwd "$qemu_user" >/dev/null; then fail "No distribution QEMU account (libvirt-qemu or qemu) exists; set CANAVERAL_QEMU_USER."; fi
  local qemu_uid
  qemu_uid=$(id -u -- "$qemu_user")
  [[ "$qemu_uid" != "$daemon_uid" && "$qemu_uid" != 0 ]] || fail "QEMU must run as its own unprivileged account, not UID $qemu_uid."
  if grep -Eq '^[[:space:]]*(user|group|dynamic_ownership)[[:space:]]*=' /etc/libvirt/qemu.conf 2>/dev/null; then
    fail "/etc/libvirt/qemu.conf overrides user, group or dynamic_ownership. Restore the distribution defaults; Canaveral domains set their DAC label per domain."
  fi
  if grep -Eq '^[[:space:]]*auth_unix_rw[[:space:]]*=' /etc/libvirt/libvirtd.conf 2>/dev/null &&
     ! grep -Eq '^[[:space:]]*auth_unix_rw[[:space:]]*=[[:space:]]*"polkit"' /etc/libvirt/libvirtd.conf; then
    fail "/etc/libvirt/libvirtd.conf overrides auth_unix_rw. Restore the polkit default."
  fi

  local changed=0 entry
  ensure_group "$vm_group" "$vm_gid"
  ensure_group "$socket_group" "$socket_gid"
  # A host account gives polkit a name for the pod's UID. It has no home, shell or extra groups.
  if entry=$(getent passwd "$daemon_uid"); then
    [[ "$(cut -d: -f1 <<<"$entry")" == "$daemon_user" ]] ||
      fail "UID $daemon_uid belongs to $(cut -d: -f1 <<<"$entry"); canaverald needs that UID for itself."
  else
    ensure_group "$daemon_user" "$daemon_gid"
    useradd --system --uid "$daemon_uid" --gid "$daemon_gid" --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin "$daemon_user" || fail "Could not create the $daemon_user host account."
  fi
  [[ "$(id -nG -- "$daemon_user")" == "$daemon_user" ]] ||
    fail "Host account $daemon_user must have no supplementary groups; found: $(id -nG -- "$daemon_user")."
  if ! id -nG -- "$qemu_user" | tr ' ' '\n' | grep -qx "$vm_group"; then
    usermod --append --groups "$vm_group" "$qemu_user" || fail "Could not add $qemu_user to $vm_group."
    changed=1
  fi
  if install_file "$socket_dropin" 0644 "$(printf '[Socket]\nSocketGroup=%s\nSocketMode=0660' "$socket_group")"; then changed=1; fi
  install_file "$polkit_rule" 0644 "$(printf '%s\n' \
    '// Canaveral: the canaverald pod (host account canaverald) may manage libvirt.' \
    'polkit.addRule(function (action, subject) {' \
    '  if (action.id == "org.libvirt.unix.manage" && subject.user == "canaverald") {' \
    '    return polkit.Result.YES;' \
    '  }' \
    '});')" || true

  [[ -d "$(dirname -- "$storage")" ]] || fail "$(dirname -- "$storage") does not exist; install libvirt first."
  if [[ ! -e "$storage" && ! -L "$storage" ]]; then
    install -d -m 2750 -o "$daemon_uid" -g "$vm_gid" -- "$storage" || fail "Could not create $storage."
  fi
  [[ ! -L "$storage" && -d "$storage" ]] || fail "$storage must be a real directory."
  local actual
  actual=$(stat -c '%u:%g:%a' -- "$storage")
  [[ "$actual" == "$daemon_uid:$vm_gid:2750" ]] ||
    fail "$storage is $actual (uid:gid:mode); expected $daemon_uid:$vm_gid:2750."

  if [[ "$changed" == 1 ]] || [[ "$(stat -c '%G:%a' -- "$socket" 2>/dev/null)" != "$socket_group:660" ]]; then
    # Running QEMU processes survive a libvirtd restart. Restart canaverald pods afterwards,
    # because their bind mount still names the replaced socket.
    local sockets=(libvirtd.socket) unit
    for unit in libvirtd-ro.socket libvirtd-admin.socket; do
      if systemctl cat "$unit" >/dev/null 2>&1; then sockets+=("$unit"); fi
    done
    systemctl stop libvirtd.service "${sockets[@]}" || fail "Could not stop libvirtd to apply the socket settings."
    systemctl daemon-reload
    systemctl start "${sockets[@]}" || fail "Could not start the libvirtd sockets."
  fi
  actual=$(stat -c '%U:%G:%a:%F' -- "$socket" 2>/dev/null) || fail "$socket does not exist after starting libvirtd.socket."
  [[ "$actual" == "root:$socket_group:660:socket" ]] || fail "$socket is $actual; expected root:$socket_group:660:socket."

  setpriv --reuid "$daemon_uid" --regid "$daemon_gid" --groups "$socket_gid" \
    env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/nonexistent \
    virsh --connect qemu:///system domcapabilities --virttype kvm >/dev/null 2>&1 ||
    fail "UID $daemon_uid with group $socket_group could not query KVM through libvirt. Check polkitd, $polkit_rule and /dev/kvm."
  setpriv --reuid "$qemu_uid" --regid "$(id -g -- "$qemu_user")" --init-groups test -r "$storage" -a -x "$storage" ||
    fail "$qemu_user cannot read $storage through group $vm_group."
  if [[ -d "$state" ]] && setpriv --reuid "$qemu_uid" --regid "$(id -g -- "$qemu_user")" --init-groups test -x "$state"; then
    fail "$qemu_user can enter $state; the daemon state directory must stay 0700."
  fi
  printf 'libvirt host ready: QEMU account %s in %s (GID %s); socket group %s (GID %s); storage %s.\n' \
    "$qemu_user" "$vm_group" "$vm_gid" "$socket_group" "$socket_gid" "$storage"
}

case "$mode" in
  token) read_token; prepare_state; write_token 0 ;;
  replace-token) read_token; prepare_state; write_token 1 ;;
  libvirt-host) [[ $# -eq 1 ]] || usage; libvirt_host ;;
  *) usage ;;
esac
