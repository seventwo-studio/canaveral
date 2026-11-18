import { Socket } from 'node:net';
import { launchPlaywrightBrowser } from './browser-playwright.ts';
import { lines } from './launch-protocol.mjs';

const socket = new Socket({ fd: 0, readable: true, writable: true });
const input = lines(socket);
const { engine, localPorts } = JSON.parse((await input.next()).value);
if (!['chromium', 'firefox', 'webkit'].includes(engine) || !Array.isArray(localPorts) ||
    localPorts.length > 32 || localPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
  throw new Error('Invalid launch request');
}
const browser = await launchPlaywrightBrowser(engine, localPorts);
socket.write(browser.wsEndpoint() + '\n');
const command = await input.next();
await browser.close();
if (command.value === 'close') socket.end('closed\n');
else socket.destroy();
