import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const id = randomUUID();
const url = 'https://127.0.0.1/v1/browsers';
const token = readFileSync('/etc/canaveral-browser/token', 'utf8').trim();
const headers = { authorization: 'Bearer ' + token };
try {
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ id, engine: 'chromium', ttlSeconds: 600 }),
  });
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.endpoint, 'wss://127.0.0.1/v1/browsers/' + id + '/connect');
  const browser = await chromium.connect(receipt.endpoint, {
    headers: { authorization: 'Bearer ' + receipt.key },
  });
  try {
    const page = await browser.newPage({ viewport: { width: 96, height: 64 }, deviceScaleFactor: 1 });
    await page.setContent('<style>html{background:#e7a729}body{margin:0;width:48px;height:100vh;background:#135389}</style><body></body>');
    await page.screenshot({ path: '/root/trial/page.png' });
  } finally {
    await browser.close();
  }
} finally {
  const stop = await fetch(url + '/' + id, { method: 'DELETE', headers });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { id, state: 'closed' });
}
