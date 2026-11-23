import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { ServiceError } from "../errors.ts";

export const modelIds = ["ollama", "llama.cpp", "vllm", "mlx-lm"] as const;
export const backendIds = ["apple-virtualization", "libvirt", "containerd", ...modelIds] as const;
export const states = ["absent", "installed", "verified", "unavailable", "failed", "unknown"] as const;
export type ModelId = typeof modelIds[number];
export type BackendId = typeof backendIds[number];
export type State = typeof states[number];
export interface Blocker { code: string; detail: string; action?: string }
export interface BackendRecord {
  id: BackendId;
  kind: "virtualization" | "container" | "model-engine";
  management: "detect-only" | "managed" | "root-installer";
  supported: boolean;
  state: State;
  qualified: boolean;
  version?: string;
  blocker?: Blocker;
}
export type HostConfigData = Record<string, unknown>;
export const object = (value: unknown): HostConfigData =>
  value && typeof value === "object" && !Array.isArray(value) ? value as HostConfigData : {};
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const absolute = (value: unknown): value is string =>
  typeof value === "string" && isAbsolute(value) && normalize(value) === value && !value.includes("\0");
export const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const version = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value);

type ModelPathStat = (path: string) => Pick<Stats, "uid" | "mode" | "nlink" | "isFile" | "isDirectory" | "isSymbolicLink">;

function trustedModelPath(path: string, stat: ModelPathStat, uid: number | undefined, file: boolean): void {
  const parent = dirname(path);
  if (parent !== path) trustedModelPath(parent, stat, uid, false);
  const info = stat(path);
  if (info.isSymbolicLink() || (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022) !== 0
    || (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw new Error();
}

export function modelConfig(config: HostConfigData, stat: ModelPathStat = lstatSync): { binary: string; config: string } | undefined {
  if (!Object.hasOwn(config, "modelExecutor")) return undefined;
  const entry = object(config.modelExecutor);
  const { binary, config: file } = entry;
  try {
    if (Object.keys(entry).length !== 2 || !absolute(binary) || !absolute(file)) throw new Error();
    const uid = process.getuid?.();
    for (const path of [binary, file]) trustedModelPath(path, stat, uid, true);
    accessSync(binary, constants.X_OK);
    accessSync(file, constants.R_OK);
    return { binary, config: file };
  } catch {
    throw new ServiceError("modelExecutor requires absolute paths to an executable and a readable config, without links. Both files and their parent directories must be owned by root or the daemon user and must not be group- or world-writable.", 400, { code: "model_executor_config_invalid" });
  }
}

export function record(id: BackendId, supported: boolean, state: State, blocker?: Blocker, version?: string): BackendRecord {
  const container = id === "containerd", model = isModel(id);
  return {
    id, kind: container ? "container" : model ? "model-engine" : "virtualization",
    management: container ? "root-installer" : model ? "managed" : "detect-only",
    supported, state, qualified: false, ...(version ? { version } : {}), ...(blocker ? { blocker } : {}),
  };
}
export const isModel = (id: BackendId): id is ModelId => modelIds.some(value => value === id);
export const blocker = (code: string, detail: string, action?: string): Blocker =>
  ({ code, detail, ...(action ? { action } : {}) });

export type Run = (argv: readonly string[], timeout: number, maxBuffer: number) => Promise<{ stdout: string; exit: number }>;
export const run: Run = (argv, timeout, maxBuffer) => new Promise((resolve, reject) => {
  const child = execFile(argv[0]!, argv.slice(1), {
    shell: false, timeout, maxBuffer, killSignal: "SIGKILL", encoding: "buffer", windowsHide: true,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin", LANG: "C", LC_ALL: "C" },
  }, (error, stdout) => {
    if (error && typeof error.code !== "number") {
      reject(new ProbeError(error.killed ? "runtime_probe_timeout" :
        error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "runtime_probe_output_limit" :
        error.code === "ENOENT" ? "runtime_probe_missing" : "runtime_probe_failed"));
      return;
    }
    try { resolve({ stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdout), exit: Number(error?.code ?? 0) }); }
    catch { reject(new ProbeError("runtime_probe_invalid_output")); }
  });
  child.stdin?.end();
});
export class ProbeError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface Environment {
  platform: NodeJS.Platform;
  arch: string;
  run: Run;
  lstat: (path: string) => Pick<Stats, "isCharacterDevice">;
  modelStat?: ModelPathStat;
  receipt: () => unknown;
}
export async function probe(env: Environment, argv: readonly string[]): Promise<string> {
  const result = await env.run(argv, 5_000, 64 * 1024);
  if (result.exit !== 0) throw new ProbeError("runtime_probe_failed");
  return result.stdout.trim();
}
