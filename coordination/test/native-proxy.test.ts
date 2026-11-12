import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import test from 'node:test';
import {proxyProbe,assertProxy} from '../native-acceptance/proxy.ts';

test('guest Node probe sends CRLF and captures fragmented status and body',async()=>{
  const server=net.createServer(socket=>{
    let received='';
    socket.on('data',chunk=>{
      received+=chunk.toString();
      if(!received.endsWith('\r\n\r\n')) return;
      assert.equal(received,'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 13\r\n\r\negress_');
      setTimeout(()=>socket.end('denied'),10);
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const port=(server.address() as net.AddressInfo).port;
    const argv=proxyProbe('github.com:443');
    const child=spawn(process.execPath,['-e',argv[2]!.replace("net.connect(18080,",`net.connect(${port},`)]);
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const [exit]=await once(child,'close');assert.equal(exit,0,stderr);
    assertProxy({state:'succeeded',result:{stdoutBase64:Buffer.from(stdout).toString('base64')}},'HTTP/1.1 403 Forbidden','egress_denied');
  } finally {server.close();await once(server,'close');}
});
