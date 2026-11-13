import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadOperatorDenyList,builtInPolicyAllows,verifyOperatorDenials} from './operator-policy.ts';
import {receiptEvidence} from './evidence.ts';

test('operator file failures expose fixed diagnostics without private paths or parser excerpts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-FAKE_PRIVATE_TOKEN-'));
  const secret='93.184.216.34 FAKE_DENY_TOKEN';
  try {
    const cases:[string,string|undefined,string][]=[
      ['missing',undefined,'unreadable'],['unreadable',undefined,'unreadable'],
      ['malformed','{"operatorDenyCidrs": ["'+secret+'", BROKEN','invalid'],
      ['shape',JSON.stringify({version:1,operatorDenyCidrs:secret}),'invalid'],
      ['version',JSON.stringify({version:2,operatorDenyCidrs:['8.8.8.8/32']}),'invalid'],
      ['hostbits',JSON.stringify({version:1,operatorDenyCidrs:['8.8.8.8/24']}),'invalid'],
      ['oversize',JSON.stringify({operatorDenyCidrs:Array(4097).fill('8.8.8.8/32')}),'invalid'],
      ['noncanonical',JSON.stringify({operatorDenyCidrs:['2606:4700:4700:0:0:0:0:1111/128']}),'invalid'],
    ];
    for(const [name,contents,kind] of cases) {
      const path=join(dir,name);
      // A mode-0600 directory is unreadable as a file even under privileged test users.
      if(name==='unreadable') {mkdirSync(path);chmodSync(path,0o600);}
      if(contents!==undefined) writeFileSync(path,contents,{mode:0o600});
      let error:Error|undefined;try{loadOperatorDenyList(path);}catch(e){error=e as Error;}
      assert.equal(error?.message,'operator deny list '+kind);
      assert.equal(error?.cause,undefined);
      const script=`import {loadOperatorDenyList} from ${JSON.stringify(new URL('./operator-policy.ts',import.meta.url).href)}; loadOperatorDenyList(process.argv[1]);`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',script,path],{encoding:'utf8'});
      assert.notEqual(child.status,0);
      const output=String(error?.stack)+child.stdout+child.stderr+JSON.stringify(receiptEvidence({error}));
      for(const value of [path,dir,secret,'FAKE_DENY_TOKEN','93.184.216.34']) assert(!output.includes(value));
    }
    for(const version of [undefined,1]) {
      const path=join(dir,'valid');writeFileSync(path,JSON.stringify({version,operatorDenyCidrs:['8.8.8.8/32','2606:4700:4700::1111/128']}),{mode:0o600});
      assert.equal(loadOperatorDenyList(path).denyEvidence.count,2);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('operator verification requires an otherwise allowed target and rejects an omitted list',async()=>{
  const interfaces=['192.168.1.2','2606:4700:4700::1111'];
  for(const target of ['10.0.0.0','127.0.0.1','192.0.0.9','2001:db8::1','2002::1','3000::1','2606:4700:4700::1111']) assert.equal(builtInPolicyAllows(target,interfaces),false);
  for(const target of ['8.8.8.8','2606:4700:4700::1001']) assert.equal(builtInPolicyAllows(target,interfaces),true);
  const evidence={count:1,digest:'a'.repeat(64)};
  let calls=0;
  const result=(response:string)=>({state:'succeeded',result:{stdoutBase64:Buffer.from(response).toString('base64')}});
  const denied=async()=>{calls++;return result('HTTP/1.1 403 Forbidden\r\n\r\ndestination_denied');};
  await assert.rejects(verifyOperatorDenials(['10.0.0.0/8'],evidence,denied,()=>interfaces),/requires an otherwise allowed target/);
  assert.equal(calls,0);
  await assert.rejects(verifyOperatorDenials(['2606:4700:4700::1111/128'],evidence,denied,()=>interfaces),/requires an otherwise allowed target/);
  // Counterfactual satellite ignores operatorDenyCidrs and permits the public target.
  await assert.rejects(verifyOperatorDenials(['8.8.8.8/32'],evidence,async()=>result('HTTP/1.1 200 Connection Established\r\n\r\n'),()=>interfaces),/^Error: operator destination denial probe failed$/);
  await assert.rejects(verifyOperatorDenials(['8.8.8.8/32'],evidence,async()=>result('HTTP/1.1 403 Forbidden\r\n\r\nroute_denied'),()=>interfaces),/^Error: operator destination denial probe failed$/);
  await assert.rejects(verifyOperatorDenials(['8.8.8.8/32'],evidence,async()=>{throw Error('8.8.8.8 FAKE_TRANSPORT_SECRET');},()=>interfaces),/^Error: operator destination denial probe failed$/);
  const passed=await verifyOperatorDenials(['8.8.8.8/32'],evidence,denied,()=>interfaces);
  assert.deepEqual(passed,{...evidence,deniedCount:1,passed:true});
  assert.equal(JSON.stringify(receiptEvidence(passed)).includes('8.8.8.8'),false);
});
