import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ServiceError } from "./errors.ts";
import type { ParseArgsConfig } from "node:util";
import {
  CliClient, CliError, credential, expandPath, handleAccount, metadata, option, positional,
  privateInput, privateOutput, promptPassword, record, removeSameFile, uuid,
} from "./account-cli.ts";
import type { AccountContext, CliArguments, RequestClient } from "./account-cli.ts";

const HELP = `Canaveral machine and inference orchestration
Usage: canaveral [--url ORIGIN] [--token-file FILE] [--allow-http] COMMAND [options]

init DIRECTORY                          Create private credentials without replacing files
serve [--config FILE]                    Start a controller; also accepts legacy serve flags
dashboard [--bind IP] [--port PORT]       Start the optional dashboard
local [--state DIR]                      Isolated loopback controller, dashboard and optional host
host --config FILE --state DIR           Run a host (--setup-file FILE is also supported)
host --config FILE --state DIR --check   Inspect without enrollment or starting machines
login --username NAME --output-file FILE [--password-file FILE]
logout | account password | users [list|create|update|invite|reset-password|revoke-invite]
tokens [list|create|revoke] | admin create|setup-link|recover
hosts | machines | templates | models | jobs | images | image-tasks
machine ID | job ID | cancel-job ID | start ID | stop ID | drain ID | accept ID
create NAME --template ID --request-id UUID [--cpu N --memory-mib N --disk-gib N]
generate --model ID --prompt-file FILE --request-id UUID [--max-tokens N]
device ID ACTION --request-id UUID [--arguments-file FILE]
operation ID [--output FILE] | template validate|prepare FILE [--cache DIR]
apps [list|create|credential|revoke] | leases [list|templates|acquire] | lease ID [renew|release|credential]
image capture --request-file FILE | image-task ID
updates [options] COMMAND                Manage signed runtime releases and rollouts

serve flags: --bind IP --port PORT --database FILE --admin-token-file FILE
             --enrollment-token-file FILE --controller-id UUID [--tls-cert-file FILE --tls-key-file FILE]
serve --config FILE accepts the explicit controller configuration used by src/main.ts.
Account create/mint commands require a stable --request-id. Passwords and issued
credentials stay in private files. Never retry an uncertain mutation with a new ID.
Local Linux: --linux-image FILE --apple-runner FILE --guest-helper-manifest FILE
(or CANAVERAL_GUEST_BUNDLE) requires an installed, runnable TypeScript guest bundle.
Retained legacy identities require explicit offline consolidation; no state is adopted.
Native host adapters and local desktop preparation require installed, explicitly
configured runtimes. Missing support fails closed; local never downloads runtimes.
`;
type Schema = { flags?: string[]; values?: string[]; required?: string[]; positional?: number; actions?: string[]; defaultAction?: string };
const schemas: Record<string, Schema> = {
  init: { positional: 1 },
  serve: { values: ["config", "bind", "port", "database", "admin-token-file", "enrollment-token-file", "controller-id", "tls-cert-file", "tls-key-file", "update-trust-file"] },
  dashboard: { values: ["bind", "port", "bootstrap-token-file"] },
  local: { values: ["state", "api-port", "dashboard-port", "linux-image", "apple-runner", "android-sdk", "guest-helper-manifest", "controller-id"] },
  host: { flags: ["check"], values: ["config", "setup-file", "state", "ca-file", "enrollment-token-file"], required: ["state"] },
  admin: { actions: ["create", "setup-link", "recover"], values: ["username", "password-file", "user-id", "dashboard-url", "output-file"] },
  login: { values: ["username", "password-file", "output-file"], required: ["username", "output-file"] },
  logout: {}, account: { actions: ["password"], values: ["current-password-file", "password-file"] },
  users: { actions: ["list", "create", "update", "invite", "reset-password", "revoke-invite"], defaultAction: "list" },
  tokens: { actions: ["list", "create", "revoke"], defaultAction: "list" },
  hosts: {}, machines: {}, templates: {}, models: {}, jobs: {}, images: {}, "image-tasks": {},
  machine: { positional: 1 }, job: { positional: 1 }, "cancel-job": { positional: 1 },
  generate: { values: ["model", "prompt-file", "max-tokens", "digest", "host-id", "request-id"], required: ["model", "prompt-file", "request-id"] },
  create: { positional: 1, values: ["template", "cpu", "memory-mib", "disk-gib", "template-revision", "arch", "host-id", "request-id"], required: ["template", "request-id"] },
  device: { positional: 2, values: ["arguments-file", "request-id"], required: ["request-id"] },
  operation: { positional: 1, values: ["output"] },
  template: { actions: ["validate", "prepare"], positional: 1, values: ["cache"] },
  start: { positional: 1 }, stop: { positional: 1 }, drain: { positional: 1 }, accept: { positional: 1 },
  apps: { actions: ["list", "create", "credential", "revoke"], defaultAction: "list" },
  leases: { actions: ["list", "acquire", "templates"], defaultAction: "list", values: ["after"] },
  lease: { positional: 1, values: ["request-file", "output-file"] },
  image: { actions: ["capture"], values: ["request-file"], required: ["request-file"] }, "image-task": { positional: 1 },
};
const subSchemas: Record<string, Schema> = {
  "users:list": {}, "users:create": { values: ["username", "role", "request-id"], required: ["username", "request-id"] },
  "users:update": { positional: 1, values: ["role", "status"] },
  "users:invite": { positional: 1, values: ["dashboard-url", "output-file"], required: ["dashboard-url", "output-file"] },
  "users:reset-password": { positional: 1, values: ["dashboard-url", "output-file"], required: ["dashboard-url", "output-file"] },
  "users:revoke-invite": { positional: 1 },
  "tokens:list": {}, "tokens:create": { values: ["name", "scope", "expires-in", "request-id", "output-file"], required: ["name", "scope", "request-id", "output-file"] },
  "tokens:revoke": { positional: 1 },
  "leases:acquire": { values: ["request-file"], required: ["request-file"] }, "leases:templates": {}, "leases:list": { values: ["after"] },
  "apps:list": {}, "apps:create": { values: ["request-file", "output-file"], required: ["request-file", "output-file"] },
  "apps:credential": { positional: 1, values: ["output-file"], required: ["output-file"] }, "apps:revoke": { positional: 1 },
};

