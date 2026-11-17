import { test } from "node:test";
import assert from "node:assert/strict";
import { appleNATAddress } from "../../src/providers/apple-nat.ts";
import { AppleBindings, requireRunningAppleStatus, type AppleBindingEvidence } from "../../src/providers/apple-binding.ts";
import { GuestUnavailableError, ServiceError } from "../../src/errors.ts";
import { randomUUID, createHash } from "node:crypto";
import { GuestHelperAccess } from "../../src/control/sessions.ts";
import { GuestHelperBinding } from "../../src/control/session-protocol.ts";
const mac = "02:ab:22:33:44:55";
const record = (extra = "", hw = `1,${mac}`, ip = "192.168.64.2", lease = "0xfffffff0") => `{\nhw_address=${hw}\nip_address=${ip}\nlease=${lease}\n${extra}\n}\n`;
test("strict Apple NAT supported evidence and complete refusal matrix", () => {
  assert.equal(appleNATAddress(record(),mac,1000),"192.168.64.2");
  for (const input of ["", record()+record(),record("lease=0xfffffffe"), record("",`ff,${mac}`),record("",`1,0:11:22:33:44:55`),record("",`1,${mac.toUpperCase()}`),record("",`1,${mac}`,"127.0.0.1"),record("",`1,${mac}`,"169.254.1.1"),record("",`1,${mac}`,"192.168.064.2"),record("",`1,${mac}`,"8.8.8.8"),record("",`1,${mac}`,"192.168.64.2","0x10"),record().replace(/lease=.*/,"lease=garbage"),record().replace(/hw_address=.*/,"name=cvm-fixture"),record()+record("","1,02:99:99:99:99:99"), record()+record("","unknown","192.168.64.2","unknown"),record()+"{", "x".repeat(262145)]) assert.throws(()=>appleNATAddress(input,mac,1000), input.slice(0,100));
  assert.equal(appleNATAddress(record()+record("","unknown","192.168.64.2","0x10"),mac,1000),"192.168.64.2");
});
function pendingFixture() {
  const bindings = new AppleBindings(); let now = 10, allowed = true, identity = "original", finish!: (v:string)=>void, probes=0;
  const authority = { authorized:()=>allowed, clock:{suspendAware:true,bootId:randomUUID(),now:()=>now,wall:()=>1000} };
  const assignment = {version:1 as const,machineId:randomUUID(),leaseId:randomUUID(),launchId:randomUUID(),fingerprint:"a".repeat(64)};
  const evidence = (): AppleBindingEvidence => ({assignment,credential:"x".repeat(43),identity,pinned:{address:"192.168.64.2",serverName:assignment.launchId+".canaveral.invalid",sha256:"",leafDER:Buffer.alloc(0)}});
  const probe=()=>{probes++;return new Promise<string>(r=>finish=r);};
  return {bindings,authority,evidence,probe,finish:()=>finish("process"),probes:()=>probes,setNow:(v:number)=>now=v,revoke:()=>allowed=false,change:()=>identity="changed"};
}
test("pending resolve deduplicates and cleanup rejects late probes without handshaking",async()=>{
  const f=pendingFixture(), first=f.bindings.resolve("owned",f.authority,f.evidence,f.probe);
  assert.equal(f.bindings.resolve("owned",f.authority,f.evidence,f.probe),first);assert.equal(f.probes(),1);
  f.bindings.closeMachine("owned"); f.finish(); await assert.rejects(first); assert.equal(f.bindings.resolve("owned",f.authority,f.evidence,f.probe),first);
});

