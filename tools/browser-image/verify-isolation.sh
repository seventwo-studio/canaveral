#!/bin/sh
# Run as root in an idle disposable, provisioned guest. Intentionally crashes the worker.
set -eu
launcher_units() {
  systemctl list-units --type=service --state=running --plain --no-legend 'browser-launch@*.service' | awk '{print $1}'
}
test -z "$(launcher_units)"
worker=$(systemctl show -p MainPID --value browser.service)
test "$worker" -gt 1
test "$(stat -c %U /proc/"$worker")" = browser-runtime
test "$(stat -c '%U:%a' /run/canaveral-browser-launch.sock)" = browser-runtime:600
for file in /etc/canaveral-browser/token /proc/"$worker"/environ; do
  test -r "$file"
  runuser -u browser -- test ! -r "$file"
done
launch_browser() {
/usr/local/bin/node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const token = readFileSync('/etc/canaveral-browser/token', 'utf8').trim();
const result = await fetch('http://127.0.0.1:9333/v1/browsers', {
  method: 'POST', headers: { authorization: 'Bearer ' + token },
  body: JSON.stringify({ engine: 'chromium', ttlSeconds: 120, id: randomUUID() }),
});
if (result.status !== 201) throw new Error('Chromium launch failed: ' + result.status);
console.log((await result.json()).id);
JS
}
first=$(launch_browser)
first_group=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$(launcher_units)")
test -d "$first_group"
BROWSER_ID="$first" /usr/local/bin/node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const id = process.env.BROWSER_ID;
const token = readFileSync('/etc/canaveral-browser/token', 'utf8').trim();
const response = await fetch('http://127.0.0.1:9333/v1/browsers/' + id, {
  method: 'DELETE', headers: { authorization: 'Bearer ' + token },
});
const receipt = await response.json();
if (response.status !== 200 || receipt.id !== id || receipt.state !== 'closed') throw new Error('Stop unconfirmed');
JS
for attempt in $(seq 1 20); do
  [ -d "$first_group" ] || break
  sleep 1
done
test ! -d "$first_group"
test "$(systemctl show -p MainPID --value browser.service)" = "$worker"
launch_browser >/dev/null
unit=$(launcher_units)
launcher=$(systemctl show -p MainPID --value "$unit")
for name in token origin; do
  nsenter -t "$launcher" -m -- runuser -u browser -- test ! -r "/run/credentials/browser.service/$name"
done
group=/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit")
test "$(wc -l < "$group/cgroup.procs")" -gt 1
for pid in $(cat "$group/cgroup.procs"); do
  test "$(awk '/^Uid:/ {print $2}' /proc/"$pid"/status)" = "$(id -u browser)"
  if tr '\000' '\n' < /proc/"$pid"/environ | grep -q '^CREDENTIALS_DIRECTORY='; then exit 1; fi
done
systemctl kill --kill-whom=main --signal=KILL browser.service
for attempt in $(seq 1 20); do
  if [ ! -d "$group" ] && systemctl is-active --quiet browser.service; then exit 0; fi
  sleep 1
done
echo 'Launcher cgroup cleanup or worker recovery timed out' >&2
exit 1
