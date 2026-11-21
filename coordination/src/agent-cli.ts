/** CLI entry points of the agent surfaces: `mcp`, `lease hold`, `lease ID device|operation|install`,
 * `instructions` and `setup`. These commands hold or use a lease for a caller, so they run on the
 * consumer SDK transport (HTTPS, or HTTP to a loopback IP literal) and report the controller's
 * stable error codes. Credentials are read from private files only. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { CliError, credential, expandPath, metadata, option, positional, privateInput, uuid } from "./account-cli.ts";
import type { CliArguments } from "./account-cli.ts";
import type { CliIO } from "./cli.ts";
import { ConsumerConfigurationError, ConsumerError, ConsumerServiceError, LeaseClient } from "./sdk.ts";
import type { ClientOptions, DurableOperation } from "./sdk.ts";
import { ServiceError } from "./errors.ts";
import { AgentError, Cancelled, LeaseSession } from "./agent-session.ts";
import type { HeldView, LeaseIntent } from "./agent-session.ts";
import { LEASE_ACTIONS, OperationUnknown, awaitOperation, installBuild, runOperation } from "./agent-device.ts";
import { RULES, setupAgents, skillFile } from "./agent-instructions.ts";

/** Helpers that live in cli.ts. Passed in, because cli.ts cannot be imported back while it starts. */
export interface AgentCliTools {
  jsonFile(path: string): Promise<Record<string, unknown>>;
  number(args: CliArguments, name: string, fallback?: number, minimum?: number, maximum?: number): number;
}

function transport(args: CliArguments): ClientOptions {
  const url = new URL(args.url), host = url.hostname.replace(/^\[|\]$/g, ""), family = isIP(host);
  const loopback = (family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError("This command needs an HTTPS controller URL, or HTTP to a loopback IP literal such as 127.0.0.1. --allow-http does not apply to it.");
  }
  return { baseUrl: args.url, allowLoopbackHttp: true, ...(typeof args.options["ca-file"] === "string" ? { caFile: resolve(expandPath(args.options["ca-file"])) } : {}) };
}
/** A UUID the caller supplied, or a new one announced on stderr before anything is sent. */
function identity(args: CliArguments, io: CliIO, flag: string, what: string): string {
  if (typeof args.options[flag] === "string") return uuid(args.options[flag]);
  const id = randomUUID(); io.stderr(`${what} UUID ${id}\n`); return id;
}
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function hold(args: CliArguments, io: CliIO, tools: AgentCliTools): Promise<number> {
  const detach = args.options.detach === true, bound = args.options["bind-pid"] === undefined ? undefined : tools.number(args, "bind-pid", undefined, 1, 2_147_483_647);
  if (detach && bound !== undefined) throw new CliError("--detach holds nothing, so --bind-pid does not apply.");
  if (bound !== undefined && !running(bound)) throw new CliError("The --bind-pid process is not running.");
  const client = transport(args), applicationKey = await credential(args);
  const tags = typeof args.options["source-file"] === "string" ? await tools.jsonFile(args.options["source-file"]) : {};
  const intent: LeaseIntent = { templateId: option(args, "template"), requestId: identity(args, io, "request-id", "Lease request"), source: { ...tags, surface: "cli" },
    ...(typeof args.options.revision === "string" ? { templateRevision: args.options.revision } : {}),
    ...(typeof args.options.arch === "string" ? { arch: args.options.arch as "arm64" | "amd64" } : {}),
    ...(args.options.ttl === undefined ? {} : { ttlSeconds: tools.number(args, "ttl", undefined, 1, 2_147_483_647) }),
    ...(typeof args.options.name === "string" ? { name: args.options.name } : {}),
    ...(args.options.priority === undefined ? {} : { priority: tools.number(args, "priority", undefined, -1_000_000, 1_000_000) }),
    ...(args.options.wait === undefined ? {} : { waitSeconds: tools.number(args, "wait", undefined, 1, 86_400) }) };

  const stop = new AbortController(); let reason = "", ended: string | undefined;
  const halt = (why: string) => { if (!stop.signal.aborted) { reason = why; stop.abort(); } };
  const onSignal = () => halt("signal");
  if (io.signal) { if (io.signal.aborted) halt("signal"); else io.signal.addEventListener("abort", onSignal, { once: true }); }
  else for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, onSignal);
  // A parent that exits re-parents this process (Unix); a bound PID that is gone no longer answers signal 0.
  // Neither check can tell a recycled PID from the original process.
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) halt("parent exit"); else if (bound !== undefined && !running(bound)) halt("bound process exit");
  }, 500);
  const session = new LeaseSession({ ...client, applicationKey, notice: notice => {
    io.stderr(`canaveral: ${notice.message}\n`);
    if (notice.event === "lease_ended" && !stop.signal.aborted) { ended = String(notice.state); halt("lease ended"); }
  } });
  const dispose = () => { clearInterval(watch); io.signal?.removeEventListener("abort", onSignal); for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, onSignal); };
  let said = "";
  const acquire = async (write?: (text: string) => Promise<void>): Promise<HeldView> => {
    const held = await session.lease(intent, { signal: stop.signal, key: write !== undefined,
      progress: progress => { if (progress.message !== said) { said = progress.message; io.stderr(`canaveral: ${said}\n`); } } });
    if (write) await write(session.credential(held.leaseId) + "\n");
    return held;
  };
  const keyFile = args.options["lease-key-file"];
  let held: HeldView;
  try { held = typeof keyFile === "string" ? await io.output(keyFile, write => acquire(write)) : await acquire(); }
  catch (error) {
    dispose();
    // A lease granted before a failed key write is released here; a wait was already withdrawn.
    await session.close();
    if (!(error instanceof Cancelled)) throw error;
    io.stderr(`canaveral: Stopped (${reason}) before a device was granted; the request was cancelled.\n`); return 1;
  }
  io.stdout(JSON.stringify({ leaseId: held.leaseId, requestId: held.leaseId, state: held.state, revision: held.revision, expiresAt: held.expiresAt, ttlSeconds: held.ttlSeconds,
    template: held.template, capabilities: held.capabilities, member: "primary", held: !detach,
    ...(typeof keyFile === "string" ? { leaseKeyFile: resolve(expandPath(keyFile)) } : {}) }) + "\n");
  if (detach) { dispose(); session.detach(); return 0; }
  if (!stop.signal.aborted) await new Promise<void>(done => stop.signal.addEventListener("abort", () => done(), { once: true }));
  dispose();
  const released = await session.close();
  for (const item of released) io.stderr(`canaveral: Stopped (${reason}); lease ${item.leaseId} ${item.state}.\n`);
  if (ended !== undefined) io.stderr(`canaveral: The lease ended by itself (${ended}); nothing was left to release.\n`);
  return ended !== undefined || released.some(item => item.state === "release_unconfirmed") ? 1 : 0;
}

