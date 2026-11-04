// Fixture only. Run after building Rust and coordination. Requires Node >=24 and openssl.
// COORDINATION_DIR may point at an independently prepared authoritative public tree.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request } from 'node:https';
const exec = promisify(execFile);
const source = resolve(process.env.COORDINATION_DIR ?? 'coordination');
const { IdentityClient } = await import(pathToFileURL(join(source, 'dist/src/identity-client.js')));
const { createIdentityServer } = await import(pathToFileURL(join(source, 'dist/src/http.js')));
const dir = mkdtempSync(join(realpathSync(tmpdir()), 'runner-tls-'));
const bin = resolve('target/debug/canaveral-runner-client');
const key = () => randomBytes(32).toString('base64url');
const admin = key(), controllerId = randomUUID();
const identities = new IdentityClient({ path: join(dir, 'identity.sqlite'), adminToken: admin, controllerId });
const http = createIdentityServer(identities);
let lose = false, mode = '', calls = 0;
let server, leaseCredential, leaseBinding, leaseLoss = false;
const leaseRequests = [];
try {
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'ca-key.pem'), '-out', join(dir, 'ca.pem'), '-days', '1', '-subj', '/CN=Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'leaf.csr'), '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  await exec('openssl', ['x509', '-req', '-in', join(dir, 'leaf.csr'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca-key.pem'), '-CAcreateserial', '-out', join(dir, 'cert.pem'), '-days', '1', '-extfile', join(dir, 'ext.cnf')]);
  const ca = readFileSync(join(dir, 'ca.pem'));
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
    calls++;
    if (req.url.startsWith('/v1/runners/linux-leases/')) {
      assert.equal(req.headers.authorization, `Bearer ${leaseCredential}`);
      assert.equal(req.headers.origin, undefined);
      let bytes = ''; req.on('data', b => bytes += b);
      req.on('end', () => {
        const body = JSON.parse(bytes); assert.deepEqual(body.binding, leaseBinding);
        assert.equal(Number(req.headers['content-length']), Buffer.byteLength(bytes));
        leaseRequests.push({route:req.url, body});
        if (leaseLoss) { leaseLoss = false; res.destroy(); return; }
        res.end(JSON.stringify(req.url.endsWith('/claim') ? {assignment:null} :
          req.url.endsWith('/assignments') ? {assignments:[]} : {assignmentId:body.assignmentId,sequence:body.sequence}));
      }); return;
    }
    if (mode === 'redirect') { mode = ''; res.writeHead(307, { Location: `https://localhost:${server.address().port}/v1/runners/authenticate` }); res.end(); return; }
    if (mode === 'timeout') return;
    if (mode === 'wrong-binding') { res.end(JSON.stringify({ controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID(), credentialRevision: 1 })); return; }
    if (mode === 'oversize') { res.end(JSON.stringify({ ...b, credentialRevision: 1 }) + ' '.repeat(17000)); return; }
    if (lose && req.url === '/v1/runner-enrollments/consume') {
      lose = false;
      // Identity handler calls end only after the worker's durable consume receipt.
      res.end = () => { res.destroy(); return res; };
    }
    http.emit('request', req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `https://localhost:${port}`;
  function api(route, token, body) {
    return new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(body));
      const r = request(`${origin}${route}`, { ca, family: 4, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Length': bytes.length, 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.on('data', b => data += b); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }); r.on('error', reject); r.end(bytes);
    });
  }
  function cli(command, binding, { trust = true, caFile = join(dir, 'ca.pem'), url = origin, ok = true, state = 'runner' } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [command, join(dir, state), url, ...(trust ? [caFile] : [])], { env: { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
      child.on('error', reject); child.on('close', code => { try { assert.equal(code === 0, ok, `${command}, server calls ${calls}: ${text}`); assert(!text.includes(approval?.enrollmentToken)); resolve(text); } catch (e) { reject(e); } });
      child.stdin.end(JSON.stringify(binding));
    });
  }
  const b = { controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const issued = await api('/v1/runner-enrollments', admin, { id: randomUUID(), ...b, ttlSeconds: 100 });
  assert.equal(issued.status, 200); const approval = issued.body;
  await cli('prepare', approval);
  const saved = () => JSON.parse(readFileSync(join(dir, 'runner/identity.json'))).record;
  const credential = saved().credential;
  lose = true; await cli('consume', b, { ok: false });
  assert.equal(saved().phase, 'Uncertain'); assert.equal(saved().credential, credential);
  await cli('authenticate', b); await cli('consume', b); // restart + exact durable receipt
  assert.equal(saved().credential, credential);
  leaseCredential = credential; leaseBinding = b;
  const leaseBin = resolve('target/debug/examples/lease-route');
  async function lease(route, body, binding=b, ok=true) {
    return new Promise((resolve,reject) => {
      const child=spawn(leaseBin,[join(dir,'runner'),origin,join(dir,'ca.pem'),route],{stdio:['pipe','pipe','pipe']});
      let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',()=>{});
      child.on('error',reject); child.on('close',code=>{
        try {assert.equal(code===0,ok); resolve(ok?JSON.parse(output):null)} catch(e){reject(e)}
      });
      child.stdin.end(JSON.stringify({binding,body}));
    });
  }
  const claimId=randomUUID();
  leaseLoss=true; await lease('claim',{claimId},b,false);
  assert.deepEqual(await lease('claim',{claimId}),{assignment:null});
  assert.deepEqual(leaseRequests[0],leaseRequests[1]);
  assert.deepEqual(await lease('assignments',{}),{assignments:[]});
  assert.equal((await lease('report',{assignmentId:randomUUID(),sequence:1,receipt:{}})).sequence,1);
  const leaseCount=leaseRequests.length;
  await lease('claim',{claimId},{...b,generation:2},false);
  assert.equal(leaseRequests.length,leaseCount);
  const before = calls;
  await cli('authenticate', { ...b, controllerId: randomUUID() }, { ok: false });
  assert.equal(calls, before);
  await cli('authenticate', b, { trust: false, ok: false }); // unrelated public roots
  assert.equal(calls, before);
  writeFileSync(join(dir, 'empty.pem'), '');
  writeFileSync(join(dir, 'not-ca.pem'), readFileSync(join(dir, 'key.pem')));
  for (const file of ['empty.pem', 'not-ca.pem']) {
    await cli('authenticate', b, { caFile: join(dir, file), ok: false });
    assert.equal(calls, before);
  }
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'other-key.pem'), '-out', join(dir, 'other-ca.pem'), '-days', '1', '-subj', '/CN=Unrelated Fixture CA']);
  await cli('authenticate', b, { caFile: join(dir, 'other-ca.pem'), ok: false });
  assert.equal(calls, before);
  // Rust must reject a trusted chain whose SAN does not cover the origin IP.
  const ip = `https://127.0.0.1:${port}`;
  await cli('prepare', approval, { url: ip, state: 'runner-ip' });
  await cli('authenticate', b, { url: ip, state: 'runner-ip', ok: false });
  assert.equal(calls, before);
  mode = 'timeout';
  const start = Date.now(); await cli('authenticate', b, { ok: false });
  assert(Date.now() - start >= 14000 && Date.now() - start < 19000); assert.equal(saved().phase, 'Uncertain');
  mode = 'wrong-binding'; await cli('authenticate', b, { ok: false });
  mode = 'redirect'; const redirectCalls = calls; await cli('authenticate', b, { ok: false }); assert.equal(calls, redirectCalls + 1);
  mode = 'oversize'; await cli('authenticate', b, { ok: false }); mode = '';
  for (const changed of [{ generation: 2 }, { incarnationId: randomUUID() }, { runnerId: randomUUID() }]) {
    assert.equal((await api('/v1/runners/authenticate', credential, { ...b, ...changed })).status, 401);
  }
  assert.equal((await api('/v1/runners/authenticate', key(), b)).status, 401);
  assert.equal((await api('/v1/runner-enrollments/consume', approval.enrollmentToken, { id: approval.id, ...b, credential: key() })).status, 401);
  assert.equal((await api('/v1/runners/credential', admin, { ...b, credentialRevision: 2, credential: key() })).status, 200);
  await cli('authenticate', b, { ok: false }); await cli('consume', b, { ok: false });
  assert.equal((await api('/v1/runners/revoke', admin, b)).status, 200);
  await cli('authenticate', b, { ok: false });
  const fresh = { ...b, generation: 2, incarnationId: randomUUID() };
  const next = await api('/v1/runner-enrollments', admin, { id: randomUUID(), ...fresh, ttlSeconds: 100 });
  assert.equal(next.status, 200);
  assert.equal((await api('/v1/runner-enrollments/consume', next.body.enrollmentToken, { id: next.body.id, ...fresh, credential: key() })).status, 200);
  await cli('authenticate', b, { ok: false });
  console.log('TLS TypeScript/Rust conformance passed: lost reply/restart, exact retry, proxy bypass, trust, bounded/redirect rejection, binding and rotation/revocation/generation fencing');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  http.close(); await identities.close(); rmSync(dir, { recursive: true, force: true });
}
