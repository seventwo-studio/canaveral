/** Portable publication fixtures: disposable files and injected Win32 handles only.
 * No device, guest, PTY, signing, GUI or production native provider is exercised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, stat, symlink, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerDownloadFiles, windowsDownloadFiles } from '../../src/sdk-files.ts';
import type { DownloadDirectory, DownloadFiles, PublishResult, WindowsPublicationAPI } from '../../src/sdk-files.ts';
import { ConsumerError, LeaseClient, receiveFile, SessionError } from '../../src/sdk.ts';
import type { TransferFinish, Writer } from '../../src/sdk.ts';
import { nativeContainerFiles, mobileNativeHelper } from '../../src/providers/mobile-native.ts';
import type { DirectoryEntry, FileIdentity, Handle } from '../../src/guest/windows/files.ts';
import { ServiceError } from '../../src/errors.ts';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const receipt = (bytes: Buffer): TransferFinish => ({ type: 'finish', bytes: bytes.length, sha256: digest(bytes) });
const payload = Buffer.alloc(150000, 17);
async function writeAll(writer: Writer, data: Buffer): Promise<void> {
  for (let at = 0; at < data.length;) { const n = await writer.write(data.subarray(at, at + 65536)); assert.ok(Number.isInteger(n) && n > 0 && n <= Math.min(65536, data.length - at)); at += n; }
}
const transfer = (data = payload) => async (writer: Writer) => { await writeAll(writer, data); return receipt(data); };
const posixFiles = (): DownloadFiles => containerDownloadFiles(nativeContainerFiles(mobileNativeHelper({})));
const posixFixtureSkip = process.platform === 'win32' ? 'POSIX helper fixture; Windows uses injected handle fixtures below.' :
  existsSync(mobileNativeHelper({})) ? false : 'Build canaveral-mobile-native to run disposable scoped-helper filesystem fixtures.';
function wrap(files: DownloadFiles, mutate: (directory: DownloadDirectory) => DownloadDirectory): DownloadFiles {
  return { openDirectory: async path => mutate(await files.openDirectory(path)) };
}
async function temporary(t: TestContext) { const path = await mkdtemp(join(tmpdir(), 'sdk-publication-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const outcome = (code: string) => (error: unknown) => error instanceof ConsumerError && error.code === code;

test('scoped POSIX helper publishes complete private multichunk/empty downloads and refuses existing/dangling targets', { skip: posixFixtureSkip }, async t => {
  const parent = await temporary(t), files = posixFiles(), target = join(parent, 'result');
  assert.deepEqual(await receiveFile(target, transfer(), false, randomUUID(), files), receipt(payload));
  assert.deepEqual(await readFile(target), payload); assert.equal((await stat(target)).mode & 0o777, 0o600);
  let calls = 0; await assert.rejects(receiveFile(target, async writer => { calls++; return transfer()(writer); }, false, randomUUID(), files), outcome('download_destination_exists')); assert.equal(calls, 0);
  const dangling = join(parent, 'dangling'); await symlink(join(parent, 'absent'), dangling);
  await assert.rejects(receiveFile(dangling, async writer => { calls++; return transfer()(writer); }, false, randomUUID(), files), outcome('download_destination_exists')); assert.equal(calls, 0);
  await receiveFile(join(parent, 'empty'), transfer(Buffer.alloc(0)), false, randomUUID(), files); assert.equal((await readFile(join(parent, 'empty'))).length, 0);
  assert.deepEqual((await readdir(parent)).filter(n => n.startsWith('.canaveral-download-')), []);
});
test('scoped POSIX helper retains parent descriptors across rename and refuses a competing writer atomically', { skip: posixFixtureSkip }, async t => {
  const parent = await temporary(t), original = join(parent, 'original'), moved = join(parent, 'moved'); await mkdir(original);
  const target = join(original, 'result'); await writeFile(target, 'old');
  await receiveFile(target, async writer => {
    await writeAll(writer, payload); assert.equal(await readFile(target, 'utf8'), 'old');
    await rename(original, moved); await mkdir(original); await writeFile(join(original, 'result'), 'other directory'); return receipt(payload);
  }, true, randomUUID(), posixFiles());
  assert.deepEqual(await readFile(join(moved, 'result')), payload); assert.equal(await readFile(target, 'utf8'), 'other directory');
  const race = join(original, 'race'); let publishes = 0;
  const files = wrap(posixFiles(), dir => ({ ...dir, publishOwned: async (...args) => { publishes++; return dir.publishOwned(...args); } }));
  await assert.rejects(receiveFile(race, async writer => { await writeAll(writer, payload); await writeFile(race, 'competing writer'); return receipt(payload); }, false, randomUUID(), files), outcome('download_destination_exists'));
  assert.equal(publishes, 1); assert.equal(await readFile(race, 'utf8'), 'competing writer'); assert.deepEqual((await readdir(original)).filter(n => n.startsWith('.canaveral-download-')), []);
});
test('scoped POSIX flush failure and interrupted transfer preserve old bytes; lost publication/sync stay unknown', { skip: posixFixtureSkip }, async t => {
  const parent = await temporary(t), target = join(parent, 'result'), requestId = randomUUID(); await writeFile(target, 'old');
  const syncFailure = wrap(posixFiles(), dir => ({ ...dir, createExclusive: async name => { const stage = await dir.createExclusive(name); return { ...stage, sync: async () => { throw new Error('fixture full'); } }; } }));
  await assert.rejects(receiveFile(target, transfer(), true, requestId, syncFailure), outcome('download_destination_failed')); assert.equal(await readFile(target, 'utf8'), 'old');
  await assert.rejects(receiveFile(target, async writer => { await writer.write(Buffer.from('partial')); throw new SessionError('private interruption', 'session_incomplete', requestId); }, true, requestId, posixFiles()), error => error instanceof ConsumerError && error.code === 'session_incomplete' && error.requestId === requestId && error.outcome === 'unknown' && error.message.includes('not replaced'));
  assert.equal(await readFile(target, 'utf8'), 'old');
  let attempts = 0; const lost = wrap(posixFiles(), dir => ({ ...dir, publishOwned: async (...args) => { attempts++; await dir.publishOwned(...args); throw new Error('receipt lost'); } }));
  await assert.rejects(receiveFile(target, transfer(), true, requestId, lost), error => error instanceof ConsumerError && error.code === 'download_publication_uncertain' && error.outcome === 'unknown' && error.requestId === requestId && !error.retryable);
  assert.equal(attempts, 1); assert.deepEqual(await readFile(target), payload);
  const directorySyncFailure = wrap(posixFiles(), dir => ({ ...dir, sync: async () => { throw new Error('directory sync'); } }));
  await assert.rejects(receiveFile(target, transfer(Buffer.from('next')), true, requestId, directorySyncFailure), outcome('download_publication_uncertain')); assert.equal(await readFile(target, 'utf8'), 'next');
  assert.deepEqual((await readdir(parent)).filter(n => n.startsWith('.canaveral-download-')), []);
});
test('scoped POSIX cleanup failure and temporary collision preserve foreign files without publication', { skip: posixFixtureSkip }, async t => {
  const parent = await temporary(t), target = join(parent, 'result'); await writeFile(target, 'old');
  const cleanupFailure = wrap(posixFiles(), dir => ({ ...dir, removeOwned: async () => { throw new Error('cleanup refused'); } }));
  await assert.rejects(receiveFile(target, async writer => { await writer.write(Buffer.from('partial')); throw new Error('digest'); }, true, randomUUID(), cleanupFailure), outcome('download_temporary_cleanup_failed')); assert.equal(await readFile(target, 'utf8'), 'old');
  const leaked = (await readdir(parent)).filter(n => n.startsWith('.canaveral-download-')); assert.equal(leaked.length, 1);
  let collision: string | undefined, transfers = 0;
  const files = wrap(posixFiles(), dir => ({ ...dir, createExclusive: async name => { collision = name; await writeFile(join(parent, name), 'foreign', { flag: 'wx' }); return dir.createExclusive(name); } }));
  await assert.rejects(receiveFile(join(parent, 'new'), async writer => { transfers++; return transfer()(writer); }, false, randomUUID(), files));
  assert.equal(transfers, 0); assert.equal(await readFile(join(parent, collision!), 'utf8'), 'foreign'); await assert.rejects(readFile(join(parent, 'new')));
});

class WinNode {
  readonly id = randomUUID().replaceAll('-', '');
  readonly children = new Map<string, WinNode>();
  data = Buffer.alloc(0); changed = 1; reparsed = false; deleted = false;
  parent: WinNode | undefined; name = '';
  constructor(readonly directory = false) {}
}
class WindowsFixture implements WindowsPublicationAPI {
  readonly driveNode = new WinNode(true); readonly directory = new WinNode(true); readonly handles = new Map<string, WinNode>();
  publications = 0; discards = 0; stops = 0; flushes = 0; failFlush = false; losePublication = false; failClose = false;
  constructor() { this.driveNode.children.set('downloads', this.directory); }
  bind(node: WinNode) { const h = randomUUID(); this.handles.set(h, node); return h; }
  node(handle: Handle): WinNode { const n = this.handles.get(handle); assert.ok(n, 'retained handle'); return n; }
  drive(drive: string) { assert.equal(drive, 'C:'); return this.bind(this.driveNode); }
  open(parent: Handle, name: string, directory: boolean) { const node = this.node(parent).children.get(name.toLowerCase()); assert.ok(node); assert.equal(node.directory, directory); return this.bind(node); }
  info(handle: Handle): FileIdentity { const n = this.node(handle); return { volume: 'fixture-volume', fileId: n.id, size: n.data.length, written: String(n.changed), changed: String(n.changed), links: 1, directory: n.directory, attributes: (n.directory ? 16 : 128) | (n.reparsed ? 1024 : 0) }; }
  read(handle: Handle, offset: number, count: number) { return this.node(handle).data.subarray(offset, offset + count); }
  async *entries(handle: Handle): AsyncIterable<DirectoryEntry> { for (const [name, n] of this.node(handle).children) yield { name, kind: n.directory ? 'directory' : 'file', size: n.data.length, modifiedAt: 0, attributes: n.directory ? 16 : 128, reparseTag: 0, nativeFileId: n.id }; }
  close(handle: Handle) {
    if (this.failClose) throw new Error('fixture handle release'); const node = this.node(handle); this.handles.delete(handle);
    if (node.deleted && node.parent?.children.get(node.name) === node) node.parent.children.delete(node.name);
  }
  create(parent: Handle, name: string) {
    const directory = this.node(parent), key = name.toLowerCase(); if (directory.children.has(key)) throw new Error('fixture collision');
    const node = new WinNode(); node.parent = directory; node.name = key; directory.children.set(key, node); return this.bind(node);
  }
  write(handle: Handle, offset: number, data: Buffer) { const node = this.node(handle); assert.equal(offset, node.data.length); const n = Math.min(7777, data.length); node.data = Buffer.concat([node.data, data.subarray(0, n)]); node.changed++; return n; }
  flush() { this.flushes++; if (this.failFlush) throw new Error('fixture disk full'); }
  discard(handle: Handle) { this.discards++; this.node(handle).deleted = true; }
  exists(parent: Handle, name: string) { return this.node(parent).children.has(name.toLowerCase()); }
  publishOwned(handle: Handle, parent: Handle, name: string, replace = false): PublishResult {
    this.publications++; const node = this.node(handle), directory = this.node(parent), key = name.toLowerCase();
    assert.equal(directory, node.parent); assert.equal(directory.children.get(node.name), node);
    if (!replace && directory.children.has(key)) return 'exists';
    directory.children.delete(node.name); directory.children.set(key, node); node.name = key; node.changed++;
    if (this.losePublication) throw new Error('publication reply lost'); return 'published';
  }
  put(name: string, bytes: string, reparsed = false) { const n = new WinNode(); n.data = Buffer.from(bytes); n.reparsed = reparsed; n.parent = this.directory; n.name = name.toLowerCase(); this.directory.children.set(n.name, n); return n; }
  value(name = 'result') { return this.directory.children.get(name.toLowerCase())?.data; }
  files(): DownloadFiles {
    const files = windowsDownloadFiles(async () => ({ api: this, close: async () => { this.stops++; this.handles.clear(); return true; } }));
    return { openDirectory: () => files.openDirectory('C:\\downloads') };
  }
}
test('Windows bridge adapter stages partial writes, flushes, publishes once and never discards a published handle', async () => {
  const fixture = new WindowsFixture(); assert.deepEqual(await receiveFile('result', transfer(), false, randomUUID(), fixture.files()), receipt(payload));
  assert.deepEqual(fixture.value(), payload); assert.equal(fixture.publications, 1); assert.equal(fixture.discards, 0); assert.equal(fixture.flushes, 1); assert.equal(fixture.stops, 1); assert.equal(fixture.handles.size, 0); assert.deepEqual([...fixture.directory.children.keys()], ['result']);
  await receiveFile('empty', transfer(Buffer.alloc(0)), false, randomUUID(), fixture.files()); assert.equal(fixture.value('empty')!.length, 0);
});
test('Windows existing/reparsed destinations and concurrent writers remain untouched; replacement is explicit', async () => {
  for (const reparsed of [false, true]) {
    const fixture = new WindowsFixture(); fixture.put('result', 'original', reparsed); let calls = 0;
    await assert.rejects(receiveFile('result', async writer => { calls++; return transfer()(writer); }, false, randomUUID(), fixture.files()), outcome('download_destination_exists')); assert.equal(calls, 0); assert.equal(fixture.publications, 0); assert.equal(fixture.value()!.toString(), 'original');
  }
  const fixture = new WindowsFixture();
  await assert.rejects(receiveFile('result', async writer => { await writeAll(writer, payload); fixture.put('result', 'racer'); return receipt(payload); }, false, randomUUID(), fixture.files()), outcome('download_destination_exists')); assert.equal(fixture.value()!.toString(), 'racer'); assert.equal(fixture.publications, 1); assert.equal(fixture.discards, 1);
  await receiveFile('result', async writer => { assert.equal(fixture.value()!.toString(), 'racer'); await writeAll(writer, payload); assert.equal(fixture.value()!.toString(), 'racer'); return receipt(payload); }, true, randomUUID(), fixture.files()); assert.deepEqual(fixture.value(), payload);
});
test('Windows failed digest/flush preserves old bytes and unknown rename never discards or replays input', async () => {
  const fixture = new WindowsFixture(); fixture.put('result', 'original'); fixture.failFlush = true;
  await assert.rejects(receiveFile('result', transfer(), true, randomUUID(), fixture.files()), outcome('download_destination_failed')); assert.equal(fixture.value()!.toString(), 'original'); assert.equal(fixture.publications, 0);
  fixture.failFlush = false; const requestId = randomUUID();
  await assert.rejects(receiveFile('result', async writer => { await writer.write(Buffer.from('part')); throw new SessionError('Digest mismatch', 'session_incomplete', requestId); }, true, requestId, fixture.files()), error => error instanceof ConsumerError && error.requestId === requestId && error.outcome === 'unknown' && error.code === 'session_incomplete');
  assert.equal(fixture.value()!.toString(), 'original'); const discards = fixture.discards; fixture.losePublication = true;
  await assert.rejects(receiveFile('result', transfer(), true, requestId, fixture.files()), error => error instanceof ConsumerError && error.code === 'download_publication_uncertain' && error.outcome === 'unknown' && !error.retryable);
  assert.deepEqual(fixture.value(), payload); assert.equal(fixture.publications, 1); assert.equal(fixture.discards, discards); assert.equal(fixture.handles.size, 0);
});
test('Windows ownership changes and temporary collisions fail without adopting or deleting foreign entries', async () => {
  const fixture = new WindowsFixture(); const files = windowsDownloadFiles(async () => ({ api: fixture, close: async () => { fixture.handles.clear(); return true; } }));
  const directory = await files.openDirectory('C:\\downloads'), stage = await directory.createExclusive('.private'); await stage.write(Buffer.from('data'));
  const node = fixture.directory.children.get('.private')!; node.reparsed = true;
  await assert.rejects(directory.publishOwned('.private', 'result', true)); assert.equal(fixture.publications, 0); await assert.rejects(directory.removeOwned('.private')); assert.equal(fixture.discards, 0); await directory.close();
  const collision = new WindowsFixture(); let foreign: string | undefined;
  const injected = wrap(collision.files(), dir => ({ ...dir, createExclusive: async name => { foreign = name; collision.put(name, 'foreign'); return dir.createExclusive(name); } }));
  let calls = 0; await assert.rejects(receiveFile('result', async writer => { calls++; return transfer()(writer); }, false, randomUUID(), injected)); assert.equal(calls, 0); assert.equal(collision.value(foreign!)!.toString(), 'foreign'); assert.equal(collision.discards, 0);
});
test('LeaseClient uses the injected Windows publication adapter with exactly one streamed session', async () => {
  const fixture = new WindowsFixture(), sessionId = randomUUID(), lease = new LeaseClient({ baseUrl: 'http://127.0.0.1:1', allowLoopbackHttp: true, leaseId: randomUUID(), leaseKey: 'x'.repeat(43) });
  let downloads = 0;
  lease.download = async (request, member, path, writer) => { downloads++; assert.equal(request, sessionId); assert.equal(member, 'primary'); assert.equal(path, '/guest/file'); return transfer()(writer); };
  await lease.downloadToFile(sessionId, 'primary', '/guest/file', 'result', { files: fixture.files() }); assert.equal(downloads, 1); assert.deepEqual(fixture.value(), payload);
  await assert.rejects(lease.downloadToFile(sessionId, 'primary', '/guest/file', 'result', { files: fixture.files() }), outcome('download_destination_exists')); assert.equal(downloads, 1);
});

test('actual SDK download stream verifies digest before publication and preserves received worker refusal metadata', { skip: posixFixtureSkip }, async t => {
  const parent = await temporary(t), target = join(parent, 'result'); await writeFile(target, 'original');
  const sessionId = randomUUID(), lease = new LeaseClient({ baseUrl: 'http://127.0.0.1:1', allowLoopbackHttp: true, leaseId: randomUUID(), leaseKey: 'x'.repeat(43) });
  let creates = 0, connects = 0, closes = 0;
  const messages: Array<Buffer | Record<string, unknown>> = [{ type: 'begin', size: 4 }, Buffer.from('data'), { ...receipt(Buffer.from('data')), sha256: '0'.repeat(64) }];
  lease.createSession = async request => { creates++; return { ...request, leaseId: lease.id, generation: randomUUID(), protocol: 'canaveral-session-v1' }; };
  lease.connectSession = async () => { connects++; return { sessionId, sendControl: async () => {}, sendBytes: async () => {}, receive: async () => messages.shift() ?? null, close: () => { closes++; } }; };
  await assert.rejects(lease.downloadToFile(sessionId, 'primary', '/guest/file', target, { replace: true, files: posixFiles() }), error => error instanceof ConsumerError && error.code === 'session_incomplete' && error.requestId === sessionId && error.outcome === 'unknown');
  assert.equal(await readFile(target, 'utf8'), 'original'); assert.equal(creates, 1); assert.equal(connects, 1); assert.equal(closes, 1);
  messages.push({ type: 'error', code: 'capability_unsupported', message: 'private provider text', outcome: 'unknown' });
  await assert.rejects(lease.downloadToFile(sessionId, 'primary', '/guest/file', target, { replace: true, files: posixFiles() }), error => error instanceof ConsumerError && error.code === 'capability_unsupported' && error.requestId === sessionId && error.outcome === 'unknown' && !error.message.includes('private provider'));
  assert.equal(await readFile(target, 'utf8'), 'original'); assert.deepEqual((await readdir(parent)).filter(n => n.startsWith('.canaveral-download-')), []);
});
test('typed publication failures stay unknown and unacknowledged Windows stage creation is never adopted', async () => {
  const fixture = new WindowsFixture(); fixture.put('result', 'original');
  const typedFailure = wrap(fixture.files(), dir => ({ ...dir, publishOwned: async () => { throw new SessionError('lost typed publication', 'local_publication_error', undefined, false); } }));
  await assert.rejects(receiveFile('result', transfer(), true, randomUUID(), typedFailure), error => error instanceof ConsumerError && error.code === 'download_publication_uncertain' && error.outcome === 'unknown');
  const lost = new WindowsFixture(); const original = lost.create.bind(lost);
  lost.create = (parent, name) => { original(parent, name); throw new ServiceError('fixture lost creation reply', 409, { outcome: 'unknown' }); };
  const requestId = randomUUID(); let calls = 0;
  await assert.rejects(receiveFile('result', async writer => { calls++; return transfer()(writer); }, false, requestId, lost.files()), error => error instanceof ConsumerError && error.code === 'download_temporary_cleanup_failed' && error.outcome === 'unknown' && error.requestId === requestId);
  assert.equal(calls, 0); assert.equal(lost.discards, 0); assert.equal(lost.publications, 0); assert.equal(lost.value(), undefined); assert.equal(lost.directory.children.size, 1); assert.equal(lost.handles.size, 0);
});
