import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { LibvirtProvider, OwnedNativeConnection, domainXML, publishAuthorization, parseQMPThreads, enabledRuntimes, runtimeFor, NativeProvider, LinuxDomainCgroup, vmStorageAccess, withDACLabel } from "../../src/providers/libvirt.ts";
import type { ExecutionSpec, LibvirtAdapters, NativeDriver, NativeSnapshot } from "../../src/providers/libvirt.ts";
import { LibvirtLeaseBinding, SupervisorJournal, bindDomainXML, validateDomainXML, canonical, fingerprint, inode, hash } from "../../src/providers/libvirt-ownership.ts";
import type { RecordValue } from "../../src/providers/libvirt-ownership.ts";
function save(path:string,value:unknown):void{fs.writeFileSync(path,canonical(value),{mode:0o600});}
// The test account's primary group stands in for the dedicated QEMU storage group.
const vmGid=process.getgid!();
function shareVM(path:string,mode:number):void{fs.chownSync(path,process.getuid!(),vmGid);fs.chmodSync(path,mode);}
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
  const folder=join(root,"assignment"),storageRoot=join(root,"disks"),storage=join(storageRoot,machine.id as string);fs.mkdirSync(folder,{mode:0o700});fs.mkdirSync(storageRoot,{mode:0o700});shareVM(storageRoot,0o2750);fs.mkdirSync(storage,{mode:0o700});
  // Templates live in the shared VM storage root, readable by the QEMU group only.
  const image:RecordValue={os:"linux",arch:"amd64",mode:"headless",image:join(storageRoot,"base.raw")};fs.writeFileSync(image.image as string,"base",{mode:0o600});shareVM(image.image as string,0o640);
  const disk=join(storage,"disk.qcow2");fs.writeFileSync(disk,"private disk",{mode:0o600});save(join(folder,"assignment.json"),{fingerprint:fingerprint(machine),leaseId:(machine.lease as RecordValue).id});save(join(storage,"canaveral-owner.json"),{fingerprint:fingerprint(machine)});
  let now=100,boot:string=randomUUID();const originalBoot=boot;
  const binding=new LibvirtLeaseBinding({machine_id:machine.id as string,lease_id:(machine.lease as RecordValue).id as string,boot_id:randomUUID(),host_boot_id:boot,fingerprint:fingerprint(machine),disk});
  const library=join(root,"deadline.so");fs.writeFileSync(library,syntheticELF(),{mode:0o600});
  const spec:ExecutionSpec={version:1,binding:{...binding},uri:"qemu:///system",library:{path:library,sha256:hash(fs.readFileSync(library))},storageIdentity:inode(fs.lstatSync(storage)),diskIdentity:inode(fs.lstatSync(disk))};
  save(join(folder,"libvirt-binding.json"),spec);save(join(folder,"libvirt-execution.json"),{...binding.identity(),phase:"prepared"});
  const driver=new Driver(bindDomainXML(domainXML(machine,image,disk),binding),machine.id as string),commands:string[][]=[];
  let auth:RecordValue={leaseID:(machine.lease as RecordValue).id,revision:1,remainingSeconds:30,fenced:false};image._leaseAuthorization=()=>({...auth});
  const adapters:LibvirtAdapters={fixture:true,platform:"linux",arch:"amd64",clock:()=>now,hostBoot:()=>boot,connect:()=>new OwnedNativeConnection(driver),run:async(argv)=>{commands.push([...argv]);const args=argv.slice(3);if(args[0]==="dumpxml")return driver.xml;if(args[0]==="domuuid")return machine.id as string;if(args[0]==="domstate")return driver.state;return"";}};
  const provider=new LibvirtProvider({storage:storageRoot,templates:[],leaseDeadlineLibrary:library,vmGroupId:vmGid,adapters},root);
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
test("publication subtracts sampling delay, never extends same revision and latches expiry",t=>{
  const f=fixture(t);assert.equal(f.provider.publish(f.machine,f.image,f.folder).deadline,129.75);f.now=110;f.auth={...f.auth,remainingSeconds:100};assert.equal(f.provider.publish(f.machine,f.image,f.folder).deadline,129.75);f.now=130;f.auth={...f.auth,revision:2};assert.equal(f.provider.publish(f.machine,f.image,f.folder).fenced,true);assert.throws(()=>publishAuthorization(f.binding,{read:()=>null,write:()=>{throw Error("must not publish");}},()=>{f.now=99;return f.auth;},()=>true,()=>f.boot,()=>f.now));
});
test("publication refuses replacement disks and preserves previous deadline",t=>{const f=fixture(t);f.provider.publish(f.machine,f.image,f.folder);fs.renameSync(f.disk,f.disk+"-original");fs.writeFileSync(f.disk,"foreign",{mode:0o600});assert.throws(()=>f.provider.publish(f.machine,f.image,f.folder));assert.equal(JSON.parse(fs.readFileSync(join(f.folder,"libvirt-authorization.json"),"utf8")).deadline,129.75);});
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
test("administrative shutdown rechecks full metadata and uncertain calls do not replay",async t=>{
  const f=fixture(t);delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});
  const b=new LibvirtLeaseBinding({...f.binding,lease_id:f.machine.id as string});f.write("libvirt-binding",{...f.spec,binding:{...b}});f.write("libvirt-execution",{...b.identity(),phase:"prepared"});f.driver.xml=bindDomainXML(domainXML(f.machine,f.image,f.disk),b);f.driver.state="running";f.machine.desired="stopped";
  let shutdowns=0;const run=f.adapters.run!;f.adapters.run=async(argv,options)=>{if(argv[3]==="shutdown"){shutdowns++;throw Error("lost shutdown acknowledgement");}return run(argv,options);};await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/not replayed/);assert.equal(shutdowns,1);
});
test("administrative foreign metadata prevents shutdown even with matching name and UUID",async t=>{
  const f=fixture(t);delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});const b=new LibvirtLeaseBinding({...f.binding,lease_id:f.machine.id as string});f.write("libvirt-binding",{...f.spec,binding:{...b}});f.write("libvirt-execution",{...b.identity(),phase:"prepared"});f.driver.xml=bindDomainXML(domainXML(f.machine,f.image,f.disk),b).replace(b.boot_id,randomUUID());f.driver.state="running";f.machine.desired="stopped";await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));assert.ok(!f.commands.some(c=>c.includes("shutdown")));
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

