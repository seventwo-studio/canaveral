import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { leaseFixture, failure } from "./leases-fixture.test.ts";
import { LegacyLeases } from "../../src/control/leases.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { Requests } from "../../src/requests.ts";

const envelope = (f: ReturnType<typeof leaseFixture>, extra: Record<string,unknown> = {}) => {
  const { id, ...intent } = f.acquire(); return { id,kind:"lease",intent,...extra };
};
test("waiting over-request admits after positive release; deadlines start at admission", async t => {
  const f = leaseFixture(t); f.changeOffer({capacity:{cpu:1,memoryMiB:1024,diskGiB:4}}); f.beat();
  const a = await f.request("POST","/v1/requests",envelope(f)); assert.equal(a.state,"admitted");
  const pending = envelope(f), b = await f.request("POST","/v1/requests",pending); assert.equal(b.state,"waiting");
  await f.request("POST",`/v1/leases/${a.id}/release`,{id:randomUUID()});
  // Unstarted generic assignments require the existing controller's positive cleanup path.
  f.beat({ reports: { [a.members?.[0]?.machineId ?? (await f.request("GET",`/v1/leases/${a.id}`)).members[0].machineId]: { state:"stopped" } } });
  const lease=await f.request("GET",`/v1/leases/${a.id}`), cleanup=lease.members[0].cleanup;
  f.beat({reports:{[lease.members[0].machineId]:{state:"stopped",leaseCleanup:{id:cleanup.id,leaseId:a.id,state:"complete",attempt:1,executionStopped:true,storageRemoved:true,credentialsErased:true}}}});
  f.leases.requests.pass();
  assert.equal((await f.request("GET",`/v1/requests/${b.id}`)).state,"admitted");
});
test("replay, normalization, changed intent, hiding, waiting cap and exact deadline", async t => {
  const f=leaseFixture(t); f.changeOffer({leaseProtocol:undefined}); f.beat();
  const limited=f.application({maxWaitingRequests:1}), req=envelope(f,{deadline:new Date(1001*1000).toISOString(),source:{run:"42"}});
  const first=await f.raw("POST","/v1/requests",req,limited.credential); assert.equal(first!.status,201);
  assert.equal((await f.raw("POST","/v1/requests",req,limited.credential))!.status,200);
  await assert.rejects(f.request("POST","/v1/requests",{...req,priority:-1},limited.credential),failure(409));
  await assert.rejects(f.request("POST","/v1/requests",req,f.other.credential),failure(404));
  await assert.rejects(f.request("GET",`/v1/requests/${req.id}`,{},f.other.credential),failure(404));
  await assert.rejects(f.request("POST","/v1/requests",envelope(f),limited.credential),failure(429,"request_waiting_limit"));
  f.setNow(1001);
  assert.equal((await f.request("GET",`/v1/requests/${req.id}`,{},limited.credential)).state,"expired");
});
test("cancel serializes against admission; admitted cancellation releases through lifecycle",async t=>{
  const f=leaseFixture(t); f.changeOffer({leaseProtocol:undefined}); f.beat();
  const req=envelope(f); await f.request("POST","/v1/requests",req);
  assert.equal((await f.request("POST",`/v1/requests/${req.id}/cancel`)).state,"cancelled");
  f.changeOffer({leaseProtocol:1}); f.beat(); f.leases.requests.pass();
  assert.equal((await f.request("GET",`/v1/requests/${req.id}`)).target,null);
  const admitted=await f.request("POST","/v1/requests",envelope(f));
  assert.equal((await f.request("POST",`/v1/requests/${admitted.id}/cancel`)).state,"admitted");
  assert.equal((await f.request("GET",`/v1/leases/${admitted.id}`)).state,"released");
});
test("old database and queue survive reopen; revocation cancels waiting without credentials",async t=>{
  const f=leaseFixture(t);
  const held=await f.request("POST","/v1/leases",f.acquire());
  await f.request("POST",`/v1/leases/${held.id}/release`,{id:randomUUID()});
  const snapshot=()=>f.store.transaction(db=>JSON.stringify(["consumers","leases","lease_mutations","machines"].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())));
  const before=snapshot();
  f.changeOffer({leaseProtocol:undefined}); f.beat();
  const req=envelope(f); await f.request("POST","/v1/requests",req);
  const reopened=new LegacyLeases(new SqliteStore(f.store.path,f.now),f.options);
  assert.equal(reopened.requests.inspect(f.app.credential,req.id).state,"waiting");
  assert.equal(snapshot(),before);
  f.store.transaction(db=>{
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM requests").all()).includes(f.app.credential));
    db.exec("DROP TABLE requests; DROP TABLE request_scheduler");
  });
  const upgraded=new LegacyLeases(new SqliteStore(f.store.path,f.now),f.options);
  assert.equal(upgraded.applications.authenticate(f.app.credential).id,f.app.id);
  upgraded.requests.submit(f.app.credential,req); f.apps.revoke(f.app.id);
  f.store.transaction(db=>assert.equal(db.prepare("SELECT state FROM requests WHERE id=?").get(req.id)!.state,"cancelled"));
});
test("round robin, priority, FIFO, skips and failure isolation with durable turns",t=>{
  const f=leaseFixture(t), app=f.application({maxRequestPriority:10});
  const accepted:string[]=[], blocked=new Set<string>();
  const queue=new Requests(f.store,f.apps,(_kind,_application,intent)=>{
    if(blocked.has(String(intent.id))) throw new (ServiceError)("capacity",503);
    f.store.transaction(db=>db.prepare("INSERT INTO fixture_effects VALUES(?)").run(String(intent.id)));
    if(intent.templateId==="bad") throw new ServiceError("removed grant",403);
    accepted.push(String(intent.id));
  },()=>{});
  f.store.transaction(db=>db.exec("CREATE TABLE fixture_effects(id TEXT PRIMARY KEY)"));
  const submit=(token:string,priority=0,templateId="fixture-image")=>{const req=envelope(f,{priority}); req.intent={...req.intent,templateId};queue.submit(token,req);return req.id;};
  const bad=submit(app.credential,10,"bad"), head=submit(app.credential,9), high=submit(app.credential,5), fifo=submit(app.credential,5), other=submit(f.other.credential);
  blocked.add(head);queue.pass();
  assert.equal(queue.inspect(app.credential,bad).state,"rejected");
  f.store.transaction(db=>assert.equal(db.prepare("SELECT count(*) n FROM fixture_effects WHERE id=?").get(bad)!.n,0));
  assert.equal(queue.inspect(app.credential,head).state,"waiting");
  assert.ok(accepted.indexOf(other)<accepted.indexOf(fifo));assert.ok(accepted.indexOf(high)<accepted.indexOf(fifo));
  const restored=new Requests(new SqliteStore(f.store.path,f.now),f.apps,(_k,_a,i)=>{accepted.push(String(i.id));},()=>{});
  blocked.clear();restored.pass();assert.equal(restored.inspect(app.credential,head).state,"admitted");
});
import { ServiceError } from "../../src/errors.ts";

