/** `canaveral mcp`: a Model Context Protocol server over stdio, written directly against JSON-RPC 2.0.
 *
 * One process is one agent session. It holds an application key (read from a private file), leases
 * devices through durable requests, keeps the lease keys in memory, renews what it holds and
 * releases everything when stdin closes or on SIGINT/SIGTERM. stdout carries protocol messages
 * only; diagnostics go to stderr and never include a credential.
 *
 * Supported: initialize, ping, tools/list, tools/call, resources/list, resources/read,
 * logging/setLevel, notifications/cancelled, notifications/progress and notifications/message.
 * Not supported: JSON-RPC batches, prompts, sampling, resource subscriptions and HTTP transports.
 * Fixture-covered over pipes against a loopback controller; not accepted against a real client
 * or a real emulator.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ServiceError } from "./errors.ts";
import { ConsumerError, ConsumerProtocolError, ConsumerServiceError, identifier, record } from "./sdk.ts";
import { AgentError, Cancelled, LeaseSession, deviceTemplates } from "./agent-session.ts";
import type { LeaseIntent, SessionNotice, SessionOptions } from "./agent-session.ts";
import { AGENT_ACTIONS, LEASE_ACTIONS, OperationUnknown, installBuild, runOperation } from "./agent-device.ts";
import { INSTRUCTIONS_URI, RULES, SUMMARY } from "./agent-instructions.ts";

/** Version of this tool surface, not of the package. */
export const MCP_SERVER_VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";
const LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const MAX_LINE = 4 * 1_048_576, MAX_TEXT = 200_000;

type Id = string | number;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean }
interface Call { signal: AbortSignal; progress(message: string): void }

