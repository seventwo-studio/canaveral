import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {LinuxTransfers,transferPath,transferUUID,TRANSFER_SPOOL_LIMIT} from '../src/linux-transfers.ts';
import {ServiceError} from '../src/errors.ts';
function ledger() {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE linux_leases (id TEXT PRIMARY KEY,workspace TEXT); CREATE TABLE linux_lease_assignments (id TEXT PRIMARY KEY);');
  const owner={id:randomUUID(),lease:randomUUID(),member:randomUUID(),credential:'hash',bytes:1048576};
  db.prepare('INSERT INTO linux_leases VALUES (?,?)').run(owner.lease,JSON.stringify({bytes:1048576}));db.prepare('INSERT INTO linux_lease_assignments VALUES (?)').run(owner.id);
  const transfers=new LinuxTransfers(db,0);return {db,owner,transfers};
}
const error=(code:string)=>(e:unknown)=>e instanceof ServiceError&&e.code===code;
test('strict transfer UUID and confined path grammar',()=>{
  for(const path of ['', '/root','a/','a//b','a/../b','./a','.canaveral/x','a\\b','a\0b','x'.repeat(4097),'\ud800']) assert.throws(()=>transferPath(path),error('invalid_path'));
  assert.equal(transferPath('dir/file.bin'),'dir/file.bin');
  for(const id of ['00000000-0000-0000-0000-000000000000',randomUUID().toUpperCase(),randomUUID().replaceAll('-','')]) assert.throws(()=>transferUUID(id));
});
test('one active transfer, one step, spool exhaustion before admission and exact replay',()=>{
  const {db,owner,transfers:t}=ledger(),id=randomUUID();
  t.create(db,owner,{id,member:'primary',direction:'download',path:'file'},0);
  assert.throws(()=>t.create(db,owner,{id:randomUUID(),member:'primary',direction:'download',path:'file'},0),error('transfer_busy'));
  t.submit(db,t.row(db,id)!,{step:1,request:{action:'beginDownload',path:'file'}},0,300);
  assert.throws(()=>t.submit(db,t.row(db,id)!,{step:2,request:{action:'abort'}},0,300),error('step_pending'));
  const poll=randomUUID();t.poll(db,owner,'boot','digest',poll,1,300,true);
  t.report(db,owner.id,id,1,{state:'reading',offset:0,bytes:3},2);
  const filler=randomUUID(),other=randomUUID();db.prepare('INSERT INTO linux_lease_assignments VALUES (?)').run(other);t.create(db,{...owner,id:other}, {id:filler,member:'primary',direction:'download',path:'file'},0);
  // Model other assignments already reserving the complete decoded spool budget.
  db.prepare("INSERT INTO linux_transfer_steps (id,step,digest,request,state,updated,start_before,spool) VALUES (?,1,'h','{}','queued',0,300,?)").run(filler,TRANSFER_SPOOL_LIMIT);
  assert.throws(()=>t.submit(db,t.row(db,id)!,{step:2,request:{action:'read',offset:0,maxBytes:3}},3,300),error('transfer_backpressure'));
  assert.equal(t.step(db,id,2),undefined);db.close();
});

