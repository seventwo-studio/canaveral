/** Lease-key device actions for the agent surfaces (`canaveral mcp`, `canaveral lease ID device|install`).
 *
 * Every action is one durable operation under a caller-owned UUID. This module submits it once and
 * then only reads its receipt. It never submits the operation again: when the submission or the
 * receipt cannot be confirmed, the outcome is reported as `unknown` with the operation UUID, and
 * the caller decides whether to resubmit that identical UUID and body (which replays the receipt
 * and never runs the action twice).
 *
 * Only Android emulator leases execute today. Fixture-covered; no native acceptance of this module.
 */
import { ConsumerError } from "./sdk.ts";
import type { DurableOperation, DurableOperationRequest, LeaseClient } from "./sdk.ts";
import type { AppArtifactMetadata } from "./app-artifact-contract.ts";
import { Cancelled, pause, transient } from "./agent-session.ts";

/** The lease capability each lease-key action needs (docs/mobile-control.md, "Scoped control"). The
 * controller enforces the same table; checking here answers without a round trip. */
export const LEASE_ACTIONS: Readonly<Record<string, string>> = {
  screenshot: "screenshot", hierarchy: "hierarchy", accessibility: "hierarchy", "accessibility-action": "hierarchy",
  tap: "input", swipe: "input", text: "input", key: "input",
  apps: "command", launch: "command", terminate: "command", uninstall: "command", "open-url": "command", logs: "command", shell: "command",
  "list-files": "files", push: "files", pull: "files", "install-uploaded": "files",
};
/** The subset offered to coding agents as one tool. Builds go through `installBuild`, not `push`. */
export const AGENT_ACTIONS = ["screenshot", "hierarchy", "accessibility", "tap", "swipe", "text", "key", "apps", "launch", "terminate", "uninstall", "open-url", "logs", "shell"] as const;

/** The operation may or may not have run. It was not, and must not be, sent again automatically. */
export class OperationUnknown extends Error {
  readonly code = "operation_unknown";
  readonly operationId: string;
  constructor(operationId: string, cause: unknown) {
    super("The outcome of this operation is unknown. It was not sent again.", { cause }); this.name = "OperationUnknown"; this.operationId = operationId;
  }
}

/** Reads one receipt until it leaves `queued` or the wait ends. A receipt still `queued` is returned as such. */
export async function awaitOperation(lease: LeaseClient, operation: DurableOperation, waitMs: number, signal?: AbortSignal): Promise<DurableOperation> {
  const until = performance.now() + waitMs;
  for (let polls = 0, failures = 0; operation.state === "queued" && performance.now() < until; polls++) {
    await pause(polls < 20 ? 250 : polls < 60 ? 500 : 1000, signal);
    try { operation = await lease.operation(operation.id); failures = 0; }
    catch (error) {
      // The operation is already recorded, so a receipt that cannot be read leaves its outcome unknown, not failed.
      if (!transient(error) || ++failures >= 5) throw new OperationUnknown(operation.id, error);
    }
  }
  return operation;
}

/** Submits once, then waits for the receipt. */
export async function runOperation(lease: LeaseClient, request: DurableOperationRequest, options: { waitMs: number; signal?: AbortSignal }): Promise<DurableOperation> {
  if (options.signal?.aborted) throw new Cancelled();
  let operation: DurableOperation;
  try { operation = (await lease.createOperation(request)).operation; }
  catch (error) {
    if (!(error instanceof ConsumerError) || error.outcome !== "unknown") throw error;
    // The controller may have recorded it. Reading the receipt is safe; submitting again is the caller's decision.
    try { operation = await lease.operation(request.id); }
    catch { throw new OperationUnknown(request.id, error); }
  }
  return awaitOperation(lease, operation, options.waitMs, options.signal);
}

export interface InstallResult {
  artifact: AppArtifactMetadata; operation: DurableOperation;
  /** True when the upload's bytes and host scratch were released after a confirmed, cleaned install. */
  uploadReleased: boolean;
}
/** Uploads one APK through the lease key and installs it with `install-uploaded` (docs/mobile-control.md,
 * "Lease recording and large installs"). The same `artifactId` resumes confirmed chunks; the same
 * `installId` replays the install receipt. An install that is not `succeeded` keeps its upload: an
 * `unknown` one holds it until the lease's cleanup, and is never repeated here. */
export async function installBuild(lease: LeaseClient, input: {
  file: string; member: string; artifactId: string; installId: string; waitMs: number; keepUpload?: boolean;
  signal?: AbortSignal; progress?: (phase: "uploading" | "installing") => void;
}): Promise<InstallResult> {
  if (input.signal?.aborted) throw new Cancelled();
  input.progress?.("uploading");
  const artifact = await lease.uploadApp({ id: input.artifactId, member: input.member, file: input.file });
  if (input.signal?.aborted) throw new Cancelled();
  input.progress?.("installing");
  const operation = await runOperation(lease, { id: input.installId, member: input.member, action: "install-uploaded", arguments: { artifact: artifact.id } },
    { waitMs: input.waitMs, ...(input.signal ? { signal: input.signal } : {}) });
  let uploadReleased = false;
  if (operation.state === "succeeded" && !input.keepUpload) {
    // Frees the application's upload budget early. The lease's end releases it otherwise.
    try { await lease.deleteAppArtifact(artifact.id); uploadReleased = true; } catch { /* Still held; reported to the caller. */ }
  }
  return { artifact, operation, uploadReleased };
}
