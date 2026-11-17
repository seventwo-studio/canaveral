import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AdminSystem } from "../../src/control/admin-system.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
import { AccessSessions } from "../../src/control/sessions.ts";
import { ModelJobs } from "../../src/model-jobs.ts";
import { machineDigest } from "../../src/control/machines.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";

function adminFixture(t: Parameters<typeof leaseFixture>[0]) {
  const f = leaseFixture(t), admin = new AdminSystem(f.leases);
  let principal: Principal = {kind:"operator",user:null,scopes:["admin"]};
  const call = (method: string,path: string,body:Record<string,unknown> = {}) => admin.handle({method,path,parts:path.split('/').filter(Boolean),query:new URLSearchParams(),body,token:f.options.adminToken,principal:()=>principal})!.body as any;
  return {...f,call,setPrincipal:(p:Principal)=>{principal=p;}};
}
test("admin recovery uses separate audited receipts, rejects lesser scope and keeps consumer authority separate", async t => {
  const f=adminFixture(t), lease=await f.request("POST","/v1/leases",f.acquire()); f.ready(lease);
  const mutation={id:randomUUID()},path=`/v1/admin/leases/${lease.id}/release`;
  f.setPrincipal({kind:"session",user:{id:randomUUID(),username:"reader",role:"user",status:"active"},scopes:["machines:read"]});
  assert.throws(()=>f.call("GET","/v1/admin/system"),failure(403));
  assert.throws(()=>f.call("POST",path,mutation),failure(403));
  f.setPrincipal({kind:"operator",user:null,scopes:["admin"]});
  const released=f.call("POST",path,mutation);assert.equal(released.state,"released");
  assert.deepEqual(f.call("POST",path,mutation),released);
  assert.throws(()=>f.call("POST",`/v1/admin/applications/${f.app.id}/revoke`,mutation),failure(409));
  assert.throws(()=>f.call("POST",path,{...mutation,unexpected:true}),failure(400));
  const snapshot=f.call("GET","/v1/admin/system");assert.equal(snapshot.leases[0].cleanup,"pending");assert.equal(snapshot.leases[0].reservationHeld,true);
  assert.equal(snapshot.leases[0].members[0].requestedState,"stopped");
  await assert.rejects(f.request("GET",`/v1/leases/${lease.id}`,{},f.options.adminToken),failure(401));
  f.store.transaction(db=>assert.equal(db.prepare("SELECT actor FROM admin_system_mutations WHERE id=?").get(mutation.id)!.actor,"operator"));
});
test("closing an access session revokes transport authorization without releasing its lease",async t=>{
  const f=adminFixture(t),sessions=new AccessSessions(f.store,f.options),lease=await f.request("POST","/v1/leases",f.acquire());f.ready(lease);
  const key=await f.scoped(lease.id), session=sessions.create(lease.id,key,{id:randomUUID(),member:"primary",capability:"pty"}).session;
  assert.equal(f.call("POST",`/v1/admin/sessions/${session.id}/close`,{id:randomUUID()}).state,"closed");
  assert.deepEqual(sessions.sessionCommand({type:"sessions.authorized",sessionId:session.id,generation:session.generation}),{authorized:false});
  assert.equal((await f.request("GET",`/v1/leases/${lease.id}`)).state,"ready");
  const second=sessions.create(lease.id,key,{id:randomUUID(),member:"primary",capability:"pty"}).session;
  f.call("POST",`/v1/admin/leases/${lease.id}/release`,{id:randomUUID()});
  assert.deepEqual(sessions.sessionCommand({type:"sessions.authorized",sessionId:second.id,generation:second.generation}),{authorized:false});
});
test("mixed snapshot omits optional nulls and payloads; configuration omits enrollment credential hashes",async t=>{
  const f=adminFixture(t),lease=await f.request("POST","/v1/leases",f.acquire());f.ready(lease);
  f.leases.requests.submit(f.app.credential,{id:randomUUID(),kind:"lease",intent:{templateId:f.image.id,templateRevision:"1",arch:"amd64"}});
  f.store.transaction(db=>db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'queued',NULL,?,?)").run(randomUUID(),lease.members[0].machineId,f.host,JSON.stringify({secret:"DO-NOT-EXPOSE"}),f.now(),f.now()));
  const snapshot=f.call("GET","/v1/admin/system");assert.equal(snapshot.requests.length,1);assert.equal(Object.hasOwn(snapshot.requests[0],"expiresAt"),false);assert.equal(Object.hasOwn(snapshot.operations[0],"leaseId"),false);
  const encoded=JSON.stringify(snapshot);for(const forbidden of ["DO-NOT-EXPOSE",f.app.credential,machineDigest(f.app.credential),f.hostToken])assert.ok(!encoded.includes(forbidden));
  f.store.transaction(db=>db.prepare("INSERT INTO runner_enrollments VALUES (?,?,?,?,?,?,?,?,0)").run(randomUUID(),f.options.controllerId,randomUUID(),1,randomUUID(),"TOKEN-HASH",f.now()+100,"CREDENTIAL-HASH"));
  const config=JSON.stringify(f.call("GET","/v1/admin/configuration"));assert.ok(!config.includes("CREDENTIAL-HASH"));assert.ok(!config.includes("TOKEN-HASH"));
});
test("revoke cascades leases and waiting requests; admin request and unclaimed model cancellation preserve lifecycle semantics",async t=>{
  const f=adminFixture(t),lease=await f.request("POST","/v1/leases",f.acquire());
  const requestId=randomUUID();f.leases.requests.submit(f.app.credential,{id:requestId,kind:"lease",intent:{templateId:f.image.id,templateRevision:"1",arch:"amd64"}});
  assert.equal(f.call("POST",`/v1/admin/requests/${requestId}/cancel`,{id:randomUUID()}).state,"cancelled");
  new ModelJobs(f.store,f.apps,undefined);const job=randomUUID();
  f.store.transaction(db=>db.prepare("INSERT INTO model_jobs(application,id,submission,model,digest,state,created,updated) VALUES (?,?,?,?,?,'queued',?,?)").run(f.app.id,job,"{}","model","digest",f.now(),f.now()));
  assert.equal(f.call("POST",`/v1/admin/jobs/${job}/cancel`,{id:randomUUID()}).state,"cancelled");
  assert.equal(f.call("GET","/v1/admin/system").jobs[0].cancelRequested,true);
  f.call("POST",`/v1/admin/applications/${f.app.id}/revoke`,{id:randomUUID()});
  f.store.transaction(db=>{assert.equal(db.prepare("SELECT state FROM leases WHERE id=?").get(lease.id)!.state,"released");assert.equal(db.prepare("SELECT cleanup FROM model_jobs WHERE id=?").get(job)!.cleanup,"complete");});
});
test("Linux operator release reclaims only unclaimed leases and fences stale runner runtime",t=>{
  const f=adminFixture(t),domain=randomUUID();
  f.store.transaction(db=>db.prepare("INSERT INTO resource_domains VALUES (?,?,?,?)").run(domain,"fixture",JSON.stringify({cpu:8,memoryMiB:8192,diskGiB:80}),f.now()));
  const seed=(claimed:boolean)=>{
    const id=randomUUID(),reservation=randomUUID();
    f.store.transaction(db=>{
      const row:Record<string,string|number|null>={id,application:f.app.id,request:"{}",image_id:"fixture-linux",image_revision:"1",arch:"amd64",backend:"kubevirt",digest:"sha256:"+"ab".repeat(32),resources:JSON.stringify({cpu:1,memoryMiB:1024,diskGiB:4}),capabilities:"[]",required:"[]",member:randomUUID(),domain,reservation,state:"ready",runtime:"running",cleanup:"notRequested",cleanup_id:null,revision:1,created:f.now(),expires:f.now()+120,max_expires:f.now()+7200,provision_deadline:f.now()+60,credential:null};
      db.prepare(`INSERT INTO linux_leases (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
      db.prepare("INSERT INTO resource_reservations VALUES (?,?,'linux-lease',?,?,'held',?,NULL)").run(reservation,domain,id,row.resources!,f.now());
      if(claimed)db.prepare("INSERT INTO linux_lease_assignments(id,claim,lease,controller,runner,generation,incarnation,created) VALUES (?,?,?,?,?,1,?,?)").run(randomUUID(),randomUUID(),id,f.options.controllerId,randomUUID(),randomUUID(),f.now());
    });
    return {id,reservation};
  };
  const unclaimed=seed(false),claimed=seed(true);
  let snapshot=f.call("GET","/v1/admin/system");assert.equal(snapshot.leases.find((l:any)=>l.id===claimed.id).runtimeState,"unknown");
  for(const l of [unclaimed,claimed])assert.equal(f.call("POST",`/v1/admin/leases/${l.id}/release`,{id:randomUUID()}).state,"released");
  f.store.transaction(db=>{
    assert.equal(db.prepare("SELECT state FROM resource_reservations WHERE id=?").get(unclaimed.reservation)!.state,"released");
    assert.equal(db.prepare("SELECT state FROM resource_reservations WHERE id=?").get(claimed.reservation)!.state,"held");
    assert.equal(db.prepare("SELECT cleanup FROM linux_leases WHERE id=?").get(claimed.id)!.cleanup,"pending");
  });
});
test("cancel receipt cannot cross request/job categories; model runtime from revoked binding remains unknown",t=>{
  const f=adminFixture(t);new ModelJobs(f.store,f.apps,undefined);
  const id=randomUUID(),mutation={id:randomUUID()};
  f.leases.requests.submit(f.app.credential,{id,kind:"lease",intent:{templateId:f.image.id,templateRevision:"1",arch:"amd64"}});
  f.store.transaction(db=>{
    db.prepare("INSERT INTO model_jobs(application,id,submission,model,digest,state,created,updated) VALUES (?,?,?,?,?,'running',?,?)").run(f.app.id,id,"{}","model","digest",f.now(),f.now());
    db.prepare("INSERT INTO model_assignments(id,claim,application,job,controller,runner,generation,incarnation,domain,reservation,created) VALUES (?,?,?,?,?,?,1,?,?,?,?)").run(randomUUID(),randomUUID(),f.app.id,id,f.options.controllerId,randomUUID(),randomUUID(),randomUUID(),randomUUID(),f.now());
  });
  assert.equal(f.call("GET","/v1/admin/system").jobs[0].state,"unknown");
  f.call("POST",`/v1/admin/requests/${id}/cancel`,mutation);
  assert.throws(()=>f.call("POST",`/v1/admin/jobs/${id}/cancel`,mutation),failure(409));
  const cancelled=f.call("POST",`/v1/admin/jobs/${id}/cancel`,{id:randomUUID()});assert.equal(cancelled.state,"cancel_requested");
  f.store.transaction(db=>{const row=db.prepare("SELECT * FROM model_jobs WHERE id=?").get(id)!;assert.equal(row.cancel_requested,1);assert.equal(row.cleanup,"pending");assert.equal(row.closed,0);});
});
test("inference projection honors host freshness and does not expose prompt, result or provider detail",async t=>{
  const f=adminFixture(t);
  const {createModule}=await import("../../src/control/inference.ts");createModule(f.store,f.options);
  const id=randomUUID(),model={id:"fixture:latest",digest:"sha256:"+"a".repeat(64),capability:"generation",resources:{cpu:1,memoryMiB:1024,diskGiB:1}};
  f.store.transaction(db=>db.prepare("INSERT INTO inference_jobs(id,host,request,definition,desired,state,detail,result,updated,created) VALUES (?,?,?,?,'running','running',?,NULL,?,?)").run(id,f.host,JSON.stringify({model:model.id,prompt:"PRIVATE-PROMPT"}),JSON.stringify(model),"PRIVATE-PROVIDER-DETAIL",f.now(),f.now()));
  assert.equal(f.call("GET","/v1/admin/system").jobs[0].state,"running");
  f.advance(30);const encoded=JSON.stringify(f.call("GET","/v1/admin/system"));assert.ok(encoded.includes('"state":"unknown"'));assert.ok(!encoded.includes("PRIVATE-PROMPT"));assert.ok(!encoded.includes("PRIVATE-PROVIDER-DETAIL"));
});
test("system and configuration histories remain reachable through bounded explicit pages",t=>{
  const f=adminFixture(t);
  f.store.transaction(db=>{
    for(let n=0;n<101;n++){
      const id=randomUUID();db.prepare("INSERT INTO requests VALUES (?,?, 'lease','{}','{}',0,NULL,NULL,'cancelled',?,?,NULL,NULL,NULL)").run(f.app.id,id,n,f.now());
      db.prepare("INSERT INTO resource_domains VALUES (?,?,?,?)").run(randomUUID(),`domain-${n}`,JSON.stringify({cpu:1,memoryMiB:1,diskGiB:1}),f.now());
    }
  });
  const first=f.call("GET","/v1/admin/system"),second=f.call("GET","/v1/admin/system/pages/1");
  assert.equal(first.page,0);assert.equal(first.nextPage,1);assert.equal(first.requests.length,100);assert.equal(second.requests.length,1);assert.equal(second.nextPage,null);
  assert.equal(new Set([...first.requests,...second.requests].map((r:any)=>r.id)).size,101);
  const config=f.call("GET","/v1/admin/configuration");assert.equal(config.resourceDomains.length,100);assert.equal(config.nextPage,1);
  assert.equal(f.call("GET","/v1/admin/configuration/pages/1").resourceDomains.length,1);
  assert.throws(()=>f.call("GET","/v1/admin/system/pages/1000001"),failure(400));
});
test("application-qualified cancellation distinguishes shared request/job UUIDs and binds receipts to the selector",t=>{
  const f=adminFixture(t);new ModelJobs(f.store,f.apps,undefined);
  const shared=randomUUID(),apps=[f.app.id,f.other.id];
  f.store.transaction(db=>{
    for(const app of apps){
      db.prepare("INSERT INTO requests VALUES (?,?,'lease','{}','{}',0,NULL,NULL,'waiting',1,?,NULL,NULL,NULL)").run(app,shared,f.now());
      db.prepare("INSERT INTO model_jobs(application,id,submission,model,digest,state,created,updated) VALUES (?,?,?,?,?,'queued',?,?)").run(app,shared,"{}","fixture-model","digest",f.now(),f.now());
    }
  });
  for(const category of ["requests","jobs"]){
    const path=`/v1/admin/${category}/${shared}/cancel`,mutation={id:randomUUID(),applicationId:f.app.id};
    assert.throws(()=>f.call("POST",path,{id:randomUUID()}),failure(409));
    assert.throws(()=>f.call("POST",path,{id:randomUUID(),applicationId:null}),failure(400));
    const result=f.call("POST",path,mutation);assert.equal(result.state,"cancelled");assert.equal(result.applicationId,f.app.id);
    assert.deepEqual(f.call("POST",path,mutation),result);
    assert.throws(()=>f.call("POST",path,{...mutation,applicationId:f.other.id}),failure(409));
    f.store.transaction(db=>{
      const table=category==="jobs" ? "model_jobs" : "requests";
      assert.equal(db.prepare(`SELECT state FROM ${table} WHERE application=? AND id=?`).get(f.other.id,shared)!.state,category==="jobs" ? "queued" : "waiting");
    });
    assert.equal(f.call("POST",path,{id:randomUUID(),applicationId:f.other.id}).state,"cancelled");
  }
  assert.throws(()=>f.call("POST",`/v1/admin/applications/${f.app.id}/revoke`,{id:randomUUID(),applicationId:f.app.id}),failure(400));
});
