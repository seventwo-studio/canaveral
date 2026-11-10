import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsumerClient, ConsumerError, ConsumerConfigurationError, credentialFile, LeaseClient, operationRequest, receiveFile, SessionConnection, Transport } from '../../src/sdk.ts';
import type { AccessSession, SessionChannel, SessionMessage, TransferFinish } from '../../src/sdk.ts';
import { TerminalClient } from '../../src/terminal-sdk.ts';
import { Inspections, receiveSnapshot, snapshot, snapshotSchema, validateSnapshot } from '../../src/accessibility-sdk.ts';
import { decodePng, DisplayClient, encodePng } from '../../src/visual-sdk.ts';
import { mobileNativeHelper } from '../../src/providers/mobile-native.ts';
const id = () => randomUUID(), key = randomBytes(32).toString('base64url');
class Wire implements SessionChannel {
  readonly sessionId = id();
  queue: Array<SessionMessage | null> = [];
  controls: Record<string, unknown>[] = [];
  bytes: Buffer[] = [];
  closes = 0;
  onControl: ((value: Record<string, unknown>) => void) | undefined;
  onBytes: ((value: Buffer) => void) | undefined;
  async sendControl(value: Record<string, unknown>) { this.controls.push(value); this.onControl?.(value); }
  async sendBytes(value: Uint8Array) { const b = Buffer.from(value); this.bytes.push(b); this.onBytes?.(b); }
  async receive(_timeoutMs = 30000): Promise<SessionMessage | null> { return this.queue.shift() ?? null; }
  close() { this.closes++; }
}
function client() { return new LeaseClient({ baseUrl: 'http://127.0.0.1:1', allowLoopbackHttp: true, leaseId: id(), leaseKey: key }); }
function bind(wire: Wire) {
  const lease = client(); let creates = 0, connects = 0;
  lease.createSession = async r => { creates++; return { ...r, leaseId: lease.id, generation: id(), protocol: 'canaveral-session-v1' }; };
  lease.connectSession = async () => { connects++; return wire; };
  return { lease, counts: () => ({ creates, connects }) };
}
function finish(bytes: Buffer): TransferFinish { return { type: 'finish', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
function frame(op: number, data: Uint8Array, fin = true): Buffer {
  const payload = Buffer.from(data), header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = (fin ? 128 : 0) | op;
  if (header.length === 2) header[1] = payload.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}
function fixtureSnapshot() { return snapshot('ios', [{ label: 'Window', frame: { x: 0, y: 0, width: 20, height: 10 }, children: [{ label: 'Continue', identifier: 'next', frame: { x: 1, y: 2, width: 4, height: 2 }, custom: { preserved: true } }] }]); }
function visualWire(): Wire {
  const wire = new Wire(), header = Buffer.alloc(24); header.writeUInt16BE(2, 0); header.writeUInt16BE(2, 2); header.writeUInt32BE(4, 20);
  const greeting = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), Buffer.alloc(4), header, Buffer.from('test')]);
  for (const byte of greeting) wire.queue.push(Buffer.from([byte])); wire.queue.push({ type: 'control', state: 'view-only' }); return wire;
}
function rectangle(x: number, y: number, width: number, height: number, encoding: number, data = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(12); [x, y, width, height].forEach((n, i) => b.writeUInt16BE(n, i * 2)); b.writeInt32BE(encoding, 8); return Buffer.concat([b, data]);
}
function update(wire: Wire, ...rects: Buffer[]) { const b = Buffer.alloc(4); b.writeUInt16BE(rects.length, 2); const data = Buffer.concat([b, ...rects]); for (let n = 0; n < data.length; n += 7) wire.queue.push(data.subarray(n, n + 7)); }

