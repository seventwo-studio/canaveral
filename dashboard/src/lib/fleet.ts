import { attention, machineStatus } from "./api";
import type { MachineStatusInput } from "./types";
import type { Host } from "./infrastructure";

export const stateFilter = (state: string) =>
  state === "Running"
    ? "running-unready"
    : state.toLowerCase().replaceAll(" ", "-");
export function matchesMachineState(
  machine: MachineStatusInput,
  filter: string,
) {
  if (filter === "all") return true;
  if (filter === "attention") return attention(machine);
  // Running includes preparation; the chart uses exact displayed states.
  if (filter === "running") return machine.observed === "running";
  return stateFilter(machineStatus(machine)) === filter;
}
export function hostIssue(host: Host): string | null {
  if (host.maintenance?.phase === "draining")
    return host.online ? "Maintenance" : "Offline · Maintenance";
  if (!host.online) return "Offline";
  if (!host.enabled) return "Draining";
  if (host.overcommitted) return "Overcommitted";
  if (host.health?.fresh === false) return "Checks stale";
  if (host.health?.status === "failed") return "Checks failed";
  if (host.placementReady === false)
    return host.health?.status === "checking"
      ? "Checking…"
      : "Not ready for placement";
  return null;
}