test("mounted libvirt uses only the selected local system socket", async t => {
  const f = fixture(t);
  const options = { ...f.provider.config, deployment: "kubernetes" };
  const defaults = new LibvirtProvider(options, f.root);
  await defaults.check();
  const defaultUri = "qemu+unix:///system?socket=/var/run/libvirt/libvirt-sock";
  assert.deepEqual(f.commands[0], ["virsh", "--connect", defaultUri, "domcapabilities", "--virttype", "kvm"]);

  const path = "/run/canaveral/libvirt-sock", uri = "qemu+unix:///system?socket=" + path;
  const custom = new LibvirtProvider({ ...options, socketPath: path }, f.root);
  await custom.check();
  assert.equal(f.commands[2]?.[2], uri);
  f.commands.length = 0;
  for (const invalid of [
    { socketPath: "relative/socket" }, { socketPath: "/run/../socket" }, { socketPath: "/run/sock?mode=direct" },
    { socketPath: "/run/sock%3F" }, { socketPath: "/".padEnd(108, "s") }, { socketPath: null },
    { uri: "qemu+tcp://example.test/system" }, { uri: "qemu:///session" },
  ]) await assert.rejects(new LibvirtProvider({ ...options, ...invalid }, f.root).check());
  assert.deepEqual(f.commands, []);
});

