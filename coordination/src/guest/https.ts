import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { createSecureContext } from "node:tls";
import { ServiceError, object } from "../errors.ts";
import { jsonBytes } from "../control/transfers.ts";

export type GuestRequest = (path: string, body: Record<string, unknown> | null) => Promise<Record<string, unknown>>;
export type Authority = () => boolean;
export const MAX_REQUEST = 1_000_000;
export const MAX_RESPONSE = 64 * 1048576;
export function authorized(check: Authority): boolean { try { return check() === true; } catch { return false; } }
export function validUnicode(value: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
export function sameUUID(value: unknown, expected: string): boolean { return typeof value === "string" && value.toLowerCase() === expected.toLowerCase(); }

/** Assignment owner supplies the endpoint and credential. No proxy, redirect, connection pool or replay. */
export class GuestHTTPS {
  private readonly origin: URL;
  private readonly ca: Buffer | undefined;
  constructor(origin: string, private readonly credential: string, caFile?: string, readonly timeout = 20) {
    try {
      if (typeof origin !== "string" || !/^https:\/\//.test(origin) || /[\s\x00-\x20?#\\]/.test(origin)) throw new Error();
      this.origin = new URL(origin);
      // Check the supplied path as well: URL normalization must not erase dot segments.
      if (!/^https:\/\/[^/]+\/?$/.test(origin) || this.origin.protocol !== "https:" || !this.origin.hostname || this.origin.username || this.origin.password || this.origin.pathname !== "/" || (this.origin.port && Number(this.origin.port) < 1)) throw new Error();
      if (typeof credential !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(credential)) throw new Error();
      if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 120) throw new Error();
      this.ca = caFile === undefined ? undefined : readFileSync(caFile);
      if (this.ca !== undefined && !this.ca.toString("ascii").includes("-----BEGIN CERTIFICATE-----")) throw new Error();
      createSecureContext(this.ca === undefined ? {} : { ca: this.ca });
    } catch { throw new ServiceError("Invalid native guest HTTPS origin, credential, timeout or certificate trust.", 400, { retryable: false }); }
  }
  readonly call: GuestRequest = async (path, body) => {
    if (typeof path !== "string" || !/^\/v1\/[a-z]+(?:\/[a-z]+)*$/.test(path)) throw new ServiceError("Invalid native guest protocol path.", 400);
    if (body !== null) object(body);
    const data = body === null ? undefined : jsonBytes(body, MAX_REQUEST);
    const failure = (message: string, status = 502, code = "response_invalid") => new ServiceError(message, status,
      { code, retryable: false, ...(data === undefined ? {} : { outcome: "unknown" as const }) });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      // A wall deadline covers DNS, handshake, headers and a trickled response, rather than socket inactivity.
      const timer = setTimeout(() => { finish(failure("Native guest response was not confirmed; inspect before another command.", 503, "transport_interrupted")); req.destroy(); }, this.timeout * 1000);
      const req = httpsRequest(this.origin, { method: data === undefined ? "GET" : "POST", path, agent: false,
        rejectUnauthorized: true, ...(this.ca === undefined ? {} : { ca: this.ca }),
        headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", Connection: "close", ...(data === undefined ? {} : { "Content-Length": data.length }) } }, response => {
        const bad = (error: ServiceError) => { finish(error); response.destroy(); req.destroy(); };
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) return bad(failure("Native guest redirects are not followed.", 502, "redirect_refused"));
        const headers = (name: string) => response.rawHeaders.flatMap((v, i, a) => i % 2 === 0 && v.toLowerCase() === name ? [a[i + 1]!] : []);
        const lengths = headers("content-length"), encodings = headers("transfer-encoding"), contentEncodings = headers("content-encoding");
        if (lengths.length > 1 || encodings.length > 1 || (lengths.length && encodings.length) || (encodings.length && encodings[0]!.toLowerCase() !== "chunked") || contentEncodings.length > 1 || (contentEncodings.length && contentEncodings[0]!.toLowerCase() !== "identity")) return bad(failure("Native guest response framing is invalid."));
        let length: number | undefined;
        if (lengths.length) {
          if (!/^[0-9]{1,10}$/.test(lengths[0]!)) return bad(failure("Native guest response length is invalid."));
          length = Number(lengths[0]);
          if (length > MAX_RESPONSE) return bad(failure("Native guest response exceeds its protocol envelope.", 413));
        }
        const limit = status === 200 ? MAX_RESPONSE : 4096, chunks: Buffer[] = [];
        let count = 0;
        response.on("data", (chunk: Buffer) => {
          count += chunk.length;
          if (count > limit) return bad(failure("Native guest response exceeds its protocol envelope.", 413));
          chunks.push(chunk);
        });
        response.on("error", () => finish(failure("Native guest response was interrupted.", 503, "transport_interrupted")));
        response.on("end", () => {
          if (settled) return;
          try {
            if (!response.complete || (length !== undefined && count !== length)) throw failure("Native guest response was truncated.");
            if (headers("content-type").length !== 1 || response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw failure("Native guest response is not JSON.");
            const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
            jsonBytes(value, limit); // Reject numeric overflow as well as non-object JSON.
            if (status !== 200) {
              const code = value.code;
              const refusal = status === 409 && typeof code === "string" && ["input_busy", "input_stale", "input_reset_uncertain", "capability_unsupported"].includes(code);
              finish(new ServiceError("Native guest request was refused.", status, { retryable: false, ...(refusal ? { code } : data === undefined ? {} : { outcome: "unknown" as const }) }));
              return;
            }
            finish(undefined, value);
          } catch (error) { finish(error instanceof ServiceError && error.status !== 400 ? error : failure("Native guest response JSON is invalid.")); }
        });
      });
      req.on("error", () => finish(failure("Native guest response was not confirmed; inspect before another command.", 503, "transport_interrupted")));
      req.end(data);
    });
  };
}
