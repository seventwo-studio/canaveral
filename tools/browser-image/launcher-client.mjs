import { createConnection } from 'node:net';
import { lines } from './launch-protocol.mjs';

export async function launchIsolatedBrowser(engine, localPorts) {
  const socket = createConnection('/run/canaveral-browser-launch.sock');
  const input = lines(socket);
  const timeout = () => socket.destroy(new Error('Launcher timed out'));
  socket.setTimeout(35_000, timeout);
  try {
    socket.write(JSON.stringify({ engine, localPorts }) + '\n');
    const endpoint = (await input.next()).value;
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/[\da-f-]{36}$/.test(endpoint)) throw new Error('Invalid launcher endpoint');
    socket.setTimeout(0);
    return {
      wsEndpoint: () => endpoint,
      async close() {
        try {
          socket.setTimeout(15_000);
          socket.write('close\n');
          if ((await input.next()).value !== 'closed') throw new Error('Browser cleanup unconfirmed');
        } finally { socket.destroy(); }
      },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
