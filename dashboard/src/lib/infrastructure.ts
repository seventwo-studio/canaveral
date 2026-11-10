import { record } from "./types";
import { resources } from "./catalogue";
import type { CatalogueHost, Resources } from "./catalogue";

export interface MetricCoverage {
  status: "complete" | "incomplete" | "unavailable";
  activePods?: number;
  measuredPods?: number;
}
export type PodMetrics =
  | { status: "unavailable"; coverage?: MetricCoverage }
  | {
      status: "available";
      cpuCores: number;
      memoryMiB: number;
      podCount: number;
      sampledAt?: number;
      coverage?: MetricCoverage;
    };
export interface NamespaceObservation {
  namespace: string;
  sampledAt: number;
  metrics: PodMetrics;
  quotas: {
    status: "available" | "unavailable";
    items: Array<{
      name: string;
      hard: Record<string, number>;
      used: Record<string, number>;
    }>;
  };
  canaveral?: {
    scope?: string;
    ownership: {
      status: "complete" | "unavailable";
      verifiedMachines?: number;
      assignedMachines?: number;
    };
    metrics: PodMetrics;
  };
}
export interface ResourceSample {
  receivedAt: number;
  cpuPercent?: number | null;
}
export interface HostUsage extends ResourceSample {
  scope: string;
  domain?: string;
  fresh: boolean;
  memoryAvailableMiB?: number | null;
  diskFreeGiB?: number | null;
  canaveral?: {
    scope: string;
    categories: Array<{
      id: string;
      cpuPercent?: number | null;
      memoryMiB?: number | null;
    }>;
  };
  cluster?: NamespaceObservation;
}
export interface Host extends CatalogueHost {
  enabled: boolean;
  placementReady?: boolean;
  overcommitted?: boolean;
  capacity: Resources;
  reserved?: Resources;
  limits?: Resources;
  usage?: HostUsage;
  health?: CatalogueHost["health"] & {
    fresh?: boolean;
    status?: string;
    checks?: Array<{
      id: string;
      label: string;
      status: string;
      detail: string;
    }>;
    capabilities?: Record<string, boolean>;
  };
}
export interface HostAllocation {
  id: string;
  name: string;
  observed: string;
  resources: Resources;
  computeReserved?: boolean;
  ready?: boolean;
  known?: boolean;
  templateId?: string;
  template?: {
    os: string;
    arch: string;
    mode: string;
    name?: string;
    guestAccess?: boolean;
  };
}
export interface HostImage {
  id: string;
  revision: string;
  arch: string;
  os: string;
  name?: string;
  format?: string;
  kind?: string;
  imageKind?: string;
  origin?: string;
  bytes?: number | null;
  offered?: boolean;
}
export interface ResourceDetails {
  hostId: string;
  capacity: Resources;
  limits: Resources;
  categories?: Array<Resources & { id: string; label: string }>;
  images?: HostImage[];
  allocations: HostAllocation[];
  samples: ResourceSample[];
}
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const optionalText = (v: unknown) => v === undefined || typeof v === "string";
export function resourceDetails(
  value: unknown,
  hostId: string,
): ResourceDetails {
  const r = record(value);
  if (
    r.hostId !== hostId ||
    !Array.isArray(r.allocations) ||
    !Array.isArray(r.samples)
  )
    throw new Error("Resource report does not match this host.");
  const capacity = resources(r.capacity);
  const limits = resources(r.limits);
  const categories =
    r.categories === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(r.categories))
            throw new Error("Invalid resource categories.");
          const ids = new Set<string>();
          return r.categories.map((v) => {
            const c = record(v);
            if (!text(c.id) || !text(c.label) || ids.has(c.id))
              throw new Error("Invalid resource category identity.");
            ids.add(c.id);
            return { id: c.id, label: c.label, ...resources(c) };
          });
        })();
  const allocations = r.allocations.map((v) => {
    const a = record(v);
    if (
      !text(a.id) ||
      !text(a.name) ||
      !text(a.observed) ||
      (a.computeReserved !== undefined &&
        typeof a.computeReserved !== "boolean")
    )
      throw new Error("Invalid host allocation.");
    return {
      id: a.id,
      name: a.name,
      observed: a.observed,
      resources: resources(a.resources),
      computeReserved: a.computeReserved as boolean | undefined,
    };
  });
  const samples = r.samples.map((v) => {
    const s = record(v);
    if (
      !finite(s.receivedAt) ||
      (s.cpuPercent != null && (!finite(s.cpuPercent) || s.cpuPercent > 100))
    )
      throw new Error("Invalid resource sample.");
    return {
      receivedAt: s.receivedAt,
      cpuPercent: s.cpuPercent as number | null | undefined,
    };
  });
  let images: HostImage[] | undefined;
  if (r.images !== undefined) {
    if (!Array.isArray(r.images))
      throw new Error("Invalid installed image inventory.");
    images = r.images.map((v) => {
      const i = record(v);
      if (
        ![i.id, i.revision, i.arch, i.os].every(text) ||
        ![i.name, i.format, i.kind, i.imageKind, i.origin].every(
          optionalText,
        ) ||
        (i.offered !== undefined && typeof i.offered !== "boolean") ||
        (i.bytes != null &&
          (!finite(i.bytes) || !Number.isSafeInteger(i.bytes)))
      )
        throw new Error("Invalid installed image.");
      return i as unknown as HostImage;
    });
  }
  return {
    hostId,
    capacity,
    limits,
    categories,
    allocations,
    samples,
    images,
  };
}
export type RunnerBindings = Record<string, unknown> & {
  runtimes?: Record<string, Record<string, unknown>>;
};
export function runnerBindings(value: unknown): RunnerBindings {
  const r = record(value);
  if (r.runtimes !== undefined) {
    const runtimes = record(r.runtimes);
    for (const value of Object.values(runtimes)) record(value);
  }
  return r as RunnerBindings;
}
export interface SetupActivity {
  id: string;
  name: string;
  provider: string;
  state: "pending" | "connected" | "expired" | "revoked";
  expiresAt: number;
  hostId?: string | null;
}
export function connectionSetups(value: unknown): {
  setups: SetupActivity[];
  controllerUrl?: string;
} {
  const r = record(value);
  if (!Array.isArray(r.setups) || !optionalText(r.controllerUrl))
    throw new Error("Invalid connection setup activity.");
  const setups = r.setups.map((v) => {
    const s = record(v);
    if (
      ![s.id, s.name, s.provider].every(text) ||
      !finite(s.expiresAt) ||
      typeof s.state !== "string" ||
      !["pending", "connected", "expired", "revoked"].includes(s.state) ||
      (s.hostId != null && typeof s.hostId !== "string")
    )
      throw new Error("Invalid connection setup.");
    return s as unknown as SetupActivity;
  });
  return { setups, controllerUrl: r.controllerUrl as string | undefined };
}
export interface SetupReceipt {
  id: string;
  enrollmentToken: string;
  expiresAt: number;
}
export interface IssuedSetup extends SetupReceipt {
  bundle: {
    schemaVersion: 1;
    controllerUrl: string;
    enrollmentToken: string;
    expiresAt: number;
    config: Record<string, unknown>;
  };
}
export function setupReceipt(value: unknown, expectedId: string): SetupReceipt {
  const r = record(value);
  if (r.id !== expectedId || !text(r.enrollmentToken) || !finite(r.expiresAt))
    throw new Error(
      "Connection setup was not confirmed. Inspect and revoke the original setup before creating another.",
    );
  return {
    id: expectedId,
    enrollmentToken: r.enrollmentToken,
    expiresAt: r.expiresAt,
  };
}
export function setupRevocation(value: unknown, expectedId: string): void {
  const r = record(value);
  if (r.id !== expectedId || r.state !== "revoked")
    throw new Error("Setup revocation was not confirmed.");
}

export function hostLimitReceipt(
  value: unknown,
  hostId: string,
  expected: Resources,
): Resources {
  const r = record(value);
  const limits = resources(r.limits);
  if (
    r.hostId !== hostId ||
    resourceKeys.some((key) => limits[key] !== expected[key])
  )
    throw new Error(
      "Host limits were not confirmed. Reload this host before retrying.",
    );
  return limits;
}
const resourceKeys = ["cpu", "memoryMiB", "diskGiB"] as const;
export function allocationLimits(host: {
  capacity: Resources;
  limits?: Resources;
}): Resources {
  const limits = host.limits || host.capacity;
  return {
    cpu: Math.min(host.capacity.cpu, limits.cpu),
    memoryMiB: Math.min(host.capacity.memoryMiB, limits.memoryMiB),
    diskGiB: Math.min(host.capacity.diskGiB, limits.diskGiB),
  };
}