test("Kubernetes administrative drain verifies the owned VM is stopped through the mounted socket", async t => {
  const f = fixture(t);
  delete f.machine.lease;
  f.machine.desired = "stopped";
  const binding = new LibvirtLeaseBinding({ ...f.binding, lease_id: f.binding.machine_id });
  const socketPath = "/run/canaveral/libvirt-sock", uri = "qemu+unix:///system?socket=" + socketPath;
  save(join(f.folder, "assignment.json"), { fingerprint: binding.fingerprint });
  save(join(f.folder, "libvirt-binding.json"), { ...f.spec, binding: { ...binding }, uri });
  f.driver.xml = bindDomainXML(domainXML(f.machine, f.image, f.disk), binding);
  const provider = new LibvirtProvider({ ...f.provider.config, deployment: "kubernetes", socketPath }, f.root);
  f.driver.state = "running";
  assert.equal(await provider.updateStopped(f.machine, f.image, f.folder), false);
  f.driver.state = "shut off";
  assert.equal(await provider.updateStopped(f.machine, f.image, f.folder, true), true);
  assert.ok(f.commands.every(command => command[2] === uri));
  const other = new LibvirtProvider({ ...provider.config, socketPath: "/run/other/libvirt-sock" }, f.root);
  const commands = f.commands.length;
  assert.equal(await other.updateStopped(f.machine, f.image, f.folder, true), false);
  assert.equal(f.commands.length, commands);
  assert.ok(fs.existsSync(f.disk));
});

