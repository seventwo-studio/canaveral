import { ServiceError, object } from "../errors.ts";
import { decodeData, jsonBytes, uuid } from "../control/transfers.ts";
import { integer, sameUUID, validUnicode } from "./https.ts";
import type { GuestRequest } from "./https.ts";

export class GuestChunkShells {
  constructor(readonly request: GuestRequest) {}
  async control(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const routes: Record<string, [string, string[]]> = {
      "shell-open": ["open", ["session", "cols", "rows"]], "shell-read": ["read", ["session", "offset"]],
      "shell-write": ["write", ["session", "text"]], "shell-resize": ["resize", ["session", "cols", "rows"]], "shell-close": ["close", ["session"]],
    };
    object(args);
    const route = routes[action];
    if (!route || Object.keys(args).some(k => !route[1].includes(k))) throw new ServiceError("Invalid guest terminal action or arguments.", 400);
    const session = uuid(args.session), value: Record<string, unknown> = { session };
    let written = 0;
    if (action === "shell-open" || action === "shell-resize") {
      for (const [key, fallback] of [["cols", 80], ["rows", 24]] as const) {
        const n = args[key] === undefined && action === "shell-open" ? fallback : args[key];
        if (!integer(n, 500) || n < 1) throw new ServiceError("Guest terminal dimensions must be integers from 1 through 500.", 400);
        value[key] = n;
      }
    } else if (action === "shell-write") {
      const text = args.text;
      if (typeof text !== "string" || !validUnicode(text) || text.includes("\0") || [...text].length > 16000) throw new ServiceError("Invalid guest terminal text.", 400);
      value.text = text; written = Buffer.byteLength(text);
    } else if (action === "shell-read") {
      const offset = args.offset === undefined ? 0 : args.offset;
      if (!integer(offset)) throw new ServiceError("Invalid guest terminal offset.", 400);
      value.offset = offset;
    }
    jsonBytes(value, 16384);
    const result = object(await this.request(`/v1/shell/${route[0]}`, value));
    const fail = (message: string): never => { throw new ServiceError(message, 409, { retryable: false, ...(action === "shell-read" ? {} : { outcome: "unknown" as const }) }); };
    if ((action === "shell-open" || action === "shell-read") && !sameUUID(result.session, session)) fail("Guest terminal response identity differs.");
    if (action === "shell-open") return { session };
    if (action === "shell-close") { if (result.closed !== true) fail("Guest terminal cleanup remains unconfirmed."); return { closed: true }; }
    if (action === "shell-resize") { if (result.resized !== true) fail("Guest terminal resize remains unconfirmed."); return { resized: true }; }
    if (action === "shell-write") { if (result.written !== written) fail("Guest terminal input acknowledgement differs; inspect before retrying."); return { written }; }
    let data: Buffer;
    try { data = decodeData(result.data, 65536); } catch { return fail("Guest terminal output encoding differs."); }
    const end = result.offset, start = value.offset as number, code = result.exitCode;
    if (!integer(end) || end < start || typeof result.truncated !== "boolean" || typeof result.exited !== "boolean" ||
      (code !== null && (typeof code !== "number" || !Number.isSafeInteger(code))) ||
      (!result.truncated && end - start !== data.length) || (result.truncated && end - data.length <= start)) fail("Guest terminal output cursor or metadata differs.");
    return { data: result.data, offset: end, truncated: result.truncated, exited: result.exited, exitCode: code };
  }
}
