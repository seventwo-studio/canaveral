import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageModelRuntime } from './package_model_runtime.mjs';

async function fixture(run) {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'canaveral-engine-package-')));
  try {
    const inputs = join(path, 'inputs');
    await fs.mkdir(join(inputs, 'bin'), { recursive: true, mode: 0o700 });
    await fs.mkdir(join(inputs, 'lib'), { mode: 0o700 });
    await fs.writeFile(join(inputs, 'bin/engine'), Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('fixture executable, never run')]), { mode: 0o700 });
    await fs.writeFile(join(inputs, 'lib/backend'), 'fixture library', { mode: 0o600 });
    await fs.writeFile(join(inputs, 'LICENSE'), 'fixture license', { mode: 0o600 });
    await run({ path, inputs, output: join(path, 'package'), os: 'linux', arch: 'x86_64', entrypoint: 'bin/engine' });
  } finally { await fs.rm(path, { recursive: true, force: true }); }
}
test('assembles complete bundled or downloadable packages without executing inputs', async () => {
  await fixture(async options => {
    for (const remote of [false, true]) {
      const output = options.output + (remote ? '-remote' : '');
      const result = await packageModelRuntime({ ...options, output, ...(remote ? { baseUrl: 'https://releases.example/engine/1/' } : {}) });
      assert.deepEqual(result.executables, ['bin/engine']);
      assert.equal(result.files['lib/backend'], createHash('sha256').update('fixture library').digest('hex'));
      assert.equal(Object.keys(result.files).length, 3);
      assert.equal(await fs.readFile(join(output, 'assets/LICENSE'), 'utf8'), 'fixture license');
      assert.equal((await fs.stat(join(output, 'assets/bin/engine'))).mode & 0o777, 0o500);
      assert.equal((await fs.stat(join(output, 'assets/lib/backend'))).mode & 0o777, 0o400);
      if (remote) { assert.equal(result.baseUrl, 'https://releases.example/engine/1/'); assert.equal(result.root, undefined); }
      else assert.equal(result.root, join(output, 'assets'));
      assert.deepEqual(JSON.parse(await fs.readFile(join(output, 'runtime-package.json'), 'utf8')), JSON.parse(JSON.stringify(result)));
      await assert.rejects(packageModelRuntime({ ...options, output }), { code: 'EEXIST' });
      assert.equal(await fs.readFile(join(output, 'assets/LICENSE'), 'utf8'), 'fixture license');
    }
  });
});
test('rejects unsafe targets, sources and origins before publishing a package', async () => {
  await fixture(async options => {
    for (const change of [
      { entrypoint: '../escape' }, { entrypoint: 'missing' }, { arch: 'other' },
      { baseUrl: 'http://releases.example/engine/' }, { baseUrl: 'https://secret@releases.example/engine/' },
      { baseUrl: 'https://@releases.example/engine/' }, { baseUrl: 'https://releases.example/' + 'x'.repeat(4096) + '/' },
      { baseUrl: 'https://releases.example/engine/?token=secret' }, { baseUrl: 'https://releases.example/engine' },
      { output: join(options.inputs, 'output') },
    ]) await assert.rejects(packageModelRuntime({ ...options, ...change }));
    await assert.rejects(fs.stat(options.output), { code: 'ENOENT' });
    await fs.symlink('backend', join(options.inputs, 'lib/alias'));
    await assert.rejects(packageModelRuntime(options));
    await fs.unlink(join(options.inputs, 'lib/alias'));
    await fs.link(join(options.inputs, 'lib/backend'), join(options.inputs, 'lib/hardlink'));
    await assert.rejects(packageModelRuntime(options));
    await fs.unlink(join(options.inputs, 'lib/hardlink'));
    await fs.chmod(join(options.inputs, 'lib/backend'), 0o666);
    await assert.rejects(packageModelRuntime(options));
    await fs.chmod(join(options.inputs, 'lib/backend'), 0o600);
    await fs.writeFile(join(options.inputs, 'bin/engine'), '#!/usr/bin/env unbundled-interpreter\n');
    await assert.rejects(packageModelRuntime(options), /native engine/);
    await assert.rejects(fs.stat(options.output), { code: 'ENOENT' });
  });
});
