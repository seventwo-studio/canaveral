import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startController } from '../../coordination/dist/src/main.js';
import { backendIds } from '../../coordination/dist/src/host-runtimes/index.js';
import { assertNoDaemon, eventually, foreground, nativeService } from './service.mjs';

const [mode, output] = process.argv.slice(2);
assert.ok(output && ['foreground', 'service'].includes(mode), 'Use acceptance.mjs foreground|service EVIDENCE.json');
if (mode === 'service') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(['linux', 'darwin'].includes(process.platform));
  assert.notEqual(process.getuid(), 0);
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const coordination = join(repo, 'coordination');
const evidence = {
  commit: process.env.GITHUB_SHA ?? null,
  image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  backend: 'native',
  mode,
  steps: [],
};
const evidencePath = resolve(output);
async function step(name, work) {
  const start = performance.now();
  let outcome = 'failed';
  try {
    const result = await work();
    outcome = 'passed';
    return result;
  } finally {
    evidence.steps.push({ name, outcome, milliseconds: Math.round(performance.now() - start) });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(`${name}: ${outcome}`);
  }
}

const root = await realpath(await mkdtemp(join(tmpdir(), 'canaverald-acceptance-')));
const host = join(root, 'host');
const controllerDir = join(root, 'controller');
const config = join(host, 'host.json');
const state = join(host, 'state');
const enrollmentFile = join(host, 'enrollment.token');
const adminFile = join(controllerDir, 'admin.token');
const configArgs = ['--config', config, '--state', state];
const capacity = { cpu: 1, memoryMiB: 1024, diskGiB: 1 };
const name = 'canaverald-acceptance';
const node = mode === 'service' ? join(root, 'node') : process.execPath;
const entry = join(mode === 'service' ? join(root, 'coordination') : coordination, 'dist', 'src', 'canaverald.js');
let controller, service;
try {
  const admin = randomBytes(32).toString('base64url');
  const url = await step('start loopback controller and mint credentials', async () => {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await mkdir(controllerDir, { mode: 0o700 });
    await writeFile(adminFile, admin, { mode: 0o600 });
    await writeFile(enrollmentFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    controller = await startController({
      statePath: join(controllerDir, 'controller.sqlite'),
      adminTokenFile: adminFile,
      enrollmentTokenFile: enrollmentFile,
      controllerId: randomUUID(),
      listen: { host: '127.0.0.1', port: 0 },
    });
    return `http://127.0.0.1:${controller.address.port}`;
  });
  await writeFile(config, JSON.stringify({
    name, provider: 'native', capacity, templates: [], runtimes: {}, pollIntervalSeconds: 0.25,
  }), { mode: 0o600 });
  const paths = { root, host, node, entry, enrollmentFile, url, configArgs, coordination, repo };
  service = mode === 'service' ? await nativeService(paths) : foreground(paths);
  Object.assign(evidence, { manager: service.manager, account: service.account });
  if (mode === 'service') await step('install service definition', () => service.install());

  async function healthyHost(after = 0, healthAfter = 0) {
    const result = await fetch(url + '/v1/hosts', {
      headers: { Authorization: `Bearer ${admin}` },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(result.status, 200);
    const { hosts } = await result.json();
    assert.ok(hosts.length <= 1, 'one enrolled host');
    const [host] = hosts;
    if (host?.online && host.health?.status === 'passed' && host.health?.fresh &&
        host.lastSeen > after && host.health.receivedAt > healthAfter) return host;
  }

  const first = await step('start, enroll, and receive healthy offer', async () => {
    await service.start(true);
    const host = await eventually('an enrolled host with fresh health', () => healthyHost());
    assert.match(host.id, /^[0-9a-f-]{36}$/);
    assert.equal(host.name, name);
    assert.equal(host.provider, 'native');
    assert.deepEqual(host.capacity, capacity);
    assert.deepEqual(host.templates, []);
    evidence.hostId = host.id;
    return host;
  });
  const pid = await eventually('daemon service PID', () => service.pid());
  await step('advance heartbeat under the service account', async () => {
    await service.assertOwner?.(pid);
    await eventually('a subsequent heartbeat', () => healthyHost(first.lastSeen));
  });

  function json(args) { return service.run(args).then(JSON.parse); }

  async function tryStateLock() {
    // Use the public host runner lock implementation as the same service user.
    // A busy result is expected while the service still owns this state.
    const module = new URL('./runtime-process.js', pathToFileURL(entry)).href;
    const source = `
      const { StateLock } = await import(process.argv[1]);
      try {
        const lock = new StateLock(process.argv[2]);
        lock.close();
        console.log('"released"');
      } catch (error) {
        if (error.code !== 'assignment_busy') throw error;
        console.log('"busy"');
      }`;
    return json(['--input-type=module', '-e', source, module, join(state, 'host-runner.sqlite')]);
  }

  await step('run inventory and runtime status with the service config and state', async () => {
    const inventory = await json([entry, '--url', url, ...configArgs, '--inventory']);
    assert.equal(inventory.status, 'passed');
    assert.equal(inventory.machine.platform, process.platform);
    assert.equal(inventory.machine.architecture, process.arch);
    assert.equal(inventory.offer.name, name);
    const runtimes = await json([entry, 'runtimes', 'status', ...configArgs, '--json']);
    assert.deepEqual(runtimes.map(runtime => runtime.id), backendIds);
    assert.deepEqual(runtimes, inventory.runtimes);
    assert.equal(await tryStateLock(), 'busy');
  });

  await step('restart without the enrollment credential', async () => {
    await service.stop();
    await assertNoDaemon(entry, pid);
    await service.run(['-e', 'require("node:fs").unlinkSync(process.argv[1])', enrollmentFile]);
    const stoppedAt = Date.now() / 1000;
    await service.start(false);
    const restarted = await eventually('authenticated heartbeats after restart', () => healthyHost(stoppedAt, stoppedAt));
    assert.equal(restarted.id, first.id);
    await eventually('continued heartbeats after restart', () => healthyHost(restarted.lastSeen));
  });

  await step('stop cleanly and reacquire the state lock', async () => {
    const restartedPid = await service.pid();
    assert.ok(restartedPid > 0);
    assert.notEqual(restartedPid, pid);
    await service.assertOwner?.(restartedPid);
    await service.stop();
    await assertNoDaemon(entry, restartedPid);
    assert.equal(await tryStateLock(), 'released');
  });

  if (mode === 'service') {
    await step('uninstall and verify service registration is gone', async () => {
      await service.uninstall();
      await assertNoDaemon(entry);
    });
  }
} finally {
  try {
    await service?.cleanup();
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
}
