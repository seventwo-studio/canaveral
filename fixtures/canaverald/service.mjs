import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, cp, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cleanNodeEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
delete cleanNodeEnv.CANAVERAL_ENROLLMENT_TOKEN_FILE;

async function invoke(command, args, options = {}) {
  try {
    return (await exec(command, args, { timeout: 30_000, env: cleanNodeEnv, ...options })).stdout;
  } catch (error) {
    // Keep subprocess output out of CI logs and evidence.
    throw new Error(`${command} ${args[0] ?? ''} failed (${error.code ?? error.signal ?? 'unknown'})`);
  }
}

export async function eventually(description, check) {
  const deadline = performance.now() + 20_000;
  do {
    const result = await check();
    if (result) return result;
    await delay(250);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

export function foreground({ node, entry, configArgs, enrollmentFile, url }) {
  let child, exited;
  return {
    manager: 'foreground',
    account: 'invoking user',
    async start(enroll) {
      child = spawn(node, [entry, ...configArgs], {
        env: {
          ...cleanNodeEnv, CANAVERAL_URL: url,
          ...(enroll ? { CANAVERAL_ENROLLMENT_TOKEN_FILE: enrollmentFile } : {}),
        },
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      exited = once(child, 'exit');
    },
    async stop() {
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [0, null], 'foreground daemon exit');
    },
    async pid() { return child.pid; },
    run(args) { return invoke(node, args); },
    async cleanup() {
      if (child?.kill('SIGKILL')) await exited;
    },
  };
}

export async function nativeService(paths) {
  const { root, host, node, entry, enrollmentFile, url, configArgs, coordination, repo } = paths;
  const linux = process.platform === 'linux';
  const user = linux ? 'canaveral-ci' : (await invoke('id', ['-un'])).trim();
  assert.match(user, /^[a-z_][a-z0-9_-]*$/i);
  const sudo = (...args) => invoke('sudo', ['-n', ...args]);
  const ctl = (...args) => sudo(linux ? 'systemctl' : 'launchctl', ...args);
  const name = linux ? 'canaverald.service' : 'com.canaveral.canaverald.plist';
  const destination = linux ? `/etc/systemd/system/${name}` : `/Library/LaunchDaemons/${name}`;
  const target = linux ? name : 'system/com.canaveral.canaverald';
  const template = await readFile(join(repo, 'deploy', linux ? 'systemd' : 'launchd', name), 'utf8');
  const staged = join(root, name);
  const program = join(root, 'coordination');
  let createdUser = false, installed = false, loaded = false;
  let uid = process.getuid();

  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  async function writeDefinition(enroll) {
    // Linux fixture paths contain no unit metacharacters. Keep this assertion
    // before substituting into the sample unit's unquoted fields.
    const substitutions = {
      [linux ? '/usr/bin/node' : '/usr/local/bin/node']: node,
      '/opt/canaveral/coordination/dist/src/canaverald.js': entry,
      '/opt/canaveral': root,
      '/etc/canaveral/host.json': configArgs[1],
      '/var/lib/canaveral/agent': configArgs[3],
      'https://canaveral.example.internal': url,
      '/etc/canaveral/enrollment.token': enrollmentFile,
    };
    let definition = template;
    for (const [from, to] of Object.entries(substitutions)) {
      assert.ok(definition.includes(from), 'sample service placeholder');
      if (linux) assert.match(to, /^[a-zA-Z0-9_./:-]+$/);
      definition = definition.replaceAll(from, linux ? to : xml(to));
    }
    if (linux) {
      definition = definition.replace('Type=simple\n', `Type=simple\nUser=${user}\nEnvironment="NODE_OPTIONS=" "NODE_PATH="\n`)
        .replace(/\nRestart=.*\nRestartSec=.*\n/, '\nRestart=no\n');
      if (!enroll) definition = definition.replace(/\nEnvironment=CANAVERAL_ENROLLMENT_TOKEN_FILE=.*\n/, '\n');
    } else {
      definition = definition.replace('<string>canaveral</string>', `<string>${user}</string>`);
      if (!enroll) definition = definition.replace(/    <key>CANAVERAL_ENROLLMENT_TOKEN_FILE<\/key>\n    <string>[^\n]+<\/string>\n/, '');
    }
    await writeFile(staged, definition, { mode: 0o600 });
    if (!linux) await invoke('plutil', ['-lint', staged]);
    await sudo('install', '-m', '0644', '-o', 'root', '-g', linux ? 'root' : 'wheel', staged, destination);
    installed = true;
  }

  async function show() {
    if (!linux) return ctl('print', target);
    return ctl('show', target, '--property=MainPID,ActiveState,Result,ExecMainCode,ExecMainStatus');
  }

  async function stop() {
    if (linux) {
      await ctl('stop', target);
      const status = await show();
      assert.match(status, /^ActiveState=inactive$/m);
      assert.match(status, /^Result=success$/m);
      assert.match(status, /^ExecMainCode=1$/m, 'systemd must report normal exit');
      assert.match(status, /^ExecMainStatus=0$/m);
    } else {
      await ctl('kill', 'SIGTERM', target);
      await eventually('a normal launchd exit', async () => {
        const status = await show();
        return /\bstate = (?:not running|exited)\b/.test(status) && /\blast exit code = 0\b/.test(status);
      });
    }
  }

  async function removeDefinition() {
    if (linux && installed) await ctl('stop', target);
    if (!linux && loaded) {
      await ctl('bootout', target);
      loaded = false;
    }
    if (installed) {
      await sudo('rm', '-f', destination);
      installed = false;
      if (linux) await ctl('daemon-reload');
    }
  }

  return {
    manager: linux ? 'systemd' : 'launchd',
    account: linux ? 'dedicated system account' : 'hosted runner account',
    async install() {
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      if (!linux) await assert.rejects(ctl('print', target), /failed \(113\)/);
      await chmod(root, 0o755);
      await cp(join(coordination, 'dist', 'src'), join(program, 'dist', 'src'), { recursive: true });
      await cp(join(coordination, 'package.json'), join(program, 'package.json'));
      await cp(join(coordination, 'node_modules'), join(program, 'node_modules'), { recursive: true });
      await cp(process.execPath, node);
      await chmod(node, 0o755);
      if (linux) {
        await sudo('useradd', '--system', '--no-create-home', '--home-dir', host, '--shell', '/usr/sbin/nologin', user);
        createdUser = true;
        uid = Number((await invoke('id', ['-u', user])).trim());
        await sudo('chown', '-R', user, host);
      }
      await writeDefinition(true);
      if (linux) await ctl('daemon-reload');
      else {
        await ctl('bootstrap', 'system', destination);
        loaded = true;
      }
    },
    async start(enroll) {
      if (!enroll) {
        // The first instance was stopped cleanly. Reload without the
        // enrollment file so continued heartbeats prove saved authentication.
        if (!linux) {
          await ctl('bootout', target);
          loaded = false;
        }
        await writeDefinition(false);
        if (linux) await ctl('daemon-reload');
        else {
          await ctl('bootstrap', 'system', destination);
          loaded = true;
        }
      }
      if (linux) await ctl('start', target);
      else await ctl('kickstart', target);
    },
    stop,
    async pid() {
      const match = (await show()).match(linux ? /^MainPID=(\d+)$/m : /\bpid = (\d+)\b/);
      return Number(match?.[1] ?? 0);
    },
    async assertOwner(pid) {
      assert.notEqual(uid, 0);
      assert.equal(Number((await invoke('ps', ['-p', String(pid), '-o', 'uid='])).trim()), uid);
    },
    run(args) {
      return linux
        ? invoke('sudo', ['-n', '-u', user, node, ...args], { cwd: root })
        : invoke(node, args, { cwd: root });
    },
    async uninstall() {
      await removeDefinition();
      if (linux) {
        assert.equal((await ctl('list-unit-files', '--no-legend', target)).trim(), '');
        assert.equal((await ctl('list-units', '--all', '--no-legend', target)).trim(), '');
      } else {
        await assert.rejects(ctl('print', target), /failed \(113\)/);
      }
    },
    async cleanup() {
      try { await removeDefinition(); }
      finally {
        if (createdUser) {
          await sudo('chown', '-R', String(process.getuid()), host);
          await sudo('userdel', user);
        }
      }
    },
  };
}

export async function assertNoDaemon(entry, pid) {
  const processes = await invoke('ps', ['-axww', '-o', 'pid=,command=']);
  const matches = processes.trim().split('\n').filter(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && (Number(match[1]) === pid || match[2].includes(entry));
  });
  assert.equal(matches.length, 0, 'stopped daemon is absent from the process table');
}
