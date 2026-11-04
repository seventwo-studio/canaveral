// Disposable HTTPS API fixture. No cluster tooling or network beyond loopback.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:https';
const dir = process.argv[2];
const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca-key.pem','-out','ca.pem','-days','1','-subj','/CN=Fixture CA','-addext','basicConstraints=critical,CA:TRUE']);
run(['req','-newkey','rsa:2048','-nodes','-keyout','key.pem','-out','leaf.csr','-subj','/CN=localhost']);
writeFileSync(join(dir,'ext.cnf'),'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
run(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','cert.pem','-days','1','-extfile','ext.cnf']);
run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','other-key.pem','-out','other-ca.pem','-days','1','-subj','/CN=Untrusted Fixture CA']);
const objects = new Map(); const lost = new Set(); let serial = 0, redirects = 0, reviews = 0, resourceRequests = 0;
const prefix = '/api/v1/namespaces/fixture/';
const server = createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))}, (req,res) => {
 const url = new URL(req.url, 'https://localhost');
 const route = url.pathname;
 const reply = (status,value) => { res.writeHead(status,{'content-type':'application/json'}); res.end(JSON.stringify(value)); };
 if (req.headers.authorization !== 'Bearer fixture-token') return reply(401,{});
 if (req.url.endsWith('/timeout')) return;
 if (req.url.endsWith('/oversize')) return res.end('x'.repeat(1048577));
 if (req.url.endsWith('/redirect')) { redirects++; res.writeHead(307,{location:prefix+'pods/leaked'}); return res.end('{}'); }
 if (req.url.endsWith('/leaked')) return reply(200,{redirects});
 let bytes = ''; req.on('data',b=>bytes+=b); req.on('end',()=> {
  if (route === '/apis/authentication.k8s.io/v1/selfsubjectreviews') { reviews++; return reply(201,{status:{userInfo:{username:'system:serviceaccount:fixture:guest'}}}); }
  if (route.endsWith('/audit')) return reply(200,{reviews, resourceRequests});
  resourceRequests++;
  if (req.method === 'POST') {
   if (Number(req.headers['content-length']) !== Buffer.byteLength(bytes)) return reply(400,{});
   const value=JSON.parse(bytes); const key=req.url+'/'+value.metadata.name;
   if (objects.has(key)) return reply(409,{});
   value.metadata.uid='uid-'+(++serial); value.metadata.annotations['server.example/added']='admission'; objects.set(key,value);
   if (!lost.has(value.kind)) {lost.add(value.kind); return res.destroy();}
   return reply(201,value);
  }
  if (req.method === 'DELETE') {
   const old=objects.get(req.url); if (!old) return reply(404,{});
   if (JSON.parse(bytes).preconditions.uid !== old.metadata.uid) return reply(409,{});
   objects.delete(req.url); return reply(202,{});
  }
  if (req.url.endsWith('/volumesnapshots/base')) return reply(200,{metadata:{namespace:'fixture',name:'base',uid:'snapshot-uid'},status:{readyToUse:true}});
  if (objects.has(req.url)) return reply(200,objects.get(req.url));
  if (route.endsWith('/pods') || route.endsWith('/virtualmachineinstances')) {
   if (req.headers.accept !== 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1' || url.searchParams.get('limit') !== '100') return reply(400,{});
   const start = Number((url.searchParams.get('continue') || 'offset:0/+==').split(':')[1].split('/')[0]);
   const total = route.endsWith('/pods') ? 350 : 0;
   const end = Math.min(start + 100, total);
   const items = Array.from({length:end-start}, (_,n)=>({apiVersion:'meta.k8s.io/v1',kind:'PartialObjectMetadata',metadata:{namespace:'fixture',name:'unrelated-'+(start+n),uid:'unrelated-'+(start+n),annotations:{'server.example/padding':'x'.repeat(4000)},ownerReferences:[{apiVersion:'apps/v1',kind:'ReplicaSet',name:'other',uid:'other',controller:true}]}}));
   return reply(200,{apiVersion:'meta.k8s.io/v1',kind:'PartialObjectMetadataList',metadata:{resourceVersion:'1',continue:end < total ? `offset:${end}/+==` : ''},items});
  }
  return reply(404,{});
 });
});
server.listen(0,'127.0.0.1',()=>console.log(`https://localhost:${server.address().port}/`));
