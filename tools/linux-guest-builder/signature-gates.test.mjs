import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Rust installer cannot execute when detached signature verification fails', t => {
  const root = mkdtempSync(join(tmpdir(), 'canaveral-signature-gate-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(join(root,'inputs')); mkdirSync(join(root,'bin'));
  // Existing but unauthenticated key material must not authorize execution.
  writeFileSync(join(root,'inputs','rust-key.asc'), 'invalid-key');
  writeFileSync(join(root,'inputs','rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz.asc'), 'invalid-signature');
  writeFileSync(join(root,'bin','gpg'), '#!/bin/sh\ncase "$*" in *--verify*) exit 1 ;; *) exit 0 ;; esac\n', {mode:0o700});
  const result = spawnSync('/bin/bash', [resolve('tools/linux-guest-builder/build-rust.sh')], {
    cwd:root, env:{...process.env, BUILD:root, PATH:join(root,'bin')+':'+process.env.PATH}, encoding:'utf8'
  });
  assert.notEqual(result.status, 0);
  assert(!existsSync(join(root,'rust')), 'installer destination created before authentication');
});
