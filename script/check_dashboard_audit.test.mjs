import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluateDashboardAudit, exception, reviewedChain, runAudit } from './check_dashboard_audit.mjs';

const clean = () => ({ auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
function reports() {
  const full = clean();
  for (const [name, policy] of Object.entries(reviewedChain)) {
    full.vulnerabilities[name] = { name, severity: 'high', nodes: [`node_modules/${name}`], via: name === 'picomatch' ? [{ name, dependency: name, source: exception.source, url: exception.advisory, range: '<=4.0.7', severity: 'high' }] : [...policy.via] };
  }
  full.metadata.vulnerabilities.high = full.metadata.vulnerabilities.total = 5;
  return { full, production: clean(), lockText: readFileSync(new URL('../dashboard/package-lock.json', import.meta.url), 'utf8'), installed: Object.fromEntries(Object.entries(reviewedChain).map(([name, value]) => [name, value.version])), now: Date.parse('2026-11-18T00:00:00Z') };
}

test('allows only the exact approved dev chain, with a clean production audit', () => {
  assert.deepEqual(evaluateDashboardAudit(reports()), { excepted: true, count: 5 });
});
test('a clean audit requires no exception, even after expiration or dependency updates', () => {
  assert.deepEqual(evaluateDashboardAudit({ full: clean(), production: clean(), now: exception.expiresAt, lockText: 'changed' }), { excepted: false, count: 0 });
});
test('the exception lasts at most seven days, and cannot be used before approval, at expiry or with an invalid clock', () => {
  assert.equal(exception.expiresAt - exception.approvedAt, 7 * 86400000);
  for (const now of [exception.approvedAt - 1, exception.expiresAt, NaN, Infinity]) assert.throws(() => evaluateDashboardAudit({ ...reports(), now }), /expired|window/);
  assert.equal(evaluateDashboardAudit({ ...reports(), now: exception.expiresAt - 1 }).excepted, true);
});
test('production vulnerabilities, including the known advisory, always block', () => {
  const args = reports(); args.production = structuredClone(args.full);
  assert.throws(() => evaluateDashboardAudit(args), /Production/);
});
test('lock changes and installed-version drift invalidate the exception', () => {
  assert.throws(() => evaluateDashboardAudit({ ...reports(), lockText: reports().lockText + '\n' }), /lockfile changed/);
  const args = reports(); args.installed.picomatch = '4.0.6';
  assert.throws(() => evaluateDashboardAudit(args), /reviewed development-only chain/);
});
test('new packages, new advisories on approved packages and altered dependency paths all block', () => {
  const changes = [
    args => { args.full.vulnerabilities.other = { name: 'other', severity: 'high', nodes: ['node_modules/other'], via: ['picomatch'] }; args.full.metadata.vulnerabilities.high++; args.full.metadata.vulnerabilities.total++; },
    args => { args.full.vulnerabilities.picomatch.via.push({ source: 9, url: 'https://github.com/advisories/OTHER' }); },
    args => { args.full.vulnerabilities.fdir.via.push('other'); },
    args => { args.full.vulnerabilities.vite.nodes = ['node_modules/another/node_modules/vite']; },
    args => { args.full.vulnerabilities.vite.via = ['picomatch']; },
    args => { args.full.vulnerabilities.picomatch.via[0].url += '-other'; },
    args => { args.full.vulnerabilities.picomatch.via[0].source++; },
    args => { args.full.vulnerabilities.picomatch.via[0].range = '*'; },
    args => { args.full.vulnerabilities.picomatch.via[0].severity = 'critical'; },
    args => { args.full.vulnerabilities.picomatch.severity = 'critical'; args.full.metadata.vulnerabilities.high--; args.full.metadata.vulnerabilities.critical++; },
    args => { args.full.vulnerabilities.vite.via = ['fdir', 'fdir', 'picomatch']; },
    args => { delete args.installed.fdir; },
  ];
  for (const change of changes) { const args = reports(); change(args); assert.throws(() => evaluateDashboardAudit(args)); }
});
test('unknown reports, failed audits and inconsistent totals fail closed', () => {
  const changes = [
    args => { args.full.auditReportVersion = 1; },
    args => { args.full.error = { code: 'NETWORK' }; },
    args => { delete args.production.metadata; },
    args => { args.full.metadata.vulnerabilities.total = 0; },
    args => { args.full.vulnerabilities = []; },
    args => { args.full.vulnerabilities.picomatch = null; },
    args => { delete args.full.vulnerabilities.picomatch; args.full.metadata.vulnerabilities.high--; args.full.metadata.vulnerabilities.total--; },
  ];
  for (const change of changes) { const args = reports(); change(args); assert.throws(() => evaluateDashboardAudit(args)); }
});
test('the command runner rejects network/process errors, duplicate JSON and contradictory exit statuses', () => {
  const execute = result => () => result;
  for (const result of [{ status: 2, stdout: '{}' }, { status: null, error: new Error('timeout') }, { status: 1, stdout: JSON.stringify(clean()) }, { status: 0, stdout: 'not JSON' }, { status: 0, stdout: '{"auditReportVersion":2,"auditReportVersion":1}' }]) assert.throws(() => runAudit('/unused', [], execute(result)));
  assert.deepEqual(runAudit('/unused', ['--omit=dev'], (command, args, options) => { assert.deepEqual(args, ['audit', '--json', '--omit=dev']); assert.equal(options.timeout, 60000); return { status: 0, stdout: JSON.stringify(clean()) }; }), clean());
});
