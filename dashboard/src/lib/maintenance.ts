import { record } from "./types";

export interface MaintenanceSummary {
  id: string;
  phase: "draining" | "resumed";
  safeToPowerOff: boolean;
  readyToResume: boolean;
}

export function maintenanceSummary(value: unknown): MaintenanceSummary {
  const s = record(value);
  if (
    typeof s.id !== "string" ||
    (s.phase !== "draining" && s.phase !== "resumed") ||
    typeof s.safeToPowerOff !== "boolean" ||
    typeof s.readyToResume !== "boolean"
  )
    throw new Error("Invalid maintenance summary.");
  return {
    id: s.id,
    phase: s.phase,
    safeToPowerOff: s.safeToPowerOff,
    readyToResume: s.readyToResume,
  };
}

export function maintenanceStatus(value: unknown, host: string) {
  if (value === null) return null;
  const s = record(value);
  if (
    s.hostId !== host ||
    s.scope !== "directHost" ||
    !Array.isArray(s.owners) ||
    !s.owners.every((owner) => typeof owner === "string") ||
    !Array.isArray(s.blockers) ||
    (s.lastRunnerConfirmedAt !== null &&
      typeof s.lastRunnerConfirmedAt !== "number")
  )
    throw new Error("Invalid maintenance status.");
  const blockers = s.blockers.map((value) => {
    const b = record(value);
    if (
      typeof b.kind !== "string" ||
      typeof b.id !== "string" ||
      typeof b.state !== "string" ||
      typeof b.detail !== "string" ||
      !Array.isArray(b.blocks) ||
      !b.blocks.includes("powerOff")
    )
      throw new Error("Invalid maintenance blocker.");
    return {
      kind: b.kind,
      id: b.id,
      state: b.state,
      detail: b.detail,
      resume: b.blocks.includes("resume"),
    };
  });
  return {
    ...maintenanceSummary(s),
    scope: s.scope,
    owners: s.owners,
    confirmed: s.lastRunnerConfirmedAt,
    blockers,
  };
}
