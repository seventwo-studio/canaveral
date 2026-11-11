import { object, ServiceError } from "./errors.ts";

export interface OperationRow {
  id: string; lease: string; assignment: string; request: string; argv: string; credential: string;
  state: string; updated: number; start_before: number; dispatched: number | null; deadline: number | null; result: string | null; timeout_ms: number;
}
export function operationObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const r = object(value);
  if (required.some(k => !Object.hasOwn(r, k)) || Object.keys(r).some(k => !required.includes(k) && !optional.includes(k))) {
    throw new ServiceError("Invalid operation fields.", 400);
  }
  return r;
}
export function operationArgv(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string" || v.includes("\0")) ||
      Buffer.byteLength(JSON.stringify(value)) > 65536 || value[0] === "") throw new ServiceError("Invalid operation argv.", 400);
  return value as string[];
}
export function operationReceipt(value: unknown): { state: string; result?: unknown } {
  const r = operationObject(value, ["state"], ["result"]);
  if (!["succeeded", "failed", "unknown"].includes(r.state as string)) throw new ServiceError("Invalid operation state.", 400);
  if (!Object.hasOwn(r, "result")) {
    if (r.state === "succeeded") throw new ServiceError("Success requires execution evidence.", 400);
    return { state: r.state as string };
  }
  if (r.state === "unknown") throw new ServiceError("Unknown execution cannot provide a result.", 400);
  const keys = ["stdoutBase64", "stderrBase64", "exitCode", "signal", "timedOut", "durationMs", "stdoutBytes", "stderrBytes", "truncated", "terminationConfirmed"];
  const result = operationObject(r.result, keys);
  const bad = () => { throw new ServiceError("Invalid execution result.", 400); };
  const sizes = ["stdoutBase64", "stderrBase64"].map(k => {
    const v = result[k];
    if (typeof v !== "string" || Buffer.from(v, "base64").toString("base64") !== v) return bad();
    return Buffer.from(v, "base64").length;
  });
  if (sizes[0]! + sizes[1]! > 262144) bad();
  for (const k of ["durationMs", "stdoutBytes", "stderrBytes"]) if (!Number.isSafeInteger(result[k]) || (result[k] as number) < 0) bad();
  for (const k of ["exitCode", "signal"]) if (result[k] !== null && !Number.isSafeInteger(result[k])) bad();
  for (const k of ["timedOut", "truncated", "terminationConfirmed"]) if (typeof result[k] !== "boolean") bad();
  if ((result.stdoutBytes as number) < sizes[0]! || (result.stderrBytes as number) < sizes[1]! ||
      (!result.truncated && (result.stdoutBytes !== sizes[0] || result.stderrBytes !== sizes[1]))) bad();
  const success = result.exitCode === 0 && result.signal === null && result.timedOut === false;
  const failure = (result.exitCode !== null && result.exitCode !== 0) || result.signal !== null || result.timedOut === true;
  if (!result.terminationConfirmed || (r.state === "succeeded" ? !success : !failure)) bad();
  return { state: r.state as string, result: Object.fromEntries(keys.map(k => [k, result[k]])) };
}
