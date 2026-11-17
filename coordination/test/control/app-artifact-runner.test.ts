import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliClient } from '../../src/account-cli.ts';
import { main as cli } from '../../src/cli.ts';
import { uploadAppArtifactFile } from '../../src/app-artifact-client.ts';
import { startController } from '../../src/main.ts';
import { HostRunner, hostTransport } from '../../src/host.ts';
import type { HostConfig, HostTransport } from '../../src/host.ts';
import { MobileProvider, authorized } from '../../src/providers/mobile.ts';
import type { Authorized, Download, RecordValue } from '../../src/providers/mobile.ts';
import { object } from '../../src/errors.ts';

/** Real loopback workers, HTTP credentials, chunks and journals; no native SDK or device. */
test('CI artifact upload reaches only its assigned runner and durable installation does not replay', { timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-artifact-runner-')));
  const admin = randomBytes(32).toString('base64url'), enrollment = randomBytes(32).toString('base64url');
  const adminFile = join(root, 'admin.token'), enrollmentFile = join(root, 'enrollment.token');
  writeFileSync(adminFile, admin, { mode: 0o600 }); writeFileSync(enrollmentFile, enrollment, { mode: 0o600 });
  let runner: HostRunner | undefined;
  const controller = await startController({ statePath: join(root, 'controller.sqlite'), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(async () => { release(); await runner?.close(); await controller.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${controller.address.port}`, client = new CliClient(url, admin);
  const image: RecordValue = { id: 'android-fixture', revision: '1', os: 'android', arch: 'arm64', mode: 'device',
    minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
  const config: HostConfig = { url, stateDir: join(root, 'runner'), enrollmentToken: enrollment, name: 'portable-artifact-runner', provider: 'android',
    storage: join(root, 'devices'), templates: [image], capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 }, pollIntervalSeconds: .25, concurrency: 3 };
  const payload = Buffer.alloc(512 * 1024 + 17003, 173), expectedSha = createHash('sha256').update(payload).digest('hex');
  const file = join(root, 'ci-build.apk'); writeFileSync(file, payload, { mode: 0o600 });
  let started = false, installs = 0, sourceClosed = false, operationError = '';
  const consumed: Buffer[] = [], downloads: string[] = [];
  class FixtureMobileProvider extends MobileProvider {
    override readonly kind = 'android';
    async check() { return { ready: true, nativeAcceptance: false }; }
    async reconcile(machine: RecordValue) { return { state: machine.desired }; }
    override async operate(...args: Parameters<MobileProvider['operate']>) {
      try { return await super.operate(...args); }
      catch (error) { operationError = String(error); throw error; }
    }
    async installArtifact(_machine: RecordValue, _image: RecordValue, _folder: string, source: Download, sha256: string, check: Authorized) {
      started = true;
      try {
        assert.equal(await source.verify(), true); await gate;
        for (let offset = 0; offset < source.size;) {
          await authorized(check); const bytes = Buffer.from(await source.read(Math.min(65536, source.size - offset)));
          assert.ok(bytes.length > 0 && bytes.length <= 65536); consumed.push(bytes); offset += bytes.length;
        }
        assert.equal(await source.verify(), true); assert.equal(sha256, expectedSha);
        assert.deepEqual(Buffer.concat(consumed), payload); installs++;
        return { installed: true, sha256, bytes: source.size, artifactCleaned: true };
      } finally { await source.close(); sourceClosed = true; }
    }
  }
  const outbound = hostTransport(config), transport: HostTransport = { request: async (method, path, body, token, signal) => {
    if (path.includes('/app-artifacts/')) { assert.equal(method, 'GET'); downloads.push(path); }
    return outbound.request(method, path, body, token, signal);
  } };
  const clock = { suspendAware: true, now: () => performance.now() / 1000, wall: () => Date.now() / 1000 };
  runner = new HostRunner(config, { transport, clock, providerFactory: (settings, state) => new FixtureMobileProvider({ ...settings,
    transport: { run: async () => { throw new Error('Native commands are forbidden in this fixture.'); }, elapsed: clock.now } }, state) });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  const hostId = runner.identity!.id;
  const machineId = randomUUID();
  await client.request('POST', '/v1/machines', { id: machineId, name: 'remote-ci-phone', templateId: image.id, resources: image.minimum });
  await runner.poll(); await runner.step();
  async function eventually(check: () => boolean): Promise<void> {
    const deadline = performance.now() + 5000;
    while (!check() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), `fixture work did not finish: ${JSON.stringify({ reports: [...runner!.reports], operations: [...runner!.deviceReports], operationError })}`);
  }
  await eventually(() => runner!.reports.get(machineId)?.state === 'running'); await runner.poll();
  const reservedDisk = async () => {
    const hosts = (await client.request('GET', '/v1/hosts')).hosts as RecordValue[];
    return Number(object(hosts.find(host => host.id === hostId)!.reserved).diskGiB);
  };
  const initialReservation = await reservedDisk(), artifactId = randomUUID();
  const artifact = await uploadAppArtifactFile(client, { machineId, id: artifactId, format: 'apk', file });
  assert.equal(artifact.state, 'ready'); assert.equal(artifact.bytes, payload.length); assert.equal(artifact.sha256, expectedSha);
  let output = '', errors = '';
  assert.equal(await cli(['--url', url, '--token-file', adminFile, 'app-upload', machineId, file, '--format', 'apk', '--request-id', artifactId], { stdout: s => { output += s; }, stderr: s => { errors += s; } }), 0, errors);
  assert.equal(JSON.parse(output).state, 'ready'); assert.ok(!output.includes(admin));
  assert.ok(await reservedDisk() > initialReservation);
  const operationId = randomUUID(), operation = { id: operationId, action: 'install-uploaded', arguments: { artifact: artifactId } };
  await client.request('POST', `/v1/machines/${machineId}/operations`, operation);
  await runner.poll(); await runner.step(); await eventually(() => started);
  const prefix = `/v1/hosts/${hostId}/app-artifacts/${artifactId}/operations/${operationId}`;
  const otherHost = randomUUID(), otherCredential = randomBytes(32).toString('base64url');
  await new CliClient(url, enrollment).request('POST', '/v1/hosts/enroll', { id: otherHost, credential: otherCredential,
    offer: { name: 'unassigned-host', provider: 'android', capacity: config.capacity, templates: [image] } });
  await assert.rejects(new CliClient(url, otherCredential).request('GET', prefix.replace(hostId, otherHost)), /HTTP 403/);
  await assert.rejects(new CliClient(url, runner.identity!.credential).request('GET', prefix.replace(operationId, randomUUID())), /HTTP 403/);
  await assert.rejects(client.request('POST', `/v1/app-artifacts/${artifactId}/delete`, {}), /HTTP 409/);
  assert.equal((await client.request('POST', `/v1/machines/${machineId}/operations`, operation)).id, operationId);
  await assert.rejects(client.request('POST', `/v1/machines/${machineId}/operations`, { ...operation, id: randomUUID() }), /HTTP 409/);
  for (let i = 0; i < 3; i++) {
    await runner.step(); await runner.poll();
    assert.equal((await client.request('GET', `/v1/machines/${machineId}`)).observed, 'running');
    assert.equal((await client.request('GET', `/v1/operations/${operationId}`)).state, 'queued');
  }
  release(); await eventually(() => runner!.deviceReports.get(operationId)?.state === 'succeeded'); await runner.poll();
  const receipt = await client.request('GET', `/v1/operations/${operationId}`);
  assert.equal(receipt.state, 'succeeded'); assert.deepEqual(receipt.result, { installed: true, sha256: expectedSha, bytes: payload.length, artifactCleaned: true });
  assert.ok(sourceClosed); assert.equal(installs, 1);
  assert.ok(downloads.length >= 5); assert.ok(downloads.every(path => path === prefix || path.startsWith(prefix + '/chunks/')));
  assert.ok(downloads.includes(prefix + '/chunks/0')); assert.ok(downloads.includes(prefix + '/chunks/524288'));
  const requestsAfterInstall = downloads.length;
  await client.request('POST', `/v1/machines/${machineId}/operations`, operation); await runner.poll(); await runner.step();
  assert.equal(installs, 1); assert.equal(downloads.length, requestsAfterInstall);
  await assert.rejects(new CliClient(url, runner.identity!.credential).request('GET', prefix), /HTTP 403/);
  assert.equal((await client.request('POST', `/v1/app-artifacts/${artifactId}/delete`, {})).state, 'deleted');
  assert.equal(await reservedDisk(), initialReservation);
});
