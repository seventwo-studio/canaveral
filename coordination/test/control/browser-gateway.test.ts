import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { ServiceError } from "../../src/errors.ts";
import { createBrowserGateway, parseBrowserGateway } from "../../src/control/browser-gateway.ts";

test("host browser gateway routes TLS requests and attachments with separate credentials", async t => {
  const root = mkdtempSync(join(tmpdir(), "canaveral-browser-gateway-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cert = join(root, "test.crt"), key = join(root, "test.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key,
    "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:mac-worker.test"], { stdio: "ignore" });
  const tls = { cert: readFileSync(cert), key: readFileSync(key) };
  const trust = getCACertificates("default");
  setDefaultCACertificates([...trust, tls.cert.toString()]);
  t.after(() => setDefaultCACertificates(trust));
  const token = () => randomBytes(32).toString("base64url");
  const app = token(), session = token(), operator = token();
  const host = randomUUID(), id = randomUUID(), credentialFile = join(root, "worker.key");
  writeFileSync(credentialFile, app, { mode: 0o600 });
  const traffic: { method?: string; authorization?: string; path?: string }[] = [];
  async function listen(server: ReturnType<typeof createServer>) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  let firstIntent: string | undefined;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const worker = createServer(tls, async (req, res) => {
    traffic.push({ method: req.method!, authorization: req.headers.authorization!, path: req.url! });
    if (req.method === "DELETE") { res.end(JSON.stringify({ id, state: "closed" })); return; }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const intent = Buffer.concat(chunks).toString();
      if (firstIntent && firstIntent !== intent) { res.writeHead(409); res.end(); return; }
      res.writeHead(firstIntent ? 200 : 201);
      firstIntent = intent;
    }
    res.end(JSON.stringify({ id, engine: "chromium", expiresAt,
      endpoint: workerOrigin.replace("https:", "wss:") + `/v1/browsers/${id}/connect`, key: session }));
  });
  worker.on("upgrade", (req, socket) => {
    traffic.push({ method: req.method!, authorization: req.headers.authorization!, path: req.url! });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const workerOrigin = (await listen(worker)).replace("127.0.0.1", "mac-worker.test");
  const gatewayServer = createServer(tls);
  const origin = await listen(gatewayServer);
  let ready = false;
  const gateway = createBrowserGateway(parseBrowserGateway({
    origin, workers: { [host]: { origin: workerOrigin, connectHost: "127.0.0.1", credentialFile } },
  }), [operator], async () => ready, async credential => {
    if (credential !== operator) throw new ServiceError("Admin required.", 403);
  });
  gatewayServer.on("request", gateway.handle);
  gatewayServer.on("upgrade", gateway.upgrade);
  t.after(gateway.close);
  const prefix = `/v1/hosts/${host}/browsers`;
  const intent = { id, engine: "chromium", ttlSeconds: 60 };
  const post = (path: string, credential: string, body: unknown) => fetch(origin + path, {
    method: "POST", headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  assert.equal((await post(prefix, operator, intent)).status, 403);
  assert.equal((await post(prefix, app, intent)).status, 409);
  assert.equal(traffic.length, 0);
  const admin = prefix.replace("/v1/", "/v1/admin/");
  const item = origin + admin + "/" + id;
  const headers = { authorization: `Bearer ${operator}` };
  assert.equal((await post(admin, app, intent)).status, 403);
  assert.equal((await post(admin, operator, intent)).status, 409);
  assert.equal(traffic.length, 0);
  ready = true;
  const launched = await post(prefix, app, intent);
  assert.equal(launched.status, 201);
  const receipt = await launched.json();
  assert.deepEqual(receipt.endpoint, origin.replace("https:", "wss:") + `${prefix}/${id}/connect`);
  const upgrade = (credential: string) => new Promise<number>((resolve, reject) => {
    const req = request(origin + `${prefix}/${id}/connect`, {
      headers: { authorization: `Bearer ${credential}`, upgrade: "websocket", connection: "Upgrade",
        "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") },
    });
    req.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
    req.on("response", response => { response.resume(); resolve(response.statusCode!); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await upgrade(app), 403);
  assert.equal(await upgrade(operator), 403);
  assert.equal(await upgrade(receipt.key), 101);
  const replay = await post(admin, operator, intent);
  assert.equal(replay.status, 200);
  const replayed = await replay.json();
  assert.deepEqual(replayed, receipt);
  assert.equal((await post(admin, operator, { ...intent, engine: "webkit" })).status, 409);
  assert.ok(!JSON.stringify(replayed).includes(app));
  ready = false;
  assert.equal((await (await fetch(item, { headers })).json()).key, session);
  assert.deepEqual(await (await fetch(item, { method: "DELETE", headers })).json(), { id, state: "closed" });
  assert.equal(await upgrade(session), 403);
  assert.equal((await post(`${prefix}/${id}/stop`, app, {})).status, 200);
  assert.equal(await upgrade(session), 403);
  assert.deepEqual(traffic, [
    { method: "POST", authorization: `Bearer ${app}`, path: "/v1/browsers" },
    { method: "GET", authorization: `Bearer ${session}`, path: `/v1/browsers/${id}/connect` },
    { method: "POST", authorization: `Bearer ${app}`, path: "/v1/browsers" },
    { method: "POST", authorization: `Bearer ${app}`, path: "/v1/browsers" },
    { method: "GET", authorization: `Bearer ${app}`, path: `/v1/browsers/${id}` },
    { method: "DELETE", authorization: `Bearer ${app}`, path: `/v1/browsers/${id}` },
    { method: "DELETE", authorization: `Bearer ${app}`, path: `/v1/browsers/${id}` },
  ]);
});
