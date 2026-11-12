import assert from 'node:assert/strict';

/** argv is passed directly to the guest; no shell or netcat dependency. */
export function proxyProbe(target: string): string[] {
  const request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
  return ['node', '-e', `
const net = require('node:net');
const socket = net.connect(18080, '127.0.0.1', () => socket.write(${JSON.stringify(request)}));
let response = Buffer.alloc(0);
socket.setTimeout(10000, () => socket.destroy(new Error('proxy probe timeout')));
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('data', chunk => {
  response = Buffer.concat([response, chunk]);
  const boundary = response.indexOf('\\r\\n\\r\\n');
  if (boundary < 0) return;
  const header = response.subarray(0, boundary).toString();
  const length = /content-length: (\\d+)/i.exec(header);
  if (length && response.length < boundary + 4 + Number(length[1])) return;
  if (!length && !header.startsWith('HTTP/1.1 200 ')) return;
  process.stdout.write(response);
  socket.destroy();
});
socket.on('end', () => { if (!socket.destroyed) process.stdout.write(response); });
`];
}
export function assertProxy(result: any, status: string, code?: string): void {
  assert.equal(result.state, 'succeeded');
  const output = Buffer.from(result.result.stdoutBase64, 'base64').toString();
  const [headers, body = ''] = output.split('\r\n\r\n');
  assert.equal(headers!.split('\r\n')[0], status);
  if (code) assert.equal(body.trim(), code);
}
