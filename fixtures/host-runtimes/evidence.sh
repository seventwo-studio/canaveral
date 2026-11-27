# Sourced by the hosted acceptance scripts.
evidence="$RUNNER_TEMP/host-evidence.json"
step=""
started=0

update_evidence() {
  jq "$@" "$evidence" > "$evidence.tmp"
  mv "$evidence.tmp" "$evidence"
}

finish() {
  if [[ -z "$step" ]]; then return; fi
  update_evidence --arg step "$step" --arg outcome "$1" --argjson seconds "$(( $(date +%s) - started ))" \
    '.steps += [{step: $step, outcome: $outcome, seconds: $seconds}]'
}

begin() {
  finish passed
  step=$1
  started=$(date +%s)
  echo "::group::$step"
}

end_evidence() {
  local status=$?
  if [[ $status == 0 ]]; then finish passed; else finish failed; fi
  exit "$status"
}

trap end_evidence EXIT
