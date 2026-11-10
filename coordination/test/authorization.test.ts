import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseNativeAuthorization } from "../src/authorization.ts";
import { owns, requireAdmin, requireScope } from "../src/control/contracts.ts";
import type { ControlRequest, Principal } from "../src/control/contracts.ts";
import { ServiceError } from "../src/errors.ts";

const forbidden = (error: unknown) => error instanceof ServiceError && error.status === 403;

const fixtures = JSON.parse(readFileSync(new URL("../../../fixtures/migration/native-authorization.json", import.meta.url), "utf8")) as
  Array<{ name: string; value: unknown; valid: boolean }>;

for (const fixture of fixtures) {
  test(fixture.name, () => {
    if (fixture.valid) {
      const value = parseNativeAuthorization(fixture.value);
      assert.equal(value.version, 1);
      assert.ok(Object.isFrozen(value));
      assert.equal(value.machineID, value.machineID.toLowerCase());
    } else {
      assert.throws(() => parseNativeAuthorization(fixture.value), TypeError);
    }
  });
}

test("caller mutation cannot change validated authority", () => {
  const input = structuredClone(fixtures.find(fixture => fixture.valid)!.value) as Record<string, unknown>;
  const parsed = parseNativeAuthorization(input);
  input.deadline = 100_000;
  assert.equal(parsed.deadline, 508.75);
  assert.throws(() => parseNativeAuthorization({ ...input, deadline: Infinity }));
  assert.throws(() => parseNativeAuthorization({ ...input, boot: NaN }));
});

test("human scopes intersect current role; administrator scope does not confer authority on an ordinary user", () => {
  const ordinary: Principal = { kind: "token", user: { id: "alice", username: "alice", role: "user", status: "active" }, scopes: ["machines:read", "admin"] };
  const request = (principal: Principal): ControlRequest => ({ method: "GET", path: "/v1/machines", parts: ["v1", "machines"], query: new URLSearchParams(), token: "", body: {}, principal: () => principal });
  assert.equal(requireScope(request(ordinary), "read"), ordinary);
  for (const action of ["write", "access", "admin"] as const) assert.throws(() => requireScope(request(ordinary), action), forbidden);
  const administrator: Principal = { ...ordinary, user: { ...ordinary.user!, role: "admin" }, scopes: ["admin"] };
  for (const action of ["read", "write", "access", "admin"] as const) assert.equal(requireScope(request(administrator), action), administrator);
  const restricted: Principal = { ...administrator, scopes: ["machines:read"] };
  assert.equal(requireScope(request(restricted), "read"), restricted);
  assert.throws(() => requireAdmin(request(restricted)), forbidden);
  for (const action of ["write", "access"] as const) assert.throws(() => requireScope(request(restricted), action), forbidden);
  const operator: Principal = { kind: "operator", user: null, scopes: [] };
  assert.equal(requireAdmin(request(operator)), operator);
});

test("ownership is exact for ordinary users and unowned/lease assignments stay admin-only", () => {
  const alice: Principal = { kind: "session", user: { id: "alice-id", username: "alice", role: "user", status: "active" }, scopes: ["machines:read", "machines:write", "machines:access", "admin"] };
  assert.equal(owns(alice, "alice-id"), true);
  for (const owner of ["bob-id", null, undefined, "lease-owner"]) assert.equal(owns(alice, owner), false);
  const administrator: Principal = { ...alice, user: { ...alice.user!, role: "admin" } };
  const operator: Principal = { kind: "operator", user: null, scopes: [] };
  for (const owner of ["bob-id", null, undefined, "lease-owner"]) {
    assert.equal(owns(administrator, owner), true);
    assert.equal(owns(operator, owner), true);
  }
});
