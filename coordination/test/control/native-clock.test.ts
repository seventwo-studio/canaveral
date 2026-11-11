import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { nativeExecutionClock } from '../../src/native-clock.ts';
import { ServiceError } from '../../src/errors.ts';

function fixture(t: TestContext, value = '10') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canaveral-clock-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, 'clock-helper'), sample = join(root, 'sample'), calls = join(root, 'calls');
  writeFileSync(sample, value);
  writeFileSync(helper, `#!${process.execPath}\nimport fs from 'node:fs';
if(process.argv.length!==3||process.argv[2]!=='clock'||process.env.CANAVERAL_CLOCK_SENTINEL)process.exit(9);
fs.appendFileSync(${JSON.stringify(calls)},'sample\\n');
const value=fs.readFileSync(${JSON.stringify(sample)},'utf8');
if(value==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}else process.stdout.write(value);
`, { mode: 0o700 });
  return { root, helper, sample, calls };
}
const unix = process.platform === 'linux' || process.platform === 'darwin';
const unavailable = (error: unknown) => error instanceof ServiceError && error.status === 503 && error.outcome === 'unknown';

test('native clock is explicit, boot-bound, observes suspended time and clears inherited environment', { skip: !unix }, t => {
  const f = fixture(t);
  assert.equal(existsSync(f.calls), false);
  const saved = process.env.CANAVERAL_CLOCK_SENTINEL;
  process.env.CANAVERAL_CLOCK_SENTINEL = 'not-forwarded';
  try {
    const clock = nativeExecutionClock(f.helper);
    assert.equal(clock.suspendAware, true);
    assert.match(clock.bootId!, /^[a-f0-9-]{36}$/);
    writeFileSync(f.sample, '1000.25');
    assert.equal(clock.now(), 1000.25);
    assert.ok(Math.abs(clock.wall() - Date.now() / 1000) < 1);
    assert.equal(readFileSync(f.calls, 'utf8'), 'sample\nsample\n');
  } finally {
    if (saved === undefined) delete process.env.CANAVERAL_CLOCK_SENTINEL; else process.env.CANAVERAL_CLOCK_SENTINEL = saved;
  }
});

test('backwards or changed native clock cannot recover by returning a later sample', { skip: !unix }, t => {
  const f = fixture(t), clock = nativeExecutionClock(f.helper);
  writeFileSync(f.sample, '9'); assert.throws(() => clock.now(), unavailable);
  const before = readFileSync(f.calls);
  writeFileSync(f.sample, '100'); assert.throws(() => clock.now(), unavailable);
  assert.deepEqual(readFileSync(f.calls), before);
  const second = fixture(t), other = nativeExecutionClock(second.helper);
  chmodSync(second.helper, 0o777); assert.throws(() => other.now(), unavailable);
  chmodSync(second.helper, 0o700); assert.throws(() => other.now(), unavailable);
});

test('native clock refuses malformed output, missing helpers and linked or writable executables', { skip: !unix }, t => {
  for (const value of ['', 'NaN', 'Infinity', '-1', '0x10', '1\n2']) assert.throws(() => nativeExecutionClock(fixture(t, value).helper), unavailable);
  const f = fixture(t), alias = join(f.root, 'alias');
  assert.throws(() => nativeExecutionClock('relative-helper'));
  assert.throws(() => nativeExecutionClock(join(f.root, 'missing')), unavailable);
  symlinkSync(f.helper, alias); assert.throws(() => nativeExecutionClock(alias), unavailable); rmSync(alias);
  linkSync(f.helper, alias); assert.throws(() => nativeExecutionClock(f.helper), unavailable); rmSync(alias);
  chmodSync(f.helper, 0o777); assert.throws(() => nativeExecutionClock(f.helper), unavailable);
});

test('a stalled clock helper cannot ignore its bounded termination', { skip: !unix, timeout: 8000 }, t => {
  const f = fixture(t, 'hang');
  assert.throws(() => nativeExecutionClock(f.helper), unavailable);
  assert.equal(readFileSync(f.calls, 'utf8'), 'sample\n');
});
