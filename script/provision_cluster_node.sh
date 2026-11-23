#!/usr/bin/env bash
# Run on the selected Linux node as root. The token is read on stdin.
set -euo pipefail
umask 077
state=/var/lib/canaverald

[[ "$(id -u)" == 0 && $# == 0 ]] || { echo "Run as root with the setup token on stdin." >&2; exit 1; }
token=$(cat)
[[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || { echo "Invalid setup token." >&2; exit 1; }


if [[ ! -e "$state" && ! -L "$state" ]]; then
  mkdir -m 0700 -- "$state"
  chown 10001:10001 -- "$state"
fi
[[ -d "$state" && ! -L "$state" && "$(stat -c '%u:%g:%a' -- "$state")" == 10001:10001:700 ]] || {
  echo "Expected a private state directory owned by 10001:10001." >&2
  exit 1
}

printf '%s\n' "$token" | setpriv --reuid 10001 --regid 10001 --clear-groups bash -euc '
  umask 077
  state=/var/lib/canaverald
  bootstrap="$state/bootstrap"
  if [[ ! -e "$bootstrap" && ! -L "$bootstrap" ]]; then
    mkdir -m 0700 -- "$bootstrap"
  fi
  [[ -d "$bootstrap" && ! -L "$bootstrap" && "$(stat -c "%u:%g:%a" -- "$bootstrap")" == 10001:10001:700 ]]
  [[ ! -e "$state/identity.json" && ! -L "$state/identity.json" ]] || {
    echo "An identity already exists. Use the recovery procedure." >&2
    exit 1
  }
  pending=$(mktemp "$bootstrap/.enrollment-token.XXXXXX")
  cleanup() { rm -f -- "$pending"; }
  trap cleanup EXIT
  cat > "$pending"
  ln -T -- "$pending" "$bootstrap/enrollment-token"
'
