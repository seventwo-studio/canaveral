import { record } from "./types";

export interface WorkspaceMachine {
  id: string;
  name: string;
  observed: string;
  ready?: boolean;
  template: { os: string; arch: string; mode: string; guestAccess?: boolean };
  capabilities?: Partial<
    Record<"desktopStream" | "shell" | "files" | "accessibility", boolean>
  >;
}
export type PerformAction = (
  action: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export interface DisplayActions {
  owned: () => boolean;
  perform: PerformAction;
}
export interface AccessibilityNode extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  depth: number;
  role: string;
  name: string;
  identifier: string;
  states: Record<string, unknown> | string[];
  actions: string[];
  bounds: { x: number; y: number; width: number; height: number } | null;
  properties: Record<string, unknown>;
}
export interface AccessibilitySnapshot extends Record<string, unknown> {
  snapshotId: string;
  capturedAt: number;
  source: string;
  coordinateSpace: "screen-pixels" | "screen-points";
  nodes: AccessibilityNode[];
  truncated: boolean;
  coverage: string;
  unavailableNodes?: number;
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  finite(value) && Number.isSafeInteger(value) && value >= 0;
const stringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Mirrors the normalized backend hierarchy contract, including parent ordering. */
export function accessibilitySnapshot(value: unknown): AccessibilitySnapshot {
  const tree = record(value);
  if (
    "frame" in tree ||
    typeof tree.snapshotId !== "string" ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.exec(
      tree.snapshotId,
    )?.[0] !== tree.snapshotId ||
    !finite(tree.capturedAt) ||
    tree.capturedAt < 0 ||
    typeof tree.source !== "string" ||
    !tree.source ||
    typeof tree.coordinateSpace !== "string" ||
    !["screen-pixels", "screen-points"].includes(tree.coordinateSpace) ||
    typeof tree.truncated !== "boolean" ||
    typeof tree.coverage !== "string" ||
    !tree.coverage ||
    !Array.isArray(tree.nodes) ||
    tree.nodes.length > 2000 ||
    (tree.unavailableNodes !== undefined && !integer(tree.unavailableNodes))
  )
    throw new Error("Invalid accessibility snapshot.");
  const seen = new Map<string, number>();
  for (const item of tree.nodes) {
    const node = record(item);
    if (
      typeof node.id !== "string" ||
      !node.id ||
      seen.has(node.id) ||
      !integer(node.depth) ||
      node.depth > 30 ||
      (node.parentId !== null &&
        (typeof node.parentId !== "string" || !seen.has(node.parentId))) ||
      node.depth !==
        (node.parentId === null ? 0 : seen.get(node.parentId as string)! + 1) ||
      [node.role, node.name, node.identifier].some(
        (label) => typeof label !== "string",
      ) ||
      !stringList(node.actions)
    )
      throw new Error("Invalid accessibility node identity or hierarchy.");
    if (Array.isArray(node.states)) {
      if (!stringList(node.states))
        throw new Error("Invalid accessibility states.");
    } else record(node.states);
    record(node.properties);
    if (node.bounds !== null) {
      const bounds = record(node.bounds);
      if (
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite) ||
        (bounds.width as number) < 0 ||
        (bounds.height as number) < 0
      )
        throw new Error("Invalid accessibility bounds.");
    }
    seen.set(node.id, node.depth);
  }
  return tree as unknown as AccessibilitySnapshot;
}

export type DisplayMessage =
  | {
      type: "control";
      state: "owned" | "busy" | "view-only" | "reset-uncertain" | "not-ready";
    }
  | {
      type: "action-result";
      id: string;
      state: string;
      result: Record<string, unknown> & { detail?: string };
    };
export function displayMessage(text: string): DisplayMessage | null {
  if (new TextEncoder().encode(text).length > 16384)
    throw new Error("Display control envelope exceeded.");
  const value = record(JSON.parse(text));
  if (value.type === "control") {
    if (
      typeof value.state !== "string" ||
      !["owned", "busy", "view-only", "reset-uncertain", "not-ready"].includes(
        value.state,
      )
    )
      throw new Error("Invalid display ownership state.");
  } else if (value.type === "action-result") {
    const result = record(value.result);
    if (
      typeof value.id !== "string" ||
      !value.id ||
      typeof value.state !== "string" ||
      (result.detail !== undefined && typeof result.detail !== "string")
    )
      throw new Error("Invalid display action acknowledgement.");
  } else return null;
  return value as unknown as DisplayMessage;
}

export interface ShellStatus {
  truncated?: boolean;
  exited?: boolean;
  exitCode?: number | null;
  error?: string;
}
export function shellStatus(text: string): ShellStatus {
  const value = record(JSON.parse(text));
  if (
    (value.truncated !== undefined && typeof value.truncated !== "boolean") ||
    (value.exited !== undefined && typeof value.exited !== "boolean") ||
    (value.exitCode != null &&
      (!finite(value.exitCode) || !Number.isSafeInteger(value.exitCode))) ||
    (value.error !== undefined && typeof value.error !== "string")
  )
    throw new Error("Invalid terminal status.");
  return value as ShellStatus;
}

export interface FileEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  size?: number | null;
  modifiedAt?: number | null;
}
export function fileListing(value: unknown): {
  path?: string;
  entries: FileEntry[];
  truncated?: boolean;
} {
  const result = record(value);
  if (
    !Array.isArray(result.entries) ||
    (result.path !== undefined && typeof result.path !== "string") ||
    (result.truncated !== undefined && typeof result.truncated !== "boolean")
  )
    throw new Error("Invalid guest directory listing.");
  for (const value of result.entries) {
    const entry = record(value);
    if (
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.kind !== "string" ||
      !["file", "directory", "symlink", "other"].includes(entry.kind) ||
      (entry.size != null && !integer(entry.size)) ||
      (entry.modifiedAt != null && !finite(entry.modifiedAt))
    )
      throw new Error("Invalid guest directory entry.");
  }
  return result as unknown as {
    path?: string;
    entries: FileEntry[];
    truncated?: boolean;
  };
}
export function pulledFile(value: unknown): { data: string } {
  const result = record(value);
  if (typeof result.data !== "string")
    throw new Error("Invalid guest file preview.");
  return { data: result.data };
}
export function uploadReceipt(
  value: unknown,
  size: number,
): { uploaded: number; durable: true } {
  const result = record(value);
  if (
    !integer(result.uploaded) ||
    result.uploaded !== size ||
    result.durable !== true
  )
    throw new Error(
      "Upload acknowledgement was not confirmed. Inspect the destination before retrying.",
    );
  return { uploaded: result.uploaded, durable: true };
}
