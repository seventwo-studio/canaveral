import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startController } from "../../src/main.ts";
import { hostOffer, hostTransport } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { canonicalManifest } from "../../src/updates/protocol.ts";
import type { Manifest, SignedRelease, Target } from "../../src/updates/protocol.ts";
import { ManagedUpdater, UpdateStore } from "../../src/updates/manager.ts";
import { StableLauncher } from "../../src/updates/launcher.ts";

test("signed CLI rollout survives lost completion reply, restart and exact rollback with protected state intact", { timeout: 90_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-update-completion-")));
  const disks = join(root, "disks");
  const hostState = join(root, "host-state"), updateState = join(root, "update-state"), installationRoot = join(root, "installation");
  for (const directory of [hostState, updateState, installationRoot, disks]) mkdirSync(directory, { mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  const keys = { fixture: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const target: Target = { os: process.platform as Target["os"], arch: process.arch === "x64" ? "amd64" : "arm64" };
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  const adminFile = join(root, "admin.token"), enrollmentFile = join(root, "enrollment.token"), configFile = join(root, "host.json");
  writeFileSync(adminFile, admin, { mode: 0o600 }); writeFileSync(enrollmentFile, enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    updatePublicKeys: keys, controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  let launcher: StableLauncher | undefined, updater: ManagedUpdater | undefined;
  t.after(async () => {
    await updater?.close();
    if (launcher) {
      try { await launcher.close(await launcher.quiesce()); }
      catch {
        // This fixture's only children are disposable Node hosts with no native runtimes.
        const owned = launcher as unknown as { current?: { child: import("node:child_process").ChildProcess }; pending?: { child: import("node:child_process").ChildProcess } };
        for (const process of [owned.current?.child, owned.pending?.child]) process?.kill("SIGKILL");
      }
    }
    await controller.close();
    function writable(directory: string): void {
      chmodSync(directory, 0o700);
      for (const item of readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) writable(join(directory, item.name));
    }
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  const hostId = randomUUID(), credential = randomBytes(32).toString("base64url");
  const config: HostConfig = { name: "update-fixture", provider: "native", templates: [], capacity: { cpu: 1, memoryMiB: 1024, diskGiB: 1 },
    url: `http://127.0.0.1:${controller.address.port}`, allowHTTP: true, stateDir: hostState, pollIntervalSeconds: 0.25,
    updates: { trustedKeys: keys, protectedPaths: [hostState, configFile, disks] } };
  const savedConfig = JSON.stringify(config);
  writeFileSync(configFile, savedConfig, { mode: 0o600 });
  const disk = randomBytes(8192), recovery = JSON.stringify({ operation: randomUUID(), state: "unknown", retained: true });
  writeFileSync(join(disks, "retained.img"), disk, { mode: 0o600 });
  writeFileSync(join(hostState, "recovery.json"), recovery, { mode: 0o600 });
  const identity = JSON.stringify({ id: hostId, credential, orchestrator: config.url });
  writeFileSync(join(hostState, "identity.json"), identity, { mode: 0o600 });
  const transport = hostTransport(config);
  await transport.request("POST", "/v1/hosts/enroll", { id: hostId, credential, offer: hostOffer(config) }, enrollment);
  const source = join(root, "source"); mkdirSync(source, { mode: 0o700 });
  const payload = new Map<string, Buffer>();
  const emitted = fileURLToPath(new URL("../../src/", import.meta.url));
  function collect(directory: string, relative = ""): void {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) collect(join(directory, item.name), name);
      else if (item.isFile() && item.name.endsWith(".js")) payload.set(`coordination/dist/src/${name}`, readFileSync(join(directory, item.name)));
    }
  }
  collect(emitted);
  payload.set("guest/agent", Buffer.from("inactive portable guest asset"));
  payload.set("native/helper", Buffer.from("inactive portable helper asset"));
  payload.set("coordination/package.json", Buffer.from('{"type":"module"}'));
  for (const [path, data] of payload) { mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(source, path), data, { mode: 0o600 }); }
  function release(sequence: number, files = payload, entrypoint = "coordination/dist/src/cli.js"): SignedRelease {
    const manifest: Manifest = { schema: "canaveral-update-v1", releaseId: randomUUID(), version: `1.0.${sequence}`, sequence, createdAt: 1000, target,
      minimumLauncherVersion: 1, entrypoint, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), executable: false, component: path.startsWith("guest/") ? "guest" as const : path.startsWith("native/") ? "native-helper" as const : "host" as const })) };
    return { manifest, keyId: "fixture", signature: sign(null, canonicalManifest(manifest), pair.privateKey).toString("base64") };
  }
  const baseline = release(1), candidate = release(2), settings = { installationRoot, stateDirectory: updateState, trustedKeys: keys, target, protectedPaths: [hostState, configFile, disks], minimumFreeBytes: 0 };
  const initial = new UpdateStore(settings);
  const tampered = { ...baseline, manifest: { ...baseline.manifest, version: '99.0.0' } };
  await assert.rejects(initial.installInitial(tampered, source), /signature/i);
  assert.equal(initial.active(), undefined, 'untrusted bootstrap must not select a release');
  assert.equal(readFileSync(configFile, 'utf8'), savedConfig);
  assert.deepEqual(readFileSync(join(disks, 'retained.img')), disk);
  await initial.installInitial(baseline, source);
  launcher = new StableLauncher({ ...settings, hostConfigPath: configFile, hostStateDirectory: hostState, readinessTimeoutMs: 10_000, stopTimeoutMs: 10_000 });
  await launcher.start();
  let dropped = false, activations = 0, currentCredential = credential;
  const replayed: string[] = [];
  const makeUpdater = () => new ManagedUpdater({ ...settings, identity: () => ({ id: hostId, credential: currentCredential }),
    request: async (method, path, body, token, signal) => {
      const reply = await transport.request(method, path, body, token, signal);
      if (path.endsWith('/updates/report') && body.state === 'succeeded') {
        replayed.push(JSON.stringify(body));
        if (!dropped) { dropped = true; throw new Error('fixture lost committed report reply'); }
      }
      return reply;
    },
    lifecycle: { idle: () => launcher!.idle(), quiesce: () => launcher!.quiesce(), activation: {
      activate: request => { activations++; return launcher!.activate(request); },
      recover: request => launcher!.recover(request),
    } } });
  updater = makeUpdater();
  assert.equal(await updater.poll(), undefined);
  const trustFile = join(root, 'trusted.json');
  writeFileSync(trustFile, JSON.stringify(keys), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../../src/updates/cli.js', import.meta.url));
  async function upload(envelope: SignedRelease, files: Map<string, Buffer>) {
    const bundle = join(root, 'bundle-' + envelope.manifest.sequence);
    mkdirSync(bundle, { mode: 0o700 }); mkdirSync(join(bundle, 'artifacts'), { mode: 0o700 });
    writeFileSync(join(bundle, 'release.json'), JSON.stringify(envelope), { mode: 0o600 });
    for (const file of envelope.manifest.files) writeFileSync(join(bundle, 'artifacts', file.sha256), files.get(file.path)!, { mode: 0o600 });
    const result = await promisify(execFile)(process.execPath, [cli, '--url', config.url!, '--token-file', adminFile,
      'releases', 'upload', '--bundle', bundle, '--trusted-keys', trustFile], { timeout: 20_000 });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(credential + '|' + admin));
    return bundle;
  }
  async function rollout(envelope: SignedRelease) {
    const id = randomUUID();
    await transport.request('POST', '/v1/updates/rollouts', { id, releaseId: envelope.manifest.releaseId, hostIds: [hostId] }, admin);
    await updater!.poll(); return id;
  }
  async function advance(terminal: string) {
    for (let count = 0; count < 12; count++) {
      const job = await updater!.step();
      if (job?.phase === terminal) return job;
      assert.ok(!['failed', 'unknown', 'succeeded', 'rolledBack'].includes(job?.phase ?? ''), 'unexpected terminal outcome: ' + job?.phase);
    }
    assert.fail('bounded update did not reach ' + terminal);
  }
  function preserved() {
    assert.equal(readFileSync(configFile, 'utf8'), savedConfig);
    assert.equal(readFileSync(join(hostState, 'identity.json'), 'utf8'), identity);
    assert.equal(readFileSync(join(hostState, 'recovery.json'), 'utf8'), recovery);
    assert.deepEqual(readFileSync(join(disks, 'retained.img')), disk);
  }
  await upload(candidate, payload);
  const rolloutId = await rollout(candidate);
  const attempt = updater.store.job()!.attemptId;
  await assert.rejects(advance('succeeded'), /lost committed report reply/);
  assert.equal(activations, 1);
  assert.equal(updater.store.active(), candidate.manifest.releaseId);
  const pending = updater.store.job()!.pending;
  assert.equal(pending?.state, 'succeeded');
  await updater.close(); updater = makeUpdater();
  currentCredential = randomBytes(32).toString('base64url');
  await assert.rejects(updater.step(), /different host credential/);
  assert.equal(replayed.length, 1); assert.equal(activations, 1);
  currentCredential = credential;
  await updater.step();
  assert.equal(updater.store.job()!.attemptId, attempt);
  assert.equal(updater.store.job()!.pending, undefined);
  assert.equal(activations, 1, 'lost controller reply must not rerun activation');
  assert.equal(replayed.length, 2); assert.equal(replayed[0], replayed[1], 'replay exact saved report');
  const view = await transport.request('GET', '/v1/updates/rollouts/' + rolloutId, {}, admin);
  assert.equal((view.jobs as Array<{ state: string }>)[0]!.state, 'succeeded');
  assert.deepEqual(updater.store.job()!.componentStatus, { host: 'ready', guest: 'pendingGuestReceipt', 'native-helper': 'pendingNativeReceipt' });
  const components = (view.jobs as Array<{ components: Record<string, string> }>)[0]!.components;
  assert.deepEqual(components, { host: 'ready', guest: 'pendingGuestReceipt', 'native-helper': 'pendingNativeReceipt' });
  preserved();
  // A positive close permits a fresh parent; it must select the committed candidate.
  await updater.close(); await launcher.close(await launcher.quiesce());
  launcher = new StableLauncher({ ...settings, hostConfigPath: configFile, hostStateDirectory: hostState, readinessTimeoutMs: 10_000, stopTimeoutMs: 10_000 });
  await launcher.start(); updater = makeUpdater();
  assert.equal(updater.store.active(), candidate.manifest.releaseId);
  const idle = await launcher.idle();
  assert.equal(idle.idle, true); assert.equal(idle.workloadsStopped, true);
  await updater.poll();
  // A signed but invalid runtime is not a new baseline. Roll back to sequence 2, never sequence 1.
  const brokenFiles = new Map(payload); brokenFiles.set('broken.mjs', Buffer.from('process.exit(17);'));
  const broken = release(3, brokenFiles, 'broken.mjs');
  await upload(broken, brokenFiles); const rollbackId = await rollout(broken);
  await advance('rolledBack');
  assert.equal(activations, 2);
  assert.equal(updater.store.active(), candidate.manifest.releaseId);
  assert.equal(updater.store.highwater().sequence, 3);
  const rolled = await transport.request('GET', '/v1/updates/rollouts/' + rollbackId, {}, admin);
  assert.equal((rolled.jobs as Array<{ state: string }>)[0]!.state, 'rolledBack');
  assert.equal((await launcher.idle()).idle, true); preserved();
});
