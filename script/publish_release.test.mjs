import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, capture, releaseIdentity, remoteTag, ensureDraft, IMAGES, DEPLOYMENT, SOURCE, Registry, registryFailure } from './publish_release.mjs';
const sha='a'.repeat(40),other='b'.repeat(40),tag='v0.4.0',version='0.4.0';
const lock={version,packages:{'':{version}}};
const draft={id:1,tag_name:tag,draft:true,target_commitish:sha};
test('strict stable versions and package/lock/tag identities fail closed',()=>{
 releaseIdentity(tag,version,lock,sha,sha,sha);
 for(const bad of ['v01.4.0','v0.04.0','v0.4.00','v0.4.0-rc.1','v0.4.0+build','0.4.0','v0.4.0\n',undefined]) assert.throws(()=>releaseIdentity(bad,version,lock,sha,sha,sha));
 for(const args of [[tag,'0.3.4',lock,sha,sha,sha],[tag,version,{...lock,version:'0.3.4'},sha,sha,sha],[tag,version,{version},sha,sha,sha],[tag,version,lock,sha,other,sha],[tag,version,lock,sha,sha,other],[tag,version,lock,sha,sha,undefined]])assert.throws(()=>releaseIdentity(...args));
 assert.equal(remoteTag(`${other}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}`,tag),sha);
 assert.equal(remoteTag(`${sha}\trefs/tags/${tag}`,tag),sha);
 assert.equal(remoteTag('',tag),undefined);
});
test('missing draft is created for exact commit and reloaded; conflicts never create',()=>{
 const calls=[];assert.deepEqual(ensureDraft([[]],tag,sha,args=>calls.push(args),()=>[[draft]]),draft);
 assert.deepEqual(calls[0],['release','create',tag,'--verify-tag','--draft','--target',sha,'--title',tag,'--notes','Release metadata and signed deployment artifact are prepared by the release workflow.']);
 for(const rows of [[draft,draft],[{...draft,draft:false}],[{...draft,target_commitish:'main'}],[{...draft,target_commitish:other}]])assert.throws(()=>ensureDraft([rows],tag,sha,()=>assert.fail('created conflicting release'),()=>assert.fail('reloaded conflict')));
 assert.throws(()=>ensureDraft([[]],tag,sha,()=>{},()=>[[{...draft,draft:false}]]));
});
function fixture(t,{failAncestry=false,remote=sha,existing=[draft],missing=false,conflict=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'canaveral-publish-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'package.json'),JSON.stringify({version}));writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock));
 const previous=process.env.RELEASE_TAG;process.env.RELEASE_TAG=tag;t.after(()=>{if(previous===undefined)delete process.env.RELEASE_TAG;else process.env.RELEASE_TAG=previous;});
 const calls=[],manifests=new Map();let rows=existing;
 const manifest=(artifact=false)=>[{annotations:{'org.opencontainers.image.source':conflict?'different':SOURCE,'org.opencontainers.image.version':version,'org.opencontainers.image.revision':artifact?tag+'@sha1:'+sha:sha},...(artifact?{layers:[{mediaType:'application/vnd.cncf.flux.content.v1.tar+gzip'}]}:{manifests:['amd64','arm64'].map(architecture=>({platform:{os:'linux',architecture}}))})},'sha256:'+'c'.repeat(64)];
 if(!missing)for(const name of [...Object.values(IMAGES),DEPLOYMENT])manifests.set(name,manifest(name===DEPLOYMENT));
 const execute=(command,args)=>{
  calls.push([command,...args]);
  if(command==='git') {
   if(args[0]==='rev-parse')return sha;
   if(args[0]==='ls-remote')return `${remote}\trefs/tags/${tag}`;
   if(args[0]==='merge-base' && failAncestry)throw new Error('not main');
  }
  if(command==='gh') {
   if(args[0]==='api')return JSON.stringify([rows]);
   if(args[1]==='create')rows=[draft];
   if(args[1]==='edit')rows=[{...draft,draft:false}];
  }
  if(command==='docker')manifests.set(args[args.indexOf('--tag')+1].split(':')[0],manifest());
  if(command==='flux')manifests.set(DEPLOYMENT,manifest(true));
  return '';
 };
 return {root,execute,connect:async name=>({manifest:async()=>manifests.get(name)??null}),calls,manifests};
}
test('prepare creates draft and missing artifacts; retry reuses digests; finalize alone publishes',async t=>{
 const f=fixture(t,{existing:[],missing:true});await main(false,f);
 assert.equal(f.calls.filter(c=>c[0]==='docker').length,3);assert.equal(f.calls.filter(c=>c[0]==='flux').length,1);
 assert.ok(!f.calls.some(c=>c[0]==='gh' && ['upload','edit'].includes(c[2])));
 f.calls.length=0;await main(false,f);assert.ok(!f.calls.some(c=>['docker','flux'].includes(c[0])));
 await main(true,f);assert.equal(f.calls.filter(c=>c[0]==='gh' && c[2]==='edit').length,1);
 // A completed release is never reopened, reuploaded or overwritten, even at the same source.
 f.calls.length=0;await assert.rejects(main(false,f),/unfinished draft/);assert.ok(!f.calls.some(c=>['docker','flux'].includes(c[0]) || c[2]==='upload'));
});
test('non-main, moved remote tag, conflicting release and foreign image stop publication',async t=>{
 for(const options of [{failAncestry:true},{remote:other},{existing:[{...draft,draft:false}]},{existing:[{...draft,target_commitish:other}]},{existing:[draft,draft]},{conflict:true}])await t.test(JSON.stringify(options),async t=>{
  const f=fixture(t,options);await assert.rejects(main(false,f));assert.ok(!f.calls.some(c=>['docker','flux'].includes(c[0]) || (c[0]==='gh' && c[1]==='release')));
 });
});
test('finalization rejects missing artifacts and changed prepared metadata without publication',async t=>{
 const f=fixture(t,{missing:true});await assert.rejects(main(true,f),/missing image/);await main(false,f);
 writeFileSync(join(f.root,'dist/release.json'),'{}');await assert.rejects(main(true,f),/metadata differs/);
 assert.ok(!f.calls.some(c=>c[0]==='gh' && ['upload','edit'].includes(c[2])));
});
test('subprocess and network failures cannot echo secrets',async t=>{
 assert.throws(()=>capture(process.execPath,['-e','console.error("secret-value");process.exit(1)']),e=>!e.message.includes('secret-value'));
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);globalThis.fetch=async()=>{throw new Error('secret-value');};
 await assert.rejects(Registry.get('https://ghcr.io/token','secret-value'),e=>!e.message.includes('secret-value'));
 assert.ok(!registryFailure(new URL('https://ghcr.io/v2/example'),'403',JSON.stringify({errors:[{code:'secret-value',message:'secret-value'}]})).includes('secret-value'));
});
test('workflow keeps tag identity, signing and provenance ahead of final publication',()=>{
 const w=readFileSync(new URL('../.github/workflows/release.yaml',import.meta.url),'utf8');
 assert.match(w,/push:\n    tags: \['v\*'\]/);assert.match(w,/GITHUB_REF" == "refs\/tags\/\$RELEASE_TAG/);
 assert.match(w,/cosign sign --yes --new-bundle-format=false --use-signing-config=false/);
 assert.match(w,/cosign verify --new-bundle-format=false --certificate-oidc-issuer https:\/\/token.actions.githubusercontent.com --certificate-identity "\$identity"/);
 assert.ok(w.indexOf('cosign verify')<w.indexOf('Attest deploy provenance'));assert.ok(w.indexOf('Attest deploy provenance')<w.indexOf('node script/publish_release.mjs --finalize'));
 assert.equal((w.match(/actions\/attest-build-provenance@/g)??[]).length,4);
});
