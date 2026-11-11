import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from '../../src/cli.ts';

test('parent CLI exposes installer help without contacting controller or starting services', async () => {
  let output = '', errors = '';
  const status = await main(['install', '--help'], {
    stdout: value => { output += value; }, stderr: value => { errors += value; },
    client: () => { throw new Error('Installer must not construct an API client'); },
  });
  assert.equal(status, 0);
  assert.equal(errors, '');
  for (const flag of ['--bundle', '--host-config', '--installation', '--state', '--node', '--launcher', '--stable-root']) assert.ok(output.includes(flag));
});

test('installer dispatch preserves strict local-only argument validation', async () => {
  for (const argv of [['install', '--url', 'https://example.invalid'], ['--token-file', 'must-not-be-opened', 'install', '--help']]) {
    let output = '', errors = '';
    assert.equal(await main(argv, {
      stdout: value => { output += value; }, stderr: value => { errors += value; },
      client: () => { throw new Error('Installer must not construct an API client'); },
    }), 1);
    assert.equal(output, '');
    assert.ok(errors.length > 0);
  }
});
