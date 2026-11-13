import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_BYTES,SECTIONS,compare,load,main,validate } from './check_retention.mjs';
import { PACKAGE,SOURCE,IMAGES,bundle,checkIdentity,draftRelease,Registry } from './publish_release.mjs';
import { inspectArtifact } from './build_android_transfer.mjs';
import { violations,scan } from './check_no_python.mjs';
import { uniqueJSON } from './json.mjs';

function directory(t) {const root=mkdtempSync(join(tmpdir(),'canaveral-tools-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function evidence() {
 const resources={cpu:2,memoryMiB:2048,diskGiB:8},fingerprint=createHash('sha256').update('fixture metadata').digest('hex');
 return {schema:'canaveral-retention-v1',capturedAt:1000,stable:{machineAssignments:{machine:{hostId:'host',resources,template:{id:'linux',revision:'1',arch:'arm64'},desired:'running'}},imageInventory:{'host/linux/1/arm64':{hostId:'host',id:'linux',revision:'1',arch:'arm64'}},nativeBootReceipts:{machine:fingerprint},hostBudgets:{host:{cpu:8,memoryMiB:8192,diskGiB:32}},sharedBudgets:{},reservations:{host:{...resources}},configurationHashes:{hostConfiguration:fingerprint}},observations:{consumerLeaseIds:[],liveCleanupIntentIds:[]}};
}
function pair(){const before=evidence(),after=structuredClone(before);after.capturedAt++;return [before,after];}
test('retention comparison is order independent and does not mutate evidence',()=>{
 const [before,after]=pair();after.stable=Object.fromEntries(Object.entries(after.stable).reverse());const saved=structuredClone([before,after]);
 assert.equal(compare(before,after).retentionMatches,true);assert.deepEqual([before,after],saved);
});
test('every retained section reports changes without private values',()=>{
 for(const section of SECTIONS) {
  const [before,after]=pair(),items=after.stable[section];
  if(section==='sharedBudgets') items.pool={capacity:{cpu:8,memoryMiB:8192,diskGiB:32},hostIds:['host']};
  else if(['nativeBootReceipts','configurationHashes'].includes(section)) items[Object.keys(items)[0]]='a'.repeat(64);
  else if(section==='machineAssignments') items.machine.desired='stopped';
  else if(section==='imageInventory') items[Object.keys(items)[0]].revision='2';
  else items.host.diskGiB++;
  const result=compare(before,after);assert.equal(result.retentionMatches,false);assert.deepEqual(result.changedSections,[section]);assert.ok(!JSON.stringify(result).includes('fixture'));
 }
});
test('same-count replacement and additions are not retention',()=>{
 for(const replacement of [false,true]) {
  const [before,after]=pair();after.stable.machineAssignments.other=structuredClone(after.stable.machineAssignments.machine);
  if(replacement){delete after.stable.machineAssignments.machine;after.stable.nativeBootReceipts={other:'a'.repeat(64)};}
  assert.ok(compare(before,after).changedSections.includes('machineAssignments'));
 }
});
test('missing sections, partial assignments and invalid numbers cannot establish retention',()=>{
 for(const section of SECTIONS) for(const empty of [false,true]) {
  if(section==='sharedBudgets' && empty) continue;
  const value=evidence();if(empty)value.stable[section]={};else delete value.stable[section];assert.throws(()=>validate(value));
 }
 for(const value of [{verified:true},{},{schema:'canaveral-retention-v1'}])assert.throws(()=>validate(value));
 for(const amount of [true,-1,1.5,NaN,Infinity]) {const value=evidence();value.stable.reservations.host.diskGiB=amount;assert.throws(()=>validate(value));}
 for(const change of [v=>v.stable.machineAssignments.machine.template={},v=>v.stable.configurationHashes.hostConfiguration='missing',v=>{v.stable.reservations.other=v.stable.reservations.host;delete v.stable.reservations.host;},v=>v.stable.nativeBootReceipts.other='a'.repeat(64),v=>v.observations.consumerLeaseIds=['a','a']]) {const value=evidence();change(value);assert.throws(()=>validate(value));}
});
test('active leases, cleanup intents and capture rollback block retention without exposing IDs',()=>{
 for(const field of ['consumerLeaseIds','liveCleanupIntentIds']) for(const which of [0,1]) {const p=pair();p[which].observations[field]=['private-id'];const result=compare(...p);assert.equal(result.retentionMatches,false);assert.ok(!JSON.stringify(result).includes('private-id'));}
 for(const stamp of [999,1000]) {const p=pair();p[1].capturedAt=stamp;assert.ok(compare(...p).reasonCodes.includes('after_not_later_than_before'));}
});
test('offline retention CLI preserves input and uses match/change/invalid exits',t=>{
 const root=directory(t),paths=['before','after'].map(n=>join(root,n)),p=pair();p.forEach((v,i)=>writeFileSync(paths[i],JSON.stringify(v)));
 const saved=paths.map(path=>readFileSync(path));let output;const print=text=>output=JSON.parse(text);
 assert.equal(main(paths,print),0);assert.equal(output.retentionMatches,true);assert.deepEqual(paths.map(path=>readFileSync(path)),saved);
 p[1].stable.machineAssignments.machine.desired='stopped';writeFileSync(paths[1],JSON.stringify(p[1]));assert.equal(main(paths,print),1);
 writeFileSync(paths[1],'{"private-field":');assert.equal(main(paths,print),2);assert.ok(!JSON.stringify(output).includes(root));assert.ok(!JSON.stringify(output).includes('private-field'));
});
test('bounded evidence parser rejects duplicates, nonfinite numbers, symlinks and nonregular files',t=>{
 const root=directory(t),path=join(root,'evidence');
 for(const raw of ['{"schema":1,"schema":2}','{"x":{"a":1,"\\u0061":2}}','{"x":1e999}']) {writeFileSync(path,raw);assert.throws(()=>load(path));}
 writeFileSync(path,'');truncateSync(path,MAX_BYTES+1);assert.throws(()=>load(path));assert.throws(()=>load(root));
 if(process.platform!=='win32') {symlinkSync(path,join(root,'link'));assert.throws(()=>load(join(root,'link')));const fifo=join(root,'fifo');const result=spawnSync('mkfifo',[fifo]);assert.equal(result.status,0);assert.throws(()=>load(fifo));}
 assert.deepEqual(uniqueJSON('{"a":[true,false,null,{"b":2}]}'),{a:[true,false,null,{b:2}]});
 assert.throws(()=>uniqueJSON('{"a":1,}'));assert.throws(()=>uniqueJSON('[1,]'));
});
const images=()=>Object.fromEntries(Object.entries(IMAGES).map(([stage,p],i)=>[stage,p+':0.1.0@sha256:'+String.fromCharCode(97+i).repeat(64)]));
test('draft discovery requires one exact reviewed unfinished target',()=>{
 const release={id:1,tag_name:'v0.1.1',draft:true,target_commitish:'c'.repeat(40)};
 assert.equal(draftRelease([[],[release]],release.tag_name,release.target_commitish),release);
 for(const pages of [[],[[release,release]],[[{...release,draft:false}]],[[{...release,target_commitish:'d'.repeat(40)}]],[[{...release,tag_name:'v0.1.0'}]]]) assert.throws(()=>draftRelease(pages,release.tag_name,release.target_commitish));
});
test('release bundle preserves optional stage, protected storage and scoped pod permissions',t=>{
 const root=directory(t),metadata=bundle('0.1.0','c'.repeat(40),images(),root);
 assert.deepEqual(metadata.images,images());assert.equal(metadata.source,SOURCE);assert.deepEqual(readdirSync(root).sort(),['app-release.json','dashboard','kubevirt','orchestrator']);
 for(const stage of ['orchestrator','dashboard','kubevirt']) for(const name of readdirSync(join(root,stage)).filter(n=>n.endsWith('.json'))) {
  const value=JSON.parse(readFileSync(join(root,stage,name)));assert.equal(value.metadata.namespace,undefined);assert.ok(!['Secret','Namespace'].includes(value.kind));
  if(['Deployment','StatefulSet'].includes(value.kind)) {
   const pod=value.spec.template.spec;if(stage!=='kubevirt')assert.equal(pod.automountServiceAccountToken,false);assert.equal(pod.containers[0].image,images()[stage]);for(const init of pod.initContainers??[])assert.equal(init.image,images()[stage]);
   assert.equal(pod.securityContext.seccompProfile.type,'RuntimeDefault');assert.equal(pod.securityContext.runAsNonRoot,true);assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation,false);
   if(stage==='dashboard')assert.ok(!pod.volumes?.some(v=>v.secret));
  }
  if(value.kind==='PersistentVolumeClaim')assert.equal(value.metadata.annotations['kustomize.toolkit.fluxcd.io/prune'],'disabled');
 }
});
test('release refuses mutable, wrong-package and wrong-version images plus occupied output',t=>{
 const root=directory(t);let i=0;
 for(const value of [{orchestrator:PACKAGE+':latest',dashboard:images().dashboard},{...images(),dashboard:PACKAGE+'-dashboard:0.2.0@sha256:'+'b'.repeat(64)},{...images(),kubevirt:PACKAGE+'-kubevirt:latest'},{...images(),kubevirt:images().dashboard}])assert.throws(()=>bundle('0.1.0','c'.repeat(40),value,join(root,String(i++))));
 writeFileSync(join(root,'unreviewed'),'');assert.throws(()=>bundle('0.1.0','c'.repeat(40),images(),root));
});
test('release rejects undeclared or symlinked deployment inputs',t=>{
 const root=directory(t);for(const stage of ['orchestrator','dashboard','kubevirt']) {const d=join(root,'deploy',stage);mkdirSync(d,{recursive:true});for(const name of readdirSync(new URL('../deploy/'+stage+'/',import.meta.url)))copyFileSync(new URL('../deploy/'+stage+'/'+name,import.meta.url),join(d,name));}
 writeFileSync(join(root,'deploy/dashboard/extra'),'unreviewed');assert.throws(()=>bundle('0.1.0','c'.repeat(40),images(),join(root,'out'),root));
});
test('publication identity checks source, version, revision, both architectures and Flux layer',()=>{
 const manifest={annotations:{'org.opencontainers.image.source':SOURCE,'org.opencontainers.image.version':'0.1.0','org.opencontainers.image.revision':'c'.repeat(40)},manifests:['amd64','arm64'].map(architecture=>({platform:{os:'linux',architecture}}))};
 checkIdentity(manifest,'0.1.0','c'.repeat(40));assert.throws(()=>checkIdentity(manifest,'0.1.0','d'.repeat(40)));
 for(const key of Object.keys(manifest.annotations)) {const changed=structuredClone(manifest);changed.annotations[key]='other';assert.throws(()=>checkIdentity(changed,'0.1.0','c'.repeat(40)));}
 assert.throws(()=>checkIdentity({...manifest,manifests:manifest.manifests.slice(0,1)},'0.1.0','c'.repeat(40)));
 const artifact={...manifest,layers:[{mediaType:'application/vnd.cncf.flux.content.v1.tar+gzip'}]};checkIdentity(artifact,'0.1.0','c'.repeat(40),true);
 assert.throws(()=>checkIdentity({...artifact,layers:[...artifact.layers,...artifact.layers]},'0.1.0','c'.repeat(40),true));
});
test('registry verifies content digests and refuses credential redirects',async t=>{
 const original=Registry.get;t.after(()=>Registry.get=original);const raw=Buffer.from('{"annotations":{}}'),digest='sha256:'+createHash('sha256').update(raw).digest('hex');
 Registry.get=async()=>[raw,new Headers({'Docker-Content-Digest':digest})];const registry=new Registry(PACKAGE,'Bearer fixture');assert.deepEqual(await registry.manifest('0.1.0'),[{annotations:{}},digest]);
 Registry.get=async()=>[raw,new Headers({'Docker-Content-Digest':'sha256:'+'0'.repeat(64)})];await assert.rejects(registry.manifest('0.1.0'),/digest/);
 Registry.get=async()=>{const e=new Error();e.status=404;throw e;};assert.equal(await registry.manifest('0.1.0'),null);
 await assert.rejects(original('https://example.invalid/','Bearer fixture'),/origin/);
});
test('Android artifact inspection enforces ELF architecture and excludes injected fault paths',()=>{
 const raw=Buffer.alloc(64);Buffer.from([127,69,76,70,2,1]).copy(raw);raw.writeUInt16LE(183,18);
 assert.equal(inspectArtifact(raw,183).bytes,64);assert.throws(()=>inspectArtifact(raw,62));assert.throws(()=>inspectArtifact(raw.subarray(0,19),183));
 assert.throws(()=>inspectArtifact(Buffer.concat([raw,Buffer.from('CANAVERAL_TRANSFER_TEST_FAIL')]),183));
});
test('Android builder uses installed fixture compiler, validates both ABIs and emits checksums',t=>{
 const root=directory(t),system={darwin:'darwin',linux:'linux',win32:'windows'}[process.platform];
 assert.ok(system);const bin=join(root,'ndk/toolchains/llvm/prebuilt',system+'-x86_64','bin');mkdirSync(bin,{recursive:true});
 if(process.platform==='win32') {const r=spawnSync(process.execPath,['script/build_android_transfer.mjs','--ndk',root],{encoding:'utf8'});assert.equal(r.status,1);return;}
 const compiler=join(bin,'clang');writeFileSync(compiler,`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2),b=Buffer.alloc(64);Buffer.from([127,69,76,70,2,1]).copy(b);b.writeUInt16LE(a.some(x=>x.includes('aarch64'))?183:62,18);fs.writeFileSync(a[a.indexOf('-o')+1],b);\n`);chmodSync(compiler,0o755);
 const out=join(root,'output with spaces'),r=spawnSync(process.execPath,['script/build_android_transfer.mjs','--ndk',join(root,'ndk'),'--output-dir',out],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const manifest=JSON.parse(readFileSync(join(out,'manifest.json')));assert.equal(manifest.minimumAPI,26);for(const [arch,machine]of[['arm64',183],['amd64',62]]) {const record=manifest.artifacts[arch];assert.deepEqual(inspectArtifact(readFileSync(join(out,record.file)),machine),{sha256:record.sha256,bytes:record.bytes});}
});
test('deadline builder refuses unsupported host or occupied destination before compiler invocation',t=>{
 const root=directory(t),out=join(root,'deadline.so');writeFileSync(out,'retained');
 const r=spawnSync(process.execPath,['script/build_linux_lease_deadline.mjs','--output',out],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(readFileSync(out,'utf8'),'retained');assert.match(r.stderr,/Linux|retained/);
});
test('dependency scanner detects forbidden extensions, shebangs and embedded source without executing it',t=>{
 const interpreter=['py','thon'].join(''),extension=['.','py'].join('');
 assert.ok(violations('source'+extension,'').length);assert.ok(violations('source'+extension+'c','').length);assert.ok(violations('source'+extension+'o','').length);
 for(const code of ['#!/usr/bin/env '+interpreter+'3',interpreter+'3 -c "pass"','"'+['im','port'].join('')+' os\\n'+['de','f'].join('')+' run():\\n pass"'])assert.ok(violations('source.rs',code).length);
 assert.deepEqual(violations('source.ts','import { readFileSync } from "node:fs";'),[]);
 const root=directory(t);assert.equal(spawnSync('git',['init','--quiet',root]).status,0);writeFileSync(join(root,'bad'+extension),'');assert.ok(scan(root).length);rmSync(join(root,'bad'+extension));assert.deepEqual(scan(root),[]);
});
test('optional remote acceptance refuses cleartext and emits no credential or private path',()=>{
 const r=spawnSync(process.execPath,['script/check_remote_tls.mjs','--url','http://controller.invalid','--token-file','/private/fixture-token'],{encoding:'utf8',env:{...process.env,CANAVERAL_ACCEPTANCE_TOKEN:'private-secret'}});
 assert.equal(r.status,1);assert.ok(!r.stderr.includes('private-secret'));assert.ok(!r.stderr.includes('/private/fixture-token'));
});
test('npm executable finalization adds one Node shebang and executable permissions',async t=>{
 const {prepareCli}=await import('./prepare_cli.mjs'),root=directory(t),cli=join(root,'cli.js');
 writeFileSync(cli,'console.log("fixture");\n');prepareCli(cli);prepareCli(cli);
 assert.equal(readFileSync(cli,'utf8'),'#!/usr/bin/env node\nconsole.log("fixture");\n');
 if(process.platform!=='win32') assert.equal(lstatSync(cli).mode&0o777,0o755);
});
test('native packaging breaks Cargo artifact hardlinks before owned runtime admission',async t=>{
 const {prepareNative}=await import('./prepare_native.mjs'),root=directory(t),build=join(root,'target/debug');
 mkdirSync(build,{recursive:true});const suffix=process.platform==='win32'?'.exe':'';
 for(const name of ['canaveral-mobile-native','apple-native-helper']) {
  const source=join(build,name+suffix);writeFileSync(source,Buffer.from('compiled fixture '+name));
  linkSync(source,source+'.cargo-artifact');assert.equal(lstatSync(source).nlink,2);
 }
 prepareNative(root);
 const manifest=JSON.parse(readFileSync(join(root,'native/runtime.json')));
 for(const name of ['canaveral-mobile-native','apple-native-helper']) {
  const installed=join(root,'native',name+suffix),bytes=readFileSync(installed),source=join(build,name+suffix);
  assert.equal(lstatSync(installed).nlink,1);
  assert.deepEqual(manifest.artifacts[name],{file:name+suffix,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  writeFileSync(source+'.cargo-artifact','changed build output');assert.deepEqual(readFileSync(installed),bytes);
  if(process.platform!=='win32')assert.equal(lstatSync(installed).mode&0o777,0o755);
 }
});
test('controller and worker stage Secret credentials as private regular files',()=>{
 for(const [path,files] of [['../deploy/orchestrator/deployment.json',['admin.token','enrollment.token']],['../deploy/kubevirt/statefulset.json',['enrollment.token']]]) {
  const pod=JSON.parse(readFileSync(new URL(path,import.meta.url))).spec.template.spec,[init]=pod.initContainers,main=pod.containers[0];
  assert.equal(pod.securityContext.fsGroupChangePolicy,'OnRootMismatch');assert.equal(pod.initContainers.length,1);assert.equal(init.image,main.image);assert.deepEqual(init.securityContext,main.securityContext);
  assert.deepEqual(init.command,['install','-m','0600','-t','/run/credentials',...files.map(f=>'/run/credential-source/'+f)]);
  assert.ok(pod.volumes.some(v=>v.name==='credentials' && v.emptyDir?.medium==='Memory'));assert.ok(pod.volumes.some(v=>v.name==='credential-source' && v.secret));
  assert.ok(main.volumeMounts.some(v=>v.name==='credentials' && v.mountPath==='/run/credentials' && v.readOnly));assert.ok(!main.volumeMounts.some(v=>v.name==='credential-source'));
 }
});
test('KubeVirt deployment keeps restricted pods, namespace-scoped observation and durable identity',()=>{
 const load=name=>JSON.parse(readFileSync(new URL('../deploy/kubevirt/'+name+'.json',import.meta.url)));
 const pod=load('statefulset').spec.template.spec,container=pod.containers[0];
 assert.deepEqual(pod.securityContext,{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,fsGroupChangePolicy:'OnRootMismatch',seccompProfile:{type:'RuntimeDefault'}});
 assert.equal(container.securityContext.readOnlyRootFilesystem,true);
 assert.deepEqual(container.securityContext.capabilities.drop,['ALL']);
 assert.equal(container.securityContext.allowPrivilegeEscalation,false);
 assert.ok(pod.volumes.some(v=>v.name==='tmp' && v.emptyDir));
 assert.ok(container.volumeMounts.some(v=>v.name==='tmp' && v.mountPath==='/tmp'));
 assert.equal(container.args[container.args.indexOf('--state')+1],'/data/host');
 const rules=load('role').rules;
 for(const [group,resource,verbs] of [['','pods',['get','list']],['','resourcequotas',['get','list']],['metrics.k8s.io','pods',['get','list']],['kubevirt.io','virtualmachines',['get','list','create','patch']],['kubevirt.io','virtualmachineinstances',['get','list']],['','persistentvolumeclaims',['get','list']],['','secrets',['get','create']],['cdi.kubevirt.io','datavolumes/source',['create']]]) {
  const rule=rules.find(r=>r.apiGroups.includes(group)&&r.resources.includes(resource));assert.ok(rule,resource);assert.deepEqual(rule.verbs,verbs);
 }
 assert.ok(rules.every(r=>!r.apiGroups.includes('*')&&!r.resources.includes('*')&&!r.verbs.includes('*')));
 assert.equal(load('role').kind,'Role');
 const namespaces=JSON.parse(readFileSync(new URL('../deploy/kubernetes/namespaces/namespaces.json',import.meta.url))).items;
 assert.ok(namespaces.every(n=>n.metadata.labels['pod-security.kubernetes.io/enforce']==='restricted'));
 assert.equal(SOURCE,'https://github.com/seventwo-studio/canaveral');assert.equal(PACKAGE,'ghcr.io/seventwo-studio/canaveral');
});
