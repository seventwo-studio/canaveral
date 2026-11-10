/** Account CLI primitives. Issued credentials are written once, never printed. */
import { constants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { createSecureContext } from "node:tls";
import { secret } from "./errors.ts";

export class CliError extends Error {
  readonly retryable = false;
  constructor(message: string, readonly status = 400, readonly requestId?: string, readonly outcome?: "unknown") { super(message); }
}
export function uuid(value: string): string {
  const compact = value.replace(/^urn:uuid:/i, "").replace(/^\{|\}$/g, "").replaceAll("-", "");
  if (!/^[a-f\d]{32}$/i.test(compact)) throw new CliError("Supply a valid UUID.");
  return `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`.toLowerCase();
}
export function expandPath(path: string): string { return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path; }
export function origin(value: string, allowHttp = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError("Use a controller origin URL."); }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) || /[?#]/.test(value)) {
    throw new CliError("Use an origin URL without credentials, query or path.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (allowHttp || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new CliError("Remote controllers require HTTPS; explicitly allow HTTP only on a trusted private network.");
  }
  return url.origin;
}
export interface RequestClient { request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> }

/** Bounded HTTP transport, no redirects and no retries. Error text cannot echo passwords or credentials. */
export class CliClient implements RequestClient {
  readonly url: string;
  readonly #ca: Buffer | undefined;
  constructor(url: string, readonly token: string, allowHttp = false, ca?: Buffer) {
    this.url = origin(url, allowHttp); this.#ca = ca;
    if (ca && !this.url.startsWith("https:")) throw new CliError("A CA file requires an HTTPS origin.");
    if (ca) { try { createSecureContext({ ca }); } catch { throw new CliError("Could not load the controller CA file."); } }
  }
  async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!path.startsWith("/v1/") || path.includes("#")) throw new CliError("Invalid controller route.");
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (payload && payload.length > 1_048_576) throw new CliError("Request body exceeds 1 MiB.");
    const mutating = method === "POST";
    let id: string | undefined;
    try { if (typeof body?.id === "string") id = uuid(body.id); } catch { /* No invented identity for invalid requests. */ }
    const uncertain = (message: string, status = 503) => new CliError(message, status, id, mutating ? "unknown" : undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const target = new URL(this.url + path);
      const request = (target.protocol === "https:" ? https : http).request(target, {
        method, agent: false, ...(this.#ca ? { ca: this.#ca } : {}), minVersion: "TLSv1.2", rejectUnauthorized: true,
        headers: { Accept: "application/json", "Content-Type": "application/json", Connection: "close",
          ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
          ...(payload ? { "Content-Length": payload.length } : {}) },
      });
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); request.destroy(); reject(error); } };
      const timer = setTimeout(() => fail(uncertain("Controller response was not confirmed. Inspect the original request before another mutation.")), 20_000);
      request.on("error", () => fail(uncertain("Controller response was not confirmed. Inspect the original request before another mutation.")));
      request.on("response", response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { response.resume(); fail(uncertain("Controller redirects are not followed.", status)); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1_048_576) fail(uncertain("Controller response exceeds 8 MiB. Inspect state before retrying.", 502));
          else chunks.push(chunk);
        });
        response.on("error", () => fail(uncertain("Controller response was interrupted. Inspect state before retrying.")));
        response.on("close", () => { if (!response.complete) fail(uncertain("Controller response was incomplete. Inspect state before retrying.")); });
        response.on("end", () => {
          if (settled) return;
          let result: Record<string, unknown>;
          try { result = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); }
          catch { fail(uncertain("Controller returned invalid JSON. Inspect state before another mutation.", 502)); return; }
          if (status < 200 || status >= 300) {
            // Provider diagnostics may contain user input. Only status and safe correlation data leave this client.
            const definite = status >= 400 && status < 500 && status !== 408;
            fail(new CliError(`Controller request failed (HTTP ${status}). Inspect state before retrying.`, status, id, mutating && !definite ? "unknown" : undefined)); return;
          }
          settled = true; clearTimeout(timer); resolve(result);
        });
      });
      request.end(payload);
    });
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("Unexpected controller response. Inspect state before retrying.", 502);
  return value as Record<string, unknown>;
}
export function metadata(value: unknown): Record<string, unknown> {
  const sensitive: string[] = [];
  const secretKey = /^(token|credential|secret|password|currentPassword|enrollmentToken|adminToken|key|hash|passwordHash|sessionHash|claimHash|tokenHash)$/i;
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) { for (const entry of item) collect(entry); }
    else if (item && typeof item === "object") for (const [key, entry] of Object.entries(item)) {
      if (secretKey.test(key) && typeof entry === "string" && entry) sensitive.push(entry); else collect(entry);
    }
  };
  collect(value);
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") { for (const secret of sensitive) item = (item as string).split(secret).join("[redacted]"); return item; }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([key]) => !secretKey.test(key)).map(([key, val]) => [key, clean(val)]));
    return item;
  };
  return clean(record(value)) as Record<string, unknown>;
}
async function sameFile(path: string, info: Stats): Promise<boolean> {
  try { const current = await fs.lstat(path); return current.isFile() && current.dev === info.dev && current.ino === info.ino; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function removeSameFile(path: string, info: Stats): Promise<void> { if (await sameFile(path, info)) await fs.unlink(path); }

/** Reserve before dispatch. Cleanup removes only the inode this call created. */
export async function privateOutput<T>(destination: string, work: (write: (text: string | Buffer) => Promise<void>, path: string) => Promise<T>): Promise<T> {
  const path = expandPath(destination);
  const file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const info = await file.stat();
  try {
    const result = await work(async text => { await file.writeFile(text); }, path);
    await file.sync(); await file.close(); return result;
  } catch (error) {
    await file.close().catch(() => {});
    await removeSameFile(path, info);
    throw error;
  }
}
export async function privateInput(path: string, password = false): Promise<string> {
  const file = await fs.open(expandPath(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new CliError("Use a private regular credential/password file owned by you with mode 0600.");
    }
    const data = Buffer.alloc(4098); const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 4096) throw new CliError("Credential/password file is too large.");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead));
    return password ? value.replace(/[\r\n]+$/, "") : secret(value.trim());
  } finally { await file.close(); }
}
export async function promptPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new CliError("No interactive terminal. Supply a protected password file.");
  process.stderr.write(prompt);
  const wasRaw = process.stdin.isRaw; process.stdin.setRawMode(true); process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = (error?: Error) => { process.stdin.off("data", receive); process.stdin.off("end", ended); error ? reject(error) : resolve(value); };
      const ended = () => finish(new CliError("Password input ended."));
      const receive = (data: Buffer) => {
        for (const char of data.toString("utf8")) {
          if (char === "\r" || char === "\n") { finish(); return; }
          if (char === "\u0003" || char === "\u0004") { finish(new CliError("Password input cancelled.")); return; }
          if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
          else if (char >= " ") value += char;
          if (Buffer.byteLength(value) > 4096) { finish(new CliError("Password is too large.")); return; }
        }
      };
      process.stdin.on("data", receive); process.stdin.once("end", ended);
    });
  } finally { process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write("\n"); }
}
export interface CliArguments {
  command: string; action: string; positionals: string[]; options: Record<string, string | boolean | string[]>;
  url: string; tokenFile?: string; allowHttp: boolean;
}
export function option(args: CliArguments, name: string, fallback?: string): string {
  const value = args.options[name];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new CliError(`Supply --${name}.`);
}
export function positional(args: CliArguments, index = 0): string {
  const value = args.positionals[index]; if (!value) throw new CliError("Missing command argument."); return value;
}
export interface AccountContext {
  client(token: string): RequestClient;
  print(value: unknown): void;
  password(prompt: string): Promise<string>;
  output: typeof privateOutput;
}
async function password(args: CliArguments, key: string, prompt: string, ctx: AccountContext, confirm = false): Promise<string> {
  const path = args.options[key]; if (typeof path === "string") return privateInput(path, true);
  const value = await ctx.password(prompt);
  if (confirm && value !== await ctx.password("Confirm new Canaveral password: ")) throw new CliError("Passwords do not match.");
  return value;
}
export async function credential(args: CliArguments): Promise<string> {
  if (!args.tokenFile) throw new CliError("Supply a credential file; credentials are never command-line values.");
  return privateInput(args.tokenFile);
}
async function link(client: RequestClient, route: string, args: CliArguments, ctx: AccountContext): Promise<void> {
  const url = origin(option(args, "dashboard-url")); const destination = option(args, "output-file");
  const result = await ctx.output(destination, async write => {
    const result = await client.request("POST", route, {});
    await write(url + "/#claim=" + encodeURIComponent(secret(result.token)) + "\n"); return result;
  });
  ctx.print({ ...metadata(result), linkFile: expandPath(destination) });
}
export async function handleAccount(args: CliArguments, ctx: AccountContext): Promise<boolean> {
  if (args.command === "login") {
    const value = await password(args, "password-file", "Canaveral password: ", ctx);
    let session: string | undefined;
    let result: Record<string, unknown>;
    const destination = option(args, "output-file");
    try {
      result = await ctx.output(destination, async write => {
        const result = await ctx.client("").request("POST", "/v1/auth/login", { username: option(args, "username"), password: value });
        session = secret(result.token); await write(session + "\n"); return result;
      });
    } catch (error) {
      if (session) await ctx.client(session).request("POST", "/v1/auth/logout", {}).catch(() => {});
      throw error;
    }
    ctx.print({ ...metadata(result), credentialFile: expandPath(destination) }); return true;
  }
  if (!["logout", "account", "users", "tokens", "admin"].includes(args.command)) return false;
  const client = ctx.client(await credential(args));
  if (args.command === "logout" || args.command === "account") {
    const path = expandPath(args.tokenFile!);
    if (args.command === "logout") await client.request("GET", "/v1/auth/session");
    const info = await fs.lstat(path);
    if (args.command === "logout") await client.request("POST", "/v1/auth/logout", {});
    else {
      const current = await password(args, "current-password-file", "Current Canaveral password: ", ctx);
      const next = await password(args, "password-file", "New Canaveral password: ", ctx, true);
      await client.request("POST", "/v1/auth/password", { currentPassword: current, password: next });
    }
    await removeSameFile(path, info);
    ctx.print({ ok: true, message: args.command === "logout" ? "Signed out. The login session is revoked." : "Password changed. Sign in again; previous sessions and personal API tokens are revoked." });
  } else if (args.command === "tokens") {
    if (args.action === "list") ctx.print(metadata(await client.request("GET", "/v1/auth/tokens")));
    else if (args.action === "revoke") ctx.print(metadata(await client.request("POST", `/v1/auth/tokens/${uuid(positional(args))}/revoke`, {})));
    else {
      const id = uuid(option(args, "request-id")); const expires = Number(option(args, "expires-in", "2592000"));
      if (!Number.isSafeInteger(expires) || expires < 60 || expires > 31_536_000) throw new CliError("Token expiry must be 60–31536000 seconds.");
      const scopes = args.options.scope;
      if (!Array.isArray(scopes) || !scopes.length) throw new CliError("Supply at least one --scope.");
      let issued = false;
      const destination = option(args, "output-file");
      let result: Record<string, unknown>;
      try {
        result = await ctx.output(destination, async write => {
          const result = await client.request("POST", "/v1/auth/tokens", { id, name: option(args, "name"), scopes: [...new Set(scopes)].sort(), expiresInSeconds: expires });
          if (result.id !== id) throw new CliError("Token creation was not confirmed for this request. Inspect your token list before retrying.", 502, id, "unknown");
          if (!result.token) throw new CliError("This token's secret was already issued. Revoke it, then create a replacement with a new request ID.", 409, id);
          const token = secret(result.token); issued = true; await write(token + "\n"); return result;
        });
      } catch (error) {
        if (issued) {
          try { await client.request("POST", `/v1/auth/tokens/${id}/revoke`, {}); }
          catch { throw new CliError(`Token file could not be saved. Inspect and revoke token ${id} before creating another.`, 503, id, "unknown"); }
        }
        throw error;
      }
      ctx.print({ ...metadata(result), credentialFile: expandPath(destination) });
    }
  } else if (args.command === "admin") {
    if (args.action === "setup-link" || args.action === "recover") {
      await link(client, args.action === "setup-link" ? "/v1/auth/bootstrap" : `/v1/users/${uuid(option(args, "user-id"))}/reset-password`, args, ctx);
    } else {
      const status = await client.request("GET", "/v1/auth/status");
      if (status.setupRequired !== true) { ctx.print({ message: "An administrator already exists; no changes made." }); return true; }
      const value = await password(args, "password-file", "New administrator password: ", ctx, true);
      const result = await client.request("POST", "/v1/auth/setup", { username: option(args, "username", "admin"), password: value });
      await ctx.client(secret(result.token)).request("POST", "/v1/auth/logout", {});
      ctx.print({ user: metadata(record(result.user)), message: "Created administrator." });
    }
  } else if (args.action === "list") ctx.print(metadata(await client.request("GET", "/v1/users")));
  else if (args.action === "create") {
    const id = uuid(option(args, "request-id"));
    const result = await client.request("POST", "/v1/users", { id, username: option(args, "username"), role: option(args, "role", "user") });
    if (result.id !== id) throw new CliError("User creation was not confirmed. Inspect the user list before retrying.", 502, id, "unknown");
    ctx.print(metadata(result));
  } else {
    const route = `/v1/users/${uuid(positional(args))}`;
    if (args.action === "update") {
      const body: Record<string, unknown> = {};
      for (const key of ["role", "status"]) if (args.options[key] !== undefined) body[key] = args.options[key];
      if (!Object.keys(body).length) throw new CliError("Supply --role or --status.");
      ctx.print(metadata(await client.request("POST", route + "/update", body)));
    } else if (args.action === "revoke-invite") ctx.print(metadata(await client.request("POST", route + "/revoke-invite", {})));
    else await link(client, route + "/" + args.action, args, ctx);
  }
  return true;
}
