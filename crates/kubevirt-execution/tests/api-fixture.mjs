// Disposable HTTPS API fixture. No cluster tooling or network beyond loopback.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
const dir = process.argv[2];
// Certificates come from an explicit OpenSSL configuration. Ambient configuration is not portable:
// OpenSSL 1.1.1w (the macos-15 runner image's openssl) merges `req -x509 -addext` with the default
// [v3_ca] section and writes duplicate extensions, which OpenSSL, Node and rustls refuse as an
// issuer. So: no -addext, one named extension section per certificate, OPENSSL_CONF pinned.
const conf = join(dir,'openssl.cnf');
writeFileSync(conf,['[req]','distinguished_name = dn','string_mask = utf8only','[dn]','commonName = Common Name (set by -subj)',
 '[ca_ext]','basicConstraints = critical,CA:TRUE','keyUsage = critical,keyCertSign,cRLSign','subjectKeyIdentifier = hash',
 '[leaf_ext]','subjectAltName = DNS:localhost','basicConstraints = critical,CA:FALSE','keyUsage = critical,digitalSignature,keyEncipherment',
 'extendedKeyUsage = serverAuth','subjectKeyIdentifier = hash','authorityKeyIdentifier = keyid,issuer',''].join('\n'));
const env = { ...process.env, OPENSSL_CONF: conf };
for (const name of ['SSL_CERT_FILE','SSL_CERT_DIR','OPENSSL_ENGINES','OPENSSL_MODULES']) delete env[name];
const run = args => execFileSync('openssl', args, { cwd: dir, env, stdio: ['ignore','pipe','pipe'] }).toString();
const selfSigned = (key, cert, subject) => run(['req','-config',conf,'-x509','-extensions','ca_ext','-sha256','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj',subject]);
selfSigned('ca-key.pem','ca.pem','/CN=Fixture CA');
run(['req','-config',conf,'-new','-sha256','-newkey','rsa:2048','-nodes','-keyout','key.pem','-out','leaf.csr','-subj','/CN=localhost']);
run(['x509','-req','-sha256','-in','leaf.csr','-CA','ca.pem','-CAkey','ca-key.pem','-CAcreateserial','-out','cert.pem','-days','1','-extfile',conf,'-extensions','leaf_ext']);
selfSigned('other-key.pem','other-ca.pem','/CN=Untrusted Fixture CA');
// Extension OIDs (hex of the OID body) of a DER certificate, in order and with repeats.
function extensionOids(der) {
 const tlv = o => { let n = der[o+1], h = 2; if (n & 0x80) { const k = n & 0x7f; n = 0; for (let i = 0; i < k; i++) n = n*256 + der[o+2+i]; h += k; }
  if (o+h+n > der.length) throw new Error('truncated certificate DER'); return { tag: der[o], start: o+h, end: o+h+n }; };
 const kids = t => { const out = []; for (let o = t.start; o < t.end; o = out.at(-1).end) out.push(tlv(o)); return out; };
 const ext = kids(kids(tlv(0))[0]).find(c => c.tag === 0xa3);
 return ext ? kids(kids(ext)[0]).map(e => { const oid = kids(e)[0]; return der.subarray(oid.start, oid.end).toString('hex'); }) : [];
}
// Fail closed before serving on an invalid chain, printing public certificate data only (no keys).
const certs = Object.fromEntries(['ca.pem','cert.pem','other-ca.pem'].map(n => [n, new X509Certificate(readFileSync(join(dir,n)))]));
try {
 for (const [n,c] of Object.entries(certs)) { const o = extensionOids(c.raw);
  if (new Set(o).size !== o.length || !['551d13','551d0f','551d0e'].every(x => o.includes(x))) throw new Error(n+' has repeated or missing X.509 extensions'); }
 const ca = certs['ca.pem'], leaf = certs['cert.pem'], other = certs['other-ca.pem'];
 if (JSON.stringify(Object.values(certs).map(c => [c.subject,c.issuer])) !== JSON.stringify([['CN=Fixture CA','CN=Fixture CA'],['CN=localhost','CN=Fixture CA'],['CN=Untrusted Fixture CA','CN=Untrusted Fixture CA']])) throw new Error('unexpected fixture certificate names');
 run(['verify','-x509_strict','-CAfile','ca.pem','-purpose','sslserver','cert.pem']);
 if (!ca.ca || leaf.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey) || leaf.checkIssued(other) || leaf.checkHost('localhost') !== 'localhost') throw new Error('invalid fixture certificate chain');
} catch (error) {
 console.error(`fixture certificate chain rejected (${run(['version']).trim()}, OPENSSL_CONF=fixture): ${error.stderr ?? error.message}`);
 for (const [n,c] of Object.entries(certs)) console.error(`${n}: subject=${JSON.stringify(c.subject)} issuer=${JSON.stringify(c.issuer)} ca=${c.ca} sha256=${c.fingerprint256} extensions=${extensionOids(c.raw).join(',')}\n`
  + run(['x509','-in',n,'-noout','-text','-certopt','no_pubkey,no_sigdump']));
 process.exit(1);
}
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
