import { ServiceError, object } from "../../errors.ts";
export { ServiceError, object };
export type MaybePromise<T> = T | Promise<T>;
export type Authority = () => boolean;
export const CHUNK = 524288;
export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
export function allowed(predicate: Authority): boolean { try { return predicate() === true; } catch { return false; } }
export function integer(value: unknown, min = 0, max = MAX_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ServiceError("An explicit UUID is required.", 400);
  return value.toLowerCase();
}
export function fields(value: unknown, names: string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).sort().join(",") !== [...names].sort().join(",")) throw new ServiceError("Invalid Windows operation fields.", 400);
  return result;
}
export function unicode(value: unknown): value is string { return typeof value === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
export function text(value: unknown, limit: number): string {
  if (!unicode(value) || value.includes("\0") || Buffer.byteLength(value) > limit) throw new ServiceError("Invalid Windows Unicode or control envelope.", 400);
  return value;
}
export function unsupported(message: string): never { throw new ServiceError(message, 409, { code: "capability_unsupported", retryable: false }); }
export function uncertain(message: string, code?: string): ServiceError { return new ServiceError(message, 409, { outcome: "unknown", retryable: false, ...(code ? { code } : {}) }); }
export function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class Lane {
  busy = false;
  async run<T>(work: () => MaybePromise<T>): Promise<T> {
    if (this.busy) throw new ServiceError("Windows operation is busy.", 409, { code: "input_busy", retryable: false });
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
}
export function base64(value: unknown, limit: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ServiceError("Invalid bounded base64 data.", 400);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit) throw new ServiceError("Data exceeds its envelope.", 400);
  return bytes;
}
