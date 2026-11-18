// Run after building coordination. Provision the assigned AVD before Device panel discovery.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startController } from '../dist/src/main.js';
import { HostRunner } from '../dist/src/host.js';
import { CliClient } from '../dist/src/account-cli.js';

const root = await mkdtemp(join(await realpath(tmpdir()), 'dashboard-android-install-'));
let controller, runner;
try {
  const admin = randomBytes(32).toString('hex'), enrollment = randomBytes(32).toString('hex');
  const adminFile = join(root, 'admin'), enrollmentFile = join(root, 'enroll');
  await writeFile(adminFile, admin, { mode: 0o600 });
  await writeFile(enrollmentFile, enrollment, { mode: 0o600 });
  controller = await startController({ statePath: join(root, 'db'), adminTokenFile: adminFile,
    enrollmentTokenFile: enrollmentFile, controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  const url = 'http://127.0.0.1:' + controller.address.port;
  const image = { id: 'acceptance-android', revision: '1', os: 'android', arch: 'arm64', mode: 'device',
    minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 }, device: {
      systemImage: 'system-images;android-36;google_apis_playstore;arm64-v8a', profile: 'pixel_8' } };
  runner = new HostRunner({ url, stateDir: join(root, 'runner'), storage: join(root, 'devices'),
    name: 'acceptance-android', provider: 'android', androidSDK: process.env.ANDROID_HOME, templates: [image], enrollmentToken: enrollment,
    capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 } });
  await runner.initializeProviders();
  await runner.connect();
  const runtime = runner.runtimes.get('android');
  const client = new CliClient(url, admin);
  const hosts = (await client.request('GET', '/v1/hosts')).hosts;
  assert.ok(hosts.some(host => host.id === runner.identity.id));
  console.log('Disposable Android runner enrolled on loopback controller.');
  await runtime.check();
  const id = randomUUID();
  await client.request('POST', '/v1/machines', { id, name: 'apk-trial', templateId: image.id, resources: {} });
  await runner.poll();
  const assignment = runner.assignments.find(machine => machine.id === id);
  assert.ok(assignment);
  const context = runner.context(assignment);
  const storage = runtime.storage(assignment, context.image);
  await runtime.provision(assignment, context.image, storage);
  console.log('Owned AVD provisioned:', runtime.name(assignment), root);
  // Wait for the operator to check the device inventory before closing the trial.
  for await (const _ of process.stdin) break;
} finally {
  await runner?.close();
  await controller?.close();
  await rm(root, { recursive: true, force: true });
}
