import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import { alive, arch, groupAlive, harness, helper, skip, supervised, until } from "./android-fixture.ts";
import type { Harness } from "./android-fixture.ts";

/** The warm hold's own lifetime, with the real `lease-supervise` helper and a stand-in emulator.
 * The shortest allowed maximum age (60 seconds) keeps this to about two minutes. */
const SLOT = { cpu: 2, memoryMiB: 2048, diskGiB: 8 };
async function pool(h: Harness): Promise<any> { return (await h.api("GET", `/v1/hosts/${h.hostId()}/warm-pool`)).body; }
async function warm(h: Harness, except: string[], ms: number): Promise<any> {
  let found: any;
  await until(async () => { found = (await pool(h)).devices.find((d: any) => d.state === "ready" && !except.includes(d.machineId)); return !!found; }, "a ready warm device", ms);
  return found;
}

test("an aged warm device is recycled, and a warm hold is enforced by the native supervisor with the runner gone", { skip, timeout: 300000 }, async t => {
  const stopReceipts = new Map<string, { reason: string; groupAbsent: boolean; warmId?: string; leaseId?: string }>();
  const leases: typeof nativeLeaseSupervisor = {
    ...nativeLeaseSupervisor,
    async status(...args) {
      const status = await nativeLeaseSupervisor.status(...args);
      const storage = args[1], file = join(storage, "lease-stopped.json");
      // Capture the receipt before returning the free status that allows the runner to remove it.
      if (status.supervisor === "free" && existsSync(file)) stopReceipts.set(storage, JSON.parse(readFileSync(file, "utf8")));
      return status;
    },
  };
  const h = await harness(t, 1, { leases, warmPool: { maxDevices: 1, maxAgeSeconds: 60 } });
  assert.equal((await h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets: [{ templateId: "lease-phone", templateRevision: "1", arch, count: 1 }] })).status, 200);
  const first = await warm(h, [], 40000), one = supervised(h, first.machineId);
  // The hold has one fixed deadline on the native clock: the device's maximum age. Nothing renews it.
  assert.equal(first.expiresAt - first.createdAt, 60);
  const held = JSON.parse(readFileSync(join(h.storage(first.machineId), "lease-authorization.json"), "utf8")), clock = await nativeLeaseSupervisor.clock(helper);
  assert.equal(held.revision, 1);
  assert.ok(held.deadline - clock.continuous > 40 && held.deadline - clock.continuous <= 60, "the native deadline is the hold's maximum age");
  // Recycling: before the hold's own deadline the controller stops offering the device, gives it up
  // with proof and only then boots its replacement in the same slot.
  const second = await warm(h, [first.machineId], 90000);
  assert.ok(second.createdAt - first.createdAt >= 35 && second.createdAt - first.createdAt < 60, "recycled by age, before the hold's deadline");
  const stopped = stopReceipts.get(h.storage(first.machineId));
  assert.ok(stopped, "the recycled device has a stop receipt");
  assert.equal(stopped.reason, "fenced"); assert.equal(stopped.groupAbsent, true); assert.ok(stopped.warmId);
  assert.ok(!groupAlive(one.childPid));
  assert.equal(existsSync(h.storage(first.machineId)), false);
  assert.deepEqual(await h.reserved(), SLOT, "one slot, held by one warm device at a time");
  // Runner loss: nothing publishes anything, and the supervisor alone stops the device at its deadline.
  const two = supervised(h, second.machineId);
  await h.stopRunner();
  assert.ok(alive(two.childPid) && alive(two.supervisorPid), "the warm device outlives the runner process");
  await until(() => !groupAlive(two.childPid) && !alive(two.supervisorPid), "native deadline stop of a warm hold without a runner", 90000);
  const expired = JSON.parse(readFileSync(join(h.storage(second.machineId), "lease-stopped.json"), "utf8"));
  assert.equal(expired.reason, "expired"); assert.ok(expired.warmId && expired.leaseId === undefined);
  // Without the runner there is no removal proof, so the controller keeps the capacity on its ledger.
  assert.deepEqual(await h.reserved(), SLOT);
  assert.ok(existsSync(h.storage(second.machineId)));
  // The runner returns, proves the removal, and the pool replaces the device.
  await h.restartRunner();
  const third = await warm(h, [first.machineId, second.machineId], 60000);
  assert.equal(existsSync(h.storage(second.machineId)), false);
  assert.ok(alive(supervised(h, third.machineId).childPid));
  assert.deepEqual(await h.reserved(), SLOT);
});
