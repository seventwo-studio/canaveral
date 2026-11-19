import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlModule, ControlRequest } from "../../src/control/contracts.ts";
import { createModule as lifecycleModule } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { createModule as updatesModule } from "../../src/control/updates.ts";
import { object, ServiceError } from "../../src/errors.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig, HostDependencies, HostTransport } from "../../src/host.ts";
import { assignmentFingerprint, saveRecord } from "../../src/runtime-process.ts";
import type { RecordValue } from "../../src/runtime-process.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { fixture as updateFixtures } from "./update-manager-fixtures.test.ts";

const templateId = "maintenance-vm";
const diskContents = "persistent fixture disk";
const resources = { cpu: 1, memoryMiB: 1024, diskGiB: 8 };
const drainingError = { status: 409, code: "host_draining" };

interface MaintenanceStatus {
  id: string;
  scope: string;
  phase: string;
  owners: string[];
  admissionClosed: boolean;
  safeToPowerOff: boolean;
  readyToResume: boolean;
  lastRunnerConfirmedAt: number | null;
  blockers: { kind: string; id: string; state: string; blocks: string[] }[];
}
interface Machine {
  id: string;
  hostId: string;
  desired: string;
  observed: string;
  resources: typeof resources;
}

function blocker(status: MaintenanceStatus, kind: string, id: string) {
  return status.blockers.find(entry => entry.kind === kind && entry.id === id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, updatePublicKeys?: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-maintenance-e2e-")));
  const runners = new Set<HostRunner>();
  const releaseWork: (() => void)[] = [];
  t.after(async () => {
    for (const release of releaseWork) release();
    try { await Promise.all([...runners].map(runner => runner.close())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  let now = 1_700_000_000;
  const clock = { now: () => now, wall: () => now, suspendAware: true };
  const options = {
    adminToken: randomBytes(32).toString("base64url"),
    enrollmentToken: randomBytes(32).toString("base64url"),
    controllerId: randomUUID(),
    ...(updatePublicKeys ? { updatePublicKeys } : {}),
  };
  function controller(): ControlModule[] {
    // The production worker wires these modules to a shared store. A fresh
    // store on the same SQLite file gives maintenance a new controller run.
    const store = new SqliteStore(join(root, "controller.sqlite"), clock.wall);
    return [new MachineStore(store, options), lifecycleModule(store, options), updatesModule(store, options)];
  }
  let modules = controller();

  async function request<T>(method: string, path: string, body: RecordValue = {}, token = options.adminToken) {
    const req: ControlRequest = {
      method, path, parts: path.split("/").filter(Boolean), body: JSON.parse(JSON.stringify(body)),
      query: new URLSearchParams(), token,
      principal: () => {
        if (token !== options.adminToken) throw new ServiceError("Not the fixture operator.", 401);
        return { kind: "operator", user: null, scopes: ["admin"] };
      },
    };
    for (const module of modules) {
      const reply = await module.handle(req);
      if (reply !== undefined) return { status: reply.status ?? 200, body: JSON.parse(JSON.stringify(reply.body)) as T };
    }
    assert.fail(`No controller route for ${method} ${path}`);
  }

  async function addHost(name: string) {
    const storage = join(root, name, "disks");
    const config: HostConfig = {
      name, provider: "apple", storage, stateDir: join(root, name, "state"),
      capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 },
      templates: [{ id: templateId, revision: "1", os: "linux", arch: "arm64", mode: "headless", minimum: resources }],
      url: "http://127.0.0.1:1", enrollmentToken: options.enrollmentToken, pollIntervalSeconds: 0.25,
    };
    const vmStates = new Map<string, "running" | "stopped">();
    let stopCalls = 0;
    let stopHook: (() => Promise<void>) | undefined;
    let accessHook: ((authorized: () => boolean) => Promise<void>) | undefined;
    const ownedFolder = (id: string) => join(storage, id);
    const disk = (id: string) => join(ownedFolder(id), id.toUpperCase(), "disk.img");
    const providerFactory: NonNullable<HostDependencies["providerFactory"]> = config => ({
      kind: "apple", config,
      check: async () => ({}),
      async reconcile(machine: RecordValue) {
        const id = String(machine.id);
        if (machine.desired === "stopped") {
          stopCalls++;
          await stopHook?.();
          vmStates.set(id, "stopped");
          return { state: "stopped" };
        }
        if (!existsSync(disk(id))) {
          saveRecord(join(ownedFolder(id), "canaveral-owner.json"), { fingerprint: assignmentFingerprint(machine) });
          mkdirSync(dirname(disk(id)), { mode: 0o700 });
          writeFileSync(disk(id), diskContents, { mode: 0o600 });
        }
        vmStates.set(id, "running");
        return { state: "running" };
      },
      updateStopped: async (machine: RecordValue) => vmStates.get(String(machine.id)) === "stopped",
      async operate(_machine: RecordValue, _image: RecordValue, _folder: string, _operation: RecordValue, authorized: () => boolean) {
        await accessHook?.(authorized);
        return { state: authorized() ? "succeeded" : "unknown", result: {} };
      },
    });

    let connected = true;
    let lastBeat: RecordValue = {};
    let beforeProof: (() => Promise<void>) | undefined;
    const transport: HostTransport = {
      async request(method, path, body, token, signal) {
        signal?.throwIfAborted();
        if (!connected) throw new Error("fixture transport offline");
        if (path.endsWith("/heartbeat")) {
          lastBeat = structuredClone(body);
          if (proof(body) && beforeProof) {
            const action = beforeProof;
            beforeProof = undefined;
            await action();
          }
        }
        const reply = await request(method, path, body, token);
        assert.equal(reply.status, 200);
        return object(reply.body);
      },
    };
    async function startHost(config: HostConfig) {
      const runner = new HostRunner(config, { clock, transport, providerFactory });
      runners.add(runner);
      await runner.initializeProviders();
      await runner.connect();
      await runner.checkEnvironment();
      return runner;
    }
    let runner = await startHost(config);
    const identity = structuredClone(runner.identity);
    assert.ok(identity);
    const path = `/v1/hosts/${identity.id}`;
    async function poll() {
      now += 0.25;
      await runner.poll();
    }

    return {
      id: identity.id, credential: identity.credential, path, vmStates, ownedFolder, disk, poll,
      get runner() { return runner; },
      get lastBeat() { return lastBeat; },
      get stopCalls() { return stopCalls; },
      setConnected(value: boolean) { connected = value; },
      onNextProof(action: () => Promise<void>) { beforeProof = action; },
      onStop(hook: (() => Promise<void>) | undefined) { stopHook = hook; },
      onAccess(hook: (authorized: () => boolean) => Promise<void>) { accessHook = hook; },
      replay: (body: RecordValue) => request<RecordValue>("POST", path + "/heartbeat", body, identity.credential),
      async reboot(whileOffline?: () => void) {
        await runner.close();
        whileOffline?.();
        runners.delete(runner);
        // The contract uses proof expiry, with no boot marker.
        now += 21;
        const savedConfig = { ...config };
        delete savedConfig.enrollmentToken;
        runner = await startHost(savedConfig);
        assert.deepEqual(runner.identity, identity);
        assert.deepEqual(runner.assignments, []);
      },
      async begin() {
        const reply = await request<MaintenanceStatus>("POST", path + "/maintenance", { id: randomUUID() });
        assert.equal(reply.status, 201);
        return reply.body;
      },
      async status() {
        return (await request<MaintenanceStatus>("GET", path + "/maintenance")).body;
      },
      resume: (id: string) => request<MaintenanceStatus & { code?: string; status?: MaintenanceStatus }>(
        "POST", path + `/maintenance/${id}/resume`, { requestId: randomUUID() },
      ),
      async reserved() {
        const { body } = await request<{ hosts: { id: string; reserved: typeof resources }[] }>("GET", "/v1/hosts");
        const host = body.hosts.find(host => host.id === identity.id);
        assert.ok(host);
        return host.reserved;
      },
    };
  }

  async function create(hostId?: string) {
    return (await request<Machine>("POST", "/v1/machines", {
      id: randomUUID(), name: "maintenance fixture VM", templateId, ...(hostId ? { hostId } : {}),
    })).body;
  }
  const machine = async (id: string) => (await request<Machine>("GET", `/v1/machines/${id}`)).body;
  const desired = (id: string, state: "stopped" | "running") => request("POST", `/v1/machines/${id}/desired`, { state });

  return {
    addHost, create, machine, desired, request,
    restartController() { modules = controller(); },
    advance(seconds: number) { now += seconds; },
    hold() {
      const { promise, resolve } = deferred<void>();
      releaseWork.push(resolve);
      return { promise, release: resolve };
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
type Host = Awaited<ReturnType<Fixture["addHost"]>>;

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    if (i === 99) assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await delay(10);
  }
  throw new Error("Unreachable");
}

async function waitForStatus(host: Host, done: (status: MaintenanceStatus) => boolean, label: string) {
  return until(async () => {
    await host.poll();
    return host.status();
  }, done, label);
}

async function reconcile(host: Host, id: string, state: string) {
  await host.runner.step();
  await until(() => host.runner.reports.get(id)?.state, observed => observed === state, `runner to report ${state}`);
  await host.poll();
}

async function runningVM(f: Fixture, host: Host) {
  await host.poll();
  const vm = await f.create(host.id);
  await host.poll();
  await reconcile(host, vm.id, "running");
  assert.equal((await f.machine(vm.id)).observed, "running");
  assert.equal(readFileSync(host.disk(vm.id), "utf8"), diskContents);
  return vm;
}

async function stopVM(f: Fixture, host: Host, id: string) {
  await f.desired(id, "stopped");
  await host.poll();
  await reconcile(host, id, "stopped");
  assert.equal((await f.machine(id)).observed, "stopped");
  return waitForStatus(host, status => status.safeToPowerOff, "stopped VM and accepted idle proof");
}

async function resume(host: Host, id: string) {
  const reply = await host.resume(id);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.phase, "resumed");
  assert.equal(reply.body.admissionClosed, false);
  await host.poll();
}

function proof(body: RecordValue) {
  return object(body.maintenance).proof;
}

test("A: drain, stop, reboot and resume a direct host without replacing the VM or storage", async t => {
  const f = fixture(t), host = await f.addHost("drained"), other = await f.addHost("accepting");
  const vm = await runningVM(f, host);
  await other.poll();
  const before = statSync(host.ownedFolder(vm.id));
  const drain = await host.begin();
  assert.equal(drain.scope, "directHost");
  await assert.rejects(f.create(host.id), drainingError);
  assert.equal((await f.create()).hostId, other.id);
  const running = await waitForStatus(host, status => status.readyToResume, "running VM proof");
  assert.equal(blocker(running, "assignment", vm.id)?.state, "running");
  assert.equal(running.safeToPowerOff, false);

  const stopped = await stopVM(f, host, vm.id);
  assert.equal(stopped.readyToResume, true);
  await host.reboot();
  const afterReboot = await host.status();
  assert.equal(afterReboot.safeToPowerOff, false);
  assert.equal(afterReboot.readyToResume, false);
  await host.poll();
  assert.equal(proof(host.lastBeat), undefined);
  assert.equal((await host.status()).readyToResume, false);
  const fresh = await waitForStatus(host, status => status.readyToResume, "fresh post-reboot proof");
  assert.ok(fresh.lastRunnerConfirmedAt! > stopped.lastRunnerConfirmedAt!);
  assert.equal(fresh.safeToPowerOff, true);
  await resume(host, drain.id);
  assert.equal((await f.create(host.id)).hostId, host.id);
  const retained = await f.machine(vm.id);
  assert.deepEqual([retained.id, retained.hostId, retained.desired, retained.observed], [vm.id, host.id, "stopped", "stopped"]);
  const after = statSync(host.ownedFolder(vm.id));
  assert.deepEqual([after.dev, after.ino], [before.dev, before.ino]);
  assert.equal(readFileSync(host.disk(vm.id), "utf8"), diskContents);
});

test("B: same-boot resume preserves a running VM and its in-flight guest access", async t => {
  const f = fixture(t), host = await f.addHost("host");
  const vm = await runningVM(f, host);
  const access = { action: "health", arguments: {} };
  const held = f.hold();
  const entered = deferred<() => boolean>();
  host.onAccess(async authorized => { entered.resolve(authorized); await held.promise; });
  const operation = host.runner.accessControl(vm.id, access);
  const authorized = await Promise.race([
    entered.promise,
    operation.then(() => assert.fail("Guest access completed before entering the provider")),
  ]);

  const drain = await host.begin();
  assert.equal(drain.readyToResume, false);
  const confirmed = await waitForStatus(host, status => status.readyToResume, "same-boot running proof");
  assert.equal(confirmed.safeToPowerOff, false);
  assert.deepEqual(blocker(confirmed, "assignment", vm.id)?.blocks, ["powerOff"]);
  await assert.rejects(host.runner.accessControl(vm.id, access), drainingError);
  assert.equal(authorized(), true);
  await resume(host, drain.id);
  held.release();
  assert.deepEqual(await operation, {});
  assert.equal(host.stopCalls, 0);
  assert.equal(host.vmStates.get(vm.id), "running");
  const retained = await f.machine(vm.id);
  assert.deepEqual([retained.desired, retained.observed], ["running", "running"]);
});

test("C: missing owned disk storage after reboot blocks resume until restored", async t => {
  const f = fixture(t), host = await f.addHost("host");
  const vm = await runningVM(f, host), drain = await host.begin();
  await stopVM(f, host, vm.id);
  const folder = host.ownedFolder(vm.id), backup = folder + "-offline";
  await host.reboot(() => renameSync(folder, backup));
  assert.equal(existsSync(folder), false);

  const missing = await waitForStatus(host, status => !!blocker(status, "missingResource", vm.id), "missing storage proof");
  assert.equal(missing.readyToResume, false);
  assert.equal(missing.safeToPowerOff, false);
  const refused = await host.resume(drain.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "maintenance_blocked");
  assert.equal(blocker(refused.body.status!, "missingResource", vm.id)?.state, "absent");

  renameSync(backup, folder);
  const restored = await waitForStatus(host, status => status.readyToResume, "restored storage proof");
  assert.equal(blocker(restored, "missingResource", vm.id), undefined);
  await resume(host, drain.id);
});

test("D: restarting the controller keeps admission closed and rejects the previous run's proof", async t => {
  const f = fixture(t), host = await f.addHost("host");
  const vm = await runningVM(f, host), drain = await host.begin();
  const before = await stopVM(f, host, vm.id);
  let restarted = false;
  host.onNextProof(async () => {
    f.restartController();
    restarted = true;
    await assert.rejects(f.create(host.id), drainingError);
    const pending = await host.status();
    assert.equal(pending.admissionClosed, true);
    assert.equal(pending.safeToPowerOff, false);
    assert.equal(pending.readyToResume, false);
  });
  await until(async () => { await host.poll(); return restarted; }, Boolean, "proof from the previous controller run");
  const stale = await host.status();
  assert.equal(stale.lastRunnerConfirmedAt, before.lastRunnerConfirmedAt);
  assert.equal(stale.safeToPowerOff, false);
  assert.equal(stale.readyToResume, false);
  assert.equal(blocker(stale, "acknowledgement", drain.id)?.state, "previousRun");
  const fresh = await waitForStatus(host, status => status.safeToPowerOff, "new controller proof");
  assert.ok(fresh.lastRunnerConfirmedAt! > before.lastRunnerConfirmedAt!);
  assert.equal(fresh.admissionClosed, true);
});

test("E: an exact runner heartbeat replay cannot refresh or revalidate its proof", async t => {
  const f = fixture(t), host = await f.addHost("host");
  const vm = await runningVM(f, host), drain = await host.begin();
  const before = await stopVM(f, host, vm.id);
  const captured = structuredClone(host.lastBeat);
  assert.equal(object(proof(captured)).drainId, drain.id);
  f.advance(1);
  assert.equal((await host.replay(captured)).status, 200);
  assert.equal((await host.status()).lastRunnerConfirmedAt, before.lastRunnerConfirmedAt);
  assert.equal((await host.status()).safeToPowerOff, true);

  const current = await waitForStatus(host,
    status => status.lastRunnerConfirmedAt! > before.lastRunnerConfirmedAt!, "runner to synchronize with the rotated challenge");
  // An unconsumed challenge also cannot attest an intervening ledger change.
  // Queue a power-off intent while the next genuine proof is in transit.
  const stopId = randomUUID();
  host.onNextProof(async () => {
    await f.request("POST", `/v1/machines/${vm.id}/power-off`, { id: stopId });
  });
  const changed = await waitForStatus(host, status => !!blocker(status, "operation", stopId), "changed ledger");
  assert.equal(changed.lastRunnerConfirmedAt, current.lastRunnerConfirmedAt);
  assert.equal(blocker(changed, "acknowledgement", drain.id)?.state, "ledgerChanged");

  f.advance(1);
  assert.equal((await host.replay(captured)).status, 200);
  const replayed = await host.status();
  assert.equal(replayed.safeToPowerOff, false);
  assert.equal(replayed.lastRunnerConfirmedAt, current.lastRunnerConfirmedAt);
  assert.equal(blocker(replayed, "acknowledgement", drain.id)?.state, "ledgerChanged");
});

test("F: a stop interrupted by transport loss keeps the named intent and reservations until a matching report", async t => {
  const f = fixture(t), host = await f.addHost("host");
  const vm = await runningVM(f, host), drain = await host.begin();
  const stopId = randomUUID();
  await f.request("POST", `/v1/machines/${vm.id}/power-off`, { id: stopId });
  await host.poll();

  const held = f.hold(), entered = deferred<void>();
  host.onStop(async () => {
    entered.resolve();
    await held.promise;
    throw new Error("fixture stop outcome unknown");
  });
  await host.runner.step();
  await until(() => host.stopCalls, calls => calls === 1, "native stop dispatch");
  await entered.promise;
  assert.equal(host.runner.reports.get(vm.id)?.state, "running");
  assert.deepEqual(await host.reserved(), vm.resources);

  host.setConnected(false);
  await assert.rejects(host.poll(), /fixture transport offline/);
  f.advance(31);
  f.restartController();
  const offline = await host.status();
  assert.equal(offline.safeToPowerOff, false);
  assert.equal(offline.readyToResume, false);
  assert.ok(blocker(offline, "operation", stopId));
  assert.ok(blocker(offline, "unknownState", vm.id));
  assert.deepEqual(await host.reserved(), vm.resources);

  held.release();
  await until(() => host.runner.reports.get(vm.id)?.state, state => state === "unknown", "uncertain stop report");
  host.setConnected(true);
  await host.poll();
  assert.ok(blocker(await host.status(), "uncertainOperation", stopId));
  assert.equal((await host.resume(drain.id)).status, 409);
  assert.deepEqual(await host.reserved(), vm.resources);

  host.onStop(undefined);
  await reconcile(host, vm.id, "stopped");
  assert.equal(object(object(host.lastBeat.reports)[vm.id]).powerOffId, stopId);
  const recovered = await waitForStatus(host, status => status.safeToPowerOff, "matching positive stop report and proof");
  assert.equal(blocker(recovered, "operation", stopId), undefined);
  assert.equal(blocker(recovered, "uncertainOperation", stopId), undefined);
  assert.equal(blocker(recovered, "unknownState", vm.id), undefined);
  assert.deepEqual(await host.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: vm.resources.diskGiB });
});

test("G: successful update completion leaves the independent manual drain in force", async t => {
  const updates = updateFixtures();
  t.after(() => updates.cleanup());
  const f = fixture(t, updates.options.trustedKeys), host = await f.addHost("host");
  await host.poll();
  const drain = await host.begin();
  const registration = { installationId: randomUUID(), target: updates.options.target, launcherVersion: 1 };
  const poll = () => f.request<{ job: { id: string; attemptId: string } | null }>("POST", host.path + "/updates/poll", registration, host.credential);
  assert.equal((await poll()).body.job, null);
  const { envelope, bytes } = updates.release(1);
  const file = envelope.manifest.files[0]!;
  await f.request("POST", "/v1/updates/releases", { ...envelope });
  await f.request("POST", `/v1/updates/artifacts/${file.sha256}`, {
    offset: 0, totalBytes: file.bytes, data: Buffer.from(bytes["host.mjs"]).toString("base64"),
  });
  await f.request("POST", "/v1/updates/rollouts", { id: randomUUID(), releaseId: envelope.manifest.releaseId, hostIds: [host.id] });
  const { body: { job } } = await poll();
  assert.ok(job);

  const both = await waitForStatus(host, status => status.readyToResume, "manual proof during update drain");
  assert.deepEqual(both.owners, ["manual", "update"]);
  assert.ok(blocker(both, "update", job.id));
  assert.equal(both.safeToPowerOff, false);

  // The launcher reports progress through a separate API from HostRunner's
  // heartbeat. Feed the real update module the ordered launcher receipts.
  for (const [index, state] of ["draining", "downloading", "staged", "activating", "verifying", "succeeded"].entries()) {
    const receipt: { status: number; body: { accepted: boolean; job: { state: string } } } = await f.request("POST", host.path + "/updates/report", {
      jobId: job.id, attemptId: job.attemptId, sequence: index + 1, state,
      ...(state === "succeeded" ? { installedReleaseId: envelope.manifest.releaseId } : {}),
    }, host.credential);
    assert.equal(receipt.body.accepted, true);
    assert.equal(receipt.body.job.state, state);
  }
  await assert.rejects(f.create(host.id), drainingError);
  const manual = await waitForStatus(host, status => status.safeToPowerOff, "manual proof after update completion");
  assert.deepEqual(manual.owners, ["manual"]);
  assert.equal(manual.admissionClosed, true);
  assert.throws(() => host.runner.beginLocalWork(), drainingError);
  await resume(host, drain.id);
  assert.equal((await f.create(host.id)).hostId, host.id);
});
