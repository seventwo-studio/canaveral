import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { chromium, firefox, webkit } from 'playwright-core';
import type { Browser, BrowserContext, BrowserServer, Page } from 'playwright-core';
import { createBrowserRuntime } from '../src/browser-runtime.ts';
import { BrowserClient, BrowserSession } from '../src/browser-sdk.ts';

const token = 'a'.repeat(32);
async function fixture(launch?: () => Promise<BrowserServer>) {
  let launches = 0, closes = 0;
  const runtime = createBrowserRuntime({ token, publicOrigin: 'http://127.0.0.1:1234', maxBrowsers: 1, launch: launch ?? (async () => { launches++; return { close: async () => { closes++; }, wsEndpoint: () => 'ws://127.0.0.1:1/native-secret' } as BrowserServer; }) });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const origin = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  const call = (path: string, method = 'GET', body?: unknown, credential = token, originHeader = false) => fetch(origin + path, { method, headers: { Authorization: `Bearer ${credential}`, ...(originHeader ? { Origin: origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { runtime, call, origin, launches: () => launches, closes: () => closes };
}
test('boot is authenticated, bounded, replayable and never exposes the native endpoint', async () => {
  const f = await fixture();
  try {
    const body = { id: randomUUID(), engine: 'chromium', ttlSeconds: 60 };
    assert.equal((await f.call('/v1/browsers', 'POST', body, 'wrong')).status, 403);
    assert.equal((await f.call('/v1/browsers', 'POST', body, token, true)).status, 403);
    assert.equal((await f.call('/v1/browsers', 'POST', { ...body, ttlSeconds: 0 })).status, 400);
    const results = await Promise.all([f.call('/v1/browsers', 'POST', body), f.call('/v1/browsers', 'POST', body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    const [first, replay] = await Promise.all(results.map(r => r.json())); assert.deepEqual(first, replay);
    assert.equal(f.launches(), 1); assert.equal(first.endpoint, `ws://127.0.0.1:1234/v1/browsers/${body.id}/connect`);
    assert.equal(JSON.stringify(first).includes('native-secret'), false);
    assert.equal((await f.call(`/v1/browsers/${body.id}`, 'GET', undefined, first.key)).status, 403);
    assert.equal((await f.call('/v1/browsers', 'POST', { ...body, engine: 'firefox' })).status, 409);
    assert.equal((await f.call('/v1/browsers', 'POST', { ...body, id: randomUUID() })).status, 429);
    assert.equal((await f.call(`/v1/browsers/${body.id}`, 'DELETE')).status, 200);
    assert.equal(f.closes(), 1);
    assert.equal((await f.call('/v1/browsers', 'POST', body)).status, 410);
    assert.equal((await f.call('/v1/browsers', 'POST', { ...body, id: randomUUID() })).status, 201);
  } finally { await f.runtime.close(); }
});
test('failed launch is retained and never silently retried', async () => {
  let launches = 0;
  const f = await fixture(async () => { launches++; throw new Error('private native path'); });
  try {
    const body = { id: randomUUID(), engine: 'webkit', ttlSeconds: 60 };
    const response = await f.call('/v1/browsers', 'POST', body);
    assert.equal(response.status, 503); assert.equal((await response.text()).includes('private'), false);
    assert.equal((await f.call('/v1/browsers', 'POST', body)).status, 410); assert.equal(launches, 1);
  } finally { await f.runtime.close(); }
});
test('WebSocket gateway requires the session key and strips credentials upstream', async () => {
  const upstream = createServer(); let authorization: string | undefined;
  upstream.on('upgrade', (req, socket) => { authorization = req.headers.authorization; assert.equal(req.url, '/native-secret'); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const f = await fixture(async () => ({ close: async () => {}, wsEndpoint: () => `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}/native-secret` }) as BrowserServer);
  try {
    const body = { id: randomUUID(), engine: 'chromium', ttlSeconds: 60 };
    const receipt = await (await f.call('/v1/browsers', 'POST', body)).json();
    const upgrade = (key: string) => new Promise<number>((resolve, reject) => {
      const req = request(`${f.origin}/v1/browsers/${body.id}/connect`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Authorization: `Bearer ${key}` } });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode!); }); req.on('response', res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end();
    });
    assert.equal(await upgrade(token), 403); assert.equal(await upgrade(receipt.key), 101); assert.equal(authorization, undefined);
  } finally { await f.runtime.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
test('SDK rejects insecure origins and invalid forwarding before dispatch', async () => {
  assert.throws(() => new BrowserClient('http://remote.example', token, { chromium, firefox, webkit }));
  assert.throws(() => new BrowserClient('https://user:secret@remote.example', token, { chromium, firefox, webkit }));
  const client = new BrowserClient('http://127.0.0.1:1', token, { chromium, firefox, webkit });
  await assert.rejects(client.boot({ id: randomUUID(), localPorts: [0] }), /ports/);
  await assert.rejects(client.boot({ id: 'invalid' }), /UUID/);
});
test('tabs, JavaScript, selectors and coordinate gestures target the chosen real-page adapter', async () => {
  const calls: unknown[] = [], pages: Page[] = [];
  const context = { on() {}, pages: () => [], close: async () => {}, newPage: async () => {
    const page = { on() {}, url: () => 'about:blank', isClosed: () => false, bringToFront: async () => {}, evaluate: async (js: string) => { calls.push(js); return 42; }, goto: async (url: string) => { calls.push(url); }, locator: (s: string) => ({ click: async () => { calls.push(s); } }), mouse: { click: async (x: number, y: number) => { calls.push([x, y]); }, move: async () => {}, down: async () => { calls.push('down'); }, up: async () => { calls.push('up'); } } } as unknown as Page;
    pages.push(page); return page;
  } } as unknown as BrowserContext;
  let stops = 0;
  const session = new BrowserSession(randomUUID(), new Date().toISOString(), { close: async () => {} } as Browser, context, async () => { stops++; });
  const a = await session.newTab('https://example.test'), b = await session.newTab();
  assert.equal(session.tabs().length, 2); assert.equal(session.activeTab, b);
  await session.activateTab(a); assert.equal(session.activeTab, a);
  assert.equal(await session.evaluate('6 * 7'), 42); await session.click('button'); await session.clickAt(10, 20);
  await session.drag({ x: 1, y: 2 }, { x: 3, y: 4 });
  assert.deepEqual(calls, ['https://example.test', '6 * 7', 'button', [10, 20], 'down', 'up']);
  await assert.rejects(session.clickAt(NaN, 0)); await assert.rejects(session.navigate('file:///etc/passwd'));
  await assert.rejects(session.elements(a, 10001));
  await session.close(); assert.equal(stops, 1); assert.throws(() => session.page(a));
});
test('SDK forwards only explicit loopback ports and configures a separate context', async () => {
  const id = randomUUID(); let connectOptions: unknown, contextOptions: unknown, deletes = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method === 'DELETE') { deletes++; res.end('{}'); return; }
    const address = server.address() as AddressInfo;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, engine: 'chromium', expiresAt: new Date(Date.now() + 60000).toISOString(), key: 'scoped-key', endpoint: `ws://127.0.0.1:${address.port}/v1/browsers/${id}/connect` }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const engine = { connect: async (_endpoint: string, opts: unknown) => {
    connectOptions = opts;
    return { newContext: async (opts: unknown) => { contextOptions = opts; return { on() {}, pages: () => [], setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, close: async () => { throw new Error('transport lost'); } }; }, close: async () => {} } as unknown as Browser;
  } } as unknown as Pick<typeof chromium, 'connect'>;
  try {
    const client = new BrowserClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, { chromium: engine, firefox: engine, webkit: engine });
    const session = await client.boot({ id, localPorts: [3000, 3000, 8080], context: { viewport: { width: 800, height: 600 } } });
    assert.deepEqual(connectOptions, { headers: { Authorization: 'Bearer scoped-key' }, timeout: 30000, exposeNetwork: '127.0.0.1:3000,127.0.0.1:8080' });
    assert.deepEqual(contextOptions, { viewport: { width: 800, height: 600 } });
    await assert.rejects(session.close(), /cleanup needs verification/); assert.equal(deletes, 1);
    await session.close(); assert.equal(deletes, 2);
    await client.boot({ id }); assert.equal(Object.hasOwn(connectOptions as object, 'exposeNetwork'), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('expiry rejects inspection and replay; cleanup failure holds capacity', async t => {
  const f = await fixture(async () => ({ close: async () => { throw new Error('cleanup uncertain'); }, wsEndpoint: () => 'ws://127.0.0.1:1/private' }) as unknown as BrowserServer);
  try {
    const body = { id: randomUUID(), engine: 'chromium', ttlSeconds: 30 };
    assert.equal((await f.call('/v1/browsers', 'POST', body)).status, 201);
    const future = Date.now() + 31000; t.mock.method(Date, 'now', () => future);
    assert.equal((await f.call(`/v1/browsers/${body.id}`)).status, 410);
    assert.equal((await f.call('/v1/browsers', 'POST', body)).status, 410);
    assert.equal((await f.call(`/v1/browsers/${body.id}`, 'DELETE')).status, 503);
    assert.equal((await f.call('/v1/browsers', 'POST', { ...body, id: randomUUID() })).status, 429);
  } finally { await assert.rejects(f.runtime.close(), /unconfirmed/); }
});
