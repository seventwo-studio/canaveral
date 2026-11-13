import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

test('harness startup discards private parser, path and assertion diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canaveral-startup-'));
  const secret = 'SYNTHETIC_PRIVATE_STARTUP_TOKEN';
  const path = join(dir, 'config.json');
  const base = {helper: '/missing/helper', satellite: '/missing/satellite', runnerClient: '/missing/runner',
    manifest: '/missing/manifest', stateRoot: dir, bundleDigest: 'sha256:' + 'a'.repeat(64),
    signingRequirement: 'anchor apple', operatorDenyCidrsFile: join(dir, secret)};
  const run = (contents: string | undefined, diagnostic: string) => {
    if (contents !== undefined) writeFileSync(path, contents, {mode: 0o600});
    const env: NodeJS.ProcessEnv = {...process.env, CANAVERAL_NATIVE_ACCEPTANCE: 'operator-authorized'};
    delete env.CI;
    const child = spawnSync(process.execPath, [new URL('./run.ts', import.meta.url).pathname, path],
      {encoding: 'utf8', env, timeout: 10000});
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stderr, diagnostic + '\n');
    for (const value of [secret, dir, path]) assert(!(child.stdout + child.stderr).includes(value));
  };
  try {
    // Counterfactual: uncaught JSON.parse prints this unquoted private path/token.
    run('{"operatorDenyCidrsFile": ' + join(dir, secret) + '}', 'private configuration invalid');
    rmSync(path);
    run(undefined, 'private configuration unreadable');
    for (const value of [null, [], {...base, bundleDigest: secret}, {...base, helper: secret},
      {...base, signingRequirement: {token: secret}}, base]) {
      run(JSON.stringify(value), 'private configuration invalid');
    }
    writeFileSync(base.operatorDenyCidrsFile, '{"operatorDenyCidrs": ' + secret + '}', {mode: 0o600});
    run(JSON.stringify(base), 'private configuration invalid');
    writeFileSync(base.operatorDenyCidrsFile, JSON.stringify({operatorDenyCidrs: ['8.8.8.8/32']}));
    run(JSON.stringify({...base, helper: join(dir, 'fixture-' + secret)}), 'private configuration invalid');
    run(JSON.stringify({...base, stateRoot: join(dir, secret)}), 'private configuration invalid');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
