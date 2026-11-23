#!/usr/bin/env bash
set -euo pipefail
source fixtures/host-runtimes/evidence.sh

installer=/usr/local/sbin/canaveral-host-installer
daemon=$PWD/coordination/dist/src/canaverald.js
# Docker Official Image busybox:1.37.0-musl OCI index (linux/amd64 and linux/arm64).
image=docker.io/library/busybox@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478
work=$(mktemp -d)
host_config="$work/host.json"
namespace=host-acceptance
cat > "$host_config" <<'JSON'
{"name":"host-acceptance","provider":"native","templates":[],"capacity":{"cpu":1,"memoryMiB":1024,"diskGiB":1}}
JSON

install_report() {
  sudo "$installer" containerd "$1" --json | tee "$2"
}

refuse() {
  local exit_code=0
  sudo "$installer" containerd "$1" --json > "$work/refusal.json" || exit_code=$?
  cat "$work/refusal.json"
  test "$exit_code" -eq 1
  jq -e --arg code "$2" '.result.code == $code' "$work/refusal.json"
}

daemon_status() {
  test "$(id -u)" -ne 0
  "$daemon" runtimes status --config "$host_config" --state "$work/state" --json | tee "$1"
}

healthy() {
  install_report status "$1"
  jq -e '.result | .code == "installed" and .unitActive and .socketPresent
    and (.files | length == 6 and all(.[]; .code == "matches"))' "$1"
}

begin "Unprivileged plan"
test "$(id -u)" -ne 0
sudo install -o root -g root -m 0755 target/release/canaveral-host-installer "$installer"
"$installer" containerd plan --json | tee "$work/plan.json"
jq -e '.result | .code == "planned" and (.assets | length == 2)' "$work/plan.json"
update_evidence --slurpfile plan "$work/plan.json" --arg image "$image" \
  '.assetPins = $plan[0].result.assets | .ociImage = $image'
ctr="$(jq -er '.result.binDirectory' "$work/plan.json")/ctr"
socket=$(jq -er '.result.socket' "$work/plan.json")
unit=$(jq -er '.result.unit' "$work/plan.json")
receipt=$(jq -er '.result.receiptPath' "$work/plan.json")
enablement=/etc/systemd/system/multi-user.target.wants/canaveral-containerd.service
operator_link=/etc/systemd/system/host-acceptance.target.wants/canaveral-containerd.service
echo "::endgroup::"

begin "Refuse the runner's preinstalled runtimes"
command -v docker
command -v containerd
command -v podman
refuse install foreign_install
echo "::endgroup::"

begin "Purge the preinstalled runtimes"
units=(docker.socket docker.service containerd.service podman.socket podman.service podman-restart.service \
  podman-auto-update.timer podman-auto-update.service)
for service in "${units[@]}"; do
  if [[ $(systemctl show --property=LoadState --value "$service") == loaded ]]; then
    sudo systemctl stop "$service"
  fi
done
mapfile -t packages < <(dpkg-query -W -f='${Package} ${db:Status-Status}\n' |
  awk '$2 != "not-installed" && $1 ~ /^(containerd(-static|[.]io)?|docker([.-].*)?|moby-.*|podman(-.*)?|runc|crun|containernetworking-plugins|netavark|aardvark-dns)$/ {print $1}')
