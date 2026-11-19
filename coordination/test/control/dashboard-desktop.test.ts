import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliClient } from '../../src/account-cli.ts';
import { startController } from '../../src/main.ts';
import { startDashboard } from '../../src/dashboard.ts';
import { HostRunner } from '../../src/host.ts';
import type { HostConfig } from '../../src/host.ts';
import { MAX_RFB_MESSAGES_PER_FRAME } from '../../src/guest/display.ts';
import type { DisplayConnection } from '../../src/guest/display.ts';
import type { RecordValue } from '../../src/runtime-process.ts';

const key = () => randomBytes(32).toString('base64url');
const PROTOCOL = 'canaveral-session-v1';
type Message = string | Buffer;
/** A browser-like client: Node's WebSocket sends Cookie/Origin and offers permessage-deflate. */
function browser(url: string, headers: Record<string, string>, protocols = ['binary', PROTOCOL]) {
  const socket = new WebSocket(url, { protocols, headers } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  const inbox: Message[] = [], waiters: Array<() => void> = [];
  let closed = false;
  socket.onmessage = event => { inbox.push(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer)); waiters.splice(0).forEach(w => w()); };
  socket.onclose = () => { closed = true; waiters.splice(0).forEach(w => w()); };
  const opened = new Promise<boolean>(resolve => { socket.onopen = () => resolve(true); socket.onerror = () => resolve(false); });
  return {
    socket, opened,
    async next(timeout = 10000): Promise<Message | null> {
      const deadline = Date.now() + timeout;
      while (!inbox.length && !closed && Date.now() < deadline) await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 100); });
      return inbox.shift() ?? null;
    },
    async bytes(n: number): Promise<Buffer> {
      let data = Buffer.alloc(0);
      while (data.length < n) { const part = await this.next(); assert.ok(Buffer.isBuffer(part), `expected ${n} RFB bytes, got ${String(part)}`); data = Buffer.concat([data, part]); }
      assert.equal(data.length, n); return data;
    },
    async control(): Promise<Record<string, unknown>> { const value = await this.next(); assert.equal(typeof value, 'string', 'expected a control message'); return JSON.parse(value as string) as Record<string, unknown>; },
    get closed() { return closed; },
  };
}
type Viewer = ReturnType<typeof browser>;
const keyEvent = (keysym: number, down: boolean) => { const frame = Buffer.alloc(8); frame[0] = 4; frame[1] = down ? 1 : 0; frame.writeUInt32BE(keysym, 4); return frame; };
async function eventually(predicate: () => boolean | Promise<boolean>, what: string, ms = 10000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!await predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(await predicate(), what);
}

/** A private RFB 3.8 peer standing in for the guest's VNC server; it records applied input. */
class FixtureDisplay implements DisplayConnection {
  private output: Buffer[] = [Buffer.from('RFB 003.008\n')];
  private stage = 0;
  closed = false;
  readonly input: Buffer[] = [];
  constructor(readonly displays: FixtureDisplay[]) { displays.push(this); }
  async read(maximum: number): Promise<Uint8Array | null> {
    if (this.closed) return Buffer.alloc(0);
    const next = this.output.shift();
    if (!next) { await new Promise(resolve => setTimeout(resolve, 10)); return null; }
    if (next.length > maximum) { this.output.unshift(next.subarray(maximum)); return next.subarray(0, maximum); }
    return next;
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('fixture display closed');
    if (this.stage === 0) this.output.push(Buffer.from([1, 1]));
    else if (this.stage === 1) this.output.push(Buffer.alloc(4));
    else if (this.stage === 2) { const header = Buffer.alloc(24); header.writeUInt16BE(1440, 0); header.writeUInt16BE(900, 2); this.output.push(header); }
    else this.input.push(Buffer.from(data));
    this.stage++;
  }
  close(): void { this.closed = true; }
  keys(): number { return this.input.filter(frame => frame[0] === 4).length; }
  /** Key events whose keysym falls in [low, high]; reset frames for held keys use other keysyms. */
  keysIn(low: number, high: number): number { return this.input.filter(frame => frame[0] === 4 && frame.readUInt32BE(4) >= low && frame.readUInt32BE(4) <= high).length; }
}