test("transient pre-verification failures need a later explicit call and never replay the failed call", async () => {
  for (const phase of ["probe", "dial"]) {
    const f = pendingFixture(); let probes = 0, dials = 0;
    const bindings = new AppleBindings(async (_factory, _evidence, current) => {
      if (++dials === 1 && phase === "dial") throw new GuestUnavailableError("not ready",503);
      return new GuestHelperBinding(async () => ({}), current);
    });
    const probe = async () => { if (++probes === 1 && phase === "probe") throw new GuestUnavailableError("route not ready",503); return "birth"; };
    try {
      await assert.rejects(bindings.resolve("owned", f.authority, f.evidence, probe));
      assert.equal(probes,1); assert.equal(dials,phase === "probe" ? 0 : 1);
      await new Promise(r => setImmediate(r)); assert.equal(probes,1);
      const binding = await bindings.resolve("owned", f.authority, f.evidence, probe);
      assert.equal(binding.authorized(),true); assert.equal(probes,2);
    } finally { bindings.close(); }
  }
});
test("proof lapse closes the old binding but a live guard permits a new explicit resolution", async () => {
  const f = pendingFixture(); let dials = 0;
  const bindings = new AppleBindings(async (_factory,_evidence,current) => { dials++; return new GuestHelperBinding(async()=>({}),current); });
  try {
    const old = await bindings.resolve("owned",f.authority,f.evidence,async()=>"birth");
    f.setNow(12); assert.equal(old.authorized(),false); assert.equal(dials,1);
    const fresh = await bindings.resolve("owned",f.authority,f.evidence,async()=>"birth");
    assert.notEqual(fresh,old); assert.equal(fresh.authorized(),true); assert.equal(old.authorized(),false); assert.equal(dials,2);
    f.revoke(); assert.equal(fresh.authorized(),false);
    await assert.rejects(bindings.resolve("owned",f.authority,f.evidence,async()=>"birth"));
  } finally { bindings.close(); }
});
test("custody and authentication failures remain terminal and raw resolver diagnostics are redacted", async () => {
  const f = pendingFixture(); let dials=0;
  const bindings = new AppleBindings(async()=>{dials++;throw new ServiceError("identity failed",401);});
  try {
    const first = bindings.resolve("owned",f.authority,f.evidence,async()=>"birth"); await assert.rejects(first);
    assert.equal(bindings.resolve("owned",f.authority,f.evidence,async()=>"birth"),first); assert.equal(dials,1);
  } finally { bindings.close(); }
  const unavailable = new AppleBindings();
  try { await assert.rejects(unavailable.resolve("owned",f.authority,()=>{throw new Error("/private/secret-state");},async()=>"birth"), (error: unknown) => error instanceof ServiceError && !error.message.includes("secret-state")); }
  finally { unavailable.close(); }
});
test("running proof needs a fresh Swift heartbeat and actual running runtime state", () => {
  const status = {phase:"Running",runnerProtocol:1,runtimeState:1,updatedAt:1000-978307200};
  requireRunningAppleStatus(status,1000); requireRunningAppleStatus(status,1007.99);
  for (const wall of [1008,994.99,NaN,Infinity]) assert.throws(()=>requireRunningAppleStatus(status,wall));
  for (const bad of [{...status,phase:"Starting"},{...status,runtimeState:0},{...status,runtimeState:2},{...status,runnerProtocol:undefined},{...status,updatedAt:NaN}]) assert.throws(()=>requireRunningAppleStatus(bad,1000));
});
test("custody, authority, suspend age, backward, nonfinite and changed boot invalidate pending proofs",async()=>{
  for (const change of [(f:ReturnType<typeof pendingFixture>)=>f.change(),(f:ReturnType<typeof pendingFixture>)=>f.revoke(),(f:ReturnType<typeof pendingFixture>)=>f.setNow(12),(f:ReturnType<typeof pendingFixture>)=>f.setNow(9),(f:ReturnType<typeof pendingFixture>)=>f.setNow(NaN),(f:ReturnType<typeof pendingFixture>)=>f.authority.clock.bootId=randomUUID()]) {
    const f=pendingFixture(), promise=f.bindings.resolve("owned",f.authority,f.evidence,f.probe);change(f);f.finish();await assert.rejects(promise);f.bindings.close();
  }
});
test("stale completion cannot remove replacement entry after cleanup sweep",async()=>{
  const f=pendingFixture(), old=f.bindings.resolve("owned",f.authority,f.evidence,f.probe);f.bindings.sweep(new Set());const finishOld=f.finish;
  const replacement=f.bindings.resolve("owned",f.authority,f.evidence,async()=>{throw Error("replacement");});
  finishOld(); await assert.rejects(old); await assert.rejects(replacement); assert.equal(f.bindings.resolve("owned",f.authority,f.evidence,f.probe),replacement);
});
test("session revocation during blocked chunk, buffered chunk and verification never succeeds or revives",async()=>{
  for (const phase of ["blocked","buffered","verify"]) {
    let allowed=true, unblock!:()=>void;const bytes=Buffer.from("hello");
    const b=new GuestHelperBinding(async(path,body)=>{
      const id=body!.id;
      if(path.endsWith("/begin")) return {id,state:"reading",bytes:5};
      if(path.endsWith("/chunk")) {if(phase==="blocked")await new Promise<void>(r=>unblock=r);return {id,data:bytes.toString("base64"),offset:5};}
      if(path.endsWith("/finish")) {await new Promise<void>(r=>unblock=r);return {id,state:"verified",bytes:5,sha256:createHash("sha256").update(bytes).digest("hex")};}
      return {id};
    },()=>true);
    const access=new GuestHelperAccess(()=>b), reader=await access.streamDownload({}, {os:"macos"},"","/hello",undefined,()=>allowed);
    if(phase==="blocked") {const read=reader.read(5);await new Promise(r=>setImmediate(r));allowed=false;unblock();await assert.rejects(Promise.resolve(read));}
    else if(phase==="buffered") {assert.equal((await reader.read(1)).length,1);allowed=false;await assert.rejects(Promise.resolve(reader.read(4)));}
    else {await reader.read(5);const verifying=reader.verify();await new Promise(r=>setImmediate(r));allowed=false;unblock();await assert.rejects(Promise.resolve(verifying));}
    allowed=true;await assert.rejects(Promise.resolve(reader.verify()));await reader.close();
  }
});

