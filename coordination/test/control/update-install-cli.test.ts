import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installMain, generateServiceDefinition } from '../../src/updates/install-cli.ts';
import { bootstrapFixture } from './update-bootstrap.test.ts';

test('strict CLI rejects unknown, duplicate, extra and incomplete flags without side effects', async () => {
  for (const args of [[], ['install'], ['--help', '--help'], ['--help', '--node', '/node'], ['--unknown'], ['--bundle', '/one', '--bundle', '/two']]) {
    let output = '', error = '';
    assert.equal(await installMain(args, { stdout: text => { output += text; }, stderr: text => { error += text; } }), 1);
    assert.equal(output, ''); assert.match(error, /failed/);
  }
  let help = '';
  assert.equal(await installMain(['--help'], { stdout: text => { help += text; } }), 0);
  assert.match(help, /never installs\/enables/);
});

test('CLI preserves config/identity and returns a generated service without running supplied Node', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const stable = join(f.root, 'stable'); mkdirSync(stable, { mode: 0o700 });
  const launcher = join(stable, 'launcher.js'); writeFileSync(launcher, 'throw Error("do not run");', { mode: 0o600 });
  const node = join(f.root, 'node'); writeFileSync(node, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const configPath = join(f.root, 'host.json');
  const config = JSON.stringify({ url: 'https://controller.invalid', stateDir: f.hostState, updates: { trustedKeys: f.options.trustedKeys, protectedPaths: [f.hostState] } });
  writeFileSync(configPath, config, { mode: 0o600 });
  const args = ['--bundle', f.bundle, '--host-config', configPath, '--installation', f.options.installationRoot, '--state', f.options.stateDirectory, '--node', node, '--launcher', launcher, '--stable-root', stable];
  let output = '', error = '';
  assert.equal(await installMain(args, { stdout: text => { output += text; }, stderr: text => { error += text; } }), 0, error);
  const result = JSON.parse(output) as { releaseId: string; service: { content: string } };
  assert.equal(result.releaseId, f.manifest.releaseId); assert.match(result.service.content, /launcher.js/);
  assert.equal(readFileSync(configPath, 'utf8'), config);
  assert.equal(existsSync(join(f.root, 'canaveral-runtime.service')), false);
  const identity = readFileSync(join(f.options.stateDirectory, 'installation.json'));
  assert.equal(await installMain(args, { stdout: () => {}, stderr: () => {} }), 1);
  assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'installation.json')), identity);
});

test('service definitions escape arguments and reject relative/control/link paths and Windows', t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const opts = { node: join(f.root, 'node space%$"&<>'), launcher: join(f.root, 'stable', 'launcher.js'), stableRoot: join(f.root, 'stable'), hostConfig: join(f.root, 'config&.json'), installation: f.options.installationRoot, state: f.options.stateDirectory };
  const systemd = generateServiceDefinition(opts, 'linux').content;
  assert.ok(systemd.includes('space%%$$\\"&<>')); assert.match(systemd, /KillMode=process/); assert.match(systemd, /SendSIGKILL=no/);
  const plist = generateServiceDefinition(opts, 'darwin').content;
  assert.match(plist, /&quot;&amp;&lt;&gt;/); assert.match(plist, /AbandonProcessGroup/);
  assert.throws(() => generateServiceDefinition({ ...opts, node: '/node\nExecStart=evil' }, 'linux'), /control/);
  assert.throws(() => generateServiceDefinition({ ...opts, node: 'relative' }, 'linux'), /absolute/);
  assert.throws(() => generateServiceDefinition(opts, 'win32'), /unproven/);
  chmodSync(f.root, 0o700);
});

test('lost CLI output after committed installation cannot create a new identity or replay', async t => {
  const f = bootstrapFixture(); t.after(f.cleanup);
  const stable = join(f.root, 'stable'); mkdirSync(stable, { mode: 0o700 });
  const launcher = join(stable, 'launcher.js'), node = join(f.root, 'node'), config = join(f.root, 'config.json');
  writeFileSync(launcher, '// inert', { mode: 0o600 }); writeFileSync(node, '// inert', { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ url: 'https://controller.invalid', stateDir: f.hostState, updates: { trustedKeys: f.options.trustedKeys, protectedPaths: [f.hostState] } }), { mode: 0o600 });
  const args = ['--bundle', f.bundle, '--host-config', config, '--installation', f.options.installationRoot, '--state', f.options.stateDirectory, '--node', node, '--launcher', launcher, '--stable-root', stable];
  assert.equal(await installMain(args, { stdout: () => { throw Error('lost output'); }, stderr: () => {} }), 1);
  const identity = readFileSync(join(f.options.stateDirectory, 'installation.json'));
  const active = readFileSync(join(f.options.stateDirectory, 'active.json'));
  assert.equal(await installMain(args, { stdout: () => {}, stderr: () => {} }), 1);
  assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'installation.json')), identity);
  assert.deepEqual(readFileSync(join(f.options.stateDirectory, 'active.json')), active);
});
