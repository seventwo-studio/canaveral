// Operator-only native trial for the dashboard Linux desktop flow.
// Build coordination (npm --prefix coordination run build) and the dashboard
// assets first, then run on an Apple-silicon Mac:
//   CANAVERAL_TRIAL_DISK=/abs/desktop-arm64.qcow2 \
//   CANAVERAL_TRIAL_BUNDLE=/abs/desktop-guest-bundle-arm64.json \
//   CANAVERAL_TRIAL_RUNNER=/abs/CanaveralVMRunner \
//   node coordination/native-acceptance/dashboard-desktop.mjs
// It runs the real `canaveral local` controller, Apple host and dashboard on
// loopback with fresh private state, launches one disposable desktop through
// the dashboard, types into it through the viewer, then stops and deletes it.
// It never signals, inspects or removes VMs it did not create.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const disk = input('CANAVERAL_TRIAL_DISK'), bundle = input('CANAVERAL_TRIAL_BUNDLE'), runner = input('CANAVERAL_TRIAL_RUNNER');
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const root = await mkdtemp(join(await realpath(tmpdir()), 'dashboard-desktop-'));
const state = join(root, 'state');
console.log('Private trial state:', root);
const evidence = { started: new Date().toISOString() };
const save = () => writeFile(join(root, 'trial.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const sha = data => createHash('sha256').update(data).digest('hex');
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

let local, browser, failure;
try {
  for (const [name, path] of [['disk', disk], ['bundle', bundle], ['runner', runner]]) evidence[`${name}Sha256`] = sha(await readFile(path));
  evidence.runnerSignature = (await run('/usr/bin/codesign', ['-dv', runner]).catch(error => error)).stderr?.split('\n').filter(line => /^(Identifier|TeamIdentifier|Signed Time)=/.test(line));
  evidence.baselineVmProcesses = await vmProcesses();
  await save();

  const apiPort = 20000 + Math.floor(Math.random() * 20000), dashboardPort = apiPort + 1;
  local = spawn(process.execPath, [cli, 'local', '--state', state, '--api-port', String(apiPort), '--dashboard-port', String(dashboardPort),
    '--linux-image', disk, '--apple-runner', runner, '--guest-helper-manifest', bundle], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const owner = new CliClient(api, (await admin.request('POST', '/v1/auth/setup', { username: 'trial', password })).token, true);
  await until(async () => (await admin.request('GET', '/v1/templates')).templates.some(t => t.mode === 'desktop' && t.online && t.accepting), 'desktop image offer', 120000);
  const hostView = async () => (await admin.request('GET', '/v1/hosts')).hosts[0];
  evidence.hostReservedBefore = (await hostView()).reserved;

  const require = createRequire(new URL('../../dashboard/package.json', import.meta.url));
  browser = await require('playwright').chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => console.log('Page error:', error.message));
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
  evidence.launchForm = await dialog.getByText(/linux · Desktop/).textContent();
  await dialog.getByRole('button', { name: 'Launch desktop' }).click();
  await page.getByText(new RegExp(`${name} is starting on`)).waitFor({ timeout: 60000 });
  const machine = (await owner.request('GET', '/v1/machines')).machines.find(m => m.name === name);
  assert.ok(machine, 'launched machine is listed for its owner');
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

  // 3. Open the viewer and interact. A terminal window is opened at a known
  // position from the dashboard's own terminal so the click target is fixed.
  await row.getByRole('button', { name: 'Control', exact: true }).click();
  await page.getByRole('button', { name: 'Terminals', exact: true }).click();
  await page.getByRole('button', { name: 'New shell', exact: true }).first().click();
  await page.locator('.xterm-screen').first().click();
  await page.keyboard.type("DISPLAY=:1 setsid xfce4-terminal --disable-server --title=canaveral-trial --geometry=60x8+40+40 >/dev/null 2>&1 &\n");
  await delay(5000);
  await page.getByRole('button', { name: 'Desktop', exact: true }).click();
  const take = page.getByRole('button', { name: 'Take control', exact: true });
  await take.waitFor({ timeout: 60000 });
  await until(() => take.isEnabled(), 'viewer connection', 60000, 500);
  await page.locator('canvas').first().screenshot({ path: join(root, 'viewer-before.png') });
  await take.click();
  await page.getByText('Mouse and keyboard connected', { exact: true }).waitFor({ timeout: 30000 });
  const canvas = page.locator('canvas').first(), box = await canvas.boundingBox();
  const scale = box.width / 1440;
  await page.mouse.click(box.x + 200 * scale, box.y + 90 * scale);
  const nonce = randomUUID();
  await page.keyboard.type(`echo typed-${nonce} > /tmp/canaveral-trial.txt\n`, { delay: 30 });
  await delay(3000);
  await canvas.screenshot({ path: join(root, 'viewer-after.png') });
  await page.getByRole('button', { name: 'Release control', exact: true }).click();
  const operation = async (action, args = {}) => {
    const id = randomUUID();
    let receipt = await owner.request('POST', `/v1/machines/${machine.id}/operations`, { id, action, arguments: args });
    await until(async () => (receipt = await owner.request('GET', `/v1/operations/${id}`)).state !== 'queued', `${action} receipt`, 120000, 500);
    assert.equal(receipt.state, 'succeeded', `${action}: ${JSON.stringify(receipt.result)}`);
    return receipt.result;
  };
  const typed = Buffer.from((await operation('pull', { path: '/tmp/canaveral-trial.txt' })).data, 'base64').toString('utf8');
  assert.equal(typed, `typed-${nonce}\n`);
  const screenshot = await operation('screenshot');
  const png = Buffer.from(screenshot.data ?? screenshot.png ?? '', 'base64');
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
