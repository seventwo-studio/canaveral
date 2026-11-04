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
