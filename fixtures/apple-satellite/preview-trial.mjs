// Disposable v2 guest-wire peer. Only the fixed local echo service runs on the host.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,copyFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createServer,connect} from 'node:net';
import https from 'node:https';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

const canonical = v => v && typeof v === 'object'
  ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
  : JSON.stringify(v);

function frame(socket,value) {
  const payload=Buffer.from(JSON.stringify({version:1,...value}));
  const header=Buffer.alloc(4); header.writeUInt32BE(payload.length);
  socket.write(Buffer.concat([header,payload]));
}

export async function previewTrial({dir,app,arch,VM,binding,domainId,ca,direct,ok,sdk,configure,satellite,builderBin,sha,until,inspect,reports,log,relays,orphans}) {
  const bundle=join(dir,'preview-bundle'), workspace=join(dir,'service-workspace');
  mkdirSync(bundle,{mode:0o700}); mkdirSync(workspace,{mode:0o700});
  const manifest={version:2,id:'fixture-preview',revision:1,arch,commandLine:'console=hvc0 root=/dev/vda rootfstype=erofs ro',agentVsockPort:1024,protocol:1,dataVsockPort:1025,dataProtocol:1,
    toolVersions:{shell:'canaveral-shell-v1',git:'git version 2.47',node:'v24.11.0',mkfsExt4:'mke2fs 1.47.2 (1-Jan-2025)'}};
  const kernel=Buffer.alloc(64); kernel.write('ARMd',56);
  const root=Buffer.alloc(4096);root.writeUInt32LE(0xe0f5e1e2,1024);
  for(const [role,bytes] of [['kernel',kernel],['initrd',Buffer.from('fixture audited initrd')],['rootfs',root]]) {
    const path=join(bundle,role); writeFileSync(path,bytes,{mode:0o400});
    execFileSync('/usr/bin/chflags',['uchg',path]);
    manifest[role]={path:role,sha256:sha(path).slice(7),size:bytes.length};
  }
  const digest=createHash('sha256').update(canonical(manifest)).digest('hex');
  const path=join(bundle,'manifest.json');writeFileSync(path,JSON.stringify(manifest),{mode:0o400});
  const image={id:'preview-workspace',arch,revision:'1',digest:'sha256:'+digest,backend:'appleVirtualization'};
  await ok('POST','/v1/linux-lease-images',{...image,os:'linux',mode:'headless',resources:VM,capabilities:['command','files'],workspaceIOVersion:1});
  await ok('POST','/v1/linux-lease-grants',{applicationId:app.id,imageId:image.id,revision:'1',arch,digest:image.digest});
  await ok('POST','/v1/linux-lease-runner-approvals',{binding,domainId,backend:image.backend,images:[{id:image.id,revision:'1',arch,digest:image.digest}],workspaceIOVersion:1});
  const builder=join(bundle,'mkfs.erofs'); copyFileSync(builderBin,builder);chmodSync(builder,0o500);
  const state=join(dir,'preview-state');
  const config=configure({state,inventory:[{credentialFree:true,format:'bootBundle',image,path,previewBundleDigest:digest}],bootstrapBuilder:{path:builder,sha256:sha(builder)}});
  const {lease}=await sdk.acquireLease({id:randomUUID(),templateId:image.id,templateRevision:'1',arch,ttlSeconds:300,requiredCapabilities:['command']});
  const runner=satellite(config),machine=join(state,'workspace',lease.members[0].machineId.toUpperCase());
  const relay=join('/private/tmp','canaveral-'+randomUUID());
  const agentSocket=join(relay,'agent.sock'),dataSocketPath=join(relay,'data.sock');
  const servers=[],sockets=new Set();
  let service,guestExec,control,seen=0,servicePort,receiptBytes,peerError;
  try {
    await until(()=>{if(runner.exitCode!==null)throw Error(runner.errors);return existsSync(join(machine,'fixture-running'));},'fixture helper started');
    orphans.push(Number(readFileSync(join(machine,'fixture-running'),'utf8')));
    const boot=JSON.parse(readFileSync(join(machine,'machine.json'))).directBoot;
    const medium=readFileSync(boot.launchMedium.path);
    const marker=Buffer.from('CANAVERAL-SIMULATED-EROFS-NOT-MOUNTABLE\n');
    assert(medium.includes(marker));
    const launch=JSON.parse(medium.subarray(medium.indexOf(marker)+marker.length));
    mkdirSync(relay,{mode:0o700});relays.push(agentSocket);
    const argv=['/sbin/canaveral-guest-agent','--preview-service'];
    async function handle(f,s,data) {
      if(f.type==='hello'||f.type==='dataHello'){
        assert(isDeepStrictEqual(f.binding,launch.binding));
        if(data)assert.equal(f.nonce,launch.data.nonce);
        frame(s,{binding:f.binding,...(data?{nonce:f.nonce}:{}),type:data?'dataReady':'ready'});return;
      }
      if(!data && ['renew','credit'].includes(f.type))return;
      if(!data && f.type==='exec'){
        assert.deepEqual(f.argv,[...argv,String(servicePort),'node','service.cjs']);
        guestExec=f.id;control=s;return;
      }
      assert(data && f.type==='previewRequest');assert.equal(f.execId,guestExec);
      seen++;
      const upstream=connect(servicePort,'127.0.0.1');
      upstream.write(f.method+' '+f.target+' HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      const chunks=[];for await(const chunk of upstream)chunks.push(chunk);
      frame(s,{type:'previewResponse',id:f.id,data:Buffer.concat(chunks).toString('base64')});
    }
    for(const [socketPath,data] of [[agentSocket,false],[dataSocketPath,true]]){
      const server=createServer(s=>{
        sockets.add(s);s.on('error',()=>{});let pending=Buffer.alloc(0);
        s.on('data',b=>{pending=Buffer.concat([pending,b]);
          while(pending.length>=4 && pending.length>=4+pending.readUInt32BE()){
            const end=4+pending.readUInt32BE(),value=JSON.parse(pending.subarray(4,end));pending=pending.subarray(end);
            handle(value,s,data).catch(e=>{peerError=e;s.destroy();});
          }
        });
      });servers.push(server);server.listen(socketPath);await once(server,'listening');chmodSync(socketPath,0o600);
    }
    const {attemptedAt}=JSON.parse(readFileSync(join(machine,'runner-launch.json')));
    writeFileSync(join(machine,'direct-started.json'),JSON.stringify({event:'started',version:1,continuous:attemptedAt,memberID:boot.memberID,leaseID:boot.leaseID,
      bootAttempt:boot.bootAttempt,bootSessionID:boot.bootSessionID,agentSocket,dataSocketPath}),{mode:0o600});
    const check=fn=>{if(peerError)throw peerError;if(runner.exitCode!==null)throw Error(runner.errors);return fn();};
    await until(()=>check(()=>reports().some(e=>e.body.receipt.ready.preview)),'transport capability');
    writeFileSync(join(workspace,'service.cjs'),"require('node:http').createServer((q,r)=>r.end(JSON.stringify({cwd:process.cwd(),target:q.url}))).listen(0,'127.0.0.1',function(){process.send(this.address().port)})");
    service=spawn(process.execPath,['service.cjs'],{cwd:workspace,stdio:['ignore','ignore','inherit','ipc']});
    [servicePort]=await once(service,'message');
    const retiredKey=(await sdk.rotateLeaseCredential(lease.id)).credential;
    const op=randomUUID(), key=(await sdk.rotateLeaseCredential(lease.id)).credential;
    await ok('POST','/v1/leases/'+lease.id+'/operations',{id:op,member:'primary',action:'shell',arguments:{argv:[...argv,String(servicePort),'node','service.cjs'],timeoutMs:30000}},key);
    await until(()=>check(()=>guestExec),'bound command');
    assert(!log.some(e=>e.route.endsWith('/previews/poll')));
    const receipt=Buffer.from('previewReady '+servicePort+'\n');receiptBytes=receipt.length;
    frame(control,{type:'output',id:guestExec,stream:'stdout',seq:0,data:receipt.toString('base64')});
    await until(()=>check(()=>log.some(e=>e.route.endsWith('/previews/poll')&&e.body.operationId===op)),'poll after readiness');
    const target='/fixture?nonce='+randomUUID();
    const route=direct+'/v1/leases/'+lease.id+'/previews/'+op+target;
    const get=token=>new Promise((resolve,reject)=>https.get(route,{ca,headers:{Authorization:'Bearer '+token}},res=>{
      let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));
    }).on('error',reject));
    assert.equal((await get(app.credential)).status,401);
    assert.equal((await get(retiredKey)).status,401);assert.equal(seen,0);
    const result=await get(key);assert.equal(result.status,200,result.body);assert.deepEqual(JSON.parse(result.body),{cwd:workspace,target});
    service.kill();await once(service,'exit');service=undefined;
    let reused=0;
    const rebound=createServer(s=>{reused++;s.destroy();});servers.push(rebound);rebound.listen(servicePort,'127.0.0.1');await once(rebound,'listening');
    frame(control,{type:'exit',id:guestExec,status:0,signal:null,timedOut:false,durationMs:100,stdoutBytes:receiptBytes,stderrBytes:0,terminationConfirmed:true});
    await until(async()=>(await ok('GET','/v1/leases/'+lease.id+'/operations/'+op,undefined,key)).state==='succeeded','operation stop');
    assert.equal((await get(key)).status,409);assert.equal(seen,1);assert.equal(reused,0);
    await sdk.releaseLease(lease.id,{id:randomUUID()});
    const done=await runner.done;assert.equal(done.code,0,done.errors);
    assert.equal((await inspect(lease.id)).cleanup.state,'complete');
    assert(!existsSync(join(state,'workspace')));assert(!existsSync(relay));
    assert.equal((await ok('GET','/v1/resource-domains/'+domainId)).reservations,0);
    const helperPid=orphans.at(-1);
    assert.throws(()=>process.kill(helperPid,0),{code:'ESRCH'});
    orphans.pop();
    console.log('PASS controller + Rust satellite fixture: owner GET 200 '+target+', application and rotated credentials 401, stopped operation 409, rebound listener untouched, workspace and relay removed, zero reservations');
  }finally{
    if(service){service.kill();await once(service,'exit');}
    for(const socket of sockets)socket.destroy();
    for(const server of servers)await new Promise(r=>server.close(r));
  }
}
