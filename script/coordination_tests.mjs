#!/usr/bin/env node
/** Runs the coordination tests (`npm test` in coordination/, after `npm run build`).
 *
 * Most test files run in parallel. Suites that assert wall-clock budgets run afterwards, one file
 * at a time, so the rest of the suite does not compete with them for CPU. The budgets they check
 * (a tunnel or live view ending within a second, a recording's duration and exit grace, a request
 * returning promptly) hold under normal load. They are not hard real-time: a starved event loop
 * can miss them. Extra arguments, such as `--test-name-pattern`, are passed to both runs. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'coordination');
export const TIMED = ['lease-tunnels', 'mobile-live-leases', 'mobile-live', 'requests-visibility', 'android-warm-pool'].map(name => `dist/test/control/${name}.test.js`);

const files = ['dist/test', 'dist/test/control'].flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith('.test.js')).map(name => `${dir}/${name}`)).sort();
for (const file of TIMED) if (!existsSync(join(root, file))) { console.error(`Serialized test file ${file} is missing; build first or update script/coordination_tests.mjs.`); process.exit(2); }
const extra = process.argv.slice(2);
const run = args => spawnSync(process.execPath, ['--test', '--test-force-exit', ...extra, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;

const parallel = run(files.filter(file => !TIMED.includes(file)));
const serial = run(['--test-concurrency=1', ...TIMED]);
process.exit(parallel || serial);
