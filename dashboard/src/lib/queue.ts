import { instant } from "./clock";
import { record } from "./types";

/** The administrator queue view, `GET /v1/admin/queue`: waiting requests in the controller's attempt
 * order and the leases that hold capacity now. Decoded strictly; a malformed reply is refused whole so
 * the last good view stays on screen with a stale notice. */
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const kinds = ["lease", "linux-lease", "model-job"] as const;
export interface TemplatePin {
  id: string;
  revision: string;
  arch: string;
}
export interface QueueRequest {
  id: string;
  applicationId: string;
  applicationName?: string;
  kind: (typeof kinds)[number];
  /** 1-based place in the attempt order; null for model calls and for a request past its deadline. */
  position: number | null;
  /** Stable code of the last refusal; null when the request has not been tried. */
  reason: string | null;
  priority: number;
  createdAt: string;
  deadline: string | null;
  label?: string;
  template?: TemplatePin;
  platform?: string;
  model?: string;
}
export interface QueueLease {
  id: string;
  ledger: "generic" | "linux";
  applicationId: string;
  applicationName?: string;
  /** The caller's label; null when a workspace lease was acquired without one. */
  name: string | null;
  state: string;
  createdAt: string;
  expiresAt: string;
  template?: TemplatePin;
  platform?: string;
}
export interface QueueView {
  observedAt: string;
  limit: number;
  requests: QueueRequest[];
  waitingTotal: number;
  leases: QueueLease[];
  activeTotal: number;
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const optionalText = (value: unknown, what: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 200)
    throw new Error(`Invalid queue ${what}.`);
  return value;
};
function pin(value: unknown): TemplatePin | undefined {
  if (value === undefined) return undefined;
  const { id, revision, arch } = record(value);
  if (
    typeof id !== "string" ||
    typeof revision !== "string" ||
    typeof arch !== "string" ||
    !id ||
    !revision ||
    !arch
  )
    throw new Error("Invalid queue template.");
  return { id, revision, arch };
}
function subject(r: Record<string, unknown>) {
  if (
    typeof r.id !== "string" ||
    !UUID.test(r.id) ||
    typeof r.applicationId !== "string" ||
    !UUID.test(r.applicationId) ||
    !instant(r.createdAt)
  )
    throw new Error("Invalid queue identity.");
  const applicationName = optionalText(r.applicationName, "application name"),
    template = pin(r.template),
    platform = optionalText(r.platform, "platform");
  return {
    id: r.id,
    applicationId: r.applicationId,
    createdAt: r.createdAt,
    ...(applicationName ? { applicationName } : {}),
    ...(template ? { template } : {}),
    ...(platform ? { platform } : {}),
  };
}
export function queueView(value: unknown): QueueView {
  const root = record(value);
  if (
    !instant(root.observedAt) ||
    !count(root.limit) ||
    !count(root.waitingTotal) ||
    !count(root.activeTotal) ||
    !Array.isArray(root.requests) ||
    !Array.isArray(root.leases)
  )
    throw new Error("Invalid queue view.");
  const seen = new Set<string>();
  const requests = root.requests.map((entry): QueueRequest => {
    const r = record(entry),
      base = subject(r);
    if (
      !kinds.includes(r.kind as QueueRequest["kind"]) ||
      !(r.position === null || (count(r.position) && r.position > 0)) ||
      !(
        r.reason === null ||
        (typeof r.reason === "string" && CODE.test(r.reason))
      ) ||
      typeof r.priority !== "number" ||
      !Number.isSafeInteger(r.priority) ||
      !(r.deadline === null || instant(r.deadline))
    )
      throw new Error("Invalid waiting request.");
    const identity = `${base.applicationId}:${base.id}`;
    if (seen.has(identity)) throw new Error("Duplicate waiting request.");
    seen.add(identity);
    const label = optionalText(r.label, "label"),
      model = optionalText(r.model, "model");
    return {
      ...base,
      kind: r.kind as QueueRequest["kind"],
      position: r.position as number | null,
      reason: r.reason as string | null,
      priority: r.priority,
      deadline: r.deadline as string | null,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
    };
  });
  // The controller sends positioned requests first, in position order. A reply out of that order is
  // not shown as if it were the attempt order.
  let last = 0,
    unordered = false;
  for (const request of requests) {
    if (request.position === null) unordered = true;
    else if (unordered || request.position <= last)
      throw new Error("Waiting requests are not in attempt order.");
    else last = request.position;
  }
  const leased = new Set<string>();
  const leases = root.leases.map((entry): QueueLease => {
    const l = record(entry),
      base = subject(l);
    if (
      (l.ledger !== "generic" && l.ledger !== "linux") ||
      !(
        l.name === null ||
        (typeof l.name === "string" && l.name.length <= 200)
      ) ||
      typeof l.state !== "string" ||
      !l.state ||
      !instant(l.expiresAt)
    )
      throw new Error("Invalid active lease.");
    if (leased.has(base.id)) throw new Error("Duplicate active lease.");
    leased.add(base.id);
    return {
      ...base,
      ledger: l.ledger,
      name: l.name as string | null,
      state: l.state,
      expiresAt: l.expiresAt,
    };
  });
  return {
    observedAt: root.observedAt,
    limit: root.limit,
    requests,
    waitingTotal: root.waitingTotal,
    leases,
    activeTotal: root.activeTotal,
  };
}

/** Plain words for each stable refusal code a waiting request can carry. An unknown code is shown as
 * the code itself rather than hidden behind a guess. */
const reasons: Record<string, string> = {
  capacity_unavailable: "No eligible host has free capacity for it",
  limit_exceeded:
    "Its application is at one of its limits: active leases, concurrent boxes or resources",
  unavailable: "No host offers this image at the moment",
  host_draining:
    "The host that could take it is closed for a drain, maintenance or an update",
  admission_error:
    "The last attempt failed unexpectedly; the controller tries again each round",
  model_job_limit: "Its application is at its unfinished model job limit",
};
const modelReasons: Record<string, string> = {
  capacity_unavailable: "No approved runner has free capacity for it",
};
export function waitingReason(request: QueueRequest): string {
  if (request.reason === null)
    return request.kind === "model-job"
      ? "Waiting for an approved runner to claim it"
      : "Not tried yet since it was submitted";
  return (
    (request.kind === "model-job" && modelReasons[request.reason]) ||
    reasons[request.reason] ||
    "Refused with a code this page has no words for"
  );
}
/** Why a waiting request has no position, in the two cases the controller defines. */
export function unorderedReason(request: QueueRequest, nowMs: number): string {
  if (request.kind === "model-job")
    return "No single order: runners claim model calls per domain";
  if (request.deadline !== null && Date.parse(request.deadline) <= nowMs)
    return "Past its deadline: the next pass expires it";
  return "No position reported";
}
export const kindLabels: Record<QueueRequest["kind"], string> = {
  lease: "Machine or device lease",
  "linux-lease": "Linux workspace lease",
  "model-job": "Model call",
};
export const pinLabel = (template: TemplatePin): string =>
  `${template.id}@${template.revision}/${template.arch}`;