async function leaseKey(args: CliArguments): Promise<LeaseClient> {
  const file = args.options["lease-key-file"] ?? process.env.CANAVERAL_LEASE_KEY_FILE;
  if (typeof file !== "string" || !file) throw new CliError("Supply --lease-key-file (or CANAVERAL_LEASE_KEY_FILE); a lease key is never a command-line value.");
  return new LeaseClient({ ...transport(args), leaseId: uuid(positional(args)), leaseKey: await privateInput(file) });
}
/** Prints receipt metadata only. Guest output can hold application data, so it goes to `--output` or nowhere. */
async function receipt(args: CliArguments, io: CliIO, operation: DurableOperation, extra: Record<string, unknown> = {}): Promise<number> {
  const { result, ...summary } = operation as DurableOperation & { result?: Record<string, unknown> };
  const view: Record<string, unknown> = { ...extra, ...summary };
  if (result !== undefined && operation.state === "succeeded" && typeof args.options.output === "string") {
    const destination = args.options.output;
    let bytes: Buffer | string;
    if (typeof result.data === "string") {
      bytes = Buffer.from(result.data, "base64");
      if (bytes.toString("base64") !== result.data) throw new CliError("Operation binary result is not canonical base64.", 502);
    } else bytes = typeof result.output === "string" && Object.keys(result).length === 1 ? result.output : JSON.stringify(result) + "\n";
    await io.output(destination, async write => write(bytes));
    view.result = { output: expandPath(destination), ...(typeof result.mediaType === "string" ? { mediaType: result.mediaType } : {}) };
  } else if (result !== undefined) view.resultOmitted = true;
  io.stdout(JSON.stringify(metadata(view), null, 2) + "\n");
  if (operation.state === "succeeded") return 0;
  if (operation.state === "unknown") io.stderr("canaveral: Operation outcome=unknown; it may or may not have happened and was not sent again. Inspect the device before deciding.\n");
  else if (operation.state === "queued") io.stderr("canaveral: Operation is still queued. Inspect it later with: lease LEASE operation OPERATION.\n");
  else io.stderr("canaveral: Operation failed.\n");
  return 1;
}
async function leaseCommand(args: CliArguments, io: CliIO, tools: AgentCliTools): Promise<number> {
  const lease = await leaseKey(args), member = option(args, "member", "primary");
  if (args.action === "operation") {
    const wait = tools.number(args, "wait", 0, 0, 1800);
    return receipt(args, io, await awaitOperation(lease, await lease.operation(uuid(positional(args, 1))), wait * 1000));
  }
  if (args.action === "install") {
    const wait = tools.number(args, "wait", 600, 1, 1800);
    const artifactId = identity(args, io, "request-id", "Upload"), installId = identity(args, io, "install-id", "Install operation");
    try {
      const result = await installBuild(lease, { file: resolve(expandPath(positional(args, 1))), member, artifactId, installId, waitMs: wait * 1000, keepUpload: args.options["keep-upload"] === true,
        progress: phase => io.stderr(phase === "uploading" ? "canaveral: Uploading the build.\n" : "canaveral: Installing the build.\n") });
      return await receipt(args, io, result.operation, { artifactId, bytes: result.artifact.bytes, sha256: result.artifact.sha256, uploadReleased: result.uploadReleased });
    } catch (error) {
      if (error instanceof OperationUnknown) throw new CliError(`Install outcome is unknown and it was not sent again. Inspect it with: lease ${lease.id} operation ${installId}.`, 502, installId, "unknown");
      throw error;
    }
  }
  // device
  let request: { id: string; member: string; action: string; arguments: Record<string, unknown> };
  if (typeof args.options["request-file"] === "string") {
    if (args.options["request-id"] !== undefined || args.options["arguments-file"] !== undefined || args.options.member !== undefined) throw new CliError("A request file already holds the id, member, action and arguments.");
    const saved = await tools.jsonFile(args.options["request-file"]), body = saved.arguments;
    if (Object.keys(saved).sort().join(",") !== "action,arguments,id,member" || typeof saved.action !== "string" || typeof saved.member !== "string" || body === null || typeof body !== "object" || Array.isArray(body)) throw new CliError("A request file holds exactly id, member, action and arguments.");
    request = { id: uuid(String(saved.id)), member: saved.member, action: saved.action, arguments: body as Record<string, unknown> };
  } else {
    request = { id: identity(args, io, "request-id", "Operation"), member, action: positional(args, 1),
      arguments: typeof args.options["arguments-file"] === "string" ? await tools.jsonFile(args.options["arguments-file"]) : {} };
  }
  if (!Object.hasOwn(LEASE_ACTIONS, request.action)) throw new CliError(`Unsupported lease device action. Use one of: ${Object.keys(LEASE_ACTIONS).join(", ")}.`);
  const wait = tools.number(args, "wait", 120, 0, 1800);
  try { return await receipt(args, io, await runOperation(lease, request, { waitMs: wait * 1000 })); }
  catch (error) {
    if (error instanceof OperationUnknown) throw new CliError(`Operation outcome is unknown and it was not sent again. Inspect it with: lease ${lease.id} operation ${request.id}.`, 502, request.id, "unknown");
    throw error;
  }
}

