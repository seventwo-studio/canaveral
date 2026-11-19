// Run after building coordination and the dashboard assets:
//   node dashboard-mobile-capture.mjs ios|android
// CANAVERAL_TRIAL_EARLY_CANCEL=1 (Android) cancels one recording and leaves the page
// during another, requires positive cleanup for both, records again, then deletes
// the machine without any abandonment.
// iOS needs DEVELOPER_DIR for the selected Xcode; Android needs ANDROID_HOME.
// The trial creates one disposable device through a loopback controller and a
// native HostRunner, captures through the real dashboard, then removes it.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startController } from '../dist/src/main.js';
import { HostRunner } from '../dist/src/host.js';
import { CliClient } from '../dist/src/account-cli.js';
import { startDashboard } from '../dist/src/dashboard.js';

const run = promisify(execFile);
const platform = process.argv[2];
assert.ok(['ios', 'android'].includes(platform), 'Choose ios or android');
const ffmpeg = process.env.CANAVERAL_TRIAL_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const ffprobe = process.env.CANAVERAL_TRIAL_FFPROBE ?? '/opt/homebrew/bin/ffprobe';
const seconds = Number(process.env.CANAVERAL_TRIAL_SECONDS ?? 15);
const earlyCancel = process.env.CANAVERAL_TRIAL_EARLY_CANCEL === '1';
assert.ok(!earlyCancel || platform === 'android', 'Early-cancellation cleanup is an Android trial');
const root = await mkdtemp(join(await realpath(tmpdir()), `dashboard-${platform}-capture-`));
console.log('Private trial state:', root);
let controller, runner, dashboard, browser;
const evidence = { platform, started: new Date().toISOString() };
const save = () => writeFile(join(root, 'trial.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
async function until(check, description, milliseconds = 180000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(500);
  }
  throw Error('Timed out waiting for ' + description);
}
async function waitForFile(name, description) {
  const file = join(root, name);
  console.log(description, '— then create', file);
  await until(async () => access(file).then(() => true, () => false), description, 1800000);
}
const sha = data => createHash('sha256').update(data).digest('hex');
const stockAvd = join(homedir(), '.android/avd');
async function androidInventory() {
  const names = (await readdir(stockAvd)).sort(), hashes = {};
  for (const name of names) {
    if (name.endsWith('.ini')) hashes[name] = sha(await readFile(join(stockAvd, name)));
    if (name.endsWith('.avd')) hashes[name] = [(await stat(join(stockAvd, name))).ino, sha(await readFile(join(stockAvd, name, 'config.ini')))];
  }
  return { names, hashes };
}
try {
  const admin = randomBytes(32).toString('hex'), enrollment = randomBytes(32).toString('hex');
  await writeFile(join(root, 'admin'), admin, { mode: 0o600 });
  await writeFile(join(root, 'enroll'), enrollment, { mode: 0o600 });
  controller = await startController({ statePath: join(root, 'db'), adminTokenFile: join(root, 'admin'),
    enrollmentTokenFile: join(root, 'enroll'), controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  const url = 'http://127.0.0.1:' + controller.address.port;
  const image = platform === 'ios'
    ? { id: 'acceptance-ios', revision: '1', os: 'ios', arch: 'arm64', mode: 'device', minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
        device: { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2', deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro' } }
    : { id: 'acceptance-android', revision: '1', os: 'android', arch: 'arm64', mode: 'device', minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
        device: { systemImage: 'system-images;android-36;google_apis_playstore;arm64-v8a', profile: 'pixel_8' } };
  runner = new HostRunner({ url, stateDir: join(root, 'runner'), storage: join(root, 'devices'), name: 'acceptance-' + platform,
    provider: platform, templates: [image], enrollmentToken: enrollment, capacity: { cpu: 6, memoryMiB: 8192, diskGiB: 32 },
    videoEncoder: ffmpeg, ...(platform === 'android' ? { androidSDK: process.env.ANDROID_HOME } : {}) },
    { log: message => console.log('Runner:', message) });
  await runner.start();
  const runtime = runner.runtimes.get(platform);
  await runtime.check();
  assert.equal(typeof runtime.removeOwnedStorage, 'function');
  assert.equal(typeof runtime.openVideo, 'function');
  // Trace native video failures that the runner otherwise reduces to an unknown outcome.
  const traced = (label, pipe) => new Proxy(pipe, { get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      try { const result = await value.apply(target, args); if (key === 'wait' || key === 'interrupt' || key === 'close') console.log('Native', label, String(key), '->', result ?? 'ok'); return result; }
      catch (error) { console.log('Native', label, String(key), 'failed:', error?.message ?? error); throw error; }
    };
  } });
  const sources = [];
  for (const [owner, name] of [[runtime, 'pipe'], [runtime.transport, 'pipe'], [runtime, 'openVideo']]) {
    const original = owner?.[name]?.bind(owner);
    if (!original) continue;
    owner[name] = async (...args) => {
      const label = name === 'openVideo' ? 'source' : String(args[0]?.[0]).split('/').at(-1) + ' ' + String(args[0]?.[1] ?? '');
      try { const pipe = await original(...args); if (name === 'openVideo') sources.push(pipe); return traced(label, pipe); }
      catch (error) { console.log('Native', label, 'open failed:', error?.message ?? error); throw error; }
    };
  }
  const inventory = platform === 'ios'
    ? async () => (await runtime.inventory()).map(({ runtime, device }) => [device.udid.toLowerCase(), runtime, device.name, device.deviceTypeIdentifier, device.state]).sort()
    : androidInventory;
  const before = await inventory();
  const machineId = randomUUID(), deletionId = randomUUID(), name = `dashboard-${platform}-${machineId}`;
  Object.assign(evidence, { machineId, deletionId, before });
  await save();

  const password = randomBytes(24).toString('hex');
  const manager = new CliClient(url, (await new CliClient(url, admin).request('POST', '/v1/auth/setup', { username: 'admin', password })).token);
  const user = await manager.request('POST', '/v1/users', { id: randomUUID(), username: 'trial' });
  const invite = await manager.request('POST', `/v1/users/${user.id}/invite`, {});
  const owner = new CliClient(url, (await new CliClient(url, '').request('POST', '/v1/auth/claim', { token: invite.token, password })).token);
  dashboard = await startDashboard({ orchestratorUrl: url, listen: { host: '127.0.0.1', port: 0 } });
  const home = 'http://127.0.0.1:' + dashboard.address.port;
  const require = createRequire(new URL('../../dashboard/package.json', import.meta.url));
  browser = await require('playwright').chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();
  page.on('pageerror', error => console.log('Page error:', error.message));
  await page.goto(home);
  await page.getByLabel('Username').fill('trial');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Account menu' }).waitFor();

  await runner.checkEnvironment();
  await runner.poll();
  const path = '/v1/machines/' + machineId;
  const machine = await owner.request('POST', '/v1/machines', { id: machineId, name, templateId: image.id, resources: image.minimum });
  assert.equal(machine.ownerId, user.id);
  const observed = async state => (await owner.request('GET', path)).observed === state;
  const reserved = async () => (await manager.request('GET', '/v1/hosts')).hosts.find(h => h.id === runner.identity.id).reserved;
  const db = () => new DatabaseSync(join(root, 'db'), { readOnly: true, timeout: 5000 });
  const sessions = () => { const d = db(); try { return d.prepare('SELECT id,state,cleaned FROM mobile_video_sessions WHERE machine=? ORDER BY created').all(machineId).map(r => ({ ...r })); } finally { d.close(); } };
  try {
    await until(() => observed('running'), 'running machine', 600000);
    const assignment = runner.assignments.find(item => item.id === machineId);
    const storage = runtime.storage(assignment, runner.context(assignment).image);
    const device = platform === 'ios'
      ? (await runtime.ready(assignment, runner.context(assignment).image)).toLowerCase()
      : await runtime.endpoint(assignment, storage);
    if (platform === 'ios') assert.ok(!before.some(([id]) => id === device));
    const baseline = await reserved();
    Object.assign(evidence, { device, deviceName: runtime.name?.(assignment), reservedWithMachine: baseline });
    await save();
    console.log('Disposable device running:', device, runtime.name?.(assignment) ?? '');
    await waitForFile('ready-to-record', 'Open this device with device_open and bring an app to the foreground');

    const open = async () => {
      await page.goto(home + '/#machines');
      await page.reload();
      await page.getByRole('button', { name, exact: true }).click();
    };
    await open();
    // Read-only guest process listing on the disposable device: screenrecord PIDs only.
    const recorders = async () => (await run(runtime.tool('adb'), ['-s', device, 'shell', 'ps', '-A', '-o', 'PID,NAME'], { env: runtime.environment() })).stdout
      .split('\n').map(line => line.trim().split(/\s+/)).filter(([, process]) => process === 'screenrecord').map(([pid]) => Number(pid));

    // Screenshot through the dashboard and its download link.
    const shotName = `${platform}-trial-screenshot`;
    await page.getByLabel('Screenshot name').fill(shotName);
    await page.getByRole('button', { name: 'Take screenshot' }).click();
    const shotLink = page.getByRole('link', { name: `Download ${shotName}.png` });
    await shotLink.waitFor({ timeout: 120000 });
    const shotDownload = page.waitForEvent('download');
    await shotLink.click();
    const shot = await shotDownload;
    assert.equal(shot.suggestedFilename(), shotName + '.png');
    const shotFile = join(root, shotName + '.png');
    await shot.saveAs(shotFile);
    const png = await readFile(shotFile);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    evidence.screenshot = { file: shotFile, bytes: png.length, sha256: sha(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      status: await page.getByRole('status').first().textContent() };
    await save();
    console.log('Screenshot', evidence.screenshot);

    // Early cancellation: Cancel, then leaving the page, each partway through a recording.
    // Each needs the runner's positive cleanup and reservation release without abandonment.
    if (earlyCancel) {
      evidence.earlyCancel = [];
      for (const how of ['cancel', 'leave']) {
        assert.deepEqual(await recorders(), [], 'no recorder runs before ' + how);
        const index = sessions().length;
        await page.getByLabel('Recording name').fill(`${platform}-trial-${how}`);
        await page.getByLabel('Recording length').selectOption(String(seconds));
        await page.getByRole('button', { name: 'Record MP4' }).click();
        await page.getByText(/^Recording \d+ s ·/).waitFor({ timeout: 60000 });
        console.log(`RECORDING ${seconds} s on ${device}, ${how} after 10 s: interact with the device now.`);
        await delay(10000);
        const during = await recorders(), source = sources.at(-1), cancelled = new Date().toISOString(), began = Date.now();
        assert.equal(during.length, 1, 'exactly one recorder runs during capture');
        assert.equal(source?.recorder?.pid, during[0], 'the runner identified the running recorder');
        if (how === 'cancel') await page.getByRole('button', { name: 'Cancel recording' }).click();
        else { await page.close({ runBeforeUnload: true }); page = undefined; }
        await until(() => ['disconnected', 'finished'].includes(sessions()[index]?.state), 'closed session', 30000);
        await until(() => sessions()[index]?.cleaned === 1, how + ' cleanup', 60000);
        const cleanedAfter = (Date.now() - began) / 1000;
        await until(async () => JSON.stringify(await reserved()) === JSON.stringify(baseline), how + ' reservation release', 30000);
        const record = { how, cancelled, recordersDuring: during, recorder: source.recorder, stopped: source.stopped, signalled: source.signalled, cleanedAfterSeconds: cleanedAfter,
          session: sessions()[index], recordersAfter: await recorders(), reservedWithMachine: baseline, reserved: await reserved(),
          ...(how === 'cancel' ? { page: await page.getByLabel('Capture').textContent() } : {}) };
        evidence.earlyCancel.push(record); await save();
        console.log('Early', how, JSON.stringify(record));
        assert.equal(record.session.cleaned, 1); assert.ok(['absent', 'replaced', 'exited'].includes(record.stopped), record.stopped);
        assert.deepEqual(record.recordersAfter, []);
        if (!page) { page = await context.newPage(); page.on('pageerror', error => console.log('Page error:', error.message)); }
        await open();
      }
    }

    // Recording through the dashboard relay, verified in the page, then by FFmpeg.
    const clipName = `${platform}-trial-walkthrough`;
    await page.getByLabel('Recording name').fill(clipName);
    await page.getByLabel('Recording length').selectOption(String(seconds));
    await page.getByRole('button', { name: 'Record MP4' }).click();
    await page.getByText(/^Recording \d+ s ·/).waitFor({ timeout: 60000 });
    console.log(`RECORDING ${seconds} s on ${device}: interact with the device now.`);
    const verified = page.getByText(/^Recording verified/), failure = page.getByLabel('Capture').getByRole('alert');
    const outcome = await Promise.race([verified.waitFor({ timeout: (seconds + 120) * 1000 }).then(() => 'verified'),
      failure.waitFor({ timeout: (seconds + 120) * 1000 }).then(() => 'failed')]);
    if (outcome === 'failed') {
      // A failed capture must never offer a file; keep its retained cleanup evidence.
      await delay(5000);
      evidence.recording = { failure: await failure.textContent(), mp4Links: await page.getByRole('link', { name: /\.mp4$/ }).count(),
        sessions: sessions(), reservedWithMachine: baseline, reserved: await reserved() };
      await save();
      console.log('Recording failed in the page', JSON.stringify(evidence.recording));
      assert.equal(evidence.recording.mp4Links, 0);
    } else {
    await page.getByText(/capture session released|cleanup is not yet confirmed/).waitFor({ timeout: 30000 });
    const clipStatus = await verified.textContent();
    const playback = await page.getByLabel('Recording preview').evaluate(video => new Promise(resolve => {
      const report = () => resolve({ readyState: video.readyState, duration: video.duration, width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null });
      if (video.readyState >= 1 || video.error) report(); else { video.addEventListener('loadedmetadata', report, { once: true }); video.addEventListener('error', report, { once: true }); }
    }));
    const clipLink = page.getByRole('link', { name: `Download ${clipName}.mp4` });
    const clipDownload = page.waitForEvent('download');
    await clipLink.click();
    const clip = await clipDownload;
    const clipFile = join(root, clipName + '.mp4');
    await clip.saveAs(clipFile);
    const mp4 = await readFile(clipFile);
    const probe = JSON.parse((await run(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,profile,width,height,nb_read_frames,duration:format=format_name,duration', '-of', 'json', clipFile])).stdout);
    const decode = await run(ffmpeg, ['-v', 'error', '-xerror', '-i', clipFile, '-f', 'null', '-']).then(r => ({ code: 0, stderr: r.stderr }), e => ({ code: e.code, stderr: e.stderr }));
    const stream = probe.streams[0];
    assert.equal(stream.codec_name, 'h264');
    assert.ok(Number(stream.nb_read_frames) > 0 && Number(probe.format.duration) > 0);
    assert.equal(decode.code, 0); assert.equal(decode.stderr, '');
    const first = sessions().at(-1);
    evidence.recording = { file: clipFile, bytes: mp4.length, sha256: sha(mp4), status: clipStatus, playback, probe, decode, session: first };
    await save();
    console.log('Recording', JSON.stringify(evidence.recording));
    assert.deepEqual({ state: first.state, cleaned: first.cleaned }, { state: 'finished', cleaned: 1 });
    await until(async () => JSON.stringify(await reserved()) === JSON.stringify(baseline), 'recording reservation release', 60000);

    if (!earlyCancel) {
    // Leaving the page mid-recording closes the session through the supported route.
    await page.getByRole('button', { name: 'Record MP4' }).click();
    await page.getByText(/^Recording \d+ s ·/).waitFor({ timeout: 60000 });
    await delay(3000);
    const closes = [];
    context.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/close')) closes.push(new URL(request.url()).pathname); });
    await page.close({ runBeforeUnload: true });
    await until(() => sessions()[1]?.state === 'disconnected', 'closed abandoned session', 30000);
    // Reservation release needs the runner's positive native cleanup; record whether it arrives.
    const released = await until(() => sessions()[1]?.cleaned === 1, 'abandoned recording cleanup', 60000).then(() => true, () => false);
    evidence.leftPage = { closeRequests: closes, session: sessions()[1], cleanupReported: released, reservedWithMachine: baseline, reserved: await reserved() };
    await save();
    console.log('Left page mid-recording', JSON.stringify(evidence.leftPage));
    page = undefined;
    }
    }
    await waitForFile('release', 'Close the device panel with device_close');
  } finally {
    await owner.request('POST', path + '/desired', { state: 'stopped' });
    await until(() => observed('stopped'), 'confirmed shutdown');
    const remove = () => owner.request('POST', path + '/delete', { id: deletionId });
    // A session without positive cleanup must block deletion until an administrator abandons it.
    const uncleaned = sessions().filter(session => session.cleaned === 0);
    evidence.uncleanedBeforeDeletion = uncleaned;
    if (earlyCancel) assert.deepEqual(uncleaned, [], 'early cancellation must not need abandonment');
    if (uncleaned.length) {
      const outcome = promise => promise.then(body => ({ accepted: body }), error => ({ refused: String(error?.message ?? error) }));
      const refused = await outcome(remove()), reservedBefore = await reserved();
      const reason = 'Native trial: Android cleanup after early cancellation is unproven; deleting the disposable device.';
      const abandon = (client, id) => outcome(client.request('POST', `${path}/video-sessions/${id}/abandon`, { reason }));
      const ownerAbandon = await abandon(owner, uncleaned[0].id), adminAbandon = [];
      for (const session of uncleaned) adminAbandon.push(await abandon(manager, session.id));
      evidence.deletionWhileUncleaned = { sessions: uncleaned, deletion: refused, reservedBefore, ownerAbandon, adminAbandon,
        afterAbandon: await owner.request('GET', `${path}/video-sessions/${uncleaned[0].id}`), reservedAfterAbandon: await reserved() };
      await save();
      console.log('Deletion while uncleaned', JSON.stringify(evidence.deletionWhileUncleaned));
      assert.match(refused.refused ?? '', /HTTP 409/);
      assert.match(ownerAbandon.refused ?? '', /HTTP 403/);
      assert.ok(adminAbandon.every(result => result.accepted?.resolution?.decision === 'abandoned'));
    }
    await remove();
    await until(async () => {
      const proof = await remove();
      assert.equal(proof.id, deletionId); assert.equal(proof.machineId, machineId); assert.notEqual(proof.state, 'blocked');
      return proof.state === 'complete';
    }, 'confirmed deletion');
    const after = await inventory();
    evidence.after = after;
    evidence.reservedAfterDeletion = await reserved();
    evidence.sessionsAfterDeletion = sessions();
    evidence.inventoryRestored = JSON.stringify(after) === JSON.stringify(before);
    evidence.finished = new Date().toISOString();
    await save();
    assert.deepEqual(after, before);
    console.log('Deletion confirmed and baseline device inventory restored.');
  }
} finally {
  try { await browser?.close(); await dashboard?.close(); }
  finally { try { await runner?.close(); } finally { await controller?.close(); } }
}
