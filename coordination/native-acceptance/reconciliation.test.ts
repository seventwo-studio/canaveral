import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {reconciliationMode,validateReconciliation,requireQuiescent,reconcileCase,proveOrphanExclusion,fenceTiming} from './reconciliation.ts';
import {receiptEvidence} from './evidence.ts';
const cfg={mode:reconciliationMode,setupOnly:false,workspaceIOVersion:1,cpu:2,memoryMiB:4096,diskGiB:8,stateRoot:'/private',physicalStateRoots:['/private']};
const auth={CANAVERAL_NATIVE_ACCEPTANCE:'operator-authorized'};
test('mode is opt-in, authorized outside CI with exact resources and inventory',()=>{
  validateReconciliation(cfg,auth);
  for(const env of [{},{...auth,CI:'true'}]) assert.throws(()=>validateReconciliation(cfg,env));
  for(const delta of [{mode:'other'},{setupOnly:true},{cpu:3},{memoryMiB:2048},{diskGiB:9},{workspaceIOVersion:0},{physicalStateRoots:[]}]) assert.throws(()=>validateReconciliation({...cfg,...delta},auth));
});
test('preflight refuses unrelated execution, held physical capacity and ambiguity',()=>{
  requireQuiescent([],0,false);
  for(const command of ['CanaveralVMRunner run /private','canaveral-apple-satellite','com.apple.Virtualization.VirtualMachine']) assert.throws(()=>requireQuiescent([{command}],0,false));
  assert.throws(()=>requireQuiescent([],1,false));assert.throws(()=>requireQuiescent([],0,true));
});
test('orphan exclusion requires live helper both sides, exact refusal, unchanged journal and held capacity',async()=>{
  const base={journalBytes:()=> 'private journal',secondOwner:async()=>({code:1,diagnostic:'executor already owned'}),helpersAlive:()=>true,reservations:async()=>1,capacityRefused:async()=>true};
  await proveOrphanExclusion(base);
  for(const delta of [{helpersAlive:()=>false},{reservations:async()=>0},{capacityRefused:async()=>false},{secondOwner:async()=>({code:1,diagnostic:'unrelated failure'})}]) await assert.rejects(proveOrphanExclusion({...base,...delta}));
  let n=0;await assert.rejects(proveOrphanExclusion({...base,journalBytes:()=>String(n++)}));
});
test('real fence window refuses early disappearance and late stops',()=>{
  fenceTiming(10000,9900,10100);
  for(const args of [[10000,1000,10100],[10000,9900,16000],[NaN,1,1]]) assert.throws(()=>fenceTiming(...args as [number,number,number]));
});
function fixture(unknown=false) {
  const binding={controllerId:randomUUID(),runnerId:randomUUID(),incarnationId:randomUUID(),generation:1};
  const j:any={config:{binding},claimId:randomUUID(),workerOwnershipProtocol:1,launchIntent:true,assignment:{id:randomUUID(),leaseId:randomUUID(),memberId:randomUUID(),domainId:randomUUID(),image:{digest:'sha256:'+'a'.repeat(64)}},direct:{bundleDigest:'sha256:'+'a'.repeat(64),workspaceDisk:{},ready:true,bootAttempt:randomUUID()}};
  const files=new Map<string,any>(),reports:any[]=[],calls:string[]=[];
  let held=1,removed=false;
  const mutation=randomUUID();
  const s={journal:()=>j,persist:(n:string,v:unknown)=>{files.set(n,structuredClone(v));},reports:()=>reports,reservations:async()=>held,removed:()=>removed,
    dispatch:async(n:string)=>{
      assert(files.has(n),'intent persisted before dispatch');calls.push(n);
      if(n==='reconcile-conflict.json') return {code:1,output:'private diagnostic'};
      if(!j.released) {
        Object.assign(j,{stopped:true,cleaned:true,released:true});j.direct.dataClosed=true;j.direct.workspaceDisk.removed=true;held=0;removed=true;
        reports.push({body:{receipt:{cleanup:'complete',executionStopped:true,workspaceRemoved:true,dataPlaneClosed:true}},response:{released:true},before:{body:{reservations:1}},after:{body:{reservations:0}}});
        if(unknown)return {code:null,output:''};
      }
      return {code:0,output:JSON.stringify({version:1,mutationUUID:mutation,assignmentId:j.assignment.id,released:true})};
    }};
  return {s,mutation,calls,j,files,reports};
}
for(const unknown of [false,true]) test('success/replay/conflict with stable saved intent; unknown='+unknown,async()=>{
  const f=fixture(unknown);assert.equal((await reconcileCase(f.s,f.mutation)).reconciliationPassed,true);
  assert.equal(f.calls.length,unknown?4:3);
  assert.equal(f.files.get('reconcile-request.json').mutationUUID,f.mutation);
});
test('uncertain failure preserves identity and refuses any reclamation claim',async()=>{
  const f=fixture();f.s.dispatch=async n=>{f.calls.push(n);return {code:null,output:'PRIVATE_SECRET'};};
  await assert.rejects(reconcileCase(f.s,f.mutation));
  assert.deepEqual(f.calls,['reconcile-request.json','reconcile-request.json']);assert.equal(await f.s.reservations(),1);assert.equal(f.j.released,undefined);
});
test('insufficient ownership and false cleanup/ack never pass',async()=>{
  for(const field of ['workerOwnershipProtocol','launchIntent']) {const f=fixture();delete f.j[field];await assert.rejects(reconcileCase(f.s,f.mutation));assert.equal(f.calls.length,0);}
  const f=fixture();f.s.removed=()=>false;await assert.rejects(reconcileCase(f.s,f.mutation));
  const g=fixture();const dispatch=g.s.dispatch;g.s.dispatch=async n=>{const r=await dispatch(n);g.reports[0].response.released=false;return r;};await assert.rejects(reconcileCase(g.s,g.mutation));
});
test('scoped evidence omits raw observation, paths, output and credentials',()=>{
  const clean=receiptEvidence({mode:reconciliationMode,reconciliationPassed:true,replayPassed:true,conflictPassed:true,orphanExclusionPassed:true,nativeAcceptance:false,output:'PRIVATE_SECRET',config:{credential:'PRIVATE_SECRET'},machine:'/PRIVATE_SECRET'});
  assert(!JSON.stringify(clean).includes('PRIVATE_SECRET'));assert.equal((clean as any).nativeAcceptance,false);
});
