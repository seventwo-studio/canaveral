import { ServiceError } from "./errors.ts";

export interface PreviewResponse { status: number; contentType: string; body: Uint8Array; contentLength?: number }

export function parsePreview(data: unknown, method: string): PreviewResponse {
  const invalid = (): never => { throw new ServiceError("Invalid preview response.", 502); };
  if (typeof data !== "string" || data.length > 87384) return invalid();
  const raw = Buffer.from(data, "base64");
  const split = raw.indexOf("\r\n\r\n");
  if (raw.length > 65536 || raw.toString("base64") !== data || split < 0 || split > 16384) return invalid();
  const lines = raw.subarray(0, split).toString("latin1").split("\r\n");
  const statusLine = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(lines.shift()!);
  if (!statusLine) return invalid();
  const status = Number(statusLine[1]);
  let length: number | undefined, type: string | undefined;
  for (const line of lines) {
    const field = /^([!#$%&'*+.^_`|~a-zA-Z0-9-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);
    if (!field) return invalid();
    const name = field[1]!.toLowerCase(), value = field[2]!.trim();
    if (name === "transfer-encoding" || name === "content-encoding") return invalid();
    if (name === "content-length") {
      if (length !== undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      length = Number(value);
    }
    if (name === "content-type") {
      if (type !== undefined || !value) return invalid();
      type = value;
    }
  }
  const body = raw.subarray(split + 4);
  if ((method === "HEAD" || [204, 205, 304].includes(status)) ? body.length !== 0 : length !== undefined && length !== body.length) return invalid();
  if (status === 204 && length !== undefined || status === 205 && length) return invalid();
  const contentLength = status === 204 ? undefined : method === "HEAD" || status === 304 ? length : body.length;
  return { status, ...(contentLength === undefined ? {} : {contentLength}), contentType: type ?? "application/octet-stream", body };
}
