import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { ConsumerClient, ConsumerServiceError, ConsumerTransportError } from "../../src/consumer-client.ts";
import type { ControllerEvent, EventStreamEnd } from "../../src/consumer-client.ts";
import { createEventStream, STREAM_LIMITS } from "../../src/control/event-stream.ts";
import type { StreamTiming } from "../../src/control/event-stream.ts";
import { envelope, requestTarget, respond } from "../../src/control/http.ts";
import { ServiceError } from "../../src/errors.ts";
import { serverSentEvents } from "../../src/sse.ts";
import type { ServerSentEvent } from "../../src/sse.ts";
import { eventually, sleep } from "./observability-controller.test.ts";

const key = () => randomBytes(32).toString("base64url");
interface Scripted { sequence: number; at: string; kind: string; applicationId?: string; data: Record<string, unknown> }
/** The stream on real sockets, with a scripted worker boundary in place of the control worker. */
async function streamFixture(t: TestContext, timing: StreamTiming = {}) {
  const events: Scripted[] = [], accepted = new Set<string>(), calls = { list: 0, probe: 0, listing: 0, peak: 0 };
  const hooks: { probe?: () => void; list?: (token: string) => void | Promise<void>; oldest: number } = { oldest: 1 };
  const control = { async request(command: any): Promise<unknown> {
    if (command.type === "events.latest") { calls.probe++; hooks.probe?.(); return events.at(-1)?.sequence ?? 0; }
    calls.list++; calls.listing++; calls.peak = Math.max(calls.peak, calls.listing);
    try {
      await hooks.list?.(command.token);
      const admin = command.path === "/v1/admin/events";
      if (!accepted.has(command.token) || admin !== command.token.startsWith("A")) throw new ServiceError("Credential rejected.", 401);
      const query = new URLSearchParams(command.query), latest = events.at(-1)?.sequence ?? 0;
      if (query.has("tail")) return { body: { events: [], cursor: latest, more: false, truncated: false } };
      const after = Number(query.get("after")), kinds = query.getAll("kind");
      const page = events.filter(event => event.sequence > after && (!kinds.length || kinds.includes(event.kind)) && (admin || event.applicationId === command.token));
      return { body: { events: page, cursor: Math.max(after, latest), more: false, truncated: after + 1 < hooks.oldest } };
    } finally { calls.listing--; }
  } };
  const stream = createEventStream(control, { pollMs: 40, ...timing });
  const server = http.createServer((request, response) => {
    void (async () => { await stream.handle(request, response, requestTarget(request)); })().catch((error: unknown) => {
      const result = envelope(error, "00000000-0000-4000-8000-000000000000", false);
      if (response.headersSent) response.destroy(); else respond(response, result.body, result.status);
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { stream.close(); server.close(() => resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const credential = (admin: boolean) => { const token = (admin ? "A" : "a") + key().slice(1); accepted.add(token); return token; };
  const add = (kind = "lease.ready", applicationId?: string) => { const event = { sequence: (events.at(-1)?.sequence ?? 0) + 1, at: new Date().toISOString(), kind, ...(applicationId ? { applicationId } : {}), data: {} }; events.push(event); return event; };
  function follow(token: string, query = "", headers: Record<string, string> = {}) {
    const admin = token.startsWith("A"), messages: ServerSentEvent[] = [];
    let request: http.ClientRequest, closed = false;
    const opened = new Promise<{ status: number; body: any }>((resolve, reject) => {
      request = http.request(`${url}${admin ? "/v1/admin/events/stream" : "/v1/events/stream"}${query}`, { agent: false, headers: { Authorization: `Bearer ${token}`, ...headers } }, response => {
        if (response.statusCode !== 200) { const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk as Buffer)); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") })); return; }
        resolve({ status: 200, body: {} });
        void (async () => { try { for await (const message of serverSentEvents(response)) messages.push(message); } catch { /* Closed by the test. */ } closed = true; })();
      });
      request.once("error", reject); request.end();
    });
    const named = (name: string) => messages.filter(message => message.event === name).map(message => ({ id: message.id, ...JSON.parse(message.data) }));
    return { opened, messages, named, data: () => messages.filter(message => message.event === undefined).map(message => JSON.parse(message.data) as Scripted), ended: () => closed, close: () => request.destroy() };
  }
  /** Drop every connection without a closing message, as a network failure would. */
  const cut = () => { for (const socket of sockets) socket.destroy(); };
  return { url, events, accepted, calls, hooks, stream, credential, add, follow, cut };
}

test("a busy worker changes nothing: no follower is dropped, and events arrive when it answers again", async t => {
  const f = await streamFixture(t), admin = f.credential(true), other = f.credential(true);
  const first = f.follow(admin), second = f.follow(other);
  assert.equal((await first.opened).status, 200); assert.equal((await second.opened).status, 200);
  await eventually(() => f.calls.probe, count => count >= 2);
  // The once-a-round probe is refused because the worker is at its pending limit.
  f.hooks.probe = () => { throw new ServiceError("Controller service is busy.", 429, { retryable: false }); };
  f.add(); f.add();
  const probes = f.calls.probe, lists = f.calls.list;
  await eventually(() => f.calls.probe, count => count >= probes + 5);
  assert.equal(f.calls.list, lists, "a busy round reads nothing");
  assert.deepEqual([first.ended(), second.ended(), first.named("end"), second.named("end"), first.data().length], [false, false, [], [], 0]);
  assert.equal(f.stream.size, 2);
  delete f.hooks.probe;
  await eventually(() => second.data().length, count => count === 2);
  assert.deepEqual(first.data().map(event => event.sequence), [1, 2]);
  // The list route being busy for one follower is tolerated the same way.
  f.hooks.list = token => { if (token === admin) throw new ServiceError("Controller service is busy.", 429, { retryable: false }); };
  f.add();
  await eventually(() => second.data().length, count => count === 3);
  await sleep(150);
  assert.deepEqual([first.ended(), first.data().length], [false, 2]);
  delete f.hooks.list;
  await eventually(() => first.data().length, count => count === 3);
  // A probe that fails for another reason leaves each follower to its own read of the list route.
  f.hooks.probe = () => { throw new ServiceError("Controller storage or service unavailable.", 503); };
  f.add();
  await eventually(() => first.data().length, count => count === 4);
  // Only the follower whose own read is refused ends, with that refusal's code.
  f.accepted.delete(other);
  await eventually(() => second.named("end"), ends => ends.length === 1, 5000);
  assert.deepEqual(second.named("end").map(end => [end.code, end.cursor]), [["unauthenticated", 4]]);
  assert.deepEqual([first.ended(), f.stream.size], [false, 1]);
});

test("streams are bounded per credential, for applications together, in total and while being admitted", async t => {
  const f = await streamFixture(t);
  const refused = (reply: { status: number; body: any }) => { assert.deepEqual([reply.status, reply.body.code, reply.body.retryable], [429, "event_stream_limit", true]); };
  // One credential cannot hold more than its share, and a second credential is unaffected.
  const greedy = f.credential(false), open = [];
  for (let n = 0; n < STREAM_LIMITS.perCredential; n++) { const s = f.follow(greedy); assert.equal((await s.opened).status, 200); open.push(s); }
  refused(await f.follow(greedy).opened);
  const modest = f.follow(f.credential(false)); assert.equal((await modest.opened).status, 200); open.push(modest);
  // Applications together stop short of the total, so administrators always have slots left.
  while (f.stream.size < STREAM_LIMITS.applications) {
    const token = f.credential(false);
    for (let n = 0; n < STREAM_LIMITS.perCredential && f.stream.size < STREAM_LIMITS.applications; n++) { const s = f.follow(token); assert.equal((await s.opened).status, 200); open.push(s); }
  }
  refused(await f.follow(f.credential(false)).opened);
  const administrators = [f.credential(true), f.credential(true)];
  for (const token of administrators) for (let n = 0; n < STREAM_LIMITS.perCredential; n++) { const s = f.follow(token); assert.equal((await s.opened).status, 200); open.push(s); }
  assert.equal(f.stream.size, STREAM_LIMITS.total);
  refused(await f.follow(f.credential(true)).opened);
  // A closed stream frees its slot.
  open[0]!.close();
  await eventually(() => f.stream.size, size => size === STREAM_LIMITS.total - 1);
  assert.equal((await f.follow(f.credential(true)).opened).status, 200);
  for (const s of open) s.close();
  await eventually(() => f.stream.size, size => size <= 1);

  // Authentication has its own bound: a burst of requests, valid or not, takes at most a few worker requests at once.
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hooks.list = () => gate;
  const before = f.calls.list;
  const burst = Array.from({ length: 12 }, (_, n) => f.follow(n % 2 ? f.credential(true) : "A" + key().slice(1)));
  const early = await Promise.all(burst.map(s => Promise.race([s.opened, sleep(300).then(() => undefined)])));
  assert.equal(early.filter(reply => reply !== undefined).length, 12 - STREAM_LIMITS.admissions, "the rest are refused at once, without reaching the worker");
  for (const reply of early) if (reply) refused(reply);
  assert.deepEqual([f.calls.list - before, f.calls.peak], [STREAM_LIMITS.admissions, STREAM_LIMITS.admissions]);
  release(); delete f.hooks.list;
  const late = (await Promise.all(burst.map(s => s.opened))).map(reply => reply.status).filter(status => status !== 429).sort();
  assert.equal(late.length, STREAM_LIMITS.admissions); assert.ok(late.every(status => status === 200 || status === 401));
});

test("position messages let any client resume, and the last event id wins over a stale after", async t => {
  const f = await streamFixture(t, { keepaliveMs: 120, lifetimeMs: 900 }), admin = f.credential(true);
  for (let n = 0; n < 5; n++) f.add();
  // No cursor: the stream opens at the head and says so.
  const head = f.follow(admin);
  assert.equal((await head.opened).status, 200);
  await eventually(() => head.named("open"), opens => opens.length === 1);
  assert.deepEqual(head.named("open"), [{ id: "5", cursor: 5 }]);
  f.add("host.offline"); f.add("lease.ready");
  await eventually(() => head.data().length, count => count === 2);
  // A quiet stream still reports how far it has read, as an id a standard client will send back.
  await eventually(() => head.named("cursor"), cursors => cursors.length >= 1);
  assert.deepEqual(head.named("cursor")[0], { id: "7", cursor: 7 });
  // The stream reaches its lifetime: the end message carries the position too.
  await eventually(() => head.named("end"), ends => ends.length === 1, 5000);
  assert.deepEqual(head.named("end"), [{ id: "7", code: "stream_lifetime", cursor: 7 }]);
  await eventually(() => head.ended(), ended => ended);
  // A URL that still carries after=2 is reconnected with the last id seen: the header decides, and nothing repeats.
  f.add();
  const resumed = f.follow(admin, "?after=2", { "Last-Event-ID": "7" });
  assert.equal((await resumed.opened).status, 200);
  await eventually(() => resumed.data().length, count => count >= 1);
  assert.deepEqual([resumed.named("open"), resumed.data().map(event => event.sequence)], [[{ id: "7", cursor: 7 }], [8]]);
  const stale = f.follow(admin, "?after=2");
  assert.equal((await stale.opened).status, 200);
  await eventually(() => stale.data().length, count => count === 6);
  assert.deepEqual(stale.data().map(event => event.sequence), [3, 4, 5, 6, 7, 8]);
  for (const [query, headers] of [["?after=x", {}], ["", { "Last-Event-ID": "-1" }], ["?after=1&after=2", {}], ["?after=1", { "Last-Event-ID": "seven" }]] as const) assert.equal((await f.follow(admin, query, headers).opened).status, 400);
  // Closing the controller tells every follower before the sockets go, and refuses new ones.
  f.stream.close();
  await eventually(() => resumed.named("end"), ends => ends.length === 1);
  assert.deepEqual(resumed.named("end"), [{ id: "8", code: "controller_closing", cursor: 8 }]);
  assert.deepEqual([(await f.follow(admin).opened).status, f.stream.size], [503, 0]);
});

test("the SDK reports how a followed stream ended and never hides missed history", async t => {
  // The authorization recheck is shortened so that a revocation is seen well before the stream's lifetime.
  const f = await streamFixture(t, { keepaliveMs: 100, lifetimeMs: 700, recheckMs: 100 }), application = f.credential(false);
  const client = (token = application) => new ConsumerClient({ baseUrl: f.url, applicationKey: token, allowLoopbackHttp: true });
  for (let n = 0; n < 3; n++) f.add("lease.ready", application);
  // An ordinary end is the iterator's return value, with the position to continue from.
  const collect = async (iterator: AsyncGenerator<ControllerEvent, EventStreamEnd, void>) => {
    const received: number[] = [];
    for (;;) { const step = await iterator.next(); if (step.done) return { received, end: step.value }; received.push(step.value.sequence); }
  };
  const positions: number[] = [];
  const quiet = await collect(client().followEvents({ onCursor: cursor => positions.push(cursor) }));
  assert.deepEqual(quiet, { received: [], end: { reason: "stream_lifetime", cursor: 3 } });
  assert.ok(positions.length >= 2 && positions.every(cursor => cursor === 3), "a quiet follower is told its position");
  f.add("lease.released", application); f.add("lease.released", "someone-else");
  const resumed = await collect(client().followEvents({ after: quiet.end.cursor! }));
  assert.deepEqual(resumed, { received: [4], end: { reason: "stream_lifetime", cursor: 5 } });
  // A plain for-await loop ends quietly on an ordinary end.
  const seen: number[] = [];
  for await (const event of client().followEvents({ after: 0 })) seen.push(event.sequence);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  // Missed history: thrown unless the caller accepts the gap.
  f.hooks.oldest = 3;
  await assert.rejects(collect(client().followEvents({ after: 0 })), (error: unknown) => error instanceof ConsumerServiceError && error.code === "events_truncated" && error.status === 410);
  const gaps: Array<{ after: number }> = [];
  assert.deepEqual((await collect(client().followEvents({ after: 0, onTruncated: gap => gaps.push(gap) }))).received, [1, 2, 3, 4]);
  assert.deepEqual(gaps, [{ after: 0 }]);
  assert.deepEqual((await collect(client().followEvents({ after: 2 }))).received, [3, 4], "a cursor that is still retained reports no gap");
  f.hooks.oldest = 1;
  // Revocation is an error, not an ordinary end.
  const doomed = f.credential(false), revoked = collect(client(doomed).followEvents());
  await eventually(() => f.stream.size, size => size >= 1);
  f.accepted.delete(doomed);
  await assert.rejects(revoked, (error: unknown) => error instanceof ConsumerServiceError && error.code === "unauthenticated" && error.status === 401 && error.retryable === false);
  // The controller ending the stream for any other reason is a retryable service error.
  const failing = collect(client().followEvents());
  await eventually(() => f.stream.size, size => size >= 1);
  f.hooks.probe = () => { throw new ServiceError("Controller storage or service unavailable.", 503); };
  f.hooks.list = () => { throw new Error("worker gone"); };
  await assert.rejects(failing, (error: unknown) => error instanceof ConsumerServiceError && error.code === "unavailable" && error.retryable === true);
  delete f.hooks.probe; delete f.hooks.list;
  // A connection that is cut without an end message is a transport failure, never a quiet finish.
  const dropped = collect(client().followEvents());
  await eventually(() => f.stream.size, size => size >= 1);
  f.cut();
  await assert.rejects(dropped, (error: unknown) => error instanceof ConsumerTransportError && error.code === "connection_failed");
  // The caller's own abort is an ordinary end, whether the stream is open or still being opened.
  const abort = new AbortController();
  const aborted = collect(client().followEvents({ signal: abort.signal, onCursor: () => abort.abort() }));
  assert.deepEqual(await aborted, { received: [], end: { reason: "aborted", cursor: 5 } });
  const early = new AbortController(), opening = collect(client().followEvents({ after: 4, signal: early.signal }));
  early.abort();
  assert.deepEqual(await opening, { received: [], end: { reason: "aborted", cursor: 4 } });
  await assert.rejects(collect(client(key()).followEvents()), (error: unknown) => error instanceof ConsumerServiceError && error.status === 401);
  await assert.rejects(client().followEvents({ onTruncated: "yes" as never }).next(), /handlers must be functions/);
});
