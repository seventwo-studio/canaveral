import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, bundle, checkDaemonGrace, STAGES, LEASE_HELPER, capture, imageLeaseHelperDigests, releaseIdentity, remoteTag, ensureDraft, IMAGES, DEPLOYMENT, SOURCE, Registry, registryFailure, RegistryUnavailable, publishedManifest, publicationFailure } from './publish_release.mjs';
const sha='a'.repeat(40),other='b'.repeat(40),tag='v0.4.0',version='0.4.0';
const lock={version,packages:{'':{version}}};
const draft={id:1,tag_name:tag,draft:true,target_commitish:sha};
const imageHelpers={amd64:'amd64 helper image bytes',arm64:'arm64 helper image bytes'};
const helperDigests=Object.fromEntries(Object.entries(imageHelpers).map(([arch,bytes])=>[arch,createHash('sha256').update(bytes).digest('hex')]));
test('strict stable versions and package/lock/tag identities fail closed',()=>{
 releaseIdentity(tag,version,lock,sha,sha,sha);
 for(const bad of ['v01.4.0','v0.04.0','v0.4.00','v0.4.0-rc.1','v0.4.0+build','0.4.0','v0.4.0\n',undefined]) assert.throws(()=>releaseIdentity(bad,version,lock,sha,sha,sha));
 for(const args of [[tag,'0.3.4',lock,sha,sha,sha],[tag,version,{...lock,version:'0.3.4'},sha,sha,sha],[tag,version,{version},sha,sha,sha],[tag,version,lock,sha,other,sha],[tag,version,lock,sha,sha,other],[tag,version,lock,sha,sha,undefined],[tag,version,lock,sha,sha,sha,other]])assert.throws(()=>releaseIdentity(...args));
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
function fixture(t,{failAncestry=false,remote=sha,existing=[draft],missing=false,conflict=false,failContent=false,failSignature=false,substituteBuild=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'canaveral-publish-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const {source} of Object.values(STAGES))cpSync(new URL('../'+source,import.meta.url),join(root,source),{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({version}));writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock));
 const previous=process.env.RELEASE_TAG;process.env.RELEASE_TAG=tag;t.after(()=>{if(previous===undefined)delete process.env.RELEASE_TAG;else process.env.RELEASE_TAG=previous;});
 const event=process.env.GITHUB_SHA;process.env.GITHUB_SHA=sha;t.after(()=>{if(event===undefined)delete process.env.GITHUB_SHA;else process.env.GITHUB_SHA=event;});
 const calls=[],manifests=new Map(),signed=new Set(),helpers={...imageHelpers};let rows=existing;
 const manifest=(artifact=false,stage)=>[{annotations:{'org.opencontainers.image.source':conflict?'different':SOURCE,'org.opencontainers.image.version':version,'org.opencontainers.image.revision':artifact?tag+'@sha1:'+sha:sha,...(stage?{'io.canaveral.release.target':stage}:{})},...(artifact?{layers:[{mediaType:'application/vnd.cncf.flux.content.v1.tar+gzip'}]}:{manifests:['amd64','arm64'].map(architecture=>({platform:{os:'linux',architecture}}))})},'sha256:'+'c'.repeat(64)];
 const candidate='candidate-'+version+'-'+sha;
 if(!missing) {
  for(const [stage,name] of Object.entries(IMAGES)) {
   const image=manifest(false,stage); manifests.set(name,image); signed.add(name+'@'+image[1]);
  }
  manifests.set(DEPLOYMENT+':'+candidate,manifest(true));
 }
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
  if(command==='docker') {
   if(args[0]==='buildx'&&args[1]==='build'&&args.includes('--push')) {
    const image=manifest(false,args[args.indexOf('--target')+1]);
    manifests.set(args[args.indexOf('--tag')+1],image);
    writeFileSync(args[args.indexOf('--metadata-file')+1],JSON.stringify({'containerimage.digest':substituteBuild?'sha256:'+'e'.repeat(64):image[1]}));
   }
   if(args[0]==='buildx'&&args[1]==='imagetools') {
    assert.ok(signed.has(args.at(-1)));
    const name=args[4].split(':')[0];
    manifests.set(name,manifests.get(name+':'+candidate));
   }
   if(args[0]==='buildx'&&args[1]==='build'&&args.includes('--output')) {
    assert.deepEqual(args.slice(2,7),['--platform','linux/amd64,linux/arm64','--network','none','--output']);
    const [,output]=/^type=local,dest=(.+),platform-split=true$/.exec(args[7]);
    const reference=IMAGES.canaverald+'@'+manifests.get(IMAGES.canaverald)[1];
    assert.ok(signed.has(reference));
    assert.equal(readFileSync(join(args[8],'Dockerfile'),'utf8'),
      'FROM '+reference+' AS daemon\nFROM scratch\nCOPY --from=daemon '+LEASE_HELPER+' /lease-helper\n');
    for(const [arch,bytes] of Object.entries(helpers)) {
      const directory=join(output,'linux_'+arch);
      mkdirSync(directory,{recursive:true});
      writeFileSync(join(directory,'lease-helper'),bytes);
    }
   }
  }
  if(command==='flux') {
   if(args[0]==='push')manifests.set(DEPLOYMENT+':'+candidate,manifest(true));
   if(args[0]==='diff' && failContent)throw new Error('bundle bytes differ');
   if(args[0]==='tag')manifests.set(DEPLOYMENT+':'+version,manifest(true));
  }
  if(command==='cosign') {
   const reference=args.at(-1);
   if(args[0]==='sign') signed.add(reference);
   else if(reference.startsWith(DEPLOYMENT+'@')) {
    if(failSignature)throw new Error('signature unverified');
   } else if(!signed.has(reference))throw new Error('unverified image signature');
  }
  return '';
 };
 return {root,execute,connect:async name=>({manifest:async ref=>manifests.get(name!==DEPLOYMENT&&ref===version?name:name+':'+ref)??null}),calls,manifests,signed,helpers};
}
const imageBuild=call=>call[0]==='docker'&&call[1]==='buildx'&&call[2]==='build'&&call.includes('--push');
const deploymentVerification=call=>call[0]==='cosign'&&call.at(-1)?.startsWith(DEPLOYMENT+'@');
test('prepare creates draft and missing artifacts; retry reuses digests; finalize alone publishes',async t=>{
 const f=fixture(t,{existing:[],missing:true});await main(false,f);
 assert.equal(f.calls.filter(imageBuild).length,3);assert.equal(f.calls.filter(c=>c[0]==='flux'&&c[1]==='push').length,1);
 assert.ok(f.calls.some(c=>c[0]==='docker' && c.includes('--target') && c[c.indexOf('--target')+1]==='canaverald'));
 assert.equal(f.manifests.has(DEPLOYMENT+':'+version),false);
 assert.ok(!f.calls.some(c=>c[0]==='gh' && ['upload','edit'].includes(c[2])));
 const prepared=JSON.parse(readFileSync(join(f.root,'dist/release.json'),'utf8'));
 assert.equal(prepared.images.canaverald,IMAGES.canaverald+':'+version+'@sha256:'+'c'.repeat(64));
 assert.deepEqual(prepared.libvirtLeaseHelper,{path:LEASE_HELPER,sha256:helperDigests});
 assert.equal(f.calls.filter(c=>c[0]==='docker'&&c.includes('--output')).length,1);
 assert.ok(!f.calls.some(c=>c[0]==='docker'&&['pull','create','cp','rm'].includes(c[1])));
 for(const overlay of ['canaverald','canaverald/vm'])assert.ok(f.calls.some(c=>c[0]==='kubectl' && c[2].endsWith('/bundle/'+overlay)));
 f.calls.length=0;await main(false,f);assert.ok(!f.calls.some(c=>imageBuild(c)||c[0]==='flux'&&c[1]!=='diff'));
 await main(true,f);assert.equal(f.calls.filter(c=>c[0]==='gh' && c[2]==='edit').length,1);
 assert.ok(f.calls.findIndex(c=>c[0]==='cosign')<f.calls.findIndex(c=>c[0]==='flux'&&c[1]==='tag'));
 assert.equal(f.manifests.has(DEPLOYMENT+':'+version),true);
 // A completed release is never reopened, reuploaded or overwritten, even at the same source.
 f.calls.length=0;await assert.rejects(main(false,f),/unfinished draft/);assert.ok(!f.calls.some(c=>['docker','flux'].includes(c[0]) || c[2]==='upload'));
});
test('lease helper export refuses unpinned input and blocks publication if an architecture is missing',async t=>{
 const f=fixture(t);
 assert.throws(()=>imageLeaseHelperDigests(IMAGES.canaverald+':latest',f.root,f.execute),/digest-pinned/);
 assert.equal(f.calls.length,0);
 delete f.helpers.arm64;
 await assert.rejects(main(false,f),/Expected a regular lease helper for linux\/arm64/);
 assert.ok(!f.calls.some(c=>c[0]==='flux'||c[0]==='gh'&&['upload','edit'].includes(c[2])));
});
test('post-push readback tolerates absence without rebuilding or promoting',async t=>{
 const f=fixture(t,{missing:true});let waits=0;
 const connect=f.connect,reads=new Map();
 f.pause=async()=>{waits++;};
 f.connect=async name=>({manifest:async ref=>{
  const found=await (await connect(name)).manifest(ref);
  if(!found)return null;
  const key=name+ref,n=(reads.get(key)??0)+1;reads.set(key,n);
  return n<3?null:found;
 }});
 await main(false,f);
 assert.equal(waits,14);
 assert.equal(f.calls.filter(imageBuild).length,3);
 assert.equal(f.calls.filter(c=>c[0]==='flux'&&c[1]==='push').length,1);
 assert.equal(f.manifests.has(DEPLOYMENT+':'+version),false);
});
test('post-push readback is bounded and refuses authentication or malformed evidence immediately',async()=>{
 let reads=0,waits=0;
 await assert.rejects(publishedManifest(async()=>({manifest:async()=>{reads++;return null;}}),'pkg','tag',async()=>{waits++;}),/six readback attempts/);
 assert.equal(reads,6);assert.equal(waits,5);
 for(const message of ['authentication failed','malformed response']) {
  reads=0;waits=0;
  await assert.rejects(publishedManifest(async()=>({manifest:async()=>{reads++;throw new Error(message);}}),'pkg','tag',async()=>{waits++;}),new RegExp(message));
  assert.equal(reads,1);assert.equal(waits,0);
 }
 reads=0;waits=0;
 const found=[{},'sha256:'+'c'.repeat(64)];
 assert.equal(await publishedManifest(async()=>({manifest:async()=>{reads++;if(reads<3)throw new RegistryUnavailable('Registry transport failed.');return found;}}),'pkg','tag',async()=>{waits++;}),found);
 assert.equal(reads,3);assert.equal(waits,2);
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
test('finalization refuses a canaverald digest that differs from prepared metadata',async t=>{
 const f=fixture(t);await main(false,f);
 const [found]=f.manifests.get(IMAGES.canaverald),changed='sha256:'+'e'.repeat(64);
 f.manifests.set(IMAGES.canaverald,[found,changed]);f.signed.add(IMAGES.canaverald+'@'+changed);
 await assert.rejects(main(true,f),/metadata differs/);
 assert.ok(!f.calls.some(c=>deploymentVerification(c)||c[0]==='flux'&&c[1]==='tag'||c[0]==='gh'&&['upload','edit'].includes(c[2])));
});
test('a candidate differing from Buildx metadata is never signed or promoted',async t=>{
 const f=fixture(t,{missing:true,substituteBuild:true});
 await assert.rejects(main(false,f),/differs from the Buildx output/);
 assert.ok(!f.calls.some(c=>c[0]==='cosign'||c[0]==='docker'&&c[2]==='imagetools'||c[0]==='flux'));
});
test('an existing version image with matching annotations still needs a trusted signature',async t=>{
 const f=fixture(t);f.signed.clear();
 await assert.rejects(main(false,f),/unverified image signature/);
 assert.ok(!f.calls.some(c=>c[0]==='cosign'&&c[1]==='sign'||c[0]==='docker'||c[0]==='flux'));
});
test('a signature for another release target does not authorize image reuse',async t=>{
 const f=fixture(t);
 f.manifests.set(IMAGES.orchestrator,f.manifests.get(IMAGES.canaverald));
 await assert.rejects(main(false,f),/does not match the release target/);
 assert.ok(!f.calls.some(c=>c[0]==='cosign'||c[0]==='docker'||c[0]==='flux'));
});
const images=Object.fromEntries(Object.entries(IMAGES).map(([stage,name])=>[stage,name+':'+version+'@sha256:'+'c'.repeat(64)]));
test('finalization checks both helper digests against the immutable images again',async t=>{
 const f=fixture(t);await main(false,f);
 f.helpers.arm64='different helper bytes';
 await assert.rejects(main(true,f),/metadata differs/);
 assert.ok(!f.calls.some(c=>deploymentVerification(c)||c[0]==='flux'&&c[1]==='tag'||c[0]==='gh'&&['upload','edit'].includes(c[2])));
});
test('the bundle pins the canaverald image in its declared overlays',t=>{
 const output=mkdtempSync(join(tmpdir(),'canaveral-bundle-'));t.after(()=>rmSync(output,{recursive:true,force:true}));
 const result=bundle(version,sha,images,helperDigests,output);
 assert.deepEqual(result.images,images);
 const daemon=JSON.parse(readFileSync(join(output,'canaverald/base/daemonset.json'),'utf8'));
 assert.equal(daemon.spec.template.spec.containers[0].image,images.canaverald);
 assert.equal(daemon.spec.template.metadata.labels['app.kubernetes.io/version'],version);
 for(const name of STAGES.canaverald.files)assert.ok(readFileSync(join(output,'canaverald',name),'utf8'));
 const vm=JSON.parse(JSON.parse(readFileSync(join(output,'canaverald/vm/configmap.json'),'utf8')).data['host.json']);
 assert.equal(vm.leaseHelper,LEASE_HELPER);
 assert.equal(vm.leaseClockHelper,LEASE_HELPER);
 assert.equal(vm.leaseHelperSha256,helperDigests.amd64);
 assert.deepEqual(JSON.parse(readFileSync(join(output,'app-release.json'),'utf8')).libvirtLeaseHelper,result.libvirtLeaseHelper);
 const policy=JSON.parse(readFileSync(join(output,'canaverald/base/admission-policy.json'),'utf8'));
 assert.equal(policy.kind,'ValidatingAdmissionPolicy');
 assert.throws(()=>bundle(version,sha,{orchestrator:images.orchestrator,dashboard:images.dashboard},helperDigests,output),/canaverald images are required/);
});
test('the bundle refuses undeclared daemon sources and an unsafe shutdown budget',t=>{
 const root=mkdtempSync(join(tmpdir(),'canaveral-bundle-source-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repository=new URL('..',import.meta.url).pathname;
 for(const {source} of Object.values(STAGES))cpSync(join(repository,source),join(root,source),{recursive:true});
 const attempt=()=>{const output=mkdtempSync(join(root,'out-'));try{return bundle(version,sha,images,helperDigests,join(output,'bundle'),root);}finally{rmSync(output,{recursive:true,force:true});}};
 attempt();
 writeFileSync(join(root,STAGES.canaverald.source,'vm/extra.json'),'{}');
 assert.throws(attempt,/Only declared deployment sources/);
 rmSync(join(root,STAGES.canaverald.source,'vm/extra.json'));
 const path=join(root,STAGES.canaverald.source,'vm/configmap.json'),config=JSON.parse(readFileSync(path,'utf8'));
 const original=config.data['host.json'];
 config.data['host.json']=JSON.stringify({...JSON.parse(original),leaseHelperSha256:'f'.repeat(64)});
 writeFileSync(path,JSON.stringify(config));
 assert.throws(attempt,/VM ConfigMap template/);
 config.data['host.json']=JSON.stringify({...JSON.parse(original),shutdownGraceSeconds:121});
 writeFileSync(path,JSON.stringify(config));
 assert.throws(attempt,/terminationGracePeriodSeconds minus 30/);
 const daemonSet={spec:{template:{spec:{terminationGracePeriodSeconds:150}}}},host=value=>({data:{'host.json':JSON.stringify(value)}});
 checkDaemonGrace(daemonSet,[host({}),host({shutdownGraceSeconds:120})]);
 assert.throws(()=>checkDaemonGrace({spec:{template:{spec:{}}}},[host({})]),/must set terminationGracePeriodSeconds/);
 assert.throws(()=>checkDaemonGrace({spec:{template:{spec:{terminationGracePeriodSeconds:120}}}},[host({})]),/minus 30/);
});
test('unverified or substituted candidate content never enters the stable feed',async t=>{
 for(const options of [{failContent:true},{failSignature:true}])await t.test(JSON.stringify(options),async t=>{
  const f=fixture(t,options);
  if(options.failContent)await assert.rejects(main(false,f),/bytes differ/);
  else {await main(false,f);await assert.rejects(main(true,f),/signature unverified/);}
  assert.equal(f.manifests.has(DEPLOYMENT+':'+version),false);
  assert.ok(!f.calls.some(c=>c[0]==='flux'&&c[1]==='tag'||c[0]==='gh'&&['upload','edit'].includes(c[2])));
 });
});
test('stable-candidate digest conflicts refuse promotion even with matching annotations',async t=>{
 const f=fixture(t);await main(false,f);
 const candidate=f.manifests.get(DEPLOYMENT+':candidate-'+version+'-'+sha);
 f.manifests.set(DEPLOYMENT+':'+version,[candidate[0],'sha256:'+'d'.repeat(64)]);
 await assert.rejects(main(true,f),/differs from its candidate/);
 assert.ok(!f.calls.some(c=>deploymentVerification(c)||c[0]==='gh'&&['upload','edit'].includes(c[2])));
});
test('subprocess and network failures cannot echo secrets',async t=>{
 assert.throws(()=>capture(process.execPath,['-e','console.error("secret-value");process.exit(7)']),e=>!publicationFailure(e).includes('secret-value')&&publicationFailure(e).includes('exit 7'));
 assert.ok(!publicationFailure(new Error('secret-value')).includes('secret-value'));
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);globalThis.fetch=async()=>{throw new Error('secret-value');};
 await assert.rejects(Registry.get('https://ghcr.io/token','secret-value'),e=>!e.message.includes('secret-value'));
 assert.ok(!registryFailure(new URL('https://ghcr.io/v2/example'),'403',JSON.stringify({errors:[{code:'secret-value',message:'secret-value'}]})).includes('secret-value'));
});
test('workflow keeps tag identity, signing and provenance ahead of final publication',()=>{
 const w=readFileSync(new URL('../.github/workflows/release.yaml',import.meta.url),'utf8');
 assert.match(w,/push:\n    tags: \['v\*'\]/);assert.match(w,/GITHUB_REF" == "refs\/tags\/\$RELEASE_TAG/);
 assert.match(w,/cosign sign --yes --new-bundle-format=false --use-signing-config=false/);
 assert.match(w,/ref: \$\{\{ github.sha \}\}/);
 assert.ok(w.indexOf('Attest deploy provenance')<w.indexOf('cosign sign'));
 assert.ok(w.indexOf('Install Cosign')<w.indexOf('Prepare reviewed images'));
 assert.ok(w.indexOf('cosign sign')<w.indexOf('node script/publish_release.mjs --finalize'));
 assert.ok(!w.slice(w.indexOf('env:'),w.indexOf('concurrency:')).includes('GITHUB_TOKEN'));
 assert.equal((w.match(/actions\/attest-build-provenance@/g)??[]).length,4);
 const daemon=w.slice(w.indexOf('Attest canaverald provenance'),w.indexOf('Attest deploy provenance'));
 assert.match(daemon,/subject-name: ghcr\.io\/seventwo-studio\/canaveral\/canaverald\n/);
 assert.match(daemon,/subject-digest: \$\{\{ steps\.digests\.outputs\.canaverald \}\}/);
 assert.match(w,/canaverald: digest\(r\.images\.canaverald\)/);
 assert.ok(!w.includes('--target canaverald') && !w.includes("'--target', 'canaverald'"));
 assert.match(daemon,/push-to-registry: true/);
});
