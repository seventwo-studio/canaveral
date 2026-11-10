import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ConsumerIdentities } from "../../src/consumers.ts";
import { LegacyLeases } from "../../src/control/leases.ts";
import { createModule as devicesModule } from "../../src/control/devices.ts";
import type { ControlRequest, ControlResponse } from "../../src/control/contracts.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";

export const key = () => randomBytes(32).toString("base64url");
export const failure = (status: number, code?: string) => (e: unknown) => e instanceof ServiceError && e.status === status && (code === undefined || e.code === code);
export function leaseFixture(t: TestContext, system = "linux", mode = "headless") {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-generic-leases-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  let now = 1000;
  const store = new SqliteStore(join(dir, "controller.sqlite"), () => now);
  const options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  const leases = new LegacyLeases(store, options), apps = new ConsumerIdentities(store);
  devicesModule(store, options);
  const host = randomUUID(), hostToken = key();
  const image = { id: "fixture-image", revision: "1", arch: "amd64", os: system, mode, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 },
    ...(system === "linux" ? { guestAccess: true } : {}),
    ...(system === "android" ? { device: { systemImage: "system-images;android-35;google_apis;x86_64", profile: "pixel_8" } } : {}),
    ...(system === "ios" ? { device: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" } } : {}) };
  const provider = system === "android" || system === "ios" ? system : "libvirt";
  let offer: Record<string, any> = { name: "disposable fixture", provider, capacity: { cpu: 512, memoryMiB: 1048576, diskGiB: 4096 }, templates: [image],
    leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch: "amd64", runtime: provider }] };
  leases.machines.enroll({ id: host, credential: hostToken, offer }, options.enrollmentToken);
  const application = (limits: Record<string, unknown> = {}, templates = [{ id: image.id, revision: "1", arch: "amd64" }]) => apps.create({ id: randomUUID(), name: "Fixture application", templates,
    limits: { resources: { cpu: 512, memoryMiB: 1048576, diskGiB: 4096 }, activeLeases: 200, defaultTTLSeconds: 120,
      maxTTLSeconds: 3600, maxLifetimeSeconds: 7200, provisioningTimeoutSeconds: 900, ...limits } });
  const app = application(), other = application();
  const raw = async (method: string, path: string, body: Record<string, unknown> = {}, token = app.credential): Promise<ControlResponse | undefined> => {
    const url = new URL(path, "http://fixture.invalid");
    const req: ControlRequest = { method, path: url.pathname, parts: url.pathname.split("/").filter(Boolean), query: url.searchParams, body, token,
      principal() { throw new ServiceError("Human credential rejected.", 401); } };
    return await leases.handle(req);
  };
  const request = async (method: string, path: string, body: Record<string, unknown> = {}, token = app.credential): Promise<any> => {
    const reply = await raw(method, path, body, token); assert.ok(reply, "generic route was owned"); return reply.body;
  };
  const acquire = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), templateId: image.id, templateRevision: "1", arch: "amd64", ttlSeconds: 120, ...extra });
  const beat = (extra: Record<string, unknown> = {}) => leases.machines.heartbeat(host, hostToken, { offer, ...extra });
  const ready = (lease: any) => beat({ reports: { [lease.members[0].machineId]: { state: "running", accessReady: true } } });
  const scoped = async (id: string, token = app.credential) => (await request("POST", `/v1/leases/${id}/credential`, {}, token)).credential as string;
  return { store, options, leases, apps, app, other, application, image, host, hostToken, acquire, raw, request, beat, ready, scoped,
    now: () => now, advance(seconds: number) { now += seconds; }, setNow(seconds: number) { now = seconds; },
    offer: () => offer, changeOffer(value: Record<string, unknown>) { offer = { ...offer, ...value }; for (const [k, v] of Object.entries(offer)) if (v === undefined) delete offer[k]; } };
}
