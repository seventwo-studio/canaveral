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
  return new ServiceError("Preserve host state and restore the original bootstrap token. If the claim cannot be recovered, inspect and retire its controller identity before reprovisioning.", 409, { code: "kubernetes_bootstrap_recovery_required", outcome: "unknown" });
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

function removeBootstrapToken(path: string, stat: ReturnType<typeof bootstrapToken>["stat"]): void {
  noLinks(path);
  const current = lstatSync(path);
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs) throw tokenError();
  unlinkSync(path);
  syncDirectory(dirname(path));
}

/** Identity publication is the commit point. Until then, only the saved claim can run. */
export async function enrollKubernetesHost(state: string, orchestrator: string, offer: RecordValue, transport: HostTransport, signal: AbortSignal) {
  const path = join(state, "bootstrap", "enrollment-token");
  const intentPath = join(state, "enrollment-intent.json");
  const pending = present(intentPath);
  if (!pending && ["lease-execution.json", "host-reports.json", "update-assignments.json"].some(file => present(join(state, file)))) throw recoveryError();
  let input: ReturnType<typeof bootstrapToken>;
  try { input = bootstrapToken(path); } catch (error) { throw pending ? recoveryError() : error; }
  const tokenDigest = legacyDigest(input.token);
  const intent = pending ? (() => {
    try {
      const saved = readRecord(intentPath, INTENT_BYTES);
      if (saved.version !== 1 || saved.orchestrator !== orchestrator || saved.tokenDigest !== tokenDigest) throw recoveryError();
      return { id: identifier(saved.id), credential: secret(saved.credential), orchestrator, offer: object(saved.offer) };
    } catch { throw recoveryError(); }
  })() : { id: randomUUID(), credential: randomBytes(32).toString("base64url"), orchestrator, offer };
  if (!pending) {
    const saved = { version: 1, tokenDigest, ...intent };
    if (Buffer.byteLength(JSON.stringify(saved)) > INTENT_BYTES) throw new ServiceError("Host enrollment intent exceeds its bound.", 413);
    saveRecord(intentPath, saved);
  }
  try {
    const reply = await transport.request("POST", "/v1/hosts/enroll/setup", intent, input.token, signal);
    if (reply.id !== intent.id) throw recoveryError();
  } catch (error) {
    if (error instanceof ServiceError && error.status >= 400 && error.status < 500) throw recoveryError();
    throw error;
  }
  const identity = { id: intent.id, credential: intent.credential, orchestrator };
  saveRecord(join(state, "identity.json"), identity);
  try { removeBootstrapToken(path, input.stat); } catch { throw tokenError(); }
  unlinkSync(intentPath);
  syncDirectory(state);
  return identity;
}
