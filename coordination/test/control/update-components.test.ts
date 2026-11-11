import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { componentFileSetDigest, parseComponentReport, parseComponentTarget } from '../../src/updates/components.ts';
import { fixture } from './update-manager-fixtures.test.ts';

test('component digest covers complete signed subset and canonicalizes only file order', t => {
  const f = fixture(); t.after(f.cleanup);
  const manifest = f.release(1, 'host', { 'guest/a': 'a', 'guest/b': 'b' }).envelope.manifest;
  const digest = componentFileSetDigest(manifest, 'guest');
  assert.equal(componentFileSetDigest({ ...manifest, files: [...manifest.files].reverse() }, 'guest'), digest);
  for (const patch of [{ executable: true }, { bytes: 100 }, { sha256: 'b'.repeat(64) }, { path: 'guest/c' }]) {
    assert.notEqual(componentFileSetDigest({ ...manifest, files: manifest.files.map(f => f.path === 'guest/a' ? { ...f, ...patch } : f) }, 'guest'), digest);
  }
  assert.notEqual(componentFileSetDigest({ ...manifest, files: manifest.files.filter(f => f.path !== 'guest/b') }, 'guest'), digest);
  assert.throws(() => componentFileSetDigest(manifest, 'native-helper'));
});

test('strict target and receipt validators reject readiness flags, unknown keys and missing binding', () => {
  const target = { component: 'guest', machineId: randomUUID(), assignmentId: randomUUID(), bootId: randomUUID(), generation: 1 };
  const report = { jobId: randomUUID(), attemptId: randomUUID(), installationId: randomUUID(), releaseId: randomUUID(), fileSetDigest: 'a'.repeat(64), target, sequence: 1, state: 'intent', evidence: null };
  assert.deepEqual(parseComponentReport(report), report);
  for (const patch of [{ bootId: '' }, { generation: 0 }, { ready: true }, { machineId: 'foreign' }]) assert.throws(() => parseComponentTarget({ ...target, ...patch }));
  for (const patch of [{ state: 'ready' }, { sequence: 0 }, { evidence: { boundary: 'idle-closed', acknowledgement: 'a'.repeat(64) } }, { state: 'adopted' }, { ready: true }]) assert.throws(() => parseComponentReport({ ...report, ...patch }));
  assert.throws(() => parseComponentTarget({ component: 'native-helper', helperId: 'helper', executable: '../helper', instanceId: 'process', generation: 1 }));
});
