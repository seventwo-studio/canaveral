import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ServiceError, object } from "../errors.ts";
import { LibvirtLeaseBinding, SupervisorJournal, StorageHandleGuard, absolute, bindDomainXML, canonical, deadlineArtifact, digest, domainEmulator, domainHasTPM, escapeXML, exact, fingerprint, finite, hash, inode, matches, noSymlinks, owned, readPrivate, refuse, regular, sameInode, snapshotFile, uuid, validateDomainXML } from "./libvirt-ownership.ts";
import type { BindingData, FileLeaseFactory, Inode, ManifestEntry, RecordValue } from "./libvirt-ownership.ts";

export interface Invocation { input?:string; timeoutMs:number; maxOutputBytes:number }
export type ProcessRunner=(argv:readonly string[],options:Invocation)=>Promise<string>;
export const runProcess:ProcessRunner=(argv,options)=>new Promise((resolve,reject)=>{
    const child=execFile(argv[0]!,argv.slice(1),{timeout:options.timeoutMs,killSignal:"SIGKILL",maxBuffer:options.maxOutputBytes,encoding:"utf8",env:{...process.env,LC_ALL:"C",LANG:"C"}},(error,out)=>{
    if(error)reject(new ServiceError("Backend command failed or timed out; its outcome is unconfirmed.",409,{outcome:"unknown"}));else resolve(out.trim());
  });
  if(options.input!==undefined)child.stdin?.end(options.input);else child.stdin?.end();
});
export interface NativeSnapshot {uuid:string;xml:string;active:boolean;state:"shut off"|"paused"|"running";persistent:boolean;managedSave:number;snapshots:number;checkpoints:number;id?:number;threads?:number[]}
/** Implementations must free temporary domain handles before returning and before close.
 * A connection is dedicated to one domain and cannot be replaced after an uncertain create.
 */
export interface NativeDriver {
  snapshot():NativeSnapshot;
  create(flags:number):void;
  resume():void;
  lookup():"present"|"VIR_ERR_NO_DOMAIN";
  undefine(flags:number):void;
  close():void;
}
export class OwnedNativeConnection {
  private attempted=false;private resumed=false;private closed=false;private binding:LibvirtLeaseBinding|undefined;
  constructor(readonly driver:NativeDriver){}
  private invoke<T>(call:()=>T):T{try{return call();}catch{throw new ServiceError("Native libvirt reply is unconfirmed.",409,{outcome:"unknown"});}}
  snapshot():NativeSnapshot{if(this.closed)refuse("Native connection ended.");return this.invoke(()=>this.driver.snapshot());}
  validate(binding:LibvirtLeaseBinding,active:boolean,paused=false):void{
    const s=this.snapshot();if(s.uuid!==binding.machine_id)refuse("Native UUID differs.");validateDomainXML(s.xml,binding);
    if(s.active!==active||s.state!==(active?(paused?"paused":"running"):"shut off"))refuse("Native runtime state differs.");
    if(!active&&(s.managedSave!==0||s.snapshots!==0||s.checkpoints!==0))refuse("Saved execution, snapshots or checkpoints remain unknown.");
    this.binding=binding;
  }
  startPaused():void{if(this.attempted||this.closed||!this.binding)refuse("Native create cannot be replayed or adopt an unvalidated domain.");this.validate(this.binding,false);this.attempted=true;this.invoke(()=>this.driver.create(1|2));}
  resume():void{if(!this.attempted||this.resumed||this.closed||!this.binding)refuse("Native resume cannot be replayed.");this.validate(this.binding,true,true);this.resumed=true;this.invoke(()=>this.driver.resume());}
  absent():boolean{if(this.closed)refuse("Native connection ended.");const v=this.invoke(()=>this.driver.lookup());if(v!=="present"&&v!=="VIR_ERR_NO_DOMAIN")refuse("Native domain absence is unconfirmed.");return v==="VIR_ERR_NO_DOMAIN";}
  retire(binding:LibvirtLeaseBinding):void{this.validate(binding,false);if(this.snapshot().persistent!==true)refuse("Only an owned persistent domain can be retired.");this.validate(binding,false);this.invoke(()=>this.driver.undefine(8|64));if(!this.absent())refuse("Native domain remains after retirement.");}
  close():void{if(this.closed)return;this.closed=true;this.invoke(()=>this.driver.close());}
}
export interface Journal {read():RecordValue|null;write(value:RecordValue):void}
export interface DeadlineFence {arm(deadline:number):void}
export class LibvirtLeaseSupervisor {
  connection:OwnedNativeConnection|undefined;phase="new";revision=0;deadline:number|undefined;private lastClock:number|undefined;private admitted=false;
  constructor(readonly binding:LibvirtLeaseBinding,readonly journal:Journal,public authorization:()=>unknown,public ownership:()=>boolean,readonly hostBoot:()=>string,readonly connect:()=>OwnedNativeConnection,readonly fence:DeadlineFence,readonly clock:()=>number){}
  private write(phase:string,reason?:string):void{if(!matches(this.journal.read(),this.binding.identity()))refuse("Supervisor journal ownership changed.");this.journal.write({...this.binding.identity(),phase,revision:this.revision,deadline:this.deadline??null,...(reason?{reason}:{})});this.phase=phase;}
  private authorize():void{
    const now=this.clock();if(!finite(now)||(this.lastClock!==undefined&&now<this.lastClock)||(this.deadline!==undefined&&now>=this.deadline))refuse("Execution deadline ended or clock changed.");this.lastClock=now;
    if(this.hostBoot()!==this.binding.host_boot_id||this.ownership()!==true)refuse("Execution ownership changed.");
    const value=object(this.authorization());if(!validAuthority(value,this.binding)||value.fenced===true||(value.revision as number)<this.revision)refuse("Execution authorization is invalid or fenced.");
    let deadline=value.deadline as number;if(value.revision===this.revision&&this.deadline!==undefined)deadline=Math.min(deadline,this.deadline);
    const after=this.clock();if(!finite(after)||after<now||after>=deadline||(this.deadline!==undefined&&after>=this.deadline))refuse("Authorization expired during validation.");
    this.lastClock=after;this.revision=value.revision as number;this.deadline=deadline;this.fence.arm(deadline);
  }
  start():void{
    if(this.phase!=="new")refuse("Supervisor launch cannot restart.");
    if(canonical(this.journal.read())!==canonical({...this.binding.identity(),phase:"prepared"})){this.phase="fenced";refuse("Supervisor requires an unused preparation receipt.");}
    this.admitted=true;
    try{this.authorize();this.write("starting");this.connection=this.connect();this.connection.validate(this.binding,false);this.authorize();this.write("creating");this.connection.startPaused();this.authorize();this.connection.validate(this.binding,true,true);this.authorize();this.write("resuming");this.connection.resume();this.authorize();this.write("running");}
    catch{this.close("startup-unconfirmed");throw new ServiceError("Leased startup was not confirmed and will not be replayed.",409,{outcome:"unknown"});}
  }
  step():boolean{if(this.phase!=="running")return false;try{this.authorize();this.connection!.validate(this.binding,true);this.authorize();this.write("running");return true;}catch{this.close("authorization-or-runtime-ended");return false;}}
  close(reason="supervisor-ended"):void{
    if(this.phase==="fenced")return;if(!this.admitted){this.phase="fenced";return;}
    if(this.deadline!==undefined)try{const now=this.clock();if(finite(now))this.fence.arm(Math.min(this.deadline,now+.1));}catch{/* The previous fatal deadline remains armed. */}
    try{this.write("fenced",reason);}catch{this.phase="fenced";}finally{const connection=this.connection;this.connection=undefined;try{connection?.close();}catch{/* Closing uncertainty is not cleanup evidence. */}}
  }
}
export function validAuthorization(value:unknown,leaseId:string):value is RecordValue{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;const v=value as RecordValue;
  return exact(v,["leaseID","revision","remainingSeconds","fenced"])&&v.leaseID===leaseId&&Number.isSafeInteger(v.revision)&&(v.revision as number)>=1&&finite(v.remainingSeconds)&&typeof v.fenced==="boolean";
}
function validAuthority(v:RecordValue,b:LibvirtLeaseBinding):boolean{return matches(v,b.identity())&&exact(v,[...Object.keys(b.identity()),"revision","deadline","fenced"])&&Number.isSafeInteger(v.revision)&&(v.revision as number)>=1&&finite(v.deadline)&&typeof v.fenced==="boolean";}
export function linuxBootId():string{if(process.platform!=="linux")refuse("Libvirt execution requires Linux.");const fd=fs.openSync("/proc/sys/kernel/random/boot_id",fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const data=Buffer.alloc(128);const size=fs.readSync(fd,data,0,128,null);return uuid(data.subarray(0,size).toString("ascii").trim());}finally{fs.closeSync(fd);}}
export function publishAuthorization(binding:LibvirtLeaseBinding,journal:Journal,authorization:()=>unknown,ownership:()=>boolean,hostBoot:()=>string,clock:()=>number,stopping=false):RecordValue{
  const before=clock();if(!finite(before)||hostBoot()!==binding.host_boot_id)refuse("Native clock or host boot changed.");const v=authorization();const after=clock();if(!validAuthorization(v,binding.lease_id)||!finite(after)||after<before||hostBoot()!==binding.host_boot_id)refuse("Invalid local deadline authorization.");
  const deadline=Math.max(0,before+(v.remainingSeconds as number)-.25);if(!finite(deadline))refuse("Deadline exceeds its clock envelope.");
  const result={...binding.identity(),revision:v.revision,deadline,fenced:stopping||v.fenced===true||deadline<=after};const previous=journal.read();
  if(previous){if(!validAuthority(previous,binding)||(result.revision as number)<(previous.revision as number))refuse("Native authorization history is invalid or newer.");result.fenced ||= previous.fenced===true||before>=(previous.deadline as number);if(result.revision===previous.revision)result.deadline=Math.min(result.deadline,previous.deadline as number);}
  result.fenced ||= result.deadline<=after;
  if(!ownership())refuse("Ownership changed during deadline publication.");if(canonical(previous)!==canonical(result))journal.write(result);return result;
}
export interface ExecutionSpec extends RecordValue {version:1;binding:BindingData;uri:string;library:{path:string;sha256:string};storageIdentity:Inode;diskIdentity:Inode}
interface Execution {binding:LibvirtLeaseBinding;spec:ExecutionSpec;execution:RecordValue;launch:RecordValue|null}
export interface ProcessBirth {pid:number;createdAt:number;parentPid:number;uid:number;executable:string;argv:string[];zombie:boolean}
export interface LibvirtAdapters {
  run?:ProcessRunner;platform?:NodeJS.Platform;arch?:string;fixture?:boolean;hostBoot?:()=>string;clock?:()=>number;
  connect?:(uri:string,id:string)=>OwnedNativeConnection;
  /** Explicit dedicated-child integration; never run the supervisor in the parent. */
  launch?:(folder:string,parentPid:number)=>{pid:number;createdAt:number};
  processBirth?:(pid:number)=>ProcessBirth|"gone"|"unknown";
  childExecutable?:string;childArguments?:(folder:string,parentPid:number)=>string[];
  fileLease?:FileLeaseFactory;protectedRemove?:(root:string,manifest:ManifestEntry[])=>void;
  kernel?:UsageKernel;process?:(pid:number)=>UsageProcess;
  seed?:(image:RecordValue,machine:RecordValue,storage:string)=>Promise<string|null>;
}
export function domainXML(machine:RecordValue,image:RecordValue,disk:string,leased=true):string{
  uuid(machine.id);const r=object(machine.resources);for(const key of ["cpu","memoryMiB","diskGiB"])if(!Number.isSafeInteger(r[key])||(r[key] as number)<=0)refuse("Invalid native resources.");
  if(!["linux","windows"].includes(String(image.os))||!["amd64","arm64"].includes(String(image.arch))||!["desktop","headless"].includes(String(image.mode)))refuse("Unsupported native template.");
  const e=escapeXML,win=image.os==="windows",storage=dirname(absolute(disk)),seed=image._seedISO;
  return `<domain type="kvm"><name>cvm-${machine.id}</name><uuid>${machine.id}</uuid><memory unit="MiB">${r.memoryMiB}</memory><vcpu>${r.cpu}</vcpu><os firmware="efi"><type arch="${image.arch==="arm64"?"aarch64":"x86_64"}">hvm</type><firmware><feature name="secure-boot" enabled="${(image.secureBoot??win)?"yes":"no"}"/></firmware><boot dev="hd"/>${leased?`<nvram>${e(join(storage,"nvram.fd"))}</nvram>`:""}</os><features><acpi/>${win?'<smm state="on"/>':""}</features><cpu mode="host-passthrough"/><devices><disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="${e(disk)}"/><target dev="${win?"sda":"vda"}" bus="${win?"sata":"virtio"}"/></disk>${seed?`<disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="${e(seed)}"/><target dev="${win?"sdb":"sda"}" bus="${win?"sata":"scsi"}"/><readonly/></disk>${win?"":'<controller type="scsi" model="virtio-scsi"/>'}`:""}<interface type="network"><source network="${e(image.network??"default")}"/><model type="${win?"e1000e":"virtio"}"/></interface><serial type="pty"><target port="0"/></serial><console type="pty"><target type="serial" port="0"/></console>${image.mode==="desktop"?'<graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1"><listen type="address" address="127.0.0.1"/></graphics>':""}<video><model type="${image.mode==="desktop"?(win?"vga":"virtio"):"none"}"/></video>${(image.tpm??win)?`<tpm model="tpm-crb"><backend type="emulator" version="2.0" persistent_state="yes"><source type="dir" path="${e(join(storage,"tpm-state"))}"/></backend></tpm>`:""}</devices></domain>`;
}

