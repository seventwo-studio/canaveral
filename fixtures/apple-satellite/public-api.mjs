// Disposable integration fixture: the public TypeScript controller over verified TLS, the public
// consumer SDK, the Rust runner identity and the Rust Apple satellite, driving a fake native
// helper that starts no VM. This is fixture evidence only; it is not native VM acceptance.
// Usage (macOS on arm64, Node >= 24, openssl, codesign, chflags):
//   node fixtures/apple-satellite/public-api.mjs COORDINATION_DIR SATELLITE RUNNER_CLIENT FIXTURE_HELPER FIXTURE_BUILDER
// FIXTURE_BUILDER writes a SIMULATED EROFS medium (magic, label, launch.json); nothing is mounted.
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
const [coordination, satelliteBin, runnerBin, helperBin, builderBin] = process.argv.slice(2).map(p => p && resolve(p));
assert(coordination && satelliteBin && runnerBin && helperBin && builderBin, 'COORDINATION_DIR SATELLITE RUNNER_CLIENT FIXTURE_HELPER FIXTURE_BUILDER required');
const {ConsumerClient, LeaseClient, ConsumerServiceError} = await import(pathToFileURL(join(coordination, 'dist/src/consumer-client.js')));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-apple-satellite-')));
const children = [], orphans = [], relays = [];
const key = () => randomBytes(32).toString('base64url');
const sha = file => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(50); }
}
// Extension OIDs (hex of the OID body) of a DER X.509 certificate, in order and with repeats.
function extensionOids(der) {
  const tlv = offset => {
    let length = der[offset + 1], header = 2;
    if (length & 0x80) { const n = length & 0x7f; length = 0; for (let i = 0; i < n; i++) length = length * 256 + der[offset + 2 + i]; header += n; }
    assert(offset + header + length <= der.length, 'truncated certificate DER');
    return {tag: der[offset], start: offset + header, end: offset + header + length};
  };
  const children = node => { const out = []; for (let o = node.start; o < node.end; o = out.at(-1).end) out.push(tlv(o)); return out; };
  const [tbs] = children(tlv(0));
  const explicit = children(tbs).find(c => c.tag === 0xa3);
  if (!explicit) return [];
  return children(children(explicit)[0]).map(extension => { const oid = children(extension)[0]; return der.subarray(oid.start, oid.end).toString('hex'); });
}
// Ambient proxies are poisoned: every client must reach the loopback controller directly.
const env = {...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: ''};
let controller, proxy;
try {
  // Disposable CA and localhost leaf, generated from an explicit OpenSSL configuration. Ambient
  // configuration is not portable: OpenSSL 1.1.1w (the macos-15 runner image's openssl) merges
  // `req -x509 -addext` with the default [v3_ca] section and writes duplicate extensions, which
  // OpenSSL, Node and rustls all refuse as an issuer. So: no -addext, no default sections, one
  // named extension section per certificate, and OPENSSL_CONF pinned to this file.
  const pem = name => join(dir, name);
  const opensslConf = pem('openssl.cnf');
  writeFileSync(opensslConf, [
    '[req]', 'distinguished_name = dn', 'string_mask = utf8only', '[dn]', 'commonName = Common Name (set by -subj)',
    '[ca_ext]', 'basicConstraints = critical,CA:TRUE', 'keyUsage = critical,keyCertSign,cRLSign', 'subjectKeyIdentifier = hash',
    '[leaf_ext]', 'subjectAltName = DNS:localhost', 'basicConstraints = critical,CA:FALSE', 'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth', 'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid,issuer', ''].join('\n'));
  const opensslEnv = {...process.env, OPENSSL_CONF: opensslConf};
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_ENGINES', 'OPENSSL_MODULES']) delete opensslEnv[name];
  const openssl = args => exec('openssl', args, {env: opensslEnv});
  const selfSigned = (keyName, certName, subject) => openssl(['req', '-config', opensslConf, '-x509', '-extensions', 'ca_ext', '-sha256',
    '-newkey', 'rsa:2048', '-nodes', '-keyout', pem(keyName), '-out', pem(certName), '-days', '1', '-subj', subject]);
  await selfSigned('ca-key.pem', 'ca.pem', '/CN=Fixture CA');
  await openssl(['req', '-config', opensslConf, '-new', '-sha256', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('key.pem'), '-out', pem('leaf.csr'), '-subj', '/CN=localhost']);
  await openssl(['x509', '-req', '-sha256', '-in', pem('leaf.csr'), '-CA', pem('ca.pem'), '-CAkey', pem('ca-key.pem'), '-CAcreateserial', '-out', pem('cert.pem'),
    '-days', '1', '-extfile', opensslConf, '-extensions', 'leaf_ext']);
  await selfSigned('other-key.pem', 'other-ca.pem', '/CN=Unrelated Fixture CA');
  const ca = readFileSync(pem('ca.pem'));
  // Public certificate diagnostics only (never key material): tool, subject/issuer, fingerprint and
  // the DER extension list, where a duplicate would show up as a repeated OID.
  const {stdout: opensslVersion} = await openssl(['version']);
  const EXT = {'551d13': 'basicConstraints', '551d0f': 'keyUsage', '551d0e': 'subjectKeyIdentifier', '551d23': 'authorityKeyIdentifier', '551d11': 'subjectAltName', '551d25': 'extendedKeyUsage'};
  const certificates = Object.fromEntries(['ca.pem', 'cert.pem', 'other-ca.pem'].map(name => [name, new X509Certificate(readFileSync(pem(name)))]));
  const summary = Object.entries(certificates).map(([name, c]) => `${name}: subject=${JSON.stringify(c.subject)} issuer=${JSON.stringify(c.issuer)} ca=${c.ca} sha256=${c.fingerprint256} extensions=${extensionOids(c.raw).map(o => EXT[o] ?? o).join(',')}`);
  console.error(`fixture certificates (${opensslVersion.trim()}, OPENSSL_CONF=fixture):\n  ${summary.join('\n  ')}`);
  try {
    for (const [name, c] of Object.entries(certificates)) {
      const oids = extensionOids(c.raw);
      assert.equal(new Set(oids).size, oids.length, `${name} repeats an X.509 extension`);
      assert(['551d13', '551d0f', '551d0e'].every(o => oids.includes(o)), `${name} lacks basicConstraints, keyUsage or subjectKeyIdentifier`);
    }
    // Validate the generated chain independently before any controller request. No system trust.
    await openssl(['verify', '-x509_strict', '-CAfile', pem('ca.pem'), '-purpose', 'sslserver', pem('cert.pem')]);
    const root = certificates['ca.pem'], leaf = certificates['cert.pem'];
    assert.deepEqual(Object.values(certificates).map(c => [c.subject, c.issuer]),
      [['CN=Fixture CA', 'CN=Fixture CA'], ['CN=localhost', 'CN=Fixture CA'], ['CN=Unrelated Fixture CA', 'CN=Unrelated Fixture CA']], 'unexpected fixture certificate names');
    assert(root.ca && !leaf.ca && root.checkIssued(root) && root.verify(root.publicKey), 'invalid fixture root certificate');
    assert(leaf.checkIssued(root) && leaf.verify(root.publicKey), 'invalid fixture certificate chain');
    assert(!leaf.checkIssued(certificates['other-ca.pem']), 'unrelated fixture CA issued the leaf');
    assert.equal(leaf.checkHost('localhost'), 'localhost');
  } catch (error) {
    // Public certificate text only: no keys, no public-key or signature dumps.
    for (const name of Object.keys(certificates)) {
      const {stdout} = await openssl(['x509', '-in', pem(name), '-noout', '-text', '-certopt', 'no_pubkey,no_sigdump']).catch(e => ({stdout: String(e)}));
      console.error(`--- ${name}\n${stdout}`);
    }
    throw error;
  }

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
  const reports = () => leaseRoutes().filter(e => e.route === '/v1/runners/linux-leases/report');

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
    // CA reads now use the shared descriptor-based private-file validator.
    assert.equal(result.code, 1); assert.match(result.errors, /unsafe executor state/);
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
  // 7. Direct boot from an operator-installed guest bundle, on the fresh binding and its own
  //    one-VM domain. The kernel/initrd/rootfs are byte fixtures, the builder writes a SIMULATED
  //    EROFS medium and the helper's guest is protocol-faithful but fake: no VM, mount or exec.
  assert.equal(process.arch, 'arm64', 'direct boot bundles are arm64-only');
  const bundleDir = join(dir, 'bundle'); mkdirSync(bundleDir, {mode: 0o700});
  const kernel = Buffer.alloc(64); kernel.write('ARMd', 56, 'latin1');
  const rootfs = Buffer.alloc(4096); Buffer.from([0xe2, 0xe1, 0xf5, 0xe0]).copy(rootfs, 1024);
  const pins = {}, artifacts = [];
  for (const [role, name, bytes] of [['kernel', 'Image', kernel], ['initrd', 'initrd.img', Buffer.from('fixture audited initrd')], ['rootfs', 'root.erofs', rootfs]]) {
    const path = join(bundleDir, name); writeFileSync(path, bytes, {mode: 0o400}); artifacts.push(path);
    pins[role] = {path: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length};
  }
  await exec('/usr/bin/chflags', ['uchg', ...artifacts]);
  const manifest = {version: 1, id: 'fixture-coding', revision: 1, arch: 'arm64', kernel: pins.kernel, initrd: pins.initrd, rootfs: pins.rootfs,
    commandLine: 'console=hvc0 root=/dev/vda rootfstype=erofs ro', agentVsockPort: 1024, protocol: 1,
    toolVersions: {shell: 'canaveral-shell-v1', git: 'git version 2.47', node: 'v24.11.0'}};
  // Independent canonical bytes (sorted keys, no whitespace; these ASCII values need no other escaping).
  const canonical = v => v === null ? 'null' : typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
  const bundleDigest = createHash('sha256').update(canonical(manifest)).digest('hex');
  const manifestPath = join(bundleDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {mode: 0o400});
  const bootImage = {id: 'linux-apple-direct', revision: '1', arch, backend: 'appleVirtualization', digest: 'sha256:' + bundleDigest};
  await ok('POST', '/v1/linux-lease-images', {...bootImage, os: 'linux', mode: 'headless', resources: VM, capabilities: ['command', 'files']});
  await ok('POST', '/v1/linux-lease-grants', {applicationId: app.id, imageId: bootImage.id, revision: bootImage.revision, arch, digest: bootImage.digest});
  const directDomain = randomUUID();
  await ok('POST', '/v1/resource-domains', {id: directDomain, name: 'fixture: one direct-boot VM', capacity: VM});
  await ok('POST', '/v1/linux-lease-runner-approvals', {binding: fresh, domainId: directDomain, backend: 'appleVirtualization', images: [{id: bootImage.id, revision: bootImage.revision, arch, digest: bootImage.digest}]});
  mkdirSync(join(dir, 'builder'), {mode: 0o700});
  const builder = join(dir, 'builder', 'mkfs.erofs');
  copyFileSync(builderBin, builder); chmodSync(builder, 0o500);
  const directState = join(dir, 'state-direct');
  const directOverrides = {binding: fresh, identity: join(dir, 'identity-2'), state: directState,
    inventory: [{credentialFree: true, format: 'bootBundle', image: bootImage, path: manifestPath}],
    bootstrapBuilder: {path: builder, sha256: sha(builder)}};
  const directConfig = configure(directOverrides, 'direct.json');
  const guestMode = mode => writeFileSync(join(dir, 'helper', 'guest-mode'), mode);
  const acquireDirect = (ttlSeconds = 300) => sdk.acquireLease({id: randomUUID(), templateId: bootImage.id, templateRevision: bootImage.revision, arch, ttlSeconds, requiredCapabilities: ['command']});
  const directJournal = () => JSON.parse(readFileSync(join(directState, 'state.json'), 'utf8'));
  const directMachine = lease => join(directState, 'workspace', lease.members[0].machineId.toUpperCase());
  const assignmentReports = id => reports().filter(e => e.body.receipt.leaseId === id);
  async function noDirectCapacity() {
    await assert.rejects(acquireDirect(), e => e instanceof ConsumerServiceError && e.status === 503 && e.code === 'capacity_unavailable');
  }
  // 7a. Preflight: builder, bundle digest and immutable artifacts fail before any claim.
  const preflightLog = log.length;
  for (const [overrides, expected] of [
    [{bootstrapBuilder: undefined}, 'requires a pinned bootstrap builder'],
    [{bootstrapBuilder: {path: builder, sha256: 'sha256:' + '0'.repeat(64)}}, 'bootstrap builder pin mismatch'],
    [{inventory: [{...directOverrides.inventory[0], image: {...bootImage, digest: 'sha256:' + '1'.repeat(64)}}]}, 'boot bundle digest differs'],
  ]) {
    const result = await run(configure({...directOverrides, ...overrides}, 'direct-bad.json'));
    assert.equal(result.code, 1); assert.match(result.errors, new RegExp(expected));
  }
  await exec('/usr/bin/chflags', ['nouchg', artifacts[2]]);
  assert.match((await run(directConfig)).errors, /must be private, immutable/);
  await exec('/usr/bin/chflags', ['uchg', artifacts[2]]);
  assert.equal(log.length, preflightLog, 'direct preflight failure reached the controller');
  assert(!existsSync(directState), 'direct preflight failure created satellite state');

  // 7b. Ready only after the bound guest ready; renewal reaches the guest; release cleans owned state.
  guestMode('commands');
  const callsBefore = {prepare: calls('prepare'), run: calls('run')};
  const d1 = (await acquireDirect()).lease;
  const readySatellite = satellite(directConfig);
  view = await until(async () => { const v = await inspect(d1.id); return v.state === 'ready' && v; }, 'direct guest ready');
  assert.equal(view.runtimeState, 'running'); assert.equal(view.members[0].ready, true);
  const d1Reports = assignmentReports(d1.id);
  assert(d1Reports.every(e => ['starting', 'running'].includes(e.body.receipt.runtimeState)), 'no unknown runtime before release');
  for (const e of d1Reports) if (e.body.receipt.ready.command) assert.equal(e.body.receipt.runtimeState, 'running');
  assert.equal(calls('guest-ready'), 1);
  await until(() => calls('guest-renew') > 0, 'renewed revision forwarded to the guest');
  const d1Machine = directMachine(d1);
  const prepared = JSON.parse(readFileSync(join(dir, 'helper', `prepare-${d1.members[0].machineId.toUpperCase()}.json`), 'utf8'));
  const boot = prepared.directBoot;
  assert.equal(prepared.image, undefined); assert.equal(boot.bundleDigest, bundleDigest);
  assert.equal(boot.commandLine, manifest.commandLine); assert.equal(boot.launchFilesystemUUID, boot.bootAttempt);
  assert.equal(boot.leaseID, d1.id); assert.equal(boot.memberID, d1.members[0].machineId);
  for (const role of ['kernel', 'initrd', 'rootfs']) assert.deepEqual(boot[role], {...pins[role], path: join(bundleDir, pins[role].path)});
  assert.equal(boot.launchMedium.path, join(directState, 'workspace', 'bootstrap', 'launch.erofs'));
  assert.equal(directJournal().direct.bootAttempt, boot.bootAttempt);
  const started = JSON.parse(readFileSync(join(d1Machine, 'direct-started.json'), 'utf8'));
  assert.equal(started.bootAttempt, boot.bootAttempt.toUpperCase()); assert.equal(started.leaseID, d1.id.toUpperCase());
  assert.match(started.agentSocket, /^\/private\/tmp\/canaveral-[0-9a-f-]{36}\/agent\.sock$/); relays.push(started.agentSocket);
  await noDirectCapacity();

  // Canned guest output traverses the real consumer route, durable controller ledger,
  // outbound Rust runner and guest wire. The fake guest never executes a program.
  const scoped = await sdk.rotateLeaseCredential(d1.id);
  const commandClient = new LeaseClient({baseUrl: origin, caFile: pem('ca.pem'), leaseId: d1.id, leaseKey: scoped.credential});
  const command = {id: randomUUID(), member: 'primary', action: 'shell', arguments: {argv: ['fixture', 'success']}};
  const commandRoute = `/v1/leases/${d1.id}/operations`;
  const operationReport = '/v1/runners/linux-leases/operations/report';
  const execsBefore = calls('exec');
  drops.add(operationReport);
  drops.add(commandRoute);
  await assert.rejects(commandClient.createOperation(command), error => error.outcome === 'unknown' && error.requestId === command.id);
  const submitted = await commandClient.createOperation(command);
  assert.equal(submitted.created, false, 'explicit replay should find the committed command');
  const completed = await until(async () => { const receipt = await commandClient.operation(command.id); return receipt.state === 'succeeded' && receipt; }, 'consumer command completion');
  assert.equal(Buffer.from(completed.result.stdoutBase64, 'base64').toString(), 'fixture-output\n');
  assert.equal(completed.result.exitCode, 0); assert.equal(completed.result.terminationConfirmed, true);
  assert.equal(completed.result.truncated, false);
  assert.equal(completed.result.stdoutBytes, 15); assert.equal(completed.result.stderrBytes, 0);
  const replay = await api('POST', commandRoute, command, scoped.credential);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, completed);
  assert.equal((await api('POST', commandRoute, {...command, arguments: {argv: ['fixture', 'wait']}}, scoped.credential)).status, 409);
  assert([401, 403].includes((await api('GET', `${commandRoute}/${command.id}`, undefined, app.credential)).status));
  await until(() => log.some(e => e.route === operationReport && e.body?.operationId === command.id && e.dropped), 'lost command report response');
  await until(() => log.filter(e => e.route === operationReport && e.body?.operationId === command.id).length >= 2, 'exact command report replay');
  const commandReports = log.filter(e => e.route === operationReport && e.body?.operationId === command.id);
  assert.deepEqual(commandReports[0].body, commandReports[1].body);
  assert.equal(calls('exec'), execsBefore + 1, 'lost reports or explicit replay repeated guest exec');
  // Credit belongs to the guest session, not an individual command. Repeated short
  // commands must not accumulate fresh grants until the protocol's 1 MiB ceiling.
  const completedCommands = 18;
  for (let i = 1; i < completedCommands; i++) {
    const next = {...command, id: randomUUID()};
    assert.equal((await commandClient.createOperation(next)).created, true);
    const receipt = await until(async () => { const r = await commandClient.operation(next.id); return r.state !== 'queued' && r; }, `sequential command ${i}`);
    assert.equal(receipt.state, 'succeeded');
    assert.equal(Buffer.from(receipt.result.stdoutBase64, 'base64').toString(), 'fixture-output\n');
  }
  assert.equal(calls('exec'), execsBefore + completedCommands);
  await sdk.releaseLease(d1.id, {id: randomUUID()});
  const readyDone = await readySatellite.done;
  assert.equal(readyDone.code, 0, readyDone.errors);
  view = await inspect(d1.id);
  assert.equal(view.state, 'released'); assert.equal(view.runtimeState, 'stopped'); assert.equal(view.cleanup.state, 'complete');
  assert(!existsSync(join(directState, 'workspace')), 'owned launch medium and workspace not removed');
  assert(!existsSync(join(started.agentSocket, '..')), 'published relay not removed');
  for (const path of artifacts) assert(existsSync(path), 'operator boot artifact removed');
  assert.equal(createHash('sha256').update(readFileSync(artifacts[2])).digest('hex'), pins.rootfs.sha256);
  assert.equal(calls('prepare'), callsBefore.prepare + 1); assert.equal(calls('run'), callsBefore.run + 1);

  // 7c. Wrong guest identity: never ready, fenced as a runtime failure, cleaned.
  guestMode('wrong-identity');
  const d2 = (await acquireDirect()).lease;
  const wrong = await run(directConfig);
  assert.equal(wrong.code, 0, wrong.errors);
  view = await inspect(d2.id);
  assert.equal(view.state, 'failed'); assert.equal(view.cleanup.state, 'complete'); neverReady(view);
  for (const e of assignmentReports(d2.id)) assert.equal(e.body.receipt.ready.command, false);

  // 7d. Stalled guest handshake: controller expiry fences without blocking the satellite.
  guestMode('stall');
  const d3 = (await acquireDirect()).lease;
  const stalled = satellite(directConfig);
  await until(() => existsSync(join(directMachine(d3), 'direct-started.json')), 'stalled guest start');
  setClock(controllerNow + 301);
  const stallDone = await stalled.done;
  assert.equal(stallDone.code, 0, stallDone.errors);
  view = await inspect(d3.id);
  assert.equal(view.state, 'expired'); assert.equal(view.cleanup.state, 'complete'); neverReady(view);

  // 7e. Crash after ready with a lost report: recovery replays it, never relaunches or executes,
  //     withdraws readiness and keeps the reservation until stop is proven.
  guestMode('commands');
  const d4 = (await acquireDirect()).lease;
  const crash = satellite(directConfig);
  await until(async () => (await inspect(d4.id)).state === 'ready', 'second direct guest ready');
  const d4Machine = directMachine(d4);
  orphans.push(Number(readFileSync(join(d4Machine, 'fixture-running'), 'utf8')));
  relays.push(JSON.parse(readFileSync(join(d4Machine, 'direct-started.json'), 'utf8')).agentSocket);
  const interruptedKey = await sdk.rotateLeaseCredential(d4.id);
  const interrupted = {id: randomUUID(), member: 'primary', action: 'shell', arguments: {argv: ['fixture', 'wait']}};
  const interruptedRoute = `/v1/leases/${d4.id}/operations`;
  assert.equal((await api('POST', interruptedRoute, interrupted, interruptedKey.credential)).status, 201);
  await until(() => calls('exec') === execsBefore + completedCommands + 1, 'guest command before crash');
  drops.add('/v1/runners/linux-leases/report');
  await until(() => assignmentReports(d4.id).some(e => e.dropped), 'dropped direct report');
  crash.kill('SIGKILL'); await crash.done;
  const runs = calls('run'), prepares = calls('prepare');
  const recovered = await run(directConfig);
  assert.equal(recovered.code, 1); assert.match(recovered.errors, /no relaunch/);
  const lostDirect = assignmentReports(d4.id).find(e => e.dropped);
  assert.deepEqual(assignmentReports(d4.id).find(e => !e.dropped && e.body.sequence === lostDirect.body.sequence).body, lostDirect.body);
  view = await inspect(d4.id);
  assert.equal(view.state, 'failed'); assert.equal(view.runtimeState, 'unknown'); assert.equal(view.members[0].ready, false);
  assert.notEqual(view.cleanup.state, 'complete'); await noDirectCapacity();
  assert.equal(assignmentReports(d4.id).at(-1).body.receipt.ready.command, false);
  const unknownCommand = await ok('GET', `${interruptedRoute}/${interrupted.id}`, undefined, interruptedKey.credential);
  assert.equal(unknownCommand.state, 'unknown');
  assert.equal(calls('run'), runs); assert.equal(calls('prepare'), prepares);
  assert.equal(calls('exec'), execsBefore + completedCommands + 1, 'crash recovery repeated a guest command');
  console.log('PASS Apple satellite public API fixture (fake helper, no VM or real command execution): preflight, TLS trust, SDK lifecycle, exact claim/report replay, cleanup-gated capacity, expiry under stalled controller, crash uncertainty without relaunch; simulated direct boot: bound readiness/renewal, command output through consumer API, lost operation report replay without duplicate exec, interrupted-command uncertainty, wrong identity, handshake expiry and owned cleanup');
} finally {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await once(c, 'exit'); }
  for (const pid of orphans) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (proxy) { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); }
  for (const socket of relays) rmSync(join(socket, '..'), {recursive: true, force: true});
  await exec('/usr/bin/chflags', ['-R', 'nouchg', dir]).catch(() => {});
  rmSync(dir, {recursive: true, force: true});
}
