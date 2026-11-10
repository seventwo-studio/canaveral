import { record } from "./types";

export interface Resources {
  cpu: number;
  memoryMiB: number;
  diskGiB: number;
}
export type ResourceInput = { [K in keyof Resources]: number | "" };
export const resourceFields = [
  ["cpu", "vCPUs"],
  ["memoryMiB", "Memory (MiB)"],
  ["diskGiB", "Disk (GiB)"],
] as const;
export interface CatalogueHost {
  id: string;
  name: string;
  provider: string;
  online: boolean;
  kind?: string;
  platform?: string;
  runtimes?: string[];
  health?: { environment?: { arch?: string } };
}
export type Refresh = () => void | Promise<void>;
export interface RegistryEntry {
  id: string;
  name: string;
  publisher: string;
  os: string;
  arch: string;
  mediaType: "disk" | "installer";
  format: string;
  sourcePage: string;
  resolver: string | null;
  status: "available" | "manual" | "unavailable";
  minimum: Resources;
  note: string;
}
export interface ImageTask {
  id: string;
  kind: "import" | "capture" | "registry";
  name: string;
  state: "queued" | "running" | "succeeded" | "failed" | "unknown";
  updatedAt: number;
  result?:
    | (Record<string, unknown> & { detail?: string; consistency?: string })
    | null;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function resources(value: unknown): Resources {
  const r = record(value);
  if (!amount(r.cpu) || !amount(r.memoryMiB) || !amount(r.diskGiB))
    throw new Error("Invalid resource amounts.");
  return { cpu: r.cpu, memoryMiB: r.memoryMiB, diskGiB: r.diskGiB };
}
export function imageTask(value: unknown, expectedId?: string): ImageTask {
  const task = record(value);
  if (
    !nonempty(task.id) ||
    (expectedId !== undefined && task.id !== expectedId) ||
    !nonempty(task.name) ||
    typeof task.kind !== "string" ||
    !["import", "capture", "registry"].includes(task.kind) ||
    typeof task.state !== "string" ||
    !["queued", "running", "succeeded", "failed", "unknown"].includes(
      task.state,
    ) ||
    typeof task.updatedAt !== "number" ||
    !Number.isFinite(task.updatedAt) ||
    task.updatedAt < 0
  )
    throw new Error(
      "Image task was not confirmed. Inspect the original task before retrying.",
    );
  if (task.result != null) {
    const result = record(task.result);
    if (
      (result.detail !== undefined && typeof result.detail !== "string") ||
      (result.consistency !== undefined &&
        typeof result.consistency !== "string")
    )
      throw new Error("Invalid image task result.");
  }
  return task as unknown as ImageTask;
}
export function imageTasks(value: unknown): ImageTask[] {
  const v = record(value);
  if (!Array.isArray(v.tasks)) throw new Error("Invalid image activity.");
  return v.tasks.map((v) => imageTask(v));
}
export function importedImage(
  value: unknown,
  expectedId: string,
  expectedBytes: number,
): { name: string; sha256: string } {
  const image = record(value);
  if (
    image.id !== expectedId ||
    image.bytes !== expectedBytes ||
    !nonempty(image.name) ||
    typeof image.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(image.sha256) ||
    image.sha256.length !== 64
  )
    throw new Error(
      "Import acknowledgement was not confirmed. Inspect the original image task before retrying.",
    );
  return { name: image.name, sha256: image.sha256 };
}
export function registryEntries(value: unknown): RegistryEntry[] {
  const v = record(value);
  if (!Array.isArray(v.entries)) throw new Error("Invalid image registry.");
  const ids = new Set<string>();
  return v.entries.map((value) => {
    const e = record(value);
    if (
      ![e.id, e.name, e.publisher, e.os, e.arch, e.format, e.sourcePage].every(
        nonempty,
      ) ||
      typeof e.note !== "string" ||
      (e.mediaType !== "disk" && e.mediaType !== "installer") ||
      (e.resolver !== null && !nonempty(e.resolver)) ||
      typeof e.status !== "string" ||
      !["available", "manual", "unavailable"].includes(e.status)
    )
      throw new Error("Invalid registry entry.");
    const entry = e as unknown as RegistryEntry;
    if (ids.has(entry.id) || new URL(entry.sourcePage).protocol !== "https:")
      throw new Error("Invalid registry source or identity.");
    ids.add(entry.id);
    return { ...entry, minimum: resources(e.minimum) };
  });
}
