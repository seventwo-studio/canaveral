import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { chromium, firefox, webkit } from 'playwright-core';

const url = 'https://127.0.0.1/v1/browsers';
const token = readFileSync('/etc/canaveral-browser/token', 'utf8').trim();
const headers = { authorization: 'Bearer ' + token };

async function trial(engine, browserType) {
  writeFileSync('/root/trial/result', engine);
  const id = randomUUID();
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ id, engine, ttlSeconds: 600 }),
  });
  assert.equal(response.status, 201);
  const receipt = await response.json();
  let group;
  try {
    assert.equal(receipt.id, id);
    assert.equal(receipt.engine, engine);
    assert.equal(receipt.endpoint, 'wss://127.0.0.1/v1/browsers/' + id + '/connect');
    const path = execFileSync('systemctl', ['show', '--value', '-p', 'ControlGroup', 'browser-launch@*.service'], { encoding: 'utf8' }).trim();
    assert.match(path, /^\/canaveral[.]slice\/browser-launch@[^/\s]+[.]service$/);
    group = '/sys/fs/cgroup' + path;
    assert.ok(existsSync(group));
    const browser = await browserType.connect(receipt.endpoint, {
      headers: { authorization: 'Bearer ' + receipt.key },
    });
    try {
      const page = await browser.newPage({ viewport: { width: 96, height: 64 }, deviceScaleFactor: 1 });
      await page.setContent('<style>html{background:#e7a729}body{margin:0;width:48px;height:100vh;background:#135389}</style><body></body>');
      await page.screenshot({ path: `/root/trial/${engine}.png` });
    } finally {
      await browser.close();
    }
  } finally {
    const stop = await fetch(url + '/' + id, { method: 'DELETE', headers });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { id, state: 'closed' });
  }
  for (let attempt = 0; existsSync(group) && attempt < 100; attempt++) {
    await setTimeout(100);
  }
  assert.equal(existsSync(group), false, engine + ' launcher cgroup survived stop');
}

for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
  await trial(engine, browserType);
}
