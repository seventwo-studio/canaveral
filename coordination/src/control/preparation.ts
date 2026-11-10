import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, secret, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import type { ControlModule, ControlOptions } from "./contracts.ts";
import { legacyDigest, operatorRecipe as recipe } from "./templates.ts";
import type { PreparationRecipe } from "./templates.ts";

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const b64 = (value: string): string => Buffer.from(value).toString("base64");
export interface PreparationMachine { id: string }
export type Notify = readonly [url: string, token: string];
/** Guest-only callback. Curl rejects redirects, requires a 200 receipt and retries boundedly. */
export function notifyScript(url: string, token: string): string {
  secret(token);
  return ["attempt=0", "notified=false", "while [ \"$attempt\" -lt 120 ]; do",
    `  if code=$(curl --disable --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --max-redirs 0 --proto '=http,https' --request POST --header ${quote("Authorization: Bearer " + token)} --header 'Content-Type: application/json' --data '{"state":"ready"}' ${quote(url)}) && [ "$code" = 200 ]; then notified=true; break; fi`,
    "  attempt=$((attempt + 1))", "  sleep 5", "done", "[ \"$notified\" = true ] || { echo 'Preparation completed but its receipt could not reach the orchestrator' >&2; exit 1; }", ""].join("\n");
}
export function unixScript(prepared: PreparationRecipe, machine: PreparationMachine, notify?: Notify): string {
  const root = `/var/lib/canaveral/${identifier(machine.id)}`;
  const lines = ["#!/bin/sh", "set -eu", "umask 077", `root=${quote(root)}`, 'mkdir -p "$root"', 'if [ ! -f "$root/complete" ]; then',
    '  if [ -e "$root/started" ]; then echo "Preparation was interrupted; inspect before clearing the started marker" >&2; exit 42; fi',
    '  mkdir "$root/lock" || exit 42', '  trap \'rmdir "$root/lock"\' EXIT', '  touch "$root/started"'];
  if (prepared.packages.length) {
    const names = prepared.packages.map(quote).join(" ");
    lines.push("  if command -v apt-get >/dev/null; then", "    export DEBIAN_FRONTEND=noninteractive", "    apt-get update", `    apt-get install -y -- ${names}`, `  elif command -v dnf >/dev/null; then dnf install -y -- ${names}`, `  elif command -v apk >/dev/null; then apk add -- ${names}`, "  else echo 'No supported package manager' >&2; exit 1; fi");
  }
  if (prepared.user) {
    const user = quote(prepared.user);
    lines.push(`  id ${user} >/dev/null 2>&1 || useradd -m -s /bin/sh ${user}`);
    if (prepared.sshAuthorizedKeys.length) lines.push(`  guest_home=$(getent passwd ${user} | cut -d: -f6)`, '  test -n "$guest_home"', '  mkdir -p "$guest_home/.ssh"', '  chmod 700 "$guest_home/.ssh"', `  printf '%s' ${quote(b64(prepared.sshAuthorizedKeys.join("\n") + "\n"))} | base64 -d > "$guest_home/.ssh/authorized_keys"`, '  chmod 600 "$guest_home/.ssh/authorized_keys"', `  chown -R ${user}: "$guest_home/.ssh"`);
  }
  for (const file of prepared.files) lines.push(`  mkdir -p ${quote(posix.dirname(file.path))}`, `  printf '%s' ${quote(b64(file.content))} | base64 -d > ${quote(file.path)}`, `  chmod ${file.mode} ${quote(file.path)}`);
  for (const command of prepared.commands) lines.push(`  sh -eu -c ${quote(command)}`);
  lines.push('  touch "$root/complete"', "fi");
  if (notify) lines.push(notifyScript(...notify));
  return lines.join("\n") + "\n";
}
export function powershellScript(prepared: PreparationRecipe, machine: PreparationMachine, notify?: Notify): string {
  const root = `C:\\ProgramData\\Canaveral\\${identifier(machine.id)}`;
  const lines = ["#ps1_sysnative", "$ErrorActionPreference = 'Stop'", "try {", `$root = ${psQuote(root)}`, "New-Item -ItemType Directory -Force -Path $root | Out-Null", "if (-not (Test-Path -LiteralPath ($root + '\\complete'))) {", " if (Test-Path -LiteralPath ($root + '\\started')) { throw 'Interrupted preparation requires inspection.' }", " $lock = [System.IO.File]::Open(($root + '\\lock'), 'CreateNew', 'Write', 'None')", " try {", " New-Item -ItemType File -Path ($root + '\\started') | Out-Null"];
  for (const file of prepared.files) lines.push(` $file = ${psQuote(file.path)}`, " New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null", ` [IO.File]::WriteAllBytes($file,[Convert]::FromBase64String('${b64(file.content)}'))`);
  for (const command of prepared.commands) {
    const encoded = Buffer.from(`$ErrorActionPreference='Stop';\n${command}\nif (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`, "utf16le").toString("base64");
    lines.push(` & powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '${encoded}'`, " if ($LASTEXITCODE -ne 0) { throw 'Guest preparation command failed.' }");
  }
  lines.push(" New-Item -ItemType File -Path ($root + '\\complete') | Out-Null", " } finally { $lock.Dispose(); Remove-Item -LiteralPath ($root + '\\lock') }", "}");
  if (notify) {
    secret(notify[1]);
    lines.push(`$headers = @{ Authorization = ${psQuote("Bearer " + notify[1])} }`, "$notified = $false", "for ($i=0; $i -lt 120; $i++) {", " try {", `  $response = Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(notify[0])} -Method Post -ContentType 'application/json' -Body '{"state":"ready"}' -Headers $headers -MaximumRedirection 0 -TimeoutSec 10`, "  if ($response.StatusCode -ne 200) { throw 'Invalid receipt response.' }", "  $notified = $true; break", " } catch { Start-Sleep -Seconds 5 }", "}", "if (-not $notified) { throw 'Preparation completed but its receipt could not reach the orchestrator.' }");
  }
  lines.push("} catch { [Console]::Error.WriteLine('Guest preparation failed; inspect the preparation state.'); exit 1 }", "exit 0");
  return lines.join("\r\n") + "\r\n";
}
export function validatePreparationURL(value: string, allowHTTP = false): string {
  let url: URL; try { url = new URL(value); } catch { throw new ServiceError("Invalid guest controller URL.", 400); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url.hostname || url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || allowHTTP)))) throw new ServiceError("Remote guest callbacks require HTTPS without embedded credentials.", 400);
  return value.replace(/\/+$/, "");
}
export function userData(image: Record<string, unknown>, machine: PreparationMachine, url: string, token: string, allowHTTP = false, notify = true): string | null {
  const prepared = recipe(image.prepare, String(image.os));
  if (!prepared || prepared.driver === "ssh") return null;
  secret(token);
  const id = identifier(machine.id), endpoint = `${validatePreparationURL(url, allowHTTP)}/v1/machines/${id}/prepared`;
  if (prepared.driver === "cloudbase-init") return powershellScript(prepared, machine, notify ? [endpoint, token] : undefined);
  const script = unixScript(prepared, machine, notify ? [endpoint, token] : undefined);
  const config: Record<string, unknown> = { write_files: [{ path: "/var/lib/canaveral/prepare.sh", permissions: "0700", encoding: "b64", content: b64(script) }], runcmd: [["sh", "/var/lib/canaveral/prepare.sh"]] };
  if (image.cloneIdentity === "linux-cloud-init") config.bootcmd = [["sh", "-eu", "-c", `printf '%s\\n' ${id.replaceAll("-", "")} > /etc/machine-id; mkdir -p /var/lib/dbus; ln -snf /etc/machine-id /var/lib/dbus/machine-id; if [ ! -f /var/lib/canaveral/${id}/complete ]; then rm -f /opt/canaveral/prepared; fi`]];
  return "#cloud-config\n" + JSON.stringify(config) + "\n";
}
/** ConfigDrive/NoCloud contents only. ISO assembly belongs to an authorized native adapter. */
export function seedFiles(image: Record<string, unknown>, machine: PreparationMachine, url: string, token: string, allowHTTP = false): Record<string, string> | null {
  const data = userData(image, machine, url, token, allowHTTP);
  if (data === null) return null;
  const id = identifier(machine.id);
  if (recipe(image.prepare, String(image.os))!.driver === "cloudbase-init") return { "openstack/latest/meta_data.json": JSON.stringify({ uuid: id, hostname: `cvm-${id.slice(0, 8)}` }), "openstack/latest/user_data": data };
  const files: Record<string, string> = { "meta-data": JSON.stringify({ "instance-id": id, "local-hostname": `cvm-${id}` }), "user-data": data };
  if (image.cloneIdentity === "linux-cloud-init") {
    const mac = "02:" + id.replaceAll("-", "").slice(0, 10).match(/../g)!.join(":");
    files["network-config"] = JSON.stringify({ version: 2, ethernets: { canaveral: { match: { macaddress: mac }, dhcp4: true, "dhcp-identifier": "mac" } } });
  }
  return files;
}
/** Return a bounded execution plan; this module never invokes SSH or native tools. */
export function sshPreparation(image: Record<string, unknown>, machine: PreparationMachine): { argv: string[]; input: string; timeoutSeconds: number } {
  const prepared = recipe(image.prepare, String(image.os)), settings = object(image.ssh);
  if (!prepared || prepared.driver !== "ssh") throw new ServiceError("SSH preparation requires an SSH recipe.", 400);
  for (const key of ["host", "user", "identityFile", "knownHostsFile"]) if (typeof settings[key] !== "string" || !settings[key] || settings[key].includes("\0")) throw new ServiceError("SSH preparation needs host, user, identityFile and knownHostsFile bindings.", 400);
  const host = (settings.host as string).replaceAll("{id}", identifier(machine.id)), user = settings.user as string, port = settings.port ?? 22;
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user) || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new ServiceError("Invalid SSH host, user or port binding.", 400);
  const known = resolve(settings.knownHostsFile as string).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return { argv: ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", `UserKnownHostsFile="${known}"`, "-i", resolve(settings.identityFile as string), "-p", String(port), `${user}@${host}`, image.os === "windows" ? "powershell.exe -NoLogo -NoProfile -NonInteractive -Command -" : "sudo -n sh -s"], input: image.os === "windows" ? powershellScript(prepared, machine) : unixScript(prepared, machine), timeoutSeconds: prepared.timeoutSeconds };
}
export function credential(folder: string): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = resolve(folder, "preparation.json");
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ token: randomBytes(32).toString("base64url") })); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new ServiceError("Preparation state must be a private regular file.", 409);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return secret(object(JSON.parse(readFileSync(fd, "utf8")) as unknown).token); } finally { closeSync(fd); }
}
export function recordPreparation(db: DatabaseSync, machineId: string, hostId: string, value: unknown, now: number): void {
  if (!db.isTransaction) throw new TypeError("Preparation reports require the caller's heartbeat transaction.");
  const v = object(value);
  if (!["pending", "ready", "failed"].includes(String(v.state)) || typeof v.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(v.tokenHash)) throw new ServiceError("Invalid preparation report.", 400);
  const row = db.prepare("SELECT host,preparation_hash,prepared_at,preparation_state FROM machines WHERE id=?").get(identifier(machineId));
  if (!row || row.host !== identifier(hostId)) throw new ServiceError("Cannot report preparation for another host's machine.", 403);
  if (row.preparation_hash && row.preparation_hash !== v.tokenHash) throw new ServiceError("Preparation credential changed; inspect the host identity/state.", 409);
  const state = row.prepared_at || v.state === "ready" ? "ready" : row.preparation_state === "failed" ? "failed" : String(v.state);
  db.prepare("UPDATE machines SET preparation_hash=?,preparation_state=?,prepared_at=? WHERE id=?").run(v.tokenHash, state, Number(row.prepared_at) || (state === "ready" ? now : 0), identifier(machineId));
}
export function preparationReadiness(row: Record<string, unknown>, image: Record<string, unknown>): { preparation: { state: string; completedAt: number | null }; ready: boolean } {
  const required = ![undefined, "none"].includes(image.preparationDriver as "none" | undefined);
  return { preparation: { state: required ? String(row.preparation_state) : "notRequired", completedAt: Number(row.prepared_at) || null }, ready: row.observed === "running" && (!required || !!row.prepared_at) };
}
export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  return { handle(req) {
    if (req.method !== "POST" || !/^\/v1\/machines\/[^/]+\/prepared$/.test(req.path)) return undefined;
    if (req.body.state !== "ready" || Object.keys(req.body).length !== 1) throw new ServiceError("Expected a ready preparation receipt.", 400);
    const id = identifier(req.parts[2]), hash = legacyDigest(secret(req.token));
    return store.transaction(db => {
      const row = db.prepare("SELECT preparation_hash,prepared_at FROM machines WHERE id=?").get(id);
      if (!row || typeof row.preparation_hash !== "string" || row.preparation_hash.length !== hash.length || !timingSafeEqual(Buffer.from(row.preparation_hash), Buffer.from(hash))) throw new ServiceError("Preparation credential rejected.", 401);
      db.prepare("UPDATE machines SET preparation_state='ready',prepared_at=? WHERE id=?").run(Number(row.prepared_at) || store.clock(), id);
      return { body: { prepared: true } };
    });
  } };
}