/** Runs one agent-surface command and returns its exit status. SDK errors become CLI errors that
 * show the status and stable code, never the controller's free text. */
export async function agentCommand(args: CliArguments, io: CliIO, tools: AgentCliTools): Promise<number> {
  try {
    if (args.command === "instructions") { io.stdout(args.options.skill === true ? skillFile() : RULES); return 0; }
    if (args.command === "setup") {
      const agent = option(args, "agent", "all"), scope = args.options.project === true ? "project" : "user";
      if (!["claude", "codex", "all"].includes(agent)) throw new CliError("Use --agent claude, codex or all.");
      if (scope === "user" && args.options.directory !== undefined) throw new CliError("--directory names a project; use it with --project.");
      io.stdout(await setupAgents({ agents: agent === "all" ? ["claude", "codex"] : [agent as "claude" | "codex"], scope, force: args.options.force === true, url: args.url,
        ...(typeof args.options.directory === "string" ? { directory: expandPath(args.options.directory) } : {}), ...(args.tokenFile === undefined ? {} : { tokenFile: expandPath(args.tokenFile) }) }));
      return 0;
    }
    if (args.command === "mcp") {
      const client = transport(args), applicationKey = await credential(args);
      const { runMcp } = await import("./mcp.ts");
      return await runMcp({ ...client, applicationKey, ...(io.signal ? { signal: io.signal } : {}) });
    }
    if (args.action === "hold") return await hold(args, io, tools);
    return await leaseCommand(args, io, tools);
  } catch (error) {
    if (error instanceof AgentError) throw new CliError(`${error.message} (${error.code})`);
    if (error instanceof ConsumerServiceError) throw new CliError(`Controller refused the request (HTTP ${error.status}, ${error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}).`, error.status, error.requestId, error.outcome);
    if (error instanceof ConsumerConfigurationError) throw new CliError(error.message);
    if (error instanceof ConsumerError) throw new CliError(`Controller request was not confirmed (${error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}).`, 503, error.requestId, error.outcome);
    // Local checks of the app-artifact client: static texts.
    if (error instanceof ServiceError) throw new CliError(error.message, error.status);
    throw error;
  }
}
