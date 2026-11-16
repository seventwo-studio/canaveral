import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { guestAssignment, guestBindingAuthorization, guestBindingMAC, guestBindingBytes, verifiedGuestHelperBinding, type GuestAssignmentContext } from "../../src/guest/binding.ts";
import { GuestHelperAccess } from "../../src/control/sessions.ts";
import { ServiceError } from "../../src/errors.ts";

const vector = JSON.parse(readFileSync(join(process.cwd(), "../fixtures/guest-binding-v2.json"), "utf8"));
test("shared golden bytes and all three MAC purposes, strict versioned tuples", () => {
  for (const v of vector.vectors) {
    const incarnation = v.kind === "identity-request" ? undefined : vector.incarnation;
    const nonce = v.kind === "request" ? undefined : vector.nonce;
    assert.equal(guestBindingBytes(vector.assignment, v.kind, nonce, incarnation).toString(), v.canonical);
    assert.equal(guestBindingBytes(vector.assignment, v.kind, nonce, incarnation).toString("hex"), v.hex);
    assert.equal(guestBindingMAC(vector.credential, vector.assignment, v.kind, nonce, incarnation), v.mac);
    if (v.authorization) assert.equal(guestBindingAuthorization(vector.credential, vector.assignment, incarnation, nonce), v.authorization);
  }
  for (const bad of [null, [], {}, { ...vector.assignment, version: true }, { ...vector.assignment, version: 2 }, { ...vector.assignment, extra: 1 },
    ...["machineId", "leaseId", "launchId", "fingerprint"].flatMap(k => [{ ...vector.assignment, [k]: "ABC" }, { ...vector.assignment, [k]: vector.assignment[k] + "\n" }])]) assert.throws(() => guestAssignment(bad));
});
test("actual Swift producer DTO is consumed by the real strict parser", () => {
  const produced = process.env.CANAVERAL_IDENTITY_DTO ? JSON.parse(readFileSync(process.env.CANAVERAL_IDENTITY_DTO, "utf8")) : vector.response;
  assert.deepEqual(produced, vector.response);
  assert.deepEqual(guestAssignment(produced, true), vector.response);
  assert.equal(guestBindingMAC(vector.credential, vector.assignment, "identity-response", vector.nonce, vector.incarnation), produced.proof);
});
test("verified binding through macOS adapter over real verified HTTPS", async t => {
  const dir = mkdtempSync(join(tmpdir(), "binding-tls-")), cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
  assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { encoding: "utf8" }).status, 0);
  const credential = vector.credential as string, assignment = vector.assignment as GuestAssignmentContext;
  let expected = { ...assignment }, authority = true, incarnation = vector.incarnation, effects = 0, reads = 0;
  let identity: unknown = undefined, raw: string | undefined, onEffect = () => {}, onIdentity = () => {}, verifyRequest = true, force401 = false;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    for await (const _ of req) { /* consume exact adapter request */ }
    const isIdentity = req.url === "/v1/identity";
    const nonce = req.headers.authorization?.split(" ")[1]?.split(".")[0];
    const auth = verifyRequest ? guestBindingAuthorization(credential, assignment, isIdentity ? undefined : incarnation, isIdentity ? nonce : undefined) : undefined;
    if (force401 || (verifyRequest && req.headers.authorization !== auth)) { res.writeHead(401); res.end("private-transport-secret"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (isIdentity) { reads++; onIdentity(); res.end(raw ?? JSON.stringify(identity === undefined ? { ...assignment, incarnation, nonce, proof: guestBindingMAC(credential, assignment, "identity-response", nonce, incarnation) } : typeof identity === "function" ? identity(nonce) : identity)); }
    else { effects++; onEffect(); res.end(JSON.stringify({ path: "/", entries: [], truncated: false })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const endpoint = `https://localhost:${address.port}`;
  const resolve = () => verifiedGuestHelperBinding(() => expected, endpoint, credential, () => authority, { caFile: cert });
  const reset = () => { expected = { ...assignment }; authority = true; incarnation = vector.incarnation; identity = undefined; raw = undefined; onEffect = () => {}; onIdentity = () => {}; verifyRequest = true; force401 = false; };
  try {
    await t.test("actual adapter list, macOS-only guard, verified certificate", async () => {
      const binding = await resolve(), access = new GuestHelperAccess(() => binding);
      await access.control({}, { os: "macos" }, "/fixture", { action: "list-files", arguments: { path: "/" } });
      const count = effects;
      await assert.rejects(access.control({}, { os: "linux" }, "/fixture", { action: "list-files", arguments: { path: "/" } }), /macOS only/);
      assert.equal(effects, count);
      await assert.rejects(verifiedGuestHelperBinding(() => expected, endpoint, credential, () => true), /identity was not verified/);
    });
    await t.test("strict identity envelope and each assignment mismatch", async () => {
      for (const value of [null, [], {}, { ...assignment, incarnation, extra: "private-secret" }, { ...assignment, incarnation: "BAD" }, { ...assignment, version: 2, incarnation },
        ...["machineId", "leaseId", "launchId", "fingerprint"].map(k => ({ ...assignment, incarnation, [k]: k === "fingerprint" ? "f".repeat(64) : "ffffffff-ffff-ffff-ffff-ffffffffffff" }))]) {
        identity = value; const count = effects;
        await assert.rejects(resolve(), (e: unknown) => e instanceof ServiceError && e.message === "Native guest identity was not verified." && !JSON.stringify(e).includes("private-secret"));
        assert.equal(effects, count);
      }
      for (const value of ["{", JSON.stringify({ ...assignment, incarnation, extra: "x".repeat(4096) })]) { raw = value; await assert.rejects(resolve(), /identity was not verified/); }
      reset();
    });
    await t.test("fresh challenges refuse unsigned peers, tampering, reflection and replay before adapter effects", async () => {
      const nonces = new Set<string>(); let saved: unknown;
      const response = (nonce: string) => ({ ...assignment, incarnation, nonce, proof: guestBindingMAC(credential, assignment, "identity-response", nonce, incarnation) });
      for (const attack of ["missing", "wrong-key", "nonce", "incarnation", "request-reflected", "tuple", "reflected", "v1", "mixed", "padding", "alias", "oversized"]) {
        reset(); verifyRequest = attack !== "missing" && attack !== "wrong-key"; identity = (nonce: string) => {
          assert.equal(nonce.length, 43); assert.ok(!nonces.has(nonce)); nonces.add(nonce);
          if (attack === "missing") return { ...assignment, incarnation, nonce };
          const dto = response(nonce);
          switch (attack) {
            case "wrong-key": return { ...dto, proof: guestBindingMAC("other-credential-01234567890123456789", assignment, "identity-response", nonce, incarnation) };
            case "nonce": return { ...dto, nonce: vector.nonce };
            case "incarnation": return { ...dto, incarnation: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
            case "tuple": return { ...dto, leaseId: "ffffffff-ffff-ffff-ffff-ffffffffffff", proof: guestBindingMAC(credential, { ...assignment, leaseId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }, "identity-response", nonce, incarnation) };
            case "request-reflected": return { ...dto, proof: guestBindingMAC(credential, assignment, "request", undefined, incarnation) };
            case "reflected": return { ...dto, proof: guestBindingMAC(credential, assignment, "identity-request", nonce) };
            case "v1": return { ...assignment, incarnation };
            case "mixed": return { ...dto, version: 2 };
            case "padding": return { ...dto, proof: dto.proof + "=" };
            case "alias": return { ...dto, proof: "A".repeat(42) + "B" };
            case "oversized": return { ...dto, nonce: "a".repeat(5000) };
          }
        };
        const count = effects;
        const access = new GuestHelperAccess(resolve);
        await assert.rejects(access.control({}, { os: "macos" }, "/fixture", { action: "list-files", arguments: { path: "/" } }));
        assert.equal(effects, count);
      }
      reset(); identity = (nonce: string) => { saved = response(nonce); return saved; };
      await resolve(); identity = saved;
      const count = effects; await assert.rejects(resolve(), /identity was not verified/); assert.equal(effects, count);
      reset();
    });
    await t.test("changed trusted state or revoked authority permanently invalidates before dispatch", async () => {
      for (const kind of ["authority", "machineId", "leaseId", "launchId", "fingerprint", "throw"]) {
        reset(); let throws = false;
        const binding = await verifiedGuestHelperBinding(() => { if (throws) throw Error("private-secret"); return expected; }, endpoint, credential, () => authority, { caFile: cert });
        if (kind === "authority") authority = false;
        else if (kind === "throw") throws = true;
        else expected = { ...assignment, [kind]: kind === "fingerprint" ? "f".repeat(64) : "ffffffff-ffff-ffff-ffff-ffffffffffff" };
        const count = effects;
        await assert.rejects(binding.call("/v1/files/list", { path: "/" }), /authorization ended/);
        reset(); throws = false;
        await assert.rejects(binding.call("/v1/files/list", { path: "/" }), /authorization ended/);
        assert.equal(effects, count);
      }
    });
    await t.test("revocation during identity or mutation acknowledgement fails closed", async () => {
      for (const change of ["authority", "expected"]) {
        reset(); onIdentity = () => { if (change === "authority") authority = false; else expected = { ...assignment, launchId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }; };
        await assert.rejects(resolve(), /identity was not verified/);
      }
      reset(); let checks = 0;
      await assert.rejects(verifiedGuestHelperBinding(() => expected, endpoint, credential, () => ++checks === 1, { caFile: cert }), /identity was not verified/);
      for (const changedExpected of [false, true]) {
        reset(); const binding = await resolve();
        onEffect = () => { if (changedExpected) expected = { ...assignment, launchId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }; else authority = false; };
        await assert.rejects(binding.call("/v1/files/list", { path: "/" }), (e: unknown) => e instanceof ServiceError && e.outcome === "unknown" && e.retryable === false);
        reset(); assert.equal(binding.authorized(), false);
      }
    });
    await t.test("helper restart and even malformed 401 kill permanently without replay or fallback", async () => {
      for (const restart of [true, false]) {
        reset(); const binding = await resolve(), count = effects, identities = reads;
        if (restart) incarnation = "ffffffff-ffff-ffff-ffff-ffffffffffff"; else force401 = true;
        await assert.rejects(binding.call("/v1/files/list", { path: "/" }), (e: unknown) => e instanceof ServiceError && e.status === 401 && e.outcome === "unknown" && !e.message.includes("private"));
        reset(); await assert.rejects(binding.call("/v1/files/list", { path: "/" }), /authorization ended/);
        assert.equal(effects, count); assert.equal(reads, identities);
      }
      reset(); const fresh = await resolve(); await fresh.call("/v1/files/list", { path: "/" });
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
