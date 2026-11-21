/** Lease authorization shared by the supervised mobile runtimes (Android emulators and iOS
 * simulators). The native lease supervisor reads the `lease-authorization.json` published
 * here; the access check is the runner's side of the same contract. One implementation, so
 * a deadline or fence rule can never differ between the two runtimes. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ServiceError } from "../errors.ts";
import { StateLock } from "../runtime-process.ts";
import type { LeaseAuthorization } from "../runtime-process.ts";
import { readJson, saveJson, uuid } from "./mobile.ts";
import type { LeaseSupervisorTransport, RecordValue } from "./mobile.ts";

export interface LeaseIdentity { machineId: string; leaseId: string }

/** Device access needs a live supervisor and a current, unfenced authorization on this
 * boot's clock. A supervisor that is gone, however it ended, no longer enforces the deadline. */
export async function requireLeaseAccess(leases: LeaseSupervisorTransport, helper: string, launch: RecordValue | undefined, storage: string, runtime: string): Promise<void> {
  const fenced = (): never => { throw new ServiceError(`Leased ${runtime} execution is fenced.`, 410); };
  if (launch?.supervised !== true || ["lease-fenced.json", "lease-stopped.json"].some(name => fs.existsSync(path.join(storage, name)))) fenced();
  const status = await leases.status(helper, storage), allowed = readJson(path.join(storage, "lease-authorization.json"));
  if (status.supervisor !== "held" || !allowed || allowed.fenced !== false || allowed.bootSessionID !== status.bootSessionID ||
    typeof allowed.deadline !== "number" || !(status.continuous < allowed.deadline)) fenced();
}
/** Publishes the host's current lease authorization as an absolute native deadline. The
 * deadline subtracts the sampling delay and 250 ms. A same revision never extends it, a
 * revision never moves backwards and a fence is sticky. */
export async function publishLeaseAuthorization(leases: LeaseSupervisorTransport, helper: string, storage: string, identity: LeaseIdentity, authorization: () => LeaseAuthorization, stopping: boolean): Promise<RecordValue> {
  const { machineId, leaseId } = identity;
  const launch = readJson(path.join(storage, "launch.json"));
  if (!launch || launch.supervised !== true || launch.machineId !== machineId || launch.leaseId !== leaseId) throw new ServiceError("Lease authorization needs its supervised launch identity.", 409);
  const lock = new StateLock(path.join(storage, "lease-authorization.sqlite"));
  try {
    const started = performance.now(), allowed = authorization(), sample = await leases.clock(helper), delay = (performance.now() - started) / 1000;
    if (allowed.leaseID !== leaseId || !Number.isSafeInteger(allowed.revision) || allowed.revision < 1 || !Number.isFinite(allowed.remainingSeconds) || allowed.remainingSeconds < 0) throw new ServiceError("Lease authorization identity differs.", 409);
    const value: RecordValue = { version: 1, machineId, leaseId, bootId: uuid(launch.bootId), bootSessionID: uuid(sample.bootSessionID), revision: allowed.revision,
      deadline: Math.max(0, sample.continuous + allowed.remainingSeconds - delay - .25), fenced: stopping || allowed.fenced };
    const file = path.join(storage, "lease-authorization.json"), previous = readJson(file);
    if (previous) {
      if (previous.machineId !== machineId || previous.leaseId !== leaseId || previous.bootId !== value.bootId || previous.bootSessionID !== value.bootSessionID || typeof previous.deadline !== "number" || typeof previous.fenced !== "boolean" || !Number.isSafeInteger(previous.revision)) throw new ServiceError("Lease authorization belongs to another launch or boot.", 409);
      if (allowed.revision < Number(previous.revision)) throw new ServiceError("Lease authorization revision cannot move backwards.", 409);
      value.fenced = value.fenced || previous.fenced;
      if (allowed.revision === previous.revision) value.deadline = Math.min(Number(value.deadline), previous.deadline);
    }
    saveJson(file, value); return value;
  } finally { lock.close(); }
}
/** Fences an existing authorization without needing the host's lease clock. */
export function fenceLeaseAuthorization(storage: string): void {
  const lock = new StateLock(path.join(storage, "lease-authorization.sqlite"));
  try { const file = path.join(storage, "lease-authorization.json"), previous = readJson(file); if (previous && previous.fenced !== true) saveJson(file, { ...previous, fenced: true }); }
  finally { lock.close(); }
}
