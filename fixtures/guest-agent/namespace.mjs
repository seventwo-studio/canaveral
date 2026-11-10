#!/usr/bin/env node
/** Explicit Linux namespace gate. No host fallback, Python process, sudo, or policy relaxation. */
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.platform !== 'linux' || process.env.CANAVERAL_NAMESPACE_FIXTURE !== '1') {
  console.error('GATED: Linux and CANAVERAL_NAMESPACE_FIXTURE=1 required');
  process.exit(1);
}
if (process.argv.length > 3) throw new Error('Expected at most one namespace helper path');
const fds = [];
try {
  for (const name of ['pid', 'mnt', 'net']) fds.push(openSync('/proc/self/ns/' + name, 'r'));
  // Node maps these descriptors to 3..5 in the child without assuming its own open FD numbers.
  const child = spawn('unshare', ['--user', '--map-auto', '--map-root-user', '--pid', '--fork',
    '--mount', '--net', '--mount-proc', '--kill-child',
    process.argv[2] ?? 'target/debug/examples/namespace-supervision'],
    { stdio: ['inherit', 'inherit', 'inherit', ...fds] });
  child.on('error', error => { console.error('Namespace gate failed: ' + error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
} finally { for (const fd of fds) closeSync(fd); }
