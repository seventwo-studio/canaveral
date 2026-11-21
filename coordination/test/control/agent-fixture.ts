import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startController } from "../../src/main.ts";

/** Fixture for the agent surfaces: a real loopback controller and a scripted host that speaks the
 * host HTTP protocol (enrollment, heartbeats, device operation receipts, lease cleanup receipts).
 * The scripted host "boots" a device after a delay, answers device operations from a table and
 * reports positive cleanup at once. It runs no HostRunner, lease supervisor, emulator or adb, so
 * these tests cover the MCP server and CLI against the controller's contract only;
 * android-leases.test.ts covers the runner side. Nothing here is native acceptance. */
export const arch = process.arch === "arm64" ? "arm64" : "amd64";
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
export const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out waiting for ${label}`);
}

export interface Dispatched { id: string; action: string; arguments: Record<string, any>; leaseId: string }
export interface Fixture {
  url: string; root: string; admin: string; image: { id: string; revision: string; arch: string };
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  /** Creates an application and saves its key in a private file. */
  application(limits?: Record<string, unknown>): Promise<{ key: string; keyFile: string }>;
  /** Every device operation the scripted host was handed, in order. One entry per delivery. */
  dispatched: Dispatched[];
  /** Device operations the host holds without a receipt (argv[0] === "hang"). */
  hanging: Set<string>;
  file(name: string, content: string | Buffer, mode?: number): string;
}
export async function agentFixture(t: TestContext, options: { devices?: number; bootMs?: number; scratchGiB?: number } = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-agent-")));
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  const url = `http://127.0.0.1:${controller.address.port}`;
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const devices = options.devices ?? 1, bootMs = options.bootMs ?? 300;
  const image = { id: "agent-phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 },
    device: { systemImage: `system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`, profile: "pixel_8" } };
  const offer = { name: "scripted agent host", provider: "android", capacity: { cpu: 2 * devices, memoryMiB: 2048 * devices, diskGiB: 8 * devices + (options.scratchGiB ?? 0) }, templates: [image],
    leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch, runtime: "android" }] };
  const hostId = randomUUID(), hostKey = randomBytes(32).toString("base64url");
  const enrolled = await api("POST", "/v1/hosts/enroll", { id: hostId, credential: hostKey, offer }, enrollment);
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  const dispatched: Dispatched[] = [], hanging = new Set<string>(), seen = new Map<string, number>(), answered = new Set<string>();
  const reports = new Map<string, Record<string, unknown>>();
  let stopped = false, report: Record<string, unknown> = {};
  const answer = (operation: Dispatched): Record<string, unknown> | undefined => {
    if (operation.action === "screenshot") return { state: "succeeded", result: { data: PNG.toString("base64"), mediaType: "image/png" } };
    if (operation.action === "shell" && operation.arguments.argv?.[0] === "uncertain") return { state: "unknown", result: { detail: "Dispatched work outcome requires inspection; it is not replayed." } };
    if (operation.action === "shell" && operation.arguments.argv?.[0] === "refuse") return { state: "failed", result: { detail: "fixture refusal" } };
    if (operation.action === "shell" && operation.arguments.argv?.[0] === "hang") return undefined;
    if (operation.action === "install-uploaded") return { state: "succeeded", result: { installed: true, artifactCleaned: true } };
    return { state: "succeeded", result: { output: `ok ${operation.action}` } };
  };
  const beat = async () => {
    const deviceReports = report; report = {};
    const reply = await api("POST", `/v1/hosts/${hostId}/heartbeat`, { offer, reports: Object.fromEntries(reports), deviceReports }, hostKey);
    if (reply.status !== 200) return;
    reports.clear();
    for (const machine of reply.body.machines as any[]) {
      if (machine.leaseCleanup) {
        if (machine.leaseCleanup.state !== "complete") reports.set(machine.id, { state: "stopped", leaseCleanup: { id: machine.leaseCleanup.id, leaseId: machine.leaseCleanup.leaseId, state: "complete",
          attempt: machine.leaseCleanup.attempts + 1, executionStopped: true, storageRemoved: true, credentialsErased: true } });
        continue;
      }
      if (machine.desired !== "running") { reports.set(machine.id, { state: "stopped" }); continue; }
      if (!seen.has(machine.id)) seen.set(machine.id, Date.now());
      reports.set(machine.id, Date.now() - seen.get(machine.id)! >= bootMs ? { state: "running", accessReady: true } : { state: "starting", detail: "booting" });
    }
    for (const operation of reply.body.deviceOperations as any[]) {
      if (answered.has(operation.id) || hanging.has(operation.id)) continue;
      const entry = { id: operation.id, action: operation.action, arguments: operation.arguments ?? {}, leaseId: operation.leaseId };
      dispatched.push(entry);
      const result = answer(entry);
      if (result === undefined) hanging.add(operation.id); else { answered.add(operation.id); report = { [operation.id]: result }; }
    }
  };
  const loop = (async () => { while (!stopped) { await beat().catch(() => {}); await sleep(100); } })();
  t.after(async () => { stopped = true; await loop; await controller.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  return { url, root, admin, image: { id: image.id, revision: "1", arch }, api, dispatched, hanging,
    file(name, content, mode = 0o600) { const path = join(root, name); writeFileSync(path, content, { mode }); return path; },
    async application(limits = {}) {
      const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: [{ id: image.id, revision: "1", arch }],
        limits: { resources: { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, activeLeases: 4, defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120, ...limits } });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const key = created.body.credential as string, keyFile = join(root, `application-${randomBytes(4).toString("hex")}.key`);
      writeFileSync(keyFile, key + "\n", { mode: 0o600 });
      return { key, keyFile };
    } };
}