/** Native adapters are injected; there is intentionally no virsh fallback for leased execution. */
export class LibvirtProvider {
  readonly kind="libvirt";readonly adapters:LibvirtAdapters;readonly state:string;
  constructor(readonly config:RecordValue,state:string){this.state=absolute(state);this.adapters=(config.adapters??{}) as LibvirtAdapters;}
  private journal(folder:string,prefix?:string):SupervisorJournal{return new SupervisorJournal(folder,prefix,{fixture:this.adapters.fixture===true});}
  private boot():string{return (this.adapters.hostBoot??linuxBootId)();}
  private clock():number{if(!this.adapters.clock)refuse("Suspend-aware CLOCK_BOOTTIME binding is unavailable.");return this.adapters.clock();}
  private uri():string{const uri=this.config.uri??"qemu:///system";if(uri!=="qemu:///system"&&uri!=="qemu:///session")refuse("Use a local libvirt connection.");return uri;}
  private async command(argv:readonly string[],timeoutMs=300000,input?:string):Promise<string>{try{return await(this.adapters.run??runProcess)(argv,{timeoutMs,maxOutputBytes:1048576,...(input===undefined?{}:{input})});}catch{throw new ServiceError("Backend command failed or timed out; its outcome is unconfirmed.",409,{outcome:"unknown"});}}
  private virsh(...args:string[]):Promise<string>{return this.command(["virsh","--connect",this.uri(),...args],30000);}
  private connection(spec:ExecutionSpec,b:LibvirtLeaseBinding):OwnedNativeConnection{if(!this.adapters.connect)refuse("Native libvirt connection binding is unavailable.");return this.adapters.connect(spec.uri,b.machine_id);}
  async check():Promise<unknown>{
    if((this.adapters.platform??process.platform)!=="linux")refuse("The libvirt provider runs on Linux hosts.");this.uri();const arch=this.adapters.arch??({x64:"amd64",arm64:"arm64"}[process.arch as "x64"|"arm64"]);
    const templates=this.config.templates??[];if(!Array.isArray(templates))refuse("Invalid native templates.");for(const value of templates){const image=object(value);if(!["linux","windows"].includes(String(image.os))||image.arch!==arch)refuse("Template is incompatible with this native host.");const path=absolute(image.image);noSymlinks(path);regular(fs.lstatSync(path),false);}
    let artifact:unknown=null;if(this.config.leaseDeadlineLibrary!==undefined)artifact=deadlineArtifact(absolute(this.config.leaseDeadlineLibrary),arch as "amd64"|"arm64");
    await this.virsh("domcapabilities","--virttype","kvm");await this.command(["qemu-img","--version"],30000);
    return{kind:this.kind,libvirtLeaseArtifact:artifact!==null,leaseEligible:false,nativeAcceptance:false,warnings:["Kernel deadlines, native connection lifetime, storage leases and fresh-lease isolation require native acceptance."]};
  }
  private storagePath(machine:RecordValue):string{return join(absolute(this.config.storage),uuid(machine.id));}
  private location(b:LibvirtLeaseBinding,s:ExecutionSpec):boolean{return s.uri===this.uri()&&b.disk===join(this.storagePath({id:b.machine_id}),"disk.qcow2");}
  private readSpec(j:SupervisorJournal,machine:RecordValue,storage=true):{binding:LibvirtLeaseBinding;spec:ExecutionSpec}{
    const value=j.readNamed("libvirt-binding.json");if(!value||!exact(value,["version","binding","uri","library","storageIdentity","diskIdentity"])||value.version!==1||!["qemu:///system","qemu:///session"].includes(String(value.uri)))refuse("Execution binding is missing or invalid.");
    const raw=object(value.binding);if(!exact(raw,["machine_id","lease_id","boot_id","host_boot_id","fingerprint","disk"]))refuse("Malformed execution binding.");const b=new LibvirtLeaseBinding(raw as unknown as BindingData);const spec=value as ExecutionSpec;
    for(const key of ["storageIdentity","diskIdentity"] as const){const id=object(value[key]);if(!exact(id,["device","inode"])||!Object.values(id).every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0))refuse("Invalid storage birth identity.");}
    const library=object(value.library);if(!exact(library,["path","sha256"])||typeof library.sha256!=="string"||!/^[a-f0-9]{64}$/.test(library.sha256))refuse("Invalid native artifact binding.");absolute(library.path);
    const lease=machine.lease?object(machine.lease):null;const assignment=j.readNamed("assignment.json");
    if(b.machine_id!==machine.id||b.fingerprint!==fingerprint(machine)||(lease&&b.lease_id!==lease.id)||!assignment||assignment.fingerprint!==b.fingerprint||(lease&&assignment.leaseId!==b.lease_id)||(!lease&&(b.lease_id!==machine.id||assignment.leaseId!==undefined)))refuse("Binding belongs to another assignment.");
    if(storage)this.assertStorage(b,spec);return{binding:b,spec};
  }
  private assertStorage(b:LibvirtLeaseBinding,s:ExecutionSpec,root=dirname(b.disk)):void{
    noSymlinks(root);const directory=fs.lstatSync(root);owned(directory);if(!directory.isDirectory()||!sameInode(directory,s.storageIdentity)||basename(dirname(b.disk))!==b.machine_id)refuse("Owned storage changed.");
    const disk=fs.lstatSync(join(root,basename(b.disk)));regular(disk,false);if(!sameInode(disk,s.diskIdentity)||readPrivate(join(root,"canaveral-owner.json"))?.fingerprint!==b.fingerprint)refuse("Owned disk or marker changed.");
  }
  private inspect(machine:RecordValue,folder:string):Execution|null{
    const j=this.journal(folder,"libvirt-binding");try{if(!j.read())return null;const{binding,spec}=this.readSpec(j,machine);const execution=j.readNamed("libvirt-execution.json"),launch=j.readNamed("libvirt-launch.json");if(!matches(execution,binding.identity())||(launch&&!matches(launch,binding.identity())))refuse("Execution history is missing or foreign.");return{binding,spec,execution,launch};}finally{j.close();}
  }
  private authorization(image:RecordValue):()=>unknown{if(typeof image._leaseAuthorization!=="function")refuse("Leased execution requires its pinned local deadline.");return image._leaseAuthorization as ()=>unknown;}
  publish(machine:RecordValue,image:RecordValue,folder:string,stopping=false):RecordValue{
    const j=this.journal(folder,"libvirt-authorization");try{const{binding:b,spec:s}=this.readSpec(j,machine);return publishAuthorization(b,j,this.authorization(image),()=>{this.readSpec(j,machine);return true;},()=>this.boot(),()=>this.clock(),stopping||!this.location(b,s));}finally{j.close();}
  }
  private supervisorAlive(b:LibvirtLeaseBinding,folder:string,launch:RecordValue|null):boolean{
    if(!matches(launch,b.identity())||!Number.isSafeInteger(launch.pid)||(launch.pid as number)<=1||!finite(launch.createdAt)||!Number.isSafeInteger(launch.parentPid)||(launch.parentPid as number)<=1||!this.adapters.processBirth||!this.adapters.childExecutable||!this.adapters.childArguments)return false;
    const p=this.adapters.processBirth(launch.pid as number);return typeof p==="object"&&p.pid===launch.pid&&p.createdAt===launch.createdAt&&p.parentPid===launch.parentPid&&p.uid===process.getuid?.()&&p.executable===this.adapters.childExecutable&&!p.zombie&&canonical(p.argv)===canonical(this.adapters.childArguments(folder,launch.parentPid as number));
  }
  private supervisorGone(b:LibvirtLeaseBinding,launch:RecordValue|null):boolean{
    if(!matches(launch,b.identity())||!Number.isSafeInteger(launch.pid)||(launch.pid as number)<=1||!finite(launch.createdAt)||!this.adapters.processBirth)return false;const p=this.adapters.processBirth(launch.pid as number);return p==="gone"||(typeof p==="object"&&p.createdAt!==launch.createdAt);
  }
  private launch(machine:RecordValue,folder:string):void{
    if(!this.adapters.launch||!this.adapters.childExecutable||!this.adapters.childArguments||!this.adapters.processBirth)refuse("Dedicated native supervisor child binding is unavailable.");
    const j=this.journal(folder,"libvirt-launch");try{const{binding:b,spec:s}=this.readSpec(j,machine);if(j.read()||canonical(j.readNamed("libvirt-execution.json"))!==canonical({...b.identity(),phase:"prepared"}))refuse("Supervisor launch cannot be replayed.");
      if(hash(snapshotFile(s.library.path,8*1048576))!==s.library.sha256)refuse("Deadline artifact changed before launch.");
      const record={...b.identity(),parentPid:process.pid,attemptedAt:Date.now()/1000};j.write(record);const child=this.adapters.launch(folder,process.pid);
      if(!Number.isSafeInteger(child.pid)||child.pid<=1||!finite(child.createdAt))refuse("Supervisor birth is unknown.");const next={...record,...child};if(!this.supervisorAlive(b,folder,next))refuse("Supervisor identity is unconfirmed.");j.write(next);
    }finally{j.close();}
  }
  private async prepare(machine:RecordValue,image:RecordValue,folder:string,leased:boolean):Promise<void>{
    if(leased&&(!this.adapters.connect||!this.adapters.launch||!this.adapters.clock))refuse("Leased native execution binding is insufficient; preparation refused.");
    const library=leased?deadlineArtifact(absolute(this.config.leaseDeadlineLibrary),(this.adapters.arch??"amd64") as "amd64"|"arm64"):{path:"/unavailable-administrative-deadline",sha256:"0".repeat(64)};
    const assignment=fingerprint(machine);const j=this.journal(folder,"libvirt-binding");try{
      if(j.read()||["libvirt-execution.json","libvirt-launch.json","libvirt-authorization.json"].some(n=>j.readNamed(n)!==null))refuse("Preparation cannot adopt prior or partial history.");
      const a=j.readNamed("assignment.json"),lease=leased?object(machine.lease):null;if(a?.fingerprint!==assignment||(lease&&a.leaseId!==lease.id))refuse("Preparation cannot adopt another assignment.");
      if((await this.virsh("list","--all","--name")).split(/\r?\n/).includes(`cvm-${machine.id}`)||(await this.virsh("list","--all","--uuid")).toLowerCase().split(/\r?\n/).includes(String(machine.id)))refuse("Cannot adopt an existing domain.");
      const root=absolute(this.config.storage);noSymlinks(root);const parent=fs.lstatSync(root);owned(parent);if(!parent.isDirectory())refuse("Owned storage parent required.");const path=this.storagePath(machine);
      try{fs.mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      noSymlinks(path);const st=fs.lstatSync(path);owned(st);if(!st.isDirectory())refuse("Owned storage directory required.");const owner=join(path,"canaveral-owner.json");
      const prior=readPrivate(owner);if(prior){if(prior.fingerprint!==assignment)refuse("Storage belongs to another assignment.");}else{if(fs.readdirSync(path).length)refuse("Unmarked storage cannot be adopted.");const fd=fs.openSync(owner,"wx",0o600);try{fs.writeFileSync(fd,canonical({fingerprint:assignment}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      if(fs.readdirSync(path).some(n=>n!=="canaveral-owner.json"))refuse("Partial native preparation cannot be replayed.");
      const base=absolute(image.image);noSymlinks(base);regular(fs.lstatSync(base),false);let seed:string|null=null;
      if(image.guestAccess&&!this.adapters.seed)refuse("Guest seed construction is not bound.");if(this.adapters.seed)seed=await this.adapters.seed(image,machine,path);
      if(seed&&(dirname(absolute(seed))!==path||!fs.lstatSync(seed).isFile()||fs.lstatSync(seed).isSymbolicLink()))refuse("Seed media is not owned.");
      const info=object(JSON.parse(await this.command(["qemu-img","info","--output=json",base])));const resources=object(machine.resources);
      if(!Number.isSafeInteger(info["virtual-size"])||(info["virtual-size"] as number)<0||(info["virtual-size"] as number)>(resources.diskGiB as number)*1073741824||!["raw","qcow2"].includes(String(info.format))||info["backing-filename"])refuse("Base disk must be standalone and fit the assignment.");
      // Persist intent before qemu-img: a lost creation acknowledgement cannot repeat provisioning.
      const disk=join(path,"disk.qcow2"),b=new LibvirtLeaseBinding({machine_id:uuid(machine.id),lease_id:leased?uuid(object(machine.lease).id):uuid(machine.id),boot_id:randomUUID(),host_boot_id:this.boot(),fingerprint:assignment,disk});
      const execution=this.journal(folder);try{execution.write({...b.identity(),phase:"preparing"});}finally{execution.close();}
      const output=fs.openSync(disk,"wx",0o600),birth=inode(fs.fstatSync(output));
      try {
        // Child access names this retained descriptor, not a swappable output path.
        const destination=process.platform==="linux"?`/proc/${process.pid}/fd/${output}`:disk;
        await this.command(["qemu-img","create","-f","qcow2","-F",String(info.format),"-b",base,destination,`${resources.diskGiB}G`]);
        if(!sameInode(fs.lstatSync(disk),birth))refuse("Prepared disk was replaced during creation.");fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      regular(fs.lstatSync(disk),false);const spec:ExecutionSpec={version:1,binding:{...b},uri:this.uri(),library:{path:library.path as string,sha256:library.sha256 as string},storageIdentity:inode(st),diskIdentity:inode(fs.lstatSync(disk))};this.assertStorage(b,spec);j.write(spec);
      const xml=bindDomainXML(domainXML(machine,{...image,...(seed?{_seedISO:seed}:{})},disk),b),definition=join(path,"domain.xml");const fd=fs.openSync(definition,"wx",0o600);try{fs.writeFileSync(fd,xml);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      const dir=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      const receipt=this.journal(folder);try{receipt.write({...b.identity(),phase:"prepared"});}finally{receipt.close();}
      this.assertStorage(b,spec);validateDomainXML(xml,b);
      // The driver receives the validated bytes; it cannot reopen a replaced XML path.
      await this.command(["virsh","--connect",this.uri(),"define","/dev/stdin"],30000,xml);
    }finally{j.close();}
  }
  async reconcile(machine:RecordValue,image:RecordValue,folder:string):Promise<RecordValue>{
    uuid(machine.id);if(!["running","stopped"].includes(String(machine.desired)))refuse("Invalid desired state.");domainXML(machine,image,join(this.storagePath(machine),"disk.qcow2"));
    const gate=this.journal(folder,"libvirt-reconcile");try{
      const leased=!!machine.lease;let current=this.inspect(machine,folder);
      if(!current){if(machine.desired==="stopped")return{state:"unknown",...(leased?{leaseFenced:true}:{}),detail:"No execution history; native resources were not adopted."};
        if(leased){const value=this.authorization(image)();if(!validAuthorization(value,uuid(object(machine.lease).id))||value.fenced===true||(value.remainingSeconds as number)<=0)refuse("Execution was fenced before preparation.");}
        await this.prepare(machine,image,folder,leased);current=this.inspect(machine,folder);if(!current)refuse("Preparation outcome is unknown.");
      }
      const{binding:b,spec:s,execution,launch}=current;if(!this.location(b,s)){if(leased)this.publish(machine,image,folder,true);return{state:"unknown",leaseFenced:leased,detail:"Runtime location changed; no native namespace was adopted."};}
      if(leased){const auth=this.publish(machine,image,folder,machine.desired==="stopped"||execution.phase==="fenced");if(auth.fenced===true){const stopped=this.confirmExecutionStopped(machine,folder);return{state:stopped?"stopped":"stopping",leaseFenced:true,detail:"Storage handles and erasure remain unverified."};}}
      const id=uuid(machine.id);const xml=await this.virsh("dumpxml",id);validateDomainXML(xml,b);if((await this.virsh("domuuid",id)).toLowerCase()!==id)refuse("Native UUID differs.");this.assertStorage(b,s);
      const state=(await this.virsh("domstate",id)).toLowerCase();
      if(leased){if(!launch){if(execution.phase!=="prepared"||state!=="shut off")refuse("Launch is not a fresh inactive owned boot.");this.launch(machine,folder);return{state:"starting"};}
        if(execution.phase==="running"&&state==="running"&&this.supervisorAlive(b,folder,launch))return{state:"running"};
        if(execution.phase==="running"){this.publish(machine,image,folder,true);return{state:"unknown",leaseFenced:true};}return{state:"starting",detail:"Supervisor launch outcome is pending or uncertain; it is never replayed."};
      }
      if(machine.desired==="stopped"){if(state==="shut off")return{state:"stopped"};await this.adminAction(machine,folder,b,s,"shutdown");return{state:"stopping",detail:"Graceful shutdown requested; storage retained."};}
      if(state==="shut off"){await this.adminAction(machine,folder,b,s,"start");return{state:"starting"};}return{state:state==="running"?"running":"unknown"};
    }finally{gate.close();}
  }
  private async adminAction(machine:RecordValue,folder:string,b:LibvirtLeaseBinding,s:ExecutionSpec,action:"start"|"shutdown"):Promise<void>{
    const j=this.journal(folder);try{const old=j.read();if(old?.phase===`${action}-pending`)refuse("Uncertain native action is not replayed.");
      const validate=async()=>{this.readSpec(j,machine);if(!this.location(b,s)||(await this.virsh("domuuid",b.machine_id)).toLowerCase()!==b.machine_id)refuse("Administrative native owner changed.");validateDomainXML(await this.virsh("dumpxml",b.machine_id),b);this.assertStorage(b,s);};
      await validate();j.write({...b.identity(),phase:`${action}-pending`});await validate();await this.virsh(action,b.machine_id);j.write({...b.identity(),phase:`${action}-requested`});
    }finally{j.close();}
  }
  private terminal(machine:RecordValue):string{const l=object(machine.lease),intent=object(machine.leaseCleanup);if(machine.desired!=="stopped"||!["released","expired","failed"].includes(String(l.state))||intent.leaseId!==l.id)refuse("Cleanup requires a terminal stopped lease and exact intent.");return uuid(intent.id);}
  private rebootBase(machine:RecordValue,j:SupervisorJournal,b:LibvirtLeaseBinding,s:ExecutionSpec):RecordValue{return{...b.identity(),cleanupId:this.terminal(machine),specDigest:digest(s),launchDigest:digest(j.readNamed("libvirt-launch.json"))};}
  private rebootContext(machine:RecordValue,j:SupervisorJournal,b:LibvirtLeaseBinding,s:ExecutionSpec,observed:string,stopped=false):RecordValue|null{
    uuid(observed);const record=j.readNamed("libvirt-reboot.json");if(observed===b.host_boot_id){if(record)refuse("Original boot cannot replace reboot history.");return null;}
    const base=this.rebootBase(machine,j,b,s),a=j.readNamed("libvirt-authorization.json");
    if(!matches(record,base)||!exact(record,[...Object.keys(base),"observedHostBootId","authorityDigest","phase"])||record.observedHostBootId!==observed||!["fenced","stopped"].includes(String(record.phase))||(stopped&&record.phase!=="stopped")||!a||!validAuthority(a,b)||a.fenced!==true||a.deadline!==0||record.authorityDigest!==digest(a))refuse("Current reboot fencing or native stop is unconfirmed.");return record;
  }
  private fenceReboot(machine:RecordValue,j:SupervisorJournal,b:LibvirtLeaseBinding,s:ExecutionSpec,observed:string,authorization?:()=>unknown):RecordValue{
    uuid(observed);if(observed===b.host_boot_id)refuse("Reboot fencing requires a different boot.");const base=this.rebootBase(machine,j,b,s),launch=j.readNamed("libvirt-launch.json");let execution=j.read();
    if(!matches(execution,b.identity())||!["prepared","starting","creating","resuming","running","fenced"].includes(String(execution.phase))||(launch&&!matches(launch,b.identity())))refuse("Original launch history is unknown.");
    const unchanged=()=>{if(this.boot()!==observed||!this.location(b,s)||canonical(this.readSpec(j,machine,false).spec)!==canonical(s)||canonical(j.read())!==canonical(execution)||canonical(j.readNamed("libvirt-launch.json"))!==canonical(launch))refuse("Reboot fencing context changed.");};
    const reboot=this.journal(j.folder,"libvirt-reboot"),auth=this.journal(j.folder,"libvirt-authorization");try{
      const old=reboot.read();if(old&&(!matches(old,base)||old.observedHostBootId===b.host_boot_id||!["fenced","stopped"].includes(String(old.phase))||!exact(old,[...Object.keys(base),"observedHostBootId","authorityDigest","phase"])||typeof old.authorityDigest!=="string"||!/^[a-f0-9]{64}$/.test(old.authorityDigest)))refuse("Foreign reboot receipt cannot be adopted.");
      const previous=auth.read();if(previous&&!validAuthority(previous,b))refuse("Original authorization is unknown.");let revision=previous?.revision;
      if(authorization){const v=authorization();if(!validAuthorization(v,b.lease_id)||v.fenced!==true||(previous&&(v.revision as number)<(previous.revision as number)))refuse("Reboot requires current terminal authorization.");revision=v.revision;}else if(!previous||previous.fenced!==true)refuse("Recovery lacks an existing fence.");
      const result={...b.identity(),revision,deadline:0,fenced:true};unchanged();auth.write(result);unchanged();execution={...b.identity(),phase:"fenced",reason:"host-reboot-observation-pending"};j.write(execution);unchanged();
      const record={...base,observedHostBootId:observed,authorityDigest:digest(result),phase:"fenced"};reboot.write(record);unchanged();return record;
    }finally{auth.close();reboot.close();}
  }
  private markRebootStopped(machine:RecordValue,j:SupervisorJournal,b:LibvirtLeaseBinding,s:ExecutionSpec,observed:string,expected:RecordValue):void{
    const r=this.journal(j.folder,"libvirt-reboot");try{if(canonical(r.read())!==canonical(expected)||this.boot()!==observed)refuse("Boot receipt changed during stop observation.");this.rebootContext(machine,j,b,s,observed);j.write({...b.identity(),phase:"fenced",stopEvidence:"host-reboot",observedHostBootId:observed});r.write({...expected,phase:"stopped"});if(this.boot()!==observed)refuse("Host boot changed after stop publication.");}finally{r.close();}
  }
  async stopForCleanup(machine:RecordValue,image:RecordValue,folder:string):Promise<RecordValue>{
    this.terminal(machine);const j=this.journal(folder,"libvirt-binding");let current:{binding:LibvirtLeaseBinding;spec:ExecutionSpec};try{current=this.readSpec(j,machine);}finally{j.close();}
    if(this.boot()===current.binding.host_boot_id)this.publish(machine,image,folder,true);else{const execution=this.journal(folder);try{this.readSpec(execution,machine);this.fenceReboot(machine,execution,current.binding,current.spec,this.boot(),this.authorization(image));this.readSpec(execution,machine);}finally{execution.close();}}
    return{state:this.confirmExecutionStopped(machine,folder)?"stopped":"stopping",leaseFenced:true};
  }
  async refreshExecution(machine:RecordValue,image:RecordValue,folder:string,authorization?:()=>unknown):Promise<RecordValue|null>{
    const current=this.inspect(machine,folder);if(!current)return null;const ended=current.execution.phase==="fenced"||!this.location(current.binding,current.spec)||(current.execution.phase==="running"&&!this.supervisorAlive(current.binding,folder,current.launch));
    const auth=this.publish(machine,authorization?{...image,_leaseAuthorization:authorization}:image,folder,machine.desired==="stopped"||ended);if(auth.fenced===true)return{state:this.confirmExecutionStopped(machine,folder)?"stopped":"stopping",leaseFenced:true};return null;
  }
  private confirmStoppedLocked(machine:RecordValue,j:SupervisorJournal):RecordValue|null{
    const{binding:b,spec:s}=this.readSpec(j,machine),observed=uuid(this.boot());if(!this.location(b,s))return null;const reboot=this.rebootContext(machine,j,b,s,observed),auth=j.readNamed("libvirt-authorization.json"),execution=j.read();
    if(!auth||!validAuthority(auth,b)||auth.fenced!==true||!matches(execution,b.identity())||!["prepared","starting","creating","resuming","running","fenced"].includes(String(execution.phase)))return null;
    const launch=j.readNamed("libvirt-launch.json"),never=launch===null&&(execution.phase==="prepared"||(execution.phase==="fenced"&&execution.stopEvidence==="never-launched"));
    if(!reboot&&!never&&!this.supervisorGone(b,launch))return null;
    const connection=this.connection(s,b);let closed=false;
    try{connection.validate(b,false);if(canonical(j.readNamed("libvirt-launch.json"))!==canonical(launch)||(!reboot&&!never&&!this.supervisorGone(b,launch))||this.boot()!==observed||!this.location(b,s)||canonical(this.rebootContext(machine,j,b,s,observed))!==canonical(reboot)||canonical(this.readSpec(j,machine).spec)!==canonical(s))return null;
      connection.close();closed=true;if(this.boot()!==observed||!this.location(b,s)||canonical(this.readSpec(j,machine).spec)!==canonical(s)||canonical(j.readNamed("libvirt-launch.json"))!==canonical(launch))return null;
      const evidence=reboot?"host-reboot":never?"never-launched":"supervisor-exited";
      if(reboot)this.markRebootStopped(machine,j,b,s,observed,reboot);else j.write({...b.identity(),phase:"fenced",stopEvidence:evidence});
      return{...b.identity(),executionStopped:true,evidence,observedHostBootId:observed,storageHandles:"unknown",storageRemoved:false};
    }finally{if(!closed)connection.close();}
  }
  confirmExecutionStopped(machine:RecordValue,folder:string):RecordValue|null{let j:SupervisorJournal|undefined;try{j=this.journal(folder);return this.confirmStoppedLocked(machine,j);}catch{return null;}finally{j?.close();}}
  private absent(s:ExecutionSpec,b:LibvirtLeaseBinding):void{const c=this.connection(s,b);try{if(!c.absent())refuse("Native definition remains.");}finally{c.close();}}
  private manifest(j:SupervisorJournal,records:ManifestEntry[]):string{
    const data=records.map(r=>{const line=canonical(r)+"\n";if(Buffer.byteLength(line)>65536)refuse("Storage manifest path is oversized.");return line;}).join("");
    const target=j.path("libvirt-removal-manifest.jsonl"),tmp=j.path(`manifest-${randomUUID()}`);j.check();try{fs.lstatSync(target);regular(fs.lstatSync(target));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const fd=fs.openSync(tmp,"wx",0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}j.check();fs.renameSync(tmp,target);const dir=fs.openSync(dirname(target),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}j.check();return hash(data);
  }
  private checkManifest(j:SupervisorJournal,records:ManifestEntry[],checksum:unknown,partial=false):void{
    // Records are streamed without a total file-count cap; each path record is bounded.
    const fd=fs.openSync(j.path("libvirt-removal-manifest.jsonl"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const wanted=new Map(records.map(r=>[canonical(r.path),canonical(r)]));const seen=new Set<string>();const chunks:Buffer[]=[];
    try{const before=fs.fstatSync(fd);regular(before);const block=Buffer.alloc(65536);let pending=Buffer.alloc(0);for(;;){const n=fs.readSync(fd,block,0,block.length,null);if(!n)break;const part=Buffer.from(block.subarray(0,n));chunks.push(part);pending=Buffer.concat([pending,part]);let end:number;while((end=pending.indexOf(10))>=0){if(end+1>65536)refuse("Manifest record is oversized.");const value=object(JSON.parse(pending.subarray(0,end).toString("utf8"))),key=canonical(value.path);if(seen.has(key)||(!partial&&!wanted.has(key))||(wanted.has(key)&&wanted.get(key)!==canonical(value)))refuse("Storage manifest identity differs.");seen.add(key);wanted.delete(key);pending=pending.subarray(end+1);}if(pending.length>65536)refuse("Manifest record is oversized.");}
      const after=fs.fstatSync(fd);if(pending.length||wanted.size||hash(Buffer.concat(chunks))!==checksum||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)refuse("Storage manifest integrity is unconfirmed.");
    }finally{fs.closeSync(fd);}
  }
  async removeOwnedStorage(machine:RecordValue,_image:RecordValue,folder:string,requestId:string):Promise<RecordValue>{
    if(this.terminal(machine)!==uuid(requestId))refuse("Removal cleanup intent differs.");
    // Refuse before quarantine if the kernel lease/protected unlink binding is absent.
    if(!this.adapters.fileLease||!this.adapters.protectedRemove||!this.adapters.connect)refuse("Native storage erasure binding is unavailable; no removal was attempted.");
    const execution=this.journal(folder),deletion=this.journal(folder,"deletion");try{
      const{binding:b,spec:s}=this.readSpec(execution,machine,false),storage=dirname(b.disk),quarantine=join(dirname(storage),`.removing-${b.machine_id}-${requestId}`),launch=execution.readNamed("libvirt-launch.json");
      noSymlinks(dirname(storage));const parent=fs.lstatSync(dirname(storage));owned(parent);const expected={...b.identity(),id:requestId,specDigest:digest(s),launchDigest:digest(launch)};
      let proof=deletion.read();
      const exists=(path:string)=>{try{const info=fs.lstatSync(path);if(info.isSymbolicLink())refuse("Removal cannot adopt a symlink.");return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}};
      const context=()=>{const observed=proof?.observedHostBootId??b.host_boot_id;if(this.boot()!==observed||!this.location(b,s)||canonical(this.readSpec(execution,machine,false).spec)!==canonical(s)||canonical(execution.readNamed("libvirt-launch.json"))!==canonical(launch))refuse("Removal context changed.");
        const a=execution.readNamed("libvirt-authorization.json"),e=execution.read();if(!a||!validAuthority(a,b)||a.fenced!==true||!matches(e,b.identity())||e.phase!=="fenced"||!["never-launched","supervisor-exited","host-reboot"].includes(String(e.stopEvidence)))refuse("Removal lacks a stopped fenced boot.");
        this.rebootContext(machine,execution,b,s,uuid(observed),true);if(observed!==b.host_boot_id&&(e.stopEvidence!=="host-reboot"||e.observedHostBootId!==observed))refuse("Current reboot stop evidence is missing.");
        const p=fs.lstatSync(dirname(storage));owned(p);if(!p.isDirectory()||!sameInode(p,inode(parent)))refuse("Storage parent changed.");exists(storage);exists(quarantine);
      };
      const syncParent=()=>{const fd=fs.openSync(dirname(storage),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{if(!sameInode(fs.fstatSync(fd),inode(parent)))refuse("Storage parent changed.");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
      if(!proof){this.readSpec(execution,machine);const stopped=this.confirmStoppedLocked(machine,execution);if(!stopped||stopped.executionStopped!==true)refuse("Positive native stop is required before removal.");if(exists(quarantine))refuse("Storage quarantine is occupied.");proof={...expected,state:"planned",executionStopped:true,evidence:stopped.evidence,observedHostBootId:stopped.observedHostBootId};context();deletion.write(proof);}
      if(!matches(proof,expected)||proof.executionStopped!==true||!["never-launched","supervisor-exited","host-reboot"].includes(String(proof.evidence))||!["planned","quarantined","retired","erasing","cleared","removing","complete"].includes(String(proof.state)))refuse("Removal receipt belongs to another intent.");
      if(["erasing","cleared","removing","complete"].includes(String(proof.state))&&(typeof proof.manifest!=="string"||!/^[a-f0-9]{64}$/.test(proof.manifest)))refuse("Removal manifest is missing.");
      if(["cleared","removing","complete"].includes(String(proof.state))&&proof.contentsErased!==true)refuse("Durable cleared-content evidence is missing.");if(proof.state==="complete"&&proof.storageRemoved!==true)refuse("Storage completion evidence is missing.");
      if(this.boot()!==proof.observedHostBootId){const observed=this.boot();if(observed===b.host_boot_id)refuse("Reboot history cannot restore original boot.");const r=this.fenceReboot(machine,execution,b,s,observed),c=this.connection(s,b);try{if(proof.state==="planned")c.validate(b,false);else if(proof.state==="quarantined"){if(!c.absent())c.validate(b,false);}else if(!c.absent())refuse("Retired domain reappeared after reboot.");}finally{c.close();}
        if(this.boot()!==observed||!this.location(b,s)||canonical(this.readSpec(execution,machine,false).spec)!==canonical(s))refuse("Reboot context changed during native observation.");this.markRebootStopped(machine,execution,b,s,observed,r);proof={...proof,observedHostBootId:observed,evidence:"host-reboot"};deletion.write(proof);}
      context();if(proof.state==="complete"){if(exists(storage)||exists(quarantine))refuse("Storage reappeared after completion.");this.absent(s,b);context();return proof;}
      if(exists(storage)){if(proof.state!=="planned"||exists(quarantine))refuse("Storage layout conflicts with removal intent.");this.assertStorage(b,s);context();fs.renameSync(storage,quarantine);syncParent();}
      if(proof.state==="planned"){this.assertStorage(b,s,quarantine);proof={...proof,state:"quarantined"};deletion.write(proof);}
      if(exists(quarantine)){
        const guard=new StorageHandleGuard(quarantine,s.storageIdentity,this.adapters.fileLease);try{context();if(exists(storage))refuse("Original storage path reappeared.");
          if(proof.state==="quarantined"){const c=this.connection(s,b);try{if(!c.absent())c.retire(b);if(!c.absent())refuse("Retirement is unconfirmed.");}finally{c.close();}guard.verify();context();proof={...proof,state:"retired"};deletion.write(proof);}else this.absent(s,b);
          if(proof.state==="retired"){proof={...proof,state:"erasing",manifest:this.manifest(deletion,guard.snapshot())};deletion.write(proof);}
          if(proof.state==="erasing"){this.checkManifest(deletion,guard.snapshot(),proof.manifest);context();guard.eraseContents();context();proof={...proof,state:"cleared",contentsErased:true};deletion.write(proof);}
          if(proof.state==="cleared"){this.checkManifest(deletion,guard.snapshot(),proof.manifest);if(!guard.empty())refuse("Storage contains uncleared contents.");proof={...proof,state:"removing"};deletion.write(proof);}
          if(proof.state!=="removing"||proof.contentsErased!==true)refuse("Removal has no durable cleared-content receipt.");this.checkManifest(deletion,guard.snapshot(),proof.manifest,true);if(!guard.empty())refuse("Storage contents reappeared.");guard.verify();context();this.absent(s,b);guard.verify();
          guard.remove(this.adapters.protectedRemove);syncParent();
        }finally{guard.close();}
      }else if(proof.state!=="removing"||proof.contentsErased!==true)refuse("Missing storage is not erasure evidence.");
      context();this.absent(s,b);context();if(exists(storage)||exists(quarantine))refuse("Storage remains after erasure.");syncParent();proof={...proof,state:"complete",storageRemoved:true};deletion.write(proof);return proof;
    }finally{deletion.close();execution.close();}
  }
  /** Read-only observation; never starts a replacement observer or signals a recovered PID. */
  resourceProcesses(machine:RecordValue,_image:RecordValue,folder:string):BoundUsageProcess[]{
    if(!this.adapters.connect)refuse("Native resource attribution is unavailable.");
    // Do not acquire/create runtime locks for accounting.
    const read=(name:string)=>readPrivate(join(folder,name));noSymlinks(folder);const spec=read("libvirt-binding.json") as ExecutionSpec|null;if(!spec)refuse("Resource binding is missing.");const b=new LibvirtLeaseBinding(spec.binding);const assignment=read("assignment.json"),marker=readPrivate(join(dirname(b.disk),"canaveral-owner.json"));
    if(b.machine_id!==machine.id||b.fingerprint!==fingerprint(machine)||assignment?.fingerprint!==b.fingerprint||marker?.fingerprint!==b.fingerprint||!this.location(b,spec))refuse("Resource assignment ownership differs.");this.assertStorage(b,spec);const boot=uuid(this.boot());
    if(machine.lease&&(b.host_boot_id!==boot||object(machine.lease).id!==b.lease_id||assignment.leaseId!==b.lease_id))refuse("Resource lease boot differs.");
    const connection=this.connection(spec,b);try{const s=connection.snapshot();if(s.uuid!==b.machine_id)refuse("Resource native UUID differs.");validateDomainXML(s.xml,b);let result:BoundUsageProcess[]=[];
      if(!s.active){if(s.state!=="shut off"||domainHasTPM(s.xml)||canonical(connection.snapshot())!==canonical(s))refuse("Inactive helper usage is unknown.");}
      else{if(!["running","paused"].includes(s.state)||!s.id||!s.threads?.length||!this.adapters.kernel||!this.adapters.process)refuse("Native resource anchor is unavailable.");
        const kernel=this.adapters.kernel,process=this.adapters.process,emulator=domainEmulator(s.xml);if(!emulator)refuse("Native emulator identity is unavailable.");const tgids=new Set(s.threads.map(t=>kernel.tgid(t)));if(tgids.size!==1)refuse("QMP threads do not identify one QEMU process.");const pid=[...tgids][0]!,primary=process(pid),argv=primary.argv,born=primary.createdAt;
        if(!finite(born)||primary.executable!==emulator||argv.filter(a=>a==="-uuid").length!==1||argv[argv.indexOf("-uuid")+1]!==b.machine_id)refuse("QEMU executable or UUID arguments differ.");
        const domain=kernel.domain(pid,s.id,`cvm-${b.machine_id}`),members=kernel.members(domain);if(!members.has(pid))refuse("QEMU is not a scoped domain member.");const ordered=[...members].sort((a,c)=>a-c),last=ordered.at(-1);
        const verify=(member:number,birth:number)=>{const p=process(member),q=process(pid);if(this.boot()!==boot||p.createdAt!==birth||q.createdAt!==born||q.executable!==emulator||canonical(q.argv)!==canonical(argv)||!kernel.contains(member,domain)||!kernel.contains(pid,domain)||(member===last&&canonical([...kernel.members(domain)].sort((a,c)=>a-c))!==canonical(ordered)))refuse("Resource process identity changed.");};
        result=ordered.map(member=>{const p=process(member);if(!finite(p.createdAt))refuse("Resource process birth is unknown.");verify(member,p.createdAt);return{process:p,birth:p.createdAt,category:"virtualMachines",verifyResourceIdentity:()=>verify(member,p.createdAt)};});
        if(canonical([...kernel.members(domain)].sort((a,c)=>a-c))!==canonical(ordered)||canonical(connection.snapshot())!==canonical(s))refuse("Native membership changed during accounting.");
      }
      if(this.boot()!==boot||canonical(read("assignment.json"))!==canonical(assignment)||canonical(readPrivate(join(dirname(b.disk),"canaveral-owner.json")))!==canonical(marker))refuse("Resource ownership changed during collection.");this.assertStorage(b,spec);return result;
    }finally{connection.close();}
  }
}

export interface UsageProcess {pid:number;createdAt:number;executable:string;argv:string[];[key:string]:unknown}
export interface UsageDomain {path:string;identity:Inode}
export interface UsageKernel {tgid(tid:number):number;domain(pid:number,id:number,name:string):UsageDomain;members(domain:UsageDomain):Set<number>;contains(pid:number,domain:UsageDomain):boolean}
export interface BoundUsageProcess {process:UsageProcess;birth:number;category:"virtualMachines";verifyResourceIdentity():void}
export function parseQMPThreads(text:string):number[]{
  if(Buffer.byteLength(text)>1048576)refuse("QMP response exceeds its envelope.");const value=object(JSON.parse(text));if(Object.keys(value).some(k=>k!=="return"&&k!=="id")||!Array.isArray(value.return))refuse("Invalid QMP response.");const threads=new Set<number>(),indices=new Set<number>();
  for(const item of value.return){const cpu=object(item),tid=cpu["thread-id"],index=cpu["cpu-index"];if(!Number.isSafeInteger(tid)||(tid as number)<=1||!Number.isSafeInteger(index)||(index as number)<0||indices.has(index as number))refuse("Invalid QMP CPU identity.");threads.add(tid as number);indices.add(index as number);}if(!threads.size)refuse("QMP returned no native threads.");return[...threads].sort((a,b)=>a-b);
}
/** Fixed Linux proc/cgroup interface. Alternative roots exist only for private fixtures. */
export class LinuxDomainCgroup implements UsageKernel {
  constructor(readonly proc="/proc",readonly root="/sys/fs/cgroup"){}
  private read(path:string,limit=65536):string{const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{if(!fs.fstatSync(fd).isFile())refuse("Kernel record is not regular.");const data=Buffer.alloc(limit+1),n=fs.readSync(fd,data,0,data.length,null);if(n>limit)refuse("Kernel record exceeds its envelope.");return data.subarray(0,n).toString("utf8");}finally{fs.closeSync(fd);}}
  tgid(tid:number):number{if(!Number.isSafeInteger(tid)||tid<=1)refuse("Invalid native thread.");const values=[...this.read(join(this.proc,String(tid),"status")).matchAll(/^Tgid:\s*([0-9]+)\s*$/gm)];if(values.length!==1||Number(values[0]![1])<=1)refuse("Native thread group is unknown.");return Number(values[0]![1]);}
  private membership(pid:number):string{const matches=this.read(join(this.proc,String(pid),"cgroup")).split("\n").filter(l=>l.startsWith("0::"));if(matches.length!==1)refuse("Ambiguous cgroup membership.");return absolute(matches[0]!.slice(3));}
  domain(pid:number,id:number,name:string):UsageDomain{
    if(!Number.isSafeInteger(id)||id<=0||id>=0xffffffff)refuse("Invalid native domain ID.");
    const mounts=this.read(join(this.proc,"self/mountinfo"),1048576).split("\n").filter(line=>{const f=line.split(" "),s=f.indexOf("-");return s>5&&f[s+1]==="cgroup2"&&f[3]==="/"&&f[4]?.replace(/\\([0-7]{3})/g,(_,oct:string)=>String.fromCharCode(parseInt(oct,8)))===this.root;});if(mounts.length!==1)refuse("A full unambiguous cgroup-v2 mount is required.");
    const parts=this.membership(pid).split("/").filter(Boolean),candidates:string[]=[];for(let i=0;i<parts.length;i++){const raw=parts[i]!,part=raw.replace(/\\x([a-fA-F0-9]{2})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16))),prefix=`machine-qemu-${id}-`,guest=part.slice(prefix.length,-6);if((part.startsWith(prefix)&&part.endsWith(".scope")&&guest&&name.startsWith(guest))||raw===`qemu-${id}-${name}.libvirt-qemu`)candidates.push("/"+parts.slice(0,i+1).join("/"));}
    if(candidates.length!==1)refuse("Native domain cgroup is ambiguous.");const path=candidates[0]!,location=join(this.root,path);noSymlinks(location);const base=fs.lstatSync(this.root);let current=this.root;for(const part of path.split("/").filter(Boolean)){current=join(current,part);const s=fs.lstatSync(current);if(!s.isDirectory()||s.dev!==base.dev)refuse("Cgroup mount boundary changed.");}return{path,identity:inode(fs.lstatSync(location))};
  }
  members(domain:UsageDomain):Set<number>{
    const location=join(this.root,domain.path),result=new Set<number>(),dirs:{path:string;birth:Inode}[]=[];
    const walk=(path:string)=>{const s=fs.lstatSync(path);if(!s.isDirectory()||s.dev!==domain.identity.device)refuse("Cgroup directory changed.");dirs.push({path,birth:inode(s)});const kind=this.read(join(path,"cgroup.type")).trim();if(!["domain","domain threaded","threaded"].includes(kind))refuse("Unsupported cgroup type.");
      if(kind!=="threaded"){const fd=fs.openSync(join(path,"cgroup.procs"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{if(!fs.fstatSync(fd).isFile())refuse("Invalid cgroup process list.");const block=Buffer.alloc(4096);let pending="";for(;;){const n=fs.readSync(fd,block,0,block.length,null);if(!n)break;pending+=block.subarray(0,n).toString("ascii");let end:number;while((end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line.length>=63||!/^\d+$/.test(line)||!Number.isSafeInteger(Number(line))||Number(line)<=1)refuse("Invalid cgroup PID record.");result.add(Number(line));}if(pending.length>=63)refuse("Oversized cgroup PID record.");}if(pending)refuse("Incomplete cgroup PID record.");}finally{fs.closeSync(fd);}}
      for(const name of fs.readdirSync(path)){const p=join(path,name),value=fs.lstatSync(p);if(value.isSymbolicLink())refuse("Cgroup symlink is unsupported.");if(value.isDirectory())walk(p);}
    };walk(location);if(!sameInode(fs.lstatSync(location),domain.identity)||dirs.some(d=>!sameInode(fs.lstatSync(d.path),d.birth)))refuse("Cgroup membership tree changed.");return result;
  }
  contains(pid:number,domain:UsageDomain):boolean{const s=fs.lstatSync(join(this.root,domain.path)),member=this.membership(pid);return s.isDirectory()&&sameInode(s,domain.identity)&&(member===domain.path||member.startsWith(domain.path+"/"));}
}

export interface ChildOptions {parentPid:number;parent:()=>number;hostBoot:()=>string;clock:()=>number;connect:(uri:string,id:string)=>OwnedNativeConnection;fence:(fd:number,parentPid:number)=>DeadlineFence;ownership:(binding:LibvirtLeaseBinding,spec:ExecutionSpec)=>boolean;fixture?:boolean}
/** Dedicated-child core. The caller supplies the Rust/C fatal timer and owns the polling loop.
 * No Python process, in-process timer substitute, or native library loading is used here.
 */
export function runSupervisorChild(folder:string,options:ChildOptions):{supervisor:LibvirtLeaseSupervisor;close():void}{
  if(!Number.isSafeInteger(options.parentPid)||options.parentPid<=1||options.parent()!==options.parentPid)refuse("Supervisor parent identity differs.");
  const journal=new SupervisorJournal(folder,undefined,{fixture:options.fixture===true});try{const spec=journal.readNamed("libvirt-binding.json") as ExecutionSpec|null;if(!spec)refuse("Supervisor binding is missing.");const b=new LibvirtLeaseBinding(spec.binding),launch=journal.readNamed("libvirt-launch.json");
    if(!matches(launch,b.identity())||launch.parentPid!==options.parentPid||canonical(journal.read())!==canonical({...b.identity(),phase:"prepared"})||!options.ownership(b,spec))refuse("Supervisor launch history or storage differs.");
    noSymlinks(spec.library.path);const fd=fs.openSync(spec.library.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let fence:DeadlineFence;
    try{const before=fs.fstatSync(fd);regular(before,false);if(before.size>8*1048576)refuse("Native artifact exceeds its envelope.");const data=Buffer.alloc(before.size);let size=0;while(size<data.length){const n=fs.readSync(fd,data,size,data.length-size,null);if(!n)break;size+=n;}const after=fs.fstatSync(fd);if(size!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.size!==after.size||hash(data)!==spec.library.sha256||options.parent()!==options.parentPid)refuse("Pinned native artifact changed.");fence=options.fence(fd,options.parentPid);}finally{fs.closeSync(fd);}
    const supervisor=new LibvirtLeaseSupervisor(b,journal,()=>journal.readNamed("libvirt-authorization.json"),()=>options.parent()===options.parentPid&&options.ownership(b,spec),options.hostBoot,()=>options.connect(spec.uri,b.machine_id),fence,options.clock);
    supervisor.start();return{supervisor,close(){try{supervisor.close();}finally{journal.close();}}};
  }catch(error){journal.close();throw error;}
}

export const HOST_RUNTIMES:Record<string,readonly string[]>={macos:["apple","android","ios"],linux:["libvirt","android"],windows:["hyperv"]};
export function enabledRuntimes(config:RecordValue):Record<string,RecordValue>{
  let runtimes=config.runtimes;if(Array.isArray(runtimes)){if(runtimes.some(n=>typeof n!=="string")||new Set(runtimes).size!==runtimes.length)refuse("Invalid runtime catalogue.");runtimes=Object.fromEntries(runtimes.map(n=>[n,{}]));}
  const r=object(runtimes),allowed=HOST_RUNTIMES[String(config.provider)];if(!allowed||!Object.keys(r).length)refuse("Physical host requires configured runtimes.");for(const[name,options]of Object.entries(r)){if(!allowed.includes(name))refuse("Runtime is incompatible with this host.");object(options);}return r as Record<string,RecordValue>;
}
export function runtimeFor(config:RecordValue,image:RecordValue):string{const runtimes=enabledRuntimes(config),name=image.runtime??(["android","ios"].includes(String(image.os))?image.os:Object.keys(runtimes).find(k=>["apple","libvirt","hyperv"].includes(k)));if(typeof name!=="string"||!Object.hasOwn(runtimes,name))refuse("Image runtime is not enabled.");const systems:Record<string,string[]>={apple:["linux","macos"],libvirt:["linux","windows"],hyperv:["linux","windows"],android:["android"],ios:["ios"]};if(!systems[name]?.includes(String(image.os)))refuse("Image OS is incompatible with its runtime.");return name;}
export class NativeProvider {readonly kind="native";constructor(readonly config:RecordValue,readonly state:string){}async check():Promise<unknown>{if(!["darwin","linux"].includes(process.platform))refuse("Embedded inference supports Mac and Linux hosts.");return{kind:this.kind};}async reconcile(_machine:RecordValue,_image:RecordValue,_folder:string):Promise<RecordValue>{return refuse("Native inference provider cannot run virtual machines.");}}
export interface MachineRuntime {state:string;check():Promise<unknown>}
export class MachineProvider {
  readonly kind:string;readonly runtimes:Record<string,MachineRuntime>={};
  constructor(readonly config:RecordValue,readonly state:string,factory:(config:RecordValue,state:string)=>MachineRuntime){this.kind=String(config.provider);const images=config.templates??[];if(!Array.isArray(images))refuse("Invalid templates.");for(const[name,settings]of Object.entries(enabledRuntimes(config))){const childState=absolute(settings.stateDirectory??join(state,"runtimes",name));fs.mkdirSync(childState,{recursive:true,mode:0o700});noSymlinks(childState);owned(fs.lstatSync(childState),true);this.runtimes[name]=factory({...settings,name:config.name,provider:name,capacity:config.capacity,templates:images.filter(i=>runtimeFor(config,object(i))===name),storage:settings.storage??join(absolute(config.storage),name)},childState);}}
  runtimeContext(machine:RecordValue,image:RecordValue):{runtime:MachineRuntime;image:RecordValue;folder:string}{const runtime=this.runtimes[runtimeFor(this.config,image)]!;return{runtime,image,folder:join(runtime.state,"machines",uuid(machine.id))};}
  async check():Promise<unknown>{if(({macos:"darwin",linux:"linux",windows:"win32"}as Record<string,string>)[this.kind]!==process.platform)refuse("Host operating system does not match runner.");for(const runtime of Object.values(this.runtimes))await runtime.check();return{kind:this.kind,runtimes:Object.keys(this.runtimes)};}
}
