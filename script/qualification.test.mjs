import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BACKENDS, buildRecords, canonical, check, checkPromotions, checkRecords, fetchEvidence, generated, loadTree, packageDigest,
  parseContainerdPins, PATHS, pinId, promotableRun, recordEntry, recordPath, REPOSITORY, ROOT, schemaErrors, treeIdentity,
  verifyRecord, verifyRun,
} from './qualification.mjs';

const tree = loadTree();
const schema = name => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
const recordSchema = schema(PATHS.recordSchema);
const promotionsSchema = schema(PATHS.promotionsSchema);
const SHA = 'c'.repeat(40);
const repo = { full_name: REPOSITORY };

function run(path, overrides = {}) {
  return {
    id: 1, name: 'suite', path, event: 'push', status: 'completed', run_attempt: 1, head_sha: SHA, head_branch: 'main',
    html_url: `https://github.com/${REPOSITORY}/actions/runs/1`, run_started_at: '2026-11-23T00:00:00Z',
    repository: repo, head_repository: repo, ...overrides,
  };
}
const job = (name, label, conclusion = 'success') => ({
  id: 2, name, labels: [label], conclusion, run_attempt: 1, html_url: `https://github.com/${REPOSITORY}/actions/runs/1/job/2`,
});
const artifact = (name, evidence) => ({ id: 3, name, digest: `sha256:${'d'.repeat(64)}`, evidenceSha256: 'e'.repeat(64), evidence });

function modelEvidence(overrides = {}) {
  const pin = tree.catalog.pins.find(p => p.backend === 'llama.cpp' && p.os === 'linux' && p.arch === 'x86_64');
  return {
    commit: SHA, runnerImage: { os: 'ubuntu24', version: '20261116.376.1' }, os: 'linux', arch: 'x86_64', backend: 'llama.cpp',
    acceleration: 'cpu',
    engine: { version: pin.version, archiveSha256: pin.sha256, treeSha256: pin.treeSha256, packageDigest: packageDigest('llama.cpp', pin.version, pin.treeSha256) },
    model: { name: tree.model.model, revision: tree.model.revision, sha256: tree.model.sha256 },
    steps: ['verify GGUF', 'install package', 'verify installed package', 'generate through public API', 'check runtime cleanup', 'remove package']
      .map(name => ({ name, outcome: 'passed', durationMs: 1 })),
    workflow: { acceptance: 'success' },
    ...overrides,
  };
}
const daemonEvidence = {
  commit: SHA, image: { os: 'ubuntu24', version: '1' }, platform: 'linux', arch: 'x64', node: 'v24.11.0', backend: 'native',
  mode: 'service', manager: 'systemd', account: 'dedicated system account', steps: [{ name: 'start', outcome: 'passed', milliseconds: 5 }],
};

function modelRecords(evidence = modelEvidence(), conclusion = 'success') {
  return buildRecords({
    run: run('.github/workflows/model-acceptance.yaml'),
    jobs: [job('ubuntu-24.04 / llama.cpp', 'ubuntu-24.04', conclusion)],
    artifacts: [artifact('model-acceptance-ubuntu-24.04-llama.cpp', evidence)], tree,
  });
}
const serviceRecord = () => buildRecords({
  run: run('.github/workflows/daemon-acceptance.yaml'), jobs: [job('service (ubuntu-24.04)', 'ubuntu-24.04')],
  artifacts: [artifact('canaverald-ubuntu-24.04', daemonEvidence)], tree,
}).records[0];

