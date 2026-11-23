#!/usr/bin/env node
// Runtime qualification records, promotions and embedded qualified-pin tables.
// See docs/runtime-qualification.md. This tool never promotes a pin: promotion is
// a reviewed edit to qualification/promotions.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY = 'seventwo-studio/canaveral';
export const RECORD_SCHEMA = 'canaveral-runtime-qualification-record';
export const PROMOTIONS_SCHEMA = 'canaveral-runtime-promotions';
export const TABLE_SCHEMA = 'canaveral-qualified-pins';
export const PATHS = {
  records: 'qualification/records',
  promotions: 'qualification/promotions.json',
  recordSchema: 'qualification/schema/record.schema.json',
  promotionsSchema: 'qualification/schema/promotions.schema.json',
  runtimePins: 'crates/model-execution/src/runtime-pins.json',
  containerdPins: 'crates/host-installer/src/pins.json',
  realModel: 'fixtures/model-execution/real-model.json',
  rustTable: 'crates/model-execution/src/runtime-qualified.json',
  tsTable: 'coordination/src/host-runtimes/qualified-pins.ts',
};

export const WORKFLOWS = {
  '.github/workflows/model-acceptance.yaml': 'model',
  '.github/workflows/host-acceptance.yaml': 'host',
  '.github/workflows/daemon-acceptance.yaml': 'daemon',
};
// Pull request runs execute only smoke checks and may carry fork code.
export const TRUSTED_EVENTS = ['push', 'schedule', 'workflow_dispatch'];
// Branch runs may be recorded for information, but only runs of the default
// branch can support a promotion.
export const DEFAULT_BRANCH = 'main';
export const DEFAULT_REF = `refs/heads/${DEFAULT_BRANCH}`;

// Promotion rules per backend. A rule names the only execution mode and
// acceleration that can be promoted. A blocker makes the backend unpromotable.
const MODEL_SUITE = '.github/workflows/model-acceptance.yaml';
const HOST_SUITE = '.github/workflows/host-acceptance.yaml';
const DAEMON_SUITE = '.github/workflows/daemon-acceptance.yaml';
const VM_BLOCKER = {
  code: 'vm_components_unbound',
  detail: 'No workflow boots a guest, and records do not yet bind the QEMU, libvirt or Swift runner components that a boot would use.',
};
export const BACKENDS = {
  'llama.cpp': { identity: 'model', suite: MODEL_SUITE, promotable: { executionMode: 'cpu-generation', acceleration: 'cpu' } },
  ollama: {
    identity: 'model',
    suite: MODEL_SUITE,
    blocker: {
      code: 'ollama_host_isolation_missing',
      detail: 'Ollama serves an unauthenticated loopback API. Promotion requires host ingress, egress and filesystem isolation that Canaveral does not enforce yet.',
    },
  },
  vllm: { identity: 'model', suite: MODEL_SUITE, blocker: { code: 'runtime_package_unavailable', detail: 'No hermetic vLLM package is pinned.' } },
  'mlx-lm': { identity: 'model', suite: MODEL_SUITE, blocker: { code: 'runtime_package_unavailable', detail: 'No hermetic MLX-LM package is pinned.' } },
  containerd: { identity: 'containerd', suite: HOST_SUITE, promotable: { executionMode: 'root-lifecycle', acceleration: 'none' } },
  libvirt: { identity: 'detected', suite: HOST_SUITE, blocker: VM_BLOCKER },
  'apple-virtualization': { identity: 'detected', suite: HOST_SUITE, blocker: VM_BLOCKER },
  canaverald: { identity: 'service', suite: DAEMON_SUITE },
};

const OS = { linux: 'linux', Linux: 'linux', darwin: 'macos', macOS: 'macos', macos: 'macos' };
const ARCH = { x64: 'x86_64', X64: 'x86_64', x86_64: 'x86_64', arm64: 'aarch64', ARM64: 'aarch64', aarch64: 'aarch64' };
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const same = (a, b) => canonical(a) === canonical(b);
// 24 hex digits (96 bits) of the canonical identity digest.
export const pinId = identity => `${identity.version}-${sha256(canonical(identity)).slice(0, 24)}`;
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = (root, path) => readFileSync(join(root, path), 'utf8');

// ---------------------------------------------------------------------------
// Pins in the tree

export function parseContainerdPins(source) {
  const catalog = JSON.parse(source);
  const pins = { x86_64: catalog.x86_64, aarch64: catalog.aarch64 };
  for (const [arch, assets] of Object.entries(pins)) {
    if (!Array.isArray(assets) || assets.map(a => a?.name).join() !== 'containerd,runc') {
      throw new Error(`${PATHS.containerdPins}: ${arch} needs containerd and runc pins`);
    }
    pins[arch] = assets.map(({ name, version, url, bytes, sha256: digest }) => ({ name, version, url, bytes, sha256: digest }));
  }
  return pins;
}