const ARGUMENTS: Record<string, string> = {
  screenshot: "none", hierarchy: "none", accessibility: "none", apps: "none", logs: "none",
  tap: "x, y (integers, device pixels)", swipe: "x, y, toX, toY (device pixels) and durationMs (1 to 10000)",
  text: "text (single-line ASCII)", key: "key (an Android key event, for example KEYCODE_HOME)",
  launch: "app (a component such as com.example/.MainActivity)", terminate: "app (a package)", uninstall: "app (a package)",
  "open-url": "url", shell: "argv (an array of strings; runs inside the guest)",
};
const leaseId = { type: "string", description: "Lease UUID from lease_device. May be omitted while this session holds exactly one lease." };
const TOOLS = [
  { name: "list_device_templates", title: "List leasable devices",
    description: "Lists the device templates this application may lease, with their capabilities, whether an eligible host is online (available) and the application's limits. Only Android emulator templates run today.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "lease_device", title: "Lease a device",
    description: "Leases one device for this session and waits until it is booted and checked. When every device is in use the request queues and this call reports progress (queued, booting); cancelling the call withdraws the request. " +
      "The session renews the lease automatically and releases it when the session closes. Call release_device as soon as you are done. Lease only what the task needs.",
    inputSchema: { type: "object", additionalProperties: false, required: ["templateId"], properties: {
      templateId: { type: "string", description: "Template id from list_device_templates." },
      templateRevision: { type: "string", description: "Needed only when several revisions of the template are offered." },
      arch: { type: "string", enum: ["arm64", "amd64"], description: "Needed only when the template is offered for several architectures." },
      ttlSeconds: { type: "integer", minimum: 1, description: "Lease TTL. The session renews when about a third of it remains. Defaults to the application's default." },
      name: { type: "string", description: "Optional name for the leased device." },
      priority: { type: "integer", description: "Queue priority, within the application's maximum. Default 0." },
      waitSeconds: { type: "integer", minimum: 1, maximum: 86400, description: "How long to wait for a free device before giving up with nothing leased. Default 600." },
      requestId: { type: "string", description: "Optional stable UUID for this lease. Repeat it to resume a lease request whose result you lost; it becomes the lease id." },
      source: { type: "object", description: "Optional small object of tags stored with the request, for example the task or run. It changes no behavior." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "lease_status", title: "Lease status",
    description: "Returns the controller's current view of the leases this session holds (state, expiry, renewal, readiness), the requests still waiting and the leases that ended. A lease that ended is no longer yours.",
    inputSchema: { type: "object", additionalProperties: false, properties: { leaseId: { type: "string", description: "One lease UUID. Omit for every lease of this session." } } },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "device_action", title: "Act on a leased device",
    description: "Performs one action on a device this session holds, through the lease's own key. Actions and their arguments: " +
      AGENT_ACTIONS.map(action => `${action}: ${ARGUMENTS[action]!}`).join("; ") + ". " +
      "A screenshot is returned as an image. Every action is one durable operation: if the result is `unknown`, the action may or may not have happened and was NOT replayed. Inspect the device (screenshot) before deciding. " +
      "To read a receipt again, repeat the call with the same operationId, action and arguments; that never runs the action twice.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action"], properties: {
      leaseId, action: { type: "string", enum: [...AGENT_ACTIONS] },
      arguments: { type: "object", description: "Arguments of the action, as listed in the tool description. Omit for actions that take none." },
      operationId: { type: "string", description: "Optional UUID of this operation. Generated when omitted and always returned." },
      waitSeconds: { type: "integer", minimum: 1, maximum: 300, description: "How long to wait for the receipt. Default 120." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "install_app", title: "Install a build",
    description: "Uploads one APK from a local file through the lease key and installs it on the leased device. Any size up to 2 GiB. " +
      "If the install result is `unknown` it may or may not have been installed and was NOT repeated: check with device_action apps.",
    inputSchema: { type: "object", additionalProperties: false, required: ["file"], properties: {
      leaseId, file: { type: "string", description: "Path of the APK on this machine." },
      artifactId: { type: "string", description: "Optional UUID of the upload. Repeat it to resume an interrupted upload of the same file." },
      installId: { type: "string", description: "Optional UUID of the install operation. Repeat it to read the same install receipt again." },
      waitSeconds: { type: "integer", minimum: 1, maximum: 1800, description: "How long to wait for the install receipt. Default 600." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: "release_device", title: "Release a device",
    description: "Releases a lease this session holds and stops renewing it. Always call this when the device work is done, also after a failure. The device is destroyed, never reused: the next waiting request gets a fresh one.",
    inputSchema: { type: "object", additionalProperties: false, properties: { leaseId } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
];

function text(value: Record<string, unknown>, isError = false, extra: Content[] = []): ToolResult {
  return { content: [...extra, { type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function clip(value: string): string { return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + `\n[truncated: ${value.length - MAX_TEXT} more characters]` : value; }
/** Safe description of a failure for the model: stable code, bounded text, no credential. */
export function describe(error: unknown): Record<string, unknown> {
  if (error instanceof AgentError) return { code: error.code, message: error.message, ...error.details };
  if (error instanceof ConsumerError) {
    return { code: error.code, message: error.message,
      ...((error instanceof ConsumerServiceError || error instanceof ConsumerProtocolError) && error.status !== undefined ? { status: error.status } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error instanceof ConsumerServiceError && error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.outcome ? { outcome: "unknown", guidance: "This request may or may not have taken effect. Inspect before acting again; do not retry it under a new id." } : {}) };
  }
  // Local checks of the app-artifact client: static texts.
  if (error instanceof ServiceError) return { code: error.code, message: error.message, status: error.status };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return { code: "local_file_error", message: `A local file could not be used (${code.replace(/[^A-Z0-9_]/g, "").slice(0, 40)}).` };
  return { code: "internal_error", message: "The tool failed unexpectedly. Check lease_status before acting again." };
}
function fields(args: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(args).filter(key => !allowed.includes(key));
  if (extra.length) throw new AgentError(`Unknown argument: ${extra.join(", ").slice(0, 200)}.`, "invalid_arguments", { allowed });
}
function optional<T>(value: unknown, kind: "string" | "number", what: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== kind || (kind === "number" && !Number.isSafeInteger(value)) || (kind === "string" && !value)) throw new AgentError(`${what} must be ${kind === "number" ? "an integer" : "a non-empty string"}.`, "invalid_arguments");
  return value as T;
}
function uuid(value: unknown, what: string): string | undefined {
  const given = optional<string>(value, "string", what);
  if (given === undefined) return undefined;
  try { return identifier(given); } catch { throw new AgentError(`${what} must be a UUID.`, "invalid_arguments"); }
}
function seconds(value: unknown, what: string, fallback: number, maximum: number): number {
  const given = optional<number>(value, "number", what) ?? fallback;
  if (given < 1 || given > maximum) throw new AgentError(`${what} must be from 1 to ${maximum}.`, "invalid_arguments");
  return given;
}

export class McpServer {
  readonly #session: LeaseSession;
  readonly #write: (line: string) => void;
  readonly #sessionId = randomUUID();
  readonly #calls = new Map<Id, AbortController>();
  readonly #pending = new Set<Promise<void>>();
  #initialized = false;
  #level = LEVELS.indexOf("info");
  #client = "unknown";

  constructor(session: LeaseSession, write: (line: string) => void) { this.#session = session; this.#write = write; }

  #send(message: Record<string, unknown>): void { this.#write(JSON.stringify({ jsonrpc: "2.0", ...message })); }
  #fail(id: Id | null, code: number, message: string): void { this.#send({ id, error: { code, message } }); }

  /** A lease-ending or renewal notice becomes a logging notification, at or above the client's level. */
  notice(notice: SessionNotice): void {
    if (!this.#initialized || LEVELS.indexOf(notice.level) < this.#level) return;
    const { level, ...data } = notice;
    this.#send({ method: "notifications/message", params: { level, logger: "canaveral", data } });
  }

  /** The framing layer dropped a line it could not accept. */
  reject(message: string): void { this.#fail(null, -32700, message); }

  /** One JSON-RPC message. Requests are answered; notifications never are. */
  receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.#fail(null, -32700, "Parse error."); return; }
    if (Array.isArray(message)) { this.#fail(null, -32600, "Batches are not supported."); return; }
    if (!record(message) || message.jsonrpc !== "2.0") { this.#fail(null, -32600, "Invalid request."); return; }
    const id = message.id, method = message.method;
    // Replies to server requests: this server sends none.
    if (typeof method !== "string") { if (!("result" in message) && !("error" in message)) this.#fail(null, -32600, "Invalid request."); return; }
    const params = message.params === undefined ? {} : message.params;
    if (id === undefined) { if (record(params)) this.#notification(method, params); return; }
    if (typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id))) { this.#fail(null, -32600, "Invalid request id."); return; }
    if (!record(params)) { this.#fail(id, -32602, "Invalid params."); return; }
    try { this.#request(id, method, params); }
    catch { this.#fail(id, -32603, "Internal error."); }
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (method !== "notifications/cancelled") return;
    const target = params.requestId;
    // The cancelled call sends no reply. A lease wait withdraws its request before it ends.
    if (typeof target === "string" || typeof target === "number") this.#calls.get(target)?.abort();
  }

  #request(id: Id, method: string, params: Record<string, unknown>): void {
    const respond = (result: Record<string, unknown>) => this.#send({ id, result });
    if (method === "ping") { respond({}); return; }
    if (method === "initialize") {
      const wanted = params.protocolVersion, info = params.clientInfo;
      if (record(info) && typeof info.name === "string") this.#client = info.name.replace(/[^\w .@/-]/g, "").slice(0, 80) || "unknown";
      this.#initialized = true;
      respond({ protocolVersion: typeof wanted === "string" && PROTOCOLS.includes(wanted) ? wanted : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, logging: {} },
        serverInfo: { name: "canaveral", title: "Canaveral device leases", version: MCP_SERVER_VERSION }, instructions: SUMMARY });
      return;
    }
    if (!this.#initialized) { this.#fail(id, -32002, "Server not initialized."); return; }
    if (method === "logging/setLevel") {
      const level = LEVELS.indexOf(String(params.level));
      if (level < 0) { this.#fail(id, -32602, "Unknown logging level."); return; }
      this.#level = level; respond({}); return;
    }
    if (method === "tools/list") { respond({ tools: TOOLS }); return; }
    if (method === "resources/list") {
      respond({ resources: [{ uri: INSTRUCTIONS_URI, name: "instructions", title: "Canaveral rules for coding agents", mimeType: "text/markdown",
        description: "Lease before touching a device, hold only what the task needs, renew, always release, never touch a device you do not hold, and how to treat unknown." }] });
      return;
    }
    if (method === "resources/templates/list") { respond({ resourceTemplates: [] }); return; }
    if (method === "resources/read") {
      if (params.uri !== INSTRUCTIONS_URI) { this.#fail(id, -32002, "Resource not found."); return; }
      respond({ contents: [{ uri: INSTRUCTIONS_URI, mimeType: "text/markdown", text: RULES }] }); return;
    }
    if (method !== "tools/call") { this.#fail(id, -32601, "Method not found."); return; }
    const name = params.name, args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
    if (typeof name !== "string" || !TOOLS.some(tool => tool.name === name)) { this.#fail(id, -32602, "Unknown tool."); return; }
    if (!record(args)) { this.#fail(id, -32602, "Tool arguments must be an object."); return; }
    if (this.#calls.has(id)) { this.#fail(id, -32600, "Request id is already in use."); return; }
    const abort = new AbortController(), token = record(params._meta) ? params._meta.progressToken : undefined;
    let step = 0, last = "", sent = 0;
    const call: Call = { signal: abort.signal, progress: message => {
      // Progress is sent when it changes, and now and then while it does not, so a client that resets
      // its timeout on progress keeps waiting through a long queue.
      if ((typeof token !== "string" && typeof token !== "number") || abort.signal.aborted || (message === last && performance.now() - sent < 10_000)) return;
      last = message; sent = performance.now();
      this.#send({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message } });
    } };
    this.#calls.set(id, abort);
    const work: Promise<void> = this.#tool(name, args, call)
      .catch((error: unknown): ToolResult | undefined => error instanceof Cancelled || abort.signal.aborted ? undefined : text({ error: describe(error) }, true))
      .then(result => { this.#calls.delete(id); this.#pending.delete(work); if (result && !abort.signal.aborted) respond({ ...result }); });
    this.#pending.add(work);
  }

  async #tool(name: string, args: Record<string, unknown>, call: Call): Promise<ToolResult> {
    const session = this.#session;
    if (name === "list_device_templates") {
      fields(args, []);
      const catalogue = await session.catalogue(), devices = deviceTemplates(catalogue);
      return text({ templates: devices.map(image => ({ templateId: image.id, templateRevision: image.revision, arch: image.arch, os: image.os, available: image.available, capabilities: image.capabilities, device: image.device })),
        otherTemplates: catalogue.templates.length - devices.length,
        limits: Object.fromEntries(["activeLeases", "defaultTTLSeconds", "maxTTLSeconds", "maxLifetimeSeconds", "provisioningTimeoutSeconds", "maxWaitingRequests", "maxRequestPriority"].flatMap(key => key in catalogue.limits ? [[key, catalogue.limits[key]]] : [])) });
    }
    if (name === "lease_device") {
      fields(args, ["templateId", "templateRevision", "arch", "ttlSeconds", "name", "priority", "waitSeconds", "requestId", "source"]);
      const templateId = optional<string>(args.templateId, "string", "templateId");
      if (templateId === undefined) throw new AgentError("templateId is required. Use list_device_templates.", "invalid_arguments");
      if (args.arch !== undefined && args.arch !== "arm64" && args.arch !== "amd64") throw new AgentError("arch must be arm64 or amd64.", "invalid_arguments");
      if (args.source !== undefined && !record(args.source)) throw new AgentError("source must be an object.", "invalid_arguments");
      const requestId = uuid(args.requestId, "requestId"), ttlSeconds = optional<number>(args.ttlSeconds, "number", "ttlSeconds"), priority = optional<number>(args.priority, "number", "priority");
      const templateRevision = optional<string>(args.templateRevision, "string", "templateRevision"), label = optional<string>(args.name, "string", "name"), waitSeconds = optional<number>(args.waitSeconds, "number", "waitSeconds");
      const intent: LeaseIntent = { templateId, source: { ...(args.source as Record<string, unknown> | undefined), surface: "mcp", session: this.#sessionId, client: this.#client },
        ...(templateRevision === undefined ? {} : { templateRevision }), ...(args.arch === undefined ? {} : { arch: args.arch as "arm64" | "amd64" }), ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        ...(label === undefined ? {} : { name: label }), ...(priority === undefined ? {} : { priority }), ...(waitSeconds === undefined ? {} : { waitSeconds }), ...(requestId === undefined ? {} : { requestId }) };
      const held = await session.lease(intent, { signal: call.signal, progress: progress => call.progress(progress.message) });
      // A cancellation that arrived as the lease was granted gets no reply, so the caller would never learn its id.
      if (call.signal.aborted) { await session.release(held.leaseId).catch(() => {}); throw new Cancelled(); }
      return text({ ...held,
        guidance: "The device is yours. This session renews the lease. Use device_action and install_app with this leaseId, and call release_device as soon as you are done." });
    }
    if (name === "lease_status") { fields(args, ["leaseId"]); return text({ ...await session.status(uuid(args.leaseId, "leaseId")) }); }
    if (name === "release_device") {
      fields(args, ["leaseId"]);
      const released = await session.release(uuid(args.leaseId, "leaseId"));
      return text({ ...released, guidance: "Released. The device is no longer yours; its cleanup continues on the host." });
    }
    if (name === "device_action") {
      fields(args, ["leaseId", "action", "arguments", "operationId", "waitSeconds"]);
      const action = args.action;
      if (typeof action !== "string" || !(AGENT_ACTIONS as readonly string[]).includes(action)) throw new AgentError("Unsupported action.", "invalid_arguments", { actions: [...AGENT_ACTIONS] });
      if (args.arguments !== undefined && args.arguments !== null && !record(args.arguments)) throw new AgentError("arguments must be an object.", "invalid_arguments", { expects: ARGUMENTS[action] });
      const device = session.device(uuid(args.leaseId, "leaseId")), capability = LEASE_ACTIONS[action]!;
      if (device.capabilities[capability] !== true) throw new AgentError(`This lease lacks the ${capability} capability that ${action} needs.`, "capability_unsupported");
      const operationId = uuid(args.operationId, "operationId") ?? randomUUID(), waitMs = seconds(args.waitSeconds, "waitSeconds", 120, 300) * 1000;
      try {
        const operation = await runOperation(device.client, { id: operationId, member: "primary", action, arguments: (args.arguments ?? {}) as Record<string, unknown> }, { waitMs, signal: call.signal });
        return this.#receipt(device.leaseId, action, operation);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (error instanceof OperationUnknown) return this.#unknown(device.leaseId, action, operationId, describe(error.cause));
        if (error instanceof ConsumerServiceError && error.status === 410) void session.observe(device.leaseId);
        return text({ error: { ...describe(error), operationId, action, ...(error instanceof ConsumerError && error.code === "invalid_configuration" ? { expects: ARGUMENTS[action] } : {}) } }, true);
      }
    }
    // install_app
    fields(args, ["leaseId", "file", "artifactId", "installId", "waitSeconds"]);
    const file = optional<string>(args.file, "string", "file");
    if (file === undefined) throw new AgentError("file is required.", "invalid_arguments");
    const device = session.device(uuid(args.leaseId, "leaseId"));
    if (device.capabilities.files !== true) throw new AgentError("This lease lacks the files capability that an install needs.", "capability_unsupported");
    const artifactId = uuid(args.artifactId, "artifactId") ?? randomUUID(), installId = uuid(args.installId, "installId") ?? randomUUID();
    const waitMs = seconds(args.waitSeconds, "waitSeconds", 600, 1800) * 1000;
    try {
      const result = await installBuild(device.client, { file: resolve(file), member: "primary", artifactId, installId, waitMs, signal: call.signal,
        progress: phase => call.progress(phase === "uploading" ? "Uploading the build." : "Installing the build.") });
      const summary = { leaseId: device.leaseId, artifactId, installId, state: result.operation.state, bytes: result.artifact.bytes, sha256: result.artifact.sha256, uploadReleased: result.uploadReleased };
      if (result.operation.state === "unknown") return this.#unknown(device.leaseId, "install", installId, result.operation.result, { artifactId });
      if (result.operation.state !== "succeeded") void session.observe(device.leaseId);
      return text({ ...summary, ...(result.operation.state === "queued" ? { guidance: "Still queued. Call again with the same artifactId and installId to read the receipt; that never installs twice." } : {}),
        ...(result.operation.state === "failed" ? { detail: result.operation.result } : {}) }, result.operation.state === "failed");
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      if (error instanceof OperationUnknown) return this.#unknown(device.leaseId, "install", installId, describe(error.cause), { artifactId });
      if (error instanceof ConsumerServiceError && error.status === 410) void session.observe(device.leaseId);
      return text({ error: { ...describe(error), artifactId, installId, guidance: "Nothing is repeated automatically. To resume the same upload, call again with this artifactId and installId." } }, true);
    }
  }

  #unknown(lease: string, action: string, operationId: string, detail: unknown, extra: Record<string, unknown> = {}): ToolResult {
    void this.#session.observe(lease);
    return text({ leaseId: lease, operationId, ...extra, action, state: "unknown", replayed: false, detail,
      guidance: "The outcome is unknown: this may or may not have happened, and it was not sent again. Inspect the device (for example a screenshot or apps) before deciding. Do not repeat it under a new id." }, true);
  }

  #receipt(lease: string, action: string, operation: { id: string; state: string; result?: unknown }): ToolResult {
    const summary = { leaseId: lease, operationId: operation.id, action, state: operation.state }, result = record(operation.result) ? operation.result : {};
    if (operation.state === "unknown") return this.#unknown(lease, action, operation.id, operation.result);
    if (operation.state === "queued") return text({ ...summary, guidance: "Still queued; it was not run twice and will not be. Repeat the call with the same operationId, action and arguments to read its receipt." });
    if (operation.state === "failed") { void this.#session.observe(lease); return text({ ...summary, detail: operation.result }, true); }
    if (typeof result.data === "string" && typeof result.mediaType === "string" && result.mediaType.startsWith("image/")) {
      return text({ ...summary, mediaType: result.mediaType, bytes: Buffer.byteLength(result.data, "base64") }, false, [{ type: "image", data: result.data, mimeType: result.mediaType }]);
    }
    if (typeof result.output === "string" && Object.keys(result).length === 1) return { content: [{ type: "text", text: JSON.stringify(summary) }, { type: "text", text: clip(result.output) }] };
    return { content: [{ type: "text", text: JSON.stringify(summary) }, { type: "text", text: clip(JSON.stringify(result, null, 2)) }] };
  }

  /** Aborts every call in flight and waits for each to finish its own cleanup. */
  async close(): Promise<void> {
    for (const abort of this.#calls.values()) abort.abort();
    await Promise.all([...this.#pending]);
  }
}

export interface McpRun extends Omit<SessionOptions, "notice"> {
  input?: Readable; output?: Writable; log?: (line: string) => void;
  /** Ends the session like SIGTERM does. Without it the process signals are used. */
  signal?: AbortSignal;
}
/** Serves one session until stdin closes or a stop signal arrives, then releases what it holds.
 * Returns the process exit status: 1 when a release could not be confirmed. */
export async function runMcp(options: McpRun): Promise<number> {
  const { input = process.stdin, output = process.stdout, log = (line: string) => { process.stderr.write(line + "\n"); }, signal, ...client } = options;
  let attached: McpServer | undefined, broken = false;
  const session = new LeaseSession({ ...client, notice: notice => {
    log(`canaveral mcp: ${notice.event}${notice.leaseId ? " " + notice.leaseId : ""}`);
    attached?.notice(notice);
  } });
  const stopped = new Promise<string>(done => {
    const stop = (reason: string) => () => done(reason);
    input.once("end", stop("stdin closed")); input.once("close", stop("stdin closed")); input.once("error", stop("stdin failed"));
    // A client that went away shows up as a failed write.
    output.on("error", () => { broken = true; done("stdout closed"); });
    if (signal) { if (signal.aborted) done("stopped"); else signal.addEventListener("abort", stop("stopped"), { once: true }); }
    else for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, stop(name));
  });
  const server = attached = new McpServer(session, line => { if (!broken && !output.destroyed) output.write(line + "\n"); });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered: Buffer[] = [], size = 0, skipping = false;
  const line = (data: Buffer) => {
    if (!data.length) return;
    let value: string;
    try { value = decoder.decode(data).trim(); } catch { server.reject("Message is not UTF-8."); return; }
    if (value) server.receive(value);
  };
  const receive = (data: Buffer | string) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, end); start = end + 1;
      if (skipping) { skipping = false; continue; }
      const whole = size ? Buffer.concat([...buffered, piece]) : piece; buffered = []; size = 0;
      if (whole.length > MAX_LINE) server.reject("Message exceeds 4 MiB."); else line(whole);
    }
    if (skipping || start >= chunk.length) return;
    buffered.push(chunk.subarray(start)); size += chunk.length - start;
    if (size > MAX_LINE) { buffered = []; size = 0; skipping = true; server.reject("Message exceeds 4 MiB."); }
  };
  input.on("data", receive);
  const reason = await stopped;
  input.off("data", receive); input.pause();
  log(`canaveral mcp: ${reason}; releasing held leases.`);
  // Cancelled waits withdraw their requests first; then every held lease is released.
  const released = await Promise.race([server.close().then(() => session.close()), new Promise<undefined>(done => { setTimeout(done, 30_000, undefined).unref(); })]);
  const unconfirmed = released === undefined ? ["(release timed out)"] : released.filter(item => item.state === "release_unconfirmed").map(item => item.leaseId);
  for (const item of released ?? []) log(`canaveral mcp: lease ${item.leaseId} ${item.state}`);
  if (unconfirmed.length) log(`canaveral mcp: release unconfirmed for ${unconfirmed.join(", ")}; such leases end at their TTL.`);
  if (input === process.stdin) process.stdin.destroy();
  return unconfirmed.length ? 1 : 0;
}
