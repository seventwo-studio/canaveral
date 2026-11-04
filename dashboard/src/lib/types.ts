/** Administrative dashboard shapes, separate from consumer lease admission. */
export interface MachineStatusInput {
  ready?: boolean;
  observed: string;
  preparation: { state: string };
}
export interface MachinePowerTarget {
  id: string;
  name: string;
  powerOffRequest?: string;
}
export interface PowerOffReceipt {
  id: string;
  machineId: string;
  state: "queued" | "unknown" | "succeeded";
}
export interface HostAvailability {
  id: string;
  online: boolean;
  accepting: boolean;
}
export interface InstalledImagePlacement {
  id: string;
  revision: string;
  arch: string;
  hostId: string;
  online: boolean;
  accepting: boolean;
}
export interface OperationReceipt {
  state: string;
  result?: (Record<string, unknown> & { detail?: string }) | null;
}
export type AuthState =
  "insecure" | "checking" | "setup" | "login" | "blocked" | "unavailable";

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response object.");
  return value as Record<string, unknown>;
}
export function operationReceipt(value: unknown): OperationReceipt {
  const receipt = record(value);
  if (typeof receipt.state !== "string")
    throw new Error("Invalid operation receipt state.");
  if (receipt.result != null) {
    const result = record(receipt.result);
    if (result.detail !== undefined && typeof result.detail !== "string")
      throw new Error("Invalid operation detail.");
  }
  return receipt as unknown as OperationReceipt;
}
export function powerOffReceipt(
  value: unknown,
  expected?: Pick<PowerOffReceipt, "id" | "machineId">,
): PowerOffReceipt {
  const receipt = record(value);
  if (
    typeof receipt.id !== "string" ||
    typeof receipt.machineId !== "string" ||
    typeof receipt.state !== "string" ||
    !["queued", "unknown", "succeeded"].includes(receipt.state)
  )
    throw new Error("Invalid power-off receipt.");
  if (
    expected &&
    (receipt.id !== expected.id || receipt.machineId !== expected.machineId)
  )
    throw new Error("Power-off receipt ownership changed.");
  return receipt as unknown as PowerOffReceipt;
}
