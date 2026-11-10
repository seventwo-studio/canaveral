import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CliClient, CliError } from '../../src/account-cli.ts';
import { ARTIFACT_CHUNK_BYTES, updateMain } from '../../src/updates/cli.ts';
import { verifyRelease } from '../../src/updates/protocol.ts';
import type { SignedRelease } from '../../src/updates/protocol.ts';
import { startController } from '../../src/main.ts';

const execute = promisify(execFile);
const builder = resolve(import.meta.dirname, '../../../../script/build_runtime_release.mjs');
async function fixture(t: TestContext, build = true) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'canaveral-update-cli-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const inputs = join(dir, 'inputs'), output = join(dir, 'bundle'), keyFile = join(dir, 'signing.pem'), recipeFile = join(dir, 'recipe.json'), trust = join(dir, 'trusted.json');
  await fs.mkdir(inputs, { mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await fs.writeFile(keyFile, privatePem, { mode: 0o600 });
  await fs.writeFile(trust, JSON.stringify({ test: publicPem }));
  await fs.writeFile(join(inputs, 'main.js'), '// inert runtime file\n'.repeat(35_000));
  await fs.writeFile(join(inputs, 'guest'), Buffer.from('portable guest fixture bytes'));
  await fs.writeFile(join(inputs, 'native'), Buffer.from('portable native fixture bytes'));
  await fs.writeFile(join(inputs, 'empty'), '');
  const recipe = {
    schema: 'canaveral-runtime-build-v1', releaseId: randomUUID(), version: '1.2.3', sequence: 1, createdAt: 1_800_000_000,
    target: { os: 'linux', arch: 'amd64' }, minimumLauncherVersion: 1, entrypoint: 'host/main.js',
    toolchain: { node: '24.11.0', rust: '1.99.1' }, sourceRevision: 'a'.repeat(40),
    files: [
      { source: 'main.js', path: 'host/main.js', executable: false, component: 'host' },
      { source: 'guest', path: 'guest/agent', executable: true, component: 'guest' },
      { source: 'guest', path: 'guest/duplicate', executable: true, component: 'guest' },
      { source: 'native', path: 'native/helper', executable: true, component: 'native-helper' },
      { source: 'empty', path: 'host/empty', executable: false, component: 'host' },
    ],
  };
  const assemble = async (destination = output) => {
    await fs.writeFile(recipeFile, JSON.stringify(recipe));
    return execute(process.execPath, [builder, '--recipe', recipeFile, '--inputs', inputs, '--output', destination, '--key-file', keyFile, '--key-id', 'test']);
  };
  if (build) await assemble();
  return { dir, inputs, output, keyFile, trust, recipe, assemble, publicPem, privatePem };
}
async function run(args: string[], client?: CliClient) {
  let stdout = '', stderr = '';
  const status = await updateMain(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, ...(client ? { client } : {}) });
  return { status, stdout, stderr };
}

test('offline builder signs deterministic exact host/guest/helper files and version evidence, without bundling private keys', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(join(f.output, 'release.json'), 'utf8');
  const release = verifyRelease(JSON.parse(original) as unknown, { test: f.publicPem });
  assert.equal(release.manifest.entrypoint, 'host/main.js');
  assert.deepEqual(new Set(release.manifest.files.map(file => file.component)), new Set(['host', 'guest', 'native-helper']));
  assert.equal(release.manifest.files.length, 6);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['artifacts', 'release.json']);
  assert.equal((await fs.readdir(join(f.output, 'artifacts'))).length, 5);
  for (const entry of await fs.readdir(join(f.output, 'artifacts'))) {
    const content = await fs.readFile(join(f.output, 'artifacts', entry));
    assert.ok(!content.includes(Buffer.from(f.privatePem)));
    assert.equal((await fs.stat(join(f.output, 'artifacts', entry))).nlink, 1);
  }
  const metadataFile = release.manifest.files.find(file => file.path === '.canaveral-build.json')!;
  const metadata = JSON.parse(await fs.readFile(join(f.output, 'artifacts', metadataFile.sha256), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(metadata.toolchain, { node: '24.11.0', rust: '1.99.1' });
  f.recipe.toolchain = { rust: '1.99.1', node: '24.11.0' };
  f.recipe.target = { arch: 'amd64', os: 'linux' };
  f.recipe.files.reverse();
  const second = join(f.dir, 'second'); await f.assemble(second);
  assert.equal(await fs.readFile(join(second, 'release.json'), 'utf8'), original);
  await assert.rejects(f.assemble());
  assert.equal(await fs.readFile(join(f.output, 'release.json'), 'utf8'), original);
});

