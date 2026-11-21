import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { STORAGE_INSPECTION_SECONDS } from "../../src/control/upkeep.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { digest, saveJson } from "../../src/providers/mobile.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";
import { assignmentFingerprint, saveRecord } from "../../src/runtime-process.ts";
import { IOS_DEVICE_TYPE, IOS_INSTALLED, failure, upkeepHarness } from "./upkeep-fixture.test.ts";
import type { UpkeepHarness } from "./upkeep-fixture.test.ts";

/** Orphan storage fixtures. Storage is created by the real providers under a temporary root, so
 * owner receipts are the ones production writes. No AVD or simulator of this machine is touched. */
const resources = { cpu: 2, memoryMiB: 2048, diskGiB: 8 };
function assignment(f: UpkeepHarness, system: "android" | "ios"): RecordValue {
  return { id: randomUUID(), template: f.images[system], resources, desired: "stopped", hostId: f.hostId };
}
/** A stopped AVD left behind by an assignment the controller no longer delivers. */
async function androidOrphan(f: UpkeepHarness, journal = true) {
  const machine = assignment(f, "android"), provider = f.providers.android, storage = provider.storage(machine, f.images.android);
  await provider.provision(machine, f.images.android, storage);
  const folder = join(f.state, "machines", String(machine.id));
  if (journal) saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(machine) });
  return { id: String(machine.id), machine, storage, folder, ini: join(f.storage.android, "avds", `cvm-${String(machine.id)}.ini`) };
}
function iosOrphan(f: UpkeepHarness, state: "Shutdown" | "Booted") {
  const machine = assignment(f, "ios"), provider = f.providers.ios, storage = provider.storage(machine, f.images.ios), udid = randomUUID().toUpperCase();
  saveJson(join(storage, "simulator.json"), { udid: udid.toLowerCase(), fingerprint: digest(provider.binding(machine, f.images.ios)) });
  f.tools.update(tools => { (tools.ios.devices[IOS_INSTALLED] ??= []).push({ udid, name: `cvm-${String(machine.id)}`, state, isAvailable: true, deviceTypeIdentifier: IOS_DEVICE_TYPE }); });
  return { id: String(machine.id), storage, udid };
}
const entry = (result: any, name: string, root = "storage"): any => result.entries.find((candidate: any) => candidate.name === name && candidate.root === root);
const simulators = (f: UpkeepHarness): string[] => Object.values(f.tools.read().ios.devices).flat().map(device => device.name).sort();

