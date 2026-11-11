import { signedGuestProvision } from "../updates/guest.ts";
import type { SignedGuestPreparation } from "../updates/guest.ts";
import { componentTargetKey, parseComponentReport } from "../updates/components.ts";
import type { ComponentAdoptionRequest, ComponentAdoptionReceipt } from "../updates/components.ts";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer as createTCPServer } from "node:net";
import { constants, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noLinks, present, privateDirectory, ProcessSupervisor, readRecord, saveRecord } from "../runtime-process.ts";
import { ServiceError, object } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { copyUpload, guestPath, jsonBytes, transferSize, uuid } from "../control/transfers.ts";
import type { ByteReader, VerifiedDownload } from "../control/transfers.ts";
import type { DisplayConnection } from "./display.ts";
import { InputDenied } from "./display.ts";
import { authorized } from "./https.ts";
import type { Authority } from "./https.ts";

export function guestReady(value: unknown, image: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).ready !== true) return false;
  const mode = (value as Record<string, unknown>).mode;
  return mode === undefined ? image.mode === "desktop" : mode === image.mode;
}
/** Resolve only literal assignment addresses. This never performs discovery by an untrusted name. */
export function guestHost(machineId: string, configured: string | undefined, provider: string, dhcpLeases = ""): string {
  uuid(machineId);
  if (configured) {
    const host = configured.replaceAll("{id}", machineId);
    if (!isIP(host)) throw new ServiceError("Guest access requires a configured literal address.", 409);
    return host;
  }
  if (provider !== "apple") throw new ServiceError("Configure a guest address for this backend.", 409);
  const hex = machineId.replaceAll("-", "").slice(0, 10), mac = `02:${hex.match(/../g)!.join(":")}`.toLowerCase();
  for (const block of dhcpLeases.split("}")) {
    const hw = /hw_address=1,([^\s]+)/.exec(block)?.[1], address = /ip_address=([^\s]+)/.exec(block)?.[1], name = /name=([^\s]+)/.exec(block)?.[1];
    const normalized = hw?.toLowerCase().split(":").slice(-6).map(p => p.padStart(2, "0")).join(":");
    if (address && (normalized === mac || name === `cvm-${machineId}`)) {
      if (!isIP(address) || !privateAddress(address)) throw new ServiceError("Owned guest address is not private.", 409);
      return address;
    }
  }
  throw new ServiceError("Waiting for the owned guest DHCP address.", 503, { retryable: false });
}
function privateAddress(value: string): boolean {
  if (isIP(value) === 6) return /^(?:f[cd]|fe[89ab])/i.test(value) || value === "::1";
  const [a, b] = value.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
export interface HelperArtifact { path: string; content: string; mode: string }
export interface GuestRecipe { driver: "cloud-init"; user: "desktop"; sshAuthorizedKeys: string[]; packages: string[]; files: HelperArtifact[]; commands: string[]; timeoutSeconds: number }
/** The build supplies the bundled TS guest service and its native helper artifacts. No legacy payload. */
export function guestRecipe(publicKey: string, mode: "desktop" | "headless", helpers: readonly HelperArtifact[]): GuestRecipe {
  if (!["desktop", "headless"].includes(mode) || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(publicKey)) throw new ServiceError("Invalid guest recipe profile or public key.", 400);
  if (!helpers.some(f => f.path === "/opt/canaveral/server.mjs" && f.content.length > 0) || helpers.some(f => !f.path.startsWith("/opt/canaveral/") || !/^0[0-7]{3}$/.test(f.mode))) throw new ServiceError("The TypeScript guest service bundle must be installed before readiness.", 409, { code: "capability_unsupported" });
  const service = `canaveral-${mode}`, other = mode === "desktop" ? "headless" : "desktop";
  const files = helpers.map(f => ({ ...f }));
  files.push({ path: `/etc/systemd/system/${service}.service`, mode: "0644", content: `[Unit]\nDescription=Canaveral owned ${mode} guest services\nAfter=network.target\n[Service]\nUser=desktop\nGroup=desktop\nWorkingDirectory=/home/desktop\nEnvironment=CANAVERAL_GUEST_MODE=${mode}\nExecStart=${mode === "desktop" ? "/usr/bin/dbus-run-session -- /opt/canaveral/start-desktop" : "/usr/local/bin/node /opt/canaveral/server.mjs /opt/canaveral/token --guest-confirmed"}\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n` });
  files.push({ path: "/etc/sudoers.d/canaveral-desktop", mode: "0440", content: "desktop ALL=(ALL) NOPASSWD:ALL\n" });
  if (mode === "desktop") files.push({ path: "/opt/canaveral/start-desktop", mode: "0755", content: "#!/bin/sh\nset -eu\nexport DISPLAY=:1 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge XDG_RUNTIME_DIR=/tmp/canaveral-runtime\nmkdir -p \"$XDG_RUNTIME_DIR\"; chmod 700 \"$XDG_RUNTIME_DIR\"\n/usr/bin/Xtigervnc :1 -geometry 1440x900 -depth 24 -SecurityTypes None -localhost yes &\ntrap 'kill $(jobs -p) 2>/dev/null || true' EXIT\nfor attempt in $(seq 1 50); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep .2; done\ngsettings set org.gnome.desktop.interface toolkit-accessibility true || true\nxfce4-session &\nexec /usr/local/bin/node /opt/canaveral/server.mjs /opt/canaveral/token --guest-confirmed\n" });
  return { driver: "cloud-init", user: "desktop", sshAuthorizedKeys: [publicKey], packages: ["curl", "openssh-server", ...(mode === "desktop" ? ["xfce4", "xfce4-terminal", "tigervnc-standalone-server", "dbus-x11", "at-spi2-core", "x11-utils", "scrot"] : [])], files,
    commands: ["/usr/local/bin/node -e 'if(parseInt(process.versions.node,10)<24)process.exit(1)'", "chown -R desktop:desktop /opt/canaveral /home/desktop", ...(helpers.some(f => f.path === "/opt/canaveral/install.mjs") ? ["/usr/local/bin/node /opt/canaveral/install.mjs"] : []), `if systemctl cat canaveral-${other}.service >/dev/null 2>&1; then systemctl disable --now canaveral-${other}.service; fi`, "systemctl daemon-reload", "systemctl restart ssh", `systemctl enable ${service} && systemctl restart ${service}`, "for attempt in $(seq 1 120); do curl --fail --silent http://127.0.0.1:8769/healthz && exit 0; sleep 2; done; exit 1", "touch /opt/canaveral/prepared"], timeoutSeconds: mode === "desktop" ? 3600 : 1800 };
}
export function prepareRecipe(recipe: GuestRecipe, machineId: string, token: string, hostKey: string, hostPublicKey: string, helpers: readonly HelperArtifact[], mode?: "desktop" | "headless"): GuestRecipe {
  uuid(machineId);
  if (!/^[\x21-\x7e]{32,4096}$/.test(token)) throw new ServiceError("Invalid assignment guest credential.", 400);
  const profile = guestRecipe(recipe.sshAuthorizedKeys[0]!, mode ?? (recipe.files.some(f => f.path.endsWith("canaveral-headless.service")) ? "headless" : "desktop"), helpers);
  const legacy = ["server.py", "inspect_linux.py", "action_linux.py", ...["__init__.py", "model.py", "lease_clock.py", "accessibility.py", "shell_sessions.py", "transfers.py"].map(p => `canaveral/${p}`)].map(p => `/opt/canaveral/${p}`);
  const result = structuredClone(recipe), managed = new Set([...profile.files.map(f => f.path), ...legacy]);
  result.files = result.files.filter(f => !managed.has(f.path)).concat(profile.files, [
    { path: "/opt/canaveral/token", content: token, mode: "0600" }, { path: "/etc/ssh/ssh_host_ed25519_key", content: hostKey, mode: "0600" }, { path: "/etc/ssh/ssh_host_ed25519_key.pub", content: hostPublicKey, mode: "0644" },
  ]);
  result.packages = [...new Set([...result.packages, ...profile.packages])];
  result.commands = ["chown desktop:desktop /opt/canaveral/token", ...(helpers.some(f => f.path === "/opt/canaveral/install.mjs") ? ["/usr/local/bin/node /opt/canaveral/install.mjs"] : []), ...result.commands.filter(c => c !== "touch /opt/canaveral/prepared" && c !== "/usr/local/bin/node /opt/canaveral/install.mjs"), `sync; touch /var/lib/canaveral/${machineId}/complete; sync; touch /opt/canaveral/prepared; sync`];
  return result;
}
export interface GuestBinding {
  /** The host owns the verified SSH tunnel, pinned preinstalled host key, and assignment credentials. */
  port: number;
  credential: string;
  authorized: Authority;
  desktop?(): Promise<DisplayConnection>;
  close(): Promise<void>;
}
export type GuestResolver = (machine: Record<string, unknown>, image: Record<string, unknown>, folder: string) => Promise<GuestBinding>;
function transportError(mutation: boolean): ServiceError { return new ServiceError("Guest transport was not confirmed; inspect before retrying.", 503, { retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}) }); }
/** HTTP is confined to an assignment-owned loopback SSH forward, never an arbitrary caller URL. */
export class GuestAccess {
  private readonly bindings = new Map<string, GuestBinding>();
  private readonly pending = new Set<Promise<GuestBinding>>();
  private stopped = false;
  private readonly failures = new Map<string, { count: number; until: number }>();
  constructor(readonly resolve: GuestResolver, readonly store?: SqliteStore) {
    store?.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS guest_shutdown_receipts(machine TEXT PRIMARY KEY,boot TEXT NOT NULL,session TEXT NOT NULL)"));
  }
  connectionFailed(key: string): void { const count = Math.min(6, (this.failures.get(key)?.count ?? 0) + 1); this.failures.set(key, { count, until: performance.now() + Math.min(60, 2 ** count) * 1000 }); }
  connectionSucceeded(key: string): void { this.failures.delete(key); }
  isClosed(): boolean { return this.stopped; }
  private binding(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<GuestBinding> {
    const work = this.openBinding(machine, image, folder); this.pending.add(work);
    return work.finally(() => { this.pending.delete(work); });
  }
  private async openBinding(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<GuestBinding> {
    if (this.stopped) throw new ServiceError("Guest access is stopping.", 410);
    const id = uuid(machine.id);
    if ((this.failures.get(id)?.until ?? 0) > performance.now()) throw new ServiceError("Guest connection retry is backing off.", 503, { retryable: false });
    const b = await this.resolve(machine, image, folder);
    if (this.stopped) { this.bindings.set(id, b); await this.closeMachine(id); throw new ServiceError("Guest access stopped before opening acknowledgement.", 410); }
    if (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535 || !/^[\x21-\x7e]{32,4096}$/.test(b.credential) || !authorized(b.authorized)) throw new ServiceError("Owned guest connection binding is unavailable.", 410, { retryable: false });
    this.bindings.set(id, b); return b;
  }
  private open(b: GuestBinding, method: string, route: string, headers: Record<string, string | number> = {}, timeout = 25000): { request: ClientRequest; response: Promise<IncomingMessage> } {
    if (!authorized(b.authorized)) throw new ServiceError("Guest authorization ended.", 410);
    let request!: ClientRequest;
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      request = httpRequest({ host: "127.0.0.1", port: b.port, method, path: route, agent: false, headers: { Authorization: `Bearer ${b.credential}`, "Accept-Encoding": "identity", Connection: "close", ...headers } }, value => {
        if (!authorized(b.authorized)) { value.destroy(); reject(transportError(method !== "GET" && method !== "HEAD")); return; }
        if (value.headers["content-encoding"] !== undefined && value.headers["content-encoding"] !== "identity") { value.destroy(); reject(transportError(method !== "GET" && method !== "HEAD")); return; }
        resolve(value);
      });
      request.on("error", () => reject(transportError(method !== "GET" && method !== "HEAD")));
      request.setTimeout(timeout, () => request.destroy());
    });
    // Suppress an early socket rejection until the sender reaches the response await.
    void response.catch(() => {});
    return { request, response };
  }
  private async json(b: GuestBinding, method: string, route: string, body: Buffer, headers: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const { request, response } = this.open(b, method, route, { "Content-Type": "application/json", "Content-Length": body.length, ...headers });
    const timer = setTimeout(() => request.destroy(), 12000);
    try {
      request.end(body); const r = await response, chunks: Buffer[] = []; let size = 0;
      for await (const part of r) {
        if (!authorized(b.authorized)) throw transportError(method === "POST");
        const data = Buffer.from(part as Uint8Array); size += data.length;
        if (size > (r.statusCode === 200 ? 6 * 1048576 : 4096)) throw transportError(method === "POST");
        chunks.push(data);
      }
      if (!authorized(b.authorized) || !r.complete) throw transportError(method === "POST");
      const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); jsonBytes(value, 6 * 1048576);
      if (r.statusCode !== 200) {
        if (r.statusCode === 409 && ["input_rejected", "capability_unsupported"].includes(value.code as string)) throw new InputDenied("Guest input was refused before dispatch.", 409, { code: value.code as string, retryable: false });
        throw transportError(method === "POST");
      }
      return value;
    } catch (error) { if (error instanceof InputDenied) throw error; throw transportError(method === "POST"); }
    finally { clearTimeout(timer); request.destroy(); }
  }
  /** Fixed adoption protocol over the current assignment-owned authenticated SSH tunnel. */
  async adoption(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, request: ComponentAdoptionRequest, inspect: boolean): Promise<ComponentAdoptionReceipt | undefined> {
    if (request.target.component !== "guest" || request.target.machineId !== machine.id || image.os !== "linux") throw new ServiceError("Guest adoption ownership differs.", 409);
    const b = await this.binding(machine, image, folder);
    const value = await this.json(b, "POST", "/control", jsonBytes({ action: inspect ? "update-inspect" : "update-acknowledge", arguments: request }, 1048576));
    if (value.absent === true && inspect) return undefined;
    const parsed = parseComponentReport({ ...value, sequence: 1 });
    const { sequence: _sequence, ...receipt } = parsed;
    if (receipt.state === "intent" || componentTargetKey(receipt.target) !== componentTargetKey(request.target) || (["jobId", "attemptId", "installationId", "releaseId", "fileSetDigest"] as const).some(k => receipt[k] !== request[k])) throw transportError(true);
    return receipt as ComponentAdoptionReceipt;
  }
  async control(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (image.mode === "headless" && ["screenshot", "hierarchy", "accessibility", "accessibility-action", "tap", "swipe", "text", "key"].includes(request.action as string)) throw new InputDenied("This headless guest has no graphical control or accessibility service.", 409, { code: "capability_unsupported" });
    const b = await this.binding(machine, image, folder);
    try { const value = await this.json(b, "POST", "/control", jsonBytes(request, 1048576)); this.connectionSucceeded(uuid(machine.id)); return value; }
    catch (error) { if (!(error instanceof InputDenied)) this.connectionFailed(uuid(machine.id)); throw error; }
  }
  async shutdown(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, boot: string): Promise<void> {
    if (!this.store) throw new ServiceError("Durable shutdown receipts require a host store.", 409, { code: "capability_unsupported" });
    const machineId = uuid(machine.id), session = randomUUID();
    const dispatch = this.store.transaction(db => {
      const prior = db.prepare("SELECT boot FROM guest_shutdown_receipts WHERE machine=?").get(machineId) as { boot: string } | undefined;
      if (prior?.boot === boot) return false;
      db.prepare("INSERT INTO guest_shutdown_receipts VALUES(?,?,?) ON CONFLICT(machine) DO UPDATE SET boot=excluded.boot,session=excluded.session").run(machineId, boot, session); return true;
    });
    if (!dispatch) return;
    await this.control(machine, image, folder, { action: "shell-open", arguments: { session } });
    await this.control(machine, image, folder, { action: "shell-write", arguments: { session, text: "sudo -n systemctl poweroff\n" } });
  }
  async streamUpload(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, path: string, app: string | undefined, reader: ByteReader, size: number, check: Authority): Promise<Record<string, unknown>> {
    if (app !== undefined) throw new ServiceError("Linux guest files do not use app containers.", 400);
    guestPath(path, "absolute"); transferSize(size);
    if (!authorized(check)) throw new ServiceError("Upload authorization ended before opening the guest connection.", 401);
    const b = await this.binding(machine, image, folder), guard = { authorized: () => authorized(check) && authorized(b.authorized) };
    const { request, response } = this.open(b, "PUT", "/file", { "Content-Length": size, "X-Canaveral-Path": encodeURIComponent(path) });
    let sent = false;
    try {
      sent = true;
      await copyUpload(reader, { write: data => new Promise<number>((resolve, reject) => request.write(data, error => error ? reject(error) : resolve(data.length))) }, size, guard);
      request.end(); const r = await response, parts: Buffer[] = []; let count = 0;
      for await (const part of r) { if (!guard.authorized()) throw transportError(true); count += (part as Buffer).length; if (count > 8192) throw transportError(true); parts.push(Buffer.from(part as Uint8Array)); }
      const result = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))));
      if (!r.complete || r.statusCode !== 200 || !guard.authorized() || result.uploaded !== size || result.durable !== true) throw transportError(true);
      return result;
    } catch { throw new ServiceError("Guest upload publication may have occurred; inspect before retrying.", 409, { code: "upload_publication_uncertain", retryable: false, ...(sent ? { outcome: "unknown" as const } : {}) }); }
    finally { request.destroy(); }
  }
  async streamDownload(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, path: string, app?: string, check: Authority = () => true): Promise<VerifiedDownload> {
    if (app !== undefined) throw new ServiceError("Linux guest files do not use app containers.", 400);
    guestPath(path, "absolute"); if (!authorized(check)) throw new ServiceError("Download authorization ended.", 401);
    const b = await this.binding(machine, image, folder), live = () => authorized(check) && authorized(b.authorized);
    const headers = { "X-Canaveral-Path": encodeURIComponent(path) }, { request, response } = this.open(b, "GET", "/file", headers);
    request.end(); let r: IncomingMessage;
    try { r = await response; } catch (error) { request.destroy(); throw error; }
    const identity = r.headers["x-canaveral-file-identity"], length = r.headers["content-length"];
    if (r.statusCode !== 200 || typeof identity !== "string" || !/^[0-9a-f]{64}$/.test(identity) || typeof length !== "string" || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) { request.destroy(); throw new ServiceError("Guest download identity or length is unavailable.", 409); }
    let closed = false, remaining = Number(length), busy = false;
    const source: VerifiedDownload = {
      size: remaining,
      read: async maximum => {
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1048576) throw new ServiceError("Use a bounded guest download read.", 400);
        if (closed || !live()) throw new ServiceError("Download authorization ended.", 401);
        if (busy) throw new ServiceError("Download already has a read in flight.", 409);
        if (!maximum || !remaining) return Buffer.alloc(0);
        busy = true;
        try {
          const data = await readResponse(r, Math.min(maximum, remaining));
          if (closed || !live()) throw new ServiceError("Download authorization ended during read.", 401);
          if (!data.length || data.length > remaining) throw new ServiceError("Guest download source ended early.", 409);
          remaining -= data.length; return data;
        } finally { busy = false; }
      },
      verify: async () => {
        if (closed || !live()) throw new ServiceError("Download authorization ended.", 401);
        const probe = this.open(b, "HEAD", "/file", headers, 12000), timer = setTimeout(() => probe.request.destroy(), 12000);
        try {
          probe.request.end(); const current = await probe.response; current.resume();
          return live() && current.statusCode === 200 && current.headers["x-canaveral-file-identity"] === identity && current.headers["content-length"] === length;
        } finally { clearTimeout(timer); probe.request.destroy(); }
      },
      close: () => { closed = true; request.destroy(); },
    };
    return source;
  }
  async desktop(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string): Promise<DisplayConnection> {
    if (image.mode === "headless") throw new ServiceError("This headless guest has no graphical display.", 409, { code: "capability_unsupported" });
    const b = await this.binding(machine, image, folder);
    if (!b.desktop) throw new ServiceError("The host must attach its private verified SSH display channel.", 409, { code: "capability_unsupported" });
    const connection = await b.desktop(); if (!authorized(b.authorized)) { await connection.close(); throw new ServiceError("Guest authorization ended.", 410); } return connection;
  }
  async closeMachine(id: string): Promise<void> { const b = this.bindings.get(id); if (b) { await b.close(); this.bindings.delete(id); } }
  async sweep(active: ReadonlySet<string>): Promise<void> { for (const id of this.bindings.keys()) if (!active.has(id)) await this.closeMachine(id); }
  async close(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.pending]); await this.sweep(new Set()); }
}
async function readResponse(response: IncomingMessage, maximum: number): Promise<Buffer> {
  for (;;) {
    const data = response.read(Math.min(maximum, response.readableLength || maximum)) as Buffer | null;
    if (data) return data;
    if (response.destroyed || response.readableEnded) return Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { response.off("readable", ready); response.off("end", ready); response.off("close", ready); response.off("error", fail); clearTimeout(timer); };
      const ready = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(transportError(false)); };
      const timer = setTimeout(fail, 25000);
      response.once("readable", ready); response.once("end", ready); response.once("close", ready); response.once("error", fail);
    });
  }
}

