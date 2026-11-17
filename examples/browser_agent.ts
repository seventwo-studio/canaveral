/** Run beside the agent's own development server, not on the browser worker. */
import { chromium, firefox, webkit } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { BrowserClient } from '../coordination/dist/src/browser-sdk.js';

const origin = process.env.CANAVERAL_BROWSER_ORIGIN, token = process.env.CANAVERAL_BROWSER_TOKEN;
if (!origin || !token) throw new Error('Set CANAVERAL_BROWSER_ORIGIN and CANAVERAL_BROWSER_TOKEN.');
// Persist this identity in your agent's operation store before booting in production.
const id = process.env.CANAVERAL_BROWSER_ID ?? randomUUID();
const client = new BrowserClient(origin, token, { chromium, firefox, webkit });
await using browser = await client.boot({ id, engine: 'chromium', localPorts: [3000], context: { viewport: { width: 1280, height: 800 } } });
const app = await browser.newTab('http://127.0.0.1:3000');
const comparison = await browser.newTab('about:blank');
await browser.evaluate('document.body.textContent = "Comparison tab"', comparison);
await browser.activateTab(app);
const elements = await browser.elements();
await writeFile('browser-elements.json', JSON.stringify(elements, null, 2));
await writeFile('browser.png', await browser.screenshot());
// For interaction: browser.click('button'), browser.clickAt(100, 200),
// browser.drag({ x: 100, y: 200 }, { x: 400, y: 200 }).
// browser.page(app).getByRole('button', { name: 'Save' }).click() also works.
