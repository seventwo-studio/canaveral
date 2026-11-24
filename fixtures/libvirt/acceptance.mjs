// Native acceptance of consumer libvirt VM leases on a disposable GitHub-hosted ubuntu-24.04
// x64 runner: host libvirtd with KVM, canaverald as a systemd service, the pinned Rust lease
// helper and a digest-pinned CirrOS guest. Usage: acceptance.mjs HELPER EVIDENCE.json
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startController } from '../../coordination/dist/src/main.js';

const [helperBuild, output] = process.argv.slice(2);
assert.ok(helperBuild && output, 'Use acceptance.mjs HELPER EVIDENCE.json');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'native acceptance runs only on a disposable hosted runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');

const repo = fileURLToPath(new URL('../../', import.meta.url));
const guest = JSON.parse(readFileSync(new URL('./guest-image.json', import.meta.url), 'utf8'));
const evidencePath = resolve(output);
const evidence = {
  commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
  image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  kernel: release(), arch: process.arch, node: process.version, backend: 'libvirt', deployment: 'bare-metal systemd',
  guest: { name: guest.name, sha256: guest.sha256 }, steps: [],
};
const save = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644 });
async function step(name, work) {
  const start = performance.now(), record = { name, outcome: 'failed' };
  evidence.steps.push(record);
  try {
    const result = await work(record);
    record.outcome = 'passed';
    return result;
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 2000);
    throw error;
  } finally {
    record.milliseconds = Math.round(performance.now() - start);
    save();
    console.log(`${name}: ${record.outcome}${record.error ? ` (${record.error})` : ''}`);
  }
}

const failures = [];
/** A lease scenario records its outcome and lets later scenarios run; the run fails at the end. */
async function scenario(name, work) {
  try { await step(name, work); }
  catch {
    failures.push(name);
    // Best effort: leave libvirtd running, the daemon active and the reservation released.
    try { attempt("sudo", ["-n", "pkill", "-CONT", "-x", "libvirtd"]); } catch { /* none */ }
    try { if (attempt("systemctl", ["is-active", unit]).stdout !== "active") await startDaemon(); } catch { /* reported below */ }
    try { await until("a released reservation after a failed scenario", reservedFree, 300, 2000); } catch { /* reported below */ }
  }
}
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const sudo = (...args) => run('sudo', ['-n', ...args]);
const attempt = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
};
const virsh = (...args) => sudo('virsh', '--connect', 'qemu:///system', ...args);
const virshTry = (...args) => attempt('sudo', ['-n', 'virsh', '--connect', 'qemu:///system', ...args]);
async function until(description, check, seconds = 120, interval = 1000) {
  const end = performance.now() + seconds * 1000;
  let last;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(interval);
  } while (performance.now() < end);
  throw new Error(`Timed out after ${seconds}s waiting for ${description}${last ? `: ${last.message}` : ''}`);
}

const account = 'canaverald';
const storage = '/var/lib/libvirt/images/canaveral';
const install = '/srv/canaveral-vm-acceptance';
const stateRoot = '/var/lib/canaverald-vm-acceptance';
const state = `${stateRoot}/agent`;
const helper = '/usr/local/lib/canaveral/canaveral-libvirt-native';
const unit = 'canaverald.service';
const template = { id: 'lease-cirros', revision: '1', os: 'linux', arch: 'amd64', mode: 'headless', firmware: 'bios', image: `${storage}/cirros.qcow2`, network: 'default', minimum: { cpu: 1, memoryMiB: 256, diskGiB: 1 } };
const work = realpathSync(mkdtempSync(join(tmpdir(), 'vm-acceptance-')));
let controller, url, admin, app;

