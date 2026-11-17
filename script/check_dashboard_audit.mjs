/** Approved, expiring exception for one development-only advisory; not a fix. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { uniqueJSON } from './json.mjs';

export const exception = Object.freeze({
  advisory: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  source: 1247710,
  approvedAt: Date.parse('2026-11-17T00:00:00Z'),
  expiresAt: Date.parse('2026-11-24T00:00:00Z'),
  lockSha256: 'c3d49e7b1d9abddff2c9dbff3b717e0aa3a39c7abee1d2518bd9b04354a3176b',
});
export const reviewedChain = Object.freeze({
  picomatch: { version: '4.0.7', via: [] },
  fdir: { version: '6.5.0', via: ['picomatch'] },
  tinyglobby: { version: '0.2.17', via: ['fdir', 'picomatch'] },
  vite: { version: '7.3.7', via: ['fdir', 'picomatch', 'tinyglobby'] },
  vitest: { version: '4.1.12', via: ['picomatch', 'tinyglobby'] },
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function entries(report) {
  if (!object(report) || report.error || report.auditReportVersion !== 2 || !object(report.vulnerabilities)) throw new Error('Unsupported or failed npm audit report.');
  const entries = Object.entries(report.vulnerabilities);
  const totals = report.metadata?.vulnerabilities;
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, entry] of entries) {
    if (!object(entry) || entry.name !== name || !Object.hasOwn(counts, entry.severity)) throw new Error('Malformed audit vulnerability.');
    counts[entry.severity]++;
  }
  if (!object(totals) || totals.total !== entries.length || Object.entries(counts).some(([key, value]) => totals[key] !== value)) throw new Error('Inconsistent npm audit totals.');
  return entries;
}
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && a.every(v => b.includes(v));

export function evaluateDashboardAudit({ full, production, lockText, installed, now = Date.now() }) {
  if (entries(production).length) throw new Error('Production advisories are never excepted.');
  const findings = entries(full);
  if (!findings.length) return { excepted: false, count: 0 };
  if (!Number.isFinite(now) || now < exception.approvedAt || now >= exception.expiresAt) throw new Error('The development advisory exception is expired or outside its approved window.');
  if (typeof lockText !== 'string' || createHash('sha256').update(lockText).digest('hex') !== exception.lockSha256) throw new Error('The reviewed dashboard lockfile changed; reassessment is required.');
  const lock = uniqueJSON(lockText);
  if (lock.lockfileVersion !== 3 || !object(lock.packages) || !object(installed)) throw new Error('Dependency evidence is unavailable.');
  if (!findings.some(([name]) => name === 'picomatch')) throw new Error('The reviewed root advisory is missing.');
  for (const [name, finding] of findings) {
    const policy = Object.hasOwn(reviewedChain, name) ? reviewedChain[name] : null;
    const node = `node_modules/${name}`;
    const item = lock.packages[node];
    if (!policy || !sameSet(finding.nodes, [node]) || item?.dev !== true || item.version !== policy.version || installed[name] !== policy.version || finding.severity !== 'high' || !Array.isArray(finding.via)) throw new Error('An advisory is outside the reviewed development-only chain.');
    if (name === 'picomatch') {
      const root = finding.via[0];
      if (finding.via.length !== 1 || !object(root) || root.name !== 'picomatch' || root.dependency !== 'picomatch' || root.source !== exception.source || root.url !== exception.advisory || root.range !== '<=4.0.7' || root.severity !== 'high') throw new Error('A different direct advisory is not excepted.');
    } else if (!sameSet(finding.via, policy.via) || finding.via.some(v => !Object.hasOwn(full.vulnerabilities, v))) throw new Error('The audited advisory chain changed.');
  }
  return { excepted: true, count: findings.length };
}

export function runAudit(cwd, args, execute = spawnSync) {
  const result = execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json', ...args], { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || ![0, 1].includes(result.status) || typeof result.stdout !== 'string') throw new Error('npm audit failed to return usable evidence.');
  const report = uniqueJSON(result.stdout);
  const findings = entries(report);
  if ((result.status === 0) !== (findings.length === 0)) throw new Error('npm audit exit status contradicts its report.');
  return report;
}

export function main() {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../dashboard');
  const production = runAudit(cwd, ['--omit=dev']);
  const full = runAudit(cwd, []);
  const installed = {};
  for (const name of Object.keys(reviewedChain)) {
    if (Object.hasOwn(full.vulnerabilities, name)) installed[name] = uniqueJSON(readFileSync(join(cwd, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  const result = evaluateDashboardAudit({ full, production, lockText: readFileSync(join(cwd, 'package-lock.json'), 'utf8'), installed });
  if (result.excepted) console.warn(`TEMPORARY EXCEPTION: ${exception.advisory}; ${result.count} reviewed dev-only entries. Expires ${new Date(exception.expiresAt).toISOString()}. Production audit is clean; the tooling vulnerability remains unfixed.`);
  else console.log('Production and full dashboard dependency audits are clean.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