if (( ${#packages[@]} )); then
  sudo env DEBIAN_FRONTEND=noninteractive apt-get purge -y "${packages[@]}"
fi
for service in "${units[@]}"; do
  sudo rm -rf "/etc/systemd/system/$service" "/etc/systemd/system/$service.d"
  sudo find /etc/systemd/system -type l -name "$service" -delete
done
sudo rm -f /usr/local/{bin,sbin}/{docker,docker-compose,dockerd,containerd,containerd-shim-runc-v2,containerd-stress,ctr,runc,podman}
sudo rm -rf /run/{containerd,docker,docker.sock,podman} /etc/{containerd,docker,containers,cni} \
  /var/lib/{containerd,docker,containers,cni} /opt/cni/bin \
  /root/{.docker,.config/containers,.local/share/containers} \
  "$HOME"/{.docker,.config/containers,.local/share/containers}
sudo systemctl daemon-reload
for executable in docker dockerd containerd ctr runc podman; do
  if command -v "$executable"; then
    echo "Runner still has $executable" >&2
    exit 1
  fi
done
echo "::endgroup::"

begin "Prepare a root-owned installation ancestor"
# Hosted images let the runner write /opt. Keep production ownership checks intact.
opt_identity=$(stat -c '%U:%G:%a' /opt)
update_evidence --arg identity "$opt_identity" '.runnerOptBefore = $identity'
sudo chown root:root /opt
sudo chmod 0755 /opt
test "$(stat -c '%U:%G:%a' /opt)" = root:root:755
echo "::endgroup::"

begin "Cold install and privileged health check"
install_report install "$work/install.json"
jq -e '.result.code == "installed"' "$work/install.json"
healthy "$work/healthy.json"
update_evidence --slurpfile healthy "$work/healthy.json" \
  '.installerStatus = ($healthy[0].result | del(.receipt, .files))'
test "$(sudo stat -c '%U:%G:%a' "$(dirname "$socket")")" = root:root:700
test ! -x "$(dirname "$socket")"
echo "::endgroup::"

begin "Verify receipt and detect file drift as the runner"
version=$(jq -er '.result.assets[] | select(.name == "containerd") | .version' "$work/plan.json")
daemon_status "$work/registry.json"
update_evidence --slurpfile registry "$work/registry.json" \
  '.registryStatus = ($registry[0][] | select(.id == "containerd"))'
jq -e --arg version "$version" \
  'any(.[]; .id == "containerd" and .state == "verified" and .version == $version and .qualified == false)' \
  "$work/registry.json"
config=$(jq -er '.result.config' "$work/plan.json")
cp "$config" "$work/config.toml"
printf '\n# host acceptance: deliberate digest drift\n' | sudo tee -a "$config" >/dev/null
daemon_status "$work/drift.json"
sudo install -o root -g root -m 0644 "$work/config.toml" "$config"
jq -e 'any(.[]; .id == "containerd" and .state == "failed" and .blocker.code == "containerd_receipt_file_mismatch")' \
  "$work/drift.json"
update_evidence --slurpfile drift "$work/drift.json" \
  '.driftStatus = ($drift[0][] | select(.id == "containerd"))'
cp "$receipt" "$work/receipt.json"
echo "::endgroup::"

begin "Run a pinned OCI task through the private socket"
ctr_command() {
  sudo "$ctr" --address "$socket" --namespace "$namespace" "$@"
}
ctr_command images pull "$image"
ctr_command run --rm "$image" acceptance-exit /bin/true
echo "::endgroup::"

begin "Refuse removal with an active task and with a container record"
ctr_command run --detach "$image" acceptance-busy /bin/sleep 120
ctr_command tasks list | awk '$1 == "acceptance-busy" && $3 == "RUNNING" {running=1} END {exit !running}'
refuse remove runtime_in_use
ctr_command tasks rm --force acceptance-busy
refuse remove runtime_in_use
ctr_command containers rm acceptance-busy
echo "::endgroup::"

begin "Same-pin reinstall preserves files, service and operator enablement"
sudo mkdir -p "$(dirname "$operator_link")"
sudo ln -s "$unit" "$operator_link"
operator_identity=$(stat -c '%d:%i:%z:%N' "$operator_link")
snapshot() {
  systemctl show --property=MainPID,InvocationID canaveral-containerd.service
  while IFS= read -r path; do
    stat -c '%d:%i:%y:%z:%N' "$path"
  done < <(jq -r '.files[].path' "$work/receipt.json")
  stat -c '%d:%i:%y:%z:%N' "$receipt" "$enablement" "$operator_link"
}
snapshot > "$work/before"
install_report install "$work/reinstall.json"
jq -e '.result.code == "installed"' "$work/reinstall.json"
snapshot > "$work/after"
diff -u "$work/before" "$work/after"
cmp "$work/receipt.json" "$receipt"
healthy "$work/reinstalled.json"
echo "::endgroup::"

begin "Remove owned files and preserve the operator link"
install_report remove "$work/remove.json"
jq -e '.result.code == "removed"' "$work/remove.json"
while IFS= read -r path; do
  sudo test ! -e "$path"
  sudo test ! -L "$path"
done < <(jq -r '.files[].path, .unit, .socket' "$work/receipt.json")
sudo test ! -e "$receipt"
sudo test ! -L "$receipt"
sudo test ! -L "$enablement"
sudo test ! -e /var/lib/canaveral-host-installer/private/containerd.json
sudo test ! -e /var/lib/canaveral-host-installer/receipts/containerd.pending.json
test "$(stat -c '%d:%i:%z:%N' "$operator_link")" = "$operator_identity"
sudo test -d /var/lib/canaveral-containerd
install_report status "$work/removed.json"
jq -e '.result | .code == "absent" and .receipt == null and .unitActive == false and .socketPresent == false' \
  "$work/removed.json"
update_evidence '.crashRecovery = "fixture-only: downloads precede the journal and remaining durable boundaries have no deterministic external pause"'
echo "::endgroup::"