function pids(pattern) {
  const found = attempt('pgrep', ['-f', pattern]);
  return found.status === 0 ? found.stdout.split('\n').map(Number).filter(n => n > 1) : [];
}
const alive = pid => existsSync(`/proc/${pid}`);
const folder = machineId => `${state}/machines/${machineId}`;
const guardianPid = machineId => pids(`canaveral-libvirt-native guard ${folder(machineId)} `)[0];
const qemuPid = machineId => pids(`qemu-system-x86_64.*-uuid ${machineId}`)[0];
const receipt = machineId => JSON.parse(sudo('cat', `${folder(machineId)}/libvirt-native-execution.json`));
/** The guardian receipt once it records positive stop proof, before cleanup erases the assignment folder. */
const stoppedReceipt = machineId => until('a stopped guardian receipt', () => {
  if (attempt('sudo', ['-n', 'test', '-e', folder(machineId)]).status !== 0) return { phase: 'erased-before-read' };
  const r = receipt(machineId); return r.phase === 'stopped' && r;
}, 180, 200);
/** Seconds until the deadline the daemon published, on the guardian's CLOCK_BOOTTIME. */
const remaining = machineId => Number(JSON.parse(sudo('cat', `${folder(machineId)}/libvirt-authorization.json`)).deadline) - Number(readFileSync('/proc/uptime', 'ascii').split(' ')[0]);
function domainGone(machineId) {
  // dominfo resolves a UUID argument (domuuid resolves only names and IDs).
  const result = virshTry('dominfo', machineId);
  return result.status !== 0 && /failed to get domain|Domain not found/i.test(result.stderr);
}
const storageGone = machineId => attempt('sudo', ['-n', 'test', '-e', `${storage}/${machineId}`]).status !== 0 &&
  !sudo('ls', '-A', storage).split('\n').some(name => name.startsWith(`.removing-${machineId}-`));

