import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { componentFileSetDigest } from "../../src/updates/components.ts";
import { GuestAccess } from "../../src/guest/access.ts";
import { createGuestServer } from "../../src/guest/server.ts";
import { createGuestAdoptionDriver, createGuestAdoptionService, signedGuestProvision } from "../../src/updates/guest.ts";
import { NativeHelperAdoptionDriver } from "../../src/updates/native-helper.ts";
import { NodeNativeHelperSelection } from "../../src/providers/mobile-native.ts";
import type { ComponentTarget } from "../../src/updates/components.ts";
import { bootstrapInstall } from "../../src/updates/bootstrap.ts";
import { StableLauncher } from "../../src/updates/launcher.ts";

test("installed signed CLI rollout survives lost completion reply, restart and exact rollback with protected state intact", { timeout: 90_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-update-completion-")));
  const disks = join(root, "disks");
  const hostState = join(root, "host-state"), updateState = join(root, "update-state"), installationRoot = join(root, "installation");
  for (const directory of [hostState, disks]) mkdirSync(directory, { mode: 0o700 });
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
  const guestArtifacts = [
    { path: '/opt/canaveral/server.mjs', content: '// portable provisioned server', mode: '0644' },
    { path: '/opt/canaveral/install.mjs', content: '// portable provisioned installer', mode: '0644' },
    ...['canaveral-mobile-native', 'canaveral-guest-agent'].map(name => ({ path: '/opt/canaveral/payload/' + name + '.0000.b64', content: Buffer.from(name).toString('base64'), mode: '0644' })),
  ];
  payload.set('guest/bundle.json', Buffer.from(JSON.stringify(guestArtifacts)));
  const helperEvents = join(hostState, 'helper-events');
  payload.set('native/canaveral-mobile-native', Buffer.from(String.raw`#!${process.execPath}
import readline from 'node:readline';
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(helperEvents)}, 'spawn\n');
for await (const line of readline.createInterface({input:process.stdin})) {
  const v=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(helperEvents)}, v.op+'\n');
  const body=v.op==='updateIdentity'?{protocol:v.protocol,nonce:v.nonce,binding:v.binding,pid:process.pid}:{};
  process.stdout.write(JSON.stringify({seq:v.seq,ok:true,body})+'\n');
  if(v.op==='shutdown') break;
}
`));
  payload.set("coordination/package.json", Buffer.from('{"type":"module"}'));

  function release(sequence: number, files = payload, entrypoint = "coordination/dist/src/cli.js"): SignedRelease {
    const manifest: Manifest = { schema: "canaveral-update-v1", releaseId: randomUUID(), version: `1.0.${sequence}`, sequence, createdAt: 1000, target,
      minimumLauncherVersion: 1, entrypoint, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), executable: path.startsWith("native/"), component: path.startsWith("guest/") ? "guest" as const : path.startsWith("native/") ? "native-helper" as const : "host" as const })) };
    return { manifest, keyId: "fixture", signature: sign(null, canonicalManifest(manifest), pair.privateKey).toString("base64") };
  }
  const baseline = release(1), candidate = release(2), settings = { installationRoot, stateDirectory: updateState, trustedKeys: keys, target, protectedPaths: [hostState, configFile, disks], minimumFreeBytes: 0 };
  function bundle(envelope: SignedRelease, files: Map<string, Buffer>, name = 'bundle-' + envelope.manifest.sequence) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, 'artifacts'), { mode: 0o700 });
    writeFileSync(join(directory, 'release.json'), JSON.stringify(envelope), { mode: 0o600 });
    for (const file of envelope.manifest.files) writeFileSync(join(directory, 'artifacts', file.sha256), files.get(file.path)!, { mode: 0o600 });
    return directory;
  }
  const tampered = { ...baseline, manifest: { ...baseline.manifest, version: '99.0.0' } };
  const badBundle = bundle(tampered, payload, 'tampered-bootstrap');
  await assert.rejects(bootstrapInstall({ ...settings, bundleDirectory: badBundle }), /signature/i);
  assert.equal(existsSync(installationRoot), false); assert.equal(existsSync(updateState), false);
  const stableRoot = join(root, 'stable'), nodePath = join(root, 'node');
  mkdirSync(stableRoot, { mode: 0o700 });
  for (const [path, bytes] of payload) if (path.startsWith('coordination/')) {
    mkdirSync(dirname(join(stableRoot, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(stableRoot, path), bytes, { mode: 0o600 });
  }
  copyFileSync(realpathSync(process.execPath), nodePath); chmodSync(nodePath, 0o700);
  const stableLauncher = join(stableRoot, 'coordination/dist/src/updates/launcher.js');
  const rootCli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
  const installArgs = ['--bundle', bundle(baseline, payload), '--host-config', configFile, '--installation', installationRoot,
    '--state', updateState, '--node', nodePath, '--launcher', stableLauncher, '--stable-root', stableRoot];
  const installation = await promisify(execFile)(process.execPath, [rootCli, 'install', ...installArgs], { timeout: 20_000 });
  const installed = JSON.parse(installation.stdout) as { installationId: string; releaseId: string; service: { filename: string; content: string } };
  assert.equal(installed.releaseId, baseline.manifest.releaseId);
  assert.ok(installed.service.content.includes(stableLauncher));
  assert.equal(existsSync(join(root, installed.service.filename)), false, 'installer generates service text only');
  const initial = new UpdateStore(settings);
  assert.equal(initial.active(), baseline.manifest.releaseId); assert.equal(initial.installationId, installed.installationId);
  const installationIdentity = readFileSync(join(updateState, 'installation.json'));
  await assert.rejects(promisify(execFile)(process.execPath, [rootCli, 'install', ...installArgs], { timeout: 20_000 }), 'reinstall must not adopt existing roots');
  assert.deepEqual(readFileSync(join(updateState, 'installation.json')), installationIdentity);
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
    const directory = bundle(envelope, files);
    const result = await promisify(execFile)(process.execPath, [cli, '--url', config.url!, '--token-file', adminFile,
      'releases', 'upload', '--bundle', directory, '--trusted-keys', trustFile], { timeout: 20_000 });
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(credential + '|' + admin));
    return directory;
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
    assert.deepEqual(readFileSync(join(updateState, 'installation.json')), installationIdentity);
    assert.deepEqual(readFileSync(stableLauncher), payload.get('coordination/dist/src/updates/launcher.js'));
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
  // A host credential and a structurally valid ACK cannot replace independent evidence.
  const completed = updater.store.job()!;
  const context = { jobId: completed.id, attemptId: completed.attemptId, installationId: completed.installationId, releaseId: candidate.manifest.releaseId };
  const targets: ComponentTarget[] = [
    { component: 'guest', machineId: randomUUID(), assignmentId: randomUUID(), bootId: randomUUID(), generation: 1 },
    { component: 'native-helper', helperId: 'portable-helper', executable: 'native/canaveral-mobile-native', instanceId: randomUUID(), generation: 1 },
  ];
  for (const inventory of [[], targets]) assert.deepEqual(await transport.request('POST', '/v1/hosts/' + hostId + '/updates/component-plan', { ...context, targets: inventory }, credential), { accepted: false, pending: true });
  for (const target of targets) await assert.rejects(transport.request('POST', '/v1/hosts/' + hostId + '/updates/component-report', {
    ...context, target, fileSetDigest: componentFileSetDigest(candidate.manifest, target.component), sequence: 1,
    state: 'adopted', evidence: { boundary: 'idle-closed', acknowledgement: 'a'.repeat(64) },
  }, credential));
  // Current production configuration has no independent owned adapter evidence.
  for (let count = 0; count < 3; count++) await updater.step();
  assert.equal(updater.store.job()!.adoption, undefined);
  assert.equal(existsSync(helperEvents), false, 'production path must not launch an unverified helper');
  const stillPending = await transport.request('GET', '/v1/updates/rollouts/' + rolloutId, {}, admin);
  assert.deepEqual((stillPending.jobs as Array<{ components: Record<string, string> }>)[0]!.components, components);
  // Exercise real owned adapters against this installed signed release. No live provider is involved.
  const guestRoot = join(root, 'provisioned-guest'), machineId = randomUUID(), assignmentId = randomUUID(), bootId = randomUUID();
  const provision = signedGuestProvision(candidate, keys, updater.store.releasePath(candidate.manifest.releaseId), context, { machineId, assignmentId, generation: 1 });
  for (const artifact of provision) {
    const path = join(guestRoot, artifact.path.slice('/opt/canaveral/'.length));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, artifact.content, { mode: parseInt(artifact.mode, 8) });
  }
  mkdirSync(join(guestRoot, 'bin'), { mode: 0o700 });
  for (const name of ['canaveral-mobile-native', 'canaveral-guest-agent']) writeFileSync(join(guestRoot, 'bin', name), name, { mode: 0o755 });
  let idle = true;
  const service = createGuestAdoptionService(guestRoot, bootId, () => idle)!;
  const guestToken = randomBytes(32).toString('base64url');
  const server = createGuestServer({ token: guestToken, mode: 'headless', services: { ready: () => true, adoption: service,
    control: async () => { throw new Error('No workload dispatch in adoption fixture'); }, upload: async () => { throw new Error(); }, download: async () => { throw new Error(); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const access = new GuestAccess(async () => ({ port, credential: guestToken, authorized: () => true, close: async () => {} }));
  const guestTarget = { component: 'guest' as const, machineId, assignmentId, bootId, generation: 1 };
  let inventoryTarget = { ...guestTarget, bootId: randomUUID() };
  const guestDriver = createGuestAdoptionDriver(access, async () => [{ target: inventoryTarget, machine: { id: machineId }, image: { os: 'linux', guestAccess: true }, folder: guestRoot }]);
  const guestRequest = { ...context, target: guestTarget, fileSetDigest: componentFileSetDigest(candidate.manifest, 'guest') };
  try {
    // Inventory agrees with the caller, but the authenticated owned service is a different boot.
    const stale = { ...guestRequest, target: inventoryTarget };
    await assert.rejects(guestDriver.adopt(stale));
    assert.equal(service.admitted(), false); assert.equal(existsSync(join(guestRoot, 'state/update-adoption.json')), false);
    inventoryTarget = guestTarget; idle = false;
    assert.equal((await guestDriver.adopt(guestRequest)).state, 'unknown');
    idle = true;
    const receipt = await guestDriver.adopt(guestRequest); assert.equal(receipt.state, 'adopted');
    const saved = readFileSync(join(guestRoot, 'state/update-adoption.json'));
    assert.deepEqual(await guestDriver.recover(guestRequest), receipt);
    assert.deepEqual(readFileSync(join(guestRoot, 'state/update-adoption.json')), saved);
    // A service restart on a different boot cannot reuse a durable old-boot receipt.
    const rebooted = createGuestAdoptionService(guestRoot, randomUUID(), () => true)!;
    assert.equal(rebooted.admitted(), false); await assert.rejects(rebooted.acknowledge(guestRequest, true));
    assert.doesNotMatch(saved.toString(), new RegExp(guestToken));
  } finally { await access.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const helperPath = join(updater.store.releasePath(candidate.manifest.releaseId), 'native/canaveral-mobile-native');
  const selection = new NodeNativeHelperSelection(helperPath), helper = new NativeHelperAdoptionDriver(updater.store, selection);
  let helperRequest: import('../../src/updates/components.ts').ComponentAdoptionRequest;
  try {
    const [target] = await helper.targets(context, candidate);
    helperRequest = { ...context, target: target!, fileSetDigest: componentFileSetDigest(candidate.manifest, 'native-helper') };
    const wrong = { ...helperRequest, target: { ...target!, instanceId: randomUUID() } as ComponentTarget };
    await assert.rejects(helper.adopt(wrong), /instance mismatch/);
    assert.equal(existsSync(helperEvents), false, 'wrong instance must not launch a process');
    const receipt = await helper.adopt(helperRequest); assert.equal(receipt.state, 'adopted');
    const events = readFileSync(helperEvents, 'utf8'); assert.equal(events, 'spawn\nupdateIdentity\n');
    assert.equal(helper.verifyAcknowledgement(wrong, receipt.evidence!.acknowledgement), false);
    await assert.rejects(helper.recover(wrong), /identity mismatch/);
    assert.deepEqual(await helper.recover(helperRequest), receipt);
    assert.deepEqual(await helper.adopt(helperRequest), receipt);
    assert.equal(readFileSync(helperEvents, 'utf8'), events, 'lost helper receipt must not repeat handshake or spawn');
  } finally { helper.close(); await selection.close(); }
  const restartedSelection = new NodeNativeHelperSelection(helperPath), restartedHelper = new NativeHelperAdoptionDriver(updater.store, restartedSelection);
  try {
    const events = readFileSync(helperEvents, 'utf8');
    assert.equal((await restartedHelper.recover(helperRequest!))?.state, 'unknown');
    assert.equal((await restartedHelper.adopt(helperRequest!)).state, 'unknown');
    assert.equal(readFileSync(helperEvents, 'utf8'), events, 'owner restart must not replay an uncertain helper');
  } finally { restartedHelper.close(); await restartedSelection.close(); }
  // Fixture-owned receipts do not bypass the controller's absent independent verifier.
  const unverified = await transport.request('GET', '/v1/updates/rollouts/' + rolloutId, {}, admin);
  assert.deepEqual((unverified.jobs as Array<{ components: Record<string, string> }>)[0]!.components, components);
  preserved();
  // A positive close permits a fresh parent; it must select the committed candidate.
  await updater.close(); await launcher.close(await launcher.quiesce());
  launcher = new StableLauncher({ ...settings, hostConfigPath: configFile, hostStateDirectory: hostState, readinessTimeoutMs: 10_000, stopTimeoutMs: 10_000 });
  await launcher.start(); updater = makeUpdater();
  assert.equal(updater.store.active(), candidate.manifest.releaseId);
  const hostIdle = await launcher.idle();
  assert.equal(hostIdle.idle, true); assert.equal(hostIdle.workloadsStopped, true);
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
