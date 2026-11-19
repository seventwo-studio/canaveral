import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

const dashboardHost = 'dashboard.canaveral.test';
const previewDomain = 'sites.canaveral-preview.test';
const file = (path, content) => ({ path, data: Buffer.from(content).toString('base64') });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Queued dashboard preview trial. The adapter owns the native controller, satellite and evidence:
 * - fill(): admit and boot a workspace from another application so the one-box domain is full.
 * - onWaiting(spec): prove the preview's request holds no lease or reservation while it waits.
 * - onCancelled(spec): prove a cancelled waiting preview never received a lease.
 * - restart(): close the dashboard and return a new server on the same preview database.
 * - free(spec): release the filler and wait for its positive cleanup; the waiting preview is then admitted.
 * - onLaunch(spec): wait for admission and start the satellite for the preview's lease.
 * - onCleanup(spec): verify complete cleanup, process and storage removal and zero reservations.
 * - record(name): save an allow-listed outcome.
 */
export async function dashboardQueuedPreviews({ dashboard, restart, cert, key, ca, accounts, fill, onWaiting, onCancelled, free, onLaunch, onCleanup, record }) {
  let server = dashboard;
  const ingress = https.createServer({ cert, key }, (req, res) => server.emit('request', req, res));
  await new Promise((resolve, reject) => ingress.once('error', reject).listen(0, '127.0.0.1', resolve));
  function request(host, path, method = 'GET', cookie, body) {
    const bytes = body && Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port: ingress.address().port, servername: host, ca, path, method,
        headers: { host, ...(cookie && { cookie }), ...(method !== 'GET' && { origin: 'https://' + host }),
          ...(bytes && { 'content-type': 'application/json', 'content-length': bytes.length }) },
      }, res => {
        const chunks = [];
        res.on('error', reject).on('data', chunk => chunks.push(chunk)).on('end', () => resolve({
          status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(),
        }));
      });
      req.setTimeout(30000, () => req.destroy(Error('trial request timed out')));
      req.on('error', reject).end(bytes);
    });
  }
  const cookie = response => response.headers['set-cookie']?.[0]?.split(';')[0];
  let session;
  async function login() {
    const response = await request(dashboardHost, '/api/v1/auth/login', 'POST', undefined, accounts[0]);
    assert.equal(response.status, 200);
    session = cookie(response);
    assert.ok(session);
  }
  const api = async (path, method, body) => {
    const response = await request(dashboardHost, '/api/v1/previews' + path, method, session, body);
    return { status: response.status, body: response.text ? JSON.parse(response.text) : undefined };
  };
  async function until(id, wanted, seconds, label) {
    for (let i = 0; ; i++) {
      const item = await api('/' + id);
      assert.equal(item.status, 200);
      if (wanted(item.body)) return item.body;
      assert.ok(i < seconds, label);
      await pause(1000);
    }
  }
  const asset = 'window.trial="' + randomUUID() + '"';
  const html = '<script src="/assets/app.js"></script>';
  // An explicit waiting deadline keeps the trial independent of how long the filler takes to boot and clean up.
  const deadline = () => new Date(Date.now() + 15 * 60000).toISOString();
  const waiting = { id: randomUUID(), mode: 'static', deadline: deadline(), files: [file('index.html', html), file('assets/app.js', asset)] };
  const cancelled = { id: randomUUID(), mode: 'static', deadline: deadline(), files: [file('index.html', '<p>cancelled</p>')] };
  let site, siteCookie, launched = false;
  try {
  try {
    await login();
    await fill();
    for (const spec of [waiting, cancelled]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const created = await api('', 'POST', spec);
        assert.equal(created.status, 200);
        assert.equal(created.body.id, spec.id);
      }
      const queued = await until(spec.id, p => p.request?.state === 'waiting', 30, 'preview did not wait');
      assert.equal(queued.state, 'provisioning');
      assert.equal(queued.expiresAt, spec.deadline);
      await onWaiting(spec);
    }
    record('waiting');
    assert.equal((await api('/' + cancelled.id, 'DELETE')).status, 200);
    const stopped = await until(cancelled.id, p => ['stopped', 'failed'].includes(p.state), 30, 'cancelled preview did not stop');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.request.state, 'cancelled');
    assert.equal(stopped.request.reason, 'consumer_cancelled');
    await onCancelled(cancelled);
    record('cancelled');
    server = await restart();
    await login();
    await pause(3000);
    const resumed = await until(waiting.id, p => p.request?.state === 'waiting', 10, 'restart ended the waiting preview');
    assert.equal(resumed.state, 'provisioning');
    record('restart');
    await free(waiting);
    await onLaunch(waiting);
    launched = true;
    const ready = await until(waiting.id, p => p.state === 'ready' || ['failed', 'stopped'].includes(p.state), 180, 'preview readiness timed out');
    assert.equal(ready.state, 'ready');
    assert.equal(ready.request.state, 'admitted');
    assert.ok(Date.parse(ready.expiresAt) > Date.parse(ready.request.admittedAt), 'lifetime did not start at admission');
    const opened = await api('/' + waiting.id + '/open', 'POST', {});
    assert.equal(opened.status, 200);
    site = new URL(opened.body.handoffUrl);
    assert.ok(site.hostname.endsWith('.' + previewDomain));
    const redeemed = await request(site.hostname, site.pathname);
    assert.equal(redeemed.status, 303);
    siteCookie = cookie(redeemed);
    const root = await request(site.hostname, '/', 'GET', siteCookie);
    assert.equal(root.status, 200);
    assert.equal(root.text, html);
    const script = await request(site.hostname, '/assets/app.js', 'GET', siteCookie);
    assert.equal(script.status, 200);
    assert.equal(script.text, asset);
    record('served');
  } finally {
    await api('/' + waiting.id, 'DELETE').catch(() => {});
    if (launched) await onCleanup(waiting);
  }
  const final = await until(waiting.id, p => ['stopped', 'failed'].includes(p.state), 60, 'release did not reach stopped');
  assert.equal(final.state, 'stopped');
  assert.equal((await request(site.hostname, '/', 'GET', siteCookie)).status, 404);
  record('released');
  } finally {
    ingress.closeAllConnections();
    await new Promise(resolve => ingress.close(resolve));
    server.close();
  }
}
