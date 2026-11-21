import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { memberSource } from "../../src/consumer-client.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";
import { WARM_SLOT, acquire, arch, cleaned, configurePool, harness, poolState, skip, sleep, systemImage, until, warmReady, warmTarget } from "./android-fixture.ts";
import type { Harness } from "./android-fixture.ts";

/** Which waiting requests may take a warm device's capacity. The pool must predict admission with
 * the rule admission itself uses, so a request that giving devices up would not admit costs the pool
 * nothing and does not stop it from refilling. Real controller, HostRunner and lease supervisor;
 * stand-in emulator, adb and avdmanager. No Linux runner executes anything here. */
const stepped: RecordValue = { id: "lease-stepped", revision: "1", os: "android", arch, mode: "device", minimum: WARM_SLOT, memoryStepMiB: 1024, device: { systemImage, profile: "pixel_tablet" } };
async function submit(h: Harness, app: string, kind: string, intent: RecordValue): Promise<string> {
  const id = randomUUID(), reply = await h.api("POST", "/v1/requests", { id, kind, intent }, app);
  assert.equal(reply.status, 201, JSON.stringify(reply.body)); return id;
}
const outcome = async (h: Harness, app: string, id: string): Promise<unknown[]> => { const body = (await h.api("GET", `/v1/requests/${id}`, undefined, app)).body; return [body.state, body.reason]; };
const WAITING = ["waiting", "capacity_unavailable"];
const ids = (devices: any[]): string[] => devices.map(d => d.machineId).sort();

