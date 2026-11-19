import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliClient } from '../../src/account-cli.ts';
import { SessionConnection } from '../../src/control/sessions.ts';
import { startController } from '../../src/main.ts';
import { startDashboard } from '../../src/dashboard.ts';

const key = () => randomBytes(32).toString('base64url');
const image = { id: 'video-phone', revision: '1', os: 'android', arch: 'arm64', mode: 'device', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 },
  device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
type Message = string | Buffer;
/** A browser-like client: Node's WebSocket sends Cookie/Origin and offers permessage-deflate. */
function browser(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { protocols: ['canaveral-session-v1'], headers } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  const inbox: Message[] = [], waiters: Array<() => void> = [];
  let closed = false;
  socket.onmessage = event => { inbox.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer)); waiters.splice(0).forEach(w => w()); };
  socket.onclose = () => { closed = true; waiters.splice(0).forEach(w => w()); };
  const opened = new Promise<boolean>(resolve => { socket.onopen = () => resolve(true); socket.onerror = () => resolve(false); });
  return {
    socket, opened,
    async next(): Promise<Message | null> {
      const deadline = Date.now() + 5000;
      while (!inbox.length && !closed && Date.now() < deadline) await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 100); });
      return inbox.shift() ?? null;
    },
    get closed() { return closed; },
  };
}