test('builder refuses traversal, symlinks, hardlinks, signing-key inclusion and missing toolchain pins', async t => {
  const f = await fixture(t, false);
  f.recipe.files[0]!.source = '../signing.pem';
  await assert.rejects(f.assemble());
  f.recipe.files[0]!.source = 'link';
  await fs.symlink(join(f.inputs, 'main.js'), join(f.inputs, 'link'));
  await assert.rejects(f.assemble());
  await fs.unlink(join(f.inputs, 'link')); await fs.link(join(f.inputs, 'main.js'), join(f.inputs, 'link'));
  await assert.rejects(f.assemble());
  await fs.unlink(join(f.inputs, 'link'));
  const keyInside = join(f.inputs, 'key.pem'); await fs.rename(f.keyFile, keyInside);
  f.recipe.files[0]!.source = 'key.pem';
  await fs.writeFile(join(f.dir, 'recipe.json'), JSON.stringify(f.recipe));
  await assert.rejects(execute(process.execPath, [builder, '--recipe', join(f.dir, 'recipe.json'), '--inputs', f.inputs, '--output', f.output, '--key-file', keyInside, '--key-id', 'test']));
  await fs.rename(keyInside, f.keyFile); f.recipe.files[0]!.source = 'main.js';
  // Copying the key to another inode, including across chunk boundaries, is also refused.
  await fs.writeFile(join(f.inputs, 'copied-key'), Buffer.concat([Buffer.alloc(256 * 1024 - 5, 0x78), Buffer.from(f.privatePem), Buffer.from('suffix')]));
  f.recipe.files[0]!.source = 'copied-key'; await assert.rejects(f.assemble());
  f.recipe.files[0]!.source = 'main.js';
  f.recipe.toolchain.rust = 'stable'; await assert.rejects(f.assemble());
  f.recipe.toolchain.rust = '1.99.1'; f.recipe.toolchain.node = '24'; await assert.rejects(f.assemble());
  assert.equal((await fs.readdir(f.dir)).includes('bundle'), false);
});

test('CLI rejects corrupt files, untrusted releases, extra entries and links before any controller mutation', async t => {
  const f = await fixture(t);
  const release = JSON.parse(await fs.readFile(join(f.output, 'release.json'), 'utf8')) as SignedRelease;
  const source = join(f.output, 'artifacts', release.manifest.files.find(file => file.path === 'guest/agent')!.sha256);
  const bytes = await fs.readFile(source); await fs.writeFile(source, Buffer.alloc(bytes.length));
  let calls = 0;
  const invoke = () => updateMain(['releases', 'upload', '--bundle', f.output, '--trusted-keys', f.trust], { client: { async request() { calls++; return {}; } }, stdout() {}, stderr() {} });
  assert.equal(await invoke(), 1); assert.equal(calls, 0);
  await fs.writeFile(source, bytes); await fs.writeFile(join(f.output, 'unexpected'), 'secret');
  assert.equal(await invoke(), 1); assert.equal(calls, 0);
  await fs.unlink(join(f.output, 'unexpected')); await fs.unlink(source); await fs.symlink(join(f.inputs, 'guest'), source);
  assert.equal(await invoke(), 1); assert.equal(calls, 0);
  await fs.unlink(source); await fs.writeFile(source, bytes); await fs.writeFile(f.trust, '{}');
  assert.equal(await invoke(), 1); assert.equal(calls, 0);
});

