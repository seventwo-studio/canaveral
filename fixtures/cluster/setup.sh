#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir "$CLUSTER_WORK"
step='prepare k3s'
began=$SECONDS
jq -n --arg commit "$GITHUB_SHA" --arg imageOs "${ImageOS:-}" --arg imageVersion "${ImageVersion:-}" \
  --arg os "$(uname -s)" --arg arch "$(uname -m)" \
  '{commit:$commit, runnerImage:{os:$imageOs,version:$imageVersion},os:$os,arch:$arch,steps:[]}' > "$CLUSTER_EVIDENCE"
record() {
  local pending="$CLUSTER_EVIDENCE.tmp"
  jq --arg name "$step" --arg outcome "$1" --argjson durationMs "$(((SECONDS-began)*1000))" \
    '.steps += [{name:$name,outcome:$outcome,durationMs:$durationMs}]' "$CLUSTER_EVIDENCE" > "$pending"
  mv "$pending" "$CLUSTER_EVIDENCE"
}
trap 'record failed' ERR

curl --fail --silent --show-error --location --retry 3 \
  https://github.com/k3s-io/k3s/releases/download/v1.34.1%2Bk3s1/k3s -o "$CLUSTER_WORK/k3s"
printf '%s  %s\n' ec8958fe1363a32d50e028b5e3411c04b0dbd0316fab33524e8094352b78f6a3 "$CLUSTER_WORK/k3s" | sha256sum --check
sudo install -m 0755 "$CLUSTER_WORK/k3s" /usr/local/bin/k3s
sudo systemd-run --unit canaveral-k3s --property Delegate=yes \
  /usr/local/bin/k3s server --disable traefik --disable servicelb --disable metrics-server
for _ in {1..60}; do
  sudo test -s /etc/rancher/k3s/k3s.yaml && break
  sleep 2
done
# shellcheck disable=SC2024 # Keep the disposable copy owned by the workflow user.
sudo cat /etc/rancher/k3s/k3s.yaml > "$KUBECONFIG"
node=
for _ in {1..60}; do
  node=$(kubectl --request-timeout=5s get nodes -o name 2>/dev/null) && [[ -n "$node" ]] && break
  sleep 2
done
if [[ -z "$node" ]]; then
  sudo journalctl -u canaveral-k3s --no-pager -n 50
  echo "k3s failed to register the hosted runner as a node." >&2
  exit 1
fi
kubectl wait --for=condition=Ready "$node" --timeout=180s
record passed

step='build and import node and controller images'
began=$SECONDS
docker build --target canaverald -t canaverald:local .
docker build --target orchestrator -t canaveral:local .
docker save -o "$CLUSTER_WORK/images.tar" canaveral:local canaverald:local
sudo k3s ctr images import "$CLUSTER_WORK/images.tar"
rm "$CLUSTER_WORK/images.tar"
record passed

step='deploy TLS controller'
began=$SECONDS
openssl req -new -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=Canaveral-CI \
  -keyout "$CLUSTER_WORK/ca.key" -out "$CLUSTER_WORK/ca.crt" 2>"$CLUSTER_WORK/openssl.log"
openssl req -new -newkey rsa:2048 -nodes -subj /CN=orchestrator.canaveral.svc \
  -keyout "$CLUSTER_WORK/server.key" -out "$CLUSTER_WORK/server.csr" 2>>"$CLUSTER_WORK/openssl.log"
printf '%s\n' 'subjectAltName=DNS:orchestrator,DNS:orchestrator.canaveral,DNS:orchestrator.canaveral.svc,IP:127.0.0.1' > "$CLUSTER_WORK/tls.ext"
openssl x509 -req -in "$CLUSTER_WORK/server.csr" -CA "$CLUSTER_WORK/ca.crt" -CAkey "$CLUSTER_WORK/ca.key" \
  -CAcreateserial -days 1 -extfile "$CLUSTER_WORK/tls.ext" -out "$CLUSTER_WORK/server.crt"
openssl rand -hex 32 > "$CLUSTER_WORK/admin.token"
openssl rand -hex 32 > "$CLUSTER_WORK/enrollment.token"
cat /proc/sys/kernel/random/uuid > "$CLUSTER_WORK/controller-id"
kubectl apply -k deploy/kubernetes/namespaces
kubectl -n canaveral create secret generic canaveral-credentials \
  --from-file=admin.token="$CLUSTER_WORK/admin.token" --from-file=enrollment.token="$CLUSTER_WORK/enrollment.token"
kubectl -n canaveral create secret tls canaveral-controller-tls \
  --cert="$CLUSTER_WORK/server.crt" --key="$CLUSTER_WORK/server.key"
# Bind the disposable model runner to a known controller ID without reading its database.
kubectl kustomize deploy/kubernetes/orchestrator |
  sed "/^        - serve$/a\        - --controller-id\n        - $(cat "$CLUSTER_WORK/controller-id")" |
  kubectl apply -f -
kubectl -n canaveral rollout status deployment/orchestrator --timeout=180s
record passed
