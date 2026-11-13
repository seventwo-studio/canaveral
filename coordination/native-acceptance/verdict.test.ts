import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
const source=readFileSync(new URL('./run.ts',import.meta.url),'utf8');
const baseline=process.env.CANAVERAL_VERDICT_BASELINE;
const before=baseline?execFileSync('git',['show',baseline+':coordination/native-acceptance/run.ts'],{encoding:'utf8'}):undefined;
function section(s:string,start:string,end:string){return s.slice(s.indexOf(start),s.indexOf(end,s.indexOf(start)));}
function run(s:string,scenario:string) {
  const dir=mkdtempSync(join(tmpdir(),'native-verdict-'));
  const modern=s.includes('function publishResult()');
  const failure=new URL('./failure-boundary.ts',import.meta.url).pathname;
  const evidence=new URL('./evidence.ts',import.meta.url).pathname;
  const finish=modern?`result={state:'cases-completed'};completed=true;`:
    `save('result.json',{state:'cases-completed',nativeAcceptance:caseFailures.length===0});`;
  const callback=s.includes('.catch(() => { internalFailure(); res.destroy(); })')?
    `.catch(() => { internalFailure(); res.destroy(); })`:`.catch(e => res.destroy(e))`;
  const body=scenario==='spawn'?`const r=await launch('/nonexistent/PRIVATE_SECRET',[],'recovery').done;assert.equal(r.code,1);`:
    scenario==='write'?`try {writeFileSync(join(dir,'missing','PRIVATE_SECRET'),'x');}catch {}`:
    scenario==='proxy'?`const res={destroy:()=>{}};await Promise.reject(Error('PRIVATE_SECRET'))${callback};`:
    scenario==='assertion'?`assert.equal(false,true);`:
    scenario==='case'?`caseFailures.push('failed case');`:
    scenario==='fatal'?`setImmediate(()=>{throw Error('PRIVATE_SECRET');});await new Promise(r=>setTimeout(r,50));`:
    scenario==='warning'?`process.emitWarning('PRIVATE_SECRET');await new Promise(r=>setTimeout(r,50));`:'';
  const script=`import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {once} from 'node:events';
import {join} from 'node:path';
import {writeFileSync as rawWriteFileSync,mkdirSync} from 'node:fs';
import {internalFailure,guardEvidenceWrite,hasInternalFailure,onInternalFailure} from ${JSON.stringify(failure)};
import {receiptEvidence} from ${JSON.stringify(evidence)};
const dir=${JSON.stringify(dir)},privateDir=join(dir,'private');mkdirSync(privateDir);
const writeFileSync:typeof rawWriteFileSync=(...args)=>guardEvidenceWrite(()=>rawWriteFileSync(...args));
const children:any[]=[];let active:any;let api:any;
const pause=async (_ms:number)=>{};
let proxy:any=${scenario==='cleanup'?`{closeAllConnections(){throw Error('PRIVATE_SECRET');}}`:'undefined'};
${section(s,'const save = ','const sha = ')}
${modern?'':'const caseFailures:string[]=[];'}
${section(s,'function launch(','\ntry {\n  const signature')}
try {${body}${finish}}
${s.slice(s.lastIndexOf('\n} catch',s.indexOf('\nfinally {'))+2)}
`;
  try {
    writeFileSync(join(dir,'case.ts'),script);
    const r=spawnSync(process.execPath,[join(dir,'case.ts')],{encoding:'utf8',timeout:10000});
    assert(!r.stderr.includes('SyntaxError'),r.stderr);
    return {...r,evidence:JSON.parse(readFileSync(join(dir,'result.json'),'utf8'))};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
for(const scenario of ['pass','spawn','write','proxy','assertion','case','fatal','warning','cleanup']) {
  test('final verdict: '+scenario,()=>{
    if(before && ['spawn','write','proxy','cleanup'].includes(scenario)) {
      const old=run(before,scenario);assert.equal(old.evidence.nativeAcceptance,true,'counterfactual accepts failure');
    }
    const r=run(source,scenario);
    assert.equal(r.evidence.nativeAcceptance,scenario==='pass');
    if(scenario!=='pass')assert.equal(r.evidence.failure,'native_acceptance_failed');
    for(const v of [r.stdout,r.stderr,JSON.stringify(r.evidence)])assert(!v.includes('PRIVATE_SECRET'));
    if(['spawn','write','proxy','assertion','fatal','warning','cleanup'].includes(scenario))assert.notEqual(r.status,0);
  });
}
test('stdout uses an opaque run label',()=>{
  const line=source.split('\n').find(l=>l.startsWith('console.log('))!;
  const r=spawnSync(process.execPath,['-e',`const {basename}=require('node:path');const dir='/private/PRIVATE_SECRET/canaveral-native-opaque';${line}`],{encoding:'utf8'});
  assert.deepEqual(JSON.parse(r.stdout),{runLabel:'canaveral-native-opaque'});
  if(before) {
    const old=before.split('\n').find(l=>l.startsWith('console.log('))!;
    const r=spawnSync(process.execPath,['-e',`const dir='/private/PRIVATE_SECRET/canaveral-native-opaque';${old}`],{encoding:'utf8'});
    assert(r.stdout.includes('/private/PRIVATE_SECRET/'));
  }
});

test('cleanup journal flags require booleans rather than truthy strings',()=>{
  const line=source.split('\n').find(l=>l.includes("for (const flag of ['stopped','cleaned','released'])"))!;
  assert(line);
  const check=(journal:unknown)=>new Function('assert','journal',line)(assert,journal);
  assert.throws(()=>check({stopped:'false',cleaned:'false',released:'false'}));
  check({stopped:true,cleaned:true,released:true});
  if(before) {
    const old=before.split('\n').find(l=>l.includes('assert(journal.stopped &&'))!;
    new Function('assert','journal',old)(assert,{stopped:'false',cleaned:'false',released:'false'});
  }
});

test('negative upload requires both a rejection and durable failed state',async()=>{
  const w=readFileSync(new URL('./workspace.ts',import.meta.url),'utf8');
  const method=section(w,'  async function failure(',"  const replacement=");
  // Run the actual TypeScript function in a subprocess with SDK responses only.
  const dir=mkdtempSync(join(tmpdir(),'native-transfer-'));
  try {
    const script=`import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
let reject=false,state='succeeded';
const uploadWorkspaceFile=async()=>{if(reject)throw Error('private');};
const client={transfer:async()=>({state,error:{code:'disk_full'}})},journal={},wait={};const save=()=>{};
${method}
await assert.rejects(failure('x',Buffer.alloc(0),'disk_full'));
reject=true;await assert.rejects(failure('x',Buffer.alloc(0),'disk_full'));
state='failed';await failure('x',Buffer.alloc(0),'disk_full');`;
    writeFileSync(join(dir,'case.ts'),script);
    const r=spawnSync(process.execPath,[join(dir,'case.ts')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
    if(baseline) {
      const old=execFileSync('git',['show',baseline+':coordination/native-acceptance/workspace.ts'],{encoding:'utf8'});
      writeFileSync(join(dir,'case.ts'),script.replace(method,section(old,'  async function failure(',"  const replacement=")));
      assert.notEqual(spawnSync(process.execPath,[join(dir,'case.ts')]).status,0);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('unsupported workspace versions cannot silently skip cases',()=>{
  const validation=(s:string)=>{
    const start=s.indexOf('    if (cfg.workspaceIOVersion !== undefined');
    const fallback=s.indexOf('    if (cfg.workspaceIOVersion === 1)');
    return s.slice(start<0?fallback:start,s.indexOf('\n  } catch',fallback));
  };
  const check=new Function('cfg',validation(source));
  for(const workspaceIOVersion of [null,0,2,'1',false]) {
    assert.throws(()=>check({workspaceIOVersion}));
    if(before)new Function('cfg',validation(before))({workspaceIOVersion});
  }
  check({});
  check({workspaceIOVersion:1,cloneRepo:'https://example.invalid/repo',cloneCommit:'a'.repeat(40),hostLanTarget:'private',hostTailnetTarget:'private',hostLoopbackTarget:'private'});
});

test('signature evidence omits configuration identifiers',()=>{
  const e=readFileSync(new URL('./evidence.ts',import.meta.url),'utf8');
  const signature=(s:string)=>new Function(section(s,'export function signatureEvidence','export function processEvidence')
    .replace('export function','function').replace('raw: string, requirementSatisfied: boolean','raw, requirementSatisfied')+';return signatureEvidence;')();
  const raw='Identifier=PRIVATE-CONFIG-ID\nCDHash='+'a'.repeat(40);
  assert(!JSON.stringify(signature(e)(raw,true)).includes('PRIVATE-CONFIG-ID'));
  if(baseline){
    const old=execFileSync('git',['show',baseline+':coordination/native-acceptance/evidence.ts'],{encoding:'utf8'});
    assert(JSON.stringify(signature(old)(raw,true)).includes('PRIVATE-CONFIG-ID'));
  }
});
