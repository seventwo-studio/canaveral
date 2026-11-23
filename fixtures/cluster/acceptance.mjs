import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const work = process.env.CLUSTER_WORK;
const evidencePath = process.env.CLUSTER_EVIDENCE;
const state = '/var/lib/canaverald';
const origin = 'https://127.0.0.1:8765';
const internal = 'https://orchestrator.canaveral.svc:8765';
const admin = readFileSync(work + '/admin.token', 'utf8').trim();
const controllerId = readFileSync(work + '/controller-id', 'utf8').trim();
const report = JSON.parse(readFileSync(evidencePath, 'utf8'));
const model = JSON.parse(readFileSync(new URL('../model-execution/real-model.json', import.meta.url)));
const { pins } = JSON.parse(readFileSync(new URL('../../crates/model-execution/src/runtime-pins.json', import.meta.url)));
const engine = pins.find(pin => pin.os === 'linux' && pin.arch === 'x86_64' && pin.backend === 'llama.cpp');
report.model = { name: model.model, sha256: model.sha256 };
report.engine = { backend: 'llama.cpp', acceleration: 'cpu', version: engine.version,
  archiveSha256: engine.sha256, treeSha256: engine.treeSha256 };

class Blocked extends Error {}
async function step(name, task) {
  const entry = { name, outcome: 'running' };
  report.steps.push(entry);
  const save = () => writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
  const start = performance.now();
  save();
  try {
    entry.result = await task();
    entry.outcome = 'passed';
    return entry.result;
  } catch (error) {
    entry.outcome = error instanceof Blocked ? 'blocked' : 'failed';
    if (error instanceof Blocked) entry.reason = error.message;
    console.error(name, error.message);
    process.exitCode = 1;
  } finally {
    entry.durationMs = Math.round(performance.now() - start);
    save();
  }
}

function command(bin, args, { input, timeout = 190_000 } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // Command output may contain credentials or private host journals.
    throw new Error(`${bin} failed (${error.signal ?? error.status ?? error.code})`);
  }
}
const kubectl = (...args) => command('kubectl', args);
const daemon = (...args) => kubectl('-n', 'canaverald', ...args);
const daemonPods = () => JSON.parse(daemon('get', 'pods', '-l', 'app.kubernetes.io/name=canaverald', '-o', 'json')).items;
const waitForDaemon = async (previousUid) => eventually('ready daemon Pod', () => {
  const pods = daemonPods();
  return pods.length === 1 && pods[0].metadata.uid !== previousUid &&
    pods[0].status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') && pods[0];
});
const inPod = (...args) => daemon('exec', 'daemonset/canaverald', '--', ...args);
const sudo = (...args) => command('sudo', args);
async function request(path, body, token = admin) {
  const reply = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: reply.status, body: await reply.json() };
}
async function call(path, body, token) {
  const result = await request(path, body, token);
  assert(result.status >= 200 && result.status < 300, `${path} returned HTTP ${result.status}`);
  return result.body;
}
async function eventually(label, check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await check();
    if (result) return result;
    await delay(2000);
  }
  throw new Error('Timed out waiting for ' + label);
}

const setup = JSON.parse(JSON.parse(readFileSync('deploy/kubernetes/canaverald/base/configmap.json')).data['host.json']);
const resources = setup.capacity;
const node = kubectl('get', 'nodes', '-o', 'name');
const ready = await step('controller TLS and k3s node', async () => {
  assert.match(node, /^node\/[a-z0-9.-]+$/);
  await eventually('verified HTTPS port forward', async () => {
    try { return (await fetch(origin + '/healthz', { signal: AbortSignal.timeout(3000) })).ok; }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  });
  return true;
});

let host;
if (ready) {
  host = await step('single-claim enrollment and heartbeats', async () => {
    const id = randomUUID(), { name, provider, capacity } = setup;
    const issued = await request('/v1/connection-setups', { id, name, provider, capacity });
    if (issued.status === 400 && issued.body.error === 'Choose a VM or simulator provider.') {
      throw new Blocked('POST /v1/connection-setups returned HTTP 400 for the CPU native offer: Choose a VM or simulator provider.');
    }
    assert.equal(issued.status, 200);
    command('sudo', ['bash', 'script/provision_cluster_node.sh'], { input: issued.body.enrollmentToken + '\n' });
    kubectl('apply', '-f', 'deploy/kubernetes/canaverald/base/namespace.json');
    daemon('create', 'configmap', 'canaveral-controller-ca', '--from-file=ca.crt=' + work + '/ca.crt');
    kubectl('label', node, 'canaveral.dev/host-profile=cpu');
    kubectl('apply', '-k', 'deploy/kubernetes/canaverald');
    await waitForDaemon();
    const claim = (await call('/v1/connection-setups')).setups.find(row => row.id === id);
    assert.equal(claim.state, 'connected');
    const get = async () => (await call('/v1/hosts')).hosts.find(row => row.id === claim.hostId);
    const first = await eventually('host offer', async () => {
      const candidate = await get();
      return candidate?.online && candidate.health?.fresh && candidate;
    });
    assert.equal(first.provider, provider);
    assert.deepEqual(first.capacity, capacity);
    assert.deepEqual(first.templates, []);
    const next = await eventually('heartbeat progression', async () => {
      const candidate = await get();
      return candidate?.lastSeen > first.lastSeen && candidate;
    });
    inPod('test', '!', '-e', state + '/bootstrap/enrollment-token');
    return { id: next.id, provider: next.provider, lastSeen: next.lastSeen };
  });
}

