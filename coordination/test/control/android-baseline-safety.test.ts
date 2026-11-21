import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { overlayBacking } from "../../src/providers/android-baselines.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";
import { acquire, arch, cleaned, configurePool, emulators, harness, poolState, skip, until, warmReady, warmTarget } from "./android-fixture.ts";
import type { Harness, HarnessOptions } from "./android-fixture.ts";

/** Baseline safety fixtures: what happens when a copy cannot be made self-contained or fails part
 * way, the controller's own data-size check, and who may save and see a baseline. Real controller
 * and HostRunner; stand-in emulator, adb, avdmanager and qemu-img.
 *
 * Coverage limit: the overlay rule is proven only at the level of the backing path a qcow2 header
 * records, which the stand-in emulator writes and reads like the real one. Whether a real emulator
 * boots from a rebased copy, and whether it reads any other file outside its AVD, is not shown. */
async function device(h: Harness, token = h.admin): Promise<string> {
  const id = randomUUID();
  await until(async () => (await h.api("POST", "/v1/machines", { id, name: "golden", templateId: h.image.id, templateRevision: "1", arch }, token)).status === 200, "placement of an account-owned device");
  await until(async () => (await h.api("GET", `/v1/machines/${id}`)).body.observed === "running", "a booted account-owned device", 40000);
  return id;
}
async function stop(h: Harness, machine: string): Promise<void> {
  assert.equal((await h.api("POST", `/v1/machines/${machine}/desired`, { state: "stopped" })).status, 200);
  await until(async () => (await h.api("GET", `/v1/machines/${machine}`)).body.observed === "stopped", "a confirmed stopped device", 40000);
}
async function prepare(h: Harness, machine: string, label: string): Promise<void> {
  const id = randomUUID();
  assert.equal((await h.api("POST", `/v1/machines/${machine}/operations`, { id, action: "shell", arguments: { argv: ["prepare", label] } })).status, 200);
  await until(async () => (await h.api("GET", `/v1/operations/${id}`)).body.state === "succeeded", "the preparation");
}
/** Asks for a save and waits for its outcome, whatever it is. */
async function save(h: Harness, machine: string, name: string, revision: string, token = h.admin): Promise<any> {
  const id = randomUUID(), saving = await h.api("POST", `/v1/machines/${machine}/baselines`, { id, name, revision }, token);
  assert.equal(saving.status, 201, JSON.stringify(saving.body));
  let view: any;
  await until(async () => { view = (await h.api("GET", `/v1/baselines/${id}`)).body; return view.state !== "saving"; }, "the outcome of the save", 30000);
  return view;
}
const storedFile = (h: Harness, name: string, revision: string, ...file: string[]) => join(h.root, "devices", "baselines", name, revision, ...file);
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const OVERLAY = "userdata-qemu.img.qcow2", BASE = "userdata-qemu.img";
/** A lease that must fail before its device is ever launched. Returns the failure the application sees. */
async function refusedLease(h: Harness, app: string, templateId: string): Promise<{ view: any; journal: any }> {
  const request = await acquire(h, app, 60, false, templateId);
  let view: any, launched = false, journal: any;
  await until(async () => {
    view = (await h.api("GET", `/v1/leases/${request.id}`, undefined, app)).body;
    const machine = view.members?.[0]?.machineId as string | undefined;
    if (machine) {
      launched ||= emulators(h.registry).some(e => e.name === `cvm-${machine}`) || existsSync(join(h.storage(machine), "launch.json"));
      try { journal = JSON.parse(readFileSync(join(h.storage(machine), "baseline-clone.json"), "utf8")); } catch { /* Not written yet, or already removed with the device. */ }
    }
    return view.state === "failed";
  }, "the failed lease", 40000);
  assert.equal(launched, false, "the device was never launched");
  const machine = view.members[0].machineId as string;
  await cleaned(h, app, request.id);
  assert.equal(existsSync(h.storage(machine)), false, "the partial copy was removed with the device");
  assert.equal(existsSync(join(h.root, "devices", "avds", `cvm-${machine}.ini`)), false);
  return { view, journal };
}

