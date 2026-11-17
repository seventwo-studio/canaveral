/** Dedicated real-browser processes. This service is separate from consumer leases. */
import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrowserServer } from 'playwright-core';

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
export interface BrowserIntent { id: string; engine: BrowserEngine; ttlSeconds: number }
export interface BrowserReceipt { id: string; engine: BrowserEngine; expiresAt: string; endpoint: string; key: string }
export interface BrowserRuntimeOptions {
  /** Application credential for creating, inspecting and stopping browsers. */
  token: string;
  /** Externally reachable HTTP(S) origin. Remote deployments require TLS termination. */
  publicOrigin: string;
  maxBrowsers?: number;
  /** Test/host adapter. Must return a dedicated process listening on loopback only. */
  launch: (engine: BrowserEngine) => Promise<BrowserServer>;
}
interface Entry { intent: BrowserIntent; key: string; expiresAt: number; server?: BrowserServer; pending?: Promise<void>; failed?: boolean; stopping?: boolean; cleanup?: Promise<void>; sockets?: Set<Duplex> }
function authorized(actual: string | undefined, key: string): boolean {
  const value = Buffer.from(actual ?? ''), expected = Buffer.from(`Bearer ${key}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function createBrowserRuntime(options: BrowserRuntimeOptions): { server: Server; close(): Promise<void> } {
  const origin = new URL(options.publicOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Choose an HTTP(S) origin without credentials or a path.');
  if (options.token.length < 32) throw new Error('Browser runtime token must contain at least 32 characters.');
  const max = options.maxBrowsers ?? 4;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64) throw new Error('Invalid browser capacity.');
  const entries = new Map<string, Entry>();
  let closing = false;
  const launch = options.launch;
  const endpoint = (id: string) => `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}/v1/browsers/${id}/connect`;
  const receipt = (entry: Entry): BrowserReceipt => ({ id: entry.intent.id, engine: entry.intent.engine, expiresAt: new Date(entry.expiresAt).toISOString(), endpoint: endpoint(entry.intent.id), key: entry.key });
  const stop = (entry: Entry): Promise<void> => {
    entry.stopping = true;
    for (const socket of entry.sockets ?? []) socket.destroy();
    entry.cleanup ??= (async () => {
      await entry.pending;
      if (entry.server) await entry.server.close();
      delete entry.server;
    })().finally(() => { delete entry.cleanup; });
    return entry.cleanup;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (closing) { send(503, { error: 'runtime_closing' }); return; }
    if (req.headers.origin || !authorized(req.headers.authorization, options.token)) { send(403, { error: 'forbidden' }); return; }
    try {
      const path = req.url ?? '';
      if (req.method === 'POST' && path === '/v1/browsers') {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4096) { send(413, { error: 'body_too_large' }); return; } chunks.push(chunk); }
        let body: BrowserIntent;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { send(400, { error: 'invalid_json' }); return; }
        if (!body || Object.keys(body).sort().join(',') !== 'engine,id,ttlSeconds' || !uuid(body.id) || !['chromium', 'firefox', 'webkit'].includes(body.engine) || !Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 30 || body.ttlSeconds > 3600) { send(400, { error: 'invalid_browser_intent' }); return; }
        const previous = entries.get(body.id);
        if (previous) {
          if (previous.intent.engine !== body.engine || previous.intent.ttlSeconds !== body.ttlSeconds) { send(409, { error: 'intent_conflict' }); return; }
          await previous.pending;
          if (previous.stopping || previous.failed || !previous.server || Date.now() >= previous.expiresAt) { send(410, { error: 'browser_unavailable' }); return; }
          send(200, receipt(previous)); return;
        }
        if ([...entries.values()].filter(e => e.server || e.pending || e.failed).length >= max || entries.size >= 10000) { send(429, { error: 'browser_capacity' }); return; }
        const entry: Entry = { intent: body, key: randomBytes(32).toString('base64url'), expiresAt: Date.now() + body.ttlSeconds * 1000 };
        entries.set(body.id, entry);
        entry.pending = (async () => { try { entry.server = await launch(body.engine); } catch { entry.failed = true; } })();
        await entry.pending; delete entry.pending;
        if (entry.failed) { send(503, { error: 'browser_launch_failed' }); return; }
        if (closing || entry.stopping || Date.now() >= entry.expiresAt) { await stop(entry); send(410, { error: 'browser_unavailable' }); return; }
        send(201, receipt(entry)); return;
      }
      const match = /^\/v1\/browsers\/([0-9a-f-]+)$/.exec(path), entry = match ? entries.get(match[1]!) : undefined;
      if (!entry) { send(404, { error: 'not_found' }); return; }
      if (req.method === 'DELETE') { await stop(entry); send(200, { id: entry.intent.id, state: 'closed' }); return; }
      if (req.method === 'GET' && !entry.stopping && entry.server && Date.now() < entry.expiresAt) { send(200, receipt(entry)); return; }
      send(410, { error: 'browser_unavailable' });
    } catch { send(503, { error: 'browser_runtime_unavailable' }); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  server.on('upgrade', (req, socket, head) => {
    const match = /^\/v1\/browsers\/([0-9a-f-]+)\/connect$/.exec(req.url ?? ''), entry = match ? entries.get(match[1]!) : undefined;
    if (closing || req.headers.origin || !entry?.server || entry.stopping || Date.now() >= entry.expiresAt || !authorized(req.headers.authorization, entry.key)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    (entry.sockets ??= new Set()).add(socket);
    socket.on('close', () => entry.sockets?.delete(socket));
    const target = new URL(entry.server.wsEndpoint());
    target.protocol = 'http:';
    const headers = { ...req.headers, host: target.host }; delete headers.authorization;
    const upstream = httpRequest(target, { headers });
    const fail = () => { socket.destroy(); upstream.destroy(); };
    socket.on('error', fail); socket.on('close', () => upstream.destroy());
    upstream.on('error', fail); upstream.on('response', fail);
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      upstream.setTimeout(0);
      if (closing || entry.stopping || !entry.server || Date.now() >= entry.expiresAt) { peer.destroy(); fail(); return; }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      peer.on('error', fail); socket.on('close', () => peer.destroy());
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    upstream.setTimeout(10_000, fail); upstream.end();
  });
  const timer = setInterval(() => { for (const entry of entries.values()) if (Date.now() >= entry.expiresAt && entry.server) void stop(entry).catch(() => {}); }, 1000); timer.unref();
  return { server, async close() { closing = true; clearInterval(timer); const stopped = await Promise.allSettled([...entries.values()].map(stop)); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); if (stopped.some(r => r.status === 'rejected')) throw new Error('Browser cleanup is unconfirmed.'); } };
}
