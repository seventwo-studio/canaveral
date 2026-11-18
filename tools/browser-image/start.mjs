import { readFileSync } from 'node:fs';
import { createBrowserRuntime } from './browser-runtime.ts';
import { launchIsolatedBrowser } from './launcher-client.mjs';

const credential = name => readFileSync(process.env.CREDENTIALS_DIRECTORY + '/' + name, 'utf8').trim();
const publicOrigin = credential('origin');
if (new URL(publicOrigin).protocol !== 'https:') throw new Error('Worker origin requires HTTPS');
const runtime = createBrowserRuntime({ token: credential('token'), publicOrigin, launch: launchIsolatedBrowser });
runtime.server.listen(9333, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void runtime.close());
