"""Guest-only preparation scripts, receipts and SSH execution."""
import base64
import hashlib
import json
import re
import secrets
import shlex
import time
from pathlib import Path, PurePosixPath

from .client import Client
from .files import save_json
from .model import Error, digest
from .templates import recipe


def credential(folder):
    path = Path(folder) / "preparation.json"
    if not path.exists():
        save_json(path, {"token": secrets.token_urlsafe(32)})
    return json.loads(path.read_text())["token"]


def notify_python(url, token):
    return '''import json,time,urllib.request,urllib.error
url,token = ''' + repr((url, token)) + '''
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise RuntimeError('Redirect rejected')
opener=urllib.request.build_opener(NoRedirect)
for attempt in range(120):
 try:
  request=urllib.request.Request(url,data=b'{"state":"ready"}',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
  with opener.open(request,timeout=10) as response:
   assert response.status == 200
  break
 except Exception:
  time.sleep(5)
else: raise SystemExit('Preparation completed but receipt could not reach the orchestrator')
'''


def unix_script(prepared, machine, notify=None):
    """All mutations run inside the guest, never through the host shell."""
    identity = machine["id"]
    root = "/var/lib/canaveral/" + identity
    # The owner-chosen recipe runs once. Interrupted commands require inspection, not replay.
    lines = ["#!/bin/sh", "set -eu", "umask 077", "root=" + shlex.quote(root), 'mkdir -p "$root"',
             'if [ ! -f "$root/complete" ]; then',
             '  if [ -e "$root/started" ]; then echo "Preparation was interrupted; inspect before clearing the started marker" >&2; exit 42; fi',
             '  mkdir "$root/lock" || exit 42', '  trap \'rmdir "$root/lock"\' EXIT', '  touch "$root/started"']
    packages = prepared["packages"]
    if packages:
        names = " ".join(shlex.quote(p) for p in packages)
        lines += ["  if command -v apt-get >/dev/null; then", "    export DEBIAN_FRONTEND=noninteractive", "    apt-get update", "    apt-get install -y -- " + names,
                  "  elif command -v dnf >/dev/null; then dnf install -y -- " + names,
                  "  elif command -v apk >/dev/null; then apk add -- " + names,
                  "  else echo 'No supported package manager' >&2; exit 1; fi"]
    user = prepared.get("user")
    if user:
        quoted = shlex.quote(user)
        lines += ["  id " + quoted + " >/dev/null 2>&1 || useradd -m -s /bin/sh " + quoted]
        if prepared["sshAuthorizedKeys"]:
            keys = base64.b64encode(("\n".join(prepared["sshAuthorizedKeys"]) + "\n").encode()).decode()
            lines += ["  guest_home=$(getent passwd " + quoted + " | cut -d: -f6)", '  test -n "$guest_home"',
                      '  mkdir -p "$guest_home/.ssh"', '  chmod 700 "$guest_home/.ssh"',
                      "  printf '%s' " + shlex.quote(keys) + ' | base64 -d > "$guest_home/.ssh/authorized_keys"',
                      '  chmod 600 "$guest_home/.ssh/authorized_keys"', "  chown -R " + quoted + ': "$guest_home/.ssh"']
    for item in prepared["files"]:
        encoded = base64.b64encode(item["content"].encode()).decode()
        lines += ["  mkdir -p " + shlex.quote(str(PurePosixPath(item["path"]).parent)),
                  "  printf '%s' " + shlex.quote(encoded) + " | base64 -d > " + shlex.quote(item["path"]),
                  "  chmod " + item["mode"] + " " + shlex.quote(item["path"])]
    for command in prepared["commands"]:
        # A failing command cannot be hidden by a later successful recipe command.
        lines.append("  sh -eu -c " + shlex.quote(command))
    lines += ['  touch "$root/complete"', "fi"]
    if notify:
        script = base64.b64encode(notify_python(*notify).encode()).decode()
        lines += ["printf '%s' " + shlex.quote(script) + ' | base64 -d > "$root/notify.py"', 'python3 "$root/notify.py"']
    return "\n".join(lines) + "\n"


