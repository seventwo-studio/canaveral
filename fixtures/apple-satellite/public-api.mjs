// Disposable integration fixture: the public TypeScript controller over verified TLS, the public
// consumer SDK, the Rust runner identity and the Rust Apple satellite, driving a fake native
// helper that starts no VM. This is fixture evidence only; it is not native VM acceptance.
// Usage (macOS, Node >= 24, openssl, codesign):
//   node fixtures/apple-satellite/public-api.mjs COORDINATION_DIR SATELLITE RUNNER_CLIENT FIXTURE_HELPER
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID, randomBytes, createHash, X509Certificate} from 'node:crypto';
import {mkdtempSync, mkdirSync, chmodSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, symlinkSync} from 'node:fs';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
const exec = promisify(execFile);
assert.equal(process.platform, 'darwin', 'the Apple satellite fixture requires a macOS host (no VM is started)');
const [coordination, satelliteBin, runnerBin, helperBin] = process.argv.slice(2).map(p => p && resolve(p));
assert(coordination && satelliteBin && runnerBin && helperBin, 'COORDINATION_DIR SATELLITE RUNNER_CLIENT FIXTURE_HELPER required');
const {ConsumerClient, ConsumerServiceError} = await import(pathToFileURL(join(coordination, 'dist/src/consumer-client.js')));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-apple-satellite-')));
const children = [], orphans = [];
const key = () => randomBytes(32).toString('base64url');
const sha = file => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(50); }
}
// Ambient proxies are poisoned: every client must reach the loopback controller directly.
const env = {...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: ''};
let controller, proxy;
try {
  // Disposable CA and localhost leaf.
  const pem = name => join(dir, name);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('ca-key.pem'), '-out', pem('ca.pem'), '-days', '1', '-subj', '/CN=Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash']);
  await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('key.pem'), '-out', pem('leaf.csr'), '-subj', '/CN=localhost']);
  writeFileSync(pem('ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
  await exec('openssl', ['x509', '-req', '-in', pem('leaf.csr'), '-CA', pem('ca.pem'), '-CAkey', pem('ca-key.pem'), '-CAcreateserial', '-out', pem('cert.pem'), '-days', '1', '-extfile', pem('ext.cnf')]);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('other-key.pem'), '-out', pem('other-ca.pem'), '-days', '1', '-subj', '/CN=Unrelated Fixture CA']);
  const ca = readFileSync(pem('ca.pem'));
  // Validate the generated chain independently before any controller request. No system trust.
  await exec('openssl', ['verify', '-CAfile', pem('ca.pem'), '-purpose', 'sslserver', pem('cert.pem')]);
  const root = new X509Certificate(ca), leaf = new X509Certificate(readFileSync(pem('cert.pem')));
  assert(root.ca && leaf.checkIssued(root) && leaf.verify(root.publicKey), 'invalid fixture certificate chain');
  assert.equal(leaf.checkHost('localhost'), 'localhost');

  // Real controller process with TLS. Its wall clock is a fixture file so expiry is exact.
  const admin = key(), controllerId = randomUUID(), clockFile = join(dir, 'clock');
  let controllerNow = 1_800_000_000;
  const setClock = t => { controllerNow = t; writeFileSync(clockFile, String(t)); };
  setClock(controllerNow);
  writeFileSync(join(dir, 'admin'), admin, {mode: 0o600});
  writeFileSync(join(dir, 'controller.json'), JSON.stringify({statePath: join(dir, 'db'), adminTokenFile: join(dir, 'admin'), controllerId,
    listen: {host: '127.0.0.1', port: 0}, tls: {certFile: pem('cert.pem'), keyFile: pem('key.pem')}}));
  controller = spawn(process.execPath, ['--import', join(coordination, 'dist/test/fixture-clock.js'), join(coordination, 'dist/src/main.js'), join(dir, 'controller.json')],
    {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, CANAVERAL_FIXTURE_CLOCK_FILE: clockFile}});
  children.push(controller); controller.stderr.resume();
  const port = await new Promise((resolve, reject) => {
    let text = ''; controller.stdout.on('data', b => { text += b; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]).listening.port); });
    controller.on('exit', code => reject(new Error('controller exited ' + code)));
  });
  const direct = `https://localhost:${port}`;
  function api(method, route, body, token = admin) {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = https.request(direct + route, {ca, method, agent: false, headers: {Authorization: 'Bearer ' + token, ...(bytes ? {'Content-Type': 'application/json', 'Content-Length': bytes.length} : {})}}, res => {
        let data = ''; res.on('data', b => data += b); res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(data)}));
      }); r.on('error', error => reject(new Error(`fixture API ${method} ${route}: ${error.message}`, {cause: error}))); r.end(bytes);
    });
  }
  const ok = async (method, route, body, token) => { const r = await api(method, route, body, token); assert(r.status < 300, `${route}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

  // TLS-terminating loopback proxy in front of the controller: records runner traffic, can drop a
  // reply after the controller committed it, or partition the satellite from the controller:
  // 'stall' accepts and never answers (blocking the satellite's request), 'drop' resets.
  const log = [], drops = new Set(), held = []; let partition = false, dropCleanup = false;
  proxy = https.createServer({key: readFileSync(pem('key.pem')), cert: readFileSync(pem('cert.pem'))}, (req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b));
    req.on('end', () => {
      const raw = Buffer.concat(chunks), entry = {route: req.url, body: raw.length ? JSON.parse(raw) : null, dropped: false, partitioned: partition};
      log.push(entry);
      if (partition === 'stall') { held.push(req.socket); return; }
      if (partition) { req.socket.destroy(); return; }
      const upstream = https.request({host: '127.0.0.1', servername: 'localhost', port, ca, method: req.method, path: req.url, headers: req.headers, agent: false}, reply => {
        const out = []; reply.on('data', b => out.push(b));
        reply.on('end', () => {
          if (drops.delete(req.url) || (dropCleanup && entry.body?.receipt?.cleanup === 'complete' && (dropCleanup = false, true))) { entry.dropped = true; res.socket.destroy(); return; }
          res.writeHead(reply.statusCode, reply.headers); res.end(Buffer.concat(out));
        });
      });
      upstream.on('error', () => res.socket.destroy()); upstream.end(raw);
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const origin = `https://localhost:${proxy.address().port}`;
  const leaseRoutes = () => log.filter(e => e.route.startsWith('/v1/runners/linux-leases/'));
  const reports = () => leaseRoutes().filter(e => e.route.endsWith('/report'));

  // Operator setup: application, immutable Apple image, grant, one-VM domain, explicit enrollment and approval.
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const app = await ok('POST', '/v1/consumers', {id: randomUUID(), name: 'disposable Apple satellite fixture', templates: [],
    limits: {resources: {cpu: 8, memoryMiB: 16384, diskGiB: 64}, activeLeases: 4, defaultTTLSeconds: 300, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 500}});
  mkdirSync(join(dir, 'images'), {mode: 0o700});
  const imagePath = join(dir, 'images', 'linux-installed.raw');
  writeFileSync(imagePath, randomBytes(4096)); chmodSync(imagePath, 0o400);
  const digest = sha(imagePath);
  const image = {id: 'linux-apple-fixture', revision: '1', arch, backend: 'appleVirtualization', digest};
  const VM = {cpu: 1, memoryMiB: 1024, diskGiB: 4};
  await ok('POST', '/v1/linux-lease-images', {...image, os: 'linux', mode: 'headless', resources: VM, capabilities: ['command', 'files']});
  await ok('POST', '/v1/linux-lease-grants', {applicationId: app.id, imageId: image.id, revision: image.revision, arch, digest});
  const domainId = randomUUID();
  await ok('POST', '/v1/resource-domains', {id: domainId, name: 'fixture: exactly one VM', capacity: VM});
  async function cli(args, input) {
    const child = spawn(runnerBin, args, {env, stdio: ['pipe', 'pipe', 'pipe']});
    let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
    child.stdin.end(JSON.stringify(input)); const [code] = await once(child, 'exit');
    assert.equal(code, 0, `${args[0]}: ${text}`);
  }
  async function enroll(binding, identity) {
    const approval = await ok('POST', '/v1/runner-enrollments', {id: randomUUID(), ...binding, ttlSeconds: 100});
    await cli(['prepare', identity, origin], approval);
    await cli(['consume', identity, origin, pem('ca.pem')], binding);
  }
  const binding = {controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID()};
  await enroll(binding, join(dir, 'identity'));
  await ok('POST', '/v1/linux-lease-runner-approvals', {binding, domainId, backend: 'appleVirtualization', images: [{id: image.id, revision: image.revision, arch, digest}]});

  // Fake native helper: a private, ad-hoc signed, pinned, immutable copy.
  mkdirSync(join(dir, 'helper'), {mode: 0o700});
  const helper = join(dir, 'helper', 'CanaveralVMRunner');
  copyFileSync(helperBin, helper); chmodSync(helper, 0o700);
  await exec('/usr/bin/codesign', ['-f', '-s', '-', '-i', 'dev.canaveral.fixture-helper', helper]);
  chmodSync(helper, 0o500);
  const calls = action => existsSync(join(dir, 'helper', 'calls.log')) ? readFileSync(join(dir, 'helper', 'calls.log'), 'utf8').split('\n').filter(l => l === action).length : 0;
  const good = {origin, identity: join(dir, 'identity'), binding, state: join(dir, 'state'), helper, helperSha256: sha(helper),
    signingRequirement: 'identifier "dev.canaveral.fixture-helper"', ca: pem('ca.pem'),
    inventory: [{credentialFree: true, image, path: imagePath}], maxCpu: 2, maxMemoryMiB: 2048, maxDiskGiB: 8};
  function configure(overrides = {}, name = 'satellite.json') {
    const path = join(dir, name); rmSync(path, {force: true});
    writeFileSync(path, JSON.stringify({...good, ...overrides}), {mode: 0o600}); return path;
  }
  function satellite(config = configure()) {
    const child = spawn(satelliteBin, ['run-once', config], {env, stdio: ['ignore', 'ignore', 'pipe']});
    children.push(child); child.errors = ''; child.stderr.on('data', b => child.errors += b);
    child.done = once(child, 'exit').then(([code]) => ({code, errors: child.errors}));
    return child;
  }
  const run = config => satellite(config).done;
  const journal = () => JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf8'));
  const machineDir = lease => join(dir, 'state', 'workspace', lease.members[0].machineId.toUpperCase());
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  // Public consumer SDK over verified TLS.
  const sdk = new ConsumerClient({baseUrl: direct, caFile: pem('ca.pem'), applicationKey: app.credential});
  const acquire = (ttlSeconds = 300) => sdk.acquireLease({id: randomUUID(), templateId: image.id, templateRevision: image.revision, arch, ttlSeconds, requiredCapabilities: ['command']});
  const inspect = id => sdk.inspectLease(id);
  async function noCapacity() {
    await assert.rejects(acquire(), e => e instanceof ConsumerServiceError && e.status === 503 && e.code === 'capacity_unavailable');
  }
  function neverReady(view) {
    assert.notEqual(view.state, 'ready'); assert.equal(view.members[0].ready, false);
  }

  // A QCOW2 container renamed .raw must be rejected before native preparation can expand it.
  const disguised = join(dir, 'images', 'container.raw');
  const qcow = Buffer.alloc(4096); qcow.writeUInt32BE(0x514649fb); qcow.writeUInt32BE(3, 4);
  qcow.writeBigUInt64BE(16n * 1024n ** 3n, 24);
  writeFileSync(disguised, qcow, {mode: 0o400});
  // 1. Every local pin fails before the satellite contacts the controller at all.
  log.length = 0; // enrollment traffic above also used the proxy
  const first = (await acquire()).lease;
  for (const [overrides, expected] of [
    [{helperSha256: 'sha256:' + '0'.repeat(64)}, 'invalid helper or local configuration'],
    [{signingRequirement: 'identifier "dev.canaveral.other"'}, 'helper signature requirement failed'],
    [{inventory: [{credentialFree: true, image: {...image, digest: 'sha256:' + '1'.repeat(64)}, path: imagePath}]}, 'installed image mismatch'],
    [{inventory: [{credentialFree: false, image, path: imagePath}]}, 'installed image mismatch'],
    [{inventory: [{credentialFree: true, image: {...image, digest: sha(disguised)}, path: disguised}]}, 'must be raw'],
  ]) {
    const result = await run(configure(overrides));
    assert.equal(result.code, 1); assert.match(result.errors, new RegExp(expected));
  }
  chmodSync(imagePath, 0o600);
  assert.match((await run()).errors, /must be immutable/); chmodSync(imagePath, 0o400);
  assert.equal(log.length, 0, 'preflight failure reached the controller');
  assert(!existsSync(join(dir, 'state')), 'preflight failure created satellite state');
  // Exercise the actual CLI trust-file boundary, not only its private unit helper.
  const unsafeCa = join(dir, 'unsafe-ca.pem'); copyFileSync(pem('ca.pem'), unsafeCa); chmodSync(unsafeCa, 0o666);
  const linkedCa = join(dir, 'linked-ca.pem'); symlinkSync(pem('ca.pem'), linkedCa);
  const unsafeParent = join(dir, 'unsafe-parent'); mkdirSync(unsafeParent, {mode: 0o777}); chmodSync(unsafeParent, 0o777);
  copyFileSync(pem('ca.pem'), join(unsafeParent, 'ca.pem'));
  for (const [index, ca] of [unsafeCa, linkedCa, join(unsafeParent, 'ca.pem')].entries()) {
    const result = await run(configure({ca, state: join(dir, `state-unsafe-ca-${index}`)}, `unsafe-ca-${index}.json`));
    assert.equal(result.code, 1); assert.match(result.errors, /invalid CA trust file/);
    assert.equal(log.length, 0, 'unsafe CA contacted the controller');
  }
  // An unrelated CA fails TLS verification before any request is delivered.
  const badTrust = await run(configure({ca: pem('other-ca.pem'), state: join(dir, 'state-untrusted')}, 'untrusted.json'));
  assert.equal(badTrust.code, 1); assert.match(badTrust.errors, /authentication failed/); assert.equal(log.length, 0);
  assert.equal((await inspect(first.id)).runtimeState, 'pending');

  // 2. Lost claim reply: the controller committed; the exact claim is replayed after restart.
  drops.add('/v1/runners/linux-leases/claim');
  const lostClaim = await run();
  assert.equal(lostClaim.code, 1, lostClaim.errors);
  assert(leaseRoutes()[0].dropped); assert(!existsSync(join(dir, 'state', 'workspace')));
  const claimId = journal().claimId;
  const running = satellite();
  const firstMachine = machineDir(first);
  await until(() => existsSync(join(firstMachine, 'fixture-running')), 'first guest start');
  const claims = leaseRoutes().filter(e => e.route.endsWith('/claim'));
  assert.equal(claims.length, 2); assert.deepEqual(claims[0].body, claims[1].body); assert.equal(claims[1].body.claimId, claimId);
  assert.deepEqual(claims[0].body.binding, binding);
  let view = await until(async () => { const v = await inspect(first.id); return v.runtimeState === 'unknown' && v; }, 'first report');
  assert.equal(view.state, 'provisioning'); neverReady(view);
  await noCapacity(); // the admission reservation is held while the guest may execute
  // Lost report reply after commit: the identical pending report is replayed at the same sequence.
  drops.add('/v1/runners/linux-leases/report');
  await until(() => reports().some(e => e.dropped), 'dropped report');
  const lost = reports().find(e => e.dropped);
  await until(() => reports().some(e => !e.dropped && e.body.sequence === lost.body.sequence), 'report replay');
  assert.deepEqual(reports().find(e => !e.dropped && e.body.sequence === lost.body.sequence).body, lost.body);
  // Consumer release is intent; the reservation stays held until positive cleanup evidence.
  dropCleanup = true;
  await sdk.releaseLease(first.id, {id: randomUUID()});
  const lostCleanup = await running.done;
  assert.equal(lostCleanup.code, 1, 'final committed cleanup reply was not lost');
  const finalLost = reports().find(e => e.dropped && e.body.receipt.cleanup === 'complete');
  assert(finalLost, 'cleanup reply was not dropped after commit');
  const released = await run();
  assert.equal(released.code, 0, released.errors);
  assert.deepEqual(reports().at(-1).body, finalLost.body, 'recovery must replay the final receipt without an extra sequence');
  view = await inspect(first.id);
  assert.equal(view.state, 'released'); assert.equal(view.runtimeState, 'stopped'); assert.equal(view.cleanup.state, 'complete'); neverReady(view);
  assert(!existsSync(join(dir, 'state', 'workspace')), 'owned workspace (disk, guest credential) not removed');
  assert.equal(sha(imagePath), digest, 'installed source image changed');
  const complete = reports().at(-1).body.receipt;
  assert.deepEqual([complete.cleanup, complete.executionStopped, complete.storageRemoved, complete.credentialsErased], ['complete', true, true, true]);
  for (const e of reports()) assert.deepEqual(e.body.receipt.ready, {command: false, pty: false, files: false});
  assert.equal(calls('prepare'), 1); assert.equal(calls('run'), 1);

  // 3. Controller expiry wins: the next lease reuses the released journal with a fresh claim.
  const second = (await acquire()).lease;
  const expiring = satellite();
  await until(() => existsSync(join(machineDir(second), 'fixture-running')), 'second guest start');
  assert.notEqual(journal().claimId, claimId);
  setClock(controllerNow + 301);
  const expired = await expiring.done;
  assert.equal(expired.code, 0, expired.errors);
  view = await inspect(second.id);
  assert.equal(view.state, 'expired'); assert.equal(view.cleanup.state, 'complete'); neverReady(view);

  // 4. Partition: a stalled controller blocks the satellite's report, yet the native guard ends
  //    execution at the local continuous-clock deadline. Cleanup is retained until the satellite
  //    can report; recovery then completes from the durable stop proof.
  const ttl = 4, claimedBefore = Date.now();
  const third = (await acquire(ttl)).lease;
  const partitioned = satellite();
  const thirdMachine = machineDir(third);
  await until(() => existsSync(join(thirdMachine, 'fixture-running')), 'third guest start');
  const thirdPid = Number(readFileSync(join(thirdMachine, 'fixture-running'), 'utf8')); orphans.push(thirdPid);
  partition = 'stall';
  await until(() => held.length > 0, 'stalled satellite request');
  // The exited guest stays an unreaped zombie of the blocked satellite, so observe the fence record.
  await until(() => existsSync(join(thirdMachine, 'lease-fenced.json')), 'native deadline fence', (ttl + 3) * 1000);
  assert(Date.now() - claimedBefore < (ttl + 2) * 1000, 'guest outlived its local deadline');
  assert.equal(partitioned.exitCode, null, 'satellite should still be blocked on the stalled controller');
  partition = 'drop'; for (const socket of held.splice(0)) socket.destroy();
  const cut = await partitioned.done;
  assert.equal(cut.code, 1, cut.errors); assert.match(cut.errors, /terminal lease acknowledgment|reply missing/);
  assert(!alive(thirdPid), 'guest helper outlived the local deadline');
  assert.equal(journal().stopped, true); assert.equal(journal().cleaned, false);
  assert(existsSync(thirdMachine), 'cleanup ran without controller acknowledgment');
  view = await inspect(third.id);
  assert.equal(view.state, 'provisioning', 'controller (frozen clock) did not observe the local fence'); neverReady(view);
  await noCapacity();
  partition = false;
  const healed = await run();
  assert.equal(healed.code, 0, healed.errors);
  view = await inspect(third.id);
  assert.equal(view.state, 'failed'); assert.equal(view.cleanup.state, 'complete'); assert(!existsSync(join(dir, 'state', 'workspace')));
  assert.equal(calls('prepare'), 3); assert.equal(calls('run'), 3);

  // 5. Satellite crash while the guest runs: no relaunch, unknown runtime, reservation retained.
  const fourth = (await acquire()).lease;
  const crashing = satellite();
  const fourthMachine = machineDir(fourth);
  await until(() => existsSync(join(fourthMachine, 'fixture-running')), 'fourth guest start');
  const fourthPid = Number(readFileSync(join(fourthMachine, 'fixture-running'), 'utf8')); orphans.push(fourthPid);
  crashing.kill('SIGKILL'); await crashing.done;
  assert(alive(fourthPid), 'fixture guest should survive the satellite crash');
  for (let i = 0; i < 2; i++) {
    const recovered = await run();
    assert.equal(recovered.code, 1); assert.match(recovered.errors, /no relaunch/);
  }
  await until(() => !alive(fourthPid), 'native fence after recovery');
  assert(existsSync(join(fourthMachine, 'lease-fenced.json')) || existsSync(join(fourthMachine, 'power-off.request')));
  view = await inspect(fourth.id);
  assert.equal(view.state, 'failed'); assert.equal(view.runtimeState, 'unknown'); assert.notEqual(view.cleanup.state, 'complete'); neverReady(view);
  assert.equal(view.members[0].cleanup.reason, 'recovery');
  assert(existsSync(fourthMachine), 'unproven stop must not delete storage');
  await noCapacity();
  assert.equal(calls('prepare'), 4); assert.equal(calls('run'), 4);

  // 6. Stale binding: revocation and reenrollment supersede generation 1. The old identity cannot
  //    report and the reservation stays held; a changed binding cannot adopt the retained journal.
  await ok('POST', '/v1/runners/revoke', binding);
  const fresh = {...binding, generation: 2, incarnationId: randomUUID()};
  await enroll(fresh, join(dir, 'identity-2'));
  const before = log.length;
  const stale = await run();
  assert.equal(stale.code, 1); assert.match(stale.errors, /authentication failed/);
  assert(log.slice(before).every(e => !e.route.startsWith('/v1/runners/linux-leases/')));
  const adopted = await run(configure({binding: fresh, identity: join(dir, 'identity-2')}, 'satellite-2.json'));
  assert.equal(adopted.code, 1); assert.match(adopted.errors, /saved binding\/config differs/);
  view = await inspect(fourth.id); assert.equal(view.runtimeState, 'unknown'); await noCapacity();
  assert.equal(calls('prepare'), 4);
  console.log('PASS Apple satellite public API fixture (fake helper, no VM): preflight before claim, TLS trust, SDK acquire/release, lost claim and report replay, never-ready receipts, cleanup-gated reservation, controller expiry, native local deadline under a stalled controller with durable-stop recovery, crash unknown retention without relaunch, stale binding');
} finally {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await once(c, 'exit'); }
  for (const pid of orphans) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (proxy) { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); }
  rmSync(dir, {recursive: true, force: true});
}