export interface ToolReply { content: any[]; isError: boolean; json: any }
/** A minimal MCP client over the stdio pipes of a spawned `canaveral mcp`. */
export class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly notifications: any[] = [];
  /** Every reply line that carried an id, including error replies. */
  readonly replies: any[] = [];
  stderr = "";
  readonly exited: Promise<number | null>;
  #buffer = "";
  #next = 1;
  readonly #waiting = new Map<number | string, (message: any) => void>();
  constructor(url: string, keyFile: string, t: TestContext, extra: string[] = []) {
    this.child = spawn(process.execPath, [CLI, "--url", url, "--token-file", keyFile, "mcp", ...extra], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    this.exited = new Promise(resolve => this.child.once("exit", code => resolve(code)));
    this.child.stderr.on("data", (data: Buffer) => { this.stderr += data.toString("utf8"); });
    this.child.stdout.on("data", (data: Buffer) => {
      this.#buffer += data.toString("utf8");
      for (let end = this.#buffer.indexOf("\n"); end !== -1; end = this.#buffer.indexOf("\n")) {
        const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
        // stdout carries protocol messages only: every line must parse.
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        if (message.method !== undefined) { this.notifications.push(message); continue; }
        this.replies.push(message);
        const waiter = this.#waiting.get(message.id);
        if (waiter) { this.#waiting.delete(message.id); waiter(message); }
      }
    });
    t.after(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); });
  }
  raw(line: string): void { this.child.stdin.write(line + "\n"); }
  notify(method: string, params: Record<string, unknown> = {}): void { this.raw(JSON.stringify({ jsonrpc: "2.0", method, params })); }
  /** Sends a request and returns its id with the eventual reply message (result or error). */
  send(method: string, params: Record<string, unknown> = {}): { id: number; reply: Promise<any> } {
    const id = this.#next++;
    const reply = new Promise<any>(resolve => this.#waiting.set(id, resolve));
    this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return { id, reply };
  }
  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const message = await this.send(method, params).reply;
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  }
  async initialize(): Promise<any> {
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-client", version: "0" } });
    this.notify("notifications/initialized");
    return result;
  }
  start(name: string, args: Record<string, unknown> = {}, progressToken?: string): { id: number; reply: Promise<ToolReply> } {
    const sent = this.send("tools/call", { name, arguments: args, ...(progressToken === undefined ? {} : { _meta: { progressToken } }) });
    return { id: sent.id, reply: sent.reply.then(message => {
      assert.equal(message.error, undefined, JSON.stringify(message.error));
      const texts = (message.result.content as any[]).filter(item => item.type === "text");
      return { content: message.result.content, isError: message.result.isError === true, json: JSON.parse(texts[0].text) };
    }) };
  }
  call(name: string, args: Record<string, unknown> = {}, progressToken?: string): Promise<ToolReply> { return this.start(name, args, progressToken).reply; }
  progress(token: string): string[] { return this.notifications.filter(n => n.method === "notifications/progress" && n.params.progressToken === token).map(n => n.params.message as string); }
  logs(event?: string): any[] { return this.notifications.filter(n => n.method === "notifications/message" && (event === undefined || n.params.data.event === event)).map(n => n.params); }
  /** Closes stdin, as a client that disconnects does, and waits for the process to exit. */
  async disconnect(): Promise<number | null> { this.child.stdin.end(); return this.exited; }
}

/** Runs the built CLI as a separate process and collects its output. */
export function cli(args: string[], env: Record<string, string> = {}): { child: ChildProcessWithoutNullStreams; stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  return { child, stdout: () => stdout, stderr: () => stderr, exited: new Promise(resolve => child.once("exit", code => resolve(code))) };
}
