/** Real GuestHTTPS -> Swift bounded listener + bridge. All storage is disposable. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { pinnedGuestBindingFactory, guestBindingAuthorization } from '../coordination/dist/src/guest/binding.js';
import { GuestHTTPS } from '../coordination/dist/src/guest/https.js';
import { GuestHelperAccess } from '../coordination/dist/src/control/sessions.js';
const watchdog = setTimeout(() => { console.error("Assigned TLS fixture exceeded its deadline"); process.exit(1); }, 30_000); watchdog.unref();
const [storage, port] = process.argv.slice(2);
const receipt = JSON.parse(readFileSync(join(storage, 'guest-launch.json')));
const pinned = { address: '127.0.0.1', serverName: receipt.tls.serverName, leafDER: Buffer.from(receipt.tls.leafDER, 'base64url'), sha256: receipt.tls.sha256 };
const origin = `https://127.0.0.1:${port}`, expected = () => receipt.assignment;
const factory = pinnedGuestBindingFactory();
try {
  const binding = await factory.resolve(expected, origin, receipt.credential, () => true, pinned);
  const access = new GuestHelperAccess(() => binding);
  const machine = {}, image = { os: 'macos' };
  await Promise.all(Array.from({ length: 4 }, () => access.control(machine, image, '', { action: 'list-files', arguments: { path: '/' } })));
  const download = await access.streamDownload(machine, image, '', '/hello');
  let bytes = Buffer.alloc(0);
  while (true) { const chunk = await download.read(65536); if (!chunk.length) break; bytes = Buffer.concat([bytes, chunk]); }
  assert.equal(await download.verify(), true); await download.close(); assert.equal(bytes.toString(), 'fixture bytes');
  await assert.rejects(factory.resolve(expected, origin, 'x'.repeat(43), () => true, pinned));
  assert.throws(() => new GuestHTTPS(origin, receipt.credential, undefined, 2, undefined, { ...pinned, serverName: 'bad.canaveral.invalid' }));
  assert.throws(() => new GuestHTTPS(origin, receipt.credential, undefined, 2, undefined, { ...pinned, sha256: '0'.repeat(64) }));
  // Coalesced head/body and pre-auth rejection on a real TLS connection.
  const ca = new X509Certificate(pinned.leafDER).toString();
  const raw = (payload) => new Promise((resolve, reject) => {
    const socket = tls.connect({ host: pinned.address, port: +port, servername: pinned.serverName, ca, minVersion: 'TLSv1.3' }, () => socket.end(payload));
    let response = ''; socket.on('data', data => response += data); socket.on('end', () => resolve(response)); socket.on('error', reject); socket.setTimeout(3000, () => { socket.destroy(); reject(Error('fixture timeout')); });
  });
  const nonce = Buffer.alloc(32, 7).toString('base64url');
  const reader = new GuestHTTPS(origin, receipt.credential, undefined, 2, guestBindingAuthorization(receipt.credential, receipt.assignment, undefined, nonce), pinned);
  const identity = await reader.call('/v1/identity', null); reader.closeAll();
  const authorization = guestBindingAuthorization(receipt.credential, receipt.assignment, identity.incarnation);
  assert.match(await raw(`POST /v1/files/list HTTP/1.1\r\nHost: fixture\r\nContent-Length: 12\r\nAuthorization: ${authorization}\r\n\r\n{"path":"/"}`), /200/);
  assert.match(await raw('POST /v1/files/list HTTP/1.1\r\nHost: fixture\r\nContent-Length: 11\r\nAuthorization: bad\r\n\r\n{"path":"/"}'), /401/);
  assert.equal(await raw('GET /v1/identity HTTP/1.1\r\nHost: fixture\r\nContent-Length: 1\r\n\r\nx'), '');
  assert.equal(await raw('GET /v1/identity HTTP/1.1\r\nX: ' + 'x'.repeat(4100)), '');
  assert.equal(await raw(`GET /v1/fixturework HTTP/1.1\r\nHost: fixture\r\nAuthorization: ${authorization}\r\n\r\n`), '', 'work deadline refuses a late response');
  const blockedWrite = tls.connect({ host: pinned.address, port: +port, servername: pinned.serverName, ca, minVersion: 'TLSv1.3' });
  blockedWrite.on('error', () => {});
  await new Promise((resolve, reject) => { blockedWrite.once('secureConnect', resolve); blockedWrite.once('error', reject); });
  blockedWrite.pause(); blockedWrite.write(`GET /v1/fixturewrite HTTP/1.1\r\nHost: fixture\r\nAuthorization: ${authorization}\r\n\r\n`);
  await new Promise(r => setTimeout(r, 1600));
  let written = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { blockedWrite.destroy(); reject(Error('write deadline fixture timeout')); }, 3000);
    blockedWrite.on('data', data => written += data.length); blockedWrite.on('close', () => { clearTimeout(timer); resolve(); }); blockedWrite.resume();
  });
  assert.ok(written < 64 * 1048576, 'blocked write must close before a full response');
  const stalledHead = tls.connect({ host: pinned.address, port: +port, servername: pinned.serverName, ca, minVersion: 'TLSv1.3' });
  stalledHead.on('error', () => {});
  await new Promise((resolve, reject) => { stalledHead.once('secureConnect', resolve); stalledHead.once('error', reject); });
  stalledHead.write('GET /v1/identity HTTP/1.1\r\n');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stalledHead.destroy(); reject(Error('head deadline fixture timeout')); }, 2500);
    stalledHead.once('close', () => { clearTimeout(timer); resolve(); }); stalledHead.resume();
  });
  // Slow-handshake peers are owned and expired; caps refuse additional peers.
  const sockets = Array.from({ length: 10 }, () => { const s = net.connect(+port, '127.0.0.1'); s.on('error', () => {}); return s; });
  let closedPeers = 0; for (const socket of sockets) socket.on('close', () => closedPeers++);
  await new Promise(r => setTimeout(r, 1400));
  assert.equal(closedPeers, 10, 'all slow TLS peers must be refused or expired');
  for (const s of sockets) s.destroy();
  // Fill the total cap with authenticated, incomplete bodies, without allocating them.
  const held = [];
  for (let index = 0; index < 32; index++) {
    const socket = tls.connect({ host: pinned.address, port: +port, servername: pinned.serverName, ca, minVersion: 'TLSv1.3' });
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    socket.write(`POST /v1/files/list HTTP/1.1\r\nHost: fixture\r\nContent-Length: 1000000\r\nAuthorization: ${authorization}\r\n\r\n`);
    held.push(socket); await new Promise(r => setTimeout(r, 5));
  }
  const refused = net.connect(+port, '127.0.0.1'); refused.on('error', () => {});
  await new Promise(r => setTimeout(r, 2400));
  for (const socket of held) socket.destroy(); refused.destroy();
  factory.closeAll();
  assert.equal(binding.authorized(), false);
  await assert.rejects(binding.call('/v1/files/list', { path: '/' }));
  await assert.rejects(factory.resolve(expected, origin, receipt.credential, () => true, pinned));
  // closeAll during an uncompleted TLS handshake must reject and stay closed.
  const stall = net.createServer(s => s.on('error', () => {}));
  await new Promise(r => stall.listen(0, '127.0.0.1', r));
  const transport = new GuestHTTPS(`https://127.0.0.1:${stall.address().port}`, receipt.credential, undefined, 2, undefined, pinned);
  const pending = transport.call('/v1/identity', null); transport.closeAll(); await assert.rejects(pending);
  await assert.rejects(transport.call('/v1/identity', null)); stall.close();
  const hanging = tls.createServer({ pfx: Buffer.from(receipt.tls.pkcs12, 'base64url'), passphrase: 'canaveral-launch-v2', minVersion: 'TLSv1.3' }, socket => socket.on('error', () => {}));
  await new Promise(r => hanging.listen(0, '127.0.0.1', r));
  const inFlight = new GuestHTTPS(`https://127.0.0.1:${hanging.address().port}`, receipt.credential, undefined, 2, undefined, pinned);
  const post = inFlight.call('/v1/files/list', { path: '/' });
  await new Promise(r => setTimeout(r, 50)); inFlight.closeAll();
  await assert.rejects(post, error => error.outcome === 'unknown'); hanging.close();
  console.log('Provider PKCS12 / Swift memory-only TLS / real GuestHTTPS / v2 / GuestHelperAccess verified');
} finally { factory.closeAll(); clearTimeout(watchdog); }