test("administrative definition retries only the identical owned XML after definite absence",async t=>{
  const f=fixture(t);
  delete f.machine.lease;
  save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});
  for(const name of ["libvirt-binding.json","libvirt-execution.json"]) fs.unlinkSync(join(f.folder,name));
  fs.rmSync(f.storage,{recursive:true});
  let creates=0,starts=0,defines=0;
  let definition="",seen="",defined=false;
  const files:string[]=[];
  f.adapters.run=async(argv,options)=>{
    const action=argv[3];
    if(argv[0]==="qemu-img"){
      if(argv[1]==="info")return JSON.stringify({"virtual-size":1024,format:"raw"});
      creates++;return "";
    }
    if(action==="list")return defined?(argv.includes("--uuid")?String(f.machine.id):"cvm-"+f.machine.id):"";
    if(action==="define"){
      assert.equal(options.input,undefined);
      const path=argv[4]!;files.push(path);
      assert.equal(fs.statSync(path).mode&0o777,0o600);
      definition=fs.readFileSync(path,"utf8");
      if(++defines===1){seen=definition;throw Error("ENXIO fixture");}
      assert.equal(definition,seen);defined=true;return "";
    }
    if(action==="dumpxml")return definition;
    if(action==="domuuid")return String(f.machine.id);
    if(action==="domstate")return "shut off";
    if(action==="start"){starts++;return "";}
    throw Error("Unexpected operation");
  };
  await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder));
  assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"starting");
  assert.deepEqual([creates,defines,starts],[1,2,1]);
  assert.ok(files.every(file=>!fs.existsSync(file)));
});
test("administrative preparation shares VM storage only with the QEMU group and labels the domain",async t=>{
  const f=fixture(t);delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});
  for(const name of ["libvirt-binding.json","libvirt-execution.json"])fs.unlinkSync(join(f.folder,name));fs.rmSync(f.storage,{recursive:true});
  let definition="";
  f.adapters.run=async argv=>{
    if(argv[0]==="qemu-img")return argv[1]==="info"?JSON.stringify({"virtual-size":1024,format:"raw"}):"";
    const action=argv[3];
    if(action==="list")return definition?(argv.includes("--uuid")?String(f.machine.id):"cvm-"+f.machine.id):"";
    if(action==="define"){definition=fs.readFileSync(argv[4]!,"utf8");return "";}
    if(action==="dumpxml")return definition;if(action==="domuuid")return String(f.machine.id);if(action==="domstate")return "shut off";if(action==="start")return "";
    throw Error("Unexpected operation");
  };
  assert.equal((await f.provider.reconcile(f.machine,f.image,f.folder)).state,"starting");
  const owner=(p:string)=>{const s=fs.lstatSync(p);return[s.uid,s.gid,s.mode&0o7777];};
  assert.deepEqual(owner(f.storage),[process.getuid!(),vmGid,0o2750]);
  assert.deepEqual(owner(f.disk),[process.getuid!(),vmGid,0o660]);
  assert.equal(fs.lstatSync(join(f.storage,"canaveral-owner.json")).mode&0o777,0o600);
  assert.equal(fs.lstatSync(f.folder).mode&0o777,0o700);
  assert.match(definition,/<seclabel type="static" model="dac" relabel="no"><label>libvirt-qemu:canaveral-vm<\/label><\/seclabel>/);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.folder,"libvirt-binding.json"),"utf8")).storageAccess,{gid:vmGid,label:"libvirt-qemu:canaveral-vm"});
  assert.equal(await f.provider.maintenanceStorage(f.machine),"present");
  // A live definition without the static label, or one that relabels storage, is not adopted.
  const labelled=definition;
  for(const changed of [labelled.replace(/<seclabel[^]*?<\/seclabel>/,""),labelled.replace('relabel="no"','relabel="yes"')]){definition=changed;await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/QEMU account label/);}
  definition=labelled;fs.chmodSync(f.disk,0o666);await assert.rejects(f.provider.maintenanceStorage(f.machine),/QEMU group/);await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/QEMU group/);
});
test("VM storage root and templates accept exactly the shared owner, group and mode",async t=>{
  const f=fixture(t),provider=new LibvirtProvider({...f.provider.config,templates:[f.image]},f.root),root=dirname(f.storage),base=f.image.image as string;
  await provider.check();
  for(const[path,mode,restore]of [[root,0o750,0o2750],[root,0o2770,0o2750],[root,0o2755,0o2750],[base,0o644,0o640],[base,0o660,0o640],[base,0o600,0o640]] as const){
    fs.chmodSync(path,mode);await assert.rejects(provider.check(),e=>(e as {code?:string}).code==="libvirt_vm_storage_access");fs.chmodSync(path,restore);
  }
  const foreign=new LibvirtProvider({...f.provider.config,templates:[f.image],vmGroupId:vmGid+1},f.root);await assert.rejects(foreign.check(),e=>(e as {code?:string}).code==="libvirt_vm_storage_access");
  // Preparation refuses before provisioning when the storage root lost its shared group mode.
  delete f.machine.lease;save(join(f.folder,"assignment.json"),{fingerprint:fingerprint(f.machine)});for(const name of ["libvirt-binding.json","libvirt-execution.json"])fs.unlinkSync(join(f.folder,name));fs.rmSync(f.storage,{recursive:true});
  fs.chmodSync(root,0o700);f.commands.length=0;await assert.rejects(f.provider.reconcile(f.machine,f.image,f.folder),/QEMU group/);assert.ok(!f.commands.some(c=>c[0]==="qemu-img"));assert.equal(fs.existsSync(f.storage),false);
});
test("QEMU account and storage group configuration is exact",()=>{
  assert.deepEqual(vmStorageAccess({}),{gid:10002,label:"libvirt-qemu:canaveral-vm"});
  assert.deepEqual(vmStorageAccess({vmGroupId:20000,vmGroup:"+20000",qemuUser:"qemu"}),{gid:20000,label:"qemu:+20000"});
  for(const config of [{vmGroupId:0},{vmGroupId:1.5},{vmGroupId:"10002"},{vmGroup:"+10003"},{vmGroup:"x<y"},{qemuUser:"root"},{qemuUser:"+0"},{qemuUser:`+${process.getuid!()}`},{qemuUser:userInfo().username},{qemuUser:"a:b"}])assert.throws(()=>vmStorageAccess(config),JSON.stringify(config));
});
test("DAC label validation accepts live labels and refuses relabelling or a second DAC label",t=>{
  const f=fixture(t),label="libvirt-qemu:canaveral-vm",xml=bindDomainXML(withDACLabel(domainXML(f.machine,f.image,f.disk),label),f.binding);
  validateDomainXML(xml,f.binding,label);
  validateDomainXML(xml.replace(`${label}</label></seclabel>`,`${label}</label><imagelabel>${label}</imagelabel></seclabel><seclabel type="dynamic" model="apparmor" relabel="yes"><label>libvirt-a</label><imagelabel>libvirt-a</imagelabel></seclabel>`),f.binding,label);
  for(const changed of [xml.replace(`>${label}<`,">root:root<"),xml.replace('type="static"','type="dynamic"'),xml.replace('relabel="no"','relabel="yes"'),xml.replace("</seclabel>",`</seclabel><seclabel type="static" model="dac" relabel="no"><label>${label}</label></seclabel>`),xml.replace(`${label}</label>`,`${label}</label><baselabel>x</baselabel>`),bindDomainXML(domainXML(f.machine,f.image,f.disk),f.binding)])assert.throws(()=>validateDomainXML(changed,f.binding,label));
});