test("queue cannot overspend mapped host and runner capacity",async t=>{
  const f=leaseFixture(t), domain=randomUUID(), runners=f.leases.linux.runners!;
  f.changeOffer({capacity:{cpu:1,memoryMiB:1024,diskGiB:4}});f.beat();
  const binding={controllerId:f.options.controllerId,runnerId:randomUUID(),generation:1,incarnationId:randomUUID()}, id=randomUUID(), credential=key();
  const issued=runners.issue({id,...binding,ttlSeconds:60});
  runners.consume((issued as {enrollmentToken:string}).enrollmentToken,{id,...binding,credential});
  const image={id:"runner-linux",revision:"1",arch:"amd64",os:"linux",mode:"headless",backend:"kubevirt",digest:"sha256:"+"ab".repeat(32),resources:{cpu:1,memoryMiB:1024,diskGiB:4},capabilities:["command"]};
  f.leases.linux.image(image);f.leases.linux.grant({applicationId:f.app.id,imageId:image.id,revision:"1",arch:"amd64",digest:image.digest});
  f.store.transaction(db=>{f.leases.linux.domains.define(db,{id:domain,name:"fixture",capacity:image.resources},f.now());new PhysicalDomains().map(db,f.host,domain);});
  f.leases.linux.approve({binding,domainId:domain,backend:"kubevirt",images:[{id:image.id,revision:"1",arch:"amd64",digest:image.digest}]});
  const generic=await f.request("POST","/v1/requests",envelope(f));assert.equal(generic.state,"admitted");
  const runner=await f.request("POST","/v1/requests",{id:randomUUID(),kind:"linux-lease",intent:{templateId:image.id,templateRevision:"1",arch:"amd64"}});
  assert.equal(runner.state,"waiting");
  f.store.transaction(db=>{assert.equal(physicalBudget(db,{hostId:f.host})!.reserved.cpu,1);assert.equal(db.prepare("SELECT count(*) n FROM linux_leases").get()!.n,0);});
});
import { PhysicalDomains,physicalBudget } from "../../src/physical-domains.ts";
import { key } from "./leases-fixture.test.ts";


test("quota-blocked application does not block another application with capacity",async t=>{
  const f=leaseFixture(t), limited=f.application({activeLeases:1});
  await f.request("POST","/v1/leases",f.acquire(),limited.credential);
  const blocked=await f.request("POST","/v1/requests",envelope(f),limited.credential);
  assert.equal(blocked.state,"waiting");
  const other=await f.request("POST","/v1/requests",envelope(f),f.other.credential);
  assert.equal(other.state,"admitted");
  assert.equal((await f.request("GET",`/v1/requests/${blocked.id}`,{},limited.credential)).state,"waiting");
});

test("bounded scan continuation reaches behind more than one pass of unfit requests",t=>{
  const f=leaseFixture(t), app=f.application({maxWaitingRequests:1000});let tail="";
  const queue=new Requests(f.store,f.apps,(_kind,_app,intent)=>{if(intent.id!==tail)throw new ServiceError("no fit",503);},()=>{});
  f.store.transaction(()=>{for(let i=0;i<270;i++){const req=envelope(f);queue.submit(app.credential,req);tail=req.id;}});
  queue.pass();assert.equal(queue.inspect(app.credential,tail).state,"waiting");
  const restored=new Requests(new SqliteStore(f.store.path,f.now),f.apps,(_kind,_app,intent)=>{if(intent.id!==tail)throw new ServiceError("no fit",503);},()=>{});
  restored.pass();assert.equal(restored.inspect(app.credential,tail).state,"admitted");
});


test("cancellation at the waiting deadline expires intent; normalized defaults replay",async t=>{
  const f=leaseFixture(t);f.changeOffer({leaseProtocol:undefined});f.beat();
  const req=envelope(f,{deadline:new Date(1001*1000).toISOString()});
  await f.request("POST","/v1/requests",req);
  const replay={...req,intent:{...req.intent,resources:{},name:`lease-${req.id}`,requiredCapabilities:[]},priority:0};
  assert.equal((await f.raw("POST","/v1/requests",replay))!.status,200);
  f.setNow(1001);
  assert.equal((await f.request("POST",`/v1/requests/${req.id}/cancel`)).state,"expired");
});
