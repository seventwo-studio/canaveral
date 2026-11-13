// Disposable public-controller + Rust executor integration. No installed models are used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,chmodSync,realpathSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
const [main,runner,runtime]=process.argv.slice(2).map(p=>resolve(p));
assert(main&&runner&&runtime,'controller main.js, Rust executable and owned test executable required');
const dir=realpathSync(mkdtempSync(join(tmpdir(),'canaveral-rust-model-fixture-')));
mkdirSync(join(dir,'models'),{mode:0o700});
const admin=randomBytes(32).toString('base64url'),controllerId=randomUUID();
writeFileSync(join(dir,'admin'),admin,{mode:0o600});
writeFileSync(join(dir,'controller.json'),JSON.stringify({statePath:join(dir,'db'),adminTokenFile:join(dir,'admin'),controllerId,listen:{host:'127.0.0.1',port:0}}));
let controller;let proxy;
const children=[];
async function start(file,args){const child=spawn(file,args,{stdio:['ignore','pipe','pipe']});children.push(child);return child;}
try {
 controller=await start(process.execPath,[main,join(dir,'controller.json')]);
 const port=await new Promise((resolve,reject)=>{let text='';controller.stdout.on('data',b=>{text+=b;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]).listening.port);});controller.on('exit',code=>reject(new Error('controller exited '+code)));});
 const origin=`http://127.0.0.1:${port}`;
 async function call(route,body,token=admin,method='POST'){const r=await fetch(origin+route,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert(r.ok,`${route}: ${r.status} ${JSON.stringify(value)}`);return value;}
 const model='fixture-model:1',digest='sha256:'+'ab'.repeat(32),resources={cpu:1,memoryMiB:16,diskGiB:1};
 await call('/v1/model-catalog',{model,digest,adapter:'ollama',resources});
 const appId=randomUUID();const app=await call('/v1/consumers',{id:appId,name:'disposable Rust fixture',templates:[],limits:{resources,activeLeases:1}});
 await call('/v1/model-grants',{applicationId:appId,model,digest,maxUnfinished:8});
 const binding={controllerId,runnerId:randomUUID(),generation:1,incarnationId:randomUUID()},enrollment=randomUUID(),credential=randomBytes(32).toString('base64url');
 const issued=await call('/v1/runner-enrollments',{id:enrollment,...binding,ttlSeconds:60});
 await call('/v1/runner-enrollments/consume',{id:enrollment,...binding,credential},issued.enrollmentToken);
 const domainId=randomUUID();await call('/v1/resource-domains',{id:domainId,name:'fixture only',capacity:resources});
 await call('/v1/model-runner-approvals',{binding,domainId,models:[{model,digest}]});
 writeFileSync(join(dir,'credential'),credential,{mode:0o600});
 const config={controller:origin,binding,credentialFile:join(dir,'credential'),caFile:null,execution:{executable:runtime,executableSha256:createHash('sha256').update(readFileSync(runtime)).digest('hex'),modelsDir:join(dir,'models'),inventory:{[model]:digest},stateDir:join(dir,'state'),startupMs:3000,executionMs:10000,contactMs:1000,stopMs:1000,responseBytes:262144,contextTokens:8192}};
 const path=join(dir,'runner.json');function save(){writeFileSync(path,JSON.stringify(config),{mode:0o600});}save();
 async function run(file=path){const c=await start(runner,[file]);let errors='';c.stderr.on('data',b=>errors+=b);const [code]=await once(c,'exit');return {code,errors};}
 const submit=async(prompt)=>{const id=randomUUID();await call('/v1/model-jobs',{version:1,applicationId:appId,id,message:{type:'submit',adapter:'ollama',model,digest,prompt,maxTokens:64}},app.credential);return id;};
 const inspect=id=>call('/v1/model-jobs/'+id,undefined,app.credential,'GET');
 const first=await submit('success');
 // A local preflight error must not consume or fail a queued application job.
 const goodPin=config.execution.executableSha256;
 config.execution.executableSha256='00'.repeat(32);save();
 const badPin=await run();assert.equal(badPin.code,1,badPin.errors);
 assert.equal((await inspect(first)).state,'queued');assert.equal((await inspect(first)).assignment,'none');assert.equal((await inspect(first)).reservationHeld,false);assert(!existsSync(join(dir,'state','claim.json')));
 config.execution.executableSha256=goodPin;save();
 chmodSync(config.execution.modelsDir,0o777);
 const unsafeModels=await run();assert.equal(unsafeModels.code,1,unsafeModels.errors);assert.equal((await inspect(first)).state,'queued');assert.equal((await inspect(first)).reservationHeld,false);
 chmodSync(config.execution.modelsDir,0o700);
 const firstRun=await run();assert.equal(firstRun.code,0,firstRun.errors);let view=await inspect(first);assert.equal(view.state,'succeeded',firstRun.errors);assert.equal(view.result.text,'fixture output');assert.deepEqual(view.result.usage,{inputTokens:5,outputTokens:2});assert.equal(view.reservationHeld,false);assert(!existsSync(join(dir,'state','workspace')));
 const second=await submit('hang');const c=await start(runner,[path]);let errors='';c.stderr.on('data',b=>errors+=b);for(let i=0;i<200;i++){if((await inspect(second)).assignment==='current')break;await new Promise(r=>setTimeout(r,10));}
 for(let i=0;i<500&&!existsSync(join(dir,'state','workspace','generation.started'));i++)await new Promise(r=>setTimeout(r,10));assert(existsSync(join(dir,'state','workspace','generation.started')));
 const cancelledPid=Number(readFileSync(join(dir,'state','workspace','runtime.pid'),'utf8'));
 const binding2={controllerId,runnerId:randomUUID(),generation:1,incarnationId:randomUUID()},enrollment2=randomUUID(),credential2=randomBytes(32).toString('base64url');
 const issued2=await call('/v1/runner-enrollments',{id:enrollment2,...binding2,ttlSeconds:60});
 await call('/v1/runner-enrollments/consume',{id:enrollment2,...binding2,credential:credential2},issued2.enrollmentToken);
 await call('/v1/model-runner-approvals',{binding:binding2,domainId,models:[{model,digest}]});
 writeFileSync(join(dir,'credential2'),credential2,{mode:0o600});const path2=join(dir,'runner2.json');
 writeFileSync(path2,JSON.stringify({...config,binding:binding2,credentialFile:join(dir,'credential2'),execution:{...config.execution,stateDir:join(dir,'state2')}}),{mode:0o600});
 const contender=await submit('success');assert.equal((await run(path2)).code,0);assert.equal((await inspect(contender)).state,'waitingForResources');assert(!existsSync(join(dir,'state2','workspace')));
 await call('/v1/model-jobs/'+second+'/cancel' ,{version:1,applicationId:appId,id:second,message:{type:'cancel'}},app.credential);assert.equal((await once(c,'exit'))[0],0,errors);view=await inspect(second);assert.equal(view.state,'cancelled');assert.equal(view.reservationHeld,false);assert.throws(()=>process.kill(cancelledPid,0),{code:'ESRCH'});assert(!existsSync(join(dir,'state','workspace')));assert.equal((await run(path2)).code,0);assert.equal((await inspect(contender)).state,'succeeded');assert(!existsSync(join(dir,'state2','workspace')));
 // A stalled listing must not hold the generation deadline hostage.
 let delayedListings=0,listingStarted;
 const stalled=http.createServer((req,res)=>{
   if(req.url.endsWith('/assignments')){delayedListings++;listingStarted??=performance.now();setTimeout(()=>res.destroy(),2000);req.resume();return;}
   const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});req.pipe(upstream);upstream.on('error',()=>res.destroy());
 });
 await new Promise(r=>stalled.listen(0,'127.0.0.1',r));
 try {
   const stalledPath=join(dir,'stalled.json');
   writeFileSync(stalledPath,JSON.stringify({...config,controller:`http://127.0.0.1:${stalled.address().port}`,execution:{...config.execution,stateDir:join(dir,'stalled-state'),executionMs:300}}),{mode:0o600});
   const stalledJob=await submit('hang');const stalledChild=await start(runner,[stalledPath]);let diagnostic='';stalledChild.stderr.on('data',b=>diagnostic+=b);
   const started=join(dir,'stalled-state','workspace','generation.started');
   for(let i=0;i<500&&!existsSync(started);i++)await new Promise(r=>setTimeout(r,10));
   assert(existsSync(started),'stalled fixture did not start');
   const pid=Number(readFileSync(join(dir,'stalled-state','workspace','runtime.pid'),'utf8'));
   assert.equal((await once(stalledChild,'exit'))[0],0,diagnostic);
   // No stop timestamp is persisted in the runner journal. Allow scheduling and
   // cleanup slack from the first listing request, retaining 200 ms of separation
   // from its 2 s stall. Measuring at the proxy avoids marker-polling latency.
   assert(performance.now()-listingStarted<1800,'controller listing postponed execution deadline');
   assert(delayedListings>0);const stopped=await inspect(stalledJob);assert.equal(stopped.state,'failed',diagnostic);assert.equal(stopped.reservationHeld,false);
   assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert(!existsSync(join(dir,'stalled-state','workspace')));
 } finally {stalled.closeAllConnections();await new Promise(r=>stalled.close(r));}
 // Drop only the report response after the real controller commits it.
 let dropRoute='/claim';
 proxy=http.createServer((req,res)=>{const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers},reply=>{if(req.url.endsWith(dropRoute)){reply.resume();reply.on('end',()=>res.destroy());}else{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);}});req.pipe(upstream);upstream.on('error',()=>res.destroy());});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 config.controller=`http://127.0.0.1:${proxy.address().port}`;save();
 const lostClaimJob=await submit('success');assert.equal((await run()).code,1);assert.equal((await inspect(lostClaimJob)).assignment,'current');assert(!existsSync(join(dir,'state','workspace')));
 config.controller=origin;save();assert.equal((await run()).code,0);assert.equal((await inspect(lostClaimJob)).state,'succeeded');
 dropRoute='/report';config.controller=`http://127.0.0.1:${proxy.address().port}`;save();const third=await submit('success');assert.equal((await run()).code,1);view=await inspect(third);assert.equal(view.state,'succeeded');assert.equal(view.reservationHeld,false);
 // A deliberately wrong runtime pin proves report recovery never launches again.
 config.controller=origin;config.execution.executableSha256='00'.repeat(32);save();assert.equal((await run()).code,0);assert.deepEqual(await inspect(third),view);
 // Crash the executor after the fixture has entered generation. Recovery reports
 // unknown and cannot replay, even after the disposable process is externally stopped.
 config.execution.executableSha256=createHash('sha256').update(readFileSync(runtime)).digest('hex');save();
 const fourth=await submit('hang');const crashed=await start(runner,[path]);crashed.stderr.resume();
 const marker=join(dir,'state','workspace','generation.started');
 for(let i=0;i<500&&!existsSync(marker);i++)await new Promise(r=>setTimeout(r,10));
 assert(existsSync(marker),'fixture generation never started');
 const ownedPid=Number(readFileSync(join(dir,'state','workspace','runtime.pid'),'utf8'));
 crashed.kill('SIGKILL');await once(crashed,'exit');
 process.kill(-ownedPid,'SIGKILL'); // Only the disposable fixture's recorded process group.
 assert.equal((await run()).code,0);view=await inspect(fourth);assert.equal(view.state,'unknown');assert.equal(view.reservationHeld,true);
 assert.equal((await run()).code,1);assert.equal((await inspect(fourth)).reservationHeld,true);
 console.log('PASS public API: admission, owned generation, measured tokens, cancellation, cleanup, stalled-controller deadline, fresh-job isolation, shared-domain contention, lost claim and report, exact restart replay, crash unknown reservation retention');
} finally {if(proxy)await new Promise(r=>proxy.close(r));for(const c of children){if(c.exitCode===null&&c.signalCode===null){c.kill('SIGKILL');await once(c,'exit');}}rmSync(dir,{recursive:true,force:true});}
