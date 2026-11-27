#!/usr/bin/env bash
set -euo pipefail

mode=detect-only
if [[ "$BACKEND" == containerd ]]; then mode=cpu; fi
jq -n \
  --arg commit "$GITHUB_SHA" --arg label "$RUNNER_LABEL" --arg imageOS "${ImageOS:-unknown}" \
  --arg imageVersion "${ImageVersion:-unknown}" --arg backend "$BACKEND" --arg os "$RUNNER_OS" \
  --arg arch "$RUNNER_ARCH" --arg mode "$mode" \
  '{schemaVersion: 1, commit: $commit, runner: {label: $label, imageOS: $imageOS, imageVersion: $imageVersion},
    backend: $backend, os: $os, arch: $arch, executionMode: $mode, assetPins: [], modelDigest: null, steps: []}' \
  > "$RUNNER_TEMP/host-evidence.json"