/** Release artifacts are supplied explicitly; reading a manifest neither installs nor launches a guest. */
export function loadHelperArtifacts(manifest: string): HelperArtifact[] {
  noLinks(manifest);
  const data = readFileSync(manifest);
  if (data.length > 128 * 1048576) throw new ServiceError("Guest bundle manifest exceeds its envelope.", 413);
  const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  if (!Array.isArray(values) || !values.length || values.length > 4096) throw new ServiceError("Invalid guest bundle manifest.", 400);
  const files = values.map(item => {
    const value = object(item);
    if (Object.keys(value).sort().join() !== "content,mode,path" || typeof value.path !== "string" || !value.path.startsWith("/opt/canaveral/") || value.path.split("/").includes("..") || value.path.includes("\0") || typeof value.content !== "string" || !/^0[0-7]{3}$/.test(String(value.mode))) throw new ServiceError("Invalid guest bundle artifact.", 400);
    return { path: value.path, content: value.content, mode: value.mode as string };
  });
  if (new Set(files.map(f => f.path)).size !== files.length) throw new ServiceError("Duplicate guest bundle artifact.", 400);
  return files;
}
export function desktopRecipe(publicKey: string, helpers?: readonly HelperArtifact[]): GuestRecipe {
  const manifest = process.env.CANAVERAL_GUEST_BUNDLE;
  return guestRecipe(publicKey, "desktop", helpers ?? (manifest ? loadHelperArtifacts(manifest) : []));
}
function sshOptions(identityFile: string, known: string, host: string): string[] {
  const quoted = `"${known.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${quoted}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-i", identityFile, `desktop@${host}`];
}
async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([ended, new Promise<never>((_resolve, reject) => { if (timer) clearTimeout(timer); timer = setTimeout(() => reject(new ServiceError("Owned guest connection has not closed.", 409, { outcome: "unknown", retryable: false })), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function processConnection(child: ChildProcessWithoutNullStreams): DisplayConnection {
  let closed = false;
  return {
    async read(maximum, timeoutSeconds = 0.1) {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536) throw new ServiceError("Use bounded SSH display reads.", 400);
      const stream = child.stdout;
      if (!stream.readableLength && !stream.destroyed && !stream.readableEnded && !closed) await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); }, error = () => { cleanup(); reject(transportError(false)); };
        const cleanup = () => { clearTimeout(timer); stream.off("readable", done); stream.off("end", done); stream.off("close", done); stream.off("error", error); };
        const timer = setTimeout(done, Math.max(0, timeoutSeconds * 1000));
        stream.once("readable", done); stream.once("end", done); stream.once("close", done); stream.once("error", error);
      });
      const value = stream.read(Math.min(maximum, stream.readableLength || maximum)) as Buffer | null;
      return value ?? (closed || stream.destroyed || stream.readableEnded ? Buffer.alloc(0) : null);
    },
    async write(data) {
      if (closed) throw transportError(true);
      await new Promise<void>((resolve, reject) => child.stdin.write(data, error => error ? reject(transportError(true)) : resolve()));
    },
    async close() { if (!closed) { closed = true; child.stdin.destroy(); child.stdout.destroy(); } await stopChild(child); },
  };
}
/** Default host adapter. SSH destinations and keys come from the assignment, never consumer request bodies. */
export function createGuestAccess(config: Record<string, unknown>, state: string): GuestAccess & { prepare(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, provision?: SignedGuestPreparation): Promise<Record<string, unknown>> } {
  const connections = new Map<string, { binding: GuestBinding; child: ChildProcessWithoutNullStreams; folder: string }>();
  const opening = new Map<string, Promise<GuestBinding>>();
  const processes = new ProcessSupervisor();
  const settings = (image: Record<string, unknown>): Record<string, unknown> => {
    if (config.guestAccess && typeof config.guestAccess === "object") return object(config.guestAccess);
    const runtimes = config.runtimes && typeof config.runtimes === "object" ? object(config.runtimes) : {};
    for (const [kind, raw] of Object.entries(runtimes)) {
      if ((kind === "apple" || kind === "libvirt") && image.os === "linux") {
        const value = object(raw); if (value.guestAccess) return object(value.guestAccess);
      }
    }
    throw new ServiceError("Configure assignment-owned Linux guest SSH access.", 409, { code: "capability_unsupported", retryable: false });
  };
  const access = new GuestAccess(async (machine, image, folder) => {
    const id = uuid(machine.id), previous = connections.get(id);
    if (previous && previous.folder === folder && previous.binding.authorized()) return previous.binding;
    if (previous) { await previous.binding.close(); connections.delete(id); }
    const pending = opening.get(id); if (pending) return pending;
    const work = (async (): Promise<GuestBinding> => {
      const options = settings(image), identity = options.identityFile;
      if (typeof identity !== "string" || !identity) throw new ServiceError("A guest SSH identity file is required.", 409);
      noLinks(identity); noLinks(folder);
      const address = object(image.ssh ?? {}).host;
      let leases = "";
      if (address === undefined && (config.provider === "apple" || object(config.runtimes ?? {}).apple)) {
        try { leases = readFileSync("/var/db/dhcpd_leases", "utf8"); } catch { throw new ServiceError("Waiting for the owned guest DHCP address.", 503, { retryable: false }); }
      }
      const host = guestHost(id, typeof address === "string" ? address : undefined, leases ? "apple" : String(config.provider), leases);
      const pub = readFileSync(join(folder, "ssh_host_ed25519_key.pub"), "utf8").trim().split(/\s+/);
      if (pub[0] !== "ssh-ed25519" || !pub[1] || !/^[A-Za-z0-9+/=]+$/.test(pub[1])) throw new ServiceError("The preinstalled guest SSH host key is unavailable.", 409);
      const known = join(folder, "known_hosts"); noLinks(known);
      const fd = openSync(known, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, `${host} ${pub[0]} ${pub[1]}\n`); } finally { closeSync(fd); }
      const token = readRecord(join(folder, "access-token.json")).token;
      if (typeof token !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(token)) throw new ServiceError("Invalid assignment guest credential.", 409);
      const port = await new Promise<number>((resolve, reject) => { const reservation = createTCPServer(); reservation.once("error", reject); reservation.listen(0, "127.0.0.1", () => { const address = reservation.address(); if (!address || typeof address === "string") { reservation.close(); reject(transportError(false)); return; } reservation.close(error => error ? reject(error) : resolve(address.port)); }); });
      const argv = sshOptions(identity, known, host), destination = argv.pop()!;
      const child = spawn("ssh", ["-N", ...argv, "-L", `127.0.0.1:${port}:127.0.0.1:8769`, destination], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {}); child.stdout.resume(); child.stderr.resume();
      let launchError = false; child.on("error", () => { launchError = true; });
      const displays = new Set<DisplayConnection>(); let closed = false;
      const binding: GuestBinding = {
        port, credential: token, authorized: () => !closed && !launchError && child.exitCode === null && child.signalCode === null,
        desktop: async () => {
          if (!binding.authorized()) throw transportError(false);
          // OpenSSH's fixed -W destination replaces the legacy inline relay program.
          const displayChild = spawn("ssh", [...argv, "-W", "127.0.0.1:5901", destination], { stdio: ["pipe", "pipe", "pipe"] });
          displayChild.on("error", () => {}); displayChild.stdin.on("error", () => {}); displayChild.stderr.resume();
          const connection = processConnection(displayChild), close = connection.close.bind(connection);
          connection.close = async () => { await close(); displays.delete(connection); };
          displays.add(connection); return connection;
        },
        close: async () => {
          closed = true;
          const results = await Promise.allSettled([...displays].map(d => d.close()));
          await stopChild(child);
          if (results.some(r => r.status === "rejected")) throw new ServiceError("Owned guest display connection closure remains uncertain.", 409, { outcome: "unknown", retryable: false });
          connections.delete(id);
        },
      };
      connections.set(id, { binding, child, folder });
      const deadline = performance.now() + 7000;
      while (performance.now() < deadline && binding.authorized()) {
        const reached = await new Promise<boolean>(resolve => { const probe = createConnection({ host: "127.0.0.1", port }); probe.once("connect", () => { probe.destroy(); resolve(true); }); probe.once("error", () => { probe.destroy(); resolve(false); }); probe.setTimeout(200, () => { probe.destroy(); resolve(false); }); });
        if (reached) return binding;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await binding.close(); throw transportError(false);
    })();
    opening.set(id, work); try { return await work; } finally { opening.delete(id); }
  }, new SqliteStore(join(state, "guest-access.sqlite")));
  return Object.assign(access, {
    async close(): Promise<void> { await GuestAccess.prototype.close.call(access); await processes.close(); },
    async prepare(machine: Record<string, unknown>, image: Record<string, unknown>, folder: string, provision?: SignedGuestPreparation): Promise<Record<string, unknown>> {
      if (access.isClosed()) throw new ServiceError("Guest access is stopping.", 410);
      const options = settings(image), manifest = options.helperManifest ?? config.guestHelperManifest ?? process.env.CANAVERAL_GUEST_BUNDLE;
      if (!provision && typeof manifest !== "string") throw new ServiceError("A runnable TypeScript guest service bundle is required before preparation.", 409, { code: "capability_unsupported", retryable: false });
      if (provision && (image.mode !== "headless" || image.os !== "linux" || provision.identity.machineId !== machine.id)) throw new ServiceError("Signed guest preparation requires the matching headless Linux assignment.", 409, { code: "capability_unsupported" });
      // This prepares cloud-init data only. The provider must establish fresh/stopped ownership before applying it.
      const helpers = provision ? signedGuestProvision(provision.release, provision.trustedKeys, provision.directory, provision.context, provision.identity) : loadHelperArtifacts(manifest as string);
      if (image.mode !== "headless" && image.mode !== "desktop") throw new ServiceError("Invalid Linux guest profile.", 400);
      uuid(machine.id); privateDirectory(folder);
      const tokenPath = join(folder, "access-token.json");
      if (!present(tokenPath)) saveRecord(tokenPath, { token: randomBytes(32).toString("base64url") });
      const key = join(folder, "ssh_host_ed25519_key"); noLinks(key);
      if (!present(key)) {
        const result = await processes.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], { folder, machine, timeoutMs: 10000 });
        if (result.code !== 0) throw new ServiceError("Guest SSH host key generation failed.", 409);
      }
      const recipe = prepareRecipe(object(image.prepare) as unknown as GuestRecipe, String(machine.id), String(readRecord(tokenPath).token), readFileSync(key, "utf8"), readFileSync(`${key}.pub`, "utf8"), helpers, image.mode);
      return { ...structuredClone(image), prepare: recipe };
    },
  });
}