/** Strict, command-specific parsing. Global flags retain their original before-command position. */
export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArguments {
  const rootOptions: NonNullable<ParseArgsConfig["options"]> = {
    url: { type: "string" }, "token-file": { type: "string" }, "allow-http": { type: "boolean" },
  };
  let boundary = 0;
  while (boundary < argv.length && argv[boundary]!.startsWith("--")) {
    const arg = argv[boundary]!;
    const name = arg.slice(2).split("=", 1)[0]!;
    if (!(name in rootOptions)) throw new CliError(`Unknown global option --${name}.`);
    boundary += rootOptions[name]!.type === "string" && !arg.includes("=") ? 2 : 1;
  }
  const globals = parseArgs({ args: argv.slice(0, boundary), options: rootOptions, strict: true });
  const command = argv[boundary]; const initial = command ? schemas[command] : undefined;
  if (!command || !initial) throw new CliError("Supply a known command; use --help for available commands.");
  let tail = argv.slice(boundary + 1); let action = "";
  if (initial.actions) {
    if (tail[0] && !tail[0].startsWith("-")) action = tail.shift()!;
    else action = initial.defaultAction ?? "";
    if (!initial.actions.includes(action)) throw new CliError(`Supply a valid ${command} action: ${initial.actions.join(", ")}.`);
  }
  const schema = subSchemas[`${command}:${action}`] ?? initial;
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const name of schema.flags ?? []) options[name] = { type: "boolean" };
  for (const name of schema.values ?? []) options[name] = { type: "string", ...(name === "scope" ? { multiple: true } : {}) };
  const result = parseArgs({ args: tail, options, allowPositionals: true, strict: true });
  if (command === "lease" && result.positionals.length === 2) {
    action = result.positionals.pop()!;
    if (!["renew", "release", "credential"].includes(action)) throw new CliError("Lease action must be renew, release or credential.");
  }
  if (result.positionals.length !== (schema.positional ?? 0)) throw new CliError(`Invalid arguments for ${command}${action ? " " + action : ""}.`);
  for (const key of schema.required ?? []) if (!result.values[key]) throw new CliError(`Supply --${key}.`);
  for (const [key, choices] of Object.entries({ role: ["admin", "user"], status: ["active", "pending", "disabled"], arch: ["amd64", "arm64"] })) {
    const value = result.values[key]; if (typeof value === "string" && !choices.includes(value)) throw new CliError(`Invalid --${key}.`);
  }
  if (Array.isArray(result.values.scope) && result.values.scope.some(scope => typeof scope !== "string" || !["machines:read", "machines:write", "machines:access", "admin"].includes(scope))) throw new CliError("Invalid --scope.");
  if (command === "host" && Number(Boolean(result.values.config)) + Number(Boolean(result.values["setup-file"])) !== 1) throw new CliError("Supply exactly one of --config and --setup-file.");
  const tokenFile = globals.values["token-file"] ?? env.CANAVERAL_TOKEN_FILE;
  return { command, action, positionals: result.positionals, options: result.values as CliArguments["options"],
    url: typeof globals.values.url === "string" ? globals.values.url : env.CANAVERAL_URL ?? "http://127.0.0.1:8765", allowHttp: globals.values["allow-http"] === true || env.CANAVERAL_ALLOW_HTTP === "1",
    ...(typeof tokenFile === "string" ? { tokenFile } : {}) };
}
function numberOption(args: CliArguments, name: string, fallback?: number, minimum = 1, maximum = 1_048_576): number {
  const text = option(args, name, fallback === undefined ? undefined : String(fallback));
  const value = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new CliError(`Invalid --${name}.`);
  return value;
}
async function readBounded(path: string, maximum: number): Promise<Buffer> {
  if (path === "-") {
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); count += data.length;
      if (count > maximum) throw new CliError("Input file exceeds the command's size limit."); chunks.push(data);
    }
    return Buffer.concat(chunks);
  }
  const file = await fs.open(expandPath(path), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new CliError("Input must be a regular file.");
    const data = Buffer.alloc(maximum + 1); let size = 0;
    while (size < data.length) { const read = await file.read(data, size, data.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > maximum) throw new CliError("Input file exceeds the command's size limit."); return data.subarray(0, size);
  } finally { await file.close(); }
}
async function jsonFile(path: string, maximum = 1_048_576): Promise<Record<string, unknown>> {
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(path, maximum))) as unknown); }
  catch (error) { if (error instanceof CliError) throw error; throw new CliError("Invalid UTF-8 JSON input file."); }
}
export interface CliService { close(): Promise<void> | void }
export interface HostOptions {
  config: Record<string, unknown>; configDirectory: string; stateDirectory: string;
  controllerUrl: string; enrollmentToken?: string; allowHttp: boolean; caFile?: string;
  signal: AbortSignal;
}
/** Host/dashboard ports can be injected by portable fixtures; production imports their TypeScript modules. */
export interface CliRuntime {
  controller(config: Record<string, unknown>): Promise<CliService>;
  dashboard(options: Record<string, unknown>): Promise<CliService>;
  host(options: HostOptions): Promise<CliService>;
  checkHost(options: HostOptions): Promise<Record<string, unknown>>;
  template(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  prepareImage(value: Record<string, unknown>, cache: string): Promise<string>;
}
async function runtimeModule(name: string): Promise<Record<string, unknown>> {
  try { return await import(new URL(name, import.meta.url).href) as Record<string, unknown>; }
  catch { throw new CliError(`The ${name.replace(/^.\//, "").replace(/\.[jt]s$/, "")} runtime module is unavailable in this build.`, 503); }
}
async function exported(name: string, fn: string): Promise<(...args: never[]) => unknown> {
  const module = await runtimeModule(name);
  if (typeof module[fn] !== "function") throw new CliError(`This build does not expose ${fn}; native execution remains unavailable.`, 503);
  return module[fn] as (...args: never[]) => unknown;
}
// Keep extension selection compatible with source execution and compiled distribution.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const defaults: CliRuntime = {
  async controller(config) {
    const { parseControllerConfig, startController } = await import("./main.ts");
    return startController(parseControllerConfig(config));
  },
  async dashboard(options) { return await (await exported(`./dashboard.${extension}`, "startDashboard"))({ ...options, orchestratorUrl: options.controllerUrl } as never) as CliService; },
  async host(options) {
    const { loadHost } = await import("./control/templates.ts");
    const { startHost } = await import("./host.ts");
    const config = { ...loadHost(options.config, options.configDirectory), url: options.controllerUrl, stateDir: options.stateDirectory, allowHTTP: options.allowHttp,
      ...(options.enrollmentToken ? { enrollmentToken: options.enrollmentToken } : {}), ...(options.caFile ? { caFile: options.caFile } : {}) };
    if (process.env.CANAVERAL_UPDATE_CANDIDATE === "1") {
      const { startManagedHost } = await import("./updates/runtime.ts");
      return startManagedHost(config);
    }
    return startHost(config);
  },
  async checkHost(options) {
    const { loadHost } = await import("./control/templates.ts");
    const { HostRunner } = await import("./host.ts");
    const runner = new HostRunner({ ...loadHost(options.config, options.configDirectory), url: options.controllerUrl, stateDir: options.stateDirectory, allowHTTP: options.allowHttp, ...(options.caFile ? { caFile: options.caFile } : {}) });
    try { await runner.initializeProviders(); await runner.checkEnvironment(); return runner.health; } finally { await runner.close(); }
  },
  async template(value) { const { normalizeTemplate } = await import("./control/templates.ts"); return normalizeTemplate(value); },
  prepareImage: prepareCachedImage,
};
export interface CliIO {
  stdout(text: string): void; stderr(text: string): void;
  client(url: string, token: string, allowHttp: boolean): RequestClient;
  password(prompt: string): Promise<string>;
  output: typeof privateOutput;
  runtime: CliRuntime;
  signal?: AbortSignal;
}
function signals(external?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (external) return { signal: external, dispose() {} };
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return { signal: controller.signal, dispose() { process.off("SIGINT", stop); process.off("SIGTERM", stop); } };
}
async function stopped(signal: AbortSignal): Promise<void> { if (!signal.aborted) await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true })); }
async function exists(path: string): Promise<boolean> { try { await fs.lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function initialize(directory: string): Promise<void> {
  const path = expandPath(directory); await fs.mkdir(path, { recursive: true, mode: 0o700 });
  if (await exists(join(path, "admin.token")) || await exists(join(path, "enrollment.token"))) throw new CliError("Credential files already exist; initialization will not overwrite them.");
  // Reserve both before writing so concurrent initialization cannot replace either credential.
  await privateOutput(join(path, "admin.token"), async writeAdmin => {
    await privateOutput(join(path, "enrollment.token"), async writeEnrollment => {
      await writeAdmin(randomBytes(32).toString("base64url") + "\n"); await writeEnrollment(randomBytes(32).toString("base64url") + "\n");
    });
  });
}
async function controllerConfig(args: CliArguments): Promise<Record<string, unknown>> {
  if (args.options.config) {
    if (Object.keys(args.options).some(key => key !== "config")) throw new CliError("Use --config alone; do not mix it with controller flags.");
    return jsonFile(option(args, "config"));
  }
  const statePath = resolve(expandPath(option(args, "database", "./state/orchestrator.sqlite3")));
  const admin = option(args, "admin-token-file", process.env.CANAVERAL_ADMIN_TOKEN_FILE);
  const enrollment = option(args, "enrollment-token-file", process.env.CANAVERAL_ENROLLMENT_TOKEN_FILE);
  await privateInput(admin); await privateInput(enrollment);
  let controllerId: string;
  if (args.options["controller-id"]) controllerId = uuid(option(args, "controller-id"));
  else {
    const identityFile = statePath + ".controller-id";
    if (!await exists(identityFile)) {
      if (await exists(statePath)) throw new CliError("Existing controller state requires --controller-id or an explicit --config; identity will not be guessed.");
      await fs.mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
      try { await privateOutput(identityFile, async write => write(randomUUID() + "\n")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    controllerId = uuid((await fs.readFile(identityFile, "utf8")).trim());
  }
  const config: Record<string, unknown> = { statePath, adminTokenFile: resolve(expandPath(admin)), enrollmentTokenFile: resolve(expandPath(enrollment)), controllerId,
    listen: { host: option(args, "bind", "127.0.0.1"), port: numberOption(args, "port", 8765, 1, 65535) } };
  if (args.options["update-trust-file"]) config.updatePublicKeys = await jsonFile(option(args, "update-trust-file"));
  if (args.options["tls-cert-file"] || args.options["tls-key-file"]) config.tls = { certFile: resolve(expandPath(option(args, "tls-cert-file"))), keyFile: resolve(expandPath(option(args, "tls-key-file"))) };
  return config;
}
async function hostOptions(args: CliArguments, signal: AbortSignal): Promise<HostOptions> {
  const file = resolve(expandPath(option(args, args.options["setup-file"] ? "setup-file" : "config")));
  let config = await jsonFile(file); let url = args.url;
  const managed = process.env.CANAVERAL_UPDATE_CANDIDATE === "1";
  if (managed && typeof config.url === "string") url = config.url;
  const enrollmentFile = args.options["enrollment-token-file"] ?? process.env.CANAVERAL_ENROLLMENT_TOKEN_FILE;
  let enrollment = typeof enrollmentFile === "string" ? await privateInput(enrollmentFile) : undefined;
  if (args.options["setup-file"]) {
    config = await jsonFile(file);
    if (config.schemaVersion !== 1 || typeof config.controllerUrl !== "string" || !config.config || !config.enrollmentToken) throw new CliError("Unsupported connection setup file.");
    url = config.controllerUrl; enrollment = String(config.enrollmentToken);
    config = record(config.config);
    // The private setup token must pass the same validation as an enrollment file.
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(enrollment)) throw new CliError("Invalid setup enrollment token.");
    if (!args.options.check && !managed) {
      const saved = join(resolve(expandPath(option(args, "state"))), "host-config.json");
      if (await exists(saved)) {
        if (canonical(await jsonFile(saved)) !== canonical(config)) throw new CliError("State directory contains a different runner config; choose another state directory.");
      } else { await fs.mkdir(dirname(saved), { recursive: true, mode: 0o700 }); await privateOutput(saved, async write => write(JSON.stringify(config) + "\n")); }
    }
  }
  return { config, configDirectory: dirname(file), stateDirectory: resolve(expandPath(option(args, "state"))), controllerUrl: url, allowHttp: managed ? (args.allowHttp || config.allowHTTP === true) : args.allowHttp, signal,
    ...(enrollment ? { enrollmentToken: enrollment } : {}), ...(args.options["ca-file"] ? { caFile: resolve(expandPath(option(args, "ca-file"))) } : managed && typeof config.caFile === "string" ? { caFile: config.caFile } : {}) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
async function credentialRequest(destination: string, client: RequestClient, route: string, body: Record<string, unknown>, io: CliIO, resourceId: string): Promise<Record<string, unknown>> {
  let received = false;
  try {
    return await io.output(destination, async write => {
      const reply = await client.request("POST", route, body); received = true;
      if (reply.id !== resourceId || typeof reply.credential !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(reply.credential)) throw new CliError("Credential exchange was not confirmed for this resource. Inspect state before an explicit rotation.", 502, typeof body.id === "string" ? body.id : undefined, "unknown");
      await write(reply.credential + "\n"); return reply;
    });
  } catch (error) {
    if (received && !(error instanceof CliError)) throw new CliError("Credential file could not be saved after issuance. Inspect the resource before an explicit rotation; no automatic retry.", 503, typeof body.id === "string" ? body.id : undefined, "unknown");
    throw error;
  }
}
const deviceActions = ["screenshot", "hierarchy", "apps", "logs", "tap", "swipe", "text", "key", "install", "uninstall", "launch", "terminate", "open-url", "location", "push", "pull", "shell", "permission", "rotate", "accessibility", "accessibility-action", "list-files", "shell-open", "shell-read", "shell-write", "shell-resize", "shell-close"];
async function handleRemote(args: CliArguments, io: CliIO): Promise<void> {
  const client = io.client(args.url, await credential(args), args.allowHttp);
  let result: Record<string, unknown>;
  if (["hosts", "machines", "templates", "models", "jobs", "images", "image-tasks"].includes(args.command)) result = await client.request("GET", "/v1/" + args.command);
  else if (["machine", "job", "image-task"].includes(args.command)) result = await client.request("GET", `/v1/${{ machine: "machines", job: "jobs", "image-task": "image-tasks" }[args.command]}/${uuid(positional(args))}`);
  else if (args.command === "cancel-job") result = await client.request("POST", `/v1/jobs/${uuid(positional(args))}/cancel`, {});
  else if (args.command === "create") {
    const resources: Record<string, number> = {};
    for (const [flag, key] of [["cpu", "cpu"], ["memory-mib", "memoryMiB"], ["disk-gib", "diskGiB"]]) if (args.options[flag!]) resources[key!] = numberOption(args, flag!);
    const body: Record<string, unknown> = { id: uuid(option(args, "request-id")), name: positional(args), templateId: option(args, "template"), resources };
    for (const [flag, key] of [["template-revision", "templateRevision"], ["arch", "arch"], ["host-id", "hostId"]]) if (args.options[flag!]) body[key!] = flag === "host-id" ? uuid(option(args, flag)) : option(args, flag!);
    result = await client.request("POST", "/v1/machines", body);
  } else if (args.command === "generate") {
    const prompt = new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(option(args, "prompt-file"), 65536));
    const body: Record<string, unknown> = { id: uuid(option(args, "request-id")), model: option(args, "model"), prompt, maxTokens: numberOption(args, "max-tokens", 600) };
    if (args.options.digest) body.digest = option(args, "digest"); if (args.options["host-id"]) body.hostId = uuid(option(args, "host-id"));
    result = await client.request("POST", "/v1/jobs", body);
  } else if (args.command === "device") {
    const action = positional(args, 1); if (!deviceActions.includes(action)) throw new CliError("Unsupported device action.");
    const { operationRequest } = await import("./control/devices.ts");
    const validated = operationRequest({ id: uuid(option(args, "request-id")), action, arguments: args.options["arguments-file"] ? await jsonFile(option(args, "arguments-file")) : {} });
    const body = { id: validated.id, action: validated.action, arguments: validated.arguments };
    result = await client.request("POST", `/v1/machines/${uuid(positional(args))}/operations`, body);
  } else if (args.command === "operation") {
    result = await client.request("GET", `/v1/operations/${uuid(positional(args))}`);
    if (args.options.output) {
      const binary = record(result.result);
      if (result.state !== "succeeded" || typeof binary.data !== "string") throw new CliError("Operation has no successful binary result to save.");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(binary.data)) throw new CliError("Operation binary result is not valid base64.", 502);
      const data = Buffer.from(binary.data, "base64");
      if (data.toString("base64") !== binary.data) throw new CliError("Operation binary result is not canonical base64.", 502);
      await io.output(option(args, "output"), async write => write(data)); result.result = { output: option(args, "output"), mediaType: binary.mediaType };
    }
  } else if (["start", "stop"].includes(args.command)) result = await client.request("POST", `/v1/machines/${uuid(positional(args))}/desired`, { state: args.command === "start" ? "running" : "stopped" });
  else if (["drain", "accept"].includes(args.command)) result = await client.request("POST", `/v1/hosts/${uuid(positional(args))}/accepting`, { enabled: args.command === "accept" });
  else if (args.command === "image") {
    const body = await jsonFile(option(args, "request-file")); body.id = uuid(String(body.id));
    result = await client.request("POST", "/v1/images/captures", body);
  } else if (args.command === "leases") {
    if (args.action === "templates") result = await client.request("GET", "/v1/environments/templates");
    else if (args.action === "acquire") { const body = await jsonFile(option(args, "request-file")); body.id = uuid(String(body.id)); result = await client.request("POST", "/v1/leases", body); }
    else result = await client.request("GET", "/v1/leases" + (args.options.after ? "?after=" + encodeURIComponent(option(args, "after")) : ""));
  }
  else if (args.command === "lease") {
    const route = `/v1/leases/${uuid(positional(args))}`;
    if (!args.action) result = await client.request("GET", route);
    else if (args.action === "credential") {
      const destination = option(args, "output-file");
      result = await credentialRequest(destination, client, route + "/credential", {}, io, uuid(positional(args)));
      result = { ...metadata(result), credentialFile: expandPath(destination) };
    } else {
      const body = await jsonFile(option(args, "request-file")); body.id = uuid(String(body.id));
      result = await client.request("POST", route + "/" + args.action, body);
    }
  } else if (args.command === "apps") {
    if (args.action === "list") result = await client.request("GET", "/v1/consumers");
    else if (args.action === "revoke") result = await client.request("POST", `/v1/consumers/${uuid(positional(args))}/revoke`, {});
    else {
      const body = args.action === "credential" ? {} : args.options["request-file"] ? await jsonFile(option(args, "request-file")) : { id: uuid(option(args, "request-id")), name: option(args, "name") };
      if (args.action === "create") body.id = uuid(String(body.id));
      const route = args.action === "create" ? "/v1/consumers" : `/v1/consumers/${uuid(positional(args))}/credential`;
      const destination = option(args, "output-file");
      result = await credentialRequest(destination, client, route, body, io, args.action === "create" ? String(body.id) : uuid(positional(args)));
      result = { ...metadata(result), credentialFile: expandPath(destination) };
    }
  } else throw new CliError("Unsupported command.");
  io.stdout(JSON.stringify(metadata(result), null, 2) + "\n");
}

/** Execute without exiting the embedding process. Returns a conventional exit status. */
export async function main(argv = process.argv.slice(2), overrides: Partial<CliIO> = {}): Promise<number> {
  // The stable launcher has a fixed bootstrap argv; ordinary CLI parsing is unchanged.
  if (process.env.CANAVERAL_UPDATE_CANDIDATE === "1" && argv.length === 4 && argv[0] === "--config" && argv[2] === "--state") argv = ["host", ...argv];
  const io: CliIO = { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    client: (url, token, allowHttp) => new CliClient(url, token, allowHttp), password: promptPassword, output: privateOutput, runtime: defaults, ...overrides };
  try {
    let boundary = 0;
    while (boundary < argv.length) {
      const arg = argv[boundary]!;
      const flag = arg.split("=", 1)[0];
      if (flag === "--allow-http") boundary++;
      else if (flag === "--url" || flag === "--token-file") boundary += arg.includes("=") ? 1 : 2;
      else break;
    }
    if (argv[boundary] === "updates") {
      const { updateMain } = await import("./updates/cli.ts");
      return updateMain([...argv.slice(0, boundary), ...argv.slice(boundary + 1)], { stdout: io.stdout, stderr: io.stderr });
    }
    if (argv.includes("--help") || argv.includes("-h")) { io.stdout(HELP); return 0; }
    const args = parseCli(argv);
    if (args.command === "init") { await initialize(positional(args)); io.stdout("Created private credential files in " + positional(args) + "\n"); return 0; }
    if (["serve", "dashboard", "host", "local"].includes(args.command)) {
      const lifecycle = signals(io.signal); let service: CliService | undefined;
      try {
        if (args.command === "local") { const { runLocal } = await import("./local.ts"); await runLocal(args, io, lifecycle.signal); return 0; }
        if (args.command === "serve") service = await io.runtime.controller(await controllerConfig(args));
        else if (args.command === "dashboard") {
          let bootstrap = args.options["bootstrap-token-file"] ?? process.env.CANAVERAL_ADMIN_TOKEN_FILE;
          if (!bootstrap && await exists("./secrets/admin.token")) bootstrap = "./secrets/admin.token";
          service = await io.runtime.dashboard({ listen: { host: option(args, "bind", "127.0.0.1"), port: numberOption(args, "port", 8766, 1, 65535) }, controllerUrl: args.url,
            allowHttp: args.allowHttp, ...(typeof bootstrap === "string" ? { bootstrapToken: await privateInput(bootstrap) } : {}) });
        } else {
          const options = await hostOptions(args, lifecycle.signal);
          if (args.options.check) { const report = await io.runtime.checkHost(options); io.stdout(JSON.stringify(metadata(report), null, 2) + "\n"); return report.status === "failed" ? 1 : 0; }
          service = await io.runtime.host(options);
        }
        io.stdout(JSON.stringify({ service: args.command, listening: args.command !== "host" }) + "\n");
        await stopped(lifecycle.signal);
      } finally { try { await service?.close(); } finally { lifecycle.dispose(); } }
      return 0;
    }
    if (args.command === "template") {
      const value = await jsonFile(positional(args)); const result = await io.runtime.template(value);
      if (args.action === "prepare") { if (!value.source) throw new CliError("This template has no base image source to cache."); result.image = await io.runtime.prepareImage(record(value.source), option(args, "cache", "./state/images")); }
      io.stdout(JSON.stringify(result, null, 2) + "\n"); return 0;
    }
    const account: AccountContext = { client: token => io.client(args.url, token, args.allowHttp), password: io.password, output: io.output, print: value => io.stdout(JSON.stringify(value, null, 2) + "\n") };
    if (!await handleAccount(args, account)) await handleRemote(args, io);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr("canaveral: " + error.message + (error.outcome ? " outcome=unknown; no automatic retry." : "") + (error.requestId ? " requestId=" + error.requestId : "") + "\n");
    } else if (error instanceof ServiceError) io.stderr(`canaveral: Command refused (HTTP ${error.status}, ${error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}). Inspect configuration or state before retrying.${error.outcome ? " outcome=unknown; no automatic retry." : ""}\n`);
    else if (error instanceof Error && error.name.startsWith("ERR_PARSE_ARGS")) io.stderr("canaveral: Invalid command arguments.\n");
    else if ((error as NodeJS.ErrnoException)?.code) io.stderr("canaveral: Local file or command input failed (" + String((error as NodeJS.ErrnoException).code).replace(/[^A-Z0-9_]/g, "").slice(0, 60) + ").\n");
    else io.stderr("canaveral: Command failed. Inspect state before retrying; no credentials were printed.\n");
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();

/** Use the shared guarded image cache, including uncertain-publication recovery. */
export async function prepareCachedImage(value: Record<string, unknown>, directory: string): Promise<string> {
  const { prepareImage } = await import("./control/images.ts");
  return prepareImage(value, resolve(expandPath(directory)));
}
