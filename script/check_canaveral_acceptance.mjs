#!/usr/bin/env node
/** Read-only prerequisites inventory. Never invokes tools, contacts services or reads credentials. */
import { constants, accessSync, lstatSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scopes = {
  'linux-guest': { platform: 'darwin', tools: ['node'], files: ['config', 'bundle', 'helper', 'kernel', 'initrd', 'rootfs'] },
  'macos-helper': { platform: 'darwin', tools: ['node'], files: ['config', 'bundle', 'helper'] },
  'windows-helper': { platform: 'win32', tools: ['node'], files: ['config', 'bundle', 'helper'] },
  'android': { platform: null, tools: ['node', 'adb'], files: ['config', 'bundle'] },
  'inference': { platform: null, tools: ['node', 'ollama'], files: ['config', 'bundle'] },
  'libvirt': { platform: 'linux', tools: ['node', 'virsh'], files: ['config', 'bundle'] },
  'kubevirt': { platform: null, tools: ['node', 'kubectl'], files: ['config', 'bundle'] },
};

function regular(path, executable = false) {
  try {
    if (executable) path = realpathSync(path);
    // Reject symlink ancestors without reading file contents.
    let current = resolve(path);
    for (;;) {
      if (lstatSync(current).isSymbolicLink()) return false;
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch { return false; }
}

export function checkAcceptance(values, environment = process.env, platform = process.platform) {
  const scope = scopes[values.scope];
  if (!scope) throw new Error('Choose a supported acceptance scope.');
  const checks = [{ prerequisite: 'platform', present: scope.platform === null || platform === scope.platform }];
  for (const tool of scope.tools) {
    const suffix = platform === 'win32' ? '.exe' : '';
    const present = (environment.PATH ?? '').split(delimiter).filter(isAbsolute)
      .some(directory => regular(join(directory, tool + suffix), true));
    checks.push({ prerequisite: `tool:${tool}`, present });
  }
  for (const file of scope.files) checks.push({ prerequisite: `file:${file}`, present: typeof values[file] === 'string' && regular(values[file]) });
  const prerequisitesPresent = checks.every(check => check.present);
  return { scope: values.scope, checks, prerequisitesPresent, operatorAuthorized: values.authorized === true,
    status: !prerequisitesPresent ? 'unavailable' : values.authorized === true ? 'prerequisites-present' : 'authorization-required',
    nativeRuntimeAcceptance: false, probesExecuted: false,
    remainingGates: ['target ownership and current identity', 'positive idle/stop boundary', 'platform admission and permissions', 'operator-selected native test execution'] };
}

export function main(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: Object.fromEntries([
      ...['scope', 'config', 'bundle', 'helper', 'kernel', 'initrd', 'rootfs'].map(name => [name, { type: 'string' }]),
      ['authorized', { type: 'boolean' }],
    ]) });
    const result = checkAcceptance(values);
    console.log(JSON.stringify(result));
    return result.status === 'prerequisites-present' ? 0 : 2;
  } catch {
    console.error('Acceptance preflight requires --scope linux-guest|macos-helper|windows-helper|android|inference|libvirt|kubevirt and explicit prerequisite file paths. Paths and file contents are withheld. --authorized records existing operator authorization; it does not run a test.');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