test("inspection reports orphans with ownership evidence, and a purge removes only proven ones", async t => {
  const f = await upkeepHarness(t);
  // A live device the controller still delivers is never an orphan.
  const live = await f.createMachine("android-phone");
  await f.pump(() => existsSync(join(f.storage.android, live.id, "avd-created.json")), "the live device to be provisioned");
  const owned = await androidOrphan(f), changed = await androidOrphan(f), mismatched = await androidOrphan(f);
  writeFileSync(join(mismatched.folder, "assignment.json"), JSON.stringify({ fingerprint: "0".repeat(64) }), { mode: 0o600 });
  // Storage without the receipt Canaveral writes when it creates a device.
  const foreign = randomUUID(); mkdirSync(join(f.storage.android, foreign, "device.avd"), { recursive: true, mode: 0o700 });
  // A receipt written by another runner state: created by Canaveral, but not by this runner.
  const elsewhere = assignment(f, "android");
  new AndroidProvider({ ...f.providers.android.config, transport: f.providers.android.transport }, join(f.root, "other-state")).storage(elsewhere, f.images.android);
  // Owned, but its recorded emulator process is alive.
  const running = await androidOrphan(f);
  saveJson(join(running.storage, "launch.json"), { version: 2, machineId: running.id, pid: process.pid, startedAt: 1 });
  // Owned, but readable by other accounts.
  const exposed = await androidOrphan(f); chmodSync(exposed.storage, 0o755);
  // A removal this runner began and never finished.
  const interrupted = await androidOrphan(f, false), quarantine = `.removing-${interrupted.id}-${randomUUID()}`;
  renameSync(interrupted.storage, join(f.storage.android, quarantine));
  const shutdown = iosOrphan(f, "Shutdown"), booted = iosOrphan(f, "Booted");
  f.tools.update(tools => { tools.ios.devices[IOS_INSTALLED]!.push({ udid: randomUUID().toUpperCase(), name: "personal iPhone", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: IOS_DEVICE_TYPE }); });
  const neighbour = join(f.storage.android, "avds", "personal.ini"); writeFileSync(neighbour, "path=/Users/operator/.android/avd/personal.avd\n");
  // An assignment's name alone proves nothing: a registration and a simulator without any storage.
  const named = randomUUID(), simulated = randomUUID(), strayIni = join(f.storage.android, "avds", `cvm-${named}.ini`); writeFileSync(strayIni, "path=/elsewhere/device.avd\n");
  f.tools.update(tools => { tools.ios.devices[IOS_INSTALLED]!.push({ udid: randomUUID().toUpperCase(), name: `cvm-${simulated}`, state: "Shutdown", isAvailable: true, deviceTypeIdentifier: IOS_DEVICE_TYPE }); });

  const inspection = await f.run("storage-inspect", {});
  assert.equal(inspection.state, "succeeded");
  const found = inspection.result;
  assert.equal(found.complete, true);
  assert.equal(entry(found, live.id), undefined);
  const reasons = (name: string) => { const e = entry(found, name); return [e.kind, e.runtime, e.owned, e.removable, e.reason]; };
  assert.deepEqual(reasons(owned.id), ["device-storage", "android", true, true, "owned_and_stopped"]);
  assert.deepEqual(reasons(foreign), ["device-storage", "android", false, false, "no_owner_receipt"]);
  assert.deepEqual(reasons(String(elsewhere.id)), ["device-storage", "android", false, false, "owner_receipt_differs"]);
  assert.deepEqual(reasons(running.id), ["device-storage", "android", true, false, "execution_not_proven_stopped"]);
  assert.deepEqual(reasons(exposed.id), ["device-storage", "android", false, false, "not_private_owned_directory"]);
  assert.deepEqual(reasons(quarantine), ["removal-quarantine", "android", true, true, "interrupted_removal"]);
  assert.deepEqual(reasons(shutdown.id), ["device-storage", "ios", true, true, "owned_and_stopped"]);
  assert.deepEqual(reasons(booted.id), ["device-storage", "ios", true, false, "simulator_running"]);
  // A journal is not removable on its own; it goes with the storage whose assignment it records.
  assert.deepEqual([entry(found, owned.id, "journal").removable, entry(found, owned.id, "journal").reason], [false, "removed_with_its_storage"]);
  assert.deepEqual([entry(found, running.id, "journal").removable, entry(found, running.id, "journal").reason], [false, "journal_without_storage_proof"]);
  assert.deepEqual(found.registries, { android: "listed", ios: "listed" });
  assert.deepEqual([entry(found, `cvm-${named}.ini`, "registry"), entry(found, `cvm-${simulated}`, "registry")].map(e => [e.machineId, e.runtime, e.kind, e.removable, e.reason]),
    [[named, "android", "avd-registration", false, "no_storage_or_receipt"], [simulated, "ios", "simulator", false, "no_storage_or_receipt"]]);
  assert.ok(!JSON.stringify(inspection).includes(f.root), "no private host path is reported");

  // The dry run joins the host's evidence with the controller's own ledger and changes nothing.
  f.store.transaction(db => db.prepare("INSERT INTO machines(id,request,host,template,desired,observed,detail,updated,intent) VALUES (?,?,?,?,'stopped','stopped','',0,?)")
    .run(changed.id, JSON.stringify({ name: "elsewhere", resources }), randomUUID(), JSON.stringify(f.images.android), "{}"));
  const preview = (await f.request("GET", f.hostPath + "/upkeep")).body.orphans;
  assert.deepEqual(preview.inspection, { id: inspection.id, inspectedAt: inspection.updatedAt, complete: true, current: true });
  const would = (name: string) => { const e = entry(preview, name); return [e.controllerOwner, e.wouldRemove, e.reason]; };
  assert.deepEqual(would(owned.id), ["absent", true, "owned_and_stopped"]);
  assert.deepEqual(would(changed.id), ["live", false, "live_owner"]);
  assert.deepEqual(would(foreign), ["absent", false, "no_owner_receipt"]);
  assert.deepEqual(would(booted.id), ["absent", false, "simulator_running"]);
  for (const kept of [owned, changed, mismatched, running, exposed]) assert.ok(existsSync(kept.storage));

  // A purge is refused as a whole when it names storage that is unproven or still owned.
  const purge = (entries: string[], inspectionId = inspection.id) => ({ id: randomUUID(), kind: "storage-purge", arguments: { inspection: inspectionId, entries } });
  await assert.rejects(f.request("POST", f.hostPath + "/operations", purge([owned.id, foreign])), failure(409, "storage_owner_exists"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", purge([changed.id])), failure(409, "storage_owner_exists"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", purge([live.id])), failure(409, "storage_owner_exists"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", purge([owned.id], randomUUID())), failure(409, "host_inspection_required"));
  f.store.transaction(db => db.prepare("DELETE FROM machines WHERE id=?").run(changed.id));
  assert.equal(f.tools.calls("xcrun").filter(call => call.args[1] === "delete").length, 0);

  // The host proves each entry again when it runs: one orphan started since the inspection.
  saveJson(join(changed.storage, "launch.json"), { version: 2, machineId: changed.id, pid: process.pid, startedAt: 1 });
  const request = purge([owned.id, changed.id, mismatched.id, quarantine, shutdown.id]);
  const done = await f.run(request.kind, request.arguments, request.id);
  assert.equal(done.state, "succeeded");
  const outcome = (name: string) => done.result.entries.find((candidate: any) => candidate.name === name);
  assert.deepEqual(outcome(owned.id), { name: owned.id, state: "removed", journalRemoved: true });
  assert.deepEqual(outcome(changed.id), { name: changed.id, state: "refused", reason: "execution_not_proven_stopped" });
  // Its journal carries another assignment's fingerprint, so only the storage goes.
  assert.deepEqual(outcome(mismatched.id), { name: mismatched.id, state: "removed", journalRemoved: false });
  assert.deepEqual(outcome(quarantine), { name: quarantine, state: "removed", journalRemoved: false });
  assert.deepEqual(outcome(shutdown.id), { name: shutdown.id, state: "removed", journalRemoved: false });
  for (const gone of [owned.storage, owned.ini, owned.folder, mismatched.storage, mismatched.ini, join(f.storage.android, quarantine), interrupted.ini, shutdown.storage]) assert.equal(existsSync(gone), false, gone);
  assert.ok(existsSync(mismatched.folder));
  // Everything unproven, running or live is exactly as it was.
  for (const kept of [changed.storage, changed.ini, running.storage, running.ini, exposed.storage, join(f.storage.android, foreign), join(f.storage.android, String(elsewhere.id)), booted.storage,
    join(f.storage.android, live.id), join(f.storage.android, "avds", `cvm-${live.id}.ini`), join(f.state, "machines", live.id), neighbour]) assert.ok(existsSync(kept), kept);
  assert.equal(readFileSync(neighbour, "utf8"), "path=/Users/operator/.android/avd/personal.avd\n");
  // Exactly the receipted, shut-down simulator was deleted; no simulator was shut down.
  assert.deepEqual(f.tools.calls("xcrun").filter(call => call.args[1] === "delete").map(call => call.args[2]), [shutdown.udid.toLowerCase()]);
  assert.ok(!f.tools.calls("xcrun").some(call => call.args[1] === "shutdown"));
  assert.deepEqual(simulators(f), [`cvm-${booted.id}`, `cvm-${simulated}`, "personal iPhone"].sort());
  assert.ok(existsSync(strayIni));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", purge([`cvm-${simulated}`])), failure(400));
  assert.ok(!f.tools.calls("adb").some(call => call.args.includes("kill")));

  // The same UUID returns the receipt and removes nothing more.
  assert.deepEqual((await f.operation(request.kind, request.arguments, request.id)).result, done.result);
  await f.poll(); await f.runner().step(); await f.poll();
  assert.equal(f.tools.calls("xcrun").filter(call => call.args[1] === "delete").length, 1);
  // The live device still reconciles normally afterwards.
  assert.equal((await f.request("GET", `/v1/machines/${live.id}`)).body.desired, "running");
});

test("a purge needs a current inspection, and one that ended unknown must be re-inspected", async t => {
  const f = await upkeepHarness(t), first = await androidOrphan(f), second = await androidOrphan(f);
  const inspection = await f.run("storage-inspect", {});
  const purge = (entries: string[], inspectionId: string) => ({ id: randomUUID(), kind: "storage-purge", arguments: { inspection: inspectionId, entries } });
  // The host collects the purge and is then lost before it reports: the outcome is unknown.
  const lost = purge([first.id], inspection.id);
  await f.operation(lost.kind, lost.arguments, lost.id);
  await f.poll(); f.setConnected(false); f.advance(900);
  assert.equal((await f.receipt(lost.id)).state, "unknown");
  f.setConnected(true); await f.poll(); await f.runner().step(); await f.poll();
  // The runner never started it, and never will.
  assert.ok(existsSync(first.storage));
  const stale = purge([second.id], inspection.id);
  await assert.rejects(f.request("POST", f.hostPath + "/operations", stale), failure(409, "host_inspection_required"));
  const preview = (await f.request("GET", f.hostPath + "/upkeep")).body;
  assert.deepEqual([preview.orphans.inspection.current, entry(preview.orphans, second.id).wouldRemove, entry(preview.orphans, second.id).reason], [false, false, "inspection_expired"]);
  assert.deepEqual(preview.pending.map((operation: any) => [operation.id, operation.state]), [[lost.id, "unknown"]]);
  // A new inspection acknowledges the unknown purge and names what may be removed now.
  const again = await f.run("storage-inspect", {});
  assert.ok((await f.receipt(lost.id)).acknowledgedAt > 0);
  assert.equal(STORAGE_INSPECTION_SECONDS, 900);
  const request = purge([first.id, second.id], again.id), done = await f.run(request.kind, request.arguments, request.id);
  assert.deepEqual(done.result.entries.map((result: any) => result.state), ["removed", "removed"]);
  assert.equal(existsSync(first.storage), false); assert.equal(existsSync(second.storage), false);
  assert.deepEqual((await f.run("storage-inspect", {})).result.entries, []);
});

test("an incomplete inventory proves nothing, and upkeep operations hold the power-off verdict of a drain", async t => {
  const f = await upkeepHarness(t), orphan = await androidOrphan(f);
  // More unexplained entries than one inspection reports: nothing is removable.
  for (let index = 0; index < 101; index++) mkdirSync(join(f.storage.ios, randomUUID()), { recursive: true, mode: 0o700 });
  const crowded = await f.run("storage-inspect", {});
  assert.equal(crowded.result.complete, false);
  assert.ok(crowded.result.entries.every((candidate: any) => candidate.removable === false));
  const request = { id: randomUUID(), kind: "storage-purge", arguments: { inspection: crowded.id, entries: [orphan.id] } };
  await assert.rejects(f.request("POST", f.hostPath + "/operations", request), failure(409, "storage_owner_exists"));
  assert.ok(existsSync(orphan.storage));

  // Upkeep is maintenance work: it is accepted during a drain and blocks the power-off verdict while it runs.
  const drain = (await f.request("POST", f.hostPath + "/maintenance", { id: randomUUID() })).body;
  assert.equal(drain.phase, "draining");
  const listing = await f.operation("runtime-list", { platform: "android" });
  const blockers = (await f.request("GET", f.hostPath + "/maintenance")).body.blockers as { kind: string; id: string; blocks: string[] }[];
  assert.deepEqual(blockers.find(blocker => blocker.id === listing.id), { kind: "operation", id: listing.id, state: "queued", detail: "Host upkeep operation", blocks: ["powerOff"] });
  await f.pump(async () => (await f.receipt(listing.id)).state === "succeeded", "the listing during the drain");
  assert.equal(((await f.request("GET", f.hostPath + "/maintenance")).body.blockers as { id: string }[]).some(blocker => blocker.id === listing.id), false);
  assert.equal(dirname(orphan.storage), f.storage.android);
});