test('SDK persists exact intent and step then stops on unknown without repeating work',async()=>{
  const {uploadWorkspaceFile}=await import('../src/linux-transfer-sdk.ts');
  const saved:unknown[]=[],id=randomUUID();let creates=0,steps=0;
  const intent={id,member:'primary' as const,direction:'upload' as const,path:'empty',bytes:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',replace:false};
  const client={
    async createTransfer() {creates++;assert.deepEqual(saved[0],intent);return {} as never;},
    async createTransferStep(_id:string,step:number) {steps++;assert.equal(saved.length,2);return {id,step,state:'unknown',receipt:{state:'unknown',code:'transport_unknown'},updatedAt:new Date().toISOString()};},
    async transferStep(){throw Error('must not poll unknown');},async transfer(){throw Error('must not fetch success');}
  };
  await assert.rejects(uploadWorkspaceFile(client,intent,(async function*(){})(),{async save(v){saved.push(v);}},{async wait(){throw Error('must not wait');}}),/unknown/);
  assert.equal(creates,1);assert.equal(steps,1);
});

test('a definite not_found frees the lane without cancelling its successor',()=>{
  const {db,owner,transfers:t}=ledger();
  try {
    const missing=randomUUID(),id=randomUUID();
    for(const transferId of [missing,id]) {
      t.create(db,owner,{id:transferId,member:'primary',direction:'download',path:'file'},0);
      t.submit(db,t.row(db,transferId)!,{step:1,request:{action:'beginDownload',path:'file'}},0,300);
      const reply=t.poll(db,owner,'boot','digest',randomUUID(),1,300,true) as {cancelRequested:boolean;transfer:{id:string}};
      assert.equal(reply.cancelRequested,false);assert.equal(reply.transfer.id,transferId);
      t.report(db,owner.id,transferId,1,transferId===missing?{state:'failed',code:'not_found'}:{state:'reading',offset:0,bytes:0},2);
    }
    const sha256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    t.submit(db,t.row(db,id)!,{step:2,request:{action:'finish',bytes:0,sha256}},3,300);
    const poll=randomUUID();
    assert.equal((t.poll(db,owner,'boot','digest',poll,4,300,true) as {cancelRequested:boolean}).cancelRequested,false);
    t.report(db,owner.id,id,2,{state:'verified',bytes:0,sha256},5);
    assert.equal(t.row(db,id)!.state,'verified');
    assert.equal((t.poll(db,owner,'boot','digest',poll,6,300,true) as {cancelRequested:boolean}).cancelRequested,false);
  } finally { db.close(); }
});

test('unknown dispatched work still requests cancellation on a fresh poll',()=>{
  const {db,owner,transfers:t}=ledger(),id=randomUUID(),poll=randomUUID();
  try {
    t.create(db,owner,{id,member:'primary',direction:'download',path:'file'},0);
    t.submit(db,t.row(db,id)!,{step:1,request:{action:'beginDownload',path:'file'}},0,300);
    t.poll(db,owner,'boot','digest',poll,1,300,true);
    t.fail(db,t.row(db,id)!,t.step(db,id,1),'deadline',122);
    for(const p of [poll,randomUUID()]) assert.equal((t.poll(db,owner,'boot','digest',p,123,300,true) as {cancelRequested:boolean}).cancelRequested,true);
    assert.throws(()=>t.create(db,owner,{id:randomUUID(),member:'primary',direction:'download',path:'next'},124),error('transfer_busy'));
  } finally {db.close();}
});

for (const direction of ['upload','download'] as const) for (const queued of [false,true]) {
  test(`restart between ${direction} steps keeps guest-owned lane blocked (queued=${queued})`,()=>{
    const {db,owner,transfers:t}=ledger(),id=randomUUID(),sha256='a'.repeat(64);
    try {
      t.create(db,owner,{id,member:'primary',direction,path:'file',...(direction==='upload'?{bytes:3,sha256,replace:false}:{})},0);
      t.submit(db,t.row(db,id)!,{step:1,request:direction==='upload'?{action:'beginUpload',path:'file',bytes:3,sha256,replace:false}:{action:'beginDownload',path:'file'}},0,300);
      const poll=randomUUID();t.poll(db,owner,'boot','digest',poll,1,300,true);
      t.report(db,owner.id,id,1,direction==='upload'?{state:'writing',offset:0}:{state:'reading',offset:0,bytes:3},2);
      if(direction==='upload') {
        t.submit(db,t.row(db,id)!,{step:2,request:{action:'write',offset:0,data:'YWJj'}},3,300);
        t.poll(db,owner,'boot','digest',randomUUID(),4,300,true);
        t.report(db,owner.id,id,2,{state:'writing',offset:3},5);
      }
      if(queued) t.submit(db,t.row(db,id)!,{step:direction==='upload'?3:2,request:{action:'abort'}},6,300);
      let recovered=new LinuxTransfers(db,7);
      assert.equal(recovered.row(db,id)!.state,'unknown');
      if(queued) assert.equal(recovered.step(db,id,direction==='upload'?3:2)!.state,'failed');
      for(const p of [poll,randomUUID()]) assert.equal((recovered.poll(db,owner,'boot','digest',p,8,300,true) as {cancelRequested:boolean}).cancelRequested,true);
      recovered=new LinuxTransfers(db,9);
      assert.throws(()=>recovered.create(db,owner,{id:randomUUID(),member:'primary',direction:'download',path:'next'},10),error('transfer_busy'));
    } finally {db.close();}
  });
}

for (const direction of ['upload','download'] as const) {
  test(`satellite refusal after ${direction} begin keeps successor admission blocked`,()=>{
    const {db,owner,transfers:t}=ledger(),id=randomUUID(),sha256='a'.repeat(64);
    try {
      t.create(db,owner,{id,member:'primary',direction,path:'file',...(direction==='upload'?{bytes:3,sha256,replace:false}:{})},0);
      t.submit(db,t.row(db,id)!,{step:1,request:direction==='upload'?{action:'beginUpload',path:'file',bytes:3,sha256,replace:false}:{action:'beginDownload',path:'file'}},0,300);
      t.poll(db,owner,'boot','digest',randomUUID(),1,300,true);
      t.report(db,owner.id,id,1,direction==='upload'?{state:'writing',offset:0}:{state:'reading',offset:0,bytes:3},2);
      t.submit(db,t.row(db,id)!,{step:2,request:direction==='upload'?{action:'write',offset:0,data:'YWJj'}:{action:'read',offset:0,maxBytes:3}},3,300);
      t.poll(db,owner,'boot','digest',randomUUID(),4,300,true);
      // Local missed-start or post-journal expiry has no guest closure evidence.
      const receipt={state:'unknown',code:'deadline'};
      const reply=t.report(db,owner.id,id,2,receipt,5);
      assert.deepEqual(reply,{transferId:id,step:2,state:'unknown'});
      assert.deepEqual(t.report(db,owner.id,id,2,receipt,6),reply);
      assert.throws(()=>t.create(db,owner,{id:randomUUID(),member:'primary',direction:'download',path:'next'},7),error('transfer_busy'));
      const recovered=new LinuxTransfers(db,8);
      assert.throws(()=>recovered.create(db,owner,{id:randomUUID(),member:'primary',direction:'download',path:'next'},9),error('transfer_busy'));
    } finally {db.close();}
  });
}