test("an overlay that cannot be made self-contained is refused at save and at clone; a copy that fails after it started is removed with proof; the controller checks the data size", { skip, timeout: 420000 }, async t => {
  const options: HarnessOptions = { relocations: [], extra: { diskGiB: 48 }, warmPool: { maxDevices: 1, maxAgeSeconds: 600 } }, h = await harness(t, 2, options);
  const tool = join(h.sdk, "emulator", "qemu-img"), source = await device(h), sourceBase = join(h.storage(source), "device.avd", BASE);
  await prepare(h, source, "accounts"); await stop(h, source);
  // The device's overlay records its base image by absolute path, as a real emulator's does.
  assert.equal(overlayBacking(join(h.storage(source), "device.avd", OVERLAY)), sourceBase);
  // Without the SDK's qemu-img this host could never make a copy self-contained: the save is
  // refused and stores nothing.
  renameSync(tool, tool + ".off");
  const refused = await save(h, source, "signed-in", "1");
  assert.equal(refused.state, "failed");
  assert.match(refused.detail, /cannot rebase a copied overlay/);
  assert.equal(existsSync(storedFile(h, "signed-in", "1")), false);
  const baselines = join(h.root, "devices", "baselines");
  assert.deepEqual(existsSync(baselines) ? readdirSync(baselines, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => entry.name) : [], [], "no staged copy is left behind");
  renameSync(tool + ".off", tool);
  // A failed save does not occupy the name: the same name and revision is saved once the tool is there.
  const saved = await save(h, source, "signed-in", "1");
  assert.equal(saved.state, "ready", JSON.stringify(saved));
  const before = Object.fromEntries([BASE, OVERLAY].map(file => [file, sha256(storedFile(h, "signed-in", "1", "files", file))]));
  const unchanged = (): void => { for (const [file, digest] of Object.entries(before)) assert.equal(sha256(storedFile(h, "signed-in", "1", "files", file)), digest); };
  // The stored overlay is the captured bytes: it still names the device it came from.
  assert.equal(overlayBacking(storedFile(h, "signed-in", "1", "files", OVERLAY)), sourceBase);
  const signed = { ...h.image, id: "lease-phone-signed-in", baseline: { name: "signed-in", revision: "1", digest: saved.digest as string } };
  h.addTemplate(signed); await h.restartRunner();
  await until(async () => ((await h.api("GET", "/v1/templates")).body.templates as any[]).some(item => item.id === signed.id), "the baseline-backed lease image");
  const app = await h.application(undefined, [h.image, signed]);
  // A usable clone: every copied overlay records its own copied base, and that is what the emulator opened.
  const a = await acquire(h, app, 120, true, signed.id), avd = join(h.storage(a.machineId), "device.avd"), booted = emulators(h.registry).find(e => e.name === `cvm-${a.machineId}`)!;
  assert.equal(overlayBacking(join(avd, OVERLAY)), join(avd, BASE));
  assert.equal(booted.backing, join(avd, BASE), "the device read its own base image, not the captured device's");
  assert.match(booted.data, /prepared:accounts/);
  assert.equal(JSON.parse(readFileSync(join(h.storage(a.machineId), "baseline-clone.json"), "utf8")).state, "complete");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  unchanged();
  // A rebase that reports success but leaves the recorded path pointing at the captured device:
  // the path is read back, and the device is not booted.
  options.qemuImg = "noop";
  const silent = await refusedLease(h, app, signed.id);
  assert.deepEqual([silent.journal?.state, /still records a backing file outside this device/.test(String(silent.journal?.detail))], ["failed", true]);
  // A rebase that fails: the copy had started, so the failure is journaled inside the device's own
  // confirmed AVD and the device is removed with the usual proof.
  options.qemuImg = "fail";
  const broken = await refusedLease(h, app, signed.id);
  assert.equal(broken.journal?.state, "failed");
  // The tool disappeared after the baseline was saved: refused, never booted from another device's file.
  options.qemuImg = "ok"; renameSync(tool, tool + ".off");
  const absent = await refusedLease(h, app, signed.id);
  assert.deepEqual([absent.journal?.state, /cannot rebase a copied overlay/.test(String(absent.journal?.detail))], ["failed", true]);
  renameSync(tool + ".off", tool);
  unchanged();
  assert.equal(emulators(h.registry).length, 0);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 9 }, "only the stopped source device and the stored baseline are left");
  // The same failure in the warm pool: each failed copy is removed with proof, so the image is not
  // paused; the pool backs off and tries one device at a time until one boots.
  options.qemuImg = "fail";
  await configurePool(h, [warmTarget(1, signed.id)]);
  let state: any;
  await until(async () => { state = await poolState(h); return state.targets[0].failed >= 1 && state.devices.length === 0; }, "a failed warm boot, removed with proof", 40000);
  assert.match(state.targets[0].lastError, /baseline could not be copied|could not be copied/i);
  assert.deepEqual([state.targets[0].paused, state.targets[0].proven, state.targets[0].retiring], [null, false, 0]);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 9 });
  options.qemuImg = "ok";
  const [warm] = await warmReady(h, 1, signed.id, 90000);
  assert.equal(emulators(h.registry).find(e => e.name === `cvm-${warm.machineId}`)!.backing, join(h.storage(warm.machineId), "device.avd", BASE));
  assert.equal((await poolState(h)).targets[0].proven, true);
  // The controller's own data-size rule: a device with another data partition size than the
  // baseline's is placed nowhere, although the host has the capacity for it, and nothing is created.
  const machines = async (): Promise<string[]> => ((await h.api("GET", "/v1/machines")).body.machines as any[]).map(machine => machine.id).sort(), existing = await machines();
  const larger = await h.api("POST", "/v1/leases", { id: randomUUID(), templateId: signed.id, templateRevision: "1", arch, ttlSeconds: 60, resources: { diskGiB: 16 } }, app);
  assert.deepEqual([larger.status, larger.body.code], [503, "capacity_unavailable"]);
  assert.equal((await h.api("POST", "/v1/leases", { id: randomUUID(), templateId: h.image.id, templateRevision: "1", arch, ttlSeconds: 60, resources: { diskGiB: 16 } }, app)).status, 201, "the host does have room for a device of that size");
  assert.equal((await machines()).length, existing.length + 1);
  await configurePool(h, []);
  await until(async () => (await poolState(h)).devices.length === 0, "an empty pool", 40000);
  unchanged();
});

