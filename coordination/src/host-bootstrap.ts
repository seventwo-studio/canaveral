import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { identifier } from "./consumers.ts";
import { legacyDigest } from "./control/templates.ts";
import { object, secret, ServiceError } from "./errors.ts";
import type { HostTransport } from "./host.ts";
import { noLinks, present, readRecord, saveRecord, syncDirectory } from "./runtime-process.ts";
import type { RecordValue } from "./runtime-process.ts";

const TOKEN_BYTES = 256;
const INTENT_BYTES = 8 * 1_048_576;

function tokenError(): ServiceError {
  return new ServiceError("Provision bootstrap/enrollment-token as an owned, unlinked 0600 setup token file.", 409, { code: "kubernetes_bootstrap_token_invalid" });
}

function recoveryError(): ServiceError {
  return new ServiceError("Preserve host state and restore the original bootstrap token. If the claim cannot be recovered, inspect and retire its controller identity before reprovisioning. If the controller already rejected this claim (kubernetes_bootstrap_intent_rejected), follow the documented intent recovery procedure instead.", 409, { code: "kubernetes_bootstrap_recovery_required", outcome: "unknown" });
}

function bootstrapToken(path: string) {
  try {
    noLinks(path);
    const parent = lstatSync(dirname(path));
    const uid = process.getuid?.();
    if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) throw tokenError();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > TOKEN_BYTES) throw tokenError();
      const bytes = Buffer.alloc(TOKEN_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, null);
        if (n === 0) break;
        length += n;
      }
      const after = fstatSync(fd);
      if (length !== stat.size || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) throw tokenError();
      return { token: secret(bytes.subarray(0, length).toString("utf8").trim()), stat };
    } finally { closeSync(fd); }
  } catch { throw tokenError(); }
}

function rejectedError(): ServiceError {
  return new ServiceError("The controller rejected the saved enrollment claim. Confirm no host with the intent's id exists or was enrolled on the controller, then remove enrollment-intent.json from the node state and provide a new bootstrap token. See the Kubernetes node bootstrap recovery procedure.", 409, { code: "kubernetes_bootstrap_intent_rejected", outcome: "unknown" });
}

function removeBootstrapToken(path: string, stat: ReturnType<typeof bootstrapToken>["stat"], remove: (path: string) => void): void {
  noLinks(path);
  const current = lstatSync(path);
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs) throw tokenError();
  remove(path);
  syncDirectory(dirname(path));
}

/** The intent holds the host credential, so it gets the same private-file checks as the token. */
function privateIntent(path: string): RecordValue {
  noLinks(path);
  const uid = process.getuid?.(), stat = lstatSync(path);
  if (uid === undefined || !stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) throw recoveryError();
  return readRecord(path, INTENT_BYTES);
}

/**
 * Post-identity cleanup. Identity publication is the commit point, so nothing
 * here may fail startup: problems are logged and retried at the next start.
 * The intent is removed only when it matches the identity, and the token only
 * when its digest matches that intent. The token goes first, so a failed token
 * removal keeps the intent that proves the token's origin for the next attempt.
 */
export function cleanupKubernetesEnrollment(state: string, identity: { id: string; credential: string; orchestrator: string }, log: (message: string) => void = () => {}, remove: (path: string) => void = unlinkSync): void {
  const intentPath = join(state, "enrollment-intent.json"), path = join(state, "bootstrap", "enrollment-token");
  try {
    if (!present(intentPath)) return;
    const saved = privateIntent(intentPath);
    if (saved.version !== 1 || saved.id !== identity.id || saved.credential !== identity.credential || saved.orchestrator !== identity.orchestrator) return;
    if (present(path)) {
      const input = bootstrapToken(path);
      if (legacyDigest(input.token) === saved.tokenDigest) removeBootstrapToken(path, input.stat, remove);
    }
    remove(intentPath);
    syncDirectory(state);
  } catch (error) {
    try { log(`Kubernetes enrollment cleanup deferred: ${error instanceof Error ? error.message : String(error)}`); } catch { /* logging is best effort */ }
  }
}

/** Identity publication is the commit point. Until then, only the saved claim can run. */
export async function enrollKubernetesHost(state: string, orchestrator: string, offer: RecordValue, transport: HostTransport, signal: AbortSignal, log: (message: string) => void = () => {}) {
  const path = join(state, "bootstrap", "enrollment-token");
  const intentPath = join(state, "enrollment-intent.json");
  const pending = present(intentPath);
  if (!pending && ["lease-execution.json", "host-reports.json", "update-assignments.json"].some(file => present(join(state, file)))) throw recoveryError();
  let input: ReturnType<typeof bootstrapToken>;
  try { input = bootstrapToken(path); } catch (error) { throw pending ? recoveryError() : error; }
  const tokenDigest = legacyDigest(input.token);
  const intent = pending ? (() => {
    try {
      const saved = privateIntent(intentPath);
      if (saved.version !== 1 || saved.orchestrator !== orchestrator || saved.tokenDigest !== tokenDigest) throw recoveryError();
      return { id: identifier(saved.id), credential: secret(saved.credential), orchestrator, offer: object(saved.offer) };
    } catch { throw recoveryError(); }
  })() : { id: randomUUID(), credential: randomBytes(32).toString("base64url"), orchestrator, offer };
  if (!pending) {
    const saved = { version: 1, tokenDigest, ...intent };
    if (Buffer.byteLength(JSON.stringify(saved)) > INTENT_BYTES) throw new ServiceError("Host enrollment intent exceeds its bound.", 413);
    saveRecord(intentPath, saved);
  }
  let reply: RecordValue;
  try {
    reply = await transport.request("POST", "/v1/hosts/enroll/setup", intent, input.token, signal);
  } catch (error) {
    // A 4xx may hide a lost success, so the intent is kept and the operator decides.
    if (error instanceof ServiceError && error.status >= 400 && error.status < 500) throw rejectedError();
    throw error;
  }
  if (reply.id !== intent.id) throw recoveryError();
  const identity = { id: intent.id, credential: intent.credential, orchestrator };
  saveRecord(join(state, "identity.json"), identity);
  cleanupKubernetesEnrollment(state, identity, log);
  return identity;
}