// Use the same pinned GGUF, bound runner enrollment and one-shot invocation as
// model-execution/real-engine.mjs. The one-shot process runs inside the daemon pod.
if (host) {
  await step('install pinned llama.cpp and generate through public API', async () => {
    const dir = state + '/model-acceptance';
    for (const path of [dir, dir + '/models', dir + '/state']) {
      sudo('install', '-d', '-m', '0700', '-o', '10001', '-g', '10001', path);
    }
    const local = work + '/' + model.file;
    command('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--max-time', '300', '--max-filesize', String(model.bytes), '--output', local, model.url], { timeout: 305_000 });
    const bytes = readFileSync(local);
    assert.equal(bytes.length, model.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), model.sha256);
    sudo('install', '-m', '0600', '-o', '10001', '-g', '10001', local, dir + '/models/' + model.file);
    const digest = 'sha256:' + model.sha256;
    const applicationId = randomUUID(), domainId = randomUUID(), id = randomUUID();
    const binding = { controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
    const credential = randomBytes(32).toString('base64url');
    await call('/v1/model-catalog', { model: model.model, digest, adapter: 'llama.cpp', resources });
    const app = await call('/v1/consumers', {
      id: applicationId, name: 'disposable cluster model fixture', templates: [], limits: { resources, activeLeases: 1 },
    });
    await call('/v1/model-grants', { applicationId, model: model.model, digest, maxUnfinished: 1 });
    const enrollment = await call('/v1/runner-enrollments', { id, ...binding, ttlSeconds: 60 });
    await call('/v1/runner-enrollments/consume', { id, ...binding, credential }, enrollment.enrollmentToken);
    await call('/v1/resource-domains', { id: domainId, name: 'disposable cluster model fixture', capacity: resources });
    await call('/v1/model-runner-approvals', { binding, domainId, models: [{ model: model.model, digest }] });
    const config = {
      controller: internal, binding, credentialFile: dir + '/credential', caFile: dir + '/ca.crt',
      execution: {
        backend: 'llama.cpp', acceleration: 'cpu', modelsDir: dir + '/models', stateDir: dir + '/state',
        inventory: { [model.model]: digest }, modelFiles: { [model.model]: { path: model.file, files: { [model.file]: model.sha256 } } },
        startupMs: 120_000, executionMs: 120_000, contactMs: 10_000, stopMs: 5000, responseBytes: 262144, contextTokens: 2048,
      },
    };
    for (const [name, value] of Object.entries({
      credential, 'ca.crt': readFileSync(work + '/ca.crt'), 'runner.json': JSON.stringify(config),
      'host.json': JSON.stringify({ ...setup, modelExecutor: { binary: '/usr/local/bin/canaveral-model-execution', config: dir + '/runner.json' } }),
    })) {
      const path = work + '/' + name;
      writeFileSync(path, value, { mode: 0o600 });
      sudo('install', '-m', '0600', '-o', '10001', '-g', '10001', path, dir + '/' + name);
    }
    const install = (...args) => command('kubectl', ['-n', 'canaverald', 'exec', 'daemonset/canaverald', '--',
      'canaverald', 'runtimes', ...args, '--config', dir + '/host.json', '--state', dir + '/state', '--json'], { timeout: 720_000 });
    install('install', 'llama.cpp');
    const row = JSON.parse(install('status')).find(entry => entry.id === 'llama.cpp');
    assert.equal(row.state, 'verified');
    const packageDigest = createHash('sha256').update(`archive-v1\nllama.cpp\n${engine.version}\n${engine.treeSha256}`).digest('hex');
    assert.equal(row.installed[0].packageDigest, packageDigest);
    const job = randomUUID();
    await call('/v1/model-jobs', { version: 1, applicationId, id: job, message: {
      type: 'submit', adapter: 'llama.cpp', model: model.model, digest,
      prompt: "<|im_start|>user\nComplete: The Moon is Earth's natural ...<|im_end|>\n<|im_start|>assistant\nThe Moon is Earth's natural",
      maxTokens: 32,
    } }, app.credential);
    command('kubectl', ['-n', 'canaverald', 'exec', 'daemonset/canaverald', '--',
      'canaveral-model-execution', dir + '/runner.json'], { timeout: 255_000 });
    const view = await call('/v1/model-jobs/' + job, undefined, app.credential);
    assert.equal(view.state, 'succeeded');
    assert.equal(view.result.model, model.model);
    assert(view.result.text.trim());
    assert(view.result.usage.inputTokens > 0 && view.result.usage.outputTokens > 0 && view.result.usage.outputTokens <= 32);
    assert.equal(view.reservationHeld, false);
    inPod('test', '!', '-e', dir + '/state/workspace');
    return { packageDigest, usage: view.result.usage, reservationHeld: view.reservationHeld };
  });

  const maintenance = '/v1/hosts/' + host.id + '/maintenance';
  const drain = await step('Canaveral drain and same-node pod replacement', async () => {
    const id = randomUUID();
    await call(maintenance, { id, reason: 'disposable cluster acceptance' });
    await eventually('independent safe-to-power-off proof', async () => (await call(maintenance)).safeToPowerOff);
    const old = daemonPods();
    assert.equal(old.length, 1);
    daemon('delete', 'pod', old[0].metadata.name, '--timeout=150s');
    const deletedAt = Date.now() / 1000;
    await waitForDaemon(old[0].metadata.uid);
    const after = await eventually('same identity heartbeating', async () => {
      const { hosts } = await call('/v1/hosts');
      assert.equal(hosts.length, 1);
      return hosts[0].id === host.id && hosts[0].lastSeen > deletedAt && hosts[0];
    });
    const status = JSON.parse(inPod('canaverald', 'runtimes', 'status', '--config', '/etc/canaverald/host.json', '--state', state, '--json'));
    assert(status.some(row => row.id === 'containerd' && row.blocker?.code === 'kubernetes_containerd_disabled'));
    return { id, hostId: after.id, runtimeIds: status.map(row => row.id) };
  });
  if (drain) {
    await step('uninstall and verify explicitly retained state', async () => {
      await eventually('renewed safe-to-power-off proof', async () => (await call(maintenance)).safeToPowerOff);
      kubectl('delete', '-k', 'deploy/kubernetes/canaverald', '--timeout=150s');
      const identity = sudo('jq', '-r', '.id', state + '/identity.json');
      assert.equal(identity, host.id);
      assert.equal(sudo('stat', '-c', '%u:%g:%a', state), '10001:10001:700');
      return { state: 'retained', hostId: identity };
    });
  }
}

