import type {
  HostAvailability,
  InstalledImagePlacement,
  MachineStatusInput,
} from "./types";

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

export function api(path: string, value?: unknown): Promise<unknown>;
export function api<T>(
  path: string,
  value: unknown,
  decode: (value: unknown) => T,
): Promise<T>;
export async function api(
  path: string,
  value?: unknown,
  decode?: (value: unknown) => unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`/api/v1/${path}`, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const detail =
        result !== null && typeof result === "object" && "error" in result
          ? result.error
          : undefined;
      throw Object.assign(
        new Error(
          typeof detail === "string"
            ? detail
            : "The request could not be completed.",
        ),
        { status: response.status },
      );
    }
    return decode ? decode(result) : result;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number"
    )
      throw error;
    throw new Error(
      path.startsWith("auth/")
        ? "Canaveral is unavailable. Try again."
        : "Connection interrupted. The outcome may be unknown. Retry the same request to check it safely.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
export const title = (value?: string | null): string =>
  value === "templates"
    ? "Images"
    : value
      ? value.charAt(0).toUpperCase() + value.slice(1)
      : "Unknown";
export const number = (value: number | bigint): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
export const memory = (value: number): string =>
  value >= 1024 ? `${number(value / 1024)} GiB` : `${number(value)} MiB`;
const providers: Readonly<Record<string, string>> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
  apple: "Apple Virtualization",
  libvirt: "libvirt / KVM",
  hyperv: "Hyper-V",
  kubevirt: "KubeVirt",
  android: "Android Emulator",
  ios: "iOS Simulator",
};
export const provider = (value?: string): string | undefined =>
  providers[value ?? ""] || value;
export function machineStatus(machine: MachineStatusInput): string {
  if (machine.ready) return "Ready";
  if (machine.observed === "running" && machine.preparation.state === "failed")
    return "Setup failed";
  if (machine.observed === "running" && machine.preparation.state === "pending")
    return "Preparing";
  return title(machine.observed);
}
export const attention = (m: MachineStatusInput): boolean =>
  ["error", "unknown"].includes(m.observed) || m.preparation.state === "failed";
export function templatesFor<T extends InstalledImagePlacement>(
  templates: T[],
): Array<T & { hosts: HostAvailability[] }> {
  const groups = new Map<string, T & { hosts: HostAvailability[] }>();
  for (const template of templates) {
    const key = JSON.stringify([template.id, template.revision, template.arch]);
    if (!groups.has(key)) groups.set(key, { ...template, hosts: [] });
    groups.get(key)!.hosts.push({
      id: template.hostId,
      online: template.online,
      accepting: template.accepting,
    });
  }
  return [...groups.values()];
}
export function since(timestamp?: number | null): string {
  if (!timestamp) return "Not reported";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - timestamp));
  return seconds < 10
    ? "Just now"
    : seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)}h ago`
          : `${Math.floor(seconds / 86400)}d ago`;
}
