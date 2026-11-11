import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ResourceDomains } from "../src/resource-domains.ts";
import type { Resources } from "../src/consumers.ts";
import { ServiceError } from "../src/errors.ts";

test("generic reservation admission rejects malformed resources without poisoning the domain", () => {
  const db = new DatabaseSync(":memory:"), domains = new ResourceDomains();
  db.exec("BEGIN IMMEDIATE");
  try {
    ResourceDomains.schema(db);
    const domain = randomUUID(), owner = randomUUID();
    domains.define(db, { id: domain, name: "fixture", capacity: { cpu: 4, memoryMiB: 4, diskGiB: 4 } }, 1);
    const valid = { cpu: 1, memoryMiB: 1, diskGiB: 1 };
    for (const amount of [null, {}, { ...valid, cpu: 0 }, { ...valid, cpu: -1 }, { ...valid, cpu: "1" },
      { ...valid, cpu: true }, { ...valid, cpu: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, cpu: Infinity },
      { ...valid, cpu: NaN }, { ...valid, cpu: 1.5 }, { ...valid, extra: 1 }, { cpu: 1, diskGiB: 1 }]) {
      assert.throws(() => domains.reserve(db, { id: randomUUID(), domain, kind: "model", owner,
        resources: amount as Resources }, 2), e => e instanceof ServiceError && e.status === 400);
      assert.equal(domains.view(db, domain).reservations, 0);
      assert.deepEqual(domains.view(db, domain).reserved, { cpu: 0, memoryMiB: 0, diskGiB: 0 });
    }
    assert.equal(domains.reserve(db, { id: randomUUID(), domain, kind: "model", owner, resources: valid }, 3), true);
    assert.deepEqual(domains.view(db, domain).reserved, valid);
  } finally { db.exec("ROLLBACK"); db.close(); }
});

test('placement ranks only approved domains and includes held Linux and model resources', () => {
  const db = new DatabaseSync(':memory:'), domains = new ResourceDomains();
  db.exec('BEGIN IMMEDIATE');
  try {
    ResourceDomains.schema(db);
    const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
    const capacity = { cpu: 10, memoryMiB: 100, diskGiB: 100 }, request = { cpu: 1, memoryMiB: 1, diskGiB: 1 };
    for (const id of [first, second]) domains.define(db, { id, name: id, capacity }, 1);
    const model = randomUUID(), linux = randomUUID(), owner = randomUUID();
    domains.reserve(db, { id: model, domain: first, kind: 'model-job', owner, resources: { cpu: 7, memoryMiB: 1, diskGiB: 1 } }, 2);
    domains.reserve(db, { id: linux, domain: second, kind: 'linux-lease', owner, resources: { cpu: 1, memoryMiB: 30, diskGiB: 1 } }, 2);
    assert.deepEqual(domains.placements(db, [first, second, first], request), [second, first]);
    assert.deepEqual(domains.placements(db, [first], request), [first], 'ranking cannot add an unapproved domain');
    assert.deepEqual(domains.placements(db, [first, second], { ...request, cpu: 4 }), [second]);
    assert.equal(domains.view(db, first).reservations, 1, 'ranking itself reserves nothing');
    domains.release(db, model, owner, 3);
    assert.deepEqual(domains.placements(db, [second, first], request), [first, second]);
    domains.release(db, linux, owner, 3);
    assert.deepEqual(domains.placements(db, [second, first], request), [first, second], 'ties use stable domain identity');
    domains.reserve(db, { id: randomUUID(), domain: first, kind: 'model-job', owner, resources: { cpu: 1, memoryMiB: 1, diskGiB: 90 } }, 4);
    domains.reserve(db, { id: randomUUID(), domain: second, kind: 'linux-lease', owner, resources: { cpu: 1, memoryMiB: 30, diskGiB: 1 } }, 4);
    assert.deepEqual(domains.placements(db, [first, second], request), [second, first], 'disk pressure contributes even when RAM is mostly free');
    assert.deepEqual(domains.placements(db, [second, first], { ...request, memoryMiB: 70 }), [first, second], 'the incoming request contributes before selection');
  } finally { db.exec('ROLLBACK'); db.close(); }
});
