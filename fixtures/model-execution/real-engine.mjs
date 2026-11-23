import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const manifest = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const model = manifest('./real-model.json');
const os = process.platform === 'darwin' ? 'macos' : process.platform;
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const backend = process.env.MODEL_BACKEND;
const engine = manifest('../../crates/model-execution/src/runtime-pins.json').pins.find(
  pin => pin.os === os && pin.arch === arch && pin.backend === backend,
);

function evidence() {
  return {
    commit: process.env.GITHUB_SHA,
    runnerImage: { os: process.env.ImageOS, version: process.env.ImageVersion },
    os, arch, backend, acceleration: 'cpu',
    engine: { version: engine?.version, archiveSha256: engine?.sha256, treeSha256: engine?.treeSha256 },
    model: { name: model.model, revision: model.revision, sha256: model.sha256 },
    steps: [],
  };
}

function writeEvidence(report) {
  writeFileSync(process.env.MODEL_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedAsset(pin, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const valid = async file => statSync(file).size === pin.bytes && await hashFile(file) === pin.sha256;
  if (existsSync(destination)) {
    assert(await valid(destination), 'cached asset failed its size or SHA-256 check');
    return 'verified cache';
  }
  const pending = destination + '.download';
  try {
    await exec('curl', [
      '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
      '--max-redirs', '4', '--connect-timeout', '15', '--max-time', '600', '--retry', '2',
      '--max-filesize', String(pin.bytes), '--output', pending, pin.url,
    ], { timeout: 660_000 });
    assert(await valid(pending), 'downloaded asset failed its size or SHA-256 check');
    renameSync(pending, destination);
  } finally {
    rmSync(pending, { force: true });
  }
  return 'verified download';
}

export async function runRealEngine({ dir, origin, call, controllerId, runner }) {
  const report = evidence();
  writeEvidence(report);
  const started = performance.now();
  async function step(name, work) {
    const entry = { name, outcome: 'running' };
    const start = performance.now();
    report.steps.push(entry);
    writeEvidence(report);
    try {
      const result = await work();
      if (result !== undefined) entry.result = result;
      entry.outcome = 'passed';
      return result;
    } catch (error) {
      entry.outcome = 'failed';
      // Only print the public fixture's diagnostic in CI. Evidence stays small.
      console.error(error);
      throw new Error(name + ' failed');
    } finally {
      entry.durationMs = Math.round(performance.now() - start);
      report.durationMs = Math.round(performance.now() - started);
      writeEvidence(report);
    }
  }
  assert(engine, `No catalog package for ${backend} on ${os}/${arch}`);

  const localModel = join(dir, 'models', model.file);
  await step('verify GGUF', async () => {
    const asset = resolve(process.env.MODEL_CACHE, model.sha256, model.file);
    const source = await verifiedAsset(model, asset);
    copyFileSync(asset, localModel);
    chmodSync(localModel, 0o600);
    return { source, bytes: model.bytes };
  });

  const binary = join(dir, 'canaveral-model-execution');
  copyFileSync(runner, binary);
  chmodSync(binary, 0o700);
  const stateDir = join(dir, 'state');
  const runnerConfig = join(dir, 'runner.json');
  const hostConfig = join(dir, 'host.json');
  const credentialFile = join(dir, 'credential');
  const digest = 'sha256:' + model.sha256;
  const name = model.model;
  const resources = { cpu: 1, memoryMiB: 1024, diskGiB: 1 };
  let client;
  await step('enroll through public API', async () => {
    const applicationId = randomUUID(), domainId = randomUUID();
    const binding = { controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
    const enrollment = randomUUID(), credential = randomBytes(32).toString('base64url');
    await call('/v1/model-catalog', { model: name, digest, adapter: backend, resources });
    const app = await call('/v1/consumers', {
      id: applicationId, name: 'disposable native model fixture', templates: [],
      limits: { resources, activeLeases: 1 },
    });
    await call('/v1/model-grants', { applicationId, model: name, digest, maxUnfinished: 1 });
    const issued = await call('/v1/runner-enrollments', { id: enrollment, ...binding, ttlSeconds: 60 });
    await call('/v1/runner-enrollments/consume', { id: enrollment, ...binding, credential }, issued.enrollmentToken);
    await call('/v1/resource-domains', { id: domainId, name: 'native fixture', capacity: resources });
    await call('/v1/model-runner-approvals', { binding, domainId, models: [{ model: name, digest }] });
    writeFileSync(credentialFile, credential, { mode: 0o600 });
    writeFileSync(runnerConfig, JSON.stringify({
      controller: origin, binding, credentialFile, caFile: null,
      execution: {
        backend, acceleration: 'cpu', modelsDir: join(dir, 'models'), stateDir,
        inventory: { [name]: digest },
        modelFiles: { [name]: { path: model.file, files: { [model.file]: model.sha256 } } },
        startupMs: 120_000, executionMs: 120_000, contactMs: 10_000, stopMs: 5000,
        responseBytes: 262144, contextTokens: 2048,
      },
    }), { mode: 0o600 });
    writeFileSync(hostConfig, JSON.stringify({
      name: 'disposable model fixture', provider: 'native', templates: [], capacity: resources,
      modelExecutor: { binary, config: runnerConfig },
    }), { mode: 0o600 });
    client = { applicationId, credential: app.credential };
  });

  async function manage(action, ...flags) {
    const args = [resolve('coordination/dist/src/canaverald.js'), 'runtimes', action];
    if (action !== 'status') args.push(backend);
    args.push('--config', hostConfig, '--state', stateDir, '--json', ...flags);
    const { stdout, exit } = await exec(process.execPath, args, { timeout: 925_000 })
      .then(value => ({ ...value, exit: 0 }), error => {
        if (error.code !== 1 || !error.stdout.trim()) throw error;
        return { stdout: error.stdout, exit: 1 };
      });
    const result = JSON.parse(stdout);
    const row = (result.backends ?? result).find(entry => entry.id === backend);
    assert(row, stdout);
    return { exit, row, result: result.result };
  }
  const validate = ({ exit, row }) => {
    assert.equal(exit, 0, JSON.stringify(row));
    assert.equal(row.state, 'verified', JSON.stringify(row));
    assert.equal(row.active, engine.version);
    assert.equal(row.catalogVersion, engine.version);
    assert.equal(row.qualified, false);
    assert.equal(row.installed.length, 1);
    const [installed] = row.installed;
    const packageDigest = createHash('sha256')
      .update(`archive-v1\n${backend}\n${engine.version}\n${engine.treeSha256}`).digest('hex');
    assert.deepEqual(installed, {
      version: engine.version, packageDigest, verified: true, referenced: false,
    });
    return installed.packageDigest;
  };

  report.engine.packageDigest = await step('install package', async () => validate(await manage('install')));
  await step('verify installed package', async () => assert.equal(validate(await manage('verify')), report.engine.packageDigest));
  await step('generate through public API', async () => {
    const id = randomUUID();
    const { applicationId, credential } = client;
    await call('/v1/model-jobs', {
      version: 1, applicationId, id,
      message: { type: 'submit', adapter: backend, model: name, digest,
        prompt: 'Write one short sentence about the moon.', maxTokens: 32 },
    }, credential);
    let diagnostics;
    try {
      diagnostics = await exec(binary, [runnerConfig], { timeout: 255_000 });
    } catch (error) {
      throw new Error(`model executor exit ${error.code}: ${error.stderr}`);
    }
    const view = await call('/v1/model-jobs/' + id, undefined, credential, 'GET');
    assert.equal(view.state, 'succeeded', diagnostics.stderr);
    assert.equal(view.result.model, name);
    assert(view.result.text.trim(), 'empty output');
    assert(Number.isInteger(view.result.usage.inputTokens) && view.result.usage.inputTokens > 0);
    assert(Number.isInteger(view.result.usage.outputTokens) && view.result.usage.outputTokens > 0);
    assert(view.result.usage.outputTokens <= 32);
    assert.equal(view.reservationHeld, false);
    return { usage: view.result.usage, reservationHeld: false };
  });
  await step('check runtime cleanup', async () => {
    assert(!existsSync(join(stateDir, 'workspace')));
    const { stdout } = await exec('ps', ['-axww', '-o', 'command=']);
    assert(!stdout.split('\n').some(line => line.includes(join(stateDir, 'runtime-package.'))));
  });

  const smoke = process.env.MODEL_SMOKE === 'true';
  if (!smoke) {
    await step('reject installed file tampering', async () => {
      const path = join(stateDir, 'runtime-package.' + report.engine.packageDigest, engine.entrypoint);
      chmodSync(path, 0o700);
      appendFileSync(path, 'tampered');
      chmodSync(path, 0o500);
      const verify = await manage('verify');
      assert.equal(verify.exit, 1);
      assert.equal(verify.row.blocker?.code, 'runtime_integrity_failed');
      assert.equal(verify.row.installed[0].verified, false);
      assert.equal((await manage('status')).row.state, 'failed');
    });
    await step('reinstall and verify package', async () => {
      assert.equal(validate(await manage('install')), report.engine.packageDigest);
      assert.equal(validate(await manage('verify')), report.engine.packageDigest);
    });
  }
  await step('remove package', async () => {
    const removed = await manage('remove', '--version', engine.version);
    assert.equal(removed.exit, 0, JSON.stringify(removed));
    const status = await manage('status');
    assert.equal(status.row.state, 'absent');
    assert.deepEqual(status.row.installed, []);
    assert(!readdirSync(stateDir).some(entry => entry.startsWith('runtime-package.')));
  });
  if (!smoke) {
    await step('reject a truncated release archive and retry', async () => {
      const archive = join(dir, engine.sha256, 'release');
      await verifiedAsset(engine, archive);
      await exec('cargo', [
        'test', '--locked', '--release', '-p', 'canaveral-model-execution', '--lib',
        'runtime_archive::tests::real_archive_transport_refuses_truncation_and_retries',
        '--', '--ignored', '--exact',
      ], {
        env: { ...process.env, CANAVERAL_REAL_ARCHIVE: archive },
        timeout: 635_000,
      }).then(({ stdout }) => assert.match(stdout, /1 passed; 0 failed/), error => {
        throw new Error(error.stderr + '\n' + error.stdout);
      });
    });
  }
  console.log(`PASS native ${backend} CPU acceptance on ${os}/${arch}`);
}

if (process.argv[2] === '--init-evidence') {
  writeEvidence(evidence());
  assert(engine, 'runner has no pinned engine package');
  appendFileSync(process.env.GITHUB_OUTPUT, `modelDigest=${model.sha256}\n`);
}
