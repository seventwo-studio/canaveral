import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
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
const guest = JSON.parse(readFileSync(new URL('./guest-image.json', import.meta.url)));
const { pins } = JSON.parse(readFileSync(new URL('../../crates/model-execution/src/runtime-pins.json', import.meta.url)));
const engine = pins.find(pin => pin.os === 'linux' && pin.arch === 'x86_64' && pin.backend === 'llama.cpp');
report.model = { name: model.model, sha256: model.sha256 };
report.engine = { backend: 'llama.cpp', acceleration: 'cpu', version: engine.version,
  archiveSha256: engine.sha256, treeSha256: engine.treeSha256 };

class Blocked extends Error {}
class ExpectedGap extends Blocked {}
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
    entry.reason = error.message;
    console.error(name, error.message);
    if (!(error instanceof ExpectedGap)) process.exitCode = 1;
  } finally {
    entry.durationMs = Math.round(performance.now() - start);
    save();
  }
}

function command(bin, args, { input, timeout = 190_000, reveal = false } = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout, input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // Command output may contain credentials or private host journals. Only
    // callers whose diagnostics are known to be safe reveal a redacted tail.
    const detail = reveal ? ': ' + String(error.stderr ?? '').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').trim().slice(-400) : '';
    throw new Error(`${bin} failed (${error.signal ?? error.status ?? error.code})${detail}`);
  }
}
const kubectl = (...args) => command('kubectl', args);
const admission = (...args) => command('kubectl', args, { reveal: true });
// Run a command that must fail, returning its stderr for an exact refusal check.
function refusal(bin, args, input) {
  try { execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, input, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { return String(error.stderr ?? ''); }
  throw new Error(`${bin} unexpectedly succeeded`);
}
const daemon = (...args) => kubectl('-n', 'canaverald', ...args);
const daemonPods = () => JSON.parse(daemon('get', 'pods', '-l', 'app.kubernetes.io/name=canaverald', '-o', 'json')).items;
const waitForDaemon = async (previousUid) => eventually('ready daemon Pod', () => {
  const pods = daemonPods();
  return pods.length === 1 && pods[0].metadata.uid !== previousUid &&
    pods[0].status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') && pods[0];
});
const inPod = (...args) => daemon('exec', 'daemonset/canaverald', '--', ...args);
const sudo = (...args) => command('sudo', args);
const virsh = (...args) => sudo('virsh', '--connect', 'qemu:///system', ...args);
function request(path, body, token = admin) {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const conn = httpsRequest(origin + path, {
      agent: false,
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
      signal: AbortSignal.timeout(5000),
    }, async reply => {
      try {
        const chunks = [];
        for await (const chunk of reply) chunks.push(chunk);
        resolve({ status: reply.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) { reject(error); }
    });
    conn.on('error', reject);
    conn.end(data);
  });
}
function rejection(result) {
  const summary = String(result.body.message ?? result.body.error ?? '').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(0, 180);
  return `HTTP ${result.status} ${summary}`.trim();
}
async function call(path, body, token) {
  const result = await request(path, body, token);
  assert(result.status >= 200 && result.status < 300, `${path} returned ${rejection(result)}`);
  return result.body;
}
async function eventually(label, check, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
let cpuRetained;
if (ready) {
  host = await step('single-claim enrollment and heartbeats', async () => {
    const id = randomUUID(), { name, provider, capacity } = setup;
    const issued = await request('/v1/connection-setups', { id, name, provider, capacity });
    assert.equal(issued.status, 200, rejection(issued));
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

if (host) {
  await step('admission policy rejects forbidden canaverald pods', async () => {
    const policy = await eventually('type-checked admission policy', () => {
      const value = JSON.parse(admission('get', 'validatingadmissionpolicy', 'canaverald-pod-security', '-o', 'json'));
      return value.status?.observedGeneration === value.metadata.generation && value;
    });
    assert.deepEqual(policy.status.typeChecking?.expressionWarnings ?? [], []);
    const container = {
      name: 'probe', image: 'busybox:1.37', command: ['true'],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    };
    const pod = (name, change = spec => spec, namespace = 'canaverald') => {
      const spec = change({
        securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [structuredClone(container)],
        volumes: [{ name: 'state', hostPath: { path: state, type: 'Directory' } }],
      });
      return JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace }, spec });
    };
    const dryRun = ['create', '--dry-run=server', '-o', 'name', '-f', '-'];
    // The API itself rejects privileged with allowPrivilegeEscalation false.
    const privileged = spec => {
      spec.containers[0].securityContext = { privileged: true, capabilities: { drop: ['ALL'] } };
      return spec;
    };
    // The apiserver loads a new policy asynchronously; wait until it denies.
    await eventually('policy enforcement', () => {
      try { command('kubectl', dryRun, { input: pod('admission-wait', privileged), reveal: true }); return false; }
      catch (error) { if (/canaverald-pod-security/.test(error.message)) return true; throw error; }
    }, 30);
    command('kubectl', dryRun, { input: pod('admission-allowed'), reveal: true });
    command('kubectl', dryRun, { input: pod('admission-other-namespace', privileged, 'default'), reveal: true });
    const forbidden = {
      privileged: [privileged, /must not be privileged/],
      'extra-host-path': [spec => { spec.volumes.push({ name: 'etc', hostPath: { path: '/etc', type: 'Directory' } }); return spec; }, /hostPath volumes are limited/],
      'create-host-path': [spec => { spec.volumes[0].hostPath.type = 'DirectoryOrCreate'; return spec; }, /hostPath volumes are limited/],
      'host-network': [spec => ({ ...spec, hostNetwork: true }), /host network/],
      'host-pid': [spec => ({ ...spec, hostPID: true }), /host PID/],
      'added-capability': [spec => { spec.containers[0].securityContext.capabilities.add = ['NET_ADMIN']; return spec; }, /drop ALL capabilities and add none/],
      escalation: [spec => { delete spec.containers[0].securityContext.allowPrivilegeEscalation; return spec; }, /allowPrivilegeEscalation/],
      'host-port': [spec => { spec.containers[0].ports = [{ containerPort: 80, hostPort: 8080 }]; return spec; }, /host ports/],
      'init-privileged': [spec => { spec.initContainers = [{ ...structuredClone(container), name: 'init', securityContext: { privileged: true } }]; return spec; }, /Init containers must not be privileged/],
    };
    const rejected = {};
    for (const [name, [change, message]] of Object.entries(forbidden)) {
      const stderr = refusal('kubectl', dryRun, pod('admission-' + name, change));
      assert.match(stderr, /canaverald-pod-security/, name);
      assert.match(stderr, message, name);
      rejected[name] = 'denied';
    }
    return { policy: policy.metadata.name, allowed: ['compliant pod', 'privileged pod outside canaverald'], rejected };
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
    cpuRetained = await step('uninstall and verify explicitly retained state', async () => {
      await eventually('renewed safe-to-power-off proof', async () => (await call(maintenance)).safeToPowerOff);
      kubectl('delete', '-k', 'deploy/kubernetes/canaverald', '--timeout=150s');
      const identity = sudo('jq', '-r', '.id', state + '/identity.json');
      assert.equal(identity, host.id);
      assert.equal(sudo('stat', '-c', '%u:%g:%a', state), '10001:10001:700');
      await eventually('daemon process exit', () => {
        try { command('pgrep', ['-u', '10001', '-f', 'canaverald']); return false; } catch { return true; }
      }, 90);
      const unused = randomBytes(32).toString('base64url') + '\n';
      assert.match(refusal('sudo', ['bash', 'script/provision_cluster_node.sh', 'replace-token'], unused), /identity\.json exists: this node is enrolled/);
      return { state: 'retained', hostId: identity, tokenReplacementRefused: 'identity exists' };
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
      'libvirt-daemon-system', 'libvirt-daemon-driver-qemu', 'libvirt-daemon-config-network',
      'libvirt-clients', 'qemu-system-x86', 'qemu-utils', 'ovmf', 'dnsmasq-base', 'polkitd'], { timeout: 360_000 });
    try { sudo('test', '-c', '/dev/kvm'); }
    catch { throw new Blocked('The hosted runner has no /dev/kvm character device after installing host QEMU and libvirt.'); }
    sudo('systemctl', 'start', 'libvirtd.socket');
    sudo('virsh', '--connect', 'qemu:///system', 'domcapabilities', '--virttype', 'kvm');
    return { kvm: true, libvirt: sudo('virsh', '--version') };
  });
  if (capability) {
    const guestDisk = await step('verify the pinned VM guest disk', () => {
      const disk = work + '/guest.qcow2';
      const download = url => command('curl', ['--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '4', '--connect-timeout', '12',
        '--max-time', '45', '--retry', '1', '--retry-max-time', '100', '--max-filesize', String(guest.bytes),
        '--output', disk, url]);
      let source = 'GitHub release';
      try { download(guest.url); }
      catch { source = 'CirrOS download mirror'; download(guest.mirror); }
      const bytes = readFileSync(disk);
      assert.equal(bytes.length, guest.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), guest.sha256);
      const info = JSON.parse(command('qemu-img', ['info', '-f', guest.format, '--output=json', disk]));
      assert.equal(info.format, guest.format);
      assert(!info['backing-filename'], 'Guest template must be self-contained.');
      return { sha256: guest.sha256, format: info.format, bytes: bytes.length, source };
    });
    if (cpuRetained && guestDisk) await exerciseVm();
    else {
      report.steps.push({ name: 'administrative VM lifecycle', outcome: 'not_run', reason: 'Requires the staged guest and successful CPU-profile uninstall.' });
      writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  await step('consumer libvirt lease admission and reservation reconciliation', async () => {
    const image = {
      id: 'cluster-catalogue-control', revision: '1', arch: 'amd64', os: 'linux', mode: 'headless',
      digest: 'sha256:' + guest.sha256, resources, capabilities: ['command'],
    };
    const refused = await request('/v1/linux-lease-images', { ...image, backend: 'libvirt' });
    assert.equal(refused.status, 400, rejection(refused));
    assert.equal(refused.body.code, 'invalid_request');
    const control = await call('/v1/linux-lease-images', { ...image, backend: 'appleVirtualization' });
    assert.equal(control.backend, 'appleVirtualization');
    throw new ExpectedGap('The API refused only the libvirt catalogue request (HTTP 400 invalid_request). The libvirt lease path lacks a production OwnedNativeConnection, supervisor and owned storage adapter.');
  });
  await step('libvirt AUTODESTROY on connection loss', () => {
    throw new ExpectedGap('Administrative start uses one-shot virsh start. PAUSED|AUTODESTROY is available only to the lease supervisor, whose OwnedNativeConnection has no production adapter.');
  });
  await step('verified administrative libvirt deletion', () => {
    throw new ExpectedGap('Verified removal requires the unavailable native connection, file lease and protected removal adapters. The administrative lifecycle retains the definition, owned disk and disk reservation.');
  });
}

async function exerciseVm() {
  const storage = '/var/lib/libvirt/images/canaveral';
  const template = {
    id: 'cluster-cirros', revision: '0.6.3', os: 'linux', arch: 'amd64', mode: 'headless',
    image: storage + '/cirros.qcow2', network: 'default',
    minimum: { cpu: 1, memoryMiB: 512, diskGiB: 1 },
  };
  const enrollment = await step('enroll the VM overlay and verify the mounted socket', async () => {
    // Configure the host exactly as docs/cluster-hosts.md "Host libvirt setup" instructs.
    const prepared = command('sudo', ['bash', 'script/provision_cluster_node.sh', 'libvirt-host'], { timeout: 120_000, reveal: true });
    const auth = /^libvirt host ready: QEMU account libvirt-qemu in canaveral-vm \(GID 10002\); socket group canaveral-libvirt \(GID 10003\); auth_unix_rw (polkit|none);/.exec(prepared)?.[1];
    assert(auth, prepared);
    assert.equal(sudo('stat', '-c', '%U:%G:%a', '/run/libvirt/libvirt-sock'), 'root:canaveral-libvirt:660');
    assert.equal(sudo('stat', '-c', '%U:%G:%a', storage), 'canaverald:canaveral-vm:2750');
    assert.doesNotMatch(sudo('cat', '/etc/libvirt/qemu.conf'), /^\s*(user|group|dynamic_ownership)\s*=/m);
    // dpkg lists modified conffiles; both libvirt configurations stay as packaged.
    const owners = command('dpkg-query', ['-S', '/etc/libvirt/libvirtd.conf', '/etc/libvirt/qemu.conf'])
      .split('\n').map(line => line.split(':')[0]);
    let modified;
    // Root can read the private conffiles; an unreadable file would print '?' fields.
    try { modified = execFileSync('sudo', ['dpkg', '--verify', ...new Set(owners)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { modified = String(error.stdout ?? ''); }
    assert.doesNotMatch(modified, /\/etc\/libvirt\/(libvirtd|qemu)\.conf/, modified);
    assert(command('id', ['-nG', 'libvirt-qemu']).split(' ').includes('canaveral-vm'));
    assert.equal(command('id', ['-nG', 'canaverald']), 'canaverald');
    assert.notEqual(sudo('stat', '-c', '%g', '/dev/kvm'), '10001');
    // A second run changes nothing and keeps every check.
    command('sudo', ['bash', 'script/provision_cluster_node.sh', 'libvirt-host'], { timeout: 120_000, reveal: true });
    if (!virsh('net-list', '--name').split('\n').includes('default')) virsh('net-start', 'default');

    // The CPU uninstall already verified state retention. Keep that state
    // aside on this one-node runner so the VM profile gets its own identity.
    sudo('mv', '-T', state, state + '-cpu-acceptance');
    sudo('install', '-m', '0640', '-o', '10001', '-g', 'canaveral-vm', work + '/guest.qcow2', template.image);
    kubectl('apply', '-f', 'deploy/kubernetes/canaverald/base/namespace.json');
    daemon('create', 'configmap', 'canaveral-controller-ca', '--from-file=ca.crt=' + work + '/ca.crt');
    const overlay = JSON.parse(kubectl('apply', '-k', 'deploy/kubernetes/canaverald/vm', '--dry-run=client', '-o', 'json'));
    const config = overlay.items.find(item => item.kind === 'ConfigMap');
    const vm = JSON.parse(config.data['host.json']);
    vm.templates = [template];
    config.data['host.json'] = JSON.stringify(vm);
    const pod = overlay.items.find(item => item.kind === 'DaemonSet').spec.template.spec;
    assert.deepEqual(pod.securityContext.supplementalGroups, [10003]);
    assert(!pod.volumes.some(volume => volume.hostPath?.path === '/dev/kvm'));
    // Exercise the documented replacement of an unclaimed token before the first claim.
    const setup = async () => {
      const id = randomUUID();
      return { id, token: (await call('/v1/connection-setups', { id, name: vm.name, provider: vm.provider, capacity: vm.capacity })).enrollmentToken };
    };
    const provisioning = mode => ['bash', 'script/provision_cluster_node.sh', mode];
    const first = await setup(), { id, token } = await setup();
    command('sudo', provisioning('token'), { input: first.token + '\n', reveal: true });
    assert.match(refusal('sudo', provisioning('token'), token + '\n'), /already provisioned.*Use replace-token/);
    assert.match(refusal('sudo', provisioning('replace-token'), 'not-a-token\n'), /setup token on stdin is malformed/);
    await call('/v1/connection-setups/' + first.id + '/revoke', {});
    command('sudo', provisioning('replace-token'), { input: token + '\n', reveal: true });
    assert.equal(sudo('stat', '-c', '%u:%g:%a:%h', state + '/bootstrap/enrollment-token'), '10001:10001:600:1');
    kubectl('label', '--overwrite', node, 'canaveral.dev/host-profile=vm');
    command('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(overlay) });
    await waitForDaemon();
    const claim = (await call('/v1/connection-setups')).setups.find(row => row.id === id);
    assert.equal(claim.state, 'connected');
    assert.notEqual(claim.hostId, cpuRetained.hostId);
    let candidate;
    const view = await eventually('placement-ready libvirt offer with the CirrOS template', async () => {
      candidate = (await call('/v1/hosts')).hosts.find(row => row.id === claim.hostId);
      return candidate?.placementReady && candidate.provider === 'libvirt' &&
        candidate.templates.some(image => image.id === template.id && image.revision === template.revision) && candidate;
    }).catch(error => {
      const health = candidate?.health;
      const summary = { online: candidate?.online, enabled: candidate?.enabled, health: health?.status,
        checks: health?.checks?.map(check => ({ id: check.id, status: check.status })),
        available: candidate?.available };
      throw new Error(error.message + ': ' + JSON.stringify(summary));
    });
    inPod('test', '!', '-e', '/dev/kvm');
    inPod('test', '-w', storage);
    assert.match(refusal('sudo', provisioning('replace-token'), token + '\n'), /canaverald process is running/);
    const status = JSON.parse(inPod('canaverald', 'runtimes', 'status', '--config', '/etc/canaverald/host.json', '--state', state, '--json'));
    const libvirt = status.find(row => row.id === 'libvirt');
    assert.equal(libvirt?.state, 'verified', JSON.stringify(libvirt));
    assert.equal(libvirt.qualified, false);
    return { hostId: view.id, libvirt: libvirt.version, qualified: libvirt.qualified, kvmProbe: 'domcapabilities over the mounted socket', socketAuth: auth,
      socket: 'root:canaveral-libvirt:660', storage: 'canaverald:canaveral-vm:2750', replacedUnclaimedToken: true };
  });
  if (!enrollment) return;

  const machineId = randomUUID();
  const route = '/v1/machines/' + machineId;
  const disk = storage + '/' + machineId + '/disk.qcow2';
  const started = await step('boot the pinned guest through the administrative API', async () => {
    await call('/v1/machines', {
      id: machineId, name: 'disposable CirrOS guest', hostId: enrollment.hostId,
      templateId: template.id, templateRevision: template.revision, arch: template.arch, resources: template.minimum,
    });
    let machine;
    await eventually('controller-observed running state', async () => {
      machine = await call(route);
      return machine.observed === 'running' && machine.ready;
    }).catch(error => {
      // Host-side state only: modes, libvirt state and the domain's QEMU log tail.
      const native = virsh('list', '--all', '--uuid').split('\n').includes(machineId);
      const tail = (bin, args) => { try { return command(bin, args).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(-600); } catch (failure) { return failure.message; } };
      const context = JSON.stringify({
        observed: machine?.observed,
        detail: String(machine?.detail ?? '').replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]').slice(0, 300),
        nativeState: native ? virsh('domstate', machineId) : 'undefined',
        modes: tail('sudo', ['stat', '-c', '%n %U:%G %a', storage, storage + '/' + machineId, disk, template.image]),
        qemuLog: tail('sudo', ['tail', '-n', '8', '/var/log/libvirt/qemu/cvm-' + machineId + '.log']),
        libvirtd: tail('sudo', ['journalctl', '-u', 'libvirtd', '--no-pager', '-n', '8', '-o', 'cat']),
      });
      throw new Error(error.message + ': ' + context);
    });
    assert.equal(virsh('domstate', machineId), 'running');
    const ip = await eventually('guest DHCP and SSH service', async () => {
      const address = virsh('domifaddr', machineId, '--source', 'lease')
        .match(/\b(192\.168\.122\.\d{1,3})\/\d+\b/)?.[1];
      return address && await sshBanner(address) && address;
    }, 125);
    const domainId = virsh('domid', machineId);
    assert.match(domainId, /^\d+$/);
    return { machineId, domainId, guestBoot: 'SSH banner on private libvirt network', guestIp: ip };
  });
  if (!started) {
    report.steps.push(...[
      'replace the pod during an administrative VM run',
      'stop the administrative VM and retain its owned disk',
      'drain and uninstall the VM DaemonSet with retained state',
    ].map(name => ({ name, outcome: 'not_run', reason: 'Requires a running administrative VM.' })));
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n');
    return;
  }

  await step('replace the pod during an administrative VM run', async () => {
    const [old] = daemonPods();
    daemon('delete', 'pod', old.metadata.name, '--timeout=150s');
    const deletedAt = Date.now() / 1000;
    await waitForDaemon(old.metadata.uid);
    await eventually('same VM host identity with a fresh heartbeat', async () => {
      const { hosts } = await call('/v1/hosts');
      assert.equal(hosts.filter(row => row.provider === 'libvirt').length, 1);
      return hosts.some(row => row.id === enrollment.hostId && row.online && row.lastSeen > deletedAt);
    });
    const machine = await eventually('fresh machine report from the replacement daemon', async () => {
      const view = await call(route);
      return view.updatedAt > deletedAt && view.observed === 'running' && view;
    });
    assert.equal(machine.hostId, enrollment.hostId);
    assert.equal(machine.observed, 'running');
    assert.equal(virsh('domid', machineId), started.domainId);
    assert.deepEqual(virsh('list', '--all', '--uuid').split('\n'), [machineId]);
    return { hostId: machine.hostId, machineId, domainId: started.domainId, duplicateDomains: 0 };
  });

  const stopped = await step('stop the administrative VM and retain its owned disk', async () => {
    const before = sudo('stat', '-c', '%d:%i', disk);
    await call(route + '/desired', { state: 'stopped' });
    await eventually('controller-observed VM stop', async () => (await call(route)).observed === 'stopped');
    assert.equal(virsh('domstate', machineId), 'shut off');
    assert.equal(sudo('stat', '-c', '%d:%i', disk), before);
    const usage = await call('/v1/hosts/' + enrollment.hostId + '/resources');
    assert(usage.reserved.diskGiB >= template.minimum.diskGiB);
    return { machineId, disk: 'retained', reservedDiskGiB: usage.reserved.diskGiB };
  });
  if (stopped) await step('drain and uninstall the VM DaemonSet with retained state', async () => {
    const maintenance = '/v1/hosts/' + enrollment.hostId + '/maintenance';
    await call(maintenance, { id: randomUUID(), reason: 'disposable VM node teardown' });
    await eventually('safe-to-power-off proof for VM host', async () => (await call(maintenance)).safeToPowerOff);
    kubectl('delete', '-k', 'deploy/kubernetes/canaverald/vm', '--timeout=150s');
    assert.equal(sudo('jq', '-r', '.id', state + '/identity.json'), enrollment.hostId);
    assert.equal(sudo('jq', '-r', '.id', state + '-cpu-acceptance/identity.json'), cpuRetained.hostId);
    sudo('test', '-f', disk);
    return { vmState: 'retained', cpuState: 'retained' };
  });
}

function sshBanner(hostname) {
  return new Promise(resolve => {
    const socket = createConnection({ host: hostname, port: 22 });
    socket.setTimeout(1200);
    socket.once('data', bytes => { resolve(bytes.toString().startsWith('SSH-2.0-')); socket.destroy(); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('close', () => resolve(false));
  });
}