async function api(method, route, body, token = admin) {
  const response = await fetch(url + route, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function call(method, route, body, token) {
  const result = await api(method, route, body, token);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${route}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
async function host() { const { hosts } = await call('GET', '/v1/hosts'); assert.equal(hosts.length, 1); return hosts[0]; }
const reservedFree = async () => { const reserved = (await host()).reserved; return reserved.cpu === 0 && reserved.memoryMiB === 0 && reserved.diskGiB === 0 && reserved; };

/** Requests a lease and waits for the booted, observed-running VM. */
async function acquire(ttlSeconds) {
  const id = randomUUID();
  const intent = { templateId: template.id, templateRevision: template.revision, arch: template.arch, ttlSeconds };
  assert.equal((await api('POST', '/v1/requests', { id, kind: 'lease', intent }, app)).status, 201);
  await until('lease admission', async () => (await call('GET', `/v1/requests/${id}`, undefined, app)).state === 'admitted', 120);
  const lease = await until('a ready libvirt lease', async () => {
    const view = await call('GET', `/v1/leases/${id}`, undefined, app);
    if (['failed', 'expired', 'released'].includes(view.state)) throw new Error(`lease ended as ${view.state}`);
    return view.state === 'ready' && view;
  }, 300);
  const machineId = lease.members[0].machineId;
  assert.match(machineId, /^[0-9a-f-]{36}$/);
  return { id, machineId, readyAt: Date.now() / 1000 };
}
/** Boot evidence: the transient domain runs as the QEMU account and the guest took a DHCP lease. */
async function booted(lease, record) {
  const info = virsh('dominfo', lease.machineId);
  assert.match(info, /^State:\s+running$/m);
  assert.match(info, /^Persistent:\s+no$/m, 'lease domains are transient');
  assert.match(info, /^Autostart:\s+disable$/m);
  const qemu = qemuPid(lease.machineId);
  assert.ok(qemu, 'QEMU process');
  // Numeric IDs: ps truncates long account names.
  const [user, group] = run('ps', ['-o', 'euid=,egid=', '-p', String(qemu)]).split(/\s+/).map(Number);
  assert.deepEqual([user, group], [Number(run('id', ['-u', 'libvirt-qemu'])), 10002], 'QEMU keeps its own account and gains only the VM storage group');
  assert.notEqual(user, Number(run('id', ['-u', account])), 'QEMU never shares the daemon account');
  const mac = /([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i.exec(virsh('domiflist', lease.machineId))?.[1];
  assert.ok(mac, 'guest MAC');
  const address = await until('the guest DHCP lease', () => {
    const line = virsh('net-dhcp-leases', 'default').split('\n').find(l => l.toLowerCase().includes(mac.toLowerCase()));
    return line && /(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(line)?.[1];
  }, 180, 2000);
  const disk = sudo('stat', '-c', '%U:%G:%a', `${storage}/${lease.machineId}/disk.qcow2`);
  const directory = sudo('stat', '-c', '%U:%G:%a', `${storage}/${lease.machineId}`);
  assert.equal(disk, `${account}:canaveral-vm:660`);
  assert.equal(directory, `${account}:canaveral-vm:2750`);
  const dac = /<seclabel type='static' model='dac' relabel='no'>\s*<label>([^<]+)<\/label>/.exec(virsh('dumpxml', lease.machineId))?.[1];
  assert.equal(dac, 'libvirt-qemu:canaveral-vm');
  const guardian = guardianPid(lease.machineId);
  assert.ok(guardian, 'lease guardian');
  const native = receipt(lease.machineId);
  assert.equal(native.phase, 'running');
  Object.assign(record, { machineId: lease.machineId, guestAddress: address, qemu: { pid: qemu, user, group }, storage: { directory, disk }, dacLabel: dac, guardianPid: guardian, domainId: native.domain?.id ?? null, qemuBirthRecorded: !!native.domain?.birth });
  return { qemu, guardian };
}
/** End proof: no domain on a fresh lookup, QEMU gone, overlay removed and the reservation released. */
async function cleaned(lease, record, seconds = 240) {
  await until('domain destruction', () => domainGone(lease.machineId), seconds);
  await until('removed lease storage', () => storageGone(lease.machineId), seconds, 2000);
  await until('a released reservation', reservedFree, seconds, 2000);
  assert.equal(qemuPid(lease.machineId), undefined, 'no QEMU process for the lease UUID');
  const start = virshTry('start', `cvm-${lease.machineId}`);
  assert.notEqual(start.status, 0, 'a transient lease domain cannot be started again');
  record.restartRefused = start.stderr.split('\n')[0] ?? '';
  record.cleanedAt = Date.now() / 1000;
}

function renderUnit(node, entry, config, enroll) {
  let definition = readFileSync(join(repo, 'deploy/systemd/canaverald.service'), 'utf8');
  for (const [from, to] of Object.entries({
    '/usr/bin/node': node, '/opt/canaveral/coordination/dist/src/canaverald.js': entry, '/opt/canaveral': install,
    '/etc/canaveral/host.json': config, '/var/lib/canaveral/agent': state, 'https://canaveral.example.internal': url,
    '/etc/canaveral/enrollment.token': `${stateRoot}/enrollment.token`,
  })) {
    assert.ok(definition.includes(from), `unit placeholder ${from}`);
    definition = definition.replaceAll(from, to);
  }
  // Acceptance disables automatic restarts so a crash cannot pass as an operator restart.
  return definition.replace('Type=simple\n', `Type=simple\nUser=${account}\nSupplementaryGroups=libvirt\nEnvironment="NODE_OPTIONS=" "NODE_PATH="\n`)
    .replace(/\nRestart=.*\nRestartSec=.*\n/, '\nRestart=no\n')
    .replace(enroll ? /^$/ : /\nEnvironment=CANAVERAL_ENROLLMENT_TOKEN_FILE=.*\n/, '\n');
}
const ctl = (...args) => sudo('systemctl', ...args);
const mainPid = () => Number(/^MainPID=(\d+)$/m.exec(ctl('show', unit, '--property=MainPID'))?.[1] ?? 0);
async function startDaemon() {
  try { ctl('reset-failed', unit); } catch { /* not failed */ }
  ctl('start', unit);
  await until('a daemon main PID', () => mainPid() > 0, 30);
  const after = Date.now() / 1000;
  await until('fresh host heartbeats', async () => { const h = await host(); return h.online && h.lastSeen > after && h; }, 120);
}

try {
  await step('host preconditions: KVM, kernel peer pidfds and libvirt', async record => {
    const [major, minor] = release().split('.').map(Number);
    assert.ok(major > 6 || major === 6 && minor >= 5, `kernel ${release()} lacks SO_PEERPIDFD`);
    assert.ok(existsSync('/dev/kvm'), '/dev/kvm');
    virsh('domcapabilities', '--virttype', 'kvm');
    record.libvirt = run('virsh', ['--version']);
    record.qemu = run('qemu-system-x86_64', ['--version']).split('\n')[0];
  });

  const helperSha256 = await step('install the pinned lease helper root-owned', async record => {
    sudo('install', '-d', '-m', '0755', '-o', 'root', '-g', 'root', '/usr/local/lib/canaveral');
    sudo('install', '-m', '0755', '-o', 'root', '-g', 'root', helperBuild, helper);
    const sha256 = createHash('sha256').update(readFileSync(helper)).digest('hex');
    Object.assign(record, { helper, sha256, mode: sudo('stat', '-c', '%U:%G:%a', helper) });
    return sha256;
  });

  await step('provision accounts, groups and VM storage', async record => {
    sudo('groupadd', '--system', '--gid', '10002', 'canaveral-vm');
    sudo('usermod', '-aG', 'canaveral-vm', 'libvirt-qemu');
    sudo('useradd', '--system', '--no-create-home', '--home-dir', stateRoot, '--shell', '/usr/sbin/nologin', '--groups', 'libvirt', account);
    sudo('install', '-d', '-m', '0700', '-o', account, '-g', account, stateRoot, state);
    sudo('install', '-d', '-m', '2750', '-o', account, '-g', 'canaveral-vm', storage);
    const net = virshTry('net-info', 'default');
    if (!/^Active:\s+yes$/m.test(net.stdout)) virsh('net-start', 'default');
    Object.assign(record, { storage: sudo('stat', '-c', '%U:%G:%a', storage), groups: run('id', ['-nG', 'libvirt-qemu']) });
    assert.ok(record.groups.split(' ').includes('canaveral-vm'));
  });

  await step('stage the digest-pinned guest template 0640 in the VM group', async record => {
    const local = join(work, 'guest.qcow2');
    for (const source of [guest.url, guest.mirror]) {
      try {
        run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '300', '--max-filesize', String(guest.bytes), '--output', local, source], { timeout: 310_000 });
        break;
      } catch (error) { record.mirrorFailure = String(error.message).slice(0, 200); }
    }
    const bytes = readFileSync(local);
    assert.equal(bytes.length, guest.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), guest.sha256);
    sudo('install', '-m', '0640', '-o', account, '-g', 'canaveral-vm', local, template.image);
    record.template = sudo('stat', '-c', '%U:%G:%a', template.image);
  });

  await step('install canaverald as a systemd service with the CAP_KILL lease drop-in', async record => {
    admin = randomBytes(32).toString('base64url');
    const enrollment = randomBytes(32).toString('base64url');
    const controllerDir = join(work, 'controller');
    mkdirSync(controllerDir, { mode: 0o700 });
    writeFileSync(join(controllerDir, 'admin'), admin, { mode: 0o600 });
    writeFileSync(join(controllerDir, 'enroll'), enrollment, { mode: 0o600 });
    controller = await startController({ statePath: join(controllerDir, 'controller.sqlite'), adminTokenFile: join(controllerDir, 'admin'), enrollmentTokenFile: join(controllerDir, 'enroll'), controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
    url = `http://127.0.0.1:${controller.address.port}`;
    const config = {
      name: 'vm-acceptance', provider: 'libvirt', uri: 'qemu:///system', storage, capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 },
      templates: [template], leaseProtocol: 1, leaseImages: [{ id: template.id, revision: template.revision, arch: template.arch, runtime: 'libvirt' }],
      leaseHelper: helper, leaseHelperSha256: helperSha256, leaseClockHelper: helper, vmGroupId: 10002, pollIntervalSeconds: 0.5,
    };
    const staged = (name, value) => { const path = join(work, name); writeFileSync(path, value, { mode: 0o600 }); return path; };
    sudo('install', '-m', '0600', '-o', account, '-g', account, staged('host.json', JSON.stringify(config)), `${stateRoot}/host.json`);
    sudo('install', '-m', '0600', '-o', account, '-g', account, staged('enrollment.token', enrollment), `${stateRoot}/enrollment.token`);
    sudo('install', '-d', '-m', '0755', '-o', 'root', '-g', 'root', install, `${install}/coordination`);
    sudo('cp', '-r', join(repo, 'coordination/dist'), join(repo, 'coordination/node_modules'), join(repo, 'coordination/package.json'), `${install}/coordination/`);
    sudo('install', '-m', '0755', '-o', 'root', '-g', 'root', process.execPath, `${install}/node`);
    sudo('chown', '-R', 'root:root', install);
    const source = `${install}/coordination/dist/src`;
    sudo('-u', account, `${install}/node`, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { hostOffer } from '${source}/host.js';
      import { nativeExecutionClock } from '${source}/native-clock.js';
      const config = JSON.parse(readFileSync('${stateRoot}/host.json', 'utf8'));
      const wrongDigest = '0'.repeat(64);
      assert.throws(() => hostOffer({ ...config, leaseHelperSha256: wrongDigest }),
        { code: 'libvirt_lease_helper_unverified' });
      assert.throws(() => nativeExecutionClock(config.leaseClockHelper, wrongDigest), { status: 503 });
      assert.equal(hostOffer(config).leaseProtocol, 1);
      assert.ok(nativeExecutionClock(config.leaseClockHelper, config.leaseHelperSha256).now() > 0);
    `);
    record.helperPinChecked = true;
    const writeUnit = enroll => sudo('install', '-m', '0644', '-o', 'root', '-g', 'root', staged(unit, renderUnit(`${install}/node`, `${install}/coordination/dist/src/canaverald.js`, `${stateRoot}/host.json`, enroll)), `/etc/systemd/system/${unit}`);
    writeUnit(true);
    sudo('install', '-d', '-m', '0755', `/etc/systemd/system/${unit}.d`);
    sudo('install', '-m', '0644', join(repo, 'deploy/systemd/canaverald.service.d/libvirt-leases.conf'), `/etc/systemd/system/${unit}.d/libvirt-leases.conf`);
    ctl('daemon-reload');
    await startDaemon();
    const h = await host();
    // Later starts authenticate with the saved identity only.
    writeUnit(false);
    sudo('rm', '-f', `${stateRoot}/enrollment.token`);
    ctl('daemon-reload');
    const caps = /^CapAmb:\s+(\S+)$/m.exec(readFileSync(`/proc/${mainPid()}/status`, 'utf8'))?.[1];
    assert.equal(BigInt(`0x${caps}`) & (1n << 5n), 1n << 5n, 'the daemon holds ambient CAP_KILL for the libvirtd-down fence');
    const status = JSON.parse(sudo('-u', account, `${install}/node`, `${install}/coordination/dist/src/canaverald.js`, 'runtimes', 'status', '--config', `${stateRoot}/host.json`, '--state', state, '--json'));
    const libvirt = status.find(row => row.id === 'libvirt');
    assert.equal(libvirt.state, 'verified');
    assert.deepEqual(libvirt.leases, { eligible: true });
    Object.assign(record, { hostId: h.id, capAmb: caps, runtime: { state: libvirt.state, leases: libvirt.leases } });
    const created = await call('POST', '/v1/consumers', { id: randomUUID(), name: 'vm acceptance', templates: [{ id: template.id, revision: template.revision, arch: template.arch }],
      limits: { resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, activeLeases: 1, defaultTTLSeconds: 300, maxTTLSeconds: 900, maxLifetimeSeconds: 900, provisioningTimeoutSeconds: 300 } });
    app = created.credential;
  });

  await scenario('consumer lease boots, stays up across idle keepalive, releases to a destroyed domain and removed overlay', async record => {
    const lease = await acquire(900);
    await booted(lease, record);
    // Idle for longer than many 5 s keepalive intervals: no spurious connection-loss fence.
    await delay(150_000);
    assert.match(virsh('domstate', lease.machineId), /^running$/);
    assert.equal(receipt(lease.machineId).phase, 'running');
    assert.equal(receipt(lease.machineId).reason, undefined);
    assert.equal((await call('GET', `/v1/leases/${lease.id}`, undefined, app)).state, 'ready');
    const autostart = virshTry('autostart', `cvm-${lease.machineId}`);
    assert.notEqual(autostart.status, 0, 'transient domains cannot autostart');
    record.autostartRefused = autostart.stderr.split('\n')[0] ?? '';
    record.idleSeconds = 150;
    // Observe the real lease UUID through an isolated crash-recovery journal that has no create
    // reply or instance identity. Its probe may neither destroy the guest nor prove absence.
    const incomplete = sudo('mktemp', '-d', `${stateRoot}/incomplete-create.XXXXXX`);
    try {
      sudo('chown', `${account}:${account}`, incomplete);
      const spec = `${folder(lease.machineId)}/libvirt-native-spec.json`;
      sudo('install', '-m', '0600', '-o', account, '-g', account, spec, incomplete);
      const identity = receipt(lease.machineId).identity;
      const pending = join(work, 'incomplete-execution.json');
      writeFileSync(pending, JSON.stringify({ identity, phase: 'creating' }), { mode: 0o600 });
      sudo('install', '-m', '0600', '-o', account, '-g', account, pending, `${incomplete}/libvirt-native-execution.json`);
      assert.equal(attempt('sudo', ['-n', '-u', account, helper, 'probe', incomplete, 'destroy']).status, 1);
      assert.match(virsh('domstate', lease.machineId), /^running$/);
      record.incompleteOwnershipRefused = true;
      await call('POST', `/v1/leases/${lease.id}/release`, { id: randomUUID() }, app);
      await until('absence of the released VM', () => domainGone(lease.machineId), 120);
      assert.equal(attempt('sudo', ['-n', '-u', account, helper, 'probe', incomplete, 'observe']).status, 1);
      record.uncertainCreateAbsenceRefused = true;
    } finally { sudo('rm', '-rf', incomplete); }
    const native = await stoppedReceipt(lease.machineId);
    record.reason = native.reason;
    await cleaned(lease, record);
  });

  await scenario('expiry destroys the domain at its deadline and removes the overlay', async record => {
    const lease = await acquire(120);
    await booted(lease, record);
    record.secondsToDeadline = remaining(lease.machineId);
    const deadline = Date.now() / 1000 + record.secondsToDeadline;
    await until('domain destruction after expiry', () => domainGone(lease.machineId), 240, 250);
    record.overrunSeconds = Date.now() / 1000 - deadline;
    assert.ok(record.overrunSeconds >= 0 && record.overrunSeconds < 30, `destroyed ${record.overrunSeconds}s after the deadline`);
    const native = await stoppedReceipt(lease.machineId);
    record.reason = native.reason;
    await cleaned(lease, record);
  });

  await scenario('SIGKILL of the daemon fences the lease through the guardian while the daemon is down', async record => {
    const lease = await acquire(900);
    const { qemu, guardian } = await booted(lease, record);
    ctl('kill', '--kill-whom=main', '--signal=SIGKILL', unit);
    await until('the guardian fence after daemon death', () => domainGone(lease.machineId) && !alive(qemu), 60);
    await until('the guardian exit', () => !alive(guardian), 60);
    assert.equal(mainPid(), 0, 'the daemon stayed down during the fence');
    const native = receipt(lease.machineId);
    Object.assign(record, { reason: native.reason, phase: native.phase });
    assert.deepEqual([native.reason, native.phase], ['daemon-exited', 'stopped']);
    await startDaemon();
    await cleaned(lease, record);
  });

  await scenario('a guardian killed mid-fence is completed by the reconciler under its lock', async record => {
    const lease = await acquire(900);
    const { qemu, guardian } = await booted(lease, record);
    const libvirtd = Number(run('pidof', ['libvirtd']).split(' ')[0]);
    sudo('kill', '-STOP', String(libvirtd));
    try {
      await call('POST', `/v1/leases/${lease.id}/release`, { id: randomUUID() }, app);
      // The guardian takes the published fence; its destroy probe waits on the stopped libvirtd.
      const released = Date.now();
      await until('a fencing guardian', () => receipt(lease.machineId).reason === 'fenced', 120, 250);
      record.fenceSeconds = (Date.now() - released) / 1000;
      assert.notEqual(receipt(lease.machineId).phase, 'stopped');
      sudo('kill', '-KILL', String(guardian));
      record.killedDuring = receipt(lease.machineId);
    } finally { sudo('kill', '-CONT', String(libvirtd)); }
    const native = await stoppedReceipt(lease.machineId);
    record.final = { phase: native.phase, reason: native.reason };
    await cleaned(lease, record);
    record.qemuGone = !alive(qemu);
  });

  await scenario('a libvirtd restart mid-lease is a connection-loss fence', async record => {
    const lease = await acquire(900);
    const { qemu } = await booted(lease, record);
    ctl('restart', 'libvirtd.service');
    await until('domain destruction after connection loss', () => domainGone(lease.machineId) && !alive(qemu), 120);
    const native = await stoppedReceipt(lease.machineId);
    Object.assign(record, { reason: native.reason, phase: native.phase });
    assert.equal(record.reason, 'connection-ended');
    await cleaned(lease, record);
  });

  await scenario('the deadline passes while libvirtd is stopped: CAP_KILL stops QEMU through a pidfd', async record => {
    const lease = await acquire(150);
    const { qemu } = await booted(lease, record);
    const libvirtd = Number(run('pidof', ['libvirtd']).split(' ')[0]);
    // Freeze libvirtd shortly before the deadline. Its keepalive needs about 15 s to declare the
    // connection dead, so the guardian's own deadline ends the lease while libvirt cannot act.
    const deadline = Date.now() / 1000 + remaining(lease.machineId);
    await delay(Math.max(0, deadline - Date.now() / 1000 - 5) * 1000);
    sudo('kill', '-STOP', String(libvirtd));
    try {
      await until('QEMU killed by the guardian while libvirtd is stopped', () => !alive(qemu), 90, 500);
      const native = await until('the receipt of the pidfd kill', () => { const r = receipt(lease.machineId); return /^qemu-killed/.test(r.fence ?? '') && r; }, 20, 200);
      Object.assign(record, { reason: native.reason, fence: native.fence ?? null, secondsAfterDeadline: Date.now() / 1000 - deadline });
      assert.ok(['deadline', 'fenced'].includes(native.reason), native.reason);
      assert.match(native.fence ?? '', /^qemu-killed/);
      assert.notEqual(native.phase, 'stopped', 'stop needs a fresh libvirt lookup');
    } finally { sudo('kill', '-CONT', String(libvirtd)); }
    record.final = (await stoppedReceipt(lease.machineId)).phase;
    await cleaned(lease, record);
  });

  await scenario('OOM kill of the guardian is fenced by the reconciler', async record => {
    const lease = await acquire(900);
    const { guardian } = await booted(lease, record);
    // Memory pressure inside the service's own cgroup makes the kernel OOM killer choose. The
    // guardian is the preferred victim; the allocator and daemon are excluded from selection.
    const cgroup = '/sys/fs/cgroup' + readFileSync(`/proc/${guardian}/cgroup`, 'utf8').trim().split('::')[1];
    sudo('choom', '-p', String(guardian), '-n', '1000');
    // Keep the daemon out of the OOM cascade so the guardian path is what this step measures.
    sudo('choom', '-p', String(mainPid()), '-n', '-1000');
    record.scores = Object.fromEntries([['guardian', guardian], ['daemon', mainPid()]].map(([name, pid]) => [name, { adj: readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim(), score: readFileSync(`/proc/${pid}/oom_score`, 'utf8').trim() }]));
    const priorOom = new Set(sudo('dmesg').split('\n'));
    const limit = Number(sudo('cat', `${cgroup}/memory.current`)) + 128 * 1048576;
    sudo('sh', '-c', `echo ${limit} > ${cgroup}/memory.max`);
    const marker = `canaveral-oom-hog-${lease.machineId}`;
    let hog;
    try {
      // A stopped guardian is still eligible for the kernel OOM kill, and cannot self-fence
      // when pressure makes its reads fail. Its worker remains tied to guardian death.
      sudo('kill', '-STOP', String(guardian));
      // The hosted runner may give the allocator a positive inherited oom_score_adj. Exclude
      // it explicitly so its growing RSS cannot make it a more likely victim than the guardian.
      hog = spawn('sudo', ['-n', 'sh', '-c', `echo -1000 > /proc/$$/oom_score_adj && echo $$ > ${cgroup}/cgroup.procs && exec ${process.execPath} -e "const a=[];setInterval(()=>a.push(Buffer.alloc(8<<20,1)),10)" ${marker}`], { stdio: 'ignore' });
      await until('the end of the guardian under memory pressure', () => !alive(guardian), 90, 250);
    } finally {
      attempt('sudo', ['-n', 'pkill', '-KILL', '-f', marker]);
      hog?.kill('SIGKILL');
      attempt('sudo', ['-n', 'sh', '-c', `echo max > ${cgroup}/memory.max`]);
      if (alive(guardian)) attempt('sudo', ['-n', 'kill', '-CONT', String(guardian)]);
    }
    const oomLines = sudo('dmesg').split('\n').filter(line => !priorOom.has(line) && /oom-kill:|Killed process/.test(line));
    record.oomLines = oomLines.slice(-6);
    const kernel = oomLines.find(line => line.includes(`Killed process ${guardian} (`));
    record.kernel = kernel ?? null;
    record.guardianEnd = kernel ? 'kernel-oom-kill' : 'unconfirmed';
    record.oomKill = Number(/^oom_kill (\d+)$/m.exec(attempt('sudo', ['-n', 'cat', `${cgroup}/memory.events`]).stdout)?.[1] ?? 0) || null;
    // systemd's default OOMPolicy=stop may stop the whole unit; every lease then fences on daemon exit.
    record.unitAfterOom = attempt('systemctl', ['is-active', unit]).stdout;
    if (record.unitAfterOom !== 'active') await startDaemon();
    const native = await stoppedReceipt(lease.machineId);
    record.reason = native.reason ?? 'guardian-ended';
    if (!kernel && native.reason && native.reason !== 'guardian-ended') record.guardianEnd = 'self-fenced';
    await cleaned(lease, record);
    assert.ok(kernel, `guardian outcome was ${record.guardianEnd}; missing kernel evidence for PID ${guardian}`);
  });

  await scenario('CLOCK_BOOTTIME follows the time namespace of the guardian', async record => {
    const outside = Number(run(helper, ['clock']));
    const inside = attempt('sudo', ['-n', 'unshare', '--time', '--boottime', '86400', '--fork', helper, 'clock']);
    if (inside.status !== 0) { record.skipped = inside.stderr.slice(0, 200); return; }
    record.offset = Number(inside.stdout) - outside;
    assert.ok(Math.abs(record.offset - 86400) < 5, `offset ${record.offset}`);
  });
  evidence.failures = failures;
  assert.deepEqual(failures, [], `failed scenarios: ${failures.join(', ')}`);
} finally {
  try { ctl('stop', unit); } catch { /* not installed */ }
  try { evidence.journal = sudo('journalctl', '-u', unit, '--no-pager', '-n', '200', '-o', 'cat').split('\n').slice(-200); } catch { /* none */ }
  save();
  await controller?.close();
  rmSync(work, { recursive: true, force: true });
}
