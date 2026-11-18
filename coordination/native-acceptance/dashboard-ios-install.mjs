// Run after building coordination, with DEVELOPER_DIR pointing at the selected Xcode.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startController } from '../dist/src/main.js';
import { HostRunner } from '../dist/src/host.js';
import { CliClient } from '../dist/src/account-cli.js';

import { startDashboard } from '../dist/src/dashboard.js';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { dashboardIosUpload } from './dashboard-ios-upload.mjs';

const archive = process.argv[2];
const neighbor = 'c96b8f8c-9647-446a-b9aa-b8515d7275d7';
const bundle = 'test.canaveral.dashboardtrial';
const root = await mkdtemp(join(await realpath(tmpdir()), 'dashboard-ios-install-'));
console.log('Private trial state:', root);
let controller, runner, dashboard, browser;
async function until(check, description, milliseconds = 180000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw Error('Timed out waiting for ' + description);
}
try {
  const admin = randomBytes(32).toString('hex'), enrollment = randomBytes(32).toString('hex');
  const adminFile = join(root, 'admin'), enrollmentFile = join(root, 'enroll');
  await writeFile(adminFile, admin, { mode: 0o600 });
  await writeFile(enrollmentFile, enrollment, { mode: 0o600 });
  controller = await startController({ statePath: join(root, 'db'), adminTokenFile: adminFile,
    enrollmentTokenFile: enrollmentFile, controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  const url = 'http://127.0.0.1:' + controller.address.port;
  const image = { id: 'acceptance-ios', revision: '1', os: 'ios', arch: 'arm64', mode: 'device',
    minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 }, device: {
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro' } };
  runner = new HostRunner({ url, stateDir: join(root, 'runner'), storage: join(root, 'devices'),
    name: 'acceptance-ios', provider: 'ios', templates: [image], enrollmentToken: enrollment,
    capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 } });
  await runner.start();
  const runtime = runner.runtimes.get('ios');
  await runtime.check();
  const prepareOnly = process.argv[3] === '--prepare-only';
  if (!archive) {
    console.log('Preflight only. No assignment created.');
  } else {
    await readFile(archive);
    const inventory = async () => (await runtime.inventory()).map(({runtime, device}) =>
      [device.udid.toLowerCase(), runtime, device.name, device.deviceTypeIdentifier, device.state]).sort();
    const before = await inventory();
    assert.ok(before.some(([id]) => id === neighbor));
    const machineId = randomUUID(), deletionId = randomUUID(), name = 'dashboard-ios-' + machineId;
    const record = data => writeFile(join(root, 'trial.json'), JSON.stringify({
      machineId, deletionId, before, ...data }, null, 2), { mode: 0o600 });
    await record({});
    const bootstrap = new CliClient(url, admin);
    const password = randomBytes(24).toString('hex');
    const setup = await bootstrap.request('POST', '/v1/auth/setup', { username: 'admin', password });
    const manager = new CliClient(url, setup.token);
    const username = 'trial';
    const user = await manager.request('POST', '/v1/users', { id: randomUUID(), username });
    const invite = await manager.request('POST', '/v1/users/' + user.id + '/invite', {});
    const session = await new CliClient(url, '').request('POST', '/v1/auth/claim', { token: invite.token, password });
    const owner = new CliClient(url, session.token);
    dashboard = await startDashboard({ orchestratorUrl: url, listen: { host: '127.0.0.1', port: 0 } });
    const require = createRequire(new URL('../../dashboard/package.json', import.meta.url));
    browser = await require('playwright').chromium.launch();
    const page = await browser.newPage();
    const home = 'http://127.0.0.1:' + dashboard.address.port;
    await page.goto(home);
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Account menu' }).waitFor();
    if (prepareOnly) {
      console.log('Owner dashboard login verified. No assignment created.');
    } else {
      assert.equal(typeof runtime.removeOwnedStorage, 'function', 'iOS provider lacks verified removal');
      assert.equal(process.env.IOS_TRIAL_CLEANUP_VERIFIED, '1', 'Verify provider and controller cleanup before boot');
      await runner.checkEnvironment();
      await runner.poll();
      const path = '/v1/machines/' + machineId;
      const machine = await owner.request('POST', '/v1/machines', { id: machineId, name, templateId: image.id, resources: image.minimum });
      assert.equal(machine.ownerId, user.id);
      assert.equal(machine.hostId, runner.identity.id);
      const observed = async state => (await owner.request('GET', path)).observed === state;
      await until(() => observed('running'), 'running machine');
      const assignment = runner.assignments.find(item => item.id === machineId);
      const udid = (await runtime.ready(assignment, runner.context(assignment).image)).toLowerCase();
      assert.ok(!before.some(([id]) => id === udid));
      await record({ udid });
      await page.goto(home + '/#machines');
      await page.reload();
      await page.getByRole('button', { name, exact: true }).click();
      const operation = await dashboardIosUpload(page, archive, machineId, machine.hostId);
      const container = await runtime.simctl(['get_app_container', udid, bundle, 'app']);
      assert.ok(container.toLowerCase().includes('/' + udid + '/') && container.endsWith('.app'));
      await record({ udid, operation, container });
      console.log('Open local device', udid, 'and launch', bundle, 'with the device_open command.');
      const receipt = join(root, 'launch-confirmed');
      console.log('After observing the trial app, write the UDID and bundle ID separated by a space to', receipt);
      await until(async () => {
        try { return (await readFile(receipt, 'utf8')).trim() === udid + ' ' + bundle; }
        catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      }, 'device launch confirmation', 900000);
      await owner.request('POST', path + '/desired', { state: 'stopped' });
      await until(() => observed('stopped'), 'confirmed shutdown');
      const remove = () => owner.request('POST', path + '/delete', { id: deletionId });
      await remove();
      await until(async () => {
        const proof = await remove();
        assert.equal(proof.id, deletionId);
        assert.equal(proof.machineId, machineId);
        assert.notEqual(proof.state, 'blocked');
        return proof.state === 'complete';
      }, 'confirmed deletion');
      assert.deepEqual(await inventory(), before);
      await record({ udid, operation, container, deletion: 'complete', neighborsPreserved: true });
      console.log('Deletion confirmed and neighboring simulator inventory preserved.');
    }
  }
} finally {
  try { await browser?.close(); await dashboard?.close(); }
  finally { try { await runner?.close(); } finally { await controller?.close(); } }
}
