import { lstatSync } from "node:fs";
import { backendIds, blocker, isModel, record, run } from "./core.ts";
import type { BackendId, BackendRecord, Environment, HostConfigData } from "./core.ts";
import { modelRecords } from "./model.ts";
import type { ModelResponse } from "./model.ts";
import { installerInstruction, nativeRecord, readReceipt } from "./native.ts";

export { backendIds, isModel, modelConfig, version } from "./core.ts";

function environment(overrides: Partial<Environment>): Environment {
  return { platform: process.platform, arch: process.arch, run, lstat: lstatSync, receipt: readReceipt, ...overrides };
}
export async function runtimeInventory(config: HostConfigData, overrides: Partial<Environment> = {}): Promise<BackendRecord[]> {
  const env = environment(overrides);
  const [apple, libvirt, containerd, models] = await Promise.all([
    nativeRecord("apple-virtualization", config, env), nativeRecord("libvirt", config, env),
    nativeRecord("containerd", config, env), modelRecords(config, env, { operation: "status" }),
  ]);
  return [apple, libvirt, containerd, ...backendIds.slice(3).map(id => models.backends.find(entry => entry.id === id)!)];
}

export async function mutateRuntime(config: HostConfigData, action: "install" | "verify" | "remove", id: BackendId,
  dryRun: boolean, version?: string, overrides: Partial<Environment> = {}): Promise<ModelResponse> {
  const env = environment(overrides);
  if (!isModel(id)) {
    const container = id === "containerd";
    const code = container ? "containerd_root_installer_required" : "runtime_detect_only";
    const supported = container || id === "libvirt" ? env.platform === "linux" && ["arm64", "x64"].includes(env.arch)
      : env.platform === "darwin" && env.arch === "arm64";
    return { backends: [record(id, supported, "unknown", blocker(code, container ? installerInstruction : "Use runtimes status to inspect this backend."))],
      result: { state: "failed", code } };
  }
  return modelRecords(config, env, { operation: action === "install" ? "prepare" : action, backend: id, dryRun, ...(version ? { version } : {}) });
}

export function runtimeTable(backends: BackendRecord[]): string {
  const rows = [["BACKEND", "STATE", "VERSION", "MANAGEMENT", "BLOCKER"],
    ...backends.map(b => [b.id, b.state, b.version ?? "-", b.management, b.blocker?.detail ?? "-"])];
  const widths = rows[0]!.map((_, index) => Math.max(...rows.map(row => row[index]!.length)));
  return rows.map(row => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n") + "\n";
}
