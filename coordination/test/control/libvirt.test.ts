import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LibvirtProvider, LibvirtLeaseSupervisor, OwnedNativeConnection, domainXML, publishAuthorization, parseQMPThreads, enabledRuntimes, runtimeFor, NativeProvider, runSupervisorChild, LinuxDomainCgroup } from "../../src/providers/libvirt.ts";
import type { ExecutionSpec, LibvirtAdapters, NativeDriver, NativeSnapshot, ProcessBirth } from "../../src/providers/libvirt.ts";
import { LibvirtLeaseBinding, SupervisorJournal, StorageHandleGuard, bindDomainXML, validateDomainXML, canonical, fingerprint, inode, deadlineArtifact, hash } from "../../src/providers/libvirt-ownership.ts";
import type { RecordValue } from "../../src/providers/libvirt-ownership.ts";
function save(path:string,value:unknown):void{fs.writeFileSync(path,canonical(value),{mode:0o600});}
function temporary(t:{after(fn:()=>void):void}):string{const p=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"canaveral-libvirt-ts-")));fs.chmodSync(p,0o700);t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function syntheticELF(machine=62):Buffer{
  const b=Buffer.alloc(1024);b.set([127,69,76,70,2,1,1]);const u16=(o:number,v:number)=>b.writeUInt16LE(v,o),u32=(o:number,v:number)=>b.writeUInt32LE(v,o),u64=(o:number,v:number)=>b.writeBigUInt64LE(BigInt(v),o);
  u16(16,3);u16(18,machine);u32(20,1);u64(32,64);u64(40,512);u16(52,64);u16(54,56);u16(56,2);u16(58,64);u16(60,4);
  u32(64,1);u64(96,1024);u64(104,1024);u32(120,2);u64(128,240);u64(152,16);u64(160,16);
  const names=Buffer.from("\0canaveral_lease_deadline_install\0canaveral_lease_deadline_arm\0");names.copy(b,256);
  for(const[o,name,address]of [[408,1,176],[432,names.indexOf("canaveral_lease_deadline_arm"),192]]){u32(o!,name!);b[o!+4]=0x12;u16(o!+6,1);u64(o!+8,address!);u64(o!+16,16);}
  u32(580,1);u64(584,6);u64(592,176);u64(600,176);u64(608,64);u32(644,3);u64(664,256);u64(672,names.length);u32(708,11);u64(728,384);u64(736,72);u32(744,2);u64(760,24);return b;
}
class Driver implements NativeDriver{
  events:string[]=[];present=true;state:"shut off"|"paused"|"running"="shut off";lostCreate=false;lostResume=false;lostRetire=false;closeFails=false;unknownAbsence=false;afterCreate=()=>{};afterClose=()=>{};saved=0;snapshots=0;checkpoints=0;persistent=true;threads=[77];id=7;
  constructor(public xml:string,readonly uuid:string){}
  snapshot():NativeSnapshot{if(!this.present)throw Error("No domain");return{uuid:this.uuid,xml:this.xml,active:this.state!=="shut off",state:this.state,persistent:this.persistent,managedSave:this.saved,snapshots:this.snapshots,checkpoints:this.checkpoints,id:this.id,threads:this.threads};}
  create(flags:number):void{assert.equal(flags,3);this.events.push("create");this.state="paused";this.afterCreate();if(this.lostCreate)throw Error("private native text");}
  resume():void{this.events.push("resume");this.state="running";if(this.lostResume)throw Error("private native text");}
  lookup():"present"|"VIR_ERR_NO_DOMAIN"{if(this.unknownAbsence)throw Error("Unknown RPC");return this.present?"present":"VIR_ERR_NO_DOMAIN";}
  undefine(flags:number):void{assert.equal(flags,72);this.events.push("retire");this.present=false;if(this.lostRetire){this.lostRetire=false;throw Error("Lost retirement ack");}}
  close():void{this.events.push("close");this.afterClose();if(this.closeFails)throw Error("Unknown close");}
}
function fixture(t:{after(fn:()=>void):void}){
  const root=temporary(t),machine:RecordValue={id:randomUUID(),desired:"running",template:{id:"linux"},resources:{cpu:1,memoryMiB:512,diskGiB:4},lease:{id:randomUUID(),state:"provisioning"}};
  const image:RecordValue={os:"linux",arch:"amd64",mode:"headless",image:join(root,"base.raw")};fs.writeFileSync(image.image as string,"base",{mode:0o600});
  const folder=join(root,"assignment"),storageRoot=join(root,"disks"),storage=join(storageRoot,machine.id as string);fs.mkdirSync(folder,{mode:0o700});fs.mkdirSync(storageRoot,{mode:0o700});fs.mkdirSync(storage,{mode:0o700});
  const disk=join(storage,"disk.qcow2");fs.writeFileSync(disk,"private disk",{mode:0o600});save(join(folder,"assignment.json"),{fingerprint:fingerprint(machine),leaseId:(machine.lease as RecordValue).id});save(join(storage,"canaveral-owner.json"),{fingerprint:fingerprint(machine)});
  let now=100,boot:string=randomUUID();const originalBoot=boot;
  const binding=new LibvirtLeaseBinding({machine_id:machine.id as string,lease_id:(machine.lease as RecordValue).id as string,boot_id:randomUUID(),host_boot_id:boot,fingerprint:fingerprint(machine),disk});
  const library=join(root,"deadline.so");fs.writeFileSync(library,syntheticELF(),{mode:0o600});
  const spec:ExecutionSpec={version:1,binding:{...binding},uri:"qemu:///system",library:{path:library,sha256:hash(fs.readFileSync(library))},storageIdentity:inode(fs.lstatSync(storage)),diskIdentity:inode(fs.lstatSync(disk))};
  save(join(folder,"libvirt-binding.json"),spec);save(join(folder,"libvirt-execution.json"),{...binding.identity(),phase:"prepared"});
  const driver=new Driver(bindDomainXML(domainXML(machine,image,disk),binding),machine.id as string),commands:string[][]=[];
  let auth:RecordValue={leaseID:(machine.lease as RecordValue).id,revision:1,remainingSeconds:30,fenced:false};image._leaseAuthorization=()=>({...auth});
  const adapters:LibvirtAdapters={fixture:true,platform:"linux",arch:"amd64",clock:()=>now,hostBoot:()=>boot,connect:()=>new OwnedNativeConnection(driver),run:async(argv)=>{commands.push([...argv]);const args=argv.slice(3);if(args[0]==="dumpxml")return driver.xml;if(args[0]==="domuuid")return machine.id as string;if(args[0]==="domstate")return driver.state;return"";},fileLease:()=>({verify(){},close(){}}),protectedRemove:path=>fs.rmSync(path,{recursive:true})};
  const provider=new LibvirtProvider({storage:storageRoot,templates:[],leaseDeadlineLibrary:library,adapters},root);
  const write=(prefix:string,value:RecordValue)=>{const j=new SupervisorJournal(folder,prefix,{fixture:true});try{j.write(value);}finally{j.close();}};
  const terminal=()=>{machine.desired="stopped";(machine.lease as RecordValue).state="expired";auth={...auth,fenced:true};machine.leaseCleanup={id:randomUUID(),leaseId:(machine.lease as RecordValue).id};};
  return{root,machine,image,folder,storage,disk,library,spec,binding,driver,adapters,provider,commands,write,terminal,get now(){return now;},set now(v:number){now=v;},get boot(){return boot;},set boot(v:string){boot=v;},originalBoot,get auth(){return auth;},set auth(v:RecordValue){auth=v;}};
}
// Ported from Python supervision, execution, readiness, stop, removal, reboot and usage fixtures.
test("exact XML UUID, ownership metadata, writable disk, firmware and TPM",t=>{
  const f=fixture(t);validateDomainXML(f.driver.xml,f.binding);assert.throws(()=>bindDomainXML(f.driver.xml,f.binding));
  for(const altered of [f.driver.xml.replace(f.binding.lease_id,randomUUID()),f.driver.xml.replace("disk.qcow2","foreign.qcow2"),f.driver.xml.replace("</devices>",'<hostdev/></devices>'),f.driver.xml.replace("</devices>",'<filesystem/></devices>'),f.driver.xml.replace("</devices>",'<disk type="file" device="disk"><source file="/foreign"/></disk></devices>'),f.driver.xml.replace("nvram.fd","../foreign"),f.driver.xml.replace("</os>",'<varstore/></os>'),f.driver.xml.replace("</domain>",'<metadata/></domain>')])assert.throws(()=>validateDomainXML(altered,f.binding));
  const win=bindDomainXML(domainXML(f.machine,{...f.image,os:"windows"},f.disk),f.binding);validateDomainXML(win,f.binding);for(const changed of [win.replace("tpm-state","../foreign"),win.replace('persistent_state="yes"','persistent_state="no"'),win.replace("</backend>","<encryption/></backend>")])assert.throws(()=>validateDomainXML(changed,f.binding));
});
test("XML rejects DTDs, unbound namespaces, entities and duplicate identities",t=>{
  const f=fixture(t);for(const changed of ["<!DOCTYPE domain>"+f.driver.xml,f.driver.xml.replace("cvm-","&external;"),f.driver.xml.replace("</domain>",`<uuid>${f.machine.id}</uuid></domain>`),f.driver.xml.replace("xmlns:cv", "xmlns:foreign"),f.driver.xml.replace('type="kvm"','type="kvm" type="qemu"')])assert.throws(()=>validateDomainXML(changed,f.binding));
});
test("journal lifetime locks and directory replacement never write into foreign state",t=>{
  const f=fixture(t),j=new SupervisorJournal(f.folder,undefined,{fixture:true});try{assert.throws(()=>new SupervisorJournal(f.folder,undefined,{fixture:true}));assert.throws(()=>j.prepare(f.binding));assert.ok(!canonical(j.read()).includes(f.disk));fs.renameSync(f.folder,f.folder+"-moved");fs.mkdirSync(f.folder,{mode:0o700});assert.throws(()=>j.write({foreign:true}));assert.deepEqual(fs.readdirSync(f.folder),[]);}finally{j.close();}
});
for(const alias of ["symlink","hardlink","public","oversized","malformed"] as const)test(`journal rejects ${alias}`,t=>{
  const f=fixture(t),path=join(f.folder,"libvirt-execution.json"),prior=fs.readFileSync(path),other=join(f.root,"foreign");fs.writeFileSync(other,prior,{mode:0o600});fs.unlinkSync(path);if(alias==="symlink")fs.symlinkSync(other,path);else if(alias==="hardlink")fs.linkSync(other,path);else fs.writeFileSync(path,alias==="oversized"?" ".repeat(16385):alias==="malformed"?"[]":prior,{mode:alias==="public"?0o644:0o600});const j=new SupervisorJournal(f.folder,undefined,{fixture:true});try{assert.throws(()=>j.read());}finally{j.close();}
});
function supervisorFixture(t:{after(fn:()=>void):void}){
  const f=fixture(t);let value:RecordValue|null={...f.binding.identity(),phase:"prepared"},auth:RecordValue={...f.binding.identity(),revision:1,deadline:130,fenced:false};const arms:number[]=[];
  const journal={read:()=>value,write:(v:RecordValue)=>{value=v;}};const make=()=>new LibvirtLeaseSupervisor(f.binding,journal,()=>auth,()=>true,()=>f.boot,()=>new OwnedNativeConnection(f.driver),{arm:d=>{arms.push(d);}},()=>f.now);const s=make();return{f,journal,arms,s,make,get value(){return value;},set value(v:RecordValue|null){value=v;},get auth(){return auth;},set auth(v:RecordValue){auth=v;}};
}
test("paused/autodestruct start is one-use; same revision cannot extend deadline",t=>{
  const x=supervisorFixture(t);x.s.start();assert.equal(x.value?.phase,"running");assert.deepEqual(x.f.driver.events,["create","resume"]);assert.equal(x.arms[0],130);x.f.now=110;x.auth={...x.auth,deadline:200};assert.equal(x.s.step(),true);assert.equal(x.s.deadline,130);x.auth={...x.auth,revision:2,deadline:160};assert.equal(x.s.step(),true);assert.equal(x.s.deadline,160);x.f.now=160;x.auth={...x.auth,revision:3,deadline:300};assert.equal(x.s.step(),false);assert.throws(()=>x.make().start());assert.equal(x.f.driver.events.filter(e=>e==="create").length,1);
});
for(const outcome of ["create","resume","expiry","clock rollback","late renewal","wrong boot","revocation","revision rollback","arm failure"] as const)test(`supervisor fences ${outcome} without replay`,t=>{
  const x=supervisorFixture(t);if(outcome==="create"){x.f.driver.lostCreate=true;assert.throws(()=>x.s.start(),e=>e instanceof Error&&!e.message.includes("private"));assert.ok(!x.f.driver.events.includes("resume"));}else if(outcome==="resume"){x.f.driver.lostResume=true;assert.throws(()=>x.s.start());}else if(outcome==="expiry"){x.f.driver.afterCreate=()=>{x.f.now=130;};assert.throws(()=>x.s.start());assert.ok(!x.f.driver.events.includes("resume"));}else{x.s.start();if(outcome==="clock rollback")x.f.now=99;if(outcome==="late renewal"){x.f.now=129;x.s.authorization=()=>{x.f.now=131;return{...x.auth,revision:2,deadline:200};};}if(outcome==="wrong boot")x.f.boot=randomUUID();if(outcome==="revocation")x.auth={...x.auth,fenced:true};if(outcome==="revision rollback")x.auth={...x.auth,revision:0};if(outcome==="arm failure"){x.auth={...x.auth,revision:2,deadline:160};x.s.fence.arm=()=>{throw Error("timer failed");};}assert.equal(x.s.step(),false);}assert.equal(x.value?.phase,"fenced");assert.equal(x.value?.executionStopped,undefined);assert.ok(x.f.driver.events.includes("close"));assert.throws(()=>x.make().start());assert.equal(x.f.driver.events.filter(e=>e==="create").length,1);
});
test("failed pending publication prevents create and retains uncertain history",t=>{
  const x=supervisorFixture(t),write=x.journal.write;x.journal.write=v=>{if(v.phase==="creating"||v.phase==="fenced")throw Error("fsync failed");write(v);};assert.throws(()=>x.s.start());assert.ok(!x.f.driver.events.includes("create"));assert.equal(x.value?.phase,"starting");assert.throws(()=>x.make().start());
});
test("revocation shortens kernel timer before close and preserves foreign journal",t=>{
  const x=supervisorFixture(t);x.s.start();x.value={...x.value,leaseId:randomUUID()};x.f.driver.afterClose=()=>assert.ok(x.arms.at(-1)!<=100.1);assert.equal(x.s.step(),false);assert.notEqual(x.value?.leaseId,x.f.binding.lease_id);
});
for(const malformed of [{revision:true},{version:true},{fenced:1},{deadline:NaN},{deadline:1e100},{leaseId:randomUUID()},{extra:true}])test(`malformed authority ${Object.keys(malformed)}`,t=>{const x=supervisorFixture(t);x.auth={...x.auth,...malformed};assert.throws(()=>x.s.start());assert.ok(!x.f.driver.events.includes("create"));});
test("publication subtracts sampling delay, never extends same revision and latches expiry",t=>{
  const f=fixture(t);assert.equal(f.provider.publish(f.machine,f.image,f.folder).deadline,129.75);f.now=110;f.auth={...f.auth,remainingSeconds:100};assert.equal(f.provider.publish(f.machine,f.image,f.folder).deadline,129.75);f.now=130;f.auth={...f.auth,revision:2};assert.equal(f.provider.publish(f.machine,f.image,f.folder).fenced,true);assert.throws(()=>publishAuthorization(f.binding,{read:()=>null,write:()=>{throw Error("must not publish");}},()=>{f.now=99;return f.auth;},()=>true,()=>f.boot,()=>f.now));
});
test("publication refuses replacement disks and preserves previous deadline",t=>{const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder);fs.renameSync(f.disk,f.disk+"-original");fs.writeFileSync(f.disk,"foreign",{mode:0o600});assert.throws(()=>f.provider.publish(f.machine,f.image,f.folder));assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"libvirt-authorization.json"),"utf8")).deadline,129.75);});
test("ELF inspection binds bytes and both architectures without loading code",t=>{const f=fixture(t),result=deadlineArtifact(f.library,"amd64");assert.equal(result.sha256,hash(fs.readFileSync(f.library)));assert.deepEqual(result.exports,["canaveral_lease_deadline_arm","canaveral_lease_deadline_install"]);fs.writeFileSync(f.library,syntheticELF(183));assert.equal(deadlineArtifact(f.library,"arm64").arch,"arm64");assert.throws(()=>deadlineArtifact(f.library,"amd64"));});
for(const change of ["hidden","undefined","noncode","zero-size","offset","dynamic","symbol-size","truncated","writable","hardlink","symlink"] as const)test(`ELF refuses ${change}`,t=>{
  const f=fixture(t),b=syntheticELF();if(change==="hidden")b[413]=2;if(change==="undefined")b.writeUInt16LE(0,414);if(change==="noncode")b.writeUInt16LE(2,414);if(change==="zero-size")b.writeBigUInt64LE(0n,424);if(change==="offset")b.writeBigUInt64LE(2n**63n,32);if(change==="dynamic")b.writeUInt32LE(1,120);if(change==="symbol-size")b.writeBigUInt64LE(8n,760);fs.writeFileSync(f.library,change==="truncated"?b.subarray(0,600):b);if(change==="writable")fs.chmodSync(f.library,0o666);if(change==="hardlink")fs.linkSync(f.library,f.library+"-alias");if(change==="symlink"){fs.renameSync(f.library,f.library+"-source");fs.symlinkSync(f.library+"-source",f.library);}assert.throws(()=>deadlineArtifact(f.library,"amd64"),e=>(e as {code:string}).code==="lease_deadline_artifact_invalid");
});
test("native adapter rejects saved, unknown, active and transient teardown",t=>{
  const f=fixture(t),c=new OwnedNativeConnection(f.driver);for(const key of ["saved","snapshots","checkpoints"] as const){f.driver[key]=-1;assert.throws(()=>c.validate(f.binding,false));f.driver[key]=0;}f.driver.state="running";assert.throws(()=>c.retire(f.binding));f.driver.state="shut off";f.driver.persistent=false;assert.throws(()=>c.retire(f.binding));f.driver.persistent=true;f.driver.unknownAbsence=true;assert.throws(()=>c.absent());f.driver.unknownAbsence=false;c.retire(f.binding);assert.equal(c.absent(),true);c.close();assert.throws(()=>c.startPaused());
});
test("unused boot stop retires preparation without claiming storage cleanup",t=>{
  const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder,true);const result=f.provider.confirmExecutionStopped(f.machine,f.folder);assert.equal(result?.evidence,"never-launched");assert.equal(result?.storageHandles,"unknown");assert.equal(result?.storageRemoved,false);assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"libvirt-execution.json"),"utf8")).phase,"fenced");assert.ok(fs.existsSync(f.disk));
});
for(const fail of ["unfenced","birth missing","native active","close unknown","lock held","changed boot"] as const)test(`stop unknown with ${fail}`,t=>{
  const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder,fail!=="unfenced");let lock:SupervisorJournal|undefined;if(fail==="birth missing")f.write("libvirt-launch",{...f.binding.identity(),pid:42});if(fail==="native active")f.driver.state="running";if(fail==="close unknown")f.driver.closeFails=true;if(fail==="lock held")lock=new SupervisorJournal(f.folder,undefined,{fixture:true});if(fail==="changed boot")f.boot=randomUUID();try{assert.equal(f.provider.confirmExecutionStopped(f.machine,f.folder),null);assert.ok(fs.existsSync(f.disk));}finally{lock?.close();}
});
test("PID reuse proves original exit only; replacement is never signalled",t=>{const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder,true);f.write("libvirt-launch",{...f.binding.identity(),pid:42,createdAt:10});f.adapters.processBirth=()=>({pid:42,createdAt:20,parentPid:99,uid:process.getuid!(),executable:"/foreign",argv:[],zombie:false});assert.equal(f.provider.confirmExecutionStopped(f.machine,f.folder)?.evidence,"supervisor-exited");});
test("unknown child spawn is recorded before call and never retried",async t=>{
  const f=fixture(t);f.adapters.childExecutable="/fixture/supervisor";f.adapters.childArguments=()=>["child"];f.adapters.processBirth=()=>"unknown";let launches=0;f.adapters.launch=()=>{launches++;assert.ok(fs.existsSync(join(f.folder,"libvirt-launch.json")));throw Error("Lost child ack");};await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"starting");assert.equal(launches,1);assert.ok(!f.commands.some(c=>c.includes("start")));
});
test("running requires exact supervisor birth, parent, owner, executable and command",async t=>{
  const f=fixture(t);f.adapters.childExecutable="/fixture/supervisor";f.adapters.childArguments=(folder,parent)=>["child",folder,String(parent)];let child:ProcessBirth={pid:4242,createdAt:80,parentPid:process.pid,uid:process.getuid!(),executable:"/fixture/supervisor",argv:f.adapters.childArguments(f.folder,process.pid),zombie:false};f.adapters.processBirth=()=>child;f.adapters.launch=()=>({pid:child.pid,createdAt:child.createdAt});assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"starting");f.write("libvirt-execution",{...f.binding.identity(),phase:"running"});f.driver.state="running";assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"running");child={...child,createdAt:81};assert.equal((await f.provider.refreshExecution(f.machine,f.image,f.folder))?.leaseFenced,true);assert.equal(f.commands.filter(c=>c.includes("start")).length,0);
});
test("namespace change fences old execution without querying another namespace",async t=>{const f=fixture(t);f.provider.config.uri="qemu:///session";const result=await f.provider.reconcile(f.machine,f.image,f.folder);assert.equal(result.leaseFenced,true);assert.equal(result.state,"unknown");assert.equal(f.commands.length,0);});
test("lease preparation refuses insufficient native bindings before provisioning",async t=>{const f=fixture(t);for(const name of ["libvirt-binding.json","libvirt-execution.json"])fs.unlinkSync(join(f.folder,name));fs.rmSync(f.storage,{recursive:true});await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/binding is insufficient/);assert.equal(f.commands.length,0);assert.equal(fs.existsSync(f.storage),false);});
test("dedicated child checks parent, pinned artifact and unused history",t=>{
  const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder);f.write("libvirt-launch",{...f.binding.identity(),parentPid:process.pid});let pinned=false;const options={fixture:true,parentPid:process.pid,parent:()=>process.pid,hostBoot:()=>f.boot,clock:()=>f.now,connect:()=>new OwnedNativeConnection(f.driver),ownership:()=>true,fence:(fd:number)=>{assert.equal(fs.fstatSync(fd).ino,fs.lstatSync(f.library).ino);pinned=true;return{arm(){}};}};const child=runSupervisorChild(f.folder,options);assert.equal(pinned,true);assert.equal(child.supervisor.phase,"running");child.close();assert.throws(()=>runSupervisorChild(f.folder,options));assert.throws(()=>runSupervisorChild(f.folder,{...options,parent:()=>1}));
});
test("storage guard holds every file, retains contents and latches break failure",t=>{
  const f=fixture(t);let broken=false,closed=0;const guard=new StorageHandleGuard(f.storage,inode(fs.lstatSync(f.storage)),()=>({verify(){if(broken)throw Error("break");},close(){closed++;}}));assert.equal(guard.snapshot().filter(e=>e.kind==="file").length,2);broken=true;assert.throws(()=>guard.verify());broken=false;assert.throws(()=>guard.verify());guard.close();assert.equal(closed,2);assert.ok(fs.existsSync(f.disk));
});
for(const hazard of ["symlink","hardlink","permissions","root inode","new entry","no binding"] as const)test(`storage refuses ${hazard}`,t=>{
  const f=fixture(t),expected=inode(fs.lstatSync(f.storage));if(hazard==="symlink")fs.symlinkSync(f.disk,join(f.storage,"alias"));if(hazard==="hardlink")fs.linkSync(f.disk,join(f.storage,"alias"));if(hazard==="permissions")fs.chmodSync(f.disk,0o666);if(hazard==="root inode")expected.inode++;const create=()=>new StorageHandleGuard(f.storage,expected,hazard==="no binding"?undefined:()=>({verify(){},close(){}}));if(hazard==="new entry"){const g=create();fs.writeFileSync(join(f.storage,"late"),"new",{mode:0o600});try{assert.throws(()=>g.verify());}finally{g.close();}}else assert.throws(create);
});
test("partial storage acquisition closes all prior leases",t=>{const f=fixture(t);let acquired=0,closed=0;assert.throws(()=>new StorageHandleGuard(f.storage,inode(fs.lstatSync(f.storage)),()=>{if(++acquired===2)throw Error("fd exhaustion");return{verify(){},close(){closed++;}};}));assert.equal(closed,1);assert.ok(fs.existsSync(f.disk));});
test("owned disk/NVRAM/TPM erasure preserves assignment credentials; completion is repeatable",async t=>{
  const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);fs.writeFileSync(join(f.storage,"nvram.fd"),"private firmware",{mode:0o600});fs.mkdirSync(join(f.storage,"tpm-state"),{mode:0o700});fs.writeFileSync(join(f.storage,"tpm-state/state"),"private tpm",{mode:0o600});const id=(f.machine.leaseCleanup as RecordValue).id as string,result=await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id);assert.equal(result.state,"complete");assert.equal(result.contentsErased,true);assert.equal(result.storageRemoved,true);assert.equal(result.credentialsErased,undefined);assert.ok(fs.existsSync(join(f.folder,"assignment.json")));assert.equal(fs.existsSync(f.storage),false);assert.deepEqual(await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id),result);assert.equal(f.driver.events.filter(e=>e==="retire").length,1);
});
test("lost retirement acknowledgement recovers without repeating undefine",async t=>{
  const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);f.driver.lostRetire=true;const id=(f.machine.leaseCleanup as RecordValue).id as string;await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id));assert.equal(f.driver.present,false);assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"deletion.json"),"utf8")).state,"quarantined");assert.equal((await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id)).state,"complete");assert.equal(f.driver.events.filter(e=>e==="retire").length,1);
});
test("partial unlink recovers only empty manifest-owned inodes",async t=>{
  const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);let first=true;f.adapters.protectedRemove=root=>{if(first){first=false;fs.unlinkSync(join(root,"disk.qcow2"));throw Error("partial unlink");}fs.rmSync(root,{recursive:true});};const id=(f.machine.leaseCleanup as RecordValue).id as string;await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id));assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"deletion.json"),"utf8")).state,"removing");assert.equal((await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id)).state,"complete");
});
test("new content cannot become erasure success after interrupted unlink",async t=>{
  const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);f.adapters.protectedRemove=()=>{throw Error("interrupted");};const id=(f.machine.leaseCleanup as RecordValue).id as string;await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id));const quarantine=join(dirname(f.storage),`.removing-${f.machine.id}-${id}`);fs.writeFileSync(join(quarantine,"disk.qcow2"),"new data");await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id),/reappeared|uncleared/);assert.ok(fs.existsSync(quarantine));
});
test("unknown storage handles prevent domain retirement",async t=>{const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);f.adapters.fileLease=()=>{throw Error("held by QEMU");};await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,(f.machine.leaseCleanup as RecordValue).id as string));assert.ok(!f.driver.events.includes("retire"));assert.equal(f.driver.present,true);});
test("missing erasure binding keeps original storage without quarantine",async t=>{const f=fixture(t);f.terminal();delete f.adapters.fileLease;await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,(f.machine.leaseCleanup as RecordValue).id as string));assert.ok(fs.existsSync(f.disk));assert.ok(!fs.existsSync(join(f.folder,"deletion.json")));
});
test("reboot zero-fences old monotonic authority without querying historical PID",async t=>{
  const f=fixture(t);f.terminal();f.write("libvirt-launch",{...f.binding.identity(),pid:123,createdAt:20});f.adapters.processBirth=()=>{throw Error("historical PID must not be queried");};f.boot=randomUUID();assert.equal((await f.provider.stopForCleanup(f.machine,f.image,f.folder)).state,"stopped");const a=JSON.parse(fs.readFileSync(join(f.folder,"libvirt-authorization.json"),"utf8"));assert.equal(a.deadline,0);assert.equal(a.fenced,true);assert.equal(f.provider.confirmExecutionStopped(f.machine,f.folder)?.evidence,"host-reboot");f.boot=f.originalBoot;assert.equal(f.provider.confirmExecutionStopped(f.machine,f.folder),null);
});
test("fresh reboot fencing and native inactive observation permit cleanup",async t=>{const f=fixture(t);f.terminal();f.boot=randomUUID();assert.equal(f.provider.confirmExecutionStopped(f.machine,f.folder),null);await f.provider.stopForCleanup(f.machine,f.image,f.folder);assert.equal((await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,(f.machine.leaseCleanup as RecordValue).id as string)).state,"complete");});
test("reboot after lost retirement acknowledgement refreshes absence without replay",async t=>{const f=fixture(t);f.terminal();f.provider.publish(f.machine,f.image,f.folder,true);f.driver.lostRetire=true;const id=(f.machine.leaseCleanup as RecordValue).id as string;await assert.rejects(f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id));f.boot=randomUUID();assert.equal((await f.provider.removeOwnedStorage(f.machine,f.image,f.folder,id)).state,"complete");assert.equal(f.driver.events.filter(e=>e==="retire").length,1);});
test("QMP supports correlation IDs and shared thread groups, rejects invalid CPU records",()=>{
  assert.deepEqual(parseQMPThreads('{"return":[{"thread-id":42,"cpu-index":0},{"thread-id":42,"cpu-index":1}],"id":"fixed"}'),[42]);for(const v of [{error:{}},{return:[]},{return:[{"thread-id":true,"cpu-index":0}]},{return:[{"thread-id":42,"cpu-index":0},{"thread-id":43,"cpu-index":0}]}])assert.throws(()=>parseQMPThreads(JSON.stringify(v)));
});
test("usage anchors QEMU UUID and rechecks process birth and full cgroup membership",t=>{
  const f=fixture(t);f.driver.state="running";f.driver.xml=f.driver.xml.replace("<devices>",'<devices><emulator>/fixture/qemu</emulator>');let members=new Set([42,43]);f.adapters.kernel={tgid:()=>42,domain:()=>({path:"/machine/qemu",identity:{device:1,inode:2}}),members:()=>new Set(members),contains:pid=>members.has(pid)};let birth=80;f.adapters.process=pid=>({pid,createdAt:pid===42?birth:81,executable:pid===42?"/fixture/qemu":"/fixture/helper",argv:pid===42?["qemu","-uuid",f.machine.id as string]:["helper"]});const result=f.provider.resourceProcesses(f.machine,f.image,f.folder);assert.equal(result.length,2);result[0]!.verifyResourceIdentity();members.add(44);assert.throws(()=>result[1]!.verifyResourceIdentity());members=new Set([42,43]);birth=99;assert.throws(()=>result[0]!.verifyResourceIdentity());
});
test("inactive zero usage excludes domains with unobserved TPM helper",t=>{const f=fixture(t);assert.deepEqual(f.provider.resourceProcesses(f.machine,f.image,f.folder),[]);f.driver.xml=bindDomainXML(domainXML(f.machine,{...f.image,tpm:true},f.disk),f.binding);assert.throws(()=>f.provider.resourceProcesses(f.machine,f.image,f.folder));});
test("physical runtime selection and native inference enforce platform restrictions",async()=>{
  const config={provider:"linux",runtimes:["libvirt","android"]};assert.deepEqual(Object.keys(enabledRuntimes(config)),["libvirt","android"]);assert.equal(runtimeFor(config,{os:"windows"}),"libvirt");assert.equal(runtimeFor(config,{os:"android"}),"android");assert.throws(()=>enabledRuntimes({...config,runtimes:["libvirt","libvirt"]}));assert.throws(()=>runtimeFor(config,{os:"macos"}));assert.throws(()=>enabledRuntimes({...config,runtimes:["apple"]}));await assert.rejects(new NativeProvider({},"/private/state").reconcile({}, {}, "/private/state"));
});
test("a leased binding cannot be converted into unfenced administrative execution",async t=>{
  const f=fixture(t);delete f.machine.lease;await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/another assignment/);assert.equal(f.commands.length,0);
});
for(const lost of [false,true])test(`fresh preparation persists binding before definition; lost acknowledgement=${lost}`,async t=>{
  const f=fixture(t);for(const n of ["libvirt-binding.json","libvirt-execution.json"])fs.unlinkSync(join(f.folder,n));fs.rmSync(f.storage,{recursive:true});let creates=0,defines=0,launches=0;let definition="";
  f.adapters.childExecutable="/fixture/child";f.adapters.childArguments=()=>["child"];
  const child:ProcessBirth={pid:12345,createdAt:80,parentPid:process.pid,uid:process.getuid!(),executable:"/fixture/child",argv:["child"],zombie:false};f.adapters.processBirth=()=>child;f.adapters.launch=()=>{launches++;return{pid:child.pid,createdAt:child.createdAt};};
  f.adapters.run=async(argv,options)=>{
    if(argv[0]==="qemu-img"&&argv[1]==="info")return JSON.stringify({"virtual-size":1024,format:"raw"});
    if(argv[0]==="qemu-img"&&argv[1]==="create"){creates++;return"";}
    if(argv[3]==="define"){defines++;assert.equal(argv[4],"/dev/stdin");definition=options.input!;assert.ok(definition.includes("<metadata>"));assert.ok(fs.existsSync(join(f.folder,"libvirt-binding.json")));assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"libvirt-execution.json"),"utf8")).phase,"prepared");if(lost)throw Error("lost define ack");return"";}
    if(argv[3]==="dumpxml")return definition;if(argv[3]==="domuuid")return f.machine.id as string;if(argv[3]==="domstate")return"shut off";return"";
  };
  if(lost)await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),e=>(e as {outcome:string}).outcome==="unknown");
  assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"starting");assert.equal(creates,1);assert.equal(defines,1);assert.equal(launches,1);
});
test("administrative shutdown rechecks full metadata and uncertain calls do not replay",async t=>{
  const f=fixture(t);delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});
  const b=new LibvirtLeaseBinding({...f.binding,lease_id:f.machine.id as string});f.write("libvirt-binding",{...f.spec,binding:{...b}});f.write("libvirt-execution",{...b.identity(),phase:"prepared"});f.driver.xml=bindDomainXML(domainXML(f.machine,f.image,f.disk),b);f.driver.state="running";f.machine.desired="stopped";
  let shutdowns=0;const run=f.adapters.run!;f.adapters.run=async(argv,options)=>{if(argv[3]==="shutdown"){shutdowns++;throw Error("lost shutdown acknowledgement");}return run(argv,options);};await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/not replayed/);assert.equal(shutdowns,1);
});
test("administrative foreign metadata prevents shutdown even with matching name and UUID",async t=>{
  const f=fixture(t);delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});const b=new LibvirtLeaseBinding({...f.binding,lease_id:f.machine.id as string});f.write("libvirt-binding",{...f.spec,binding:{...b}});f.write("libvirt-execution",{...b.identity(),phase:"prepared"});f.driver.xml=bindDomainXML(domainXML(f.machine,f.image,f.disk),b).replace(b.boot_id,randomUUID());f.driver.state="running";f.machine.desired="stopped";await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));assert.ok(!f.commands.some(c=>c.includes("shutdown")));
});
test("check redacts native artifact paths and never enables consumer admission",async t=>{
  const f=fixture(t),result=await f.provider.check() as RecordValue;assert.equal(result.libvirtLeaseArtifact,true);assert.equal(result.leaseEligible,false);assert.equal(result.nativeAcceptance,false);assert.ok(!JSON.stringify(result).includes(f.library));fs.chmodSync(f.library,0o666);f.commands.length=0;await assert.rejects(f.provider.check());assert.equal(f.commands.length,0);
});
test("deadlines expire during slow same-revision publication",t=>{
  const f=fixture(t);let old:RecordValue|null={...f.binding.identity(),revision:1,deadline:101,fenced:false};const result=publishAuthorization(f.binding,{read:()=>old,write:v=>{old=v;}},()=>{f.now=102;return f.auth;},()=>true,()=>f.boot,()=>f.now);assert.equal(result.fenced,true);assert.equal(result.deadline,101);
});
for(const threaded of [false,true])test(`cgroup-v2 attribution excludes siblings and handles threaded=${threaded}`,t=>{
  const root=temporary(t),proc=join(root,"proc"),group=join(root,"cgroup"),name=`cvm-${randomUUID()}`,scope=`machine-qemu-7-${name.slice(0,16)}.scope`,domain=`/machine.slice/${scope}`,where=join(group,domain),helper=join(where,"helpers"),sibling=join(group,"machine.slice/machine-qemu-8-foreign.scope");
  fs.mkdirSync(join(proc,"self"),{recursive:true});fs.mkdirSync(helper,{recursive:true});fs.mkdirSync(sibling,{recursive:true});
  fs.writeFileSync(join(proc,"self/mountinfo"),`1 0 0:1 / ${group} rw - cgroup2 cgroup rw\n`);
  for(const pid of [42,43]){fs.mkdirSync(join(proc,String(pid)));fs.writeFileSync(join(proc,String(pid),"status"),"Name: qemu\nTgid:\t42\n");fs.writeFileSync(join(proc,String(pid),"cgroup"),`0::${domain}${pid===43?"/helpers":""}\n`);}
  fs.writeFileSync(join(where,"cgroup.type"),threaded?"domain threaded\n":"domain\n");fs.writeFileSync(join(where,"cgroup.procs"),threaded?"42\n43\n":"42\n");fs.writeFileSync(join(helper,"cgroup.type"),threaded?"threaded\n":"domain\n");fs.writeFileSync(join(helper,"cgroup.procs"),threaded?"unreadable-threaded-list":"43\n");fs.writeFileSync(join(sibling,"cgroup.type"),"domain\n");fs.writeFileSync(join(sibling,"cgroup.procs"),"44\n");
  const kernel=new LinuxDomainCgroup(proc,group);assert.equal(kernel.tgid(43),42);const owned=kernel.domain(42,7,name);assert.equal(owned.path,domain);assert.deepEqual([...kernel.members(owned)].sort(),[42,43]);assert.equal(kernel.contains(43,owned),true);fs.writeFileSync(join(proc,"43/cgroup"),"0::/machine.slice/foreign.scope\n");assert.equal(kernel.contains(43,owned),false);
  fs.symlinkSync(sibling,join(where,"unexpected"));assert.throws(()=>kernel.members(owned));
});
test("partial cgroup mounts cannot establish native process attribution",t=>{
  const root=temporary(t),proc=join(root,"proc"),group=join(root,"cgroup");fs.mkdirSync(join(proc,"self"),{recursive:true});fs.mkdirSync(group);fs.writeFileSync(join(proc,"self/mountinfo"),`1 0 0:1 /partial ${group} rw - cgroup2 cgroup rw\n`);assert.throws(()=>new LinuxDomainCgroup(proc,group).domain(42,7,"cvm-fixture"));
});