test("device requests that no warm capacity could admit give up nothing and do not stop the pool", { skip, timeout: 240000 }, async t => {
  const h = await harness(t, 3, { warmPool: { maxDevices: 3, maxAgeSeconds: 600 }, templates: [stepped] });
  const app = await h.application(), small = await h.application(WARM_SLOT);
  await configurePool(h, [warmTarget(3)]);
  const original = ids(await warmReady(h, 3, "lease-phone", 60000));
  assert.deepEqual(await h.reserved(), { cpu: 6, memoryMiB: 6144, diskGiB: 24 }, "the pool holds the whole host");
  // Three requests that capacity refuses and that no amount of capacity would admit:
  // below the image's minimum, off the image's memory step, and beyond the application's own limit.
  const below = await submit(h, app, "lease", { templateId: "lease-phone", templateRevision: "1", arch, resources: { memoryMiB: 1024 } });
  const offStep = await submit(h, app, "lease", { templateId: "lease-stepped", templateRevision: "1", arch, resources: { memoryMiB: 2560 } });
  const overLimit = await submit(h, small, "lease", { templateId: "lease-phone", templateRevision: "1", arch, resources: { cpu: 4 } });
  const refused = async (): Promise<void> => {
    assert.deepEqual([await outcome(h, app, below), await outcome(h, app, offStep), await outcome(h, small, overLimit)], [WAITING, WAITING, WAITING]);
  };
  await until(async () => (await outcome(h, small, overLimit))[1] === "capacity_unavailable", "the refusals");
  // Several admission and pool passes later nothing was given up.
  await sleep(5000);
  await refused();
  let state = await poolState(h);
  assert.deepEqual(ids(state.devices), original);
  assert.deepEqual([state.targets[0].ready, state.targets[0].booting, state.targets[0].retiring, state.targets[0].paused], [3, 0, 0, null]);
  assert.deepEqual(await h.reserved(), { cpu: 6, memoryMiB: 6144, diskGiB: 24 });
  // The pool keeps working behind them: a request it can serve adopts a warm device, and the pool
  // refills once that lease is gone, although the three requests still wait.
  const a = await acquire(h, app, 120);
  assert.ok(original.includes(a.machineId)); assert.equal(memberSource((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body), "warm");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  const refilled = ids(await warmReady(h, 3, "lease-phone", 60000));
  assert.deepEqual(refilled.filter(id => original.includes(id)).length, 2);
  await refused();
  state = await poolState(h);
  assert.equal(state.devices.filter((d: any) => d.reason === "contention").length, 0);
  await configurePool(h, []);
  await until(async () => (await poolState(h)).devices.length === 0, "an empty pool", 40000);
});

test("a waiting Linux lease on a mapped host takes one warm device's capacity; one that could never fit takes none", { skip, timeout: 240000 }, async t => {
  const h = await harness(t, 2, { warmPool: { maxDevices: 2, maxAgeSeconds: 600 } }), key = () => randomBytes(32).toString("base64url");
  const ok = async (route: string, body: unknown, token?: string): Promise<any> => { const reply = await h.api("POST", route, body, token); assert.equal(reply.status, 200, `${route}: ${JSON.stringify(reply.body)}`); return reply.body; };
  // A Linux runner domain that is the same physical machine as the Android host: one shared budget.
  const applicationId = randomUUID(), domainId = randomUUID(), digest = "sha256:" + "ab".repeat(32), HOST = { cpu: 4, memoryMiB: 4096, diskGiB: 16 };
  const app = (await ok("/v1/consumers", { id: applicationId, name: "runner-agents", templates: [],
    limits: { resources: { cpu: 64, memoryMiB: 131072, diskGiB: 1000 }, activeLeases: 4, defaultTTLSeconds: 60, maxTTLSeconds: 300, maxLifetimeSeconds: 300, provisioningTimeoutSeconds: 250 } })).credential as string;
  const image = { id: "runner-linux", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "kubevirt", digest, resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, capabilities: ["command"] };
  await ok("/v1/linux-lease-images", image);
  await ok("/v1/linux-lease-grants", { applicationId, imageId: image.id, revision: "1", arch: "amd64", digest });
  await ok("/v1/resource-domains", { id: domainId, name: "android host", capacity: HOST });
  await ok(`/v1/hosts/${h.hostId()}/physical-domain`, { domainId });
  const binding = { controllerId: "8a4d2f3e-5a7b-4c1d-9e2f-0123456789ab", runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() }, enrollment = randomUUID();
  const issued = await ok("/v1/runner-enrollments", { id: enrollment, ...binding, ttlSeconds: 60 });
  await ok("/v1/runner-enrollments/consume", { id: enrollment, ...binding, credential: key() }, issued.enrollmentToken as string);
  await ok("/v1/linux-lease-runner-approvals", { binding, domainId, backend: "kubevirt", images: [{ id: image.id, revision: "1", arch: "amd64", digest }] });
  await configurePool(h, [warmTarget(2)]);
  const original = await warmReady(h, 2, "lease-phone", 60000);
  const budget = async (): Promise<any> => (await h.api("GET", `/v1/resource-domains/${domainId}`)).body;
  assert.deepEqual((await budget()).reserved, HOST, "the warm devices fill the shared budget");
  // Larger than the whole machine: capacity refuses it, and no warm device stands in its way.
  const huge = await submit(h, app, "linux-lease", { templateId: image.id, templateRevision: "1", arch: "amd64", resources: { cpu: 8 } });
  await until(async () => (await outcome(h, app, huge))[1] === "capacity_unavailable", "the refusal");
  await sleep(5000);
  let state = await poolState(h);
  assert.deepEqual(ids(state.devices), ids(original));
  assert.deepEqual([state.targets[0].ready, state.targets[0].retiring], [2, 0]);
  // One that fits once a single warm device is gone: exactly one is given up, with proof, and the
  // request is admitted by its own module's rule.
  const fitting = await submit(h, app, "linux-lease", { templateId: image.id, templateRevision: "1", arch: "amd64" });
  await until(async () => (await outcome(h, app, fitting))[0] === "admitted", "admission of the Linux lease", 40000);
  await until(async () => (await poolState(h)).devices.every((d: any) => d.state === "ready"), "the given-up device's removal");
  state = await poolState(h);
  // The oldest ready device went; the other was not touched and nothing was created in its place,
  // because the freed capacity now belongs to the Linux lease.
  const [first, second] = [...original].sort((a, b) => a.createdAt - b.createdAt || (a.machineId < b.machineId ? -1 : 1));
  assert.deepEqual(ids(state.devices), [second.machineId]);
  assert.ok(first);
  assert.deepEqual((await budget()).reserved, { cpu: 3, memoryMiB: 3072, diskGiB: 12 }, "one warm device and the Linux lease");
  await sleep(3000);
  state = await poolState(h);
  assert.deepEqual([ids(state.devices), state.targets[0].booting], [[second.machineId], 0]);
  assert.deepEqual(await outcome(h, app, huge), WAITING);
  assert.equal((await h.api("GET", `/v1/leases/${fitting}`, undefined, app)).body.state, "provisioning");
  await configurePool(h, []);
  await until(async () => (await poolState(h)).devices.length === 0, "an empty pool", 40000);
  assert.deepEqual((await budget()).reserved, image.resources, "only the Linux lease is left on the budget");
});
