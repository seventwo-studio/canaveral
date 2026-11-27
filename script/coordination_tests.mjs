#!/usr/bin/env node
/** Runs the coordination tests (`npm test` in coordination/, after `npm run build`).
 *
 * Two groups partition the test files, and the runner checks that each file falls in exactly one:
 * - `parallel`: most files, run in parallel.
 * - `timed`: suites that assert wall-clock budgets, run one file at a time so the rest of the
 *   suite does not compete with them for CPU. The budgets they check (a tunnel or live view
 *   ending within a second, a recording's duration and exit grace, a request returning promptly)
 *   hold under normal load. They are not hard real-time: a starved event loop can miss them.
 *
 * `--group=parallel` or `--group=timed` runs one group (CI runs them as separate jobs); the
 * default, `--group=all`, runs both, the timed group last. The exit status is non-zero when any
 * run fails. Other arguments, such as `--test-name-pattern`, are passed to each run. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'coordination');
export const TIMED = ['lease-tunnels', 'mobile-live-leases', 'mobile-live', 'mobile-live-android', 'mobile-live-owned',
  'requests-visibility', 'android-warm-pool'].map(name => `dist/test/control/${name}.test.js`);
const fail = message => { console.error(message); process.exit(2); };

const args = process.argv.slice(2), choice = args.find(arg => arg.startsWith('--group='))?.slice('--group='.length) ?? 'all';
if (!['all', 'parallel', 'timed'].includes(choice)) fail(`Unknown test group ${choice}; choose all, parallel or timed.`);
const extra = args.filter(arg => !arg.startsWith('--group='));

const files = ['dist/test', 'dist/test/control'].flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith('.test.js')).map(name => `${dir}/${name}`)).sort();
for (const file of TIMED) if (!existsSync(join(root, file))) fail(`Timed test file ${file} is missing; build first or update script/coordination_tests.mjs.`);
const groups = { parallel: files.filter(file => !TIMED.includes(file)), timed: TIMED };
// Every test file runs exactly once across the groups, whichever CI job runs which group.
const assigned = [...groups.parallel, ...groups.timed];
if (assigned.length !== new Set(assigned).size || assigned.length !== files.length || files.some(file => !assigned.includes(file))) fail('The test groups do not partition the test files.');

const run = (group, concurrency) => {
  console.log(`# coordination tests: ${group} group, ${groups[group].length} files`);
  return spawnSync(process.execPath, ['--test', '--test-force-exit', ...concurrency, ...extra, ...groups[group]], { cwd: root, stdio: 'inherit' }).status ?? 1;
};
const statuses = [];
if (choice !== 'timed') statuses.push(run('parallel', []));
if (choice !== 'parallel') statuses.push(run('timed', ['--test-concurrency=1']));
process.exit(statuses.find(status => status !== 0) ?? 0);
