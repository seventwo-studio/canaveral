import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { PreviewResponse } from "./linux-preview.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const cookieName = "__Host-canaveral_preview";
const opaque = () => randomBytes(32).toString("base64url");
interface Target { leaseId: string; operationId: string; leaseKey: string }
type Resolve = (session: string, previewId: string) => Promise<Target | undefined>;
type ReadAsset = (binding: Target, method: "GET" | "HEAD", path: string) => Promise<PreviewResponse>;

export function controllerPreviewReader(origin: URL, ca?: Buffer): ReadAsset {
  return async (binding, method, target) => new Promise((resolve, reject) => {
    const request = (origin.protocol === "https:" ? httpsRequest : httpRequest)(origin, {
      method, path: `/v1/leases/${binding.leaseId}/previews/${binding.operationId}${target}`,
      ca, signal: AbortSignal.timeout(20_000), headers: { Authorization: "Bearer " + binding.leaseKey },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) response.destroy(new Error("Preview response too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 502;
        // Controller failures and redirects can contain internal details.
        if (status < 200 || status >= 300) { reject(new Error("Preview unavailable")); return; }
        const length = response.headers["content-length"];
        resolve({ status, contentType: response.headers["content-type"] ?? "application/octet-stream",
          body: Buffer.concat(chunks), ...(length === undefined ? {} : { contentLength: Number(length) }) });
      });
    });
    request.on("error", reject);
    request.end();
  });
}
interface Grant { session: string; previewId: string; host: string; expires: number; redeemed: boolean }

export class PrivatePreviewGateway {
  private grants = new Map<string, Grant>();
  // Controller dispatch permits one exchange at a time for each lease operation.
  private queues = new Map<string, Set<() => void>>();

  private async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    let waiting = this.queues.get(key);
    if (waiting) {
      if (waiting.size >= 24) throw Error("Preview queue full");
      const queue = waiting;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { queue.delete(next); reject(Error("Preview request ended")); };
        const next = () => {
          queue.delete(next);
          signal.removeEventListener("abort", cancel);
          resolve();
        };
        queue.add(next);
        signal.addEventListener("abort", cancel, { once: true });
      });
    } else {
      waiting = new Set();
      this.queues.set(key, waiting);
    }
    return () => {
      const next = waiting.values().next().value;
      if (next) next();
      else this.queues.delete(key);
    };
  }

  readonly dashboardHost: string;
  private readonly domain: string;
  private readonly resolve: Resolve;
  private readonly readAsset: ReadAsset;
  private readonly now: () => number;
  constructor(domain: string, dashboardHost: string, resolve: Resolve, readAsset: ReadAsset, now = Date.now) {
    this.dashboardHost = dashboardHost;
    this.domain = domain;
    this.resolve = resolve;
    this.readAsset = readAsset;
    this.now = now;
    const dns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
    if (!dns.test(domain) || !dns.test(dashboardHost) || dashboardHost === domain ||
        dashboardHost.endsWith("." + domain) || domain.endsWith("." + dashboardHost)) throw Error("Invalid private preview domains");
  }
  issue(session: string, previewId: string): string {
    for (const [key, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(key);
    if (!session || !/^[a-zA-Z0-9_-]{1,128}$/.test(previewId) || this.grants.size >= 4096) throw Error("Preview unavailable");
    const key = opaque(), host = randomBytes(16).toString("hex") + "." + this.domain;
    this.grants.set(key, { session, previewId, host, expires: this.now() + 30_000, redeemed: false });
    return 'https://' + host + '/.canaveral/handoff/' + key;
  }
  async serve(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-same-origin; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const deny = () => { if (res.destroyed) return; res.writeHead(404); res.end(); };
    try {
      const target = req.url ?? "", method = req.method;
      if ((method !== "GET" && method !== "HEAD") || target.length > 4096 || !/^\/[!-~]*$/.test(target) || target.startsWith("//") ||
          /[\\#\s]/.test(target) || req.headers["transfer-encoding"] || Number(req.headers["content-length"] ?? 0) !== 0) return deny();
      const ticket = /^\/\.canaveral\/handoff\/([A-Za-z0-9_-]{43})$/.exec(target)?.[1];
      const cookies = (req.headers.cookie ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(cookieName + "="));
      const key = ticket ?? (cookies.length === 1 ? cookies[0]!.slice(cookieName.length + 1) : "");
      const grant = this.grants.get(key);
      if (!grant || grant.expires <= this.now() || grant.host !== req.headers.host || grant.redeemed === Boolean(ticket)) return deny();
      if (ticket) {
        if (method !== "GET") return deny();
        this.grants.delete(key);
        const check = await this.resolve(grant.session, grant.previewId);
        if (!check || grant.expires <= this.now()) return deny();
        const sessionKey = opaque();
        this.grants.set(sessionKey, { ...grant, redeemed: true, expires: this.now() + 900_000 });
        res.writeHead(303, { Location: "/", "Set-Cookie": cookieName + "=" + sessionKey + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900" });
        res.end();
        return;
      }
      if (target.startsWith("/.canaveral/")) return deny();
      const binding = await this.resolve(grant.session, grant.previewId);
      if (!binding) return deny();
      const disconnected = new AbortController();
      const close = () => disconnected.abort();
      res.once("close", close);
      let release: (() => void) | undefined;
      let result: PreviewResponse;
      try {
        const queueKey = binding.leaseId + "/" + binding.operationId;
        const signal = AbortSignal.any([disconnected.signal,
          AbortSignal.timeout(Math.max(0, Math.min(20_000, grant.expires - this.now())))]);
        if (res.destroyed) return;
        release = await this.acquire(queueKey, signal);
        const current = async () => {
          if (signal.aborted || grant.expires <= this.now()) return false;
          const live = await this.resolve(grant.session, grant.previewId);
          return !signal.aborted && grant.expires > this.now() && live?.leaseId === binding.leaseId &&
            live.operationId === binding.operationId && live.leaseKey === binding.leaseKey;
        };
        if (!await current()) return deny();
        result = await this.readAsset(binding, method, target);
        if (!await current()) return deny();
      } finally {
        release?.();
        res.off("close", close);
      }
      res.setHeader("Content-Type", result.contentType);
      if (method === "HEAD" && typeof result.contentLength === "number" && Number.isSafeInteger(result.contentLength) && result.contentLength >= 0)
        res.setHeader("Content-Length", result.contentLength);
      res.writeHead(result.status);
      res.end(method === "HEAD" ? undefined : result.body);
    } catch { deny(); }
    finally { req.resume(); }
  }
}
