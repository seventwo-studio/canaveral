import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memberSource } from "../../src/consumer-client.ts";
import { LEASE_ISOLATION_ARGUMENTS } from "../../src/providers/android.ts";
import { normalizeTemplate } from "../../src/control/templates.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";
import { acquire, arch, cleaned, emulators, harness, ready, skip, systemImage, until } from "./android-fixture.ts";
import type { Harness, HarnessOptions } from "./android-fixture.ts";

/** Device baseline fixtures: the real controller and HostRunner with stand-in emulator, adb,
 * avdmanager and qemu-img processes. The stand-in emulator keeps its "disk state" in its AVD
 * directory, which is enough to prove what is captured, what a clone starts from and that the
 * stored baseline is never written. Whether a real emulator boots from copied user data is not
 * shown here; no real AVD is created, captured or booted. */
const GIGABYTE_SLOT = { cpu: 2, memoryMiB: 2048, diskGiB: 8 };
/** An account-owned Android device, booted by the runner itself as in production. */
async function device(h: Harness, token = h.admin): Promise<string> {
  const id = randomUUID();
  // Placement needs the host's first passed environment check; the same UUID is safe to repeat.
  await until(async () => (await h.api("POST", "/v1/machines", { id, name: "golden", templateId: h.image.id, templateRevision: "1", arch }, token)).status === 200, "placement of an account-owned device");
  await until(async () => (await h.api("GET", `/v1/machines/${id}`)).body.observed === "running", "a booted account-owned device", 40000);
  return id;
}
async function operation(h: Harness, machine: string, action: string, args: RecordValue): Promise<any> {
  const id = randomUUID(), submitted = await h.api("POST", `/v1/machines/${machine}/operations`, { id, action, arguments: args });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  let current: any;
  await until(async () => { current = (await h.api("GET", `/v1/operations/${id}`)).body; return current.state !== "queued"; }, `${action} receipt`);
  return current;
}
async function stop(h: Harness, machine: string): Promise<void> {
  assert.equal((await h.api("POST", `/v1/machines/${machine}/desired`, { state: "stopped" })).status, 200);
  await until(async () => (await h.api("GET", `/v1/machines/${machine}`)).body.observed === "stopped", "a confirmed stopped device", 40000);
}
/** Prepares a device through ordinary device actions, stops it and saves it under a name. */
async function baseline(h: Harness, name: string, revision: string): Promise<any> {
  const machine = await device(h);
  assert.equal((await operation(h, machine, "shell", { argv: ["prepare", `${name}-${revision}`] })).state, "succeeded");
  await stop(h, machine);
  const id = randomUUID(), saving = await h.api("POST", `/v1/machines/${machine}/baselines`, { id, name, revision });
  assert.equal(saving.status, 201, JSON.stringify(saving.body));
  let view: any;
  await until(async () => { view = (await h.api("GET", `/v1/baselines/${id}`)).body; return view.state !== "saving"; }, "the saved baseline", 30000);
  assert.equal(view.state, "ready", JSON.stringify(view));
  return view;
}
const stored = (h: Harness, name: string, revision: string, ...file: string[]) => join(h.root, "devices", "baselines", name, revision, ...file);
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** A second account with machine scopes but no administrator role. */
async function user(h: Harness): Promise<string> {
  const password = "correct-horse-battery-staple-fixture";
  const manager = (await h.api("POST", "/v1/auth/setup", { username: "admin", password })).body.token as string;
  const created = (await h.api("POST", "/v1/users", { id: randomUUID(), username: "developer" }, manager)).body;
  const invite = (await h.api("POST", `/v1/users/${created.id}/invite`, {}, manager)).body;
  const claimed = await fetch(`${h.url}/v1/auth/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: invite.token, password }) });
  const session = await claimed.json() as { token?: string };
  assert.equal(typeof session.token, "string", JSON.stringify(session));
  return session.token!;
}

test("an administrator saves a stopped account-owned device as an immutable baseline, lists it and removes it; everything else is refused", { skip, timeout: 240000 }, async t => {
  // Saving holds twice the device's data size plus two GiB of host disk until the stored size is known.
  const h = await harness(t, 2, { extra: { diskGiB: 32 } }), app = await h.application(), developer = await user(h);
  const machine = await device(h);
  // A running device is never captured, by the controller or by the host itself.
  const request = { id: randomUUID(), name: "signed-in", revision: "1" };
  assert.equal((await h.api("POST", `/v1/machines/${machine}/baselines`, request)).status, 409);
  const assignment = (h.runner() as any).assignments.find((m: RecordValue) => m.id === machine) as RecordValue, context = h.runner().context(assignment);
  await assert.rejects(h.provider().saveBaseline(assignment, context.image, context.folder, request, () => true), (error: any) => error.code === "baseline_source_running");
  await assert.rejects(h.provider().saveBaseline({ ...assignment, desired: "stopped" }, context.image, context.folder, request, () => true), (error: any) => error.code === "baseline_source_running", "a stop intent is not a stopped emulator");
  assert.equal(existsSync(join(h.root, "devices", "baselines")), false, "a refused capture stores nothing");
  // The operator prepares the device through the existing device actions, then stops it.
  assert.equal((await operation(h, machine, "shell", { argv: ["prepare", "accounts"] })).state, "succeeded");
  await stop(h, machine);
  // Saving and listing are administrator actions: an application key and an ordinary account are refused.
  for (const token of [app, developer]) {
    assert.ok([401, 403].includes((await h.api("POST", `/v1/machines/${machine}/baselines`, request, token)).status));
    assert.ok([401, 403].includes((await h.api("GET", "/v1/baselines", undefined, token)).status));
    assert.ok([401, 403].includes((await h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets: [] }, token)).status));
  }
  for (const body of [{ ...request, name: "Signed In" }, { ...request, revision: "" }, { id: request.id, name: "signed-in" }, { ...request, host: h.hostId() }])
    assert.equal((await h.api("POST", `/v1/machines/${machine}/baselines`, body)).status, 400);
  const saving = await h.api("POST", `/v1/machines/${machine}/baselines`, request);
  assert.equal(saving.status, 201, JSON.stringify(saving.body));
  // A lost reply replays by UUID; the same UUID cannot name another save.
  assert.equal((await h.api("POST", `/v1/machines/${machine}/baselines`, request)).status, 200);
  assert.equal((await h.api("POST", `/v1/machines/${machine}/baselines`, { ...request, revision: "2" })).status, 409);
  let view: any;
  await until(async () => { view = (await h.api("GET", `/v1/baselines/${request.id}`)).body; return view.state === "ready"; }, "the saved baseline", 30000);
  // Identity, image binding and stale state; nothing host-local.
  assert.deepEqual([view.name, view.revision, view.hostId, view.sourceMachineId, view.arch, view.diskGiB, view.files, view.present, view.stale],
    ["signed-in", "1", h.hostId(), machine, arch, 8, 2, true, false]);
  assert.deepEqual(view.device, { systemImage, profile: "pixel_8" });
  assert.match(view.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(view.references, { templates: [], machines: 0 });
  assert.ok(!JSON.stringify(view).includes(h.root), "no host path leaves the host");
  const listed = (await h.api("GET", "/v1/baselines")).body.baselines as any[];
  assert.deepEqual(listed.map(item => [item.id, item.state]), [[request.id, "ready"]]);
  // Stored once, with a manifest and digests. Only disk state is captured: the device's own
  // configuration, per-launch files and quick-boot snapshots are not.
  const manifest = JSON.parse(readFileSync(stored(h, "signed-in", "1", "manifest.json"), "utf8"));
  assert.equal(manifest.digest, view.digest);
  assert.deepEqual(manifest.files.map((f: any) => f.path), ["userdata-qemu.img", "userdata-qemu.img.qcow2"]);
  for (const file of manifest.files) assert.equal(sha256(stored(h, "signed-in", "1", "files", file.path)), file.sha256);
  assert.match(readFileSync(stored(h, "signed-in", "1", "files", "userdata-qemu.img.qcow2"), "utf8"), /prepared:accounts/);
  assert.deepEqual(readdirSync(stored(h, "signed-in", "1", "files")).sort(), ["userdata-qemu.img", "userdata-qemu.img.qcow2"]);
  // Read-only on disk, and the capture left its source device untouched.
  assert.equal(statSync(stored(h, "signed-in", "1", "files", "userdata-qemu.img")).mode & 0o222, 0);
  assert.equal(statSync(stored(h, "signed-in", "1", "files")).mode & 0o222, 0);
  assert.match(readFileSync(join(h.storage(machine), "device.avd", "userdata-qemu.img.qcow2"), "utf8"), /prepared:accounts/);
  assert.ok(existsSync(join(h.storage(machine), "device.avd", "config.ini")));
  // The stored baseline is charged to the host's disk beside its stopped source device.
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 9 });
  // A baseline is immutable: the same name and revision cannot be saved again; a new revision can.
  assert.equal((await h.api("POST", `/v1/machines/${machine}/baselines`, { id: randomUUID(), name: "signed-in", revision: "1" })).status, 409);
  // A leased device is never captured, by the controller or by the host.
  const a = await acquire(h, app, 120);
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/baselines`, { id: randomUUID(), name: "leased", revision: "1" })).status, 409);
  const leased = (h.runner() as any).assignments.find((m: RecordValue) => m.id === a.machineId) as RecordValue, leasedContext = h.runner().context(leased);
  await assert.rejects(h.provider().saveBaseline({ ...leased, desired: "stopped" }, leasedContext.image, leasedContext.folder, { id: randomUUID(), name: "leased", revision: "1" }, () => true), (error: any) => error.code === "baseline_source_unsupported");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  // While a lease image names it, the baseline cannot be removed: not by the controller, not by the host.
  const signed = { ...h.image, id: "lease-phone-signed-in", baseline: { name: "signed-in", revision: "1", digest: view.digest } };
  h.addTemplate(signed); await h.restartRunner();
  await until(async () => ((await h.api("GET", "/v1/templates")).body.templates as any[]).some(item => item.id === signed.id), "the baseline-backed lease image");
  view = (await h.api("GET", `/v1/baselines/${request.id}`)).body;
  assert.deepEqual(view.references.templates, [{ id: signed.id, revision: "1", arch }]);
  const refused = await h.api("POST", `/v1/baselines/${request.id}/remove`, { id: randomUUID() });
  assert.equal(refused.status, 409);
  assert.deepEqual((await (h.runner() as any).baselineWork({ id: randomUUID(), kind: "remove", baseline: request.id, name: "signed-in", revision: "1" }, { authorized: () => true })).result.code, "baseline_referenced");
  assert.ok(existsSync(stored(h, "signed-in", "1", "manifest.json")));
  // An ordinary account cannot make itself a device from a baseline-backed image; an administrator can.
  assert.equal((await h.api("POST", "/v1/machines", { id: randomUUID(), name: "copy", templateId: signed.id, templateRevision: "1", arch }, developer)).status, 409);
  // Once nothing names it, an administrator removes it as a whole.
  h.removeTemplate(signed.id); await h.restartRunner();
  await until(async () => (await h.api("GET", `/v1/baselines/${request.id}`)).body.references.templates.length === 0, "the withdrawn lease image");
  assert.ok([401, 403].includes((await h.api("POST", `/v1/baselines/${request.id}/remove`, { id: randomUUID() }, developer)).status));
  const removal = { id: randomUUID() };
  assert.equal((await h.api("POST", `/v1/baselines/${request.id}/remove`, removal)).body.state, "removing");
  assert.equal((await h.api("POST", `/v1/baselines/${request.id}/remove`, removal)).status, 200, "a lost reply replays");
  await until(async () => (await h.api("GET", `/v1/baselines/${request.id}`)).body.state === "removed", "the removed baseline", 30000);
  assert.equal(existsSync(stored(h, "signed-in", "1")), false);
  assert.deepEqual((await h.api("GET", "/v1/baselines")).body.baselines, []);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 8 }, "the baseline's disk charge is released; the source device keeps its own");
});

