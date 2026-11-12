// Operator-only native acceptance. Run directly with Node >=24; never imported by tests.
import assert from 'node:assert/strict';
import {spawn, execFile, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, chmodSync, realpathSync, writeFileSync, readFileSync, existsSync, copyFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import https from 'node:https';
import {promisify} from 'node:util';
const exec = promisify(execFile);
type ObjectValue = Record<string, any>;
assert(!process.env.CI && process.env.CANAVERAL_NATIVE_ACCEPTANCE === 'operator-authorized', 'requires explicit operator authorization outside CI');
assert.equal(process.platform, 'darwin');
process.umask(0o077);
const input = process.argv[2];
assert(input, 'usage: node coordination/native-acceptance/run.ts /absolute/config.json');
const cfg: ObjectValue = JSON.parse(readFileSync(input, 'utf8'));
// Check both names and embedded fixture markers, including renamed fixture executables.
export function refuseFixture(path: string) {
  assert(!/fixture|simulated|fake[-_ ]?helper/i.test(path), `fixture path refused: ${path}`);
  if (!existsSync(path)) return;
  const bytes = readFileSync(realpathSync(path));
  assert(!/fixture[-_ ]helper|fixture[-_ ]bootstrap[-_ ]builder|fixture-running|fixture-only guest secret|dev\.canaveral\.fixture|CANAVERAL-SIMULATED-EROFS|simulated erofs|fixture audited initrd/i.test(bytes.toString('latin1')), `fixture content refused: ${path}`);
}
for (const name of ['helper', 'builder', 'bootstrap', 'satellite', 'runnerClient', 'manifest']) {
  if (cfg[name]) { assert.equal(resolve(cfg[name]), cfg[name], `${name} must be absolute`); refuseFixture(cfg[name]); }
}
assert(cfg.helper && cfg.satellite && cfg.runnerClient && cfg.manifest && cfg.stateRoot && cfg.bundleDigest && cfg.signingRequirement);
assert.match(cfg.bundleDigest, /^sha256:[0-9a-f]{64}$/);
assert(cfg.signingRequirement.includes('anchor apple'), 'Apple signing requirement required');
const resources = {cpu: cfg.cpu ?? 2, memoryMiB: cfg.memoryMiB ?? 2048, diskGiB: cfg.diskGiB ?? 4};
const root = realpathSync(cfg.stateRoot);
const dir = mkdtempSync(join(root, 'canaveral-native-')); chmodSync(dir, 0o700);
console.log(JSON.stringify({runDirectory: dir}));
const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2), {mode: 0o600});
const sha = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const children: ChildProcess[] = [];
let proxy: https.Server | undefined;
let active: {id: string, credential: string} | undefined;
let api: (method: string, route: string, body?: unknown, token?: string) => Promise<any>;
async function until(check: () => Promise<any>, label: string, ms = 180000): Promise<any> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(200); }
  throw Error('timeout: ' + label);
}
function launch(bin: string, args: string[], name: string) {
  const c = spawn(bin, args, {stdio: ['pipe', 'pipe', 'pipe']}); children.push(c);
  let output = ''; c.stdout!.on('data', b => output += b);
  const errors: Buffer[] = []; c.stderr!.on('data', b => errors.push(b));
  const done = once(c, 'exit').then(([code, signal]) => {
    writeFileSync(join(dir, name + '.stderr'), Buffer.concat(errors));
    return {code, signal, output};
  });
  return {c, done, output: () => output};
}
try {
  const signature = await exec('/usr/bin/codesign', ['-dvvv', '--entitlements', ':-', cfg.helper]);
  writeFileSync(join(dir, 'helper-signature.txt'), signature.stdout + signature.stderr);
  await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + cfg.signingRequirement, cfg.helper]);
  assert.match(signature.stdout + signature.stderr, /com.apple.security.virtualization/);
  assert(!/Signature=adhoc/.test(signature.stderr));
  save('pins.json', {helper: sha(cfg.helper), builder: cfg.builder && existsSync(cfg.builder) ? sha(cfg.builder) : null});
  const pem = (n: string) => join(dir, n);
  const conf = pem('openssl.cnf');
  writeFileSync(conf, '[req]\ndistinguished_name=dn\n[dn]\n[ca_ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n[leaf_ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
  const ssl = (args: string[]) => exec('openssl', args, {env: {...process.env, OPENSSL_CONF: conf}});
  await ssl(['req', '-config', conf, '-x509', '-extensions', 'ca_ext', '-sha256', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('ca-key.pem'), '-out', pem('ca.pem'), '-days', '1', '-subj', '/CN=Canaveral Native Run CA']);
  await ssl(['req', '-config', conf, '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem('key.pem'), '-out', pem('leaf.csr'), '-subj', '/CN=localhost']);
  await ssl(['x509', '-req', '-sha256', '-in', pem('leaf.csr'), '-CA', pem('ca.pem'), '-CAkey', pem('ca-key.pem'), '-CAcreateserial', '-out', pem('cert.pem'), '-days', '1', '-extfile', conf, '-extensions', 'leaf_ext']);
  await ssl(['verify', '-x509_strict', '-CAfile', pem('ca.pem'), '-purpose', 'sslserver', pem('cert.pem')]);
  const admin = randomBytes(32).toString('base64url'), controllerId = randomUUID();
  writeFileSync(pem('admin'), admin);
  save('controller.json', {statePath: pem('db'), adminTokenFile: pem('admin'), controllerId, listen: {host: '127.0.0.1', port: 0}, tls: {certFile: pem('cert.pem'), keyFile: pem('key.pem')}});
  const controller = launch(process.execPath, [resolve('coordination/dist/src/main.js'), pem('controller.json')], 'controller');
  const port = await until(async () => {
    assert(controller.c.exitCode === null, 'controller exited');
    const line = controller.output().split('\n')[0]; return line && JSON.parse(line).listening.port;
  }, 'controller listen', 15000);
  const reports: any[] = [];
  proxy = https.createServer({key: readFileSync(pem('key.pem')), cert: readFileSync(pem('cert.pem'))}, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', b => chunks.push(b));
    req.on('end', () => { void (async () => {
      const raw = Buffer.concat(chunks);
      const isReport = req.url === '/v1/runners/linux-leases/report';
      const before = isReport ? await api('GET', '/v1/resource-domains/' + domainForReports) : undefined;
      const upstream = https.request({host:'127.0.0.1', servername:'localhost', port, ca:readFileSync(pem('ca.pem')), method:req.method, path:req.url, headers:req.headers, agent:false}, reply => {
        const out: Buffer[] = []; reply.on('data', b => out.push(b));
        reply.on('end', () => { void (async () => {
          const bytes = Buffer.concat(out);
          if (isReport) {
            const body = JSON.parse(raw.toString()), response = JSON.parse(bytes.toString());
            reports.push({at: new Date().toISOString(), body, response, before, after: await api('GET', '/v1/resource-domains/' + domainForReports)});
            save('runner-reports.json', reports);
            if (response.released === true) {
              assert.equal(body.receipt.cleanup, 'complete', 'reservation released before cleanup report');
              assert.equal(reports.at(-1).after.body.reservations, 0);
            } else assert.equal(reports.at(-1).after.body.reservations, 1, 'reservation disappeared before cleanup');
          }
          res.writeHead(reply.statusCode!, reply.headers); res.end(bytes);
        })().catch(e => res.destroy(e)); });
      }); upstream.on('error', e => res.destroy(e)); upstream.end(raw);
    })().catch(e => res.destroy(e)); });
  });
  let domainForReports = '';
  await new Promise<void>(r => proxy!.listen(0, '127.0.0.1', r));
  const address = proxy.address(); assert(address && typeof address !== 'string');
  const origin = `https://localhost:${address.port}`;
  api = (method, route, body, token = admin) => new Promise((res, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = https.request(origin + route, {method, ca: readFileSync(pem('ca.pem')), agent: false,
      headers: {Authorization: 'Bearer ' + token, ...(bytes ? {'Content-Type': 'application/json', 'Content-Length': bytes.length} : {})}}, response => {
      let text = ''; response.on('data', b => text += b); response.on('end', () => {
        try { res({status: response.statusCode, body: JSON.parse(text)}); } catch (e) { reject(e); }
      });
    }); r.setTimeout(20000, () => r.destroy(Error('HTTP timeout'))); r.on('error', reject); r.end(bytes);
  });
  const ok = async (m: string, r: string, b?: unknown, token?: string) => { const v = await api(m, r, b, token); assert(v.status < 300, `${r}: ${JSON.stringify(v)}`); return v.body; };
  const appBody = (name: string) => ({id: randomUUID(), name, templates: [], limits: {resources, activeLeases: 1, defaultTTLSeconds: 120, maxTTLSeconds: 300, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 180}});
  const app = await ok('POST', '/v1/consumers', appBody('native acceptance application 1'));
  const app2 = await ok('POST', '/v1/consumers', appBody('native acceptance application 2 (no grant)'));
  const domainId = randomUUID(); domainForReports = domainId;
  await ok('POST', '/v1/resource-domains', {id: domainId, name: 'native acceptance: one guest', capacity: resources});
  const binding = {controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID()};
  const approval = await ok('POST', '/v1/runner-enrollments', {id: randomUUID(), ...binding, ttlSeconds: 100});
  for (const [args, body] of [ [['prepare', pem('identity'), origin], approval], [['consume', pem('identity'), origin, pem('ca.pem')], binding] ] as [string[], unknown][]) {
    const c = launch(cfg.runnerClient, args, 'enroll-' + args[0]); c.c.stdin!.end(JSON.stringify(body));
    const result = await c.done; assert.equal(result.code, 0, 'runner enrollment failed (see stderr)');
  }
  const image = {id: 'native-linux', revision: '1', arch: 'arm64', backend: 'appleVirtualization', digest: cfg.bundleDigest};
  await ok('POST', '/v1/linux-lease-images', {...image, os: 'linux', mode: 'headless', resources, capabilities: ['command']});
  await ok('POST', '/v1/linux-lease-grants', {applicationId: app.id, imageId: image.id, revision: image.revision, arch: image.arch, digest: image.digest});
  await ok('POST', '/v1/linux-lease-runner-approvals', {binding, domainId, backend: image.backend, images: [{id:image.id, revision:image.revision, arch:image.arch, digest:image.digest}]});
  save('setup.json', {binding, domainId, image, artifactVerified: false, application1: app.id, application2: app2.id,
    domain: await ok('GET', '/v1/resource-domains/' + domainId), catalog: await ok('GET', '/v1/environments/templates', undefined, app.credential)});
  // Setup is real controller/TLS/enrollment evidence, never VM acceptance. No lease or claim yet.
  if (cfg.setupOnly || !existsSync(cfg.manifest) || !cfg.builder || !existsSync(cfg.builder)) {
    assert(cfg.setupOnly, 'real manifest and mkfs.erofs required; no lease acquired');
    save('result.json', {state: 'blocked-real-artifacts', setupComplete: true, nativeAcceptance: false});
  } else {
    const manifest = JSON.parse(readFileSync(cfg.manifest, 'utf8'));
    for (const role of ['kernel', 'initrd', 'rootfs']) refuseFixture(resolve(dirname(cfg.manifest), manifest[role].path));
    const inspect = (id: string) => ok('GET', '/v1/leases/' + id, undefined, app.credential);
    const domain = () => ok('GET', '/v1/resource-domains/' + domainId);
    let currentRun: ReturnType<typeof launch> | undefined;
    let state = '';
    async function snapshot(label: string, id: string) {
      save(label + '.json', {at: new Date().toISOString(), lease: await inspect(id), domain: await domain()});
      const journal = join(state, 'state.json');
      if (existsSync(journal)) copyFileSync(journal, pem(label + '.journal.json'));
    }
    // Capture process tree and console while the helper exists, before cleanup removes its directory.
    const journalVersions = new Set<string>();
    const observed = new Map<string, {pids: number[], machine: string, relay?: string}>();
    async function observe(id: string) {
      if (!existsSync(join(state, 'state.json'))) return;
      const journalBytes = readFileSync(join(state, 'state.json'));
      const journalHash = createHash('sha256').update(journalBytes).digest('hex');
      if (!journalVersions.has(journalHash)) {
        writeFileSync(pem(id + '-journal-' + journalVersions.size + '.json'), journalBytes);
        journalVersions.add(journalHash);
      }
      const j = JSON.parse(journalBytes.toString());
      if (!j.assignment) return;
      const machine = join(state, 'workspace', j.assignment.memberId.toUpperCase());
      const ps = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout;
      const rows = ps.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[];
      const pids = rows.filter(r => Number(r[2]) === currentRun?.c.pid && r[3]!.includes(cfg.helper + ' run ' + machine)).map(r => Number(r[1]));
      const old = observed.get(id);
      observed.set(id, {pids: [...new Set([...(old?.pids ?? []), ...pids])], machine, relay: j.direct?.agentSocket ?? old?.relay});
      save(id + '-observed-processes.json', observed.get(id));
      for (const name of ['boot.log', 'console.log', 'direct-started.json']) if (existsSync(join(machine, name))) copyFileSync(join(machine, name), pem(id + '-' + name));
      if (existsSync(join(machine, 'console.log'))) copyFileSync(join(machine, 'console.log'), pem(id + '-boot.log'));
      writeFileSync(pem(id + '-processes.txt'), ps);
      copyFileSync(join(state, 'state.json'), pem(id + '-latest.journal.json'));
    }
    const acquireBody = (ttlSeconds: number) => ({id: randomUUID(), templateId: image.id, templateRevision: image.revision, arch: image.arch, ttlSeconds, requiredCapabilities: ['command']});
    async function start(label: string, ttl = 120) {
      const lease = await ok('POST', '/v1/leases', acquireBody(ttl), app.credential);
      active = {id: lease.id, credential: app.credential};
      state = pem(label + '-satellite');
      save(label + '-satellite.json', {origin, identity: pem('identity'), binding, state, helper: cfg.helper, helperSha256: sha(cfg.helper), signingRequirement: cfg.signingRequirement,
        ca: pem('ca.pem'), inventory: [{credentialFree: true, format: 'bootBundle', image, path: cfg.manifest}],
        bootstrapBuilder: {path: cfg.builder, sha256: sha(cfg.builder)}, maxCpu: resources.cpu, maxMemoryMiB: resources.memoryMiB, maxDiskGiB: resources.diskGiB});
      await snapshot(label + '-before', lease.id);
      currentRun = launch(cfg.satellite, ['run-once', pem(label + '-satellite.json')], label);
      await until(async () => { await observe(lease.id); const v = await inspect(lease.id); assert(!['failed','expired','released'].includes(v.state), 'guest failed before ready'); return v.state === 'ready' && v; }, 'real guest ready');
      await until(async () => { await observe(lease.id); return observed.get(lease.id)?.pids.length && existsSync(pem(lease.id + '-boot.log')); }, 'helper PID and boot console');
      await snapshot(label + '-ready', lease.id);
      const credential = (await ok('POST', `/v1/leases/${lease.id}/credential`, {}, app.credential)).credential;
      const operation = randomUUID();
      await ok('POST', `/v1/leases/${lease.id}/operations`, {id:operation, member:'primary', action:'shell', arguments:{argv:['/bin/cat','/proc/self/mountinfo']}}, credential);
      const receipt = await until(async () => {
        await observe(lease.id);
        const r = await ok('GET', `/v1/leases/${lease.id}/operations/${operation}`, undefined, credential);
        return ['succeeded','failed','unknown','cancelled'].includes(r.state) && r;
      }, 'guest mountinfo');
      save(label + '-mountinfo-command.json', receipt);
      assert.equal(receipt.state, 'succeeded');
      const mountinfo = Buffer.from(receipt.result.stdoutBase64, 'base64').toString();
      const launchMount = mountinfo.split('\n').find((line: string) => line.split(' ')[4] === '/etc/canaveral');
      assert(launchMount, 'missing guest launch mount');
      for (const flag of ['ro','nosuid','nodev','noexec']) assert(launchMount.split(' ')[5]!.split(',').includes(flag));
      writeFileSync(pem(label + '-mountinfo.txt'), mountinfo);
      return lease.id;
    }
    async function stopped(label: string, id: string) {
      await until(async () => { await observe(id); return (await inspect(id)).cleanup.state === 'complete'; }, 'positive cleanup');
      assert.equal((await currentRun!.done).code, 0);
      const record = observed.get(id)!; assert(record?.pids.length, 'no independent helper PID observation');
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { assert.equal(e.code, 'ESRCH'); return false; } };
      for (const pid of record.pids) assert(!alive(pid), 'helper still alive');
      const ps = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout;
      // Fail conservatively on any VZ service still present: process names alone cannot attribute a VM.
      assert(!ps.split('\n').some(l => /com\.apple\.Virtualization\.VirtualMachine/.test(l)), 'VZ process remains; VM attribution requires operator inspection');
      assert(!existsSync(record.machine)); assert(!existsSync(join(state, 'workspace')));
      assert(record.relay, 'no published relay evidence'); assert(!existsSync(dirname(record.relay)));
      const journal = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
      assert(journal.stopped && journal.cleaned && journal.released);
      save(label + '-independent-stop.json', {helperPids: record.pids, helperPidsGone: true, noVZProcess: true, machineRemoved: true, workspaceRemoved: true, relayRemoved: true, journal});
      await snapshot(label + '-after', id); active = undefined;
    }
    const id = await start('release');
    for (const [m, route, body] of [ ['GET', `/v1/leases/${id}`, undefined], ['POST', `/v1/leases/${id}/credential`, {}], ['POST', `/v1/leases/${id}/operations`, {id: randomUUID(), member:'primary', action:'shell', arguments:{argv:['printf','denied']}}] ] as [string,string,unknown][]) {
      const r = await api(m, route, body, app2.credential); assert([401,403,404].includes(r.status)); save('ownership-' + m + '-' + route.split('/').at(-1) + '.json', r);
    }
    assert.equal((await api('POST', '/v1/leases', acquireBody(120), app2.credential)).status, 403);
    const credential = (await ok('POST', `/v1/leases/${id}/credential`, {}, app.credential)).credential;
    const operation = randomUUID();
    await ok('POST', `/v1/leases/${id}/operations`, {id: operation, member:'primary', action:'shell', arguments:{argv:['/bin/sh','-c','printf canaveral-native-command']}}, credential);
    const receipt = await until(async () => { await observe(id); const r = await ok('GET', `/v1/leases/${id}/operations/${operation}`, undefined, credential); return ['succeeded','failed','unknown','cancelled'].includes(r.state) && r; }, 'guest command');
    assert.equal(receipt.state, 'succeeded'); assert.equal(Buffer.from(receipt.result.stdoutBase64, 'base64').toString(), 'canaveral-native-command'); save('command.json', receipt);
    const originalExpiresAt = Date.parse((await inspect(id)).expiresAt);
    await pause(1100);
    await ok('POST', `/v1/leases/${id}/renew`, {id:randomUUID(), expectedRevision:(await inspect(id)).revision, ttlSeconds:180}, app.credential);
    const renewedRevision = (await inspect(id)).revision;
    await until(async () => {
      await observe(id);
      const machine = observed.get(id)!.machine;
      const file = join(machine, 'lease-authorization.json');
      if (!existsSync(file)) return false;
      const authorization = JSON.parse(readFileSync(file, 'utf8'));
      if (authorization.revision < renewedRevision) return false;
      save('renewed-native-authorization.json', authorization); return true;
    }, 'renewal delivered to native lease guard');
    await until(async () => Date.now() > originalExpiresAt + 2000, 'past original deadline and guest margin');
    const renewalCommand = randomUUID();
    await ok('POST', "/v1/leases/" + id + "/operations", {id:renewalCommand, member:'primary', action:'shell', arguments:{argv:['/bin/sh','-c','printf renewed-after-original-deadline']}}, credential);
    const renewalReceipt = await until(async () => {
      await observe(id);
      const r = await ok('GET', "/v1/leases/" + id + "/operations/" + renewalCommand, undefined, credential);
      return ['succeeded','failed','unknown','cancelled'].includes(r.state) && r;
    }, 'post-deadline renewal command');
    assert.equal(renewalReceipt.state, 'succeeded');
    assert.equal(Buffer.from(renewalReceipt.result.stdoutBase64, 'base64').toString(), 'renewed-after-original-deadline');
    save('renewal-post-deadline-command.json', {originalExpiresAt, observedAt:Date.now(), receipt:renewalReceipt});
    await snapshot('renewed', id);
    await ok('POST', `/v1/leases/${id}/release`, {id:randomUUID()}, app.credential); await stopped('release', id);
    const expiry = await start('expiry', 120);
    await until(async () => {
      await observe(expiry);
      const view = await inspect(expiry);
      if (view.state === 'failed') { await snapshot('expiry-failed', expiry); throw Error('guest failure preempted wall-clock expiry'); }
      return view.state === 'expired';
    }, 'wall-clock expiry'); await stopped('expiry', expiry);
    const lost = await start('satellite-loss', 120);
    currentRun!.c.kill('SIGKILL'); await currentRun!.done;
    const lossDeadline = Date.parse((await inspect(lost)).expiresAt);
    const killedAt = Date.now();
    assert(!existsSync(join(observed.get(lost)!.machine, 'power-off.request')));
    // Do not reset state or fabricate cleanup. Preserve this isolated database and reservation.
    await until(async () => {
      const record = observed.get(lost)!;
      return record.pids.every(pid => { try { process.kill(pid, 0); return false; } catch (e: any) { assert.equal(e.code, 'ESRCH'); return true; } });
    }, 'orphan helper independent deadline', 180000);
    const stoppedObservedAt = Date.now();
    const record = observed.get(lost)!;
    for (const pid of record.pids) { try { process.kill(pid, 0); throw Error('orphan helper still alive'); } catch (e: any) { assert.equal(e.code, 'ESRCH'); } }
    const lossProcesses = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])).stdout;
    writeFileSync(pem('loss-final-processes.txt'), lossProcesses);
    assert(!lossProcesses.split('\n').some(l => /com\.apple\.Virtualization\.VirtualMachine/.test(l)), 'VZ process remains after loss deadline');
    assert(!existsSync(join(record.machine, 'power-off.request')), 'controller recovery contaminated autonomous fence');
    await until(async () => Date.now() > lossDeadline + 2000, 'past loss deadline');
    save('loss-independent-fence.json', {lossDeadline, killedAt, stoppedObservedAt, stopOffsetMs:stoppedObservedAt - lossDeadline, checkedPastDeadlineAt:Date.now(), autonomous:true, helperPids:record.pids, helperPidsGone:true, noVZProcess:true, reservationHeld:(await domain()).reservations === 1, cleanupProven:false});
    // Recovery must report unknown, never relaunch; native deadline independently fences execution.
    const recovery = launch(cfg.satellite, ['run-once', pem('satellite-loss-satellite.json')], 'loss-recovery');
    assert.equal((await recovery.done).code, 1);
    assert.equal((await inspect(lost)).runtimeState, 'unknown'); assert.notEqual((await inspect(lost)).cleanup.state, 'complete'); assert.equal((await domain()).reservations, 1);
    const capacity = await api('POST', '/v1/leases', acquireBody(120), app.credential); assert([429,503].includes(capacity.status));
    await snapshot('loss-held', lost);
    active = undefined;
    save('result.json', {state:'cases-completed', nativeAcceptance:true, lossReservationHeld:true, lossCleanupRequiresOperatorReconciliation:true});
  }
} catch (e: any) { save('failure.json', {message:e.message, stack:e.stack, activeLease:active?.id}); process.exitCode = 1; }
finally {
  if (active && api!) {
    // A release is intent only. Never delete machine state or kill the helper as a substitute for proof.
    await api('POST', `/v1/leases/${active.id}/release`, {id:randomUUID()}, active.credential).catch(() => {});
    await pause(5000);
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>(r => proxy!.close(() => r())); }
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  for (const c of children) if (c.exitCode === null && c.signalCode === null) await Promise.race([once(c, 'exit'), pause(20000)]);
}
