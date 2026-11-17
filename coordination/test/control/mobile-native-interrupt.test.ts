import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeMobilePipe } from '../../src/providers/mobile-native.ts';

test('native capture interrupt targets the retained child and requires its graceful zero exit', async () => {
  const pipe = new NodeMobilePipe([process.execPath, '-e', "process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready');setInterval(()=>{},1000)"], { env: {}, timeoutMs: 5000, maxBytes: 65536 });
  try { assert.equal(Buffer.from(await pipe.read(5, 5000)).toString(), 'ready'); await pipe.interrupt(); assert.equal(await pipe.wait(1000), 0); await pipe.interrupt(); }
  finally { await pipe.close(); }
});

test('native capture interrupt refuses an unacknowledged signal termination', async () => {
  const pipe = new NodeMobilePipe([process.execPath, '-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { env: {}, timeoutMs: 5000, maxBytes: 65536 });
  try { await pipe.read(5, 5000); await assert.rejects(pipe.interrupt(), /graceful termination/); }
  finally { await pipe.close(); }
});