test('credential descriptors enforce private regular file, ownership and bounded token', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-credential-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'key'); writeFileSync(file, key + '\n', { mode: 0o600 }); assert.equal(credentialFile(file), key);
  if (process.platform !== 'win32') { chmodSync(file, 0o644); assert.throws(() => credentialFile(file), ConsumerConfigurationError); chmodSync(file, 0o600); }
  writeFileSync(file, 'x'.repeat(131)); assert.throws(() => credentialFile(file)); assert.throws(() => credentialFile(dir));
});
test('session admission validates UUID, timeout and byte budgets before side effects', async () => {
  const wire = new Wire(), { lease, counts } = bind(wire);
  await assert.rejects(lease.terminal(id(), 'primary', 0));
  await assert.rejects(lease.display(id(), 'primary', { maxFrameBytes: 3 }));
  await assert.rejects(lease.accessibility(id(), 'primary', 7 * 1048576));
  assert.deepEqual(counts(), { creates: 0, connects: 0 });
  assert.throws(() => client().createSession({ id: 'bad', member: 'primary', capability: 'pty' }));
});
test('terminal fragments, truncation, unknown exit status and idempotent close', async () => {
  const wire = new Wire(), terminal = new TerminalClient(wire, wire.sessionId);
  wire.queue.push(Buffer.from([0xe2]), Buffer.from([0x82, 0xac]), { type: 'truncated' }, Buffer.from('\x1b[0m'), { type: 'exited', exitCode: null });
  assert.deepEqual(await terminal.receive(), Buffer.from([0xe2])); assert.deepEqual(await terminal.receive(), Buffer.from([0x82, 0xac]));
  assert.deepEqual(await terminal.receive(), { type: 'truncated' }); assert.equal(terminal.truncated, true);
  assert.deepEqual(await terminal.receive(), Buffer.from('\x1b[0m')); assert.deepEqual(await terminal.receive(), { type: 'exited', exitCode: null });
  terminal.close(); assert.equal(wire.closes, 1); assert.equal(terminal.exited, true); assert.equal(terminal.closed, true);
  await assert.rejects(terminal.write('never sent')); assert.equal(wire.controls.length, 0);
});
test('terminal local validation preserves connection, and blocked read allows input/resize', async () => {
  const wire = new Wire(), terminal = new TerminalClient(wire, wire.sessionId);
  for (const text of ['\0', 'x'.repeat(16001), '🚀'.repeat(2000), '\ud800']) assert.throws(() => terminal.write(text));
  for (const dimensions of [[0, 20], [80, 501], [1.5, 20]]) assert.throws(() => terminal.resize(dimensions[0]!, dimensions[1]!));
  assert.throws(() => terminal.receive(NaN)); assert.throws(() => terminal.receive(-1));
  let done: ((value: null) => void) | undefined;
  wire.receive = () => new Promise(resolve => { done = resolve; });
  const reading = terminal.receive(1000); await Promise.resolve(); await terminal.write('hello\n'); await terminal.resize(120, 40);
  assert.equal(wire.controls.length, 2); done!(null); assert.equal(await reading, null); assert.equal(terminal.closed, false); terminal.close();
});
test('terminal interruptions and worker refusals retain correlation without peer text or replay', async () => {
  const wire = new Wire(), terminal = new TerminalClient(wire, wire.sessionId);
  wire.onControl = () => { throw new Error('private peer detail'); };
  await assert.rejects(terminal.write('once'), error => error instanceof ConsumerError && error.outcome === 'unknown' && error.requestId === wire.sessionId && !error.retryable && !error.message.includes('private'));
  await assert.rejects(terminal.write('once')); assert.equal(wire.controls.length, 1);
  for (const value of [{ type: 'truncated', extra: true }, { type: 'exited', exitCode: true }, Buffer.alloc(65537), { type: 'error', code: 'capability_unsupported', outcome: 'unknown', message: 'private provider path' }]) {
    const w = new Wire(); w.queue.push(value); const tty = new TerminalClient(w, w.sessionId);
    await assert.rejects(tty.receive(), error => error instanceof ConsumerError && error.outcome === 'unknown' && error.requestId === w.sessionId && !error.message.includes('private'));
    assert.equal(tty.closed, true);
  }
});
test('nine independent terminal attachments have separate input and close ownership', async () => {
  const wires = Array.from({ length: 9 }, () => new Wire()), terminals = wires.map(w => new TerminalClient(w, w.sessionId));
  await Promise.all(terminals.map(async (tty, i) => { await tty.resize(100 + i, 30 + i); await tty.write('terminal_' + i); }));
  terminals[0]!.close();
  for (let i = 0; i < 9; i++) { assert.equal(wires[i]!.controls.length, 2); assert.deepEqual(wires[i]!.controls[1], { action: 'shell-write', arguments: { text: 'terminal_' + i } }); assert.equal(terminals[i]!.closed, i === 0); }
  terminals.forEach(tty => tty.close());
});
test('verified multichunk downloads handle partial writer writes and preserve worker errors', async () => {
  const wire = new Wire(), { lease, counts } = bind(wire), source = Buffer.concat([Buffer.alloc(65536, 1), Buffer.from('tail')]);
  wire.queue.push({ type: 'begin', size: source.length }, source.subarray(0, 65536), source.subarray(65536), finish(source));
  const output: Buffer[] = [], result = await lease.download(id(), 'primary', '/guest/file', { write: bytes => { const b = Buffer.from(bytes.subarray(0, 127)); output.push(b); return b.length; } });
  assert.deepEqual(Buffer.concat(output), source); assert.equal(result.sha256, finish(source).sha256); assert.deepEqual(counts(), { creates: 1, connects: 1 }); assert.equal(wire.closes, 1);
  const failed = new Wire(), request = id(); failed.queue.push({ type: 'error', code: 'session_incomplete', message: 'private guest', outcome: 'unknown' });
  await assert.rejects(bind(failed).lease.download(request, 'primary', '/file', { write: data => data.length }), e => e instanceof ConsumerError && e.code === 'session_incomplete' && e.requestId === request && e.outcome === 'unknown');
});
test('download empty/digest rejection and upload durable finish use exact bounded binary bytes', async () => {
  for (const data of [Buffer.alloc(0), Buffer.from('content')]) {
    const wire = new Wire(), { lease } = bind(wire); wire.queue.push({ type: 'begin', size: data.length }, ...(data.length ? [data] : []), finish(data));
    assert.equal((await lease.download(id(), 'primary', '/file', { write: b => b.length })).bytes, data.length);
  }
  const bad = new Wire(), requestId = id(); bad.queue.push({ type: 'begin', size: 1 }, Buffer.from('x'), { ...finish(Buffer.from('x')), sha256: '0'.repeat(64) });
  await assert.rejects(bind(bad).lease.download(requestId, 'primary', '/file', { write: b => b.length }), e => e instanceof ConsumerError && e.outcome === 'unknown' && e.requestId === requestId);
  const up = new Wire(), data = Buffer.alloc(70000, 9); let offset = 0; up.queue.push({ ...finish(data), durable: true });
  await bind(up).lease.upload(id(), 'primary', '/file', { read: size => { const b = data.subarray(offset, offset + size); offset += b.length; return b; } }, data.length);
  assert.deepEqual(up.bytes.map(b => b.length), [65536, 4464]); assert.deepEqual(Buffer.concat(up.bytes), data); assert.equal(up.controls.length, 2);
  const uncertain = new Wire(); uncertain.queue.push({ ...finish(Buffer.alloc(0)), durable: false });
  await assert.rejects(bind(uncertain).lease.upload(id(), 'primary', '/file', { read: () => null }, 0), e => e instanceof ConsumerError && e.outcome === 'unknown');
});
test('snapshot schema, semantics and byte/digest validation preserve all native fields', async () => {
  const tree = fixtureSnapshot(), bytes = Buffer.from(JSON.stringify(tree)), wire = new Wire();
  wire.queue.push({ type: 'begin', schema: 'canaveral-accessibility-v1', size: bytes.length }, bytes.subarray(0, 91), bytes.subarray(91), finish(bytes));
  assert.deepEqual(await receiveSnapshot(wire, wire.sessionId), tree); assert.deepEqual(tree.nodes[1]!.properties.custom, { preserved: true }); assert.equal(snapshotSchema().$schema, 'https://json-schema.org/draft/2020-12/schema');
  for (const mutate of [(t: typeof tree) => { t.nodes[1]!.id = t.nodes[0]!.id; }, (t: typeof tree) => { t.nodes[1]!.parentId = 'missing'; }, (t: typeof tree) => { t.nodes[1]!.depth = 0; }, (t: typeof tree) => { t.nodes[1]!.bounds!.width = Infinity; }, (t: typeof tree) => { t.frame = {}; }]) { const invalid = structuredClone(tree); mutate(invalid); assert.throws(() => validateSnapshot(invalid)); }
  const bad = new Wire(); bad.queue.push({ type: 'begin', schema: 'canaveral-accessibility-v1', size: bytes.length }, bytes, { ...finish(bytes), sha256: '0'.repeat(64) }); await assert.rejects(receiveSnapshot(bad, bad.sessionId));
});
test('Android password redaction, XML refusal, immutable lineage and exact freshness expiry', () => {
  const tree = snapshot('android', 'status\n<hierarchy rotation="0"><node class="EditText" text="secret" password="true" bounds="[0,0][10,20]" clickable="true" /></hierarchy>');
  assert.equal(tree.nodes[0]!.name, ''); assert.equal(tree.nodes[0]!.properties.text, '[redacted]'); assert.throws(() => snapshot('android', '<!DOCTYPE x><hierarchy/>'));
  let now = 1; const cache = new Inspections(() => now), original = fixtureSnapshot(); cache.save('machine', original); original.nodes[1]!.name = 'caller mutated';
  const saved = cache.get('machine', original.snapshotId); assert.equal(saved.nodes[1]!.name, 'Continue'); assert.deepEqual(cache.target('machine', { snapshotId: saved.snapshotId, nodeId: saved.nodes[1]!.id }, saved), { x: 3, y: 3 });
  const changed = structuredClone(saved); changed.nodes[0]!.name = 'other window'; assert.throws(() => cache.target('machine', { snapshotId: saved.snapshotId, nodeId: saved.nodes[1]!.id }, changed));
  now = 16; assert.throws(() => cache.get('machine', saved.snapshotId)); now = 50; cache.save('machine', saved); now = 49; assert.throws(() => cache.get('machine', saved.snapshotId));
});
test('Raw RFB fragments, DesktopSize and complete PNG capture never fabricate missing pixels', async () => {
  const wire = visualWire(), display = await DisplayClient.connect(wire), red = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0]), blue = Buffer.from([0, 0, 255, 0, 0, 0, 255, 0]);
  wire.onBytes = b => { if (b[0] === 3) update(wire, rectangle(0, 0, 2, 1, 0, red), rectangle(0, 1, 2, 1, 0, blue)); };
  const decoded = decodePng(await display.screenshot(), 2, 2); assert.deepEqual([...decoded.rgb], [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  await assert.rejects(display.key(65)); assert.equal(display.closed, false); assert.equal(display.state, 'view-only');
  wire.onBytes = b => { if (b[0] === 3) { wire.onBytes = undefined; update(wire, rectangle(0, 0, 1, 1, 0, red.subarray(0, 4))); } };
  await assert.rejects(display.screenshot(100)); assert.equal(display.closed, true);
});
test('TightPNG/fill and injected JPEG decode honor dimensions and ownership', async () => {
  const wire = visualWire(), display = await DisplayClient.connect(wire, { decodeImage: (data, format, w, h, max) => {
    if (format === 'PNG') return decodePng(data, w, h, max);
    return { width: w, height: h, rgb: Buffer.alloc(w * h * 3, 42) }; // Fake decoder, no JPEG acceptance claim.
  } });
  const png = encodePng(3, 1, Buffer.from([7, 8, 9, 7, 8, 9, 7, 8, 9])); assert.ok(png.length < 128);
  wire.onBytes = b => { if (b[0] === 3) update(wire, rectangle(0, 0, 3, 1, -223), rectangle(0, 0, 3, 1, -260, Buffer.concat([Buffer.from([0xa0, png.length]), png]))); };
  assert.deepEqual([...decodePng(await display.screenshot(), 3, 1).rgb], [7, 8, 9, 7, 8, 9, 7, 8, 9]);
  wire.onBytes = b => { if (b[0] === 3) update(wire, rectangle(0, 0, 3, 1, -260, Buffer.from([0x80, 1, 2, 3]))); };
  assert.deepEqual([...decodePng(await display.screenshot(), 3, 1).rgb], [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  wire.onBytes = b => { if (b[0] === 3) update(wire, rectangle(0, 0, 3, 1, -260, Buffer.from([0x90, 1, 0xff]))); };
  assert.deepEqual([...decodePng(await display.screenshot(), 3, 1).rgb], Array(9).fill(42)); display.close();
});
test('lost display acknowledgement recovers by original UUID without input replay', async () => {
  const wire = visualWire(), display = await DisplayClient.connect(wire), requestId = id(); display.state = 'owned';
  assert.throws(() => display.action(requestId, 'text', { text: 'once' }, 0)); assert.equal(wire.controls.length, 0);
  await assert.rejects(display.action(requestId, 'text', { text: 'once' }, 50), e => e instanceof ConsumerError && e.requestId === requestId && e.outcome === 'unknown' && !e.retryable);
  await assert.rejects(display.action(requestId, 'text', { text: 'once' })); assert.equal(wire.controls.length, 1); assert.equal(display.closed, true);
  const fresh = visualWire(), recovery = await DisplayClient.connect(fresh); fresh.onControl = value => { fresh.queue.push({ type: 'action-result', id: value.id, state: 'succeeded', result: {} }); };
  const result = await recovery.receipt(requestId); assert.equal(result.id, requestId); assert.equal(result.state, 'succeeded'); assert.equal(recovery.state, 'view-only'); assert.deepEqual(fresh.controls, [{ type: 'action-receipt', id: requestId }]); recovery.close();
});
test('unknown display result disables further input; bad rectangles and PNG CRC fail closed', async () => {
  const wire = visualWire(), display = await DisplayClient.connect(wire); display.state = 'owned'; wire.onControl = value => { wire.queue.push({ type: 'action-result', id: value.id, state: 'unknown', result: {} }); };
  assert.equal((await display.action(id(), 'text', { text: 'once' })).state, 'unknown'); assert.equal(display.state, 'reset-uncertain'); await assert.rejects(display.pointer(0, 0)); assert.equal(display.closed, false);
  wire.onBytes = b => { if (b[0] === 3) update(wire, rectangle(1, 1, 2, 2, 0)); }; await assert.rejects(display.screenshot()); assert.equal(display.closed, true);
  const png = encodePng(1, 1, Buffer.from([1, 2, 3])); png[20] = png[20]! ^ 1; assert.throws(() => decodePng(png, 1, 1));
});
test('durable device operations retain complete intent and validate action-specific arguments', () => {
  for (const [action, args] of [['screenshot', {}], ['accessibility-action', { snapshotId: id(), nodeId: 'ax-1', nativeAction: 'click' }], ['push', { path: '/file', data: 'AA==', app: 'com.example.app' }], ['shell', { argv: ['printf', 'hello'] }], ['shell-resize', { session: id(), rows: 40, cols: 120 }]] as const) {
    const request = { id: id(), member: 'secondary', action, arguments: args }; assert.deepEqual(operationRequest(request), request);
  }
  assert.throws(() => operationRequest({ id: id(), member: 'primary', action: 'shell', arguments: { argv: ['-host-command'] } }));
  assert.throws(() => operationRequest({ id: id(), member: 'primary', action: 'tap', arguments: { x: 1, y: NaN } }));
});
test('platform-selected staged publication preserves verified bytes and explicit replacement', async t => {
  if (process.platform === 'darwin' && !existsSync(mobileNativeHelper({}))) { t.skip('Build canaveral-mobile-native for disposable publication fixtures.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'sdk-download-')); t.after(() => rmSync(dir, { recursive: true, force: true })); const target = join(dir, 'output'); let transfers = 0;
  const transfer = async (writer: { write(bytes: Uint8Array): Promise<number> | number }) => { transfers++; const data = Buffer.from('verified'); await writer.write(data); return finish(data); };
  await receiveFile(target, transfer); assert.equal(await readFile(target, 'utf8'), 'verified'); await assert.rejects(receiveFile(target, transfer)); assert.equal(transfers, 1);
  await receiveFile(target, async writer => { await writer.write(Buffer.from('replacement')); return finish(Buffer.from('replacement')); }, true); assert.equal(await readFile(target, 'utf8'), 'replacement');
  const output = join(dir, 'second'); await assert.rejects(receiveFile(output, async writer => { await writer.write(Buffer.from('partial')); throw new Error('digest'); })); await assert.rejects(readFile(output)); assert.deepEqual((await readdir(dir)).filter(n => n.startsWith('.canaveral-')), []);
});

test('real HTTP session intent loss and operation loss retain UUIDs, no replay, scope isolation', async t => {
  const leaseId = id(), sessionId = id(), generation = id(), operationId = id(), requests: Array<{ path: string; bearer: string; body: string }> = [];
  const session = { id: sessionId, leaseId, generation, protocol: 'canaveral-session-v1', capability: 'pty', member: 'primary' };
  const operation = { id: operationId, leaseId, member: 'secondary', state: 'succeeded', updatedAt: '2026-01-01T00:00:00Z', result: {} };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b)); requests.push({ path: req.url!, bearer: req.headers.authorization!, body: Buffer.concat(chunks).toString() });
    if (req.method === 'POST') { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url?.includes('operations') ? operation : session));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); }); const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const lease = new LeaseClient({ baseUrl, allowLoopbackHttp: true, leaseId, leaseKey: key });
  await assert.rejects(lease.createSession({ id: sessionId, member: 'primary', capability: 'pty' }), e => e instanceof ConsumerError && e.requestId === sessionId && e.outcome === 'unknown' && !e.retryable);
  assert.deepEqual(await lease.session(sessionId), session); assert.equal(requests.length, 2);
  await assert.rejects(lease.createOperation({ id: operationId, member: 'secondary', action: 'tap', arguments: { x: 1, y: 2 } }), e => e instanceof ConsumerError && e.requestId === operationId && e.outcome === 'unknown');
  assert.deepEqual(await lease.operation(operationId), operation); assert.equal(requests.length, 4); assert.ok(requests.every(r => r.bearer === 'Bearer ' + key)); assert.equal('rotateLeaseCredential' in lease, false);
});
test('real WebSocket upgrade auth, binary fragmentation, masked writes and ready binding', async t => {
  const leaseId = id(), sessionId = id(), generation = id(); let upgrades = 0; const sent: Buffer[] = [];
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    upgrades++; assert.equal(request.headers.authorization, 'Bearer ' + key); assert.equal(request.url, `/v1/leases/${leaseId}/sessions/${sessionId}/${generation}`);
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(Buffer.concat([frame(1, Buffer.from(JSON.stringify({ type: 'ready', sessionId, generation, capability: 'pty' }))), frame(2, Buffer.from([0xe2]), false), frame(0, Buffer.from([0x82, 0xac])), frame(1, Buffer.from(JSON.stringify({ type: 'error', code: 'capability_unsupported', outcome: 'unknown', message: 'private provider' })))]));
    socket.on('data', (b: Buffer) => sent.push(b)); socket.on('error', () => {});
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port, lease = new LeaseClient({ baseUrl, allowLoopbackHttp: true, leaseId, leaseKey: key });
  const connection = await lease.connectSession({ id: sessionId, leaseId, member: 'primary', generation, capability: 'pty', protocol: 'canaveral-session-v1' }); t.after(() => connection.close());
  assert.deepEqual(await connection.receive(1000), Buffer.from('€')); const refusal = await connection.receive(1000); assert.equal((refusal as Record<string, unknown>).code, 'capability_unsupported');
  await assert.rejects(connection.sendControl({ action: 'shell-write', arguments: { text: 'not sent' } }), e => e instanceof ConsumerError && e.code === 'capability_unsupported'); assert.equal(upgrades, 1); assert.equal(sent.length, 0);
});
test('session redirects are refused without a second origin request', async t => {
  let requests = 0; const server = http.createServer((_req, res) => { requests++; res.writeHead(302, { Location: 'http://127.0.0.1:1/private' }); res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const transport = new Transport({ baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, allowLoopbackHttp: true }, key);
  await assert.rejects(SessionConnection.connect(transport, `/v1/leases/${id()}/sessions/${id()}/${id()}`, id()), e => e instanceof ConsumerError && e.code === 'redirect_refused'); assert.equal(requests, 1);
});

test('WebSocket masked outbound text/binary, control byte limits and oversize inbound refusal', async t => {
  const sessionId = id(), server = http.createServer(), messages: Array<{ opcode: number; data: Buffer }> = [];
  let acknowledge: (() => void) | undefined; const received = new Promise<void>(resolve => { acknowledge = resolve; });
  server.on('upgrade', (request, socket) => {
    socket.on('error', () => {});
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        assert.ok(buffer[1]! & 128); let n = buffer[1]! & 127, offset = 2;
        if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); offset = 4; }
        else if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + 4 + n) return;
        const mask = buffer.subarray(offset, offset + 4), data = Buffer.alloc(n); for (let i = 0; i < n; i++) data[i] = buffer[offset + 4 + i]! ^ mask[i % 4]!;
        messages.push({ opcode: buffer[0]! & 15, data }); buffer = buffer.subarray(offset + 4 + n);
        if (messages.length === 2) { acknowledge!(); socket.write(frame(2, Buffer.alloc(65537))); }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const connection = await SessionConnection.connect(new Transport({ baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, allowLoopbackHttp: true }, key), `/v1/leases/${id()}/sessions/${sessionId}/${id()}`, sessionId); t.after(() => connection.close());
  assert.throws(() => connection.sendBytes(Buffer.alloc(65537))); assert.throws(() => connection.sendControl({ text: '🚀'.repeat(2000) }));
  await connection.sendControl({ action: 'shell-write', arguments: { text: '€\n' } }); await connection.sendBytes(Buffer.alloc(65536, 9)); await received;
  assert.deepEqual(JSON.parse(messages[0]!.data.toString()), { action: 'shell-write', arguments: { text: '€\n' } }); assert.equal(messages[0]!.opcode, 1); assert.equal(messages[1]!.opcode, 2); assert.deepEqual(messages[1]!.data, Buffer.alloc(65536, 9));
  await assert.rejects(connection.receive(1000), e => e instanceof ConsumerError && e.code === 'session_protocol_error');
});

test('explicit scoped credential rotation is non-idempotent, never retried, and separate from loading a key', async t => {
  const leaseId = id(), appKey = randomBytes(32).toString('base64url'), scopedKey = randomBytes(32).toString('base64url'); let rotations = 0; const bearers: string[] = [];
  const view = { id: leaseId, state: 'ready', runtimeState: 'running', revision: 1, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T01:00:00Z', cleanup: { state: 'notRequested' }, members: [], capabilities: {} };
  const server = http.createServer((req, res) => {
    bearers.push(req.headers.authorization!);
    if (req.url?.endsWith('/credential')) { rotations++; if (rotations === 1) { req.socket.destroy(); return; } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: leaseId, credential: scopedKey })); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(view)); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port, app = new ConsumerClient({ baseUrl, allowLoopbackHttp: true, applicationKey: appKey });
  await assert.rejects(app.scopedLease(leaseId), e => e instanceof ConsumerError && e.outcome === 'unknown' && e.requestId === undefined && !e.retryable); assert.equal(rotations, 1);
  assert.deepEqual(await app.inspectLease(leaseId), view); assert.equal(rotations, 1);
  const scoped = await app.scopedLease(leaseId); assert.deepEqual(await scoped.inspect(), view); assert.equal(rotations, 2); assert.deepEqual(bearers, ['Bearer ' + appKey, 'Bearer ' + appKey, 'Bearer ' + appKey, 'Bearer ' + scopedKey]);
});

test('WebSocket HTTPS uses pinned CA, refuses unrelated CA/default trust and hostname mismatch before attachment', async t => {
  const { spawnSync } = await import('node:child_process'), https = await import('node:https');
  const dir = mkdtempSync(join(tmpdir(), 'sdk-session-tls-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certificate = async (name: string, san: string) => {
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, name + '.key'), '-out', join(dir, name + '.pem'), '-days', '2', '-subj', '/CN=fixture', '-addext', 'subjectAltName=' + san], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return { key: await readFile(join(dir, name + '.key')), cert: await readFile(join(dir, name + '.pem')), caFile: join(dir, name + '.pem') };
  };
  const good = await certificate('good', 'IP:127.0.0.1'), wrong = await certificate('wrong', 'DNS:unrelated.example'); let attachments = 0;
  const listener = async (credentials: typeof good) => {
    const server = https.createServer({ key: credentials.key, cert: credentials.cert });
    server.on('upgrade', (request, socket) => {
      attachments++; assert.equal(request.headers.authorization, 'Bearer ' + key); socket.on('error', () => {});
      const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      socket.write(frame(2, Buffer.from('encrypted fixture')));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
    return 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
  };
  const baseUrl = await listener(good), mismatch = await listener(wrong), path = `/v1/leases/${id()}/sessions/${id()}/${id()}`;
  const connection = await SessionConnection.connect(new Transport({ baseUrl, caFile: good.caFile }, key), path, id()); t.after(() => connection.close());
  assert.deepEqual(await connection.receive(1000), Buffer.from('encrypted fixture')); connection.close(); assert.equal(attachments, 1);
  for (const options of [{ baseUrl }, { baseUrl, caFile: wrong.caFile }, { baseUrl: mismatch, caFile: wrong.caFile }]) await assert.rejects(SessionConnection.connect(new Transport(options, key), path, id()));
  assert.equal(attachments, 1);
  assert.throws(() => new ConsumerClient({ baseUrl, applicationKey: key, caFile: join(dir, 'missing') }));
});

test('provider inspection dispatch preserves cache ownership, frame separation and headless refusal', async () => {
  const { inspectProvider } = await import('../../src/accessibility-sdk.ts');
  const calls: Record<string, unknown>[] = [];
  const provider: import('../../src/accessibility-sdk.ts').InspectionProvider = {
    control: (_machine, _image, _folder, request) => { calls.push(request); return request.action === 'hierarchy' ? { label: 'Target', frame: { x: 0, y: 0, width: 4, height: 2 } } : { synthetic: true }; },
  };
  await assert.rejects(inspectProvider(provider, { id: 'machine' }, { os: 'ios', mode: 'headless' }, null, true, () => 10)); assert.equal(calls.length, 0);
  const value = await inspectProvider(provider, { id: 'machine' }, { os: 'ios', mode: 'desktop' }, null, true, () => 10);
  assert.deepEqual(value.frame, { synthetic: true }); assert.equal(Object.hasOwn(provider.inspections!.get('machine', value.snapshotId), 'frame'), false); assert.equal(calls.length, 2);
  assert.equal(snapshot('android', '<hierarchy/>').nodes.length, 0); assert.throws(() => snapshot('android', '<hierarchy></hierarchy><')); assert.throws(() => snapshot('android', '<hierarchy></hierarchy><hierarchy/>'));
  assert.throws(() => client().createSession({ id: id() + '\n', member: 'primary', capability: 'pty' }));
});

test('checkout examples run with Node strip-only against the normal emitted SDK build', async () => {
  const { spawnSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const name of ['lease_lifecycle', 'lease_operation', 'lease_accessibility', 'lease_download', 'lease_display']) {
    const result = spawnSync(process.execPath, [`examples/${name}.ts`, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, name + ': ' + result.stderr + result.stdout); assert.ok(result.stdout.includes('--help')); assert.ok(result.stdout.includes('--credential-file'));
  }
});