export function loadTree(root = ROOT) {
  return {
    catalog: JSON.parse(read(root, PATHS.runtimePins)),
    model: JSON.parse(read(root, PATHS.realModel)),
    containerd: parseContainerdPins(read(root, PATHS.containerdPins)),
  };
}

export const packageDigest = (backend, version, treeSha256) => sha256(`archive-v1\n${backend}\n${version}\n${treeSha256}`);

// The exact pin the tree ships for a backend and scope, or undefined when the
// tree has none (detected backends are never pinned by the tree).
export function treeIdentity(tree, backend, os, arch) {
  const kind = BACKENDS[backend]?.identity;
  if (kind === 'model') {
    const pin = tree.catalog.pins.find(p => p.backend === backend && p.os === os && p.arch === arch);
    if (!pin) return undefined;
    return { version: pin.version, url: pin.url, sha256: pin.sha256, treeSha256: pin.treeSha256,
      packageDigest: packageDigest(backend, pin.version, pin.treeSha256) };
  }
  if (kind === 'containerd') {
    const assets = os === 'linux' ? tree.containerd[arch] : undefined;
    return assets && { version: assets[0].version, assets };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Evidence -> records

export function recordPath(record) {
  const { os, arch, acceleration } = record.scope;
  if (record.kind === 'service') return `${record.backend}/service/${os}-${arch}-${record.identity.manager}.json`;
  return `${record.backend}/${record.pinId}/${os}-${arch}-${acceleration}.json`;
}

const steps = (list, name, ms) => (Array.isArray(list) ? list : []).map(entry => ({
  name: String(entry[name]), outcome: String(entry.outcome), durationMs: Math.round(Number(ms(entry)) || 0),
}));
const allPassed = list => list.length > 0 && list.every(step => step.outcome === 'passed');
const hostedLimitation = runner =>
  `Ran on a disposable GitHub-hosted ${runner.label} runner (${runner.imageOS} ${runner.imageVersion}), not a production host.`;

function artifactTarget(suite, name) {
  let match;
  if (suite === 'model' && (match = /^model-acceptance-(.+)-(llama\.cpp|ollama)$/.exec(name))) {
    return { label: match[1], backend: match[2], job: `${match[1]} / ${match[2]}` };
  }
  if (suite === 'host' && (match = /^host-(containerd|libvirt|apple-virtualization)-(.+)$/.exec(name))) {
    const [, backend, label] = match;
    return { label, backend, job: backend === 'containerd' ? `containerd (${label})` : `virtualization (${label}, ${backend})` };
  }
  if (suite === 'daemon' && (match = /^canaverald-(.+)$/.exec(name)) && match[1] !== 'smoke') {
    return { label: match[1], backend: 'canaverald', job: `service (${match[1]})` };
  }
  return undefined;
}

function modelRecord(ev, target, tree, problems) {
  const os = OS[ev.os], arch = ARCH[ev.arch];
  const identity = treeIdentity(tree, target.backend, os, arch);
  if (ev.backend !== target.backend) problems.push(`evidence backend ${ev.backend} differs from artifact ${target.backend}`);
  if (ev.acceleration !== 'cpu') problems.push(`unexpected acceleration ${ev.acceleration}`);
  if (!identity) { problems.push(`no ${target.backend} pin in the tree for ${os}/${arch}`); return undefined; }
  const engine = ev.engine ?? {};
  if (engine.version !== identity.version || engine.archiveSha256 !== identity.sha256 || engine.treeSha256 !== identity.treeSha256
    || (engine.packageDigest !== undefined && engine.packageDigest !== identity.packageDigest)) {
    problems.push(`${target.backend} ${os}/${arch} engine evidence does not match ${PATHS.runtimePins}`);
  }
  const model = { name: tree.model.model, revision: tree.model.revision, sha256: tree.model.sha256 };
  if (!same(ev.model, model)) problems.push(`model evidence does not match ${PATHS.realModel}`);
  const list = steps(ev.steps, 'name', s => s.durationMs);
  const required = ['verify GGUF', 'install package', 'verify installed package', 'generate through public API', 'check runtime cleanup', 'remove package'];
  const generate = (ev.steps ?? []).find(s => s.name === 'generate through public API')?.result;
  const source = (ev.steps ?? []).find(s => s.name === 'verify GGUF')?.result?.source;
  const names = new Set(list.map(s => s.name));
  return {
    identity, os, arch, acceleration: 'cpu', executionMode: 'cpu-generation',
    passed: ev.workflow?.acceptance === 'success' && allPassed(list) && required.every(name => names.has(name)),
    steps: list, model,
    observations: {
      inputTokens: generate?.usage?.inputTokens ?? null,
      outputTokens: generate?.usage?.outputTokens ?? null,
      reservationHeldAfterJob: generate?.reservationHeld ?? null,
      modelSource: typeof source === 'string' ? source : null,
      tamperRepairExercised: names.has('reject installed file tampering'),
      archiveTransportRepairExercised: names.has('reject a truncated release archive and retry'),
    },
    runner: { imageOS: ev.runnerImage?.os, imageVersion: ev.runnerImage?.version },
    limitations: [
      'CPU-only generation of one pinned 135M-parameter GGUF through the public job API; no accelerator, resource-fit, throughput or concurrency evidence.',
      'Isolation from untrusted local callers was not exercised.',
    ],
  };
}

function hostRecord(ev, target, tree, problems) {
  const os = OS[ev.os], arch = ARCH[ev.arch];
  if (ev.schemaVersion !== 1) problems.push(`unsupported host evidence schemaVersion ${ev.schemaVersion}`);
  if (ev.backend !== target.backend) problems.push(`evidence backend ${ev.backend} differs from artifact ${target.backend}`);
  if (ev.runner?.label !== target.label) problems.push(`evidence runner ${ev.runner?.label} differs from artifact ${target.label}`);
  const list = steps(ev.steps, 'step', s => Number(s.seconds) * 1000);
  const status = ev.registryStatus ?? {};
  const blockers = status.blocker ? [{ code: String(status.blocker.code), detail: String(status.blocker.detail) }] : [];
  const runner = { imageOS: ev.runner?.imageOS, imageVersion: ev.runner?.imageVersion };
  if (target.backend === 'containerd') {
    const identity = treeIdentity(tree, 'containerd', os, arch);
    if (!identity) { problems.push(`no containerd pin in the tree for ${os}/${arch}`); return undefined; }
    const byName = list => [...(list ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!same(byName(ev.assetPins), byName(identity.assets))) problems.push(`containerd ${arch} asset evidence does not match ${PATHS.containerdPins}`);
    if (ev.executionMode !== 'cpu') problems.push(`unexpected containerd execution mode ${ev.executionMode}`);
    return {
      identity, os, arch, acceleration: 'none', executionMode: 'root-lifecycle', steps: list, blockers, runner,
      passed: allPassed(list) && status.state === 'verified' && status.version === identity.version && ev.installerStatus?.code === 'installed',
      observations: { registryState: status.state ?? null, ociImage: ev.ociImage ?? null },
      limitations: [
        'The runner purged its preinstalled Docker, containerd and Podman before installation.',
        'One digest-pinned OCI task ran through the private socket; no workload isolation or resource evidence.',
        ...(typeof ev.crashRecovery === 'string' ? [`Crash recovery: ${ev.crashRecovery}.`] : []),
      ],
    };
  }
  if (ev.executionMode !== 'detect-only') problems.push(`unexpected ${target.backend} execution mode ${ev.executionMode}`);
  const libvirt = target.backend === 'libvirt';
  const version = libvirt ? /\d+\.\d+\.\d+/.exec(String(ev.packageVersion ?? ''))?.[0] : ev.macOSVersion;
  if (!version) { problems.push(`${target.backend} evidence has no detected version`); return undefined; }
  return {
    identity: { version, source: libvirt ? 'host-packages' : 'host-os' }, os, arch,
    acceleration: libvirt ? (ev.kvmDevicePresent === true ? 'kvm' : 'none') : 'vz',
    executionMode: 'detect-only', steps: list, blockers, runner,
    passed: allPassed(list) && status.state === 'verified',
    blocked: allPassed(list) && blockers.length > 0,
    observations: libvirt
      ? { registryState: status.state ?? null, kvmDevicePresent: ev.kvmDevicePresent ?? null }
      : { registryState: status.state ?? null, frameworkSupport: ev.frameworkSupport === undefined ? null : ev.frameworkSupport === 'true' },
    limitations: ['Detection only; no guest was booted.'],
  };
}

function daemonRecord(ev, _target, _tree, problems) {
  const os = OS[ev.platform], arch = ARCH[ev.arch];
  if (ev.mode !== 'service') problems.push(`daemon evidence mode ${ev.mode} is not a service run`);
  if (!['systemd', 'launchd'].includes(ev.manager)) problems.push(`unknown service manager ${ev.manager}`);
  const list = steps(ev.steps, 'name', s => s.milliseconds);
  return {
    identity: { manager: ev.manager, node: ev.node, account: ev.account }, os, arch,
    acceleration: 'none', executionMode: 'service', steps: list, blockers: [],
    runner: { imageOS: ev.image?.os, imageVersion: ev.image?.version },
    passed: allPassed(list), observations: {},
    limitations: [
      'The daemon enrolled with a loopback controller started by the test.',
      ...(ev.account === 'dedicated system account' ? [] : [`The service ran as the ${ev.account}, not a dedicated service account.`]),
    ],
  };
}

const builders = { model: modelRecord, host: hostRecord, daemon: daemonRecord };

export function verifyRun(run, repository = REPOSITORY) {
  const problems = [];
  if (run.repository?.full_name !== repository) problems.push(`run belongs to ${run.repository?.full_name}, not ${repository}`);
  if (run.head_repository?.full_name !== repository) problems.push(`run head comes from ${run.head_repository?.full_name}`);
  if (!TRUSTED_EVENTS.includes(run.event)) problems.push(`event ${run.event} is not trusted for qualification`);
  if (run.status !== 'completed') problems.push(`run status is ${run.status}`);
  if (!WORKFLOWS[run.path]) problems.push(`workflow ${run.path} is not an acceptance suite`);
  if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? '')) problems.push('run has no commit SHA');
  // The artifacts API does not say which attempt produced an artifact.
  if (run.run_attempt !== 1) problems.push(`run attempt ${run.run_attempt} cannot be bound to its artifacts; record a fresh run`);
  return problems;
}

// A run can support a promotion only if it ran on main and its commit is on main.
// compareStatus is GitHub's status for <refs/heads/main SHA>...<commit>. A tag
// named main would make the branch name in run metadata ambiguous.
export function promotableRun(run, compareStatus, mainTagExists = false) {
  const problems = [];
  if (mainTagExists) problems.push(`a tag named ${DEFAULT_BRANCH} exists, so the run ref is ambiguous`);
  if (run.head_branch !== DEFAULT_BRANCH) problems.push(`run is on ${run.head_branch}, not ${DEFAULT_BRANCH}`);
  if (!TRUSTED_EVENTS.includes(run.event)) problems.push(`event ${run.event} is not trusted for qualification`);
  if (run.run_attempt !== 1) problems.push(`run attempt ${run.run_attempt} is not 1`);
  if (!['identical', 'behind'].includes(compareStatus)) problems.push(`commit ${run.head_sha} is not reachable from ${DEFAULT_BRANCH} (${compareStatus})`);
  return problems;
}

// Guards against a re-run starting between reading the run and its artifacts.
export function runUnchanged(before, after) {
  return after.run_attempt === before.run_attempt && after.status === 'completed'
    && after.updated_at === before.updated_at && after.head_sha === before.head_sha ? [] : ['the run changed while its artifacts were read; retry'];
}

// Pure conversion from verified run metadata and downloaded evidence to records.
export function buildRecords({ run, jobs, artifacts, tree, repository = REPOSITORY }) {
  const suite = WORKFLOWS[run.path];
  const problems = [];
  const records = [];
  for (const artifact of artifacts) {
    const target = artifactTarget(suite, artifact.name);
    if (!target) { problems.push(`${artifact.name}: unrecognized artifact`); continue; }
    if (BACKENDS[target.backend]?.suite !== run.path) { problems.push(`${artifact.name}: ${target.backend} evidence must come from ${BACKENDS[target.backend]?.suite}`); continue; }
    const job = jobs.find(j => j.name === target.job && j.run_attempt === run.run_attempt);
    if (!job) { problems.push(`${artifact.name}: no job ${target.job} in attempt ${run.run_attempt}`); continue; }
    if (!(job.labels ?? []).includes(target.label)) problems.push(`${artifact.name}: job runs on ${job.labels}, not ${target.label}`);
    const ev = artifact.evidence;
    const local = [];
    if (ev?.commit !== run.head_sha) local.push(`evidence commit ${ev?.commit} differs from run commit ${run.head_sha}`);
    const built = builders[suite](ev ?? {}, target, tree, local);
    if (built && (!built.os || !built.arch)) local.push('unrecognized os or architecture');
    if (built && !(built.runner.imageOS && built.runner.imageVersion)) local.push('evidence has no runner image version');
    problems.push(...local.map(problem => `${artifact.name}: ${problem}`));
    if (!built || local.length) continue;
    const jobPassed = job.conclusion === 'success';
    const outcome = jobPassed && built.passed ? 'passed' : jobPassed && built.blocked ? 'blocked' : 'failed';
    const service = suite === 'daemon';
    const runner = { label: target.label, ...built.runner };
    const record = {
      schema: RECORD_SCHEMA, version: 1,
      kind: service ? 'service' : 'runtime',
      backend: target.backend,
      ...(service ? {} : { pinId: pinId(built.identity) }),
      identity: built.identity,
      scope: { os: built.os, arch: built.arch, acceleration: built.acceleration, executionMode: built.executionMode },
      outcome,
      blockers: outcome === 'passed' ? [] : built.blockers ?? [],
      evidence: { ...(built.model ? { model: built.model } : {}), steps: built.steps, observations: built.observations },
      source: {
        repository, workflow: run.path, workflowName: run.name, runId: run.id, runAttempt: run.run_attempt,
        runUrl: run.html_url, event: run.event, ref: `refs/heads/${run.head_branch}`, commit: run.head_sha,
        job: { id: job.id, name: job.name, conclusion: job.conclusion, url: job.html_url },
        artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest },
        evidenceSha256: artifact.evidenceSha256,
      },
      runner,
      limitations: [hostedLimitation(runner), ...built.limitations],
      recorded: String(run.run_started_at).slice(0, 10),
    };
    if (outcome === 'failed' && !record.blockers.length) {
      record.blockers = [{ code: 'acceptance_failed', detail: `Job ${job.conclusion}; see the run for the failing step.` }];
    }
    records.push({ path: recordPath(record), record });
  }
  const seen = new Set();
  for (const { path } of records) {
    if (seen.has(path)) problems.push(`two artifacts map to ${path}`);
    seen.add(path);
  }
  return { records, problems };
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema subset validator (type, const, enum, pattern, bounds,
// required, properties, additionalProperties, items, minItems, $ref, oneOf).

export function schemaErrors(schema, value, path = '$', root = schema) {
  if (schema.$ref) return schemaErrors(root.$defs[schema.$ref.replace('#/$defs/', '')], value, path, root);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(option => !schemaErrors(option, value, path, root).length).length;
    return matches === 1 ? [] : [`${path}: matches ${matches} alternatives, expected one`];
  }
  const errors = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  const types = [schema.type ?? []].flat();
  if (types.length && !types.includes(type) && !(type === 'integer' && types.includes('number'))) return [`${path}: expected ${types.join('|')}`];
  if ('const' in schema && !same(schema.const, value)) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(option => same(option, value))) errors.push(`${path}: not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`, root)));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...schemaErrors(property, item, `${path}.${key}`, root));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...schemaErrors(schema.additionalProperties, item, `${path}.${key}`, root));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Records, promotions and generated tables

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJson(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

// A record entry as loaded from disk. Promotions bind records by the SHA-256 of
// these exact bytes, so replacing evidence requires a new reviewed promotion.
export const recordEntry = (path, record, bytes = json(record)) => ({ path, record, sha256: sha256(bytes) });

export function loadRecords(root = ROOT) {
  const base = join(root, PATHS.records);
  return listJson(base).sort().map(file => {
    const path = relative(base, file).split(sep).join('/');
    const bytes = readFileSync(file);
    try { return recordEntry(path, JSON.parse(bytes.toString('utf8')), bytes); }
    catch (error) { return { path, error: error.message }; }
  });
}

export function checkRecords(entries, tree, schema) {
  const errors = [], stale = [];
  for (const { path, record, error } of entries) {
    if (error) { errors.push(`records/${path}: ${error}`); continue; }
    const problems = schemaErrors(schema, record);
    if (problems.length) { errors.push(...problems.map(p => `records/${path}: ${p}`)); continue; }
    if (recordPath(record) !== path) errors.push(`records/${path}: content belongs at records/${recordPath(record)}`);
    if (record.kind === 'runtime' && record.pinId !== pinId(record.identity)) errors.push(`records/${path}: pinId does not match identity`);
    if ((record.kind === 'service') !== (record.backend === 'canaverald')) errors.push(`records/${path}: kind and backend disagree`);
    if (record.source.workflow !== BACKENDS[record.backend].suite) errors.push(`records/${path}: ${record.backend} evidence must come from ${BACKENDS[record.backend].suite}`);
    if (record.source.repository !== REPOSITORY) errors.push(`records/${path}: evidence from another repository`);
    if (record.outcome === 'passed') {
      if (record.blockers.length) errors.push(`records/${path}: passed record lists blockers`);
      if (!record.evidence.steps.every(step => step.outcome === 'passed')) errors.push(`records/${path}: passed record has a failed step`);
    }
    if (record.outcome !== 'passed' && !record.blockers.length) errors.push(`records/${path}: ${record.outcome} record needs a blocker`);
    if (record.kind === 'runtime' && BACKENDS[record.backend]?.identity !== 'detected') {
      const current = treeIdentity(tree, record.backend, record.scope.os, record.scope.arch);
      if (!same(current, record.identity)) stale.push(`records/${path}`);
    }
  }
  return { errors, stale };
}

// Offline promotability: the record claims a first-attempt trusted run of main
// in this repository. `verify` confirms the claim against the GitHub API.
function citedRecordProblems(record) {
  const problems = [];
  if (record.source.repository !== REPOSITORY) problems.push('comes from another repository');
  if (record.source.ref !== DEFAULT_REF) problems.push(`comes from ${record.source.ref}, not ${DEFAULT_REF}`);
  if (!TRUSTED_EVENTS.includes(record.source.event)) problems.push(`comes from an untrusted ${record.source.event} event`);
  if (record.source.runAttempt !== 1) problems.push(`comes from run attempt ${record.source.runAttempt}`);
  if (record.source.workflow !== BACKENDS[record.backend]?.suite) problems.push(`does not come from the ${record.backend} suite`);
  return problems;
}

const scopeKey = entry => [entry.backend, entry.scope.os, entry.scope.arch, entry.scope.acceleration, entry.scope.executionMode].join(' ');

export function checkPromotions(promotions, entries, tree, schema) {
  const errors = schemaErrors(schema, promotions).map(p => `promotions: ${p}`);
  if (errors.length) return errors;
  const byPath = new Map(entries.filter(entry => entry.record).map(entry => [entry.path, entry]));
  const keys = new Set();
  const cited = (at, label, ref) => {
    const entry = byPath.get(ref.path);
    if (!entry) { errors.push(`${at}: ${label} ${ref.path} does not exist`); return undefined; }
    if (entry.sha256 !== ref.sha256) errors.push(`${at}: ${label} ${ref.path} changed since promotion (sha256 ${entry.sha256})`);
    for (const problem of citedRecordProblems(entry.record)) errors.push(`${at}: ${label} ${ref.path} ${problem}`);
    return entry.record;
  };
  promotions.promotions.forEach((entry, index) => {
    const at = `promotions[${index}] ${entry.backend} ${entry.pinId}`;
    const rule = BACKENDS[entry.backend];
    if (!rule) { errors.push(`${at}: unknown backend`); return; }
    if (rule.blocker) { errors.push(`${at}: ${rule.blocker.code}: ${rule.blocker.detail}`); return; }
    if (!rule.promotable) { errors.push(`${at}: ${entry.backend} cannot be promoted`); return; }
    const { os, arch, acceleration, executionMode } = entry.scope;
    if (executionMode !== rule.promotable.executionMode || acceleration !== rule.promotable.acceleration) {
      errors.push(`${at}: ${entry.backend} promotes only ${rule.promotable.executionMode} with ${rule.promotable.acceleration} acceleration`);
    }
    if (keys.has(scopeKey(entry))) errors.push(`${at}: duplicate scope ${scopeKey(entry)}`);
    keys.add(scopeKey(entry));
    if (entry.pinId !== pinId(entry.identity)) errors.push(`${at}: pinId does not match identity`);
    if (!same(treeIdentity(tree, entry.backend, os, arch), entry.identity)) {
      errors.push(`${at}: identity is not the exact pin the tree ships for ${os}/${arch}`);
    }
    for (const ref of entry.records) {
      const record = cited(at, 'record', ref);
      if (!record) continue;
      if (record.kind !== 'runtime' || record.outcome !== 'passed') errors.push(`${at}: record ${ref.path} is not a passing runtime record`);
      if (record.backend !== entry.backend || record.pinId !== entry.pinId || !same(record.identity, entry.identity) || !same(record.scope, entry.scope)) {
        errors.push(`${at}: record ${ref.path} covers a different pin or scope`);
      }
    }
    for (const ref of entry.supporting) {
      const record = cited(at, 'supporting record', ref);
      if (record && (record.kind !== 'service' || record.outcome !== 'passed' || record.scope.os !== os || record.scope.arch !== arch)) {
        errors.push(`${at}: supporting record ${ref.path} is not a passing service record for ${os}/${arch}`);
      }
    }
  });
  return errors;
}

export function qualifiedTable(promotions) {
  const pins = promotions.promotions
    .map(({ backend, pinId: id, identity, scope }) => ({ backend, ...scope, pinId: id, identity }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { schema: TABLE_SCHEMA, version: 1, source: PATHS.promotions, pins };
}

export function generated(promotions) {
  const table = qualifiedTable(promotions);
  const pins = JSON.stringify(table.pins, null, 2);
  return {
    [PATHS.rustTable]: json(table),
    [PATHS.tsTable]: `// Generated by \`node script/qualification.mjs sync\` from ${PATHS.promotions}.\n`
      + '// Do not edit. `node script/qualification.mjs check` rejects drift.\n'
      + 'import type { QualifiedPin } from "./qualification.ts";\n\n'
      + `export const qualifiedPins: readonly QualifiedPin[] = ${pins};\n`,
  };
}

export function check(root = ROOT) {
  const tree = loadTree(root);
  const entries = loadRecords(root);
  const recordSchema = JSON.parse(read(root, PATHS.recordSchema));
  const promotionsSchema = JSON.parse(read(root, PATHS.promotionsSchema));
  const promotions = JSON.parse(read(root, PATHS.promotions));
  const { errors, stale } = checkRecords(entries, tree, recordSchema);
  errors.push(...checkPromotions(promotions, entries, tree, promotionsSchema));
  for (const [path, content] of Object.entries(generated(promotions))) {
    if (!existsSync(join(root, path)) || read(root, path) !== content) errors.push(`${path} is out of date; run node script/qualification.mjs sync`);
  }
  return { errors, stale, records: entries.length, promotions: promotions.promotions?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// GitHub access through gh (read-only). In Actions, gh reads GH_TOKEN.

export function ghClient(repository = REPOSITORY) {
  const gh = (args, options = {}) => execFileSync('gh', args, { maxBuffer: 64 * 1024 * 1024, ...options });
  const api = path => JSON.parse(gh(['api', path], { encoding: 'utf8' }));
  return {
    run: id => api(`repos/${repository}/actions/runs/${id}`),
    jobs: (id, attempt) => api(`repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`).jobs,
    artifacts: id => api(`repos/${repository}/actions/runs/${id}/artifacts?per_page=100`).artifacts,
    artifact: id => api(`repos/${repository}/actions/artifacts/${id}`),
    // Resolve refs/heads/main to a SHA first so a tag named main cannot shadow it.
    compare: sha => api(`repos/${repository}/compare/${api(`repos/${repository}/branches/${DEFAULT_BRANCH}`).commit.sha}...${sha}`).status,
    mainTagExists: () => {
      try { api(`repos/${repository}/git/ref/tags/${DEFAULT_BRANCH}`); return true; }
      catch (error) { if (/HTTP 404/.test(String(error.stderr ?? error.message))) return false; throw error; }
    },
    download: (artifact, file) => writeFileSync(file, gh(['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`])),
  };
}

// Downloads each artifact archive, checks it against the digest GitHub reports
// and extracts the single evidence file. Archives are untrusted data and are
// only JSON-parsed.
export function fetchEvidence(client, artifacts, scratch) {
  return artifacts.map(artifact => {
    if (artifact.expired) throw new Error(`${artifact.name}: artifact expired`);
    if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) throw new Error(`${artifact.name}: GitHub reports no artifact digest`);
    const dir = mkdtempSync(join(scratch, 'artifact-'));
    const zip = join(dir, 'artifact.zip');
    client.download(artifact, zip);
    const digest = `sha256:${sha256(readFileSync(zip))}`;
    if (artifact.digest !== digest) throw new Error(`${artifact.name}: archive digest ${digest} differs from ${artifact.digest}`);
    const members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);
    if (members.length !== 1 || !members[0].endsWith('.json')) throw new Error(`${artifact.name}: expected one JSON evidence file`);
    const bytes = execFileSync('unzip', ['-p', zip, members[0]], { maxBuffer: MAX_EVIDENCE_BYTES });
    return { id: artifact.id, name: artifact.name, digest, evidenceSha256: sha256(bytes), evidence: JSON.parse(bytes.toString('utf8')) };
  });
}

function withScratch(work) {
  const scratch = mkdtempSync(join(tmpdir(), 'canaveral-qualification-'));
  try { return work(scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

function record(runId, { repository, root, dryRun }) {
  const client = ghClient(repository);
  const run = client.run(runId);
  const refused = verifyRun(run, repository);
  if (refused.length) throw new Error(`run ${runId} refused:\n  ${refused.join('\n  ')}`);
  // A run labelled main must really be a promotable run of main.
  const promotable = run.head_branch === DEFAULT_BRANCH;
  if (promotable) {
    const problems = promotableRun(run, client.compare(run.head_sha), client.mainTagExists());
    if (problems.length) throw new Error(`run ${runId} refused:\n  ${problems.join('\n  ')}`);
  }
  withScratch(scratch => {
    const artifacts = fetchEvidence(client, client.artifacts(runId), scratch);
    const changed = runUnchanged(run, client.run(runId));
    if (changed.length) throw new Error(`run ${runId} refused: ${changed[0]}`);
    const { records, problems } = buildRecords({ run, jobs: client.jobs(runId, run.run_attempt), artifacts, tree: loadTree(root), repository });
    if (problems.length) throw new Error(`run ${runId} evidence does not match the tree:\n  ${problems.join('\n  ')}`);
    for (const { path, record } of records) {
      const file = join(root, PATHS.records, path);
      if (!dryRun) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(record)); }
      const note = promotable ? '' : `, ${run.head_branch} run: informational, not promotable`;
      console.log(`${dryRun ? 'would write' : 'wrote'} ${PATHS.records}/${path} (${record.outcome}${note}) sha256 ${sha256(json(record))}`);
    }
  });
}

// Re-derives a committed record from its run and artifact through the GitHub
// API and requires an exact match. Returns problems. Once GitHub has expired the
// artifact, only its metadata (digest, run and job) can be compared; such records
// are added to `notes`.
export function verifyRecord(committed, client, tree, scratch, notes = []) {
  const source = committed.source;
  const run = client.run(source.runId);
  const problems = [...verifyRun(run), ...promotableRun(run, client.compare(run.head_sha), client.mainTagExists())];
  if (run.path !== BACKENDS[committed.backend]?.suite) problems.push(`run workflow ${run.path} is not the ${committed.backend} suite`);
  if (run.head_sha !== source.commit || run.run_attempt !== source.runAttempt) problems.push('run commit or attempt differs from the record');
  if (problems.length) return problems;
  const artifact = client.artifact(source.artifact.id);
  if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha) return ['artifact does not belong to the run'];
  if (artifact.name !== source.artifact.name || artifact.digest !== source.artifact.digest) return ['artifact name or digest differs from the record'];
  if (artifact.expired) {
    const job = client.jobs(run.id, run.run_attempt).find(entry => entry.id === source.job.id);
    if (!job || job.name !== source.job.name || job.conclusion !== source.job.conclusion) return ['job differs from the record'];
    notes.push('artifact expired; verified run, job and artifact digest metadata only');
    return [];
  }
  const fetched = fetchEvidence(client, [artifact], scratch);
  const changed = runUnchanged(run, client.run(source.runId));
  if (changed.length) return changed;
  const { records, problems: built } = buildRecords({ run, jobs: client.jobs(run.id, run.run_attempt), artifacts: fetched, tree });
  if (built.length) return built;
  if (records.length !== 1 || !same(records[0].record, committed)) return ['committed record differs from the record derived from the run artifact'];
  return [];
}

// Runs the offline check (including citation digests), then verifies against
// GitHub every record cited by a promotion: all of them with `all`, otherwise
// those cited by promotions that are new or changed since the `base` commit.
export function verify({ root = ROOT, client = ghClient(), base, all = false } = {}) {
  const offline = check(root);
  if (offline.errors.length) return { errors: offline.errors, verified: 0 };
  const promotions = JSON.parse(read(root, PATHS.promotions)).promotions;
  let previous = [];
  if (!all) {
    if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('verify needs --all or --base with a full commit SHA');
    try { previous = JSON.parse(execFileSync('git', ['show', `${base}:${PATHS.promotions}`], { cwd: root, encoding: 'utf8' })).promotions; }
    catch { previous = []; }
  }
  const changed = promotions.filter(entry => !previous.some(old => same(old, entry)));
  const paths = [...new Set(changed.flatMap(entry => [...entry.records, ...entry.supporting].map(ref => ref.path)))];
  const entries = new Map(loadRecords(root).map(entry => [entry.path, entry]));
  const tree = loadTree(root);
  const errors = [], notes = [];
  withScratch(scratch => {
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry?.record) { errors.push(`records/${path}: missing or unreadable`); continue; }
      const recordNotes = [];
      try { errors.push(...verifyRecord(entry.record, client, tree, scratch, recordNotes).map(p => `records/${path}: ${p}`)); }
      catch (error) { errors.push(`records/${path}: ${error.message}`); }
      notes.push(...recordNotes.map(note => `records/${path}: ${note}`));
    }
  });
  return { errors, notes, verified: paths.length };
}

function usage() {
  return `usage:
  node script/qualification.mjs record --run RUN_ID [--repo OWNER/NAME] [--dry-run]
  node script/qualification.mjs check
  node script/qualification.mjs verify (--all | --base COMMIT_SHA)
  node script/qualification.mjs sync`;
}

export function main(argv, root = ROOT) {
  const [command, ...rest] = argv;
  const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === 'record') {
    const runId = option('--run');
    if (!/^\d+$/.test(runId ?? '')) throw new Error(usage());
    record(runId, { repository: option('--repo') ?? REPOSITORY, root, dryRun: rest.includes('--dry-run') });
    return 0;
  }
  if (command === 'check') {
    const result = check(root);
    for (const path of result.stale) console.log(`stale (pin changed since recording): ${path}`);
    for (const error of result.errors) console.error(`error: ${error}`);
    console.log(`${result.records} records, ${result.promotions} promotions, ${result.errors.length} errors`);
    return result.errors.length ? 1 : 0;
  }
  if (command === 'verify') {
    const result = verify({ root, base: option('--base'), all: rest.includes('--all') });
    for (const note of result.notes ?? []) console.log(`note: ${note}`);
    for (const error of result.errors) console.error(`error: ${error}`);
    console.log(`verified ${result.verified} promoted records, ${result.errors.length} errors`);
    return result.errors.length ? 1 : 0;
  }
  if (command === 'sync') {
    const promotions = JSON.parse(read(root, PATHS.promotions));
    const errors = checkPromotions(promotions, loadRecords(root), loadTree(root), JSON.parse(read(root, PATHS.promotionsSchema)));
    if (errors.length) { for (const error of errors) console.error(`error: ${error}`); return 1; }
    for (const [path, content] of Object.entries(generated(promotions))) writeFileSync(join(root, path), content);
    console.log(`synced ${promotions.promotions.length} promotions`);
    return 0;
  }
  console.error(usage());
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
