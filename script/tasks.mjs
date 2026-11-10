#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' }, shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}
const npm = (project, ...args) => run('npm', ['--prefix', project, ...args]);
function install() { for (const project of ['coordination', 'dashboard']) npm(project, 'ci', '--ignore-scripts'); }
function prepare() {
  // Source checkouts install the two independently locked packages. Published
  // packages already contain their compiled CLI/SDK and static dashboard assets.
  if (!existsSync(resolve(ROOT, 'coordination/src'))) return;
  for (const project of ['coordination', 'dashboard']) {
    if (!existsSync(resolve(ROOT, project, 'node_modules'))) npm(project, 'ci', '--ignore-scripts');
    npm(project, 'run', 'build');
  }
}
function build() { npm('coordination', 'run', 'build'); npm('dashboard', 'run', 'build'); run('cargo', ['build', '--workspace', '--locked', '-j', '2']); run(process.execPath, ['script/prepare_native.mjs', 'debug']); }
function typecheck() { npm('coordination', 'run', 'typecheck'); npm('dashboard', 'run', 'typecheck'); run('cargo', ['check', '--workspace', '--all-targets', '--locked', '-j', '2']); }
function test() {
  npm('coordination', 'run', 'build'); npm('coordination', 'test'); npm('dashboard', 'test');
  run(process.execPath, ['--test', 'crates/guest-agent/worker.test.ts', 'VirtualMachines/GuestHelpers/linux_desktop.test.ts']);
  run(process.execPath, ['--test', 'script/tooling.test.mjs']);
  run('cargo', ['test', '--workspace', '--locked', '-j', '2']);
}
export function main(action) {
  switch (action) {
    case 'install': install(); break;
    case 'prepare': prepare(); break;
    case 'build': build(); break;
    case 'typecheck': typecheck(); break;
    case 'test': test(); break;
    case 'check': run(process.execPath, ['script/check_no_python.mjs']); typecheck(); build(); test(); break;
    default: throw new Error('Usage: node script/tasks.mjs install|prepare|build|typecheck|test|check');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
