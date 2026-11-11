import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { LeaseClient, ConsumerError } from '../src/sdk.ts';

const leaseId = randomUUID(), operationId = randomUUID();
function view(state = 'provisioning', ready = false, cleanup = 'notRequested') {
  return { id: leaseId, state, runtimeState: 'running', revision: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), cleanup: { state: cleanup },
    members: [{ name: 'primary', ready, capabilities: { command: true } }], capabilities: { command: true } };
}
async function fixture(t: test.TestContext, handler: (res: http.ServerResponse, count: number) => void) {
  const requests: string[] = [], bodies: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, `Bearer ${'a'.repeat(43)}`);
    res.setHeader('Content-Type', 'application/json');
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => { bodies.push(body); handler(res, requests.length); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, bodies, client: new LeaseClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, allowLoopbackHttp: true, leaseId, leaseKey: 'a'.repeat(43), timeoutMs: 30000 }) };
}
test('explicit readiness wait observes member readiness and required capabilities using GET only', async t => {
  const { client, requests } = await fixture(t, (res, count) => {
    const value = view('ready', count >= 2);
    if (count === 2) value.members[0]!.capabilities.command = false;
    res.end(JSON.stringify(value));
  });
  const result = await client.waitUntilReady({ timeoutMs: 2000, intervalMs: 100, requiredCapabilities: ['command'] });
  assert.equal(result.state, 'ready'); assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r === `GET /v1/leases/${leaseId}`));
});
test('cleanup wait does not equate release with completed reclamation', async t => {
  const { client, requests } = await fixture(t, (res, count) => res.end(JSON.stringify(view('released', false, count === 1 ? 'pending' : 'complete'))));
  assert.equal((await client.waitForCleanup({ timeoutMs: 2000, intervalMs: 100 })).cleanup.state, 'complete');
  assert.equal(requests.length, 2);
});
test('terminal readiness and blocked cleanup stop without mutations', async t => {
  const { client, requests } = await fixture(t, res => res.end(JSON.stringify(view('expired', false, 'blocked'))));
  await assert.rejects(client.waitUntilReady({ timeoutMs: 1000 }), (e: unknown) => e instanceof ConsumerError && e.code === 'lease_terminal' && e.outcome === undefined);
  await assert.rejects(client.waitForCleanup({ timeoutMs: 1000 }), (e: unknown) => e instanceof ConsumerError && e.code === 'cleanup_blocked');
  assert.equal(requests.length, 2);
});
test('operation wait returns unknown as terminal uncertainty without replay', async t => {
  const { client, requests } = await fixture(t, (res, count) => res.end(JSON.stringify({ id: operationId, leaseId, member: 'primary', state: count === 1 ? 'queued' : 'unknown', updatedAt: new Date().toISOString() })));
  assert.equal((await client.waitForOperation(operationId, { timeoutMs: 2000, intervalMs: 100 })).state, 'unknown');
  assert.deepEqual(requests, Array(2).fill(`GET /v1/leases/${leaseId}/operations/${operationId}`));
});
test('total deadline aborts stalled HTTP read before the ordinary transport timeout', async t => {
  let closed = false;
  const { client, requests } = await fixture(t, res => { res.on('close', () => { closed = true; }); });
  const started = performance.now();
  await assert.rejects(client.waitUntilReady({ timeoutMs: 100 }), (e: unknown) => e instanceof ConsumerError && e.code === 'wait_timeout' && e.requestId === leaseId);
  assert.ok(performance.now() - started < 2000); assert.equal(requests.length, 1);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, true);
});
test('cancellation aborts a pending read and pre-cancelled or invalid waits never dispatch', async t => {
  const { client, requests } = await fixture(t, () => {});
  const abort = new AbortController();
  const pending = client.waitUntilReady({ timeoutMs: 5000, signal: abort.signal });
  setTimeout(() => abort.abort(new Error('private cancellation detail')), 50);
  await assert.rejects(pending, (e: unknown) => e instanceof ConsumerError && e.code === 'wait_aborted' && !e.message.includes('private'));
  await assert.rejects(client.waitUntilReady({ timeoutMs: 1000, signal: abort.signal }));
  await assert.rejects(client.waitForOperation(operationId, { timeoutMs: 0 }));
  await assert.rejects(client.waitForCleanup({ timeoutMs: 1000, intervalMs: 0 }));
  assert.equal(requests.length, 1);
});
test('read errors stop observation without retry even when service marks them retryable', async t => {
  const { client, requests } = await fixture(t, res => { res.statusCode = 503; res.end(JSON.stringify({ error: 'unavailable' })); });
  await assert.rejects(client.waitUntilReady({ timeoutMs: 2000, intervalMs: 100 }), (e: unknown) => e instanceof ConsumerError && e.code === 'unavailable');
  assert.equal(requests.length, 1);
});
test('shell timeout validation preserves explicit bounded build budget on the wire', async t => {
  const { operationRequest } = await import('../src/sdk.ts');
  const request = { id: operationId, member: 'primary', action: 'shell', arguments: { argv: ['make'], timeoutMs: 300000 } };
  assert.deepEqual(operationRequest(request), request);
  for (const timeoutMs of [0, -1, 3600001, 1.5, NaN]) assert.throws(() => operationRequest({ ...request, arguments: { ...request.arguments, timeoutMs } }));
  const { client, requests, bodies } = await fixture(t, res => res.end(JSON.stringify({ id: operationId, leaseId, member: 'primary', state: 'queued', updatedAt: new Date().toISOString() })));
  assert.equal((await client.createOperation(request)).operation.state, 'queued');
  assert.deepEqual(JSON.parse(bodies[0]!), request);
  assert.equal(requests.length, 1);
});
test('cancellation during poll delay stops without another read', async t => {
  const { client, requests } = await fixture(t, res => res.end(JSON.stringify(view())));
  const abort = new AbortController();
  const pending = client.waitUntilReady({ timeoutMs: 5000, intervalMs: 1000, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, (e: unknown) => e instanceof ConsumerError && e.code === 'wait_aborted');
  assert.equal(requests.length, 1);
});
