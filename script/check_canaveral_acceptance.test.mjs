import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { checkAcceptance } from './check_canaveral_acceptance.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-preflight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secret = join(root, 'private-config');
  writeFileSync(secret, 'SECRET-MUST-NOT-APPEAR', { mode: 0o600 });
  const marker = join(root, 'executed');
  for (const name of ['node', 'adb', 'ollama', 'kubectl', 'virsh']) {
    writeFileSync(join(root, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  }
  return { root, secret, marker, values: { scope: 'linux-guest', config: secret, bundle: secret, helper: secret, kernel: secret, initrd: secret, rootfs: secret } };
}

test('inventory separates authorization from presence and never executes tools or reads secrets', t => {
  const f = fixture(t);
  const result = checkAcceptance(f.values, { PATH: f.root }, 'darwin');
  assert.equal(result.status, 'authorization-required');
  assert.equal(result.nativeRuntimeAcceptance, false);
  assert.equal(result.probesExecuted, false);
  assert.equal(checkAcceptance({ ...f.values, authorized: true }, { PATH: f.root }, 'darwin').status, 'prerequisites-present');
  assert.equal(existsSync(f.marker), false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-MUST|private-config|canaveral-preflight-/);
});

test('platform, executable and missing input gates remain unavailable despite authorization', t => {
  const f = fixture(t);
  assert.equal(checkAcceptance({ ...f.values, authorized: true }, { PATH: f.root }, 'linux').status, 'unavailable');
  chmodSync(join(f.root, 'node'), 0o600);
  assert.equal(checkAcceptance(f.values, { PATH: f.root }, 'darwin').status, 'unavailable');
  assert.equal(checkAcceptance({ scope: 'inference', authorized: true }, { PATH: f.root }, 'darwin').status, 'unavailable');
});

test('symlinked files and directories cannot count as prerequisites', t => {
  const f = fixture(t);
  const link = join(f.root, 'link'); symlinkSync(f.secret, link);
  assert.equal(checkAcceptance({ ...f.values, config: link }, { PATH: f.root }, 'darwin').status, 'unavailable');
  const directory = join(f.root, 'directory'); symlinkSync(f.root, directory);
  assert.equal(checkAcceptance({ ...f.values, config: join(directory, 'private-config') }, { PATH: f.root }, 'darwin').status, 'unavailable');
  assert.equal(checkAcceptance(f.values, { PATH: directory }, 'darwin').status, 'authorization-required');
});

test('CLI stays read-only, withholds paths and rejects unknown arguments', t => {
  const f = fixture(t);
  const script = new URL('./check_canaveral_acceptance.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [script.pathname, '--scope', 'inference', '--config', f.secret, '--bundle', f.secret, '--authorized'], { env: { PATH: f.root }, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).status, 'prerequisites-present');
  assert.equal(existsSync(f.marker), false);
  assert.doesNotMatch(run.stdout + run.stderr, /SECRET-MUST|private-config|canaveral-preflight-/);
  const invalid = spawnSync(process.execPath, [script.pathname, '--token', 'SECRET-MUST-NOT-APPEAR'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /SECRET-MUST/);
});
