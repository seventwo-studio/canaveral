import { record } from "./types";

export const systemCollections = [
  "applications",
  "leases",
  "requests",
  "jobs",
  "operations",
  "sessions",
] as const;
export type SystemCollection = (typeof systemCollections)[number];
export interface SystemRecord {
  id: string;
  family: string;
  state: string;
  applicationId?: string;
  leaseId?: string;
  machineId?: string;
  createdAt?: number;
  expiresAt?: number;
  revision?: number;
  runtimeState?: string;
  requestedState?: string;
  reservationHeld?: boolean;
  ready?: boolean;
  cleanupReason?: string;
  cleanupAttempts?: number;
  cleanupRetryAt?: number;
  cleanup?: string;
  name?: string;
  kind?: string;
  cancelRequested?: boolean;
  revoked?: boolean;
  members?: {
    machineId: string;
    name: string;
    runtimeState?: string;
    ready?: boolean;
    cleanup?: string;
  }[];
}
export type SystemSnapshot = Record<SystemCollection, SystemRecord[]> & {
  page?: number;
  nextPage?: number | null;
  /** The controller's clock for this page, in seconds. Absent from a controller that predates it. */
  observedAt?: number;
};
const strings = [
  "applicationId",
  "leaseId",
  "machineId",
  "runtimeState",
  "requestedState",
  "cleanupReason",
  "cleanup",
  "name",
  "kind",
] as const;
const numbers = [
  "createdAt",
  "expiresAt",
  "revision",
  "cleanupAttempts",
  "cleanupRetryAt",
] as const;
export function systemSnapshot(value: unknown): SystemSnapshot {
  const root = record(value);
  const result = {} as SystemSnapshot;
  if (root.page !== undefined || root.nextPage !== undefined) {
    if (
      typeof root.page !== "number" ||
      !Number.isSafeInteger(root.page) ||
      root.page < 0 ||
      (root.nextPage !== null && root.nextPage !== root.page + 1)
    )
      throw new Error("Invalid system page.");
    result.page = root.page;
    result.nextPage = root.nextPage as number | null;
  }
  if (root.observedAt !== undefined) {
    if (
      typeof root.observedAt !== "number" ||
      !Number.isFinite(root.observedAt) ||
      root.observedAt < 0
    )
      throw new Error("Invalid system clock.");
    result.observedAt = root.observedAt;
  }
  for (const collection of systemCollections) {
    const entries = root[collection];
    if (!Array.isArray(entries)) throw new Error("Invalid system inventory.");
    const seen = new Set<string>();
    result[collection] = entries.map((entry) => {
      const r = record(entry);
      for (const key of ["id", "family", "state"]) {
        if (typeof r[key] !== "string" || !r[key])
          throw new Error("Invalid system identity.");
      }
      const item: SystemRecord = {
        id: r.id as string,
        family: r.family as string,
        state: r.state as string,
      };
      const identity = `${item.family}:${item.id}:${typeof r.applicationId === "string" ? r.applicationId : ""}`;
      if (seen.has(identity)) throw new Error("Duplicate system identity.");
      seen.add(identity);
      for (const key of strings) {
        if (r[key] !== undefined) {
          if (typeof r[key] !== "string")
            throw new Error("Invalid system field.");
          item[key] = r[key];
        }
      }
      for (const key of numbers) {
        if (r[key] !== undefined) {
          if (
            typeof r[key] !== "number" ||
            !Number.isFinite(r[key]) ||
            r[key] < 0
          )
            throw new Error("Invalid system timestamp or revision.");
          item[key] = r[key];
        }
      }
      for (const key of [
        "cancelRequested",
        "revoked",
        "reservationHeld",
        "ready",
      ] as const) {
        if (r[key] !== undefined) {
          if (typeof r[key] !== "boolean")
            throw new Error("Invalid system state.");
          item[key] = r[key];
        }
      }
      if (r.members !== undefined) {
        if (!Array.isArray(r.members))
          throw new Error("Invalid system members.");
        item.members = r.members.map((value) => {
          const member = record(value);
          if (
            typeof member.machineId !== "string" ||
            typeof member.name !== "string"
          )
            throw new Error("Invalid system member.");
          const decoded: NonNullable<SystemRecord["members"]>[number] = {
            machineId: member.machineId,
            name: member.name,
          };
          for (const key of ["runtimeState", "cleanup"] as const) {
            if (member[key] !== undefined) {
              if (typeof member[key] !== "string")
                throw new Error("Invalid system member state.");
              decoded[key] = member[key];
            }
          }
          if (member.ready !== undefined) {
            if (typeof member.ready !== "boolean")
              throw new Error("Invalid system member readiness.");
            decoded.ready = member.ready;
          }
          return decoded;
        });
      }
      return item;
    });
  }
  return result;
}
export type SystemAction = "release" | "close" | "revoke" | "cancel";
export function systemReceipt(
  value: unknown,
  target: string,
  requestId: string,
  action: SystemAction,
): string {
  const r = record(value);
  if (
    r.id !== target ||
    r.requestId !== requestId ||
    r.action !== action ||
    typeof r.state !== "string" ||
    !r.state
  ) {
    throw new Error(
      "The action was not confirmed. Retry the same request to inspect its outcome.",
    );
  }
  return r.state;
}
