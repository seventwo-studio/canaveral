import {proxyProbe,assertProxy} from './proxy.ts';
import assert from 'node:assert/strict';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {uploadWorkspaceFile,downloadWorkspaceFile} from '../src/linux-transfer-sdk.ts';
import {LeaseClient} from '../src/consumer-client.ts';
/** Public API only. The enclosing harness owns native launch and independent cleanup evidence. */
export async function workspaceCases(o:{cfg:Record<string,any>;origin:string;ca:Buffer;app:Record<string,any>;other:Record<string,any>;api:Function;ok:Function;until:Function;save:Function;start:Function;stopped:Function}) {
  const {cfg,ok,until,save}=o;
  const failures:string[]=[];
  const check=(label:string,fn:()=>void)=>{try{fn();}catch(e){failures.push(label+': '+String(e));save('workspace-case-failures.json',failures);}};
  assert.match(cfg.cloneRepo,/^https:\/\//);assert.match(cfg.cloneCommit,/^[0-9a-f]{40}$/);
  for(const name of ['hostLanTarget','hostTailnetTarget','hostLoopbackTarget']) assert.equal(typeof cfg[name],'string',`${name} required in private config`);
  const id=await o.start('workspace',300), key=(await ok('POST',`/v1/leases/${id}/credential`,{},o.app.credential)).credential;
  const client=new LeaseClient({baseUrl:o.origin,ca:o.ca,leaseId:id,leaseKey:key,timeoutMs:20000});
  const journal={save:async(value:unknown)=>save('workspace-intent-'+randomUUID()+'.json',value)};
  const wait={wait:()=>new Promise<void>(r=>setTimeout(r,100))};
  async function command(argv:string[],timeoutMs=120000) {
    const request={id:randomUUID(),member:'primary' as const,action:'shell' as const,arguments:{argv,timeoutMs}};
    await client.createOperation(request);
    return until(async()=>{const r=await client.operation(request.id);return ['succeeded','failed','unknown'].includes(r.state)&&r;},'workspace command',timeoutMs+30000);
  }
  const shell=(script:string,timeoutMs=120000)=>command(['/bin/sh','-c',script],timeoutMs);
  const tools=await shell('for tool in git node npm sh dd sync; do command -v "$tool" >/dev/null || { echo "Missing required guest tool: $tool" >&2; exit 1; }; done');
  assert.equal(tools.state,'succeeded','guest requires git, node, npm, sh, dd, sync: '+JSON.stringify(tools));
  const denials: Array<{result:any;code:string}>=[];
  for(const [target,code] of [[cfg.hostLanTarget,'destination_denied'],[cfg.hostTailnetTarget,'destination_denied'],[cfg.hostLoopbackTarget,'destination_denied'],['169.254.169.254:443','destination_denied'],['10.0.0.1:443','destination_denied'],['example.com:80','port_denied']]) {
    const result=await command(proxyProbe(target));save('proxy-'+target.replaceAll(':','_')+'.json',result);
    denials.push({result,code});
  }
  const allowed=await command(proxyProbe('github.com:443'));save('proxy-allowed.json',allowed);
  for(const {result,code} of denials) check('proxy denial '+code,()=>assertProxy(result,'HTTP/1.1 403 Forbidden',code));
  check('allowed CONNECT',()=>assertProxy(allowed, 'HTTP/1.1 200 Connection Established'));
  const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
  const build=await shell(`git clone ${quote(cfg.cloneRepo)} source && cd source && git checkout --detach ${quote(cfg.cloneCommit)} && test "$(git rev-parse HEAD)" = ${quote(cfg.cloneCommit)} && { npm ci && npm test; } > /workspace/build.log 2>&1`,180000);
  save('workspace-build.json',build);check('clone/npm build',()=>assert.equal(build.state,'succeeded'));
  if(build.state==='succeeded') {
  const logs:Buffer[]=[];
  await downloadWorkspaceFile(client,{id:randomUUID(),member:'primary',direction:'download',path:'build.log'},async b=>{save('workspace-build-chunk-'+logs.length+'.json',{base64:Buffer.from(b).toString('base64')});logs.push(Buffer.from(b));},journal,wait);
  save('workspace-build-log.json',{base64:Buffer.concat(logs).toString('base64')});
  }
  for(const bytes of [Buffer.alloc(0),Buffer.from([0,255,1,128]),randomBytes(300*1024)]) {
    const path='roundtrip-'+bytes.length,sha256=createHash('sha256').update(bytes).digest('hex');
    await uploadWorkspaceFile(client,{id:randomUUID(),member:'primary',direction:'upload',path,bytes:bytes.length,sha256,replace:false},(async function*(){yield bytes;})(),journal,wait);
    const chunks:Buffer[]=[];
    await downloadWorkspaceFile(client,{id:randomUUID(),member:'primary',direction:'download',path},async b=>{save('roundtrip-'+bytes.length+'-chunk-'+chunks.length+'.json',{base64:Buffer.from(b).toString('base64')});chunks.push(Buffer.from(b));},journal,wait);
    assert.deepEqual(Buffer.concat(chunks),bytes);
    save('roundtrip-'+bytes.length+'-verified.json',{bytes:bytes.length,sha256,upload:'committed',download:'verified'});
  }
  async function failure(path:string,bytes:Buffer,code:string) {
    const id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex');
    let caught: string | undefined;
    try {await uploadWorkspaceFile(client,{id,member:'primary',direction:'upload',path,bytes:bytes.length,sha256,replace:false},(async function*(){yield bytes;})(),journal,wait);} catch(e) {caught=String(e);}
    const transfer=await client.transfer(id);save('workspace-'+code+'.json',{transfer,caught});
    assert.equal(transfer.error?.code,code);
  }
  await failure('roundtrip-0',Buffer.alloc(0),'destination_exists');
  const denied=await o.api('POST',`/v1/leases/${id}/transfers`,{id:randomUUID(),member:'primary',direction:'download',path:'build.log'},o.other.credential);save('workspace-second-tenant-denial.json',denied);assert([401,403,404].includes(denied.status));
  // Fill workspace through a command, then require a durable failed file receipt.
  const full=await shell('dd if=/dev/zero of=/workspace/fill bs=1048576; dd if=/dev/zero of=/workspace/fill bs=4096 oflag=append conv=notrunc; sync; df -B1 /workspace; exit 1',120000);save('workspace-fill.json',full);assert.equal(full.state,'failed');
  assert.match(Buffer.from(full.result.stderrBase64,'base64').toString(),/No space left on device/);
  await failure('disk-full',randomBytes(65536),'disk_full');
  const released=await client.release({id:randomUUID()});save('workspace-release.json',released);await o.stopped('workspace',id);
  const exp=await o.start('workspace-expiry',30),expKey=(await ok('POST',`/v1/leases/${exp}/credential`,{},o.app.credential)).credential;
  const expClient=new LeaseClient({baseUrl:o.origin,ca:o.ca,leaseId:exp,leaseKey:expKey});
  const expOp=randomUUID();
  await expClient.createOperation({id:expOp,member:'primary',action:'shell',arguments:{argv:['/bin/sleep','120'],timeoutMs:180000}});
  const dispatched=await until(async()=>{const r=await expClient.operation(expOp);return r.dispatchedAt&&r;},'expiry command dispatch',20000);
  save('workspace-expiry-command-dispatch.json',dispatched);
  const tid=randomUUID();await expClient.createTransfer({id:tid,member:'primary',direction:'upload',path:'expiry',bytes:0,sha256:createHash('sha256').digest('hex'),replace:false});
  await expClient.createTransferStep(tid,1,{action:'beginUpload',path:'expiry',bytes:0,sha256:createHash('sha256').digest('hex'),replace:false});
  const step=await until(async()=>{const r=await expClient.transferStep(tid,1);return r.state==='succeeded'&&r;},'expiry transfer opened',20000);
  assert.equal(step.receipt?.state,'writing');
  const opened=await expClient.transfer(tid);assert.equal(opened.state,'writing');
  save('workspace-expiry-transfer-opened.json',{step,transfer:opened});
  await o.stopped('workspace-expiry',exp);assert(['failed','unknown'].includes((await expClient.operation(expOp)).state));const operation=await expClient.operation(expOp);assert.equal(operation.dispatchedAt,dispatched.dispatchedAt);
  const transfer=await expClient.transfer(tid);assert(['failed','unknown'].includes(transfer.state));
  assert(['deadline','authorization_lost','lease_ended'].includes(transfer.error?.code ?? ''));
  save('workspace-expiry-terminal.json',{operation,transfer});
  return failures;
}
