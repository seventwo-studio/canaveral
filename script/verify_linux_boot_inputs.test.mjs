import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, verificationCommand } from './verify_linux_boot_inputs.mjs';
const args = ['--recipe', '/local/recipe.json', '--inputs', '/local/inputs', '--evidence', '/local/evidence.json'];
test('preflight uses existing Rust CLI, locked dependencies and at most two jobs', () => {
  const command = verificationCommand(args);
  assert(command.includes('--locked'));
  assert(command.includes('--offline'));
  assert(command.includes('-j2'));
  assert.deepEqual(command.slice(-7), ['verify-inputs', ...args]);
  assert(!command.includes('assemble'));
});
test('argv remains literal and process failures propagate', () => {
  const literal = [...args];
  literal[1] = '/local/$(echo nope); recipe';
  assert.equal(run(literal, (program, argv, options) => {
    assert.equal(program, 'cargo');
    assert.equal(argv.at(-5), literal[1]);
    assert.equal(options.shell, false);
    return { status: 17 };
  }), 17);
  assert.throws(() => run(args, () => ({signal:'SIGTERM', status:null})), /interrupted/);
  assert.throws(() => run(args, () => ({error:new Error('missing cargo')})), /missing cargo/);
});
test('reject unsupported/missing options before spawning', () => {
  for (const bad of [[], args.slice(0, 4), [...args, '--output', 'out'], ['--recipe', '--inputs', ...args.slice(2)]]) {
    assert.throws(() => run(bad, () => assert.fail('must not spawn')), /usage/);
  }
});
