import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseNativeAuthorization } from "../src/authorization.ts";

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
