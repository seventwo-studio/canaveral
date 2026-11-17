import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GuestHelperBinding } from "../control/session-protocol.ts";
import { ServiceError } from "../errors.ts";
import { GuestHTTPS, authorized, type Authority, type PinnedGuestEndpoint } from "./https.ts";

export interface GuestAssignmentContext {
  readonly version: 1;
  readonly machineId: string;
  readonly leaseId: string;
  readonly fingerprint: string;
  readonly launchId: string;
}
export interface GuestHelperIdentity extends GuestAssignmentContext { readonly incarnation: string; readonly nonce: string; readonly proof: string }
const keys = ["version", "machineId", "leaseId", "fingerprint", "launchId"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid(): ServiceError { return new ServiceError("Native guest identity was not verified.", 409, { retryable: false }); }
export function guestAssignment(value: unknown, identity = false): GuestAssignmentContext | GuestHelperIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>, expected = identity ? [...keys, "incarnation", "nonce", "proof"] : keys;
  if (Object.keys(v).length !== expected.length || expected.some(k => !Object.hasOwn(v, k)) || v.version !== 1 ||
    ["machineId", "leaseId", "launchId", ...(identity ? ["incarnation"] : [])].some(k => typeof v[k] !== "string" || ((v[k] as string).length !== 36 || !uuid.test(v[k] as string))) ||
    typeof v.fingerprint !== "string" || (v.fingerprint.length !== 64 || !/^[0-9a-f]{64}$/.test(v.fingerprint))) throw invalid();
  if (identity) { canonical32(v.nonce); canonical32(v.proof); }
  return Object.freeze(Object.fromEntries(expected.map(k => [k, v[k]]))) as unknown as GuestAssignmentContext;
}
/** Strict canonical unpadded base64url for 32 bytes; bound before decoding. */
function canonical32(value: unknown): Buffer {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw invalid();
  return bytes;
}
export type BindingPurpose = "identity-request" | "identity-response" | "request";
/** UTF-8, fixed order, LF delimiters including final LF. Assignment schema stays v1. */
export function guestBindingBytes(context: GuestAssignmentContext, purpose: BindingPurpose, nonce?: string, incarnation?: string): Buffer {
  guestAssignment(context);
  if (!["identity-request", "identity-response", "request"].includes(purpose)) throw invalid();
  if (purpose !== "request") canonical32(nonce); else if (nonce !== undefined) throw invalid();
  if (purpose !== "identity-request") {
    if (typeof incarnation !== "string" || incarnation.length !== 36 || !uuid.test(incarnation)) throw invalid();
  } else if (incarnation !== undefined) throw invalid();
  return Buffer.from(["Canaveral-Binding-v2", purpose, "1", context.machineId, context.leaseId, context.fingerprint, context.launchId,
    ...(purpose === "request" ? [] : [nonce!]), ...(purpose === "identity-request" ? [] : [incarnation!]), ""].join("\n"), "utf8");
}
export function guestBindingMAC(credential: string, context: GuestAssignmentContext, purpose: BindingPurpose, nonce?: string, incarnation?: string): string {
  return createHmac("sha256", Buffer.from(credential, "utf8")).update(guestBindingBytes(context, purpose, nonce, incarnation)).digest("base64url");
}
export function guestBindingAuthorization(credential: string, context: GuestAssignmentContext, incarnation?: string, nonce?: string): string {
  return "Canaveral-Binding-v2 " + (incarnation === undefined ? nonce + "." : "") +
    guestBindingMAC(credential, context, incarnation === undefined ? "identity-request" : "request", nonce, incarnation);
}
function sameAssignment(a: GuestAssignmentContext, b: GuestAssignmentContext): boolean {
  return keys.every(k => a[k as keyof GuestAssignmentContext] === b[k as keyof GuestAssignmentContext]);
}
/** Resolution is explicit and never retries an operation. */
export async function verifiedGuestHelperBinding(expected: () => GuestAssignmentContext, endpoint: string, credential: string,
  authority: Authority, options: { caFile?: string; timeout?: number; pinned?: PinnedGuestEndpoint; owner?: { transports: Set<GuestHTTPS>; closed: boolean } } = {}): Promise<GuestHelperBinding> {
  let alive = !options.owner?.closed;
  let pinned: GuestAssignmentContext;
  try { pinned = guestAssignment(expected()); } catch { throw invalid(); }
  if (options.pinned && options.pinned.serverName !== pinned.launchId + ".canaveral.invalid") throw invalid();
  const current = (): boolean => {
    if (options.owner?.closed) alive = false;
    if (!alive) return false;
    try {
      if (!authorized(authority) || !sameAssignment(guestAssignment(expected()), pinned)) alive = false;
    } catch { alive = false; }
    return alive;
  };
  if (!current()) throw invalid();
  const nonce = randomBytes(32).toString("base64url");
  let identity: GuestHelperIdentity;
  let reader: GuestHTTPS | undefined;
  try {
    reader = new GuestHTTPS(endpoint, credential, options.caFile, options.timeout, guestBindingAuthorization(credential, pinned, undefined, nonce), options.pinned);
    options.owner?.transports.add(reader);
    identity = guestAssignment(await reader.call("/v1/identity", null), true) as GuestHelperIdentity;
    const { incarnation, nonce: echoed, proof, ...tuple } = identity;
    if (!sameAssignment(tuple, pinned) || echoed !== nonce ||
      !timingSafeEqual(canonical32(proof), canonical32(guestBindingMAC(credential, pinned, "identity-response", nonce, incarnation))) || !current()) throw invalid();
  } catch { alive = false; throw invalid(); }
  finally { if (reader) { reader.closeAll(); options.owner?.transports.delete(reader); } }
  const transport = new GuestHTTPS(endpoint, credential, options.caFile, options.timeout, guestBindingAuthorization(credential, pinned, identity.incarnation), options.pinned);
  options.owner?.transports.add(transport);
  return new GuestHelperBinding(async (path, body) => {
    if (!current()) throw new ServiceError("Guest assignment authorization ended.", 410);
    try { return await transport.call(path, body); }
    catch (error) {
      if (options.owner || error instanceof ServiceError && error.status === 401) alive = false;
      if (options.owner) { options.owner.closed = true; for (const t of options.owner.transports) t.closeAll(); options.owner.transports.clear(); }
      throw error;
    }
  }, current);
}

/** Close is available during the identity handshake, before a binding exists. */
export function pinnedGuestBindingFactory() {
  const owner = { transports: new Set<GuestHTTPS>(), closed: false };
  return {
    get closed() { return owner.closed; },
    closeAll() { owner.closed = true; for (const transport of owner.transports) transport.closeAll(); owner.transports.clear(); },
    async resolve(expected: () => GuestAssignmentContext, endpoint: string, credential: string, authority: Authority, pinned: PinnedGuestEndpoint, timeout = 20) {
      if (pinned.serverName !== guestAssignment(expected()).launchId + ".canaveral.invalid") throw invalid();
      return verifiedGuestHelperBinding(expected, endpoint, credential, authority, { pinned, timeout, owner });
    },
  };
}