/** Browser side of the RFB handshake through the relay, ending view-only. */
async function handshake(viewer: Viewer, sessionReady = true): Promise<void> {
  if (sessionReady) { const ready = await viewer.control(); assert.equal(ready.type, 'ready'); assert.equal(ready.capability, 'display'); }
  assert.equal((await viewer.bytes(12)).toString(), 'RFB 003.008\n');
  viewer.socket.send(Buffer.from('RFB 003.008\n')); assert.deepEqual(await viewer.bytes(2), Buffer.from([1, 1]));
  viewer.socket.send(Buffer.from([1])); assert.deepEqual(await viewer.bytes(4), Buffer.alloc(4));
  viewer.socket.send(Buffer.from([1])); const init = await viewer.bytes(24 + 'Canaveral display'.length);
  assert.equal(init.readUInt16BE(0), 1440);
  assert.deepEqual(await viewer.control(), { type: 'control', state: 'view-only' });
}
async function take(viewer: Viewer): Promise<void> {
  viewer.socket.send(JSON.stringify({ type: 'input-control', action: 'take' }));
  assert.deepEqual(await viewer.control(), { type: 'control', state: 'owned' });
}

test('a standalone dashboard relays an owner desktop through the controller to its host', { timeout: 90000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dashboard-desktop-'))), admin = key(), enrollment = key();
  writeFileSync(join(root, 'admin'), admin, { mode: 0o600 }); writeFileSync(join(root, 'enroll'), enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, 'db'), adminTokenFile: join(root, 'admin'), enrollmentTokenFile: join(root, 'enroll'),
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${controller.address.port}`;
  // No connectors: the deployed shape, separate from the controller and every host.
  const dashboard = await startDashboard({ orchestratorUrl: origin, listen: { host: '127.0.0.1', port: 0 }, reauthorizeMs: 100 });
  const home = `http://127.0.0.1:${dashboard.address.port}`, ws = home.replace('http:', 'ws:');
  const displays: FixtureDisplay[] = [];
  const image: RecordValue = { id: 'desktop-fixture', revision: '1', os: 'linux', arch: 'amd64', mode: 'desktop', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, image: '/private/local/desktop.img' };
  const config: HostConfig = { url: origin, stateDir: join(root, 'runner'), enrollmentToken: enrollment, name: 'desktop-runner', provider: 'libvirt',
    storage: join(root, 'disks'), templates: [image], capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 64 }, pollIntervalSeconds: .25 };
  const clock = { suspendAware: true, now: () => performance.now() / 1000, wall: () => Date.now() / 1000 };
  const runner = new HostRunner(config, { clock, providerFactory: () => ({ kind: 'libvirt', check: async () => ({}), reconcile: async (m: RecordValue) => ({ state: m.desired }),
    desktop: async () => new FixtureDisplay(displays) }) });
  let pumping = true;
  const pump = (async () => { while (pumping) { try { await runner.poll(); await runner.step(); } catch { /* the next round retries */ } await new Promise(resolve => setTimeout(resolve, 50)); } })();
  t.after(async () => { pumping = false; await pump; await runner.close(); await dashboard.close(); await controller.close(); rmSync(root, { recursive: true, force: true }); });
  await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment();

  const password = randomBytes(24).toString('hex');
  const manager = new CliClient(origin, String((await new CliClient(origin, admin).request('POST', '/v1/auth/setup', { username: 'admin', password })).token));
  async function account(username: string): Promise<string> {
    const user = await manager.request('POST', '/v1/users', { id: randomUUID(), username });
    const invite = await manager.request('POST', `/v1/users/${user.id}/invite`, {});
    return String((await new CliClient(origin, '').request('POST', '/v1/auth/claim', { token: invite.token, password })).token);
  }
  const login = async (username: string) => String((await new CliClient(origin, '').request('POST', '/v1/auth/login', { username, password })).token);
  const owner = await account('owner'), other = await account('other'), machineId = randomUUID();
  await new CliClient(origin, owner).request('POST', '/v1/machines', { id: machineId, name: 'desktop', templateId: image.id, resources: image.minimum });
  await eventually(async () => (await new CliClient(origin, owner).request('GET', `/v1/machines/${machineId}`)).observed === 'running', 'machine running');

  const cookie = (token: string) => ({ Cookie: `canaveral_session=${token}`, Origin: home });
  const path = `${ws}/api/v1/machines/${machineId}/desktop`;

  // 1. Refusals happen before any controller display session or host attachment.
  const refused = async (headers: Record<string, string>, protocols?: string[]) => { const client = browser(path, headers, protocols); assert.equal(await client.opened, false); };
  await refused({ Cookie: `canaveral_session=${owner}` }); // no Origin
  await refused({ ...cookie(owner), Origin: 'http://attacker.example' });
  await refused({ Authorization: `Bearer ${owner}`, Origin: home });
  await refused({ Origin: home }); // no session cookie
  await refused(cookie(other)); // another account, with its own valid session
  await refused(cookie(owner), ['binary']); // the relay speaks only the session protocol
  assert.equal(displays.length, 0, 'no refused viewer reached the host display');
  assert.equal((await fetch(`${home}/api/v1/machines/${machineId}/desktop`, { headers: cookie(owner) })).status, 403, 'the viewer is not an ordinary GET route');

  // 2. The owner's viewer reaches the guest display; input applies only after ownership.
  const viewer = browser(path, cookie(owner));
  assert.equal(await viewer.opened, true);
  assert.equal(viewer.socket.protocol, PROTOCOL); assert.equal(viewer.socket.extensions, '');
  await handshake(viewer);
  const display = displays.at(-1)!;
  viewer.socket.send(keyEvent(0x61, true)); // view-only: discarded on the runner
  assert.deepEqual(await viewer.control(), { type: 'control', state: 'view-only' });
  await take(viewer);
  // Typing rate through the relay: one key event per WebSocket message, as noVNC sends them.
  const started = performance.now(), typed = 200;
  for (let i = 0; i < typed; i++) viewer.socket.send(keyEvent(0x61 + (Math.floor(i / 2) % 26), i % 2 === 0));
  await eventually(() => display.keys() === typed, 'typed events applied in order');
  const rate = typed / ((performance.now() - started) / 1000);
  t.diagnostic(`relayed portable input rate: ${Math.round(rate)} events/s`);
  assert.deepEqual(display.input.slice(0, 4).map(frame => [frame.readUInt32BE(4), frame[1]]), [[0x61, 1], [0x61, 0], [0x62, 1], [0x62, 0]]);

  // 3. A message carrying more RFB messages than the cap ends the session with none applied.
  viewer.socket.send(Buffer.concat(Array.from({ length: MAX_RFB_MESSAGES_PER_FRAME + 1 }, (_, i) => keyEvent(0x30 + (i % 10), i % 2 === 0))));
  await eventually(() => viewer.closed, 'over-cap message closes the viewer');
  await eventually(() => display.closed, 'over-cap message closes the guest display');
  assert.equal(display.keysIn(0x30, 0x39), 0, 'no event of the over-cap message was applied');

  // 4. Logging out mid-session tears down both sockets; later input never reaches the guest.
  const session = await login('owner');
  const second = browser(path, cookie(session));
  assert.equal(await second.opened, true);
  await handshake(second);
  const secondDisplay = displays.at(-1)!;
  await take(second);
  second.socket.send(keyEvent(0x41, true)); second.socket.send(keyEvent(0x41, false));
  await eventually(() => secondDisplay.keys() === 2, 'input before logout applied');
  const logout = await fetch(`${home}/api/v1/auth/logout`, { method: 'POST', headers: { ...cookie(session), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  for (let i = 0; i < 20; i++) if (!second.closed) second.socket.send(keyEvent(0x30 + (i % 10), i % 2 === 0));
  await eventually(() => second.closed, 'logout closes the viewer', 5000);
  await eventually(() => secondDisplay.closed, 'logout closes the guest display', 5000);
  assert.equal(secondDisplay.keysIn(0x30, 0x39), 0, 'no input after logout was applied');

  // 5. Losing machine access (the owner stops the machine) also ends the relay.
  const third = browser(path, cookie(owner));
  assert.equal(await third.opened, true);
  await handshake(third);
  await new CliClient(origin, owner).request('POST', `/v1/machines/${machineId}/desired`, { state: 'stopped' });
  await eventually(() => third.closed, 'stopping the machine closes the viewer', 5000);
  await eventually(() => displays.at(-1)!.closed, 'stopping the machine closes the guest display', 5000);
});

test('a connection reset while the desktop relay is authorizing does not crash the dashboard', { timeout: 20000 }, async t => {
  const { createServer } = await import('node:http'), { connect } = await import('node:net');
  // A slow controller keeps the upgrade waiting in authorization.
  const upstream = createServer((_request, response) => { setTimeout(() => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"Unauthorized."}'); }, 500); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dashboard = await startDashboard({ orchestratorUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, listen: { host: '127.0.0.1', port: 0 } });
  t.after(async () => { await dashboard.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const home = `http://127.0.0.1:${dashboard.address.port}`;
  const socket = connect(dashboard.address.port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write([`GET /api/v1/machines/${randomUUID()}/desktop HTTP/1.1`, `Host: 127.0.0.1:${dashboard.address.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: binary, ${PROTOCOL}`,
    `Cookie: canaveral_session=${key()}`, `Origin: ${home}`, '', ''].join('\r\n'));
  await new Promise(resolve => setTimeout(resolve, 150));
  socket.resetAndDestroy();
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok((await fetch(home + '/')).status < 500);
});