test("every lease of a baseline-backed image starts from its own copy; the baseline is never changed; warm devices use it too; checks still fence", { skip, timeout: 300000 }, async t => {
  const options: HarnessOptions = { warmPool: { maxDevices: 2, maxAgeSeconds: 600 }, relocations: [], extra: { diskGiB: 32 } }, h = await harness(t, 2, options);
  const saved = await baseline(h, "signed-in", "1"), reference = { name: "signed-in", revision: "1", digest: saved.digest as string };
  const before = Object.fromEntries(["userdata-qemu.img", "userdata-qemu.img.qcow2"].map(file => [file, sha256(stored(h, "signed-in", "1", "files", file))]));
  // Only an explicitly declared, pinned lease image names the baseline; its definition carries the reference.
  const signed = { ...h.image, id: "lease-phone-signed-in", baseline: reference };
  assert.deepEqual(normalizeTemplate(signed).baseline, reference);
  assert.throws(() => normalizeTemplate({ ...signed, os: "ios", device: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" } }), /Android templates only/);
  assert.throws(() => normalizeTemplate({ ...signed, baseline: { name: "signed-in", revision: "1" } }), /recorded SHA-256 digest/);
  h.addTemplate(signed); await h.restartRunner();
  await until(async () => ((await h.api("GET", "/v1/templates")).body.templates as any[]).some(item => item.id === signed.id), "the baseline-backed lease image");
  // An application reaches the baseline only through its template allowlist.
  const plain = await h.application(undefined, [h.image]), app = await h.application(undefined, [h.image, signed]);
  assert.equal((await h.api("POST", "/v1/leases", { id: randomUUID(), templateId: signed.id, templateRevision: "1", arch, ttlSeconds: 60 }, plain)).status, 403);
  const catalogue = (await h.api("GET", "/v1/environments/templates", undefined, app)).body.templates as any[];
  assert.deepEqual(catalogue.find(item => item.id === signed.id).baseline, reference);
  // A cold lease: a fresh AVD, the baseline copied in before first boot, then the usual checks.
  const a = await acquire(h, app, 120, true, signed.id), booted = emulators(h.registry).find(e => e.name === `cvm-${a.machineId}`)!;
  assert.match(booted.data, /prepared:signed-in-1/, "the device booted from the prepared state");
  assert.equal(memberSource((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body), "cold");
  const clone = JSON.parse(readFileSync(join(h.storage(a.machineId), "baseline-clone.json"), "utf8")), avd = join(h.storage(a.machineId), "device.avd");
  assert.deepEqual([clone.name, clone.revision, clone.digest, clone.files], ["signed-in", "1", saved.digest, 2]);
  // Each copied overlay is pointed at its own copied base image, not at the device it was captured from.
  assert.deepEqual(clone.relocated, ["userdata-qemu.img.qcow2"]);
  assert.deepEqual(options.relocations!.at(-1), ["rebase", "-u", "-f", "qcow2", "-F", "raw", "-b", join(avd, "userdata-qemu.img"), join(avd, "userdata-qemu.img.qcow2")]);
  // A baseline-backed device is isolated and checked exactly like any leased device.
  const launched = JSON.parse(readFileSync(join(h.storage(a.machineId), "launch.json"), "utf8"));
  assert.deepEqual(launched.argv.slice(-LEASE_ISOLATION_ARGUMENTS.length), LEASE_ISOLATION_ARGUMENTS);
  assert.equal(JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-isolation.json"), "utf8")).isolated, true);
  assert.ok(h.counters.get(`cvm-${a.machineId}:shell getprop ro.debuggable`));
  // The lease wrote to its own copy; the stored baseline is byte for byte what was saved.
  assert.match(readFileSync(join(avd, "userdata-qemu.img.qcow2"), "utf8"), new RegExp(`boot:cvm-${a.machineId}`));
  for (const [file, digest] of Object.entries(before)) assert.equal(sha256(stored(h, "signed-in", "1", "files", file)), digest);
  // A live device and its lease image both hold the baseline in place.
  const held = (await h.api("GET", `/v1/baselines/${saved.id}`)).body;
  assert.deepEqual([held.references.templates.length, held.references.machines], [1, 1]);
  assert.equal((await h.api("POST", `/v1/baselines/${saved.id}/remove`, { id: randomUUID() })).status, 409);
  // Warm devices of a baseline-backed image are created from the baseline too, and adopted as usual.
  assert.equal((await h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets: [{ templateId: signed.id, templateRevision: "1", arch, count: 1 }] })).status, 200);
  let warm: any;
  await until(async () => { warm = ((await h.api("GET", `/v1/hosts/${h.hostId()}/warm-pool`)).body.devices as any[]).find(d => d.state === "ready"); return !!warm; }, "a ready baseline-backed warm device", 40000);
  assert.match(emulators(h.registry).find(e => e.name === `cvm-${warm.machineId}`)!.data, /prepared:signed-in-1/);
  assert.equal(JSON.parse(readFileSync(join(h.storage(warm.machineId), "baseline-clone.json"), "utf8")).digest, saved.digest);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  const b = await acquire(h, app, 120, true, signed.id);
  assert.equal(b.machineId, warm.machineId); assert.equal(memberSource((await h.api("GET", `/v1/leases/${b.id}`, undefined, app)).body), "warm");
  assert.equal((await h.api("POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets: [] })).status, 200);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/release`, { id: randomUUID() }, b.key)).status, 200);
  await cleaned(h, app, b.id);
  await until(async () => ((await h.api("GET", `/v1/hosts/${h.hostId()}/warm-pool`)).body.devices as any[]).length === 0, "an empty pool", 40000);
  for (const [file, digest] of Object.entries(before)) assert.equal(sha256(stored(h, "signed-in", "1", "files", file)), digest);
  // A baseline-backed device that fails the image check is fenced and never handed out.
  options.guest = "debuggable";
  const failing = await acquire(h, app, 60, false, signed.id), views: string[] = [];
  await until(async () => { const view = (await h.api("GET", `/v1/leases/${failing.id}`, undefined, app)).body; views.push(view.state); return view.state === "failed"; }, "failed lease", 40000);
  assert.ok(!views.includes("ready"));
  await cleaned(h, app, failing.id);
  options.guest = "isolated";
  // Stale: the installed system image changed in place after the baseline was saved.
  const properties = join(h.sdk, ...systemImage.split(";"), "source.properties"), original = readFileSync(properties, "utf8");
  writeFileSync(properties, original.replace("Pkg.Revision=9", "Pkg.Revision=10"));
  const binding = { arch, device: { systemImage, profile: "pixel_8" }, diskGiB: 8 };
  assert.throws(() => h.provider().baselineStore().resolve(reference, binding), (error: any) => error.code === "baseline_stale");
  // The host refuses on its own account, even while the controller's inventory still calls the
  // baseline current: nothing is created or booted, and the lease fails with a clean cleanup.
  const unnoticed = await acquire(h, app, 60, false, signed.id);
  let refusedLease: any;
  await until(async () => { refusedLease = (await h.api("GET", `/v1/leases/${unnoticed.id}`, undefined, app)).body; return refusedLease.state === "failed"; }, "a lease refused by the host for its stale baseline", 40000);
  assert.equal(emulators(h.registry).length, 0);
  assert.equal(existsSync(join(h.storage(refusedLease.members[0].machineId), "device.avd")), false, "no device was created from a stale baseline");
  await cleaned(h, app, unnoticed.id);
  assert.equal((await h.api("POST", `/v1/hosts/${h.hostId()}/checks`, {})).status, 200);
  let stale: any;
  await until(async () => { stale = (await h.api("GET", `/v1/baselines/${saved.id}`)).body; return stale.stale === true; }, "the stale baseline", 30000);
  assert.match(stale.staleReason, /system image changed/);
  // A stale baseline is refused for new devices: no host is eligible, so a direct lease gets no capacity.
  assert.equal((await h.api("POST", "/v1/leases", { id: randomUUID(), templateId: signed.id, templateRevision: "1", arch, ttlSeconds: 60 }, app)).status, 503);
  assert.equal(emulators(h.registry).length, 0);
  // The same refusal for another device profile, data size or digest than the baseline's own.
  writeFileSync(properties, original);
  assert.equal(h.provider().baselineStore().resolve(reference, binding).digest, saved.digest);
  for (const [changed, code] of [[{ ...binding, device: { systemImage, profile: "pixel_tablet" } }, "baseline_stale"], [{ ...binding, diskGiB: 16 }, "baseline_mismatch"]] as const)
    assert.throws(() => h.provider().baselineStore().resolve(reference, changed), (error: any) => error.code === code);
  assert.throws(() => h.provider().baselineStore().resolve({ ...reference, digest: "0".repeat(64) }, binding), (error: any) => error.code === "baseline_mismatch");
  assert.throws(() => h.provider().baselineStore().resolve({ ...reference, revision: "2" }, binding), (error: any) => error.code === "baseline_missing");
  assert.equal((await h.api("POST", `/v1/hosts/${h.hostId()}/checks`, {})).status, 200);
  await until(async () => (await h.api("GET", `/v1/baselines/${saved.id}`)).body.stale === false, "the baseline current again", 30000);
  const c = await acquire(h, app, 60, true, signed.id);
  assert.match(emulators(h.registry).find(e => e.name === `cvm-${c.machineId}`)!.data, /prepared:signed-in-1/);
  assert.equal((await h.api("POST", `/v1/leases/${c.id}/release`, { id: randomUUID() }, c.key)).status, 200);
  await cleaned(h, app, c.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: GIGABYTE_SLOT.diskGiB + 1 }, "the stopped source device and the stored baseline");
});