test('maintenance never overlaps probes and suspend expiry cannot be refreshed',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let now=10,probes=0,finish!:()=>void;
  const f=pendingFixture();
  const authority={...f.authority,clock:{...f.authority.clock,now:()=>now}};
  const bindings=new AppleBindings(async(_factory,_evidence,current)=>new GuestHelperBinding(async()=>({}),current));
  const probe=async()=>{probes++;if(probes>1)await new Promise<void>(r=>finish=r);return 'birth';};
  const binding=await bindings.resolve('owned',authority,f.evidence,probe);
  now=11;t.mock.timers.tick(1000);await Promise.resolve();assert.equal(probes,2);
  now=12;t.mock.timers.tick(1000);await Promise.resolve();assert.equal(binding.authorized(),false);assert.equal(probes,2);
  finish();await Promise.resolve();await Promise.resolve();now=10;assert.equal(binding.authorized(),false);bindings.close();
});
test("proof maintenance runs during the initial handshake without resolving twice", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const f = pendingFixture(); let now=10,probes=0,dials=0,finish!:()=>void;
  const authority = {...f.authority,clock:{...f.authority.clock,now:()=>now}};
  const bindings = new AppleBindings(async(_factory,_evidence,current)=>{
    dials++; await new Promise<void>(resolve=>finish=resolve); return new GuestHelperBinding(async()=>({}),current);
  });
  try {
    const pending = bindings.resolve("owned",authority,f.evidence,async()=>{probes++;return "birth";});
    await new Promise(r=>setImmediate(r)); assert.equal(dials,1);
    for (const second of [11,12,13]) { now=second;t.mock.timers.tick(1000);await new Promise(r=>setImmediate(r)); }
    assert.equal(probes,4); assert.equal(dials,1);
    finish(); assert.equal((await pending).authorized(),true);
  } finally { bindings.close(); }
});
