import assert from 'node:assert/strict';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import https from 'node:https';
import { createRequire } from 'node:module';

export async function dashboardBrowser({dashboard, cert, key, accounts, privateDir, onLaunch, onCleanup, record}) {
  const require = createRequire(new URL('../../dashboard/package.json', import.meta.url));
  const { chromium } = require('playwright');
  const ingress = https.createServer({cert, key}, (req,res) => dashboard.emit('request',req,res));
  await new Promise((resolve,reject) => ingress.once('error',reject).listen(0,'127.0.0.1',resolve));
  const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  const mapping = '127.0.0.1:' + ingress.address().port;
  const url = 'https://dashboard.canaveral.test/#previews';
  let browser;
  try {
    browser = await chromium.launch({args:[
      '--no-proxy-server', '--ignore-certificate-errors-spki-list=' + pin,
      '--host-resolver-rules=MAP dashboard.canaveral.test ' + mapping + ', MAP *.sites.canaveral-preview.test ' + mapping,
    ]});
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByLabel('Username').fill(accounts[0].username);
    await page.getByLabel('Password', {exact:true}).fill(accounts[0].password);
    await page.getByRole('button',{name:'Sign in'}).click();
    await page.goto(url);
    for (const mode of ['static','command']) {
      const directory = join(privateDir,'upload-'+mode);
      await mkdir(join(directory,'assets','nested'),{recursive:true});
      const marker = randomUUID();
      if (mode === 'static') {
        await writeFile(join(directory,'index.html'), '<script src="/assets/nested/app.js"></script>');
        await writeFile(join(directory,'assets/nested/app.js'), 'window.trial=' + JSON.stringify(marker));
      } else {
        await writeFile(join(directory,'app.cjs'), "require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','text/plain');r.end(q.url)}).listen(3000,'127.0.0.1')");
        await page.getByLabel('Preview type').selectOption(mode);
        await page.getByLabel('Foreground command', {exact:false}).fill('node\napp.cjs');
        await page.getByLabel('HTTP port').fill('3000');
      }
      await page.getByLabel('Workspace directory').setInputFiles(directory);
      const submitted = page.waitForResponse(r => r.url().endsWith('/api/v1/previews') && r.request().method()==='POST');
      await page.getByRole('button',{name:'Launch preview'}).click();
      const {id} = await (await submitted).json();
      assert.ok(id);
      const row = page.getByRole('listitem').filter({hasText:id});
      const spec = {id,mode};
      let origin;
      try {
        await onLaunch(spec);
        await row.getByRole('button',{name:'Inspect'}).click();
        await row.getByRole('button',{name:'Open preview'}).click({timeout:90000});
        await page.waitForURL(u => u.hostname.endsWith('.sites.canaveral-preview.test') && u.pathname==='/');
        origin = new URL(page.url()).origin;
        if (mode === 'static') await page.waitForFunction(v => window.trial === v, marker);
        else {
          const target = '/live?nonce='+marker;
          const response = await page.goto(origin+target);
          assert.equal(response.status(),200);
          assert.equal(await response.text(),target);
        }
      } finally {
        await page.goto(url);
        await row.getByRole('button',{name:'Release'}).click();
        await onCleanup(spec);
        await page.getByRole('button',{name:'Refresh previews'}).click();
        await row.getByText(/· stopped$/).waitFor();
      }
      assert.equal((await page.goto(origin+'/')).status(),404);
      await page.goto(url);
      record(mode);
    }
  } finally {
    await browser?.close();
    ingress.closeAllConnections();
    await new Promise(resolve => ingress.close(resolve));
    dashboard.close();
  }
}
