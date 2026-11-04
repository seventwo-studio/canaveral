/** Experimental model-job/1. Parsing grants neither ownership nor execution. */
export type ModelJobState = "queued" | "waitingForResources" | "running" | "unknown" | "succeeded" | "failed" | "cancelled";
export interface GenerationResult {
  readonly model: string;
  readonly text: string;
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number }>;
}
export type ModelJobMessage =
  | Readonly<{ type: "submit"; adapter: "ollama"; model: string; digest: string; prompt: string; maxTokens: number }>
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "receipt"; state: ModelJobState; cancelRequested: boolean; stopped: boolean;
      cleanup: "pending" | "complete"; result?: GenerationResult }>;
export interface ModelJob {
  readonly version: 1;
  readonly applicationId: string;
  readonly id: string;
  readonly message: ModelJobMessage;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const states = ["queued", "waitingForResources", "running", "unknown", "succeeded", "failed", "cancelled"];
const terminal = (state: string): boolean => ["succeeded", "failed", "cancelled"].includes(state);
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid model job object");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("Model jobs require plain JSON data");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new TypeError("Model jobs cannot contain accessors");
    copy[key] = descriptor.value;
  }
  return copy;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new TypeError("Invalid model job fields");
  }
}
const integer = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
// Scalar Unicode only: lone UTF-16 surrogates have no interoperable UTF-8 encoding.
function text(value: unknown, maxBytes: number, nonblank = false): value is string {
  return typeof value === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes &&
    (!nonblank || /[^\x09-\x0d\x20]/.test(value));
}
function model(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?![\s\S])/.test(value) && !value.toLowerCase().includes("cloud");
}
export function parseModelJob(input: unknown): ModelJob {
  const job = record(input);
  keys(job, ["version", "applicationId", "id", "message"]);
  if (job.version !== 1 || [job.applicationId, job.id].some(id => typeof id !== "string" || !uuid.test(id))) {
    throw new TypeError("Unsupported model job version or identity");
  }
  const msg = record(job.message);
  let valid = false;
  switch (msg.type) {
    case "submit":
      keys(msg, ["type", "adapter", "model", "digest", "prompt", "maxTokens"]);
      valid = msg.adapter === "ollama" && model(msg.model) && typeof msg.digest === "string" &&
        /^sha256:[a-f0-9]{64}(?![\s\S])/.test(msg.digest) && text(msg.prompt, 65536, true) && integer(msg.maxTokens, 1, 4096);
      break;
    case "cancel":
      keys(msg, ["type"]);
      valid = true;
      break;
    case "receipt": {
      keys(msg, ["type", "state", "cancelRequested", "stopped", "cleanup"], ["result"]);
      valid = typeof msg.state === "string" && states.includes(msg.state) && typeof msg.cancelRequested === "boolean" &&
        typeof msg.stopped === "boolean" && ["pending", "complete"].includes(msg.cleanup as string) &&
        (terminal(msg.state) || (!msg.stopped && msg.cleanup === "pending")) &&
        (msg.cleanup !== "complete" || msg.stopped === true) &&
        (msg.state !== "cancelled" || (msg.cancelRequested === true && msg.stopped === true));
      if (msg.state === "succeeded") {
        const result = record(msg.result);
        keys(result, ["model", "text", "usage"]);
        const usage = record(result.usage);
        keys(usage, ["inputTokens", "outputTokens"]);
        result.usage = Object.freeze(usage);
        msg.result = Object.freeze(result);
        valid = valid && model(result.model) && text(result.text, 131072) &&
          integer(usage.inputTokens, 0, 2147483648) && integer(usage.outputTokens, 0, 2147483648);
      } else if (Object.hasOwn(msg, "result")) valid = false;
      break;
    }
  }
  if (!valid) throw new TypeError("Invalid model job message");
  job.message = Object.freeze(msg);
  return Object.freeze(job) as unknown as ModelJob;
}
function validated(input: unknown): ModelJob | undefined {
  try { return parseModelJob(input); } catch { return undefined; }
}
/** Scope checks require an independently authenticated application identity. */
export function ownsModelJob(input: unknown, applicationId: string): boolean {
  const job = validated(input);
  return job !== undefined && job.applicationId === applicationId;
}
/** Compare validated submissions after a lost reply; false means conflict/new identity. */
export function sameModelSubmission(left: unknown, right: unknown): boolean {
  const a = validated(left), b = validated(right);
  if (!a || !b) return false;
  if (a.applicationId !== b.applicationId || a.id !== b.id || a.message.type !== "submit" || b.message.type !== "submit") return false;
  const x = a.message, y = b.message;
  return x.adapter === y.adapter && x.model === y.model && x.digest === y.digest && x.prompt === y.prompt && x.maxTokens === y.maxTokens;
}
/** Eligibility only; callers must authenticate, bind and durably reconcile the receipt. */
export function modelJobCanRelease(input: unknown): boolean {
  const job = validated(input);
  return job !== undefined && job.message.type === "receipt" && terminal(job.message.state) && job.message.stopped && job.message.cleanup === "complete";
}

/** Bind a validated receipt to a stored submission before considering its claims. */
export function modelReceiptMatches(input: unknown, output: unknown): boolean {
  const submission = validated(input), receipt = validated(output);
  return submission !== undefined && receipt !== undefined && submission.message.type === "submit" && receipt.message.type === "receipt" &&
    submission.applicationId === receipt.applicationId && submission.id === receipt.id &&
    (receipt.message.state !== "succeeded" || receipt.message.result?.model === submission.message.model);
}
