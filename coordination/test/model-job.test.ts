import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseModelJob, modelJobCanRelease, ownsModelJob, sameModelSubmission, modelReceiptMatches } from "../src/model-job.ts";
const corpus = JSON.parse(readFileSync(new URL("../../../fixtures/migration/model-job.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; value: unknown; valid: boolean; canRelease: boolean }>;
  bindings: Array<{ name: string; submission: unknown; receipt: unknown; matches: boolean }>;
  comparisons: Array<{ name: string; left: unknown; right: unknown; same: boolean }>;
};
for (const c of corpus.cases) test(`model-job: ${c.name}`, () => {
  if (!c.valid) return assert.throws(() => parseModelJob(c.value), TypeError);
  const job = parseModelJob(c.value);
  assert.equal(modelJobCanRelease(job), c.canRelease);
  assert.equal(ownsModelJob(job, job.applicationId), true);
  assert.equal(ownsModelJob(job, "33333333-3333-4333-8333-333333333333"), false);
  assert.ok(Object.isFrozen(job.message));
});
for (const c of corpus.comparisons) test(c.name, () => {
  assert.equal(sameModelSubmission(parseModelJob(c.left), parseModelJob(c.right)), c.same);
});
test("text byte limits and caller mutation", () => {
  const input = structuredClone(corpus.cases[0]!.value) as { message: { prompt: string; maxTokens: number } };
  input.message.prompt = "é".repeat(32768);
  const job = parseModelJob(input);
  input.message.prompt += "x";
  assert.throws(() => parseModelJob(input), TypeError);
  assert.equal(job.message.type === "submit" && Buffer.byteLength(job.message.prompt), 65536);
  input.message.prompt = "\ud800";
  assert.throws(() => parseModelJob(input), TypeError);
  input.message.prompt = "ok";
  for (const n of [NaN, Infinity, -Infinity]) {
    input.message.maxTokens = n;
    assert.throws(() => parseModelJob(input), TypeError);
  }
});

for (const c of corpus.bindings) test(c.name, () => {
  assert.equal(modelReceiptMatches(parseModelJob(c.submission), parseModelJob(c.receipt)), c.matches);
});
test("result UTF-8 limit and nested receipt immutability", () => {
  const input = structuredClone(corpus.cases.find(c => c.name === "succeeded fully cleaned")!.value) as {
    message: { result: { text: string; usage: { inputTokens: number } } };
  };
  input.message.result.text = "é".repeat(65536);
  const job = parseModelJob(input);
  assert.equal(job.message.type === "receipt" && job.message.result !== undefined && Object.isFrozen(job.message.result.usage), true);
  input.message.result.usage.inputTokens = 42;
  if (job.message.type === "receipt") assert.equal(job.message.result!.usage.inputTokens, 0);
  input.message.result.text += "x";
  assert.throws(() => parseModelJob(input), TypeError);
});
