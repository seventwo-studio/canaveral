import { createHmac } from "node:crypto";
import { GuestHelperBinding } from "../control/session-protocol.ts";
import { ServiceError } from "../errors.ts";
import { GuestHTTPS, authorized, type Authority } from "./https.ts";

export interface GuestAssignmentContext {
  readonly version: 1;
  readonly machineId: string;
  readonly leaseId: string;
  readonly fingerprint: string;
  readonly launchId: string;
}
export interface GuestHelperIdentity extends GuestAssignmentContext { readonly incarnation: string }
const keys = ["version", "machineId", "leaseId", "fingerprint", "launchId"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): ServiceError { return new ServiceError("Native guest identity was not verified.", 409, { retryable: false }); }
export function guestAssignment(value: unknown, identity = false): GuestAssignmentContext | GuestHelperIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>, expected = identity ? [...keys, "incarnation"] : keys;
  if (Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v, k)) || v.version !== 1 ||
    ["machineId", "leaseId", "launchId", ...(identity ? ["incarnation"] : [])].some(k => typeof v[k] !== "string" || ((v[k] as string).length !== 36 || !uuid.test(v[k] as string))) ||
    typeof v.fingerprint !== "string" || (v.fingerprint.length !== 64 || !/^[0-9a-f]{64}$/.test(v.fingerprint))) throw invalid();
  return Object.freeze(Object.fromEntries(expected.map(k => [k, v[k]]))) as unknown as GuestAssignmentContext;
}
/** UTF-8, fixed order, LF delimiters including final LF; validated fields cannot contain LF. */
export function guestBindingBytes(context: GuestAssignmentContext, incarnation?: string): Buffer {
  guestAssignment(context);
  if (incarnation !== undefined && (incarnation.length !== 36 || !uuid.test(incarnation))) throw invalid();
  return Buffer.from(["Canaveral-Binding-v1", incarnation === undefined ? "identity" : "request", context.machineId, context.leaseId, context.fingerprint, context.launchId, ...(incarnation === undefined ? [] : [incarnation]), ""].join("\n"), "utf8");
}
export function guestBindingAuthorization(credential: string, context: GuestAssignmentContext, incarnation?: string): string {
  return "Canaveral-Binding-v1 " + createHmac("sha256", Buffer.from(credential, "utf8")).update(guestBindingBytes(context, incarnation)).digest("base64url");
}
/** No production caller supplies trusted launch state yet. Resolution is explicit and never retried. */
export async function verifiedGuestHelperBinding(expected: () => GuestAssignmentContext, endpoint: string, credential: string,
  authority: Authority, options: { caFile?: string; timeout?: number } = {}): Promise<GuestHelperBinding> {
  let alive = true;
  let pinned: GuestAssignmentContext;
  try { pinned = guestAssignment(expected()); } catch { throw invalid(); }
  const current = (): boolean => {
    if (!alive) return false;
    try {
      if (!authorized(authority) || !guestBindingBytes(guestAssignment(expected())).equals(guestBindingBytes(pinned))) alive = false;
    } catch { alive = false; }
    return alive;
  };
  if (!current()) throw invalid();
  let identity: GuestHelperIdentity;
  try {
    const reader = new GuestHTTPS(endpoint, credential, options.caFile, options.timeout, guestBindingAuthorization(credential, pinned));
    identity = guestAssignment(await reader.call("/v1/identity", null), true) as GuestHelperIdentity;
    const { incarnation: _, ...tuple } = identity;
    if (!current() || !guestBindingBytes(tuple).equals(guestBindingBytes(pinned))) throw invalid();
  } catch { alive = false; throw invalid(); }
  const transport = new GuestHTTPS(endpoint, credential, options.caFile, options.timeout, guestBindingAuthorization(credential, pinned, identity.incarnation));
  return new GuestHelperBinding(async (path, body) => {
    if (!current()) throw new ServiceError("Guest assignment authorization ended.", 410);
    try { return await transport.call(path, body); }
    catch (error) { if (error instanceof ServiceError && error.status === 401) alive = false; throw error; }
  }, current);
}