/** An administrator account and an ordinary one, both with their session tokens. */
async function accounts(h: Harness): Promise<{ manager: string; managerId: string; developer: string; developerId: string }> {
  const password = "correct-horse-battery-staple-fixture";
  const manager = (await h.api("POST", "/v1/auth/setup", { username: "admin", password })).body.token as string;
  const created = (await h.api("POST", "/v1/users", { id: randomUUID(), username: "developer" }, manager)).body;
  const invite = (await h.api("POST", `/v1/users/${created.id}/invite`, {}, manager)).body;
  const claimed = await fetch(`${h.url}/v1/auth/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: invite.token, password }) });
  const session = await claimed.json() as { token?: string };
  assert.equal(typeof session.token, "string", JSON.stringify(session));
  const users = (await h.api("GET", "/v1/users", undefined, manager)).body.users as any[];
  return { manager, managerId: users.find(user => user.username === "admin").id, developer: session.token!, developerId: created.id };
}

test("only the account that owns a device saves it as a baseline; the deciding principal is recorded; lease, host and non-administrator credentials are refused on every route", { skip, timeout: 300000 }, async t => {
  const h = await harness(t, 3, { extra: { diskGiB: 48 }, warmPool: { maxDevices: 1, maxAgeSeconds: 600 } }), { manager, managerId, developer, developerId } = await accounts(h);
  // Three stopped devices: one of an ordinary account, one of the administrator account, one of no account.
  const theirs = await device(h, developer), mine = await device(h, manager), unowned = await device(h);
  for (const machine of [theirs, mine, unowned]) await stop(h, machine);
  const owners = Object.fromEntries(((await h.api("GET", "/v1/machines")).body.machines as any[]).map(machine => [machine.id, machine.ownerId ?? machine.owner?.id ?? machine.owner ?? null]));
  assert.deepEqual([owners[theirs], owners[mine], owners[unowned]], [developerId, managerId, null]);
  // An administrator is not the owner of another account's device, and neither is the operator
  // credential, which is no account at all. Their devices hold their accounts and tokens.
  const attempt = async (machine: string, token: string): Promise<unknown[]> => { const reply = await h.api("POST", `/v1/machines/${machine}/baselines`, { id: randomUUID(), name: "captured", revision: "1" }, token); return [reply.status, reply.body.code]; };
  const NOT_OWNED = [403, "baseline_source_not_owned"];
  assert.deepEqual(await attempt(theirs, manager), NOT_OWNED);
  assert.deepEqual(await attempt(theirs, h.admin), NOT_OWNED);
  assert.deepEqual(await attempt(mine, h.admin), NOT_OWNED);
  assert.deepEqual(await attempt(unowned, manager), NOT_OWNED);
  assert.deepEqual((await h.api("GET", "/v1/baselines")).body.baselines, [], "a refused capture records nothing");
  assert.equal(existsSync(join(h.root, "devices", "baselines")), false);
  // Each saves its own, and the baseline says who decided. No credential is recorded.
  const own = await save(h, mine, "team", "1", manager), shared = await save(h, unowned, "shared", "1");
  assert.deepEqual([own.state, shared.state], ["ready", "ready"], JSON.stringify([own, shared]));
  assert.deepEqual(own.savedBy, { kind: "session", userId: managerId, username: "admin" });
  assert.deepEqual(shared.savedBy, { kind: "operator", userId: null, username: null });
  assert.equal(own.removedBy, undefined);
  // Every credential that is not an administrator's: an application key, a lease key, the host's
  // own credential, an ordinary account's session and its personal token.
  const app = await h.application(), a = await acquire(h, app, 120);
  const minted = await h.api("POST", "/v1/auth/tokens", { id: randomUUID(), name: "automation", scopes: ["machines:read", "machines:write"] }, developer);
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  const credentials: Record<string, string> = { "application key": app, "lease key": a.key, "host credential": h.runner().identity!.credential, "account session": developer, "personal token": minted.body.token as string };
  const routes: [string, string, RecordValue?][] = [
    ["GET", "/v1/warm-pool"], ["GET", `/v1/hosts/${h.hostId()}/warm-pool`], ["POST", `/v1/hosts/${h.hostId()}/warm-pool`, { targets: [warmTarget(1)] }],
    ["POST", `/v1/machines/${theirs}/baselines`, { id: randomUUID(), name: "theirs", revision: "1" }], ["POST", `/v1/machines/${a.machineId}/baselines`, { id: randomUUID(), name: "leased", revision: "1" }],
    ["GET", "/v1/baselines"], ["GET", `/v1/baselines/${own.id}`], ["POST", `/v1/baselines/${own.id}/remove`, { id: randomUUID() }],
  ];
  for (const [label, token] of Object.entries(credentials)) for (const [method, route, body] of routes) {
    const reply = await h.api(method, route, body, token);
    assert.ok([401, 403].includes(reply.status), `${label} on ${method} ${route}: ${reply.status} ${JSON.stringify(reply.body)}`);
    assert.ok(!JSON.stringify(reply.body).includes(own.digest), `${label} learned nothing about a baseline`);
  }
  // Nothing changed: no target, no warm device, the same two baselines.
  const pool = await poolState(h);
  assert.deepEqual([pool.targets, pool.devices], [[], []]);
  assert.deepEqual(((await h.api("GET", "/v1/baselines")).body.baselines as any[]).map(item => [item.name, item.state]).sort(), [["shared", "ready"], ["team", "ready"]]);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  // Removal is an administrator action on the host's storage, whoever saved it; it records who decided.
  const removal = await h.api("POST", `/v1/baselines/${shared.id}/remove`, { id: randomUUID() }, manager);
  assert.deepEqual([removal.status, removal.body.state], [200, "removing"]);
  let removed: any;
  await until(async () => { removed = (await h.api("GET", `/v1/baselines/${shared.id}`)).body; return removed.state === "removed"; }, "the removed baseline", 30000);
  assert.deepEqual([removed.savedBy, removed.removedBy], [{ kind: "operator", userId: null, username: null }, { kind: "session", userId: managerId, username: "admin" }]);
  assert.equal(existsSync(storedFile(h, "shared", "1")), false);
  assert.ok(existsSync(storedFile(h, "team", "1", "manifest.json")));
});
