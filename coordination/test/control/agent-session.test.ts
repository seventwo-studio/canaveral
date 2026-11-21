import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { LeaseSession } from "../../src/agent-session.ts";
import type { SessionNotice } from "../../src/agent-session.ts";
import { sleep, until } from "./agent-fixture.ts";

/** The held-lease session against a scripted loopback server that can lose a reply after applying
 * its effect. It checks only what the session sends and concludes; the controller's own behavior
 * is covered by agent-mcp.test.ts and agent-cli.test.ts against the real controller. */
interface Call { method: string; path: string; body: any }
async function fake(t: TestContext) {
  const calls: Call[] = [], lose = new Set<string>(), refuse = new Set<string>(), receipts = new Map<string, any>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const image = { id: "phone", revision: "1", os: "android", arch: "arm64", mode: "device", available: true, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, defaults: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, memoryStepMiB: 1,
    capabilities: { command: true, pty: true, files: true, screenshot: true, displayStream: true, input: true, hierarchy: true } };
  let request: any, lease: any, ttl = 0, queue = 0;
  const admit = () => {
    const now = Date.now();
    lease = { id: request.id, state: "ready", runtimeState: "running", revision: 1, createdAt: iso(now), expiresAt: iso(now + ttl * 1000), cleanup: { state: "notRequested" }, members: [{ name: "primary", state: "running", ready: true }], capabilities: image.capabilities };
    request = { ...request, state: "admitted", admittedAt: iso(now), target: request.id, reason: null }; delete request.position;
  };
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(chunk as Buffer));
    incoming.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined, path = incoming.url ?? "", route = `${incoming.method} ${path.replace(/[0-9a-f-]{36}/g, "ID")}`;
      calls.push({ method: incoming.method ?? "", path, body });
      let status = 200, reply: any;
      if (refuse.has(route)) { status = 503; reply = { error: "unavailable" }; }
      else if (route === "GET /v1/environments/templates") reply = { templates: [image], limits: { defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 60 } };
      else if (route === "POST /v1/requests") {
        if (!request) {
          ttl = body.intent.ttlSeconds; status = 201;
          request = { id: body.id, kind: "lease", intent: body.intent, resources: {}, priority: 0, deadline: body.deadline, source: body.source ?? null, state: "waiting", sequence: 1, createdAt: iso(Date.now()), admittedAt: null, target: null, reason: "capacity_unavailable", position: queue };
          if (!queue) admit();
        }
        reply = request;
      } else if (route === "GET /v1/requests/ID") {
        // Each look moves a queued request one place forward, as a draining queue would.
        if (request?.state === "waiting") { if (--queue > 0) request = { ...request, position: queue }; else admit(); }
        if (request) reply = request; else { status = 404; reply = { error: "Unknown request.", message: "Unknown request.", code: "not_found", requestId: randomUUID(), retryable: false }; } }
      else if (route === "GET /v1/leases/ID") reply = lease;
      else if (route === "POST /v1/leases/ID/credential") reply = { id: lease.id, credential: randomBytes(32).toString("base64url") };
      else if (route === "POST /v1/leases/ID/renew") {
        if (receipts.has(body.id)) reply = { mutation: receipts.get(body.id), lease };
        else if (body.expectedRevision !== lease.revision) { status = 409; reply = { error: "Lease revision changed.", message: "Lease revision changed.", code: "conflict", requestId: randomUUID(), retryable: false }; }
        else {
          lease = { ...lease, revision: lease.revision + 1, expiresAt: iso(Date.now() + body.ttlSeconds * 1000) };
          receipts.set(body.id, { id: body.id, state: lease.state, revision: lease.revision, expiresAt: lease.expiresAt });
          reply = { mutation: receipts.get(body.id), lease };
        }
      } else if (route === "POST /v1/requests/ID/cancel") { lease = { ...lease, state: "released", revision: lease.revision + 1, cleanup: { state: "pending" } }; reply = request; }
      else { status = 404; reply = { error: "Unknown endpoint.", message: "Unknown endpoint.", code: "not_found", requestId: randomUUID(), retryable: false }; }
      // The effect above is applied; the reply is lost on the way back.
      if (lose.delete(route)) { incoming.socket.destroy(); return; }
      response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const notices: SessionNotice[] = [];
  const session = new LeaseSession({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, allowLoopbackHttp: true, applicationKey: randomBytes(32).toString("base64url"), notice: notice => notices.push(notice) });
  const sent = (route: string) => calls.filter(call => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/g, "ID")}` === route);
  return { session, calls, sent, lose, refuse, receipts, notices, lease: () => lease, queued(places: number) { queue = places; }, bump() { lease = { ...lease, revision: lease.revision + 1, expiresAt: iso(Date.parse(lease.expiresAt) + 1000) }; } };
}

test("a lost submission and a lost renewal are replayed byte for byte; a moved revision is read and renewed", { timeout: 60000 }, async t => {
  const f = await fake(t);
  f.lose.add("POST /v1/requests"); f.lose.add("POST /v1/leases/ID/renew");
  const held = await f.session.lease({ templateId: "phone", ttlSeconds: 3, source: { run: "7" } });
  assert.equal(held.state, "ready");
  // The submission was applied but its reply was lost: the identical envelope is sent again, never a new UUID.
  const submissions = f.sent("POST /v1/requests");
  assert.equal(submissions.length, 2); assert.deepEqual(submissions[1]!.body, submissions[0]!.body); assert.equal(submissions[0]!.body.id, held.leaseId);
  assert.deepEqual([submissions[0]!.body.kind, submissions[0]!.body.intent.ttlSeconds, submissions[0]!.body.source.run, typeof submissions[0]!.body.deadline], ["lease", 3, "7", "string"]);
  // The first renewal is applied and its reply lost: the same mutation is replayed and applied once.
  await until(() => f.sent("POST /v1/leases/ID/renew").length >= 2, "a replayed renewal");
  const renewals = f.sent("POST /v1/leases/ID/renew");
  assert.deepEqual(renewals[1]!.body, renewals[0]!.body); assert.deepEqual(renewals[0]!.body, { id: renewals[0]!.body.id, expectedRevision: 1, ttlSeconds: 3 });
  assert.equal(f.receipts.size, 1);
  await until(async () => (await f.session.status(held.leaseId)).held[0]!.renewal.count === 1, "the confirmed renewal");
  assert.deepEqual(f.notices.map(notice => [notice.event, notice.level]), [["lease_renewal_unconfirmed", "warning"]]);
  // Someone else renews: the next renewal meets a newer revision, reads the lease and renews against it.
  f.bump();
  const moved = f.lease().revision as number;
  await until(() => f.sent("POST /v1/leases/ID/renew").some(call => call.body.expectedRevision === moved), "a renewal against the newer revision", 15000);
  await until(async () => (await f.session.status(held.leaseId)).held[0]!.renewal.count >= 2, "the second confirmed renewal");
  // Whatever was replayed, no mutation UUID was ever sent with two different bodies.
  const bodies = new Map<string, Set<string>>();
  for (const call of f.sent("POST /v1/leases/ID/renew")) bodies.set(call.body.id, (bodies.get(call.body.id) ?? new Set<string>()).add(JSON.stringify(call.body)));
  for (const sentBodies of bodies.values()) assert.equal(sentBodies.size, 1);
  assert.ok(f.receipts.size >= 2);
  assert.deepEqual(await f.session.close(), [{ leaseId: held.leaseId, state: "released" }]);
  assert.equal(f.sent("POST /v1/requests/ID/cancel").length, 1);
});

test("a release that cannot be confirmed stops renewal, and a later close completes it", { timeout: 60000 }, async t => {
  const f = await fake(t);
  const held = await f.session.lease({ templateId: "phone", ttlSeconds: 3 });
  f.refuse.add("POST /v1/requests/ID/cancel");
  await assert.rejects(f.session.release(held.leaseId), (error: any) => error.outcome === "unknown");
  // The cancel was replayed, never replaced by another mutation, and nothing renews the lease any more.
  assert.equal(f.sent("POST /v1/requests/ID/cancel").length, 4);
  const view = (await f.session.status(held.leaseId)).held[0]!;
  assert.deepEqual([view.state, view.renewal.automatic], ["ready", false]);
  const renewed = f.sent("POST /v1/leases/ID/renew").length;
  await sleep(3500);
  assert.equal(f.sent("POST /v1/leases/ID/renew").length, renewed);
  f.refuse.clear();
  assert.deepEqual(await f.session.close(), [{ leaseId: held.leaseId, state: "released" }]);
  await assert.rejects(f.session.lease({ templateId: "phone" }), (error: any) => error.code === "session_closed");
});

test("the queue position is reported when the request view carries one", { timeout: 60000 }, async t => {
  const f = await fake(t), seen: Array<[string, number | undefined, string]> = [];
  f.queued(3);
  const held = await f.session.lease({ templateId: "phone", ttlSeconds: 60 }, { key: false, progress: progress => seen.push([progress.phase, progress.position, progress.message]) });
  assert.deepEqual(seen.map(entry => [entry[0], entry[1]]), [["queued", 3], ["queued", 2], ["queued", 1], ["ready", undefined]]);
  assert.equal(seen[0]![2], "Waiting for a free device (queue position 3): capacity_unavailable.");
  // No key was asked for, so none was exchanged.
  assert.equal(f.sent("POST /v1/leases/ID/credential").length, 0);
  assert.throws(() => f.session.device(held.leaseId), (error: any) => error.code === "lease_key_missing");
  // Detaching stops renewal without releasing.
  assert.deepEqual(f.session.detach(), [held.leaseId]);
  assert.equal(f.sent("POST /v1/requests/ID/cancel").length, 0); assert.equal(f.lease().state, "ready");
});