test('real controller upload and rollout recover lost committed replies with exact chunk/body replay', async t => {
  const f = await fixture(t);
  const operator = randomBytes(32).toString('base64url'), enrollment = randomBytes(32).toString('base64url');
  const adminFile = join(f.dir, 'operator'), enrollFile = join(f.dir, 'enroll');
  await fs.writeFile(adminFile, operator, { mode: 0o600 }); await fs.writeFile(enrollFile, enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(f.dir, 'db'), adminTokenFile: adminFile, enrollmentTokenFile: enrollFile, controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 }, updatePublicKeys: { test: f.publicPem } });
  t.after(() => controller.close());
  const origin = `http://127.0.0.1:${controller.address.port}`;
  const hostId = randomUUID(), credential = randomBytes(32).toString('base64url');
  await new CliClient(origin, enrollment).request('POST', '/v1/hosts/enroll', { id: hostId, credential, offer: { name: 'portable-update-only', provider: 'libvirt', capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 100 }, templates: [{ id: 'linux', revision: '1', os: 'linux', arch: 'amd64', mode: 'headless', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }] } });
  await new CliClient(origin, credential).request('POST', `/v1/hosts/${hostId}/updates/poll`, { installationId: randomUUID(), target: { os: 'linux', arch: 'amd64' }, launcherVersion: 1 });
  const calls: Array<{ path: string; body: string }> = [];
  const dropped = new Set<string>();
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const body = Buffer.concat(chunks).toString();
      const path = request.url!;
      if (request.method === 'POST') calls.push({ path, body });
      const upstream = await fetch(origin + path, { method: request.method!, headers: { Authorization: request.headers.authorization!, 'Content-Type': 'application/json' }, ...(body ? { body } : {}), redirect: 'error' });
      const data = await upstream.text();
      const group = path.includes('/artifacts/') ? 'artifact' : path.endsWith('/cancel') ? 'cancel' : path === '/v1/updates/releases' ? 'release' : path === '/v1/updates/rollouts' ? 'rollout' : '';
      if (request.method === 'POST' && upstream.ok && group && !dropped.has(group)) { dropped.add(group); response.destroy(); return; }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(data);
    })().catch(() => { response.writeHead(500); response.end('{}'); });
  });
  await new Promise<void>(accept => proxy.listen(0, '127.0.0.1', accept));
  t.after(() => new Promise<void>((accept, reject) => proxy.close(error => error ? reject(error) : accept())));
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const globals = ['--url', url, '--token-file', adminFile];
  const uploaded = await run([...globals, 'releases', 'upload', '--bundle', f.output, '--trusted-keys', f.trust]);
  assert.equal(uploaded.status, 0, uploaded.stderr);
  assert.equal((JSON.parse(uploaded.stdout) as { uploaded: boolean }).uploaded, true);
  const replayed = await run([...globals, 'releases', 'upload', '--bundle', f.output, '--trusted-keys', f.trust]);
  assert.equal(replayed.status, 0, replayed.stderr);
  const rolloutId = randomUUID();
  const createArgs = [...globals, 'rollouts', 'create', '--id', rolloutId, '--release-id', f.recipe.releaseId, '--host-id', hostId];
  const created = await run(createArgs); assert.equal(created.status, 0, created.stderr);
  const job = (JSON.parse(created.stdout) as { jobs: Array<{ id: string }> }).jobs[0]!;
  assert.equal((JSON.parse((await run(createArgs)).stdout) as { jobs: Array<{ id: string }> }).jobs[0]!.id, job.id);
  assert.equal((await run([...globals, 'releases', 'list'])).status, 0);
  assert.equal((await run([...globals, 'releases', 'status', '--id', f.recipe.releaseId])).status, 0);
  assert.equal((await run([...globals, 'rollouts', 'list'])).status, 0);
  const cancelled = await run([...globals, 'rollouts', 'cancel', '--id', rolloutId]); assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal((JSON.parse(cancelled.stdout) as { jobs: Array<{ state: string }> }).jobs[0]!.state, 'cancelled');
  const status = await run([...globals, 'rollouts', 'status', '--id', rolloutId]); assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(dropped, new Set(['release', 'artifact', 'rollout', 'cancel']));
  for (const path of ['/v1/updates/releases', '/v1/updates/rollouts', `/v1/updates/rollouts/${rolloutId}/cancel`]) {
    const bodies = calls.filter(call => call.path === path).map(call => call.body);
    assert.ok(bodies.length >= 2); assert.equal(new Set(bodies).size, 1);
  }
  const artifactCalls = calls.filter(call => call.path.includes('/artifacts/'));
  const chunksByOffset = new Map<string, string>();
  for (const call of artifactCalls) {
    const body = JSON.parse(call.body) as { offset: number; data: string };
    const key = call.path + ':' + body.offset;
    assert.ok(Buffer.from(body.data, 'base64').length <= ARTIFACT_CHUNK_BYTES);
    if (chunksByOffset.has(key)) assert.equal(chunksByOffset.get(key), call.body); else chunksByOffset.set(key, call.body);
  }
  assert.ok(![uploaded, created, cancelled, status].some(result => (result.stdout + result.stderr).includes(operator) || (result.stdout + result.stderr).includes(f.privatePem)));
});

test('CLI stable runnerIds extension and exhausted lost replies retain the same explicit identity', async () => {
  const id = randomUUID(), releaseId = randomUUID(), runnerId = randomUUID();
  const bodies: unknown[] = []; let stderr = '';
  const args = ['rollouts', 'create', '--id', id, '--release-id', releaseId, '--runner-id', runnerId];
  const status = await updateMain(args, { client: { async request(method, path, body) { assert.equal(method, 'POST'); assert.equal(path, '/v1/updates/rollouts'); bodies.push(structuredClone(body)); throw new CliError('secret diagnostic', 503, id, 'unknown'); } }, stdout() {}, stderr: text => { stderr += text; } });
  assert.equal(status, 1); assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], { id, releaseId, hostIds: [], runnerIds: [runnerId] }); assert.deepEqual(bodies[0], bodies[1]);
  assert.match(stderr, new RegExp(id)); assert.ok(!stderr.includes('secret diagnostic'));
  let count = 0;
  const invalid = await updateMain([...args, '--runner-id', runnerId], { client: { async request() { count++; return {}; } }, stdout() {}, stderr() {} });
  assert.equal(invalid, 1); assert.equal(count, 0);
});

test('CLI refuses redirects and does not retry definite authorization/conflict failures', async () => {
  for (const status of [302, 401, 403, 409]) {
    let calls = 0;
    assert.equal(await updateMain(['rollouts', 'cancel', '--id', randomUUID()], { client: { async request() { calls++; throw new CliError('not echoed', status, undefined, status === 302 ? 'unknown' : undefined); } }, stdout() {}, stderr() {} }), 1);
    assert.equal(calls, 1);
  }
  assert.equal((await run(['rollouts', 'create', '--release-id', randomUUID(), '--host-id', randomUUID()])).status, 1);
  assert.equal((await run(['rollouts', 'list', '--bundle', '/unused'])).status, 1);
  assert.equal((await run(['rollouts', 'cancel', '--id', randomUUID(), '--id', randomUUID()])).status, 1);
  assert.equal((await run(['--help'])).status, 0);
});