test('dashboard relays an owned video session to a cookie client with matching Origin only', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-video-')), admin = key(), enrollment = key();
  writeFileSync(join(directory, 'admin'), admin, { mode: 0o600 }); writeFileSync(join(directory, 'enroll'), enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(directory, 'db'), adminTokenFile: join(directory, 'admin'), enrollmentTokenFile: join(directory, 'enroll'),
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${controller.address.port}`;
  const dashboard = await startDashboard({ orchestratorUrl: origin, listen: { host: '127.0.0.1', port: 0 } });
  const home = `http://127.0.0.1:${dashboard.address.port}`, ws = home.replace('http:', 'ws:');
  const peers: SessionConnection[] = [];
  t.after(async () => { peers.forEach(p => p.close()); await dashboard.close(); await controller.close(); rmSync(directory, { recursive: true, force: true }); });

  const password = randomBytes(24).toString('hex');
  const manager = new CliClient(origin, String((await new CliClient(origin, admin).request('POST', '/v1/auth/setup', { username: 'admin', password })).token));
  async function account(username: string) {
    const user = await manager.request('POST', '/v1/users', { id: randomUUID(), username });
    const invite = await manager.request('POST', `/v1/users/${user.id}/invite`, {});
    return String((await new CliClient(origin, '').request('POST', '/v1/auth/claim', { token: invite.token, password })).token);
  }
  const owner = await account('owner'), other = await account('other');
  const hostId = randomUUID(), hostToken = key(), machineId = randomUUID();
  const offer = { name: 'dashboard-video-fixture', provider: 'android', capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 32 }, templates: [image] };
  await new CliClient(origin, enrollment).request('POST', '/v1/hosts/enroll', { id: hostId, credential: hostToken, offer });
  await new CliClient(origin, owner).request('POST', '/v1/machines', { id: machineId, name: 'video-phone', templateId: image.id, resources: {} });
  await new CliClient(origin, hostToken).request('POST', `/v1/hosts/${hostId}/heartbeat`, { offer, reports: { [machineId]: { state: 'running' } } });

  const cookie = (token: string) => ({ Cookie: `canaveral_session=${token}`, Origin: home });
  async function create() {
    const response = await fetch(`${home}/api/v1/machines/${machineId}/video-sessions`, { method: 'POST', headers: { ...cookie(owner), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), fps: 30, durationSeconds: 5, bitRate: 4000000 }) });
    assert.equal(response.status, 201); return await response.json() as { id: string; generation: string };
  }
  const session = await create(), path = `/api/v1/machines/${machineId}/video-sessions/${session.id}/${session.generation}`;
  const refused = async (headers: Record<string, string>) => { const client = browser(ws + path, headers); assert.equal(await client.opened, false); };
  await refused({ Cookie: `canaveral_session=${owner}` }); // no Origin
  await refused({ ...cookie(owner), Origin: 'http://attacker.example' });
  await refused({ Authorization: `Bearer ${owner}`, Origin: home });
  await refused(cookie(other)); // another account cannot attach, even with a valid session
  assert.equal((await fetch(home + path, { headers: cookie(owner) })).status, 404, 'attachment is not an ordinary GET route');
  assert.equal((await fetch(`${home}/api/v1/machines/${machineId}/video-sessions/${session.id}`, { headers: cookie(owner) })).status, 200);

  const viewer = browser(ws + path, cookie(owner));
  assert.equal(await viewer.opened, true);
  assert.equal(viewer.socket.protocol, 'canaveral-session-v1'); assert.equal(viewer.socket.extensions, '');
  const host = await SessionConnection.connect(origin, `/v1/hosts/${hostId}/video-sessions/${session.id}/${session.generation}`, hostToken); peers.push(host);
  const ready = { type: 'ready', sessionId: session.id, generation: session.generation, capability: 'video' };
  assert.deepEqual(JSON.parse(String(await viewer.next())), ready); assert.deepEqual(await host.receive(5), ready);
  const metadata = { type: 'video', mediaType: 'video/mp4', codec: 'avc1', fps: 30 };
  await host.sendControl(metadata); assert.deepEqual(JSON.parse(String(await viewer.next())), metadata);
  const mp4 = readFileSync(new URL('../../../../dashboard/e2e/fixtures/capture.mp4', import.meta.url));
  for (let offset = 0; offset < mp4.length; offset += 65536) await host.sendBytes(mp4.subarray(offset, offset + 65536));
  const received: Buffer[] = [];
  while (Buffer.concat(received).length < mp4.length) { const chunk = await viewer.next(); assert.ok(Buffer.isBuffer(chunk)); received.push(chunk); }
  assert.deepEqual(Buffer.concat(received), mp4);
  const finish = { type: 'finish', bytes: mp4.length, sha256: createHash('sha256').update(mp4).digest('hex'), cleaned: true };
  await host.sendControl(finish); assert.deepEqual(JSON.parse(String(await viewer.next())), finish);
  viewer.socket.send(JSON.stringify({ type: 'ack' })); assert.deepEqual(await host.receive(5), { type: 'ack' });
  // As the runner does: close the channel, then report positive native cleanup.
  host.close(); assert.equal(await viewer.next(), null); assert.equal(viewer.closed, true);
  await new CliClient(origin, hostToken).request('POST', `/v1/hosts/${hostId}/video-sessions/${session.id}/finish`, { generation: session.generation, cleaned: true });
  const done = await (await fetch(`${home}/api/v1/machines/${machineId}/video-sessions/${session.id}`, { headers: cookie(owner) })).json() as { state: string };
  assert.equal(done.state, 'finished');

  // Leaving mid-recording: the supported close route ends authorization and the relay.
  const second = await create(), secondPath = `/api/v1/machines/${machineId}/video-sessions/${second.id}/${second.generation}`;
  const leaving = browser(ws + secondPath, cookie(owner)); assert.equal(await leaving.opened, true);
  const secondHost = await SessionConnection.connect(origin, `/v1/hosts/${hostId}/video-sessions/${second.id}/${second.generation}`, hostToken); peers.push(secondHost);
  await leaving.next(); await secondHost.receive(5);
  const closed = await fetch(`${home}/api/v1/machines/${machineId}/video-sessions/${second.id}/close`, { method: 'POST', headers: { ...cookie(owner), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(closed.status, 200); assert.equal((await closed.json() as { state: string }).state, 'disconnected');
  await assert.rejects(secondHost.receive(5));
  assert.equal(await leaving.next(), null); assert.equal(leaving.closed, true);
});
