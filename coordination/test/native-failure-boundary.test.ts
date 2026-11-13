import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const harness = 'coordination/native-acceptance/run.ts';
const current = readFileSync(join(root, harness), 'utf8');
// Optional counterfactual run; ordinary/shallow checkouts need no historical Git objects.
const baseline = process.env.CANAVERAL_FAILURE_BASELINE;
const previous = baseline ? execFileSync('git', ['show', baseline + ':' + harness], {cwd:root, encoding:'utf8'}) : undefined;
const token = 'SYNTHETIC_PRIVATE_PATH_6291';
const fixed = 'native acceptance failed: internal error (details withheld)';
function section(source: string, start: string, end: string) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function run(source: string, scenario: string, mode = 'strict') {
  const dir = mkdtempSync(join(tmpdir(), 'native-boundary-'));
  try {
    const modern = source === current;
    const prelude = `import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync as rawWriteFileSync, mkdirSync, rmSync, chmodSync} from 'node:fs';
import {join} from 'node:path';
${modern ? `import {internalFailure,guardEvidenceWrite} from ${JSON.stringify(join(root,'coordination/native-acceptance/failure-boundary.ts'))};
const writeFileSync: typeof rawWriteFileSync = (...args) => guardEvidenceWrite(() => rawWriteFileSync(...args));` : 'const writeFileSync = rawWriteFileSync;'}
const privateDir = ${JSON.stringify(join(dir,token,'private'))};
const dir = ${JSON.stringify(join(dir,token))};
const receiptEvidence = (v: unknown) => v;
const children: any[] = [];
let active: any;
${section(source, 'const save = ', 'const sha = ')}
${section(source, 'function launch(', '\ntry {\n  const signature')}
`;
    // Select the outer reporting boundary rather than an inner case catch.
    const outer = source.slice(source.lastIndexOf('\n} catch', source.indexOf('\nfinally {')) + 1, source.indexOf('\nfinally {'));
    const storageSetup = scenario.startsWith('report') ? `mkdirSync(privateDir, {recursive:true}); ${scenario === 'report removed' ? 'rmSync(dir,{recursive:true});' : 'chmodSync(privateDir,0o500); chmodSync(dir,0o500);'}` : '';
    const body = scenario === 'spawn'
      ? `launch('/nonexistent/${token}/satellite', [], 'satellite'); await new Promise(r => setTimeout(r, 50));`
      : scenario.startsWith('report')
      ? `try { throw new Error('${token}'); ${outer}`
      : scenario === 'write'
      ? `writeFileSync(join(privateDir,'evidence.json'), 'data');`
      : scenario === 'warning'
      ? `process.emitWarning('${token}'); await new Promise(r => setTimeout(r, 50));`
      : `function deepCase() { setImmediate(() => { throw new Error('${token}'); }); } deepCase(); await new Promise(r => setTimeout(r,50));`;
    const script = join(dir,'case.ts'); writeFileSync(script, prelude + storageSetup + body);
    return spawnSync(process.execPath, ['--unhandled-rejections='+mode, script], {encoding:'utf8'});
  } finally {
    for (const path of [join(dir,token), join(dir,token,'private')]) if (existsSync(path)) chmodSync(path,0o700);
    rmSync(dir,{recursive:true,force:true});
  }
}
for (const scenario of ['spawn','report removed','report unwritable','write','deep case','warning']) {
  for (const mode of ['strict','throw','warn']) test(`native failure boundary: ${scenario} (${mode})${previous ? '; previous revision leaks' : ''}`, () => {
    if (previous) {
      const before = run(previous,scenario,mode);
      assert.ok(!before.stderr.includes('SyntaxError'), before.stderr);
      assert.match(before.stdout + before.stderr, new RegExp(token), 'counterfactual must expose the synthetic secret');
    }
    const after = run(current,scenario,mode);
    assert.notEqual(after.status,0);
    assert.equal(after.stdout,'');
    assert.ok(after.stderr.trim().split('\n').every(line => line === fixed), after.stderr);
    assert.ok(after.stderr.includes(fixed));
  });
}
