import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOperatorTemplate, normalizeTemplate, operatorRecipe, recipe } from "../../src/control/templates.ts";
import { userData } from "../../src/control/preparation.ts";

test("large private guest bundles retain the public preparation envelope", () => {
  const prepare = { driver: "cloud-init", files: Array.from({ length: 120 }, (_, index) => ({ path: `/opt/canaveral/part-${index}`, content: "a".repeat(4096), mode: "0600" })) };
  assert.throws(() => recipe(prepare, "linux"), /preparation files/);
  assert.equal(operatorRecipe(prepare, "linux")!.files.length, 120);
  const definition = { id: "fixture", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, prepare };
  assert.throws(() => normalizeTemplate(definition), /preparation files/);
  const publicView = normalizeOperatorTemplate(definition);
  assert.equal(publicView.prepare, undefined);
  assert.equal(publicView.preparationDriver, "cloud-init");
  assert.match(String(publicView.recipeDigest), /^[a-f0-9]{64}$/);
  assert.deepEqual(normalizeTemplate(publicView), publicView);
  const payload = userData(definition, { id: "11111111-2222-4333-8444-555555555555" }, "http://127.0.0.1:8765", "a".repeat(43));
  assert.ok(payload && payload.startsWith("#cloud-config"));
  assert.ok(Buffer.byteLength(payload) > 200000);
});

test("private bundle permissions and individual payloads stay bounded", () => {
  for (const file of [{ path: "relative", content: "data" }, { path: "/file", content: "a".repeat(1048577) }, { path: "/file", content: "data", mode: "07777" }]) {
    assert.throws(() => operatorRecipe({ driver: "cloud-init", files: [file] }, "linux"));
  }
});