if (!host) {
  report.steps.push(...['install pinned llama.cpp and generate through public API',
    'Canaveral drain and same-node pod replacement', 'uninstall and verify explicitly retained state'].map(name => ({
    name, outcome: 'not_run', reason: 'Requires an enrolled daemon with advancing heartbeats.',
  })));
  writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
}

if (ready) {
  const capability = await step('host libvirt and KVM capability', () => {
    command('sudo', ['apt-get', 'update'], { timeout: 240_000 });
    command('sudo', ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends',
      'libvirt-daemon-system', 'libvirt-daemon-driver-qemu', 'libvirt-clients', 'qemu-system-x86'], { timeout: 360_000 });
    try { sudo('test', '-c', '/dev/kvm'); }
    catch { throw new Blocked('The hosted runner has no /dev/kvm character device after installing host QEMU and libvirt.'); }
    sudo('systemctl', 'start', 'libvirtd.socket');
    sudo('virsh', '--connect', 'qemu:///system', 'domcapabilities', '--virttype', 'kvm');
    return { kvm: true, libvirt: sudo('virsh', '--version') };
  });
  await step('VM boot, lease cleanup, and active-lease pod replacement', async () => {
    const reply = await request('/v1/linux-lease-images', {
      id: 'cluster-libvirt-trial', revision: '1', arch: 'amd64', os: 'linux', mode: 'headless',
      backend: 'libvirt', digest: 'sha256:' + '0'.repeat(64), resources, capabilities: [],
    });
    if (reply.status === 400 && reply.body.error === 'Backend must be appleVirtualization.') {
      throw new Blocked('POST /v1/linux-lease-images returned HTTP 400: Backend must be appleVirtualization. No VM lease, AUTODESTROY or reservation reconciliation was exercised.');
    }
    assert(capability, 'Host KVM and libvirt capability is required for VM acceptance.');
    throw new Error(`Unexpected HTTP ${reply.status} from libvirt catalogue probe. A real VM lease acceptance fixture is required before enabling this backend.`);
  });
}
