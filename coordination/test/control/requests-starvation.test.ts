import assert from "node:assert/strict";
import test from "node:test";
import { leaseFixture } from "./leases-fixture.test.ts";
import { Requests } from "../../src/requests.ts";
import { ServiceError } from "../../src/errors.ts";

// Unservable backlogs from a few applications must not use every attempt in every pass.
const envelope = (f: ReturnType<typeof leaseFixture>) => { const { id, ...intent } = f.acquire(); return { id, kind: "lease", intent } as any; };
const full = () => new ServiceError("capacity", 503, { code: "capacity_unavailable" });

function setup(t: Parameters<typeof leaseFixture>[0], waiting?: number) {
  const f = leaseFixture(t), b = f.application(), owners = new Map<string, string>();
  const us = [0, 1, 2].map(() => f.application(waiting ? { maxWaitingRequests: waiting } : {}));
  let attempts = 0, reached = 0;
  const queue = new Requests(f.store, f.apps, (_k, _a, intent) => { attempts++; if (owners.get(String(intent.id)) === "U") throw full(); reached = attempts; }, () => {});
  // B is admitted once, so every never-admitted application sorts ahead of it.
  const first = envelope(f); owners.set(first.id, "B"); queue.submit(b.credential, first); queue.pass();
  const add = (cred: string, ttl: number) => { const r = envelope(f); r.intent = { ...r.intent, ttlSeconds: ttl }; owners.set(r.id, "U"); queue.submit(cred, r); return r.id as string; };
  const servable = () => { const r = envelope(f); owners.set(r.id, "B"); queue.submit(b.credential, r); return r.id as string; };
  return { f, b, us, queue, add, servable, reached: () => reached, reset: () => { attempts = 0; reached = 0; } };
}

test("never-admitted applications with hundreds of unservable groups cannot hold a servable application past one pass", t => {
  const s = setup(t, 1000);
  s.f.store.transaction(() => { for (const [k, u] of s.us.entries()) for (let g = 0; g < 100; g++) for (let m = 0; m < 10; m++) s.add(u.credential, 60 + k * 100 + g); });
  const id = s.servable(); s.reset(); s.queue.pass();
  assert.equal(s.queue.inspect(s.b.credential, id).state, "admitted", "the servable request is admitted in the first pass");
  assert.ok(s.reached() <= 3 * 16 + 1, `B is reached after each other application's capped refusals (attempt ${s.reached()})`);
});

test("cancel-and-resubmit churn of unservable requests under default limits cannot starve a servable application", t => {
  const s = setup(t);
  let live: Array<{ cred: string; id: string; ttl: number }> = [];
  s.f.store.transaction(() => { for (const [k, u] of s.us.entries()) for (let g = 0; g < 100; g++) live.push({ cred: u.credential, id: s.add(u.credential, 60 + k * 100 + g), ttl: 60 + k * 100 + g }); });
  const id = s.servable();
  let passes = 0;
  while (s.queue.inspect(s.b.credential, id).state === "waiting" && passes < 50) {
    s.queue.pass(); passes++;
    s.f.store.transaction(() => { const old = live; live = []; for (const r of old) { s.queue.cancel(r.cred, r.id, {}); live.push({ ...r, id: s.add(r.cred, r.ttl) }); } });
  }
  assert.equal(s.queue.inspect(s.b.credential, id).state, "admitted"); assert.ok(passes <= 2, `admitted after ${passes} passes`);
});
