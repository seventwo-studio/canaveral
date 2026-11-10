import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GuestHTTPS } from "../../src/guest/https.ts";
import { ServiceError } from "../../src/errors.ts";

test("guest HTTPS uses verified TLS, independent requests, bounded deadlines, and no redirect/replay/proxy", async t => {
  const directory = mkdtempSync(join(tmpdir(), "guest-tls-")), cert = join(directory, "certificate.pem"), key = join(directory, "key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { encoding: "utf8" });
  assert.equal(generated.status, 0, "portable TLS fixture certificate generation");
  const seen: { method: string; route: string; body: string; authorization: string | undefined }[] = [];
  let reply = (_req: IncomingMessage, response: ServerResponse) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}'); };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, response) => {
    let data = ""; for await (const bytes of req) data += (bytes as Buffer).toString("utf8");
    seen.push({ method: req.method!, route: req.url!, body: data, authorization: req.headers.authorization }); reply(req, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`, credential = "a".repeat(43), client = new GuestHTTPS(origin, credential, cert);
  try {
    await t.test("GET and POST ignore ambient proxy variables and preserve UTF-8", async () => {
      const previous = process.env.HTTPS_PROXY; process.env.HTTPS_PROXY = "http://127.0.0.1:1";
      try { assert.deepEqual(await client.call("/v1/accessibility", null), { ok: true }); assert.deepEqual(await client.call("/v1/shell/write", { text: "héllo\n" }), { ok: true }); }
      finally { if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous; }
      assert.deepEqual(seen.map(v => [v.method, v.route]), [["GET", "/v1/accessibility"], ["POST", "/v1/shell/write"]]);
      assert.equal(seen[0]!.authorization, `Bearer ${credential}`); assert.deepEqual(JSON.parse(seen[1]!.body), { text: "héllo\n" });
    });
    await t.test("untrusted certificates, hostname mismatch and invalid origins cannot dispatch", async () => {
      const count = seen.length;
      await assert.rejects(new GuestHTTPS(origin, credential).call("/v1/accessibility", null), (e: unknown) => e instanceof ServiceError && e.code === "transport_interrupted");
      await assert.rejects(new GuestHTTPS(origin.replace("localhost", "127.0.0.1"), credential, cert).call("/v1/accessibility", null));
      for (const value of ["http://localhost", `${origin}/a`, `${origin}?`, `${origin}#`, `https://name:password@localhost`, `${origin}/./`, "https://localhost:0", "https://localhost:65536"]) assert.throws(() => new GuestHTTPS(value, credential));
      assert.equal(seen.length, count);
    });
    await t.test("redirects and malformed responses carry unknown mutation outcomes without replay", async () => {
      for (const fixture of [
        { status: 307, headers: { Location: origin + "/v1/elsewhere", "Content-Type": "application/json" }, body: "{}", code: "redirect_refused" },
        { status: 200, headers: { "Content-Type": "application/json" }, body: "[]", code: "response_invalid" },
        { status: 200, headers: { "Content-Type": "application/json" }, body: '{"x":1e999}', code: "response_invalid" },
        { status: 200, headers: { "Content-Type": "text/html" }, body: "{}", code: "response_invalid" },
        { status: 200, headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: "{}", code: "response_invalid" },
      ]) {
        reply = (_req, r) => { r.writeHead(fixture.status, fixture.headers); r.end(fixture.body); };
        const count = seen.length;
        await assert.rejects(client.call("/v1/display/input", {}), (e: unknown) => e instanceof ServiceError && e.outcome === "unknown" && e.retryable === false && e.code === fixture.code);
        assert.equal(seen.length, count + 1);
      }
    });
    await t.test("typed pre-effect refusals survive while private errors remain sanitized", async () => {
      for (const code of ["input_busy", "input_stale", "input_reset_uncertain", "capability_unsupported", "private-secret"]) {
        reply = (_req, r) => { r.writeHead(409, { "Content-Type": "application/json" }); r.end(JSON.stringify({ code, error: "private-secret" })); };
        await assert.rejects(client.call("/v1/display/take", {}), (e: unknown) => {
          assert.ok(e instanceof ServiceError); assert.equal(e.retryable, false); assert.equal(e.outcome, code === "private-secret" ? "unknown" : undefined); assert.equal(e.code, code === "private-secret" ? "conflict" : code); assert.equal(e.message.includes("private-secret"), false); return true;
        });
      }
    });
    await t.test("one slow terminal cannot serialize other reads and deadline includes trickled response", async () => {
      let finishSlow!: () => void;
      reply = (req, r) => {
        if (req.url === "/v1/shell/read") { finishSlow = () => { r.writeHead(200, { "Content-Type": "application/json" }); r.end("{}"); }; }
        else { r.writeHead(200, { "Content-Type": "application/json" }); r.end("{}"); }
      };
      const slow = client.call("/v1/shell/read", {});
      while (!finishSlow) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(await client.call("/v1/display/frame", null), {}); finishSlow(); assert.deepEqual(await slow, {});
      reply = (_req, r) => { r.writeHead(200, { "Content-Type": "application/json" }); r.write('{"x":"'); const timer = setInterval(() => r.write("x"), 5); r.once("close", () => clearInterval(timer)); };
      const count = seen.length, short = new GuestHTTPS(origin, credential, cert, 0.05);
      await assert.rejects(short.call("/v1/shell/write", {}), (e: unknown) => e instanceof ServiceError && e.code === "transport_interrupted" && e.outcome === "unknown");
      assert.equal(seen.length, count + 1);
    });
    await t.test("invalid requests and request envelope fail before dispatch", async () => {
      const count = seen.length;
      for (const [path, body] of [["//evil", null], ["/v1/a?x", null], ["/v1/a", []], ["/v1/a", { n: Infinity }], ["/v1/a", { data: "x".repeat(1_000_001) }]] as const) await assert.rejects(client.call(path, body as Record<string, unknown> | null));
      assert.equal(seen.length, count);
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
