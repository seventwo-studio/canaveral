/** Operator-started standalone browser worker; does not enroll a Canaveral host. */
import { createBrowserRuntime } from '../coordination/dist/src/browser-runtime.js';
import { launchPlaywrightBrowser } from '../coordination/dist/src/browser-playwright.js';

const token = process.env.CANAVERAL_BROWSER_TOKEN;
const publicOrigin = process.env.CANAVERAL_BROWSER_ORIGIN;
if (!token || !publicOrigin) throw new Error('Set CANAVERAL_BROWSER_TOKEN and CANAVERAL_BROWSER_ORIGIN.');
const port = Number(process.env.CANAVERAL_BROWSER_PORT ?? 9333);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser worker port.');
const runtime = createBrowserRuntime({ token, publicOrigin, launch: launchPlaywrightBrowser });
runtime.server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void runtime.close().catch(() => { process.exitCode = 1; });
});