def powershell_script(prepared, machine, notify=None):
    root = "C:\\ProgramData\\Canaveral\\" + machine["id"]
    lines = ["#ps1_sysnative", "$ErrorActionPreference = 'Stop'", "try {", "$root = '" + root + "'", "New-Item -ItemType Directory -Force -Path $root | Out-Null",
             "if (-not (Test-Path -LiteralPath ($root + '\\complete'))) {",
             " if (Test-Path -LiteralPath ($root + '\\started')) { throw 'Interrupted preparation requires inspection.' }",
             " $lock = [System.IO.File]::Open(($root + '\\lock'), 'CreateNew', 'Write', 'None')",
             " try {", " New-Item -ItemType File -Path ($root + '\\started') | Out-Null"]
    for item in prepared["files"]:
        encoded = base64.b64encode(item["content"].encode()).decode()
        path = item["path"].replace("'", "''")
        lines += [" $file = '" + path + "'", " New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null",
                  " [IO.File]::WriteAllBytes($file,[Convert]::FromBase64String('" + encoded + "'))"]
    for command in prepared["commands"]:
        encoded = base64.b64encode(("$ErrorActionPreference='Stop';\n" + command + "\nif (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }").encode("utf-16le")).decode()
        lines += [" & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '" + encoded + "'",
                  " if ($LASTEXITCODE -ne 0) { throw 'Guest preparation command failed.' }"]
    lines += [" New-Item -ItemType File -Path ($root + '\\complete') | Out-Null", " } finally { $lock.Dispose(); Remove-Item -LiteralPath ($root + '\\lock') }", "}"]
    if notify:
        url, token = notify
        lines += ["$headers = @{ Authorization = 'Bearer " + token + "' }", "$notified = $false", "for ($i=0; $i -lt 120; $i++) {", " try {",
                  "  Invoke-RestMethod -Uri '" + url.replace("'", "''") + "' -Method Post -ContentType 'application/json' -Body '{\"state\":\"ready\"}' -Headers $headers -MaximumRedirection 0 | Out-Null",
                  "  $notified = $true; break", " } catch { Start-Sleep -Seconds 5 }", "}", "if (-not $notified) { throw 'Preparation completed but its receipt could not reach the orchestrator.' }"]
    lines += ["} catch { [Console]::Error.WriteLine('Guest preparation failed; inspect the preparation state.'); exit 1 }", "exit 0"]
    return "\r\n".join(lines) + "\r\n"


def user_data(image, machine, url, token, allow_http=False, notify=True):
    prepared = recipe(image.get("prepare"), image["os"])
    if not prepared or prepared["driver"] == "ssh":
        return None
    Client(url, token, allow_http)  # The guest endpoint uses the same transport boundary as hosts.
    endpoint = url.rstrip("/") + "/v1/machines/" + machine["id"] + "/prepared"
    if prepared["driver"] == "cloudbase-init":
        return powershell_script(prepared, machine, (endpoint, token))
    script = unix_script(prepared, machine, (endpoint, token) if notify else None)
    # JSON is a YAML subset, so this needs no third-party YAML emitter.
    config={"write_files": [{"path": "/var/lib/canaveral/prepare.sh", "permissions": "0700", "encoding": "b64", "content": base64.b64encode(script.encode()).decode()}],
            "runcmd": [["sh", "/var/lib/canaveral/prepare.sh"]]}
    if image.get('cloneIdentity')=='linux-cloud-init':
        from .model import identifier
        identity=identifier(machine['id']).replace('-','')
        marker='/var/lib/canaveral/'+identifier(machine['id'])+'/complete'
        config['bootcmd']=[['sh','-eu','-c',"printf '%s\\n' "+identity+" > /etc/machine-id; mkdir -p /var/lib/dbus; ln -snf /etc/machine-id /var/lib/dbus/machine-id; if [ ! -f "+marker+" ]; then rm -f /opt/canaveral/prepared; fi"]]
    return "#cloud-config\n"+json.dumps(config)+"\n"


def prepare_ssh(image, machine):
    from .providers.base import run
    prepared = recipe(image.get("prepare"), image["os"])
    settings = image.get("ssh", {})
    if not isinstance(settings, dict) or not all(settings.get(k) for k in ("host", "user", "identityFile", "knownHostsFile")):
        raise Error("SSH preparation needs host, user, identityFile and knownHostsFile bindings.")
    host = settings["host"].replace("{id}", machine["id"])
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", host) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", settings["user"]):
        raise Error("Invalid SSH host or user binding.")
    port = settings.get("port", 22)
    if type(port) is not int or not 1 <= port <= 65535:
        raise Error("Invalid SSH port.")
    command = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command -" if image["os"] == "windows" else "sudo -n sh -s"
    script = powershell_script(prepared, machine) if image["os"] == "windows" else unix_script(prepared, machine)
    known = str(Path(settings["knownHostsFile"]).resolve()).replace("\\", "\\\\").replace('"', '\\"')
    run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
         "-o", 'UserKnownHostsFile="' + known + '"', "-i", str(Path(settings["identityFile"]).resolve()),
         "-p", str(port), settings["user"] + "@" + host, command], data=script.encode(), timeout=prepared["timeoutSeconds"])
