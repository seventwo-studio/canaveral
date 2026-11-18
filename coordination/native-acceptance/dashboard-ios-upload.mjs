import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The authenticated browser must be on the disposable machine's dashboard detail.
export async function dashboardIosUpload(page, archive, machineId, hostId) {
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await page.getByLabel(/iOS Simulator .app in an uncompressed ustar archive/).setInputFiles(archive);
  const [created] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/machines/' + machineId + '/operations' && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Upload and install' }).click(),
  ]);
  assert.ok(created.ok(), 'dashboard install submission failed');
  const operation = await created.json();
  assert.equal(operation.machineId, machineId);
  assert.equal(operation.hostId, hostId);
  await page.getByText('Installation succeeded · ' + operation.id, { exact: true }).waitFor({ timeout: 120000 });
  const response = await page.request.get(new URL('/api/v1/operations/' + operation.id, page.url()).href);
  assert.ok(response.ok());
  const receipt = await response.json();
  assert.equal(receipt.id, operation.id);
  assert.equal(receipt.machineId, machineId);
  assert.equal(receipt.hostId, hostId);
  assert.equal(receipt.state, 'succeeded');
  assert.deepEqual(receipt.result, { installed: true, artifactCleaned: true, sha256, bytes: bytes.length });
  return receipt.id;
}
