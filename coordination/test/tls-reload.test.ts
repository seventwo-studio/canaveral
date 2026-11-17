import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { controllerTLS, controllerTLSReloader } from "../src/tls-reload.ts";

test("renewed TLS files take effect on new connections; incomplete pairs retain the working context", async t => {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-tls-renewal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certificate = (name: string) => {
    const cert = join(directory, name + ".crt"), key = join(directory, name + ".key");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", key, "-out", cert, "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    return { cert: readFileSync(cert), key: readFileSync(key) };
  };
  const first = certificate("first"), second = certificate("second");
  const files = { certFile: join(directory, "mounted.crt"), keyFile: join(directory, "mounted.key") };
  writeFileSync(files.certFile, first.cert); writeFileSync(files.keyFile, first.key, { mode: 0o600 });
  const initial = controllerTLS(files), server = createServer(initial, (_req, res) => res.end("ok"));
  server.on("tlsClientError", () => undefined);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const reports: string[] = [], reloader = controllerTLSReloader(server, files, initial, message => reports.push(message));
  t.after(async () => { reloader.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const peer = () => new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      servername: "localhost", ca: [first.cert, second.cert], agent: false }, res => {
      const fingerprint = (res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
      res.resume(); res.on("end", () => resolve(fingerprint));
    });
    req.on("error", reject); req.end();
  });
  const fingerprint = (cert: Buffer) => new X509Certificate(cert).fingerprint256;
  assert.equal(await peer(), fingerprint(first.cert));
  writeFileSync(files.certFile, second.cert);
  reloader.refresh(); reloader.refresh();
  assert.equal(reports.length, 1);
  assert.ok(!reports[0]!.includes(directory));
  assert.equal(await peer(), fingerprint(first.cert));
  writeFileSync(files.keyFile, second.key);
  reloader.refresh();
  assert.equal(await peer(), fingerprint(second.cert));
  reloader.close();
  writeFileSync(files.certFile, first.cert); writeFileSync(files.keyFile, first.key);
  reloader.refresh();
  assert.equal(await peer(), fingerprint(second.cert));
});
