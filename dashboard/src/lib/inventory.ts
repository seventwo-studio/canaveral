import { record } from "./types";
import { resources, sharedBudget } from "./catalogue";
import type { Resources } from "./catalogue";
import type {
  Host,
  HostUsage,
  NamespaceObservation,
  PodMetrics,
} from "./infrastructure";
import type { HostAvailability } from "./types";
import type { WorkspaceMachine } from "./workspace";

export interface Machine extends WorkspaceMachine {
  hostId: string;
  templateId: string;
  resources: Resources;
  desired: string;
  preparation: { state: string };
  updatedAt?: number;
  detail?: string;
  powerOffRequest?: string;
  template: WorkspaceMachine["template"] & { name?: string; revision?: string };
}
export interface ImageOffer {
  id: string;
  revision: string;
  os: string;
  arch: string;
  mode: string;
  name?: string;
  hostId: string;
  online: boolean;
  accepting: boolean;
  minimum: Resources;
  defaults?: Resources;
  memoryStepMiB?: number;
  preparationDriver?: string;
  imageKind?: string;
  mediaType?: string;
  device?: { systemImage?: string; runtime?: string };
}
export type GroupedImage = ImageOffer & { hosts: HostAvailability[] };
export interface Inventory {
  hosts: Host[];
  machines: Machine[];
  templates: ImageOffer[];
}
export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
}
const string = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
function requiredStrings(r: Record<string, unknown>, keys: string[]) {
  if (keys.some((k) => !string(r[k]) || !r[k]))
    throw new Error("Missing inventory identity or label.");
}
function optionalStrings(r: Record<string, unknown>, keys: string[]) {
  if (keys.some((k) => r[k] !== undefined && !string(r[k])))
    throw new Error("Invalid inventory label.");
}
function optionalNumbers(r: Record<string, unknown>, keys: string[]) {
  if (keys.some((k) => r[k] != null && !finite(r[k])))
    throw new Error("Invalid inventory measurement.");
}
function booleans(
  r: Record<string, unknown>,
  keys: string[],
  optional = false,
) {
  if (
    keys.some(
      (k) => (!optional || r[k] !== undefined) && typeof r[k] !== "boolean",
    )
  )
    throw new Error("Invalid inventory capability or state.");
}
function list(value: unknown, key: string): unknown[] {
  const r = record(value);
  if (!Array.isArray(r[key])) throw new Error("Invalid inventory collection.");
  return r[key];
}
function podMetrics(value: unknown): PodMetrics {
  const r = record(value);
  if (r.status !== "available" && r.status !== "unavailable")
    throw new Error("Invalid namespace metric state.");
  if (
    r.status === "available" &&
    [r.cpuCores, r.memoryMiB, r.podCount].some((v) => !finite(v))
  )
    throw new Error("Incomplete namespace metrics.");
  optionalNumbers(r, ["sampledAt"]);
  if (r.coverage !== undefined) {
    const c = record(r.coverage);
    if (!["complete", "incomplete", "unavailable"].includes(String(c.status)))
      throw new Error("Invalid namespace coverage.");
    if (
      c.status !== "unavailable" &&
      (!finite(c.activePods) ||
        !finite(c.measuredPods) ||
        c.measuredPods > c.activePods ||
        (c.status === "complete"
          ? c.activePods !== c.measuredPods
          : c.activePods === c.measuredPods))
    )
      throw new Error("Incomplete namespace coverage.");
    if (
      r.status === "available" &&
      (c.status !== "complete" || c.measuredPods !== r.podCount)
    )
      throw new Error("Namespace metric coverage mismatch.");
  }
  return r as unknown as PodMetrics;
}
function namespaceObservation(value: unknown): NamespaceObservation {
  const r = record(value);
  requiredStrings(r, ["namespace"]);
  if (!finite(r.sampledAt)) throw new Error("Invalid namespace timestamp.");
  podMetrics(r.metrics);
  const q = record(r.quotas);
  if (
    !["available", "unavailable"].includes(String(q.status)) ||
    !Array.isArray(q.items)
  )
    throw new Error("Invalid namespace quotas.");
  for (const value of q.items) {
    const item = record(value);
    requiredStrings(item, ["name"]);
    if (
      [
        ...Object.values(record(item.hard)),
        ...Object.values(record(item.used)),
      ].some((v) => !finite(v))
    )
      throw new Error("Invalid quota amounts.");
  }
  if (r.canaveral !== undefined) {
    const owned = record(r.canaveral),
      ownership = record(owned.ownership);
    if (
      owned.scope !== "assigned-vm-pods" ||
      !["complete", "unavailable"].includes(String(ownership.status))
    )
      throw new Error("Invalid workload ownership.");
    const metrics = podMetrics(owned.metrics);
    if (ownership.status === "complete") {
      if (
        !finite(ownership.assignedMachines) ||
        ownership.assignedMachines !== ownership.verifiedMachines
      )
        throw new Error("Unverified workload ownership.");
    } else if (metrics.status === "available")
      throw new Error("Usage lacks ownership evidence.");
  }
  return r as unknown as NamespaceObservation;
}
function hostUsage(value: unknown): HostUsage {
  const r = record(value);
  requiredStrings(r, ["scope"]);
  booleans(r, ["fresh"]);
  if (!finite(r.receivedAt)) throw new Error("Invalid host usage timestamp.");
  optionalStrings(r, ["domain"]);
  optionalNumbers(r, ["cpuPercent", "memoryAvailableMiB", "diskFreeGiB"]);
  if (r.cpuPercent != null && Number(r.cpuPercent) > 100)
    throw new Error("Invalid CPU measurement.");
  if (r.canaveral != null) {
    const owned = record(r.canaveral);
    requiredStrings(owned, ["scope"]);
    if (!Array.isArray(owned.categories))
      throw new Error("Invalid measured categories.");
    for (const value of owned.categories) {
      const c = record(value);
      requiredStrings(c, ["id"]);
      optionalNumbers(c, ["cpuPercent", "memoryMiB"]);
    }
  }
  if (r.cluster != null) namespaceObservation(r.cluster);
  return {
    ...r,
    canaveral: r.canaveral ?? undefined,
    cluster: r.cluster ?? undefined,
  } as unknown as HostUsage;
}
export function hostsResponse(value: unknown): Host[] {
  return list(value, "hosts").map((value) => {
    const h = record(value);
    requiredStrings(h, ["id", "name", "provider"]);
    booleans(h, ["online", "enabled"]);
    optionalStrings({ ...h, platform: h.platform ?? undefined }, [
      "kind",
      "platform",
    ]);
    booleans(h, ["placementReady", "overcommitted"], true);
    if (
      h.runtimes !== undefined &&
      (!Array.isArray(h.runtimes) || !h.runtimes.every(string))
    )
      throw new Error("Invalid host runtimes.");
    if (h.health != null) {
      const health = record(h.health);
      optionalStrings(health, ["status"]);
      booleans(health, ["fresh"], true);
      if (health.environment !== undefined) {
        const env = record(health.environment);
        optionalStrings(env, ["arch"]);
      }
      if (
        health.capabilities !== undefined &&
        Object.values(record(health.capabilities)).some(
          (v) => typeof v !== "boolean",
        )
      )
        throw new Error("Invalid host capabilities.");
      if (health.checks !== undefined) {
        if (!Array.isArray(health.checks))
          throw new Error("Invalid environment checks.");
        for (const value of health.checks)
          requiredStrings(record(value), ["id", "label", "status", "detail"]);
      }
    }
    if (h.sharedBudgets !== undefined && !Array.isArray(h.sharedBudgets))
      throw new Error("Invalid host budgets.");
    return {
      ...h,
      platform: h.platform ?? undefined,
      capacity: resources(h.capacity),
      reserved: h.reserved == null ? undefined : resources(h.reserved),
      health: h.health ?? undefined,
      usage: h.usage == null ? undefined : hostUsage(h.usage),
      sharedBudgets: (h.sharedBudgets as unknown[] | undefined)?.map((v) =>
        sharedBudget(v),
      ),
    } as unknown as Host;
  });
}
export function machinesResponse(value: unknown): Machine[] {
  return list(value, "machines").map((value) => {
    const m = record(value);
    requiredStrings(m, [
      "id",
      "name",
      "hostId",
      "templateId",
      "desired",
      "observed",
    ]);
    const t = record(m.template);
    requiredStrings(t, ["os", "arch", "mode"]);
    optionalStrings(t, ["name", "revision"]);
    booleans(t, ["guestAccess"], true);
    requiredStrings(record(m.preparation), ["state"]);
    booleans(m, ["ready"], true);
    optionalStrings(m, ["detail"]);
    optionalNumbers(m, ["updatedAt"]);
    if (m.powerOffRequest != null && !string(m.powerOffRequest))
      throw new Error("Invalid power-off request.");
    if (
      m.capabilities !== undefined &&
      Object.values(record(m.capabilities)).some((v) => typeof v !== "boolean")
    )
      throw new Error("Invalid guest capabilities.");
    return {
      ...m,
      updatedAt: m.updatedAt ?? undefined,
      resources: resources(m.resources),
      powerOffRequest: m.powerOffRequest ?? undefined,
    } as unknown as Machine;
  });
}
export function imagesResponse(value: unknown): ImageOffer[] {
  return list(value, "templates").map((value) => {
    const t = record(value);
    requiredStrings(t, ["id", "revision", "os", "arch", "mode", "hostId"]);
    booleans(t, ["online", "accepting"]);
    optionalStrings(t, ["name", "preparationDriver", "imageKind", "mediaType"]);
    if (
      t.memoryStepMiB !== undefined &&
      (!finite(t.memoryStepMiB) ||
        !Number.isSafeInteger(t.memoryStepMiB) ||
        t.memoryStepMiB < 1)
    )
      throw new Error("Invalid memory step.");
    if (t.device !== undefined)
      optionalStrings(record(t.device), ["runtime", "systemImage"]);
    return {
      ...t,
      minimum: resources(t.minimum),
      defaults: t.defaults === undefined ? undefined : resources(t.defaults),
    } as unknown as ImageOffer;
  });
}
export function user(value: unknown): User {
  const u = record(value);
  requiredStrings(u, ["id", "username"]);
  if (
    !["admin", "user"].includes(String(u.role)) ||
    !["pending", "active", "disabled"].includes(String(u.status))
  )
    throw new Error("Invalid account identity.");
  return {
    id: u.id as string,
    username: u.username as string,
    role: u.role as User["role"],
    status: u.status as User["status"],
  };
}
export function authStatus(value: unknown): {
  user?: User;
  setupRequired: boolean;
  setupAllowed?: boolean;
} {
  const s = record(value);
  booleans(s, ["setupRequired"]);
  booleans(s, ["setupAllowed"], true);
  return {
    setupRequired: s.setupRequired as boolean,
    setupAllowed: s.setupAllowed as boolean | undefined,
    user: s.user == null ? undefined : user(s.user),
  };
}
export function loginReceipt(value: unknown): { user: User } {
  return { user: user(record(value).user) };
}
export interface CreatedMachine {
  id: string;
  name: string;
  hostId: string;
}
export function createdMachine(
  value: unknown,
  expectedId: string,
): CreatedMachine {
  const m = record(value);
  requiredStrings(m, ["id", "name", "hostId"]);
  if (m.id !== expectedId)
    throw new Error(
      "Machine creation was not confirmed. Inspect the original request before retrying.",
    );
  return { id: expectedId, name: m.name as string, hostId: m.hostId as string };
}