test('reads the exact containerd and model engine pins from the tree', () => {
  const pins = parseContainerdPins(readFileSync(join(ROOT, PATHS.containerdPins), 'utf8'));
  assert.equal(PATHS.containerdPins, 'crates/host-installer/src/pins.json');
  assert.deepEqual(pins.x86_64.map(a => a.name), ['containerd', 'runc']);
  assert.match(pins.aarch64[0].url, /containerd-static-.*-linux-arm64\.tar\.gz$/);
  assert.ok(pins.x86_64.every(a => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0));
  assert.throws(() => parseContainerdPins('{"x86_64":[],"aarch64":[]}'), /needs containerd and runc pins/);
  // Matches the package digest the Rust executor reported in run 45231181336.
  assert.equal(packageDigest('ollama', '0.40.17', '2f2f45e48cf038c5fbb942d80f441d26bfa81105922bab797385b17c633049f6'),
    '1dd5a215eac3b9d83b61400b4d64b8b1df95450cf6c090f3645ff684a3f3a9ef');
  assert.equal(treeIdentity(tree, 'libvirt', 'linux', 'x86_64'), undefined);
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test('refuses untrusted runs and limits promotion to first attempts of main', () => {
  const path = '.github/workflows/model-acceptance.yaml';
  assert.deepEqual(verifyRun(run(path)), []);
  assert.match(verifyRun(run(path, { event: 'pull_request' })).join(), /not trusted/);
  assert.match(verifyRun(run(path, { head_repository: { full_name: 'fork/canaveral' } })).join(), /head comes from/);
  assert.match(verifyRun(run(path, { status: 'in_progress' })).join(), /status/);
  assert.match(verifyRun(run('.github/workflows/validate.yaml')).join(), /not an acceptance suite/);
  assert.match(verifyRun(run(path, { run_attempt: 2 })).join(), /cannot be bound to its artifacts/);
  assert.deepEqual(promotableRun(run(path), 'behind'), []);
  assert.deepEqual(promotableRun(run(path), 'identical'), []);
  assert.match(promotableRun(run(path), 'ahead').join(), /not reachable from main/);
  assert.match(promotableRun(run(path, { head_branch: 'feature' }), 'behind').join(), /not main/);
  assert.match(promotableRun(run(path, { event: 'pull_request' }), 'behind').join(), /not trusted/);
});

test('requires the artifact digest GitHub reports', () => {
  assert.throws(() => fetchEvidence({ download: () => assert.fail('downloaded') }, [{ id: 1, name: 'a' }], ROOT), /no artifact digest/);
  assert.throws(() => fetchEvidence({}, [{ id: 1, name: 'a', expired: true }], ROOT), /expired/);
});

test('backends can only record evidence from their own acceptance suite', () => {
  const { problems } = buildRecords({
    run: run('.github/workflows/host-acceptance.yaml'), jobs: [job('ubuntu-24.04 / llama.cpp', 'ubuntu-24.04')],
    artifacts: [artifact('model-acceptance-ubuntu-24.04-llama.cpp', modelEvidence())], tree,
  });
  assert.match(problems.join(), /unrecognized artifact/);
  for (const [backend, rule] of Object.entries(BACKENDS)) assert.match(rule.suite, /acceptance\.yaml$/, backend);
});

test('turns matching model evidence into a passed record at its keyed path', () => {
  const { records, problems } = modelRecords();
  assert.deepEqual(problems, []);
  const [{ path, record }] = records;
  assert.deepEqual(schemaErrors(recordSchema, record), []);
  assert.equal(record.outcome, 'passed');
  assert.equal(record.pinId, pinId(record.identity));
  assert.deepEqual(record.identity, treeIdentity(tree, 'llama.cpp', 'linux', 'x86_64'));
  assert.equal(path, `llama.cpp/${record.pinId}/linux-x86_64-cpu.json`);
  assert.equal(recordPath(record), path);
  assert.equal(record.source.commit, SHA);
  assert.equal(record.source.ref, 'refs/heads/main');
  assert.match(record.pinId, /-[0-9a-f]{24}$/);
  assert.equal(record.runner.imageVersion, '20261116.376.1');
});

test('refuses evidence that does not match the run commit or the tree pins', () => {
  const engine = { ...modelEvidence().engine, archiveSha256: '0'.repeat(64) };
  assert.match(modelRecords(modelEvidence({ engine })).problems.join(), /does not match .*runtime-pins\.json/);
  assert.match(modelRecords(modelEvidence({ commit: 'f'.repeat(40) })).problems.join(), /differs from run commit/);
  assert.match(modelRecords(modelEvidence({ model: { ...modelEvidence().model, sha256: '0'.repeat(64) } })).problems.join(), /real-model\.json/);
  assert.match(modelRecords(modelEvidence({ runnerImage: {} })).problems.join(), /runner image/);
  const failed = modelRecords(modelEvidence(), 'failure').records[0].record;
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.blockers[0].code, 'acceptance_failed');
});

test('promotions need exact tree pins, passing records, service evidence and review', () => {
  const built = modelRecords().records[0];
  const runtime = recordEntry(built.path, built.record);
  const service = recordEntry(serviceRecord().path, serviceRecord().record);
  const entries = [runtime, service];
  const cite = entry => ({ path: entry.path, sha256: entry.sha256 });
  assert.deepEqual(checkRecords(entries, tree, recordSchema), { errors: [], stale: [] });
  const empty = { schema: 'canaveral-runtime-promotions', version: 1, promotions: [] };
  assert.deepEqual(checkPromotions(empty, entries, tree, promotionsSchema), []);
  const entry = {
    backend: 'llama.cpp', pinId: runtime.record.pinId, identity: runtime.record.identity, scope: runtime.record.scope,
    records: [cite(runtime)], supporting: [cite(service)],
    review: { pullRequest: `https://github.com/${REPOSITORY}/pull/1`, reviewer: 'maintainer', date: '2026-11-24' },
    limitations: ['CPU only.'],
  };
  const promotions = list => ({ ...empty, promotions: list });
  assert.deepEqual(checkPromotions(promotions([entry]), entries, tree, promotionsSchema), []);
  const errors = list => checkPromotions(promotions(list), entries, tree, promotionsSchema).join('\n');
  assert.match(errors([entry, entry]), /duplicate scope/);
  assert.match(errors([{ ...entry, backend: 'ollama' }]), /ollama_host_isolation_missing/);
  assert.match(errors([{ ...entry, supporting: [{ ...cite(service), path: 'canaverald/service/macos-aarch64-launchd.json' }] }]), /does not exist/);
  assert.match(errors([{ ...entry, records: [cite(service)] }]), /not a passing runtime record/);
  assert.match(errors([{ ...entry, records: [{ ...cite(runtime), sha256: '0'.repeat(64) }] }]), /changed since promotion/);
  assert.match(errors([{ ...entry, backend: 'libvirt' }]), /vm_components_unbound/);
  assert.match(errors([{ ...entry, backend: 'apple-virtualization' }]), /vm_components_unbound/);
  assert.match(errors([{ ...entry, scope: { ...entry.scope, executionMode: 'detect-only' } }]), /promotes only cpu-generation/);
  const drifted = { ...entry.identity, treeSha256: '0'.repeat(64) };
  assert.match(errors([{ ...entry, identity: drifted, pinId: pinId(drifted) }]), /not the exact pin the tree ships/);
  assert.match(errors([{ ...entry, review: { ...entry.review, pullRequest: 'https://example.com/pull/1' } }]), /pullRequest/);
  assert.match(errors([{ ...entry, limitations: [] }]), /limitations/);
  // Relabelled records keep a bound digest only if the promotion is re-reviewed; offline rules still apply.
  const relabel = (base, source) => recordEntry(base.path, { ...base.record, source: { ...base.record.source, ...source } });
  const promoteWith = (r, sv = service) => checkPromotions(promotions([{ ...entry, records: [cite(r)], supporting: [cite(sv)] }]), [r, sv], tree, promotionsSchema).join();
  assert.match(promoteWith(relabel(runtime, { ref: 'refs/heads/feat/runtime-acceptance' })), /not refs\/heads\/main/);
  assert.match(promoteWith(runtime, relabel(service, { ref: 'refs/heads/feature' })), /supporting record .* not refs\/heads\/main/);
  assert.match(promoteWith(relabel(runtime, { runAttempt: 2 })), /run attempt 2/);
  assert.match(promoteWith(relabel(runtime, { workflow: '.github/workflows/host-acceptance.yaml' })), /does not come from the llama.cpp suite/);
  const failing = recordEntry(runtime.path, { ...runtime.record, outcome: 'failed', blockers: [{ code: 'acceptance_failed', detail: 'x' }] });
  assert.match(promoteWith(failing), /not a passing runtime record/);

  const table = generated(promotions([entry]));
  assert.match(table[PATHS.tsTable], /"backend": "llama\.cpp"/);
  assert.deepEqual(JSON.parse(table[PATHS.rustTable]).pins[0], { backend: 'llama.cpp', ...entry.scope, pinId: entry.pinId, identity: entry.identity });
});

test('record checks catch misplaced, inconsistent and stale records', () => {
  const { path, record } = modelRecords().records[0];
  const moved = checkRecords([{ path: `x/${path}`, record }], tree, recordSchema).errors.join();
  assert.match(moved, /content belongs at/);
  const blocked = { ...record, outcome: 'blocked' };
  assert.match(checkRecords([{ path, record: blocked }], tree, recordSchema).errors.join(), /needs a blocker/);
  const identity = { ...record.identity, version: '0.0.1' };
  const old = { ...record, identity, pinId: pinId(identity) };
  assert.deepEqual(checkRecords([{ path: recordPath(old), record: old }], tree, recordSchema).stale, [`records/${recordPath(old)}`]);
  assert.deepEqual(schemaErrors(recordSchema, { ...record, extra: true }), ['$: unexpected extra']);
  const wrongSuite = { ...record, source: { ...record.source, workflow: '.github/workflows/daemon-acceptance.yaml' } };
  assert.match(checkRecords([{ path, record: wrongSuite }], tree, recordSchema).errors.join(), /must come from/);
});

test('every unpromotable backend carries an explicit blocker', () => {
  for (const id of ['ollama', 'vllm', 'mlx-lm', 'libvirt', 'apple-virtualization']) assert.ok(BACKENDS[id].blocker?.code);
  assert.equal(BACKENDS.ollama.blocker.code, 'ollama_host_isolation_missing');
});

test('the committed records, promotions and generated tables are consistent', () => {
  const result = check(ROOT);
  assert.deepEqual(result.errors, []);
});

test('verify re-derives promoted records from the GitHub API', () => {
  const { record } = modelRecords().records[0];
  const evidence = modelEvidence();
  const client = (overrides = {}) => ({
    run: () => run('.github/workflows/model-acceptance.yaml'),
    compare: () => 'behind',
    artifact: () => ({ id: 3, name: 'model-acceptance-ubuntu-24.04-llama.cpp', digest: 'sha256:' + 'd'.repeat(64), workflow_run: { id: 1, head_sha: SHA } }),
    jobs: () => [job('ubuntu-24.04 / llama.cpp', 'ubuntu-24.04')],
    ...overrides,
  });
  // fetchEvidence is exercised separately; substitute its result through a fake download path.
  const derive = (c, committed = record) => {
    const fake = { ...c, download: () => { throw new Error('unused'); } };
    try { return verifyRecord(committed, fake, tree, ROOT); }
    catch (error) { return [error.message]; }
  };
  assert.match(derive(client({ compare: () => 'ahead' })).join(), /not reachable from main/);
  assert.match(derive(client({ run: () => run('.github/workflows/model-acceptance.yaml', { head_branch: 'feature' }) })).join(), /not main/);
  assert.match(derive(client({ artifact: () => ({ workflow_run: { id: 9, head_sha: SHA } }) })).join(), /does not belong to the run/);
  assert.match(derive(client({ run: () => run('.github/workflows/host-acceptance.yaml') })).join(), /not the llama.cpp suite/);
  assert.match(derive(client(), { ...record, source: { ...record.source, commit: 'f'.repeat(40) } }).join(), /commit or attempt differs/);
  assert.ok(evidence);
});

test('packaging checks gate on the qualification state', async () => {
  const { checkQualification } = await import('./package_checks.mjs');
  assert.equal(await checkQualification(), true);
});
