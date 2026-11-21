import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { startController } from "../../src/main.ts";
import type { ControllerConfig } from "../../src/main.ts";
import { serverSentEvents } from "../../src/sse.ts";
import type { ServerSentEvent } from "../../src/sse.ts";

export type Json = Record<string, any>;
export const key = () => randomBytes(32).toString("base64url");
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Poll a real controller for an expected state; the fixture has no injected clock. */
export async function eventually<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("expected controller state was not reached: " + JSON.stringify(value)?.slice(0, 2000));
    await sleep(50);
  }
}
export const IMAGE = { id: "fixture-image", revision: "1", arch: "amd64", os: "linux", mode: "headless", guestAccess: true, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
/** A real controller on a loopback port with both workers, a disposable lease-capable fixture host and no native runtime. */
export async function controllerFixture(t: TestContext, observability: ControllerConfig["observability"] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-observability-"));
  const admin = key(), enrollment = key(), adminTokenFile = join(directory, "admin.token"), enrollmentTokenFile = join(directory, "enrollment.token");
  writeFileSync(adminTokenFile, admin, { mode: 0o600 }); writeFileSync(enrollmentTokenFile, enrollment, { mode: 0o600 });
  const config: ControllerConfig = { statePath: join(directory, "controller.sqlite"), adminTokenFile, enrollmentTokenFile, controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 }, observability };
  let controller: Awaited<ReturnType<typeof startController>> | undefined = await startController(config);
  t.after(async () => { await controller?.close(); rmSync(directory, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${controller!.address.port}`;
  async function raw(method: string, path: string, token = admin, body?: Json, headers: Record<string, string> = {}) {
    const response = await fetch(url() + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    return { status: response.status, type: response.headers.get("content-type") ?? "", text, body: (response.headers.get("content-type") ?? "").startsWith("application/json") ? JSON.parse(text) as Json : {} as Json };
  }
  async function call(method: string, path: string, token = admin, body?: Json, expected = 200): Promise<Json> {
    const reply = await raw(method, path, token, body);
    assert.equal(reply.status, expected, `${method} ${path}: ${reply.text.slice(0, 500)}`);
    return reply.body;
  }
  const host = randomUUID(), hostToken = key();
  const offer = { name: "disposable fixture", provider: "libvirt", capacity: { cpu: 64, memoryMiB: 65536, diskGiB: 512 }, templates: [IMAGE], leaseProtocol: 1,
    leaseImages: [{ id: IMAGE.id, revision: "1", arch: "amd64", runtime: "libvirt" }] };
  await call("POST", "/v1/hosts/enroll", enrollment, { id: host, credential: hostToken, offer });
  const beat = (reports: Json = {}) => call("POST", `/v1/hosts/${host}/heartbeat`, hostToken, { offer, reports });
  const application = async (limits: Json = {}) => await call("POST", "/v1/consumers", admin, { id: randomUUID(), name: "Fixture application", templates: [{ id: IMAGE.id, revision: "1", arch: "amd64" }],
    limits: { resources: { cpu: 64, memoryMiB: 65536, diskGiB: 512 }, activeLeases: 20, defaultTTLSeconds: 120, maxTTLSeconds: 3600, maxLifetimeSeconds: 7200, provisioningTimeoutSeconds: 900, ...limits } }) as { id: string; credential: string };
  const acquire = (credential: string, extra: Json = {}) => call("POST", "/v1/leases", credential, { id: randomUUID(), templateId: IMAGE.id, templateRevision: "1", arch: "amd64", ttlSeconds: 120, ...extra }, 201);
  const ready = (lease: Json) => beat({ [lease.members[0].machineId]: { state: "running", accessReady: true } });
  const events = async (query = "", token = admin, route = "/v1/admin/events") => (await call("GET", `${route}?limit=500${query ? "&" + query : ""}`, token)).events as Json[];
  /** Direct ledger writes stand in for a module whose native flow this fixture cannot drive. */
  const sql = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(config.statePath, { timeout: 15_000 });
    try { return work(db); } finally { db.close(); }
  };
  /** One live stream, collected until closed. `messages` grows as events arrive. */
  function follow(path: string, token = admin, headers: Record<string, string> = {}) {
    const messages: ServerSentEvent[] = [];
    let request: http.ClientRequest, status = 0;
    const opened = new Promise<number>((resolve, reject) => {
      request = http.request(url() + path, { agent: false, headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, response => {
        status = response.statusCode ?? 0; resolve(status);
        if (status !== 200) { response.resume(); return; }
        void (async () => { try { for await (const message of serverSentEvents(response)) messages.push(message); } catch { /* Closed by the test. */ } })();
      });
      request.once("error", reject); request.end();
    });
    const data = () => messages.filter(message => message.event === undefined).map(message => JSON.parse(message.data) as Json);
    return { opened, messages, data, close: () => request.destroy(), status: () => status };
  }
  return { config, directory, admin, enrollment, host, hostToken, offer, url, raw, call, beat, application, acquire, ready, events, sql, follow,
    async restart() { await controller!.close(); controller = undefined; controller = await startController(config); } };
}
