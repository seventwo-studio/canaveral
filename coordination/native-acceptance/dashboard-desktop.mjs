// Operator-only native trial for the dashboard Linux desktop flow.
// Build coordination (npm --prefix coordination run build), the dashboard assets
// and the native helpers (cargo build -p canaveral-mobile-native -p
// canaveral-apple-native, then node script/prepare_native.mjs debug) first; the
// Apple provider needs apple-native-helper to prove and erase owned storage.
// Then run on an Apple-silicon Mac:
//   CANAVERAL_TRIAL_DISK=/abs/desktop-arm64.qcow2 \
//   CANAVERAL_TRIAL_BUNDLE=/abs/desktop-guest-bundle-arm64.json \
//   CANAVERAL_TRIAL_RUNNER=/abs/CanaveralVMRunner \
//   node coordination/native-acceptance/dashboard-desktop.mjs
// For a macOS desktop, set CANAVERAL_TRIAL_OS=macos and supply the operator-prepared
// image directory (docs/macos-desktop-image.md) and its restore image instead:
//   CANAVERAL_TRIAL_OS=macos CANAVERAL_TRIAL_MACOS_IMAGE=/abs/dir \
//   CANAVERAL_TRIAL_RESTORE_IMAGE=/abs/UniversalMac.ipsw CANAVERAL_TRIAL_RUNNER=/abs/CanaveralVMRunner \
//   node coordination/native-acceptance/dashboard-desktop.mjs
// It runs the real `canaveral local` controller, Apple host and dashboard on
// loopback with fresh private state, launches one disposable desktop through
// the dashboard, types into it through the viewer, then stops and deletes it.
// It never signals, inspects or removes VMs it did not create.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CliClient } from '../dist/src/account-cli.js';

const run = promisify(execFile);
const input = name => { const value = process.env[name]; assert.ok(value?.startsWith('/'), `Set ${name} to an absolute path`); return value; };
const os = process.env.CANAVERAL_TRIAL_OS ?? 'linux', mac = os === 'macos';
assert.ok(['linux', 'macos'].includes(os), 'CANAVERAL_TRIAL_OS is linux or macos');
const runner = input('CANAVERAL_TRIAL_RUNNER');
const macImage = mac ? input('CANAVERAL_TRIAL_MACOS_IMAGE') : undefined, restore = mac ? input('CANAVERAL_TRIAL_RESTORE_IMAGE') : undefined;
const disk = mac ? join(macImage, 'disk.raw') : input('CANAVERAL_TRIAL_DISK'), bundle = mac ? undefined : input('CANAVERAL_TRIAL_BUNDLE');
const inputs = mac ? [['disk', disk], ['auxiliary', join(macImage, 'auxiliary.bin')], ['hardwareModel', join(macImage, 'hardware-model.bin')], ['restoreImage', restore], ['runner', runner]]
  : [['disk', disk], ['bundle', bundle], ['runner', runner]];
