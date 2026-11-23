import { blocker, digest, modelConfig, modelIds, object, ProbeError, record, states, version } from "./core.ts";
import type { BackendRecord, Blocker, Environment, HostConfigData, ModelId, State } from "./core.ts";

type Request = { operation: "status" } | {
  operation: "prepare" | "verify" | "remove"; backend: ModelId; dryRun: boolean; version?: string;
};
interface Asset { url: string; sha256: string; bytes: number }
interface Plan { downloadBytes: number; assets: Asset[] }
interface Result { state: "succeeded" | "failed" | "unknown"; code?: string }
export interface ModelResponse { backends: BackendRecord[]; plan?: Plan; result?: Result }
const codePattern = /^[a-z][a-z0-9_]{0,95}$/;
const cleanText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2_000 && !/[\p{Cc}\p{Cf}]/u.test(value);
const code = (value: unknown): value is string => typeof value === "string" && codePattern.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireReport(condition: unknown): asserts condition {
  if (!condition) throw new ProbeError("model_executor_invalid_report");
}

const modelPlatform = (env: Environment): string => env.platform === "darwin" ? "macos" : env.platform;
function supported(id: ModelId, env: Environment): boolean {
  if (id === "mlx-lm") return env.platform === "darwin" && env.arch === "arm64";
  if (env.platform === "linux") return ["arm64", "x64"].includes(env.arch);
  return id !== "vllm" && env.platform === "darwin" && env.arch === "arm64";
}

function parseBackend(value: unknown, env: Environment): BackendRecord {
  const { backend, catalogVersion, available, state, installed, active, qualified, blocker: reason } = object(value);
  requireReport(modelIds.some(id => id === backend) && typeof available === "boolean"
    && states.some(s => s === state) && qualified === false && Array.isArray(installed)
    && (catalogVersion === undefined || version(catalogVersion))
    && (active === undefined || version(active)));
  const versions = new Set<string>();
  const digests = new Set<string>();
  for (const item of installed) {
    const pkg = object(item);
    requireReport(version(pkg.version) && digest(pkg.packageDigest) && typeof pkg.verified === "boolean"
      && typeof pkg.referenced === "boolean" && !digests.has(pkg.packageDigest));
    versions.add(pkg.version);
    digests.add(pkg.packageDigest);
  }
  requireReport(active === undefined || versions.has(active));
  let message: Blocker | undefined;
  if (reason !== undefined) {
    const { code: reasonCode, detail, action } = object(reason);
    requireReport(code(reasonCode) && cleanText(detail) && (action === undefined || cleanText(action)));
    message = blocker(reasonCode, detail, action);
  }
  const id = backend as ModelId;
  requireReport((id !== "mlx-lm" && id !== "vllm" && supported(id, env)) || !available);
  return record(id, supported(id, env), state as State, message, active ?? catalogVersion);
}

function parsePlan(value: unknown): Plan {
  const { downloadBytes, assets } = object(value);
  requireReport(count(downloadBytes) && Array.isArray(assets));
  return { downloadBytes, assets: assets.map(value => {
    const { url, sha256, bytes } = object(value);
    requireReport(cleanText(url) && digest(sha256) && count(bytes));
    const parsed = URL.parse(url);
    requireReport(parsed?.protocol === "https:" && !parsed.username && !parsed.password);
    return { url, sha256, bytes };
  }) };
}

function parseReport(stdout: string, exit: number, request: Request, env: Environment): ModelResponse {
  const line = stdout.replace(/\r?\n$/, "");
  requireReport(!/[\r\n]/.test(line));
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new ProbeError("model_executor_invalid_report"); }
  const r = object(value);
  const status = request.operation === "status";
  requireReport(r.type === "canaveral-runtime-report" && r.version === 1 && r.operation === request.operation
    && r.platform === modelPlatform(env) && r.arch === (env.arch === "arm64" ? "aarch64" : "x86_64")
    && r.dryRun === (status ? false : request.dryRun) && Array.isArray(r.backends));
  const backends = r.backends.map(value => parseBackend(value, env));
  const ids = new Set(backends.map(entry => entry.id));
  requireReport(ids.size === backends.length);
  if (status) {
    requireReport((exit === 0 || exit === 1) && modelIds.every(id => ids.has(id)) && r.plan === undefined && r.result === undefined);
    return { backends };
  }
  const [backend] = backends;
  requireReport(backends.length === 1 && backend?.id === request.backend);
  const verify = request.operation === "verify";
  if (verify) {
    requireReport(r.plan === undefined && (exit === 0 || exit === 1));
    if (r.result === undefined) {
      const state = exit === 0 ? "succeeded" : backend.state === "unknown" ? "unknown" : "failed";
      const reason = exit === 1 ? backend.blocker?.code : undefined;
      return { backends, result: { state, ...(reason ? { code: reason } : {}) } };
    }
  }
  const { state, code: resultCode } = object(r.result);
  requireReport((state === "succeeded" || state === "failed" || state === "unknown")
    && (resultCode === undefined || code(resultCode)) && exit === (state === "succeeded" ? 0 : 1));
  const plan = verify ? undefined : parsePlan(r.plan);
  return { backends, ...(plan ? { plan } : {}),
    result: { state, ...(resultCode ? { code: resultCode } : {}) } };
}

export async function modelRecords(config: HostConfigData, env: Environment, request: Request): Promise<ModelResponse> {
  const ids = request.operation === "status" ? modelIds : [request.backend];
  const unavailable = (state: State, reason: Blocker): ModelResponse => ({
    backends: ids.map(id => record(id, supported(id, env), state, reason)),
    ...(request.operation === "status" ? {} : { result: { state: state === "unknown" ? "unknown" : "failed", code: reason.code } }),
  });
  try {
    const settings = modelConfig(config, env.modelStat);
    if (!settings) {
      return unavailable("unavailable", blocker("model_executor_not_configured", "Configure modelExecutor in the host config."));
    }
    if (!ids.some(id => supported(id, env))) {
      return unavailable("unavailable", blocker("runtime_platform_unsupported", "This backend does not support the host platform and architecture."));
    }
    const argv = [settings.binary, "--runtime-" + request.operation, "--config", settings.config];
    if (request.operation !== "status") {
      argv.push("--backend", request.backend);
      if (request.version) argv.push("--version", request.version);
      if (request.dryRun) argv.push("--dry-run");
    }
    const timeout = request.operation === "prepare" && !request.dryRun ? 15 * 60_000 : request.operation === "status" ? 10_000 : 60_000;
    const { stdout, exit } = await env.run(argv, timeout, 256 * 1024);
    if (exit === 2 && stdout === "") return unavailable("failed", blocker("model_executor_refused", "The model executor rejected its configuration or arguments."));
    return parseReport(stdout, exit, request, env);
  } catch (error) {
    const reason = error instanceof ProbeError ? error.code : "model_executor_config_invalid";
    return unavailable(reason === "model_executor_config_invalid" ? "failed" : "unknown", blocker(reason, "Could not confirm the model runtime operation."));
  }
}
