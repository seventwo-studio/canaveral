import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import https from 'node:https';

const dashboardHost = 'dashboard.canaveral.test';
const previewDomain = 'sites.canaveral-preview.test';
export const certificateNames = [dashboardHost, '*.' + previewDomain];
const file = (path, content) => ({ path, data: Buffer.from(content).toString('base64') });

export async function dashboardSites({ dashboard, cert, key, ca, accounts, onLaunch, onCleanup, record }) {
  const ingress = https.createServer({ cert, key }, (req, res) => dashboard.emit('request', req, res));
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
  try {
    const sessions = [];
    for (const account of accounts) {
      const login = await request(dashboardHost, '/api/v1/auth/login', 'POST', undefined, account);
      assert.equal(login.status, 200);
      assert.ok(cookie(login));
      sessions.push(cookie(login));
    }
    const api = (path, method, body, owner = 0) => request(dashboardHost, '/api/v1/previews' + path, method, sessions[owner], body);
    const assets = [['assets/nested/app.js', 'window.trial="' + randomUUID() + '"'], ['assets/style.css', '/*' + randomUUID() + '*/']];
    const html = '<link rel="stylesheet" href="/assets/style.css"><script src="/assets/nested/app.js"></script>';
    for (const spec of [
      { mode: 'static', files: [file('index.html', html), ...assets.map(([p, s]) => file(p, s))] },
      { mode: 'command', port: 3000, argv: ['node', 'app.cjs'], files: [file('app.cjs',
        "require('node:http').createServer((req,res)=>res.end(req.url)).listen(3000,'127.0.0.1')")] },
    ]) {
      spec.id = randomUUID();
      const path = '/' + spec.id;
      let site, siteCookie;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const created = await api('', 'POST', spec);
          assert.equal(created.status, 200);
          assert.equal(JSON.parse(created.text).id, spec.id);
        }
        await onLaunch(spec);
        for (let i = 0; ; i++) {
          const item = await api(path);
          assert.equal(item.status, 200);
          const state = JSON.parse(item.text).state;
          if (state === 'ready') break;
          assert.ok(i < 90 && ['starting','provisioning'].includes(state), 'preview readiness failed');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        for (const [p,m,b] of [[path,'GET'],[path+'/open','POST',{}],[path,'DELETE']]) {
          assert.ok([403,404].includes((await api(p,m,b,1)).status), 'second account obtained access');
        }
        const opened = await api(path + '/open', 'POST', {});
        assert.equal(opened.status, 200);
        site = new URL(JSON.parse(opened.text).handoffUrl);
        assert.ok(site.hostname.endsWith('.' + previewDomain));
        const redeemed = await request(site.hostname, site.pathname);
        assert.equal(redeemed.status, 303);
        assert.equal(redeemed.headers.location, '/');
        siteCookie = cookie(redeemed);
        assert.ok(siteCookie);
        assert.equal((await request(site.hostname, site.pathname)).status, 404);
        assert.equal((await request(site.hostname, '/', 'GET', sessions[1])).status, 404);
        const get = p => request(site.hostname, p, 'GET', siteCookie);
        if (spec.mode === 'static') {
          const root = await get('/');
          assert.equal(root.status, 200);
          assert.equal(root.text, html);
          const replies = await Promise.all(assets.map(([p]) => get('/' + p)));
          for (const [i, response] of replies.entries()) {
            assert.equal(response.status, 200);
            assert.equal(response.text, assets[i][1]);
          }
        } else {
          const nonce = '/live?nonce=' + randomUUID();
          const response = await get(nonce);
          assert.equal(response.status, 200);
          assert.equal(response.text, nonce);
        }
      } finally {
        assert.equal((await api(path, 'DELETE')).status, 200);
        await onCleanup(spec);
        for (let i = 0; ; i++) {
          const item = await api(path);
          assert.equal(item.status, 200);
          const state = JSON.parse(item.text).state;
          if (state === 'stopped') break;
          assert.ok(i < 30 && state === 'stopping', 'release did not reach stopped');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      assert.equal((await request(site.hostname, '/', 'GET', siteCookie)).status, 404);
      record(spec.mode);
    }
  } finally {
    ingress.closeAllConnections();
    await new Promise(resolve => ingress.close(resolve));
    dashboard.close();
  }
}