// The guest file the typed command creates; /tmp is a link on macOS.
const typedDirectory = mac ? '/private/tmp' : '/tmp';
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const removalHelper = fileURLToPath(new URL('../dist/src/providers/apple-native-helper', import.meta.url));
await readFile(removalHelper).catch(() => { throw Error('Install apple-native-helper with script/prepare_native.mjs before launching a VM'); });
const root = await mkdtemp(join(await realpath(tmpdir()), 'dashboard-desktop-'));
const state = join(root, 'state');
console.log('Private trial state:', root);
const evidence = { started: new Date().toISOString() };
const save = () => writeFile(join(root, 'trial.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const sha = data => createHash('sha256').update(data).digest('hex');
async function fileSha(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function until(check, description, milliseconds = 180000, interval = 1000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(interval);
  }
  throw Error(`Timed out waiting for ${description}${last ? `: ${last.message}` : ''}`);
}
/** Virtualization XPC processes. Pre-existing ones are recorded and never touched. */
async function vmProcesses() {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,command=']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter(line => line.includes('com.apple.Virtualization.VirtualMachine')).map(line => Number(line.trim().split(/\s+/)[0])).sort((a, b) => a - b);
}

let local, browser, failure, owner, machineId;
try {
  evidence.os = os;
  for (const [name, path] of inputs) evidence[`${name}Sha256`] = await fileSha(path);
  evidence.runnerSignature = (await run('/usr/bin/codesign', ['-dv', runner]).catch(error => error)).stderr?.split('\n').filter(line => /^(Identifier|TeamIdentifier|Signed Time)=/.test(line));
  evidence.baselineVmProcesses = await vmProcesses();
  await save();

  const apiPort = 20000 + Math.floor(Math.random() * 20000), dashboardPort = apiPort + 1;
  // The host identity is bound to this controller URL; recovery must reuse it.
  evidence.apiPort = apiPort;
  local = spawn(process.execPath, [cli, 'local', '--state', state, '--api-port', String(apiPort), '--dashboard-port', String(dashboardPort),
    '--apple-runner', runner, ...(mac ? ['--macos-image', macImage, '--macos-restore-image', restore] : ['--linux-image', disk, '--guest-helper-manifest', bundle])], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  local.stdout.on('data', chunk => { output += chunk; });
  local.stderr.on('data', chunk => process.stderr.write('local: ' + chunk));
  await until(() => output.includes('"dashboard"'), 'local services', 60000, 250);
  const started = JSON.parse(output.split('\n').find(line => line.includes('"dashboard"')));
  assert.equal(started.hostConfigured, true);
  const api = `http://127.0.0.1:${apiPort}`, home = started.dashboard;
  const admin = new CliClient(api, (await readFile(join(state, 'admin.token'), 'utf8')).trim(), true);
  const password = randomBytes(24).toString('hex');
  // The dashboard account that launches the desktop; its session owns the machine.
  owner = new CliClient(api, (await admin.request('POST', '/v1/auth/setup', { username: 'trial', password })).token, true);
  await until(async () => (await admin.request('GET', '/v1/templates')).templates.some(t => t.os === os && t.mode === 'desktop' && t.guestAccess && t.online && t.accepting), 'desktop image offer', 120000);
  const hostView = async () => (await admin.request('GET', '/v1/hosts')).hosts[0];
  evidence.hostReservedBefore = (await hostView()).reserved;

  const require = createRequire(new URL('../../dashboard/package.json', import.meta.url));
  browser = await require('playwright').chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => console.log('Page error:', error.message));
  // Viewer transport evidence: control messages received and RFB input sent.
  const wire = { control: [], sent: { key: 0, pointer: 0, other: 0 } };
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/desktop')) return;
    socket.on('framereceived', ({ payload }) => { if (typeof payload === 'string') wire.control.push(payload.slice(0, 200)); });
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') { wire.control.push('sent ' + payload.slice(0, 200)); return; }
      const kind = payload[0];
      if (kind === 4) wire.sent.key++; else if (kind === 5) wire.sent.pointer++; else wire.sent.other++;
    });
  });
  evidence.viewerWire = wire;
  await page.goto(home);
  await page.getByLabel('Username').fill('trial');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Account menu' }).waitFor();

  // 1. Launch through the dashboard by choosing the desktop image.
  const name = `desktop-trial-${randomBytes(3).toString('hex')}`;
  await page.getByRole('button', { name: 'Launch desktop' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Machine name').fill(name);
  evidence.launchForm = await dialog.getByText(new RegExp(`${os} · Desktop`)).textContent();
  await dialog.getByRole('button', { name: 'Launch desktop' }).click();
  await page.getByText(new RegExp(`${name} is starting on`)).waitFor({ timeout: 60000 });
  const machine = (await owner.request('GET', '/v1/machines')).machines.find(m => m.name === name);
  assert.ok(machine, 'launched machine is listed for its owner');
  machineId = machine.id;
  Object.assign(evidence, { machineId: machine.id, launchedAt: new Date().toISOString() });
  await save();
  console.log('Launched', machine.id);

  // 2. Readiness as the dashboard shows it.
  const row = page.locator(`[data-machine-id="${machine.id}"]`);
  const states = new Set();
  await until(async () => {
    await page.getByRole('button', { name: /^Refresh/ }).first().click().catch(() => {});
    const status = (await row.locator('.status').textContent())?.trim();
    if (status && !states.has(status)) { states.add(status); console.log('Dashboard state:', status, new Date().toISOString()); }
    if (status === 'Setup failed') throw Error('Guest preparation failed');
    return status === 'Ready';
  }, 'Ready in the dashboard', 3600000, 5000);
  Object.assign(evidence, { dashboardStates: [...states], readyAt: new Date().toISOString(), hostReservedReady: (await hostView()).reserved });
  await save();

  // 3. Open the viewer and interact only through it: click the XFCE panel's
  // terminal launcher (1440x900 guest pixels), then type into the new window.
  await row.getByRole('button', { name: 'Control', exact: true }).click();
  const take = page.getByRole('button', { name: 'Take control', exact: true });
  await take.waitFor({ timeout: 60000 });
  await until(() => take.isEnabled(), 'viewer connection', 60000, 500);
  await page.locator('canvas').first().screenshot({ path: join(root, 'viewer-before.png') });
  await take.click();
  await page.getByText('Mouse and keyboard connected', { exact: true }).waitFor({ timeout: 30000 });
  const canvas = page.locator('canvas').first(), box = await canvas.boundingBox();
  if (mac) {
    // Open Terminal with Spotlight, then click inside its window to focus it.
    await page.keyboard.press('Meta+Space'); await delay(1500);
    await page.keyboard.type('Terminal', { delay: 60 }); await delay(1500);
    await page.keyboard.press('Enter'); await delay(6000);
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  } else {
    const scale = box.width / 1440;
    await canvas.click({ position: { x: 647 * scale, y: 875 * scale } });
  }
  await delay(4000);
  await canvas.screenshot({ path: join(root, 'viewer-terminal.png') });
  const operation = async (action, args = {}) => {
    const id = randomUUID();
    let receipt = await owner.request('POST', `/v1/machines/${machine.id}/operations`, { id, action, arguments: args });
    await until(async () => (receipt = await owner.request('GET', `/v1/operations/${id}`)).state !== 'queued', `${action} receipt`, 120000, 500);
    assert.equal(receipt.state, 'succeeded', `${action}: ${JSON.stringify(receipt.result)}`);
    return receipt.result;
  };
  const nonce = randomUUID();
  const typingStarted = Date.now();
  await page.keyboard.type(`echo typed-${nonce} > ${typedDirectory}/canaveral-trial.txt\n`, { delay: 30 });
  evidence.typingMs = Date.now() - typingStarted;
  // The file appears only after the final Enter reached the guest through the viewer.
  // Listing is a read that succeeds whether or not the file exists yet.
  await until(async () => (await operation('list-files', { path: typedDirectory })).entries?.some(entry => entry.name === 'canaveral-trial.txt' && entry.size > 0), 'typed file', 60000, 1000);
  evidence.typedFileVisibleMs = Date.now() - typingStarted;
  await canvas.screenshot({ path: join(root, 'viewer-after.png') });
  await page.getByRole('button', { name: 'Release control', exact: true }).click();
  let typed, png = Buffer.alloc(0);
  if (mac) {
    // The macOS helper offers listing and streamed files, not the discrete pull/screenshot
    // operations: the exact size of the typed line identifies the nonce-bearing file.
    const entry = (await operation('list-files', { path: typedDirectory })).entries.find(e => e.name === 'canaveral-trial.txt');
    assert.equal(entry.size, Buffer.byteLength(`typed-${nonce}\n`));
    typed = `typed-${nonce} (size ${entry.size})\n`;
  } else {
    typed = Buffer.from((await operation('pull', { path: '/tmp/canaveral-trial.txt' })).data, 'base64').toString('utf8');
    assert.equal(typed, `typed-${nonce}\n`);
    const screenshot = await operation('screenshot');
    png = Buffer.from(screenshot.data ?? screenshot.png ?? '', 'base64');
  }
  if (png.length) await writeFile(join(root, 'guest-after.png'), png, { mode: 0o600 });
  Object.assign(evidence, { typedFile: typed.trim(), viewerBefore: sha(await readFile(join(root, 'viewer-before.png'))), viewerAfter: sha(await readFile(join(root, 'viewer-after.png'))), guestScreenshotBytes: png.length });
  await save();
  await page.getByRole('button', { name: 'Close machine workspace' }).click();

  // 4. Stop, then delete with controller confirmation.
  await row.getByRole('button', { name: `Stop ${name}` }).click();
  await page.getByRole('button', { name: 'Request stop' }).click();
  await until(async () => {
    await page.getByRole('button', { name: /^Refresh/ }).first().click().catch(() => {});
    return (await row.locator('.status').textContent())?.trim() === 'Stopped';
  }, 'Stopped in the dashboard', 300000, 3000);
  evidence.stoppedAt = new Date().toISOString();
  await row.getByRole('button', { name: `More actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: /Delete machine/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete machine' }).click();
  await page.getByRole('dialog').getByRole('status').waitFor();
  evidence.deletionReceipt = await page.getByRole('dialog').getByRole('status').textContent();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await until(async () => {
    await page.getByRole('button', { name: /^Refresh/ }).first().click().catch(() => {});
    return page.getByText(`${name} deleted. The host confirmed removal.`).isVisible();
  }, 'dashboard deletion confirmation', 300000, 3000);
  evidence.deletedAt = new Date().toISOString();
  await assert.rejects(owner.request('GET', `/v1/machines/${machine.id}`), /Unknown machine|not found|404/i);

  // 5. Baseline: no reservation, no owned storage, only pre-existing VM processes.
  await until(async () => { const r = (await hostView()).reserved; return r.cpu === 0 && r.memoryMiB === 0 && r.diskGiB === 0; }, 'zero host reservation', 120000);
  evidence.hostReservedAfter = (await hostView()).reserved;
  const leftovers = [];
  for (const directory of ['linux-disks', 'machines']) {
    const entries = await readdir(join(state, directory)).catch(() => []);
    leftovers.push(...entries.filter(entry => entry.includes(machine.id)).map(entry => `${directory}/${entry}`));
  }
  evidence.ownedStorageAfter = leftovers;
  assert.deepEqual(leftovers, []);
  await until(async () => JSON.stringify(await vmProcesses()) === JSON.stringify(evidence.baselineVmProcesses), 'VM process baseline', 60000);
  evidence.vmProcessesAfter = await vmProcesses();
  evidence.result = 'passed';
} catch (error) {
  failure = error;
  evidence.result = 'failed';
  evidence.failure = error.message;
  console.error('Trial failed:', error.message);
} finally {
  await browser?.close().catch(() => {});
  // A failed run still removes the VM it created, through its own controller.
  if (failure && owner && machineId && local?.exitCode === null) {
    try {
      const view = async () => (await owner.request('GET', '/v1/machines')).machines.find(m => m.id === machineId);
      if ((await view())?.desired !== 'stopped') await owner.request('POST', `/v1/machines/${machineId}/desired`, { state: 'stopped' });
      await until(async () => (await view())?.observed === 'stopped', 'recovery stop', 300000, 2000);
      await owner.request('POST', `/v1/machines/${machineId}/delete`, { id: (await view()).deletion?.id ?? randomUUID() });
      await until(async () => !(await view()), 'recovery deletion', 300000, 2000);
      evidence.recovery = 'stopped and deleted after failure';
    } catch (error) { evidence.recovery = 'unconfirmed: ' + error.message; }
  }
  if (local && local.exitCode === null) {
    local.kill('SIGINT');
    await Promise.race([new Promise(resolve => local.once('exit', resolve)), delay(30000)]);
  }
  evidence.finished = new Date().toISOString();
  await save();
  console.log(JSON.stringify(evidence, null, 2));
  // Machine state is retained after a failure for inspection; a pass leaves no VM disks.
  if (!failure) await rm(join(state, 'linux-disks'), { recursive: true, force: true });
  process.exitCode = failure ? 1 : 0;
}
