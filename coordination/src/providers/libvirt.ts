import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import { kubernetesDeployment } from "../host-deployment.ts";
import { ServiceError, object } from "../errors.ts";
import { noLinks, present, syncDirectory } from "../runtime-process.ts";
import { LibvirtLeaseBinding, SupervisorJournal, absolute, bindDomainXML, canonical, domainEmulator, domainHasTPM, escapeXML, exact, fingerprint, finite, inode, matches, noSymlinks, owned, readPrivate, refuse, regular, sameInode, snapshotFile, uuid, validateDomainXML } from "./libvirt-ownership.ts";
import type { BindingData, Inode, RecordValue } from "./libvirt-ownership.ts";

const mountedSocketPrefix = "qemu+unix:///system?socket=";

function validSocketPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 107 && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) && normalize(value) === value;
}

export function localLibvirtUri(config: RecordValue): string {
  const uri = config.uri ?? "qemu:///system";
  if (config.socketPath !== undefined || config.deployment === "kubernetes") {
    const path = config.socketPath === undefined ? "/var/run/libvirt/libvirt-sock" : config.socketPath;
    if (uri !== "qemu:///system" || !validSocketPath(path)) refuse("Use a local system libvirt URI and a normalized absolute socketPath.");
    return mountedSocketPrefix + path;
  }
  if (uri !== "qemu:///system" && uri !== "qemu:///session") refuse("Use a local libvirt connection.");
  return uri;
}

function validSavedUri(value: unknown): boolean {
  return value === "qemu:///system" || value === "qemu:///session" ||
    typeof value === "string" && value.startsWith(mountedSocketPrefix) && validSocketPath(value.slice(mountedSocketPrefix.length));
}

export interface Invocation { input?:string; timeoutMs:number; maxOutputBytes:number }
export type ProcessRunner=(argv:readonly string[],options:Invocation)=>Promise<string>;
export const runProcess:ProcessRunner=(argv,options)=>new Promise((resolve,reject)=>{
    const child=execFile(argv[0]!,argv.slice(1),{timeout:options.timeoutMs,killSignal:"SIGKILL",maxBuffer:options.maxOutputBytes,encoding:"utf8",env:{...process.env,LC_ALL:"C",LANG:"C"}},(error,out)=>{
    if(error)reject(new ServiceError("Backend command failed or timed out; its outcome is unconfirmed.",409,{outcome:"unknown"}));else resolve(out.trim());
  });
  if(options.input!==undefined)child.stdin?.end(options.input);else child.stdin?.end();
});
export interface NativeSnapshot {uuid:string;xml:string;active:boolean;state:"shut off"|"paused"|"running";persistent:boolean;managedSave:number;snapshots:number;checkpoints:number;id?:number;threads?:number[]}
/** Read-only native observation for resource attribution. Implementations free temporary domain handles before returning. */
export interface NativeDriver {
  snapshot():NativeSnapshot;
  close():void;
}
export class OwnedNativeConnection {
  private closed=false;
  constructor(readonly driver:NativeDriver){}
  private invoke<T>(call:()=>T):T{try{return call();}catch{throw new ServiceError("Native libvirt reply is unconfirmed.",409,{outcome:"unknown"});}}
  snapshot():NativeSnapshot{if(this.closed)refuse("Native connection ended.");return this.invoke(()=>this.driver.snapshot());}
  close():void{if(this.closed)return;this.closed=true;this.invoke(()=>this.driver.close());}
}
export interface Journal {read():RecordValue|null;write(value:RecordValue):void}
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
/** Lease specs record executionMode "transient": the guardian creates the domain without a persistent definition. */
export interface ExecutionSpec extends RecordValue {version:1;binding:BindingData;uri:string;library:{path:string;sha256:string};storageIdentity:Inode;diskIdentity:Inode;storageAccess?:StorageAccess;executionMode?:"transient"}
/** VM storage shared with QEMU through one dedicated group; QEMU keeps its own account. */
export interface StorageAccess extends RecordValue {gid:number;label:string}
const accountName=/^(?:[a-z_][a-z0-9_.-]{0,31}|\+[0-9]{1,10})$/;
const VM_MODES={directory:0o2750,disk:0o660,media:0o640} as const;
function passwdUid(name:string):number|undefined{
  try{const line=snapshotFile("/etc/passwd",4*1048576).toString("utf8").split("\n").find(l=>l.split(":")[0]===name);const uid=Number(line?.split(":")[2]);return line&&Number.isSafeInteger(uid)?uid:undefined;}catch{return undefined;}
}
export function vmStorageAccess(config:RecordValue):StorageAccess{
  const gid=config.vmGroupId??10002,group=config.vmGroup??"canaveral-vm",user=config.qemuUser??"libvirt-qemu";
  if(!Number.isSafeInteger(gid)||(gid as number)<=0||(gid as number)>=2**31-1)refuse("vmGroupId must be a positive group ID.");
  if(typeof group!=="string"||!accountName.test(group)||group.startsWith("+")&&Number(group.slice(1))!==gid)refuse("vmGroup must name the group vmGroupId identifies.");
  if(typeof user!=="string"||!accountName.test(user)||user==="root"||user.startsWith("+")&&Number(user.slice(1))===0)refuse("qemuUser must name a dedicated QEMU account.");
  const uid=process.getuid?.();let daemon:string|undefined;try{daemon=userInfo().username;}catch{/* A container may have no account entry. */}
  if(user===daemon||(user.startsWith("+")?Number(user.slice(1)):passwdUid(user))===uid)refuse("QEMU must not share the daemon account.");
  return{gid:gid as number,label:`${user}:${group}`};
}
/** Exact owner, group and mode; nothing broader is accepted. */
export function vmEntry(s:fs.Stats,access:StorageAccess,kind:keyof typeof VM_MODES):void{
  if(s.uid!==process.getuid?.()||s.gid!==access.gid||(s.mode&0o7777)!==VM_MODES[kind]||(kind==="directory"?!s.isDirectory():!s.isFile()||s.nlink!==1))refuse("VM storage must be owned by the daemon and shared only with the QEMU group.");
}
/** Linux gives a new directory the setgid parent's group and setgid bit; the mode must not lose group search. */
function vmDirectory(path:string,access:StorageAccess):fs.Stats{
  const mask=process.umask(0o027);
  try{fs.mkdirSync(path,{mode:0o750});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}finally{process.umask(mask);}
  noSymlinks(path);let s=fs.lstatSync(path);
  // Only a group member can set setgid itself, such as on platforms without inheritance.
  if(s.isDirectory()&&s.uid===process.getuid?.()&&s.gid===access.gid&&(s.mode&0o7777)!==VM_MODES.directory&&process.getgroups?.().includes(access.gid)){fs.chmodSync(path,VM_MODES.directory);s=fs.lstatSync(path);}
  vmEntry(s,access,"directory");return s;
}
interface Execution {binding:LibvirtLeaseBinding;spec:ExecutionSpec;execution:RecordValue;launch:RecordValue|null}
export interface ProcessBirth {pid:number;createdAt:number;parentPid:number;uid:number;executable:string;argv:string[];zombie:boolean}
export type LeaseFence="stopped"|"busy"|"unconfirmed";
/** The native lease helper. Production binds the root-owned, SHA-256-pinned Rust helper (libvirt-native.ts). */
export interface LibvirtLeaseNative {
  readonly helper:{path:string;sha256:string};
  /** Starts the per-lease guardian after the caller persisted the attempt. It is never retried. */
  launch(folder:string,parentPid:number):{pid:number;createdAt:number};
  /** The exact command line of this folder's guardian for that daemon. */
  arguments(folder:string,parentPid:number):string[];
  birth(pid:number):ProcessBirth|"gone"|"unknown";
  /** Takes the guardian's lock, then destroys only a proven owned domain. Stopped needs a fresh VIR_ERR_NO_DOMAIN lookup. */
  fence(folder:string):Promise<LeaseFence>;
  /** Erases quarantined storage under the same lock after a fresh absence proof, holding write leases on every file. */
  erase(folder:string,quarantine:string):Promise<boolean>;
  close?():void;
}
export interface LibvirtAdapters {
  run?:ProcessRunner;platform?:NodeJS.Platform;arch?:string;fixture?:boolean;hostBoot?:()=>string;clock?:()=>number;
  /** Read-only native observation for resource attribution. */
  connect?:(uri:string,id:string)=>OwnedNativeConnection;
  lease?:LibvirtLeaseNative;
  kernel?:UsageKernel;process?:(pid:number)=>UsageProcess;
  seed?:(image:RecordValue,machine:RecordValue,storage:string)=>Promise<string|null>;
}
/** The natively qualified lease template: headless x64 Linux booted by BIOS, without TPM, secure boot or guest seed media. */
export function libvirtLeaseTemplate(image:RecordValue):boolean{
  return image.os==="linux"&&image.arch==="amd64"&&image.mode==="headless"&&image.firmware==="bios"&&!image.guestAccess&&!image.tpm&&!image.secureBoot&&!image.prepare;
}
/** A static DAC label without relabelling keeps QEMU on its own account and the daemon's files unchanged. */
export function withDACLabel(xml:string,label:string):string{
  if(!/<\/devices><\/domain>$/.test(xml))refuse("Domain XML cannot carry a QEMU account label.");
  return xml.replace(/<\/domain>$/,`<seclabel type="static" model="dac" relabel="no"><label>${escapeXML(label)}</label></seclabel></domain>`);
}
export function domainXML(machine:RecordValue,image:RecordValue,disk:string,leased=true):string{
  uuid(machine.id);const r=object(machine.resources);for(const key of ["cpu","memoryMiB","diskGiB"])if(!Number.isSafeInteger(r[key])||(r[key] as number)<=0)refuse("Invalid native resources.");
  if(!["linux","windows"].includes(String(image.os))||!["amd64","arm64"].includes(String(image.arch))||!["desktop","headless"].includes(String(image.mode)))refuse("Unsupported native template.");
  const e=escapeXML,win=image.os==="windows",storage=dirname(absolute(disk)),seed=image._seedISO,bios=image.firmware==="bios";
  if(image.firmware!==undefined&&!["bios","efi"].includes(String(image.firmware)))refuse("Unsupported template firmware.");
  if(bios&&(win||image.arch!=="amd64"||image.secureBoot||image.tpm))refuse("BIOS boot supports x64 Linux without secure boot or TPM.");
  return `<domain type="kvm"><name>cvm-${machine.id}</name><uuid>${machine.id}</uuid><memory unit="MiB">${r.memoryMiB}</memory><vcpu>${r.cpu}</vcpu>${bios?`<os><type arch="x86_64">hvm</type><boot dev="hd"/></os>`:`<os firmware="efi"><type arch="${image.arch==="arm64"?"aarch64":"x86_64"}">hvm</type><firmware><feature name="secure-boot" enabled="${(image.secureBoot??win)?"yes":"no"}"/></firmware><boot dev="hd"/>${leased?`<nvram>${e(join(storage,"nvram.fd"))}</nvram>`:""}</os>`}<features><acpi/>${win?'<smm state="on"/>':""}</features><cpu mode="host-passthrough"/><devices><disk type="file" device="disk"><driver name="qemu" type="qcow2"/><source file="${e(disk)}"/><target dev="${win?"sda":"vda"}" bus="${win?"sata":"virtio"}"/></disk>${seed?`<disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="${e(seed)}"/><target dev="${win?"sdb":"sda"}" bus="${win?"sata":"scsi"}"/><readonly/></disk>${win?"":'<controller type="scsi" model="virtio-scsi"/>'}`:""}<interface type="network"><source network="${e(image.network??"default")}"/><model type="${win?"e1000e":"virtio"}"/></interface><serial type="pty"><target port="0"/></serial><console type="pty"><target type="serial" port="0"/></console>${image.mode==="desktop"?'<graphics type="vnc" port="-1" autoport="yes" listen="127.0.0.1"><listen type="address" address="127.0.0.1"/></graphics>':""}<video><model type="${image.mode==="desktop"?(win?"vga":"virtio"):"none"}"/></video>${(image.tpm??win)?`<tpm model="tpm-crb"><backend type="emulator" version="2.0" persistent_state="yes"><source type="dir" path="${e(join(storage,"tpm-state"))}"/></backend></tpm>`:""}</devices></domain>`;
}

/** Native adapters are injected; there is intentionally no virsh fallback for leased execution. */
export class LibvirtProvider {
  readonly kind="libvirt";readonly adapters:LibvirtAdapters;readonly state:string;
  constructor(readonly config:RecordValue,state:string){this.state=absolute(state);this.adapters=(config.adapters??{}) as LibvirtAdapters;}
  private journal(folder:string,prefix?:string):SupervisorJournal{return new SupervisorJournal(folder,prefix,{fixture:this.adapters.fixture===true});}
  private boot():string{return (this.adapters.hostBoot??linuxBootId)();}
  private clock():number{if(!this.adapters.clock)refuse("Suspend-aware CLOCK_BOOTTIME binding is unavailable.");return this.adapters.clock();}
  private uri():string{return localLibvirtUri(this.config);}
  private async command(argv:readonly string[],timeoutMs=300000,input?:string):Promise<string>{try{return await(this.adapters.run??runProcess)(argv,{timeoutMs,maxOutputBytes:1048576,...(input===undefined?{}:{input})});}catch{throw new ServiceError("Backend command failed or timed out; its outcome is unconfirmed.",409,{outcome:"unknown"});}}
  private virsh(...args:string[]):Promise<string>{return this.command(["virsh","--connect",this.uri(),...args],30000);}
  private connection(spec:ExecutionSpec,b:LibvirtLeaseBinding):OwnedNativeConnection{if(!this.adapters.connect)refuse("Native libvirt connection binding is unavailable.");return this.adapters.connect(spec.uri,b.machine_id);}
  async check():Promise<unknown>{
    if((this.adapters.platform??process.platform)!=="linux")refuse("The libvirt provider runs on Linux hosts.");this.uri();const arch=this.adapters.arch??({x64:"amd64",arm64:"arm64"}[process.arch as "x64"|"arm64"]);
    const templates=this.config.templates??[];if(!Array.isArray(templates))refuse("Invalid native templates.");for(const value of templates){const image=object(value);if(!["linux","windows"].includes(String(image.os))||image.arch!==arch)refuse("Template is incompatible with this native host.");const path=absolute(image.image);noSymlinks(path);this.storageEntry(fs.lstatSync(path),"media");}
    if(this.config.storage!==undefined){const root=absolute(this.config.storage);noSymlinks(root);this.storageEntry(fs.lstatSync(root),"directory");}
    await this.virsh("domcapabilities","--virttype","kvm");await this.command(["qemu-img","--version"],30000);
    // The configured helper was verified (owner, mode, SHA-256 and kernel) before it was bound.
    const leaseHelper=this.adapters.lease!==undefined;
    return{kind:this.kind,leaseHelper,warnings:leaseHelper?[]:["Consumer VM leases need the pinned libvirt lease helper."]};
  }
  private storagePath(machine:RecordValue):string{return join(absolute(this.config.storage),uuid(machine.id));}
  /** The group and QEMU account label configured for this host. */
  access():StorageAccess{return vmStorageAccess(this.config);}
  private storageEntry(s:fs.Stats,kind:"directory"|"disk"|"media"):void{
    try{vmEntry(s,this.access(),kind);}catch(error){throw new ServiceError(error instanceof ServiceError?error.message:"VM storage access is invalid.",409,{code:"libvirt_vm_storage_access"});}
  }
  async maintenanceStorage(machine:RecordValue):Promise<"present"|"absent"|"unknown">{
    const path=this.storagePath(machine);noLinks(path);
    if(!present(path))return "absent";
    const directory=fs.lstatSync(path);owned(directory);if(!directory.isDirectory())return "unknown";
    // Storage prepared before QEMU group access stays private; it is never widened in place.
    const shared=directory.gid===this.access().gid&&(directory.mode&0o7777)===VM_MODES.directory;if(!shared)owned(directory,true);
    if(readPrivate(join(path,"canaveral-owner.json"))?.fingerprint!==fingerprint(machine))return "unknown";
    const disk=join(path,"disk.qcow2");noLinks(disk);if(!present(disk))return "absent";
    if(shared)vmEntry(fs.lstatSync(disk),this.access(),"disk");else regular(fs.lstatSync(disk),true);return "present";
  }
  private location(b:LibvirtLeaseBinding,s:ExecutionSpec):boolean{return s.uri===this.uri()&&b.disk===join(this.storagePath({id:b.machine_id}),"disk.qcow2")&&(s.storageAccess===undefined||canonical(s.storageAccess)===canonical(this.access()));}
  /** The QEMU account label bound at preparation; older preparations carry none. */
  private label(s:ExecutionSpec):string|undefined{return s.storageAccess?.label;}
  private readSpec(j:SupervisorJournal,machine:RecordValue,storage=true):{binding:LibvirtLeaseBinding;spec:ExecutionSpec}{
    const value=j.readNamed("libvirt-binding.json");if(!value||!exact(value,["version","binding","uri","library","storageIdentity","diskIdentity",...["storageAccess","executionMode"].filter(k=>Object.hasOwn(value,k))])||(Object.hasOwn(value,"executionMode")&&value.executionMode!=="transient")||value.version!==1||!validSavedUri(value.uri))refuse("Execution binding is missing or invalid.");
    const raw=object(value.binding);if(!exact(raw,["machine_id","lease_id","boot_id","host_boot_id","fingerprint","disk"]))refuse("Malformed execution binding.");const b=new LibvirtLeaseBinding(raw as unknown as BindingData);const spec=value as ExecutionSpec;
    for(const key of ["storageIdentity","diskIdentity"] as const){const id=object(value[key]);if(!exact(id,["device","inode"])||!Object.values(id).every(n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0))refuse("Invalid storage birth identity.");}
    if(Object.hasOwn(value,"storageAccess")){const a=object(value.storageAccess);if(!exact(a,["gid","label"])||!Number.isSafeInteger(a.gid)||(a.gid as number)<=0||typeof a.label!=="string"||!/^[^:<>&]{1,64}:[^:<>&]{1,64}$/.test(a.label))refuse("Invalid VM storage access binding.");}
    const library=object(value.library);if(!exact(library,["path","sha256"])||typeof library.sha256!=="string"||!/^[a-f0-9]{64}$/.test(library.sha256))refuse("Invalid native artifact binding.");absolute(library.path);
    const lease=machine.lease?object(machine.lease):null;const assignment=j.readNamed("assignment.json");
    if(b.machine_id!==machine.id||b.fingerprint!==fingerprint(machine)||(lease&&b.lease_id!==lease.id)||!assignment||assignment.fingerprint!==b.fingerprint||(lease&&assignment.leaseId!==b.lease_id)||(!lease&&(b.lease_id!==machine.id||assignment.leaseId!==undefined)))refuse("Binding belongs to another assignment.");
    if(storage)this.assertStorage(b,spec);return{binding:b,spec};
  }
  private assertStorage(b:LibvirtLeaseBinding,s:ExecutionSpec,root=dirname(b.disk)):void{
    noSymlinks(root);const directory=fs.lstatSync(root),access=s.storageAccess;if(access)vmEntry(directory,access,"directory");else owned(directory);if(!directory.isDirectory()||!sameInode(directory,s.storageIdentity)||basename(dirname(b.disk))!==b.machine_id)refuse("Owned storage changed.");
    const disk=fs.lstatSync(join(root,basename(b.disk)));if(access)vmEntry(disk,access,"disk");else regular(disk,false);if(!sameInode(disk,s.diskIdentity)||readPrivate(join(root,"canaveral-owner.json"))?.fingerprint!==b.fingerprint)refuse("Owned disk or marker changed.");
  }
  private inspect(machine:RecordValue,folder:string):Execution|null{
    const j=this.journal(folder,"libvirt-binding");try{if(!j.read())return null;const{binding,spec}=this.readSpec(j,machine);const execution=j.readNamed("libvirt-execution.json"),launch=j.readNamed("libvirt-launch.json");if(!matches(execution,binding.identity())||(launch&&!matches(launch,binding.identity())))refuse("Execution history is missing or foreign.");return{binding,spec,execution,launch};}finally{j.close();}
  }
  private authorization(image:RecordValue):()=>unknown{if(typeof image._leaseAuthorization!=="function")refuse("Leased execution requires its pinned local deadline.");return image._leaseAuthorization as ()=>unknown;}
  publish(machine:RecordValue,image:RecordValue,folder:string,stopping=false):RecordValue{
    const j=this.journal(folder,"libvirt-authorization");try{const{binding:b,spec:s}=this.readSpec(j,machine);return publishAuthorization(b,j,this.authorization(image),()=>{this.readSpec(j,machine);return true;},()=>this.boot(),()=>this.clock(),stopping||!this.location(b,s));}finally{j.close();}
  }
  private native():LibvirtLeaseNative{
    const native=this.adapters.lease;
    if(!native)throw new ServiceError("The libvirt lease helper is not configured.",409,{code:"libvirt_lease_helper_unverified"});
    return native;
  }
  /** The recorded guardian is alive with the same birth, parent, account, executable and command line. Observation never signals it. */
  private guardianAlive(b:LibvirtLeaseBinding,folder:string,launch:RecordValue|null):boolean{
    const native=this.adapters.lease;
    if(!native||!matches(launch,b.identity())||!Number.isSafeInteger(launch.pid)||(launch.pid as number)<=1||!finite(launch.createdAt)||!Number.isSafeInteger(launch.parentPid)||(launch.parentPid as number)<=1)return false;
    const p=native.birth(launch.pid as number);
    return typeof p==="object"&&p.pid===launch.pid&&p.createdAt===launch.createdAt&&p.parentPid===launch.parentPid&&p.uid===process.getuid?.()&&
      p.executable===native.helper.path&&!p.zombie&&canonical(p.argv)===canonical(native.arguments(folder,launch.parentPid as number));
  }
  /** Starts the one-use guardian. The attempt is durable before the spawn and is never replayed. */
  private launch(machine:RecordValue,folder:string):void{
    const native=this.native(),j=this.journal(folder,"libvirt-launch");
    try{
      const{binding:b,spec:s}=this.readSpec(j,machine);
      if(j.read()||canonical(j.readNamed("libvirt-execution.json"))!==canonical({...b.identity(),phase:"prepared"})||j.readNamed("libvirt-native-execution.json"))refuse("A lease guardian launch cannot be replayed.");
      if(canonical(s.library)!==canonical(native.helper))refuse("The pinned lease helper changed after preparation.");
      const record={...b.identity(),parentPid:process.pid,attemptedAt:Date.now()/1000};j.write(record);
      const child=native.launch(folder,process.pid);
      if(!Number.isSafeInteger(child.pid)||child.pid<=1||!finite(child.createdAt))refuse("The lease guardian birth is unknown.");
      // The guardian waits for this record before it acts.
      const next={...record,...child};j.write(next);
      if(!this.guardianAlive(b,folder,next))refuse("The lease guardian identity is unconfirmed.");
    }finally{j.close();}
  }
  private async prepare(machine:RecordValue,image:RecordValue,folder:string,leased:boolean):Promise<void>{
    const native=leased?this.native():undefined;
    if(leased&&(!this.adapters.clock||!libvirtLeaseTemplate(image)))refuse("A libvirt lease needs the boot clock and a headless x64 BIOS Linux template.");
    const library=native?native.helper:{path:"/unavailable-administrative-deadline",sha256:"0".repeat(64)};
    const assignment=fingerprint(machine),access=this.access();const j=this.journal(folder,"libvirt-binding");try{
      if(j.read()||["libvirt-execution.json","libvirt-launch.json","libvirt-authorization.json"].some(n=>j.readNamed(n)!==null))refuse("Preparation cannot adopt prior or partial history.");
      const a=j.readNamed("assignment.json"),lease=leased?object(machine.lease):null;if(a?.fingerprint!==assignment||(lease&&a.leaseId!==lease.id))refuse("Preparation cannot adopt another assignment.");
      if((await this.virsh("list","--all","--name")).split(/\r?\n/).includes(`cvm-${machine.id}`)||(await this.virsh("list","--all","--uuid")).toLowerCase().split(/\r?\n/).includes(String(machine.id)))refuse("Cannot adopt an existing domain.");
      const root=absolute(this.config.storage);noSymlinks(root);this.storageEntry(fs.lstatSync(root),"directory");const path=this.storagePath(machine);
      // QEMU reads VM storage through its group; daemon state and the owner marker stay private.
      const st=vmDirectory(path,access);const owner=join(path,"canaveral-owner.json");
      const prior=readPrivate(owner);if(prior){if(prior.fingerprint!==assignment)refuse("Storage belongs to another assignment.");}else{if(fs.readdirSync(path).length)refuse("Unmarked storage cannot be adopted.");const fd=fs.openSync(owner,"wx",0o600);try{fs.writeFileSync(fd,canonical({fingerprint:assignment}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      if(fs.readdirSync(path).some(n=>n!=="canaveral-owner.json"))refuse("Partial native preparation cannot be replayed.");
      const base=absolute(image.image);noSymlinks(base);this.storageEntry(fs.lstatSync(base),"media");let seed:string|null=null;
      if(image.guestAccess&&!this.adapters.seed)refuse("Guest seed construction is not bound.");if(this.adapters.seed)seed=await this.adapters.seed(image,machine,path);
      if(seed&&(dirname(absolute(seed))!==path||!fs.lstatSync(seed).isFile()||fs.lstatSync(seed).isSymbolicLink()))refuse("Seed media is not owned.");
      if(seed){fs.chmodSync(seed,VM_MODES.media);vmEntry(fs.lstatSync(seed),access,"media");}
      const info=object(JSON.parse(await this.command(["qemu-img","info","--output=json",base])));const resources=object(machine.resources);
      if(!Number.isSafeInteger(info["virtual-size"])||(info["virtual-size"] as number)<0||(info["virtual-size"] as number)>(resources.diskGiB as number)*1073741824||!["raw","qcow2"].includes(String(info.format))||info["backing-filename"])refuse("Base disk must be standalone and fit the assignment.");
      // Persist intent before qemu-img: a lost creation acknowledgement cannot repeat provisioning.
      const disk=join(path,"disk.qcow2"),b=new LibvirtLeaseBinding({machine_id:uuid(machine.id),lease_id:leased?uuid(object(machine.lease).id):uuid(machine.id),boot_id:randomUUID(),host_boot_id:this.boot(),fingerprint:assignment,disk});
      const execution=this.journal(folder);try{execution.write({...b.identity(),phase:"preparing"});}finally{execution.close();}
      const output=fs.openSync(disk,"wx",0o600),birth=inode(fs.fstatSync(output));
      try {
        // The disk takes the directory's group; only that group gains read and write.
        fs.fchmodSync(output,VM_MODES.disk);vmEntry(fs.fstatSync(output),access,"disk");
        // Child access names this retained descriptor, not a swappable output path.
        const destination=process.platform==="linux"?`/proc/${process.pid}/fd/${output}`:disk;
        await this.command(["qemu-img","create","-f","qcow2","-F",String(info.format),"-b",base,destination,`${resources.diskGiB}G`]);
        if(!sameInode(fs.lstatSync(disk),birth))refuse("Prepared disk was replaced during creation.");fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      vmEntry(fs.lstatSync(disk),access,"disk");const spec:ExecutionSpec={version:1,binding:{...b},uri:this.uri(),library:{path:library.path as string,sha256:library.sha256 as string},storageIdentity:inode(st),diskIdentity:inode(fs.lstatSync(disk)),storageAccess:access,...(leased?{executionMode:"transient" as const}:{})};this.assertStorage(b,spec);j.write(spec);
      const xml=bindDomainXML(withDACLabel(domainXML(machine,{...image,...(seed?{_seedISO:seed}:{})},disk,!leased),access.label),b);
      if(leased){
        // Only the guardian creates the transient domain, from these bytes; nothing is defined.
        const record=this.journal(folder,"libvirt-native-spec");try{record.write({version:1,uri:spec.uri,identity:b.identity(),cluster:kubernetesDeployment(this.config),xml});}finally{record.close();}
      }else{const fd=fs.openSync(join(path,"domain.xml"),"wx",0o600);try{fs.writeFileSync(fd,xml);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      const dir=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      const receipt=this.journal(folder);try{receipt.write({...b.identity(),phase:"prepared"});}finally{receipt.close();}
      this.assertStorage(b,spec);validateDomainXML(xml,b,access.label);
      if(!leased)await this.definePrepared(j,b,spec);
    }finally{j.close();}
  }
  private async definePrepared(j:SupervisorJournal,b:LibvirtLeaseBinding,s:ExecutionSpec):Promise<void>{
    if (!this.location(b,s)) refuse("The prepared domain namespace changed.");
    this.assertStorage(b,s);
    const source=join(dirname(b.disk),"domain.xml");
    const bytes=snapshotFile(source,1048576);validateDomainXML(bytes.toString("utf8"),b,this.label(s));
    // Node uses a Unix socket for child stdin on Linux. virsh needs a reopenable file.
    const path=join(j.folder,`temporary-${randomUUID()}.xml`);
    const fd=fs.openSync(path,"wx",0o600);
    try {
      fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
      await this.virsh("define",path);
    }finally{fs.closeSync(fd);fs.unlinkSync(path);}
  }
  async reconcile(machine:RecordValue,image:RecordValue,folder:string):Promise<RecordValue>{
    uuid(machine.id);if(!["running","stopped"].includes(String(machine.desired)))refuse("Invalid desired state.");domainXML(machine,image,join(this.storagePath(machine),"disk.qcow2"));
    const gate=this.journal(folder,"libvirt-reconcile");try{
      const leased=!!machine.lease;let current=this.inspect(machine,folder);
      // A lease without a binding never launched a guardian, the only creator of its domain.
      if(!current){if(machine.desired==="stopped")return leased?this.leaseReport(true):{state:"unknown",detail:"No execution history; native resources were not adopted."};
        if(leased){const value=this.authorization(image)();if(!validAuthorization(value,uuid(object(machine.lease).id))||value.fenced===true||(value.remainingSeconds as number)<=0)refuse("Execution was fenced before preparation.");}
        await this.prepare(machine,image,folder,leased);current=this.inspect(machine,folder);if(!current)refuse("Preparation outcome is unknown.");
      }
      if(leased)return await this.reconcileLease(machine,image,folder,current);
      const{binding:b,spec:s,execution}=current;if(!this.location(b,s))return{state:"unknown",detail:"Runtime location changed; no native namespace was adopted."};
      if(!leased&&machine.desired==="running"&&execution.phase==="prepared"){
        const ids=(await this.virsh("list","--all","--uuid")).toLowerCase().split(/\r?\n/);
        if(!ids.includes(b.machine_id)){
          if((await this.virsh("list","--all","--name")).split(/\r?\n/).includes(`cvm-${b.machine_id}`))refuse("The prepared domain name is occupied.");
          await this.definePrepared(gate,b,s);
        }
      }
      const id=uuid(machine.id);const xml=await this.virsh("dumpxml",id);validateDomainXML(xml,b,this.label(s));if((await this.virsh("domuuid",id)).toLowerCase()!==id)refuse("Native UUID differs.");this.assertStorage(b,s);
      const state=(await this.virsh("domstate",id)).toLowerCase();
      if(machine.desired==="stopped"){if(state==="shut off")return{state:"stopped"};await this.adminAction(machine,folder,b,s,"shutdown");return{state:"stopping",detail:"Graceful shutdown requested; storage retained."};}
      if(state==="shut off"){await this.adminAction(machine,folder,b,s,"start");return{state:"starting"};}return{state:state==="running"?"running":"unknown"};
    }finally{gate.close();}
  }
  async updateStopped(machine: RecordValue, _image: RecordValue, folder: string, readOnly = false): Promise<boolean> {
    if (machine.lease) return this.leaseStopped(machine, folder);
    if (machine.desired !== "stopped" || !kubernetesDeployment(this.config)) return false;
    let journal: SupervisorJournal | undefined;
    try {
      journal = new SupervisorJournal(folder, "libvirt-reconcile", { fixture: this.adapters.fixture === true, existingOnly: readOnly });
      const { binding, spec } = this.readSpec(journal, machine);
      if (!this.location(binding, spec)) return false;
      if (await this.virsh("domuuid", binding.machine_id) !== binding.machine_id) return false;
      validateDomainXML(await this.virsh("dumpxml", binding.machine_id), binding, this.label(spec));
      if (await this.virsh("domstate", binding.machine_id) !== "shut off") return false;
      return this.location(binding, spec) && canonical(this.readSpec(journal, machine).spec) === canonical(spec);
    } catch { return false; }
    finally { journal?.close(); }
  }
  private async adminAction(machine:RecordValue,folder:string,b:LibvirtLeaseBinding,s:ExecutionSpec,action:"start"|"shutdown"):Promise<void>{
    const j=this.journal(folder);try{const old=j.read();if(old?.phase===`${action}-pending`)refuse("Uncertain native action is not replayed.");
      const validate=async()=>{this.readSpec(j,machine);if(!this.location(b,s)||(await this.virsh("domuuid",b.machine_id)).toLowerCase()!==b.machine_id)refuse("Administrative native owner changed.");validateDomainXML(await this.virsh("dumpxml",b.machine_id),b,this.label(s));this.assertStorage(b,s);};
      await validate();j.write({...b.identity(),phase:`${action}-pending`});await validate();await this.virsh(action,b.machine_id);j.write({...b.identity(),phase:`${action}-requested`});
    }finally{j.close();}
  }
  private terminal(machine:RecordValue):string{const l=object(machine.lease),intent=object(machine.leaseCleanup);if(machine.desired!=="stopped"||!["released","expired","failed"].includes(String(l.state))||intent.leaseId!==l.id)refuse("Cleanup requires a terminal stopped lease and exact intent.");return uuid(intent.id);}
  // Transient lease execution. The guardian creates the domain with PAUSED|AUTODESTROY on its own
  // connection; there is never a persistent definition to resurrect. Stopped means that no
  // guardian was ever started, or that the guardian's lock was taken and a fresh connection
  // returned VIR_ERR_NO_DOMAIN for the per-launch UUID. Everything else keeps the reservation.
  private nativeReceipt(folder:string,b:LibvirtLeaseBinding):RecordValue|null{
    noSymlinks(folder);const receipt=readPrivate(join(folder,"libvirt-native-execution.json"));
    if(receipt&&canonical(receipt.identity)!==canonical(b.identity()))refuse("The lease guardian receipt belongs to another launch.");
    return receipt;
  }
  private readonly fences=new Map<string,Promise<LeaseFence>>();
  /** One proof-gated fence per lease at a time. A failed call is unconfirmed, never stopped. */
  private nativeFence(folder:string):Promise<LeaseFence>{
    const running=this.fences.get(folder);if(running)return running;
    const fence=Promise.resolve().then(()=>this.native().fence(folder)).catch(():LeaseFence=>"unconfirmed").finally(()=>this.fences.delete(folder));
    this.fences.set(folder,fence);return fence;
  }
  private async stopLease(machine:RecordValue,image:RecordValue,folder:string,current:Execution|null):Promise<boolean>{
    // Without a binding the preparation never reached a launch, which requires one.
    if(!current)return true;
    const{binding:b,spec:s}=current;
    // No adapter can prove a persistent-definition lease stopped; it stays unknown.
    if(s.executionMode!=="transient")return false;
    // A published fence stops a live guardian on its own; it also enforces its last deadline.
    if(this.boot()===b.host_boot_id){try{this.publish(machine,image,folder,true);}catch{/* The last published deadline still holds. */}}
    const j=this.journal(folder);
    try{
      const execution=j.read();if(!matches(execution,b.identity()))refuse("Lease execution history is foreign.");
      if(!j.readNamed("libvirt-launch.json")){
        // Retiring the preparation prevents any later launch.
        if(execution.phase!=="fenced")j.write({...b.identity(),phase:"fenced",stopEvidence:"never-launched"});
        return true;
      }
    }finally{j.close();}
    if(this.nativeReceipt(folder,b)?.phase==="stopped")return true;
    return await this.nativeFence(folder)==="stopped";
  }
  private leaseReport(stopped:boolean):RecordValue{
    return stopped?{state:"stopped",leaseFenced:true}:{state:"stopping",leaseFenced:true,detail:"The lease fence is not proven yet; its reservation is retained."};
  }
  /** Running needs the recorded guardian alive, its receipt running and the owned domain observed running. */
  private async reconcileLease(machine:RecordValue,image:RecordValue,folder:string,current:Execution):Promise<RecordValue>{
    const{binding:b,spec:s,execution,launch}=current;
    let fenced=machine.desired==="stopped"||execution.phase==="fenced"||!this.location(b,s)||s.executionMode!=="transient"||this.boot()!==b.host_boot_id;
    if(!fenced){try{fenced=this.publish(machine,image,folder).fenced===true;}catch{fenced=true;}}
    if(fenced)return this.leaseReport(await this.stopLease(machine,image,folder,current));
    const receipt=this.nativeReceipt(folder,b);
    if(!launch){
      if(execution.phase!=="prepared"||receipt)refuse("A lease guardian needs an unused preparation.");
      this.launch(machine,folder);return{state:"starting"};
    }
    if(this.guardianAlive(b,folder,launch)){
      if(receipt===null||["creating","paused"].includes(String(receipt.phase)))return{state:"starting"};
      if(receipt.phase==="running"){
        const observed=await this.observeLease(b,s);
        if(observed==="running")return{state:"running"};
        if(observed==="unknown")return{state:"unknown",detail:"The leased domain could not be observed; its guardian keeps enforcing the lease."};
      }
    }
    // The guardian or its domain ended: this one-use launch is over.
    return this.leaseReport(await this.stopLease(machine,image,folder,current));
  }
  private async observeLease(b:LibvirtLeaseBinding,s:ExecutionSpec):Promise<"running"|"ended"|"unknown">{
    let xml:string,state:string;
    try{xml=await this.virsh("dumpxml",b.machine_id);state=(await this.virsh("domstate",b.machine_id)).toLowerCase();}catch{return "unknown";}
    try{validateDomainXML(xml,b,this.label(s));this.assertStorage(b,s);}catch{return "ended";}
    return state==="running"?"running":"ended";
  }
  async refreshExecution(machine:RecordValue,image:RecordValue,folder:string,authorization?:()=>unknown):Promise<RecordValue|null>{
    // The cleanup pipeline owns a lease once its cleanup intent exists.
    if(machine.leaseCleanup)return null;
    const current=this.inspect(machine,folder);if(!current)return null;
    const local=authorization?{...image,_leaseAuthorization:authorization}:image,{binding:b,spec:s,execution,launch}=current;
    let fenced=machine.desired==="stopped"||execution.phase==="fenced"||!this.location(b,s)||s.executionMode!=="transient"||this.boot()!==b.host_boot_id||(launch!==null&&!this.guardianAlive(b,folder,launch));
    if(!fenced){try{fenced=this.publish(machine,local,folder).fenced===true;}catch{fenced=true;}}
    if(!fenced)return null;
    return this.leaseReport(await this.stopLease(machine,local,folder,current));
  }
  async stopForCleanup(machine:RecordValue,image:RecordValue,folder:string):Promise<RecordValue>{
    this.terminal(machine);
    return this.leaseReport(await this.stopLease(machine,image,folder,this.inspect(machine,folder)));
  }
  /** Lock-free stop evidence for idle checks: a durable stopped receipt, or a stopped lease that never launched. */
  private leaseStopped(machine:RecordValue,folder:string):boolean{
    try{
      noSymlinks(folder);const read=(name:string)=>readPrivate(join(folder,name));
      const spec=read("libvirt-binding.json") as ExecutionSpec|null;if(!spec)return machine.desired==="stopped";
      const b=new LibvirtLeaseBinding(spec.binding);if(b.machine_id!==machine.id||b.fingerprint!==fingerprint(machine))return false;
      if(!read("libvirt-launch.json"))return machine.desired==="stopped";
      const receipt=read("libvirt-native-execution.json");
      return receipt?.phase==="stopped"&&canonical(receipt.identity)===canonical(b.identity());
    }catch{return false;}
  }
  async removeOwnedStorage(machine:RecordValue,_image:RecordValue,folder:string,requestId:string):Promise<RecordValue>{
    if(this.terminal(machine)!==uuid(requestId))refuse("Removal cleanup intent differs.");
    const id=uuid(machine.id),root=this.storagePath(machine),parent=dirname(root),quarantine=join(parent,`.removing-${id}-${requestId}`);
    const exists=(path:string)=>{noLinks(path);return present(path);};
    const deletion=this.journal(folder,"deletion");
    try{
      if(!deletion.readNamed("libvirt-binding.json"))return this.removeUnprepared(machine,deletion,requestId,root,quarantine);
      const native=this.native(),{binding:b,spec:s}=this.readSpec(deletion,machine,false),expected={...b.identity(),id:requestId};
      let proof=deletion.read();
      if(proof&&!matches(proof,expected))refuse("The removal receipt belongs to another cleanup.");
      if(proof?.state==="complete"){if(exists(root)||exists(quarantine))refuse("Storage reappeared after removal.");return proof;}
      if(s.executionMode!=="transient"||!s.storageAccess)refuse("Removal needs a transient lease execution.");
      // Positive stop first: a launch that never happened, or the guardian's durable stopped receipt.
      if(deletion.readNamed("libvirt-launch.json")&&this.nativeReceipt(folder,b)?.phase!=="stopped")throw new ServiceError("Native stop of the lease is not proven.",409,{code:"execution_pending"});
      const intent={cleanupId:requestId,root,quarantine,fingerprint:b.fingerprint,storageIdentity:s.storageIdentity,diskIdentity:s.diskIdentity,storageGid:s.storageAccess.gid};
      const intents=this.journal(folder,"libvirt-native-removal");
      try{const old=intents.read();if(old&&canonical(old)!==canonical(intent))refuse("The native removal intent belongs to another cleanup.");if(!old)intents.write(intent);}finally{intents.close();}
      if(!proof){proof={...expected,state:"planned"};deletion.write(proof);}
      if(exists(root)){
        if(exists(quarantine))refuse("Storage occupies both owned paths.");
        this.assertStorage(b,s);fs.renameSync(root,quarantine);syncDirectory(parent);
      }
      if(exists(quarantine)){
        // An interrupted erasure leaves its own receipt; the helper resumes it.
        if(!deletion.readNamed("libvirt-native-erased.json"))this.assertStorage(b,s,quarantine);
        if(!await native.erase(folder,quarantine))refuse("Erasure of the quarantined lease storage is unconfirmed.");
      }
      const erased=deletion.readNamed("libvirt-native-erased.json");
      if(erased?.phase!=="removed"||erased.cleanupId!==requestId||exists(root)||exists(quarantine))refuse("Lease storage removal is unconfirmed.");
      proof={...expected,state:"complete",executionStopped:true,storageRemoved:true};deletion.write(proof);return proof;
    }finally{deletion.close();}
  }
  /** Storage of a preparation that never recorded its binding. A launch needs that binding, so no QEMU ever opened it. */
  private removeUnprepared(machine:RecordValue,deletion:SupervisorJournal,requestId:string,root:string,quarantine:string):RecordValue{
    const expected={machineId:uuid(machine.id),id:requestId},prior=deletion.read();
    if(prior&&!matches(prior,expected))refuse("The removal receipt belongs to another cleanup.");
    noLinks(quarantine);if(present(quarantine))refuse("Unexplained storage quarantine.");
    noLinks(root);
    if(present(root)){
      const directory=fs.lstatSync(root);if(!directory.isDirectory()||directory.uid!==process.getuid?.())refuse("Unprepared storage ownership differs.");
      if(readPrivate(join(root,"canaveral-owner.json"))?.fingerprint!==fingerprint(machine))refuse("Unprepared storage belongs to another assignment.");
      const names=fs.readdirSync(root);if(names.some(n=>!["canaveral-owner.json","disk.qcow2"].includes(n)))refuse("Unprepared storage holds unexpected entries.");
      for(const name of names){const path=join(root,name),entry=fs.lstatSync(path);if(!entry.isFile()||entry.nlink!==1||entry.uid!==process.getuid?.())refuse("Unprepared storage holds a foreign file.");fs.unlinkSync(path);}
      fs.rmdirSync(root);syncDirectory(dirname(root));
    }
    const result={...expected,state:"complete",executionStopped:true,storageRemoved:true,evidence:"never-launched"};deletion.write(result);return result;
  }
  close():void{this.adapters.lease?.close?.();}
  /** Read-only observation; never starts a replacement observer or signals a recovered PID. */
  resourceProcesses(machine:RecordValue,_image:RecordValue,folder:string):BoundUsageProcess[]{
    if(!this.adapters.connect)refuse("Native resource attribution is unavailable.");
    // Do not acquire/create runtime locks for accounting.
    const read=(name:string)=>readPrivate(join(folder,name));noSymlinks(folder);const spec=read("libvirt-binding.json") as ExecutionSpec|null;if(!spec)refuse("Resource binding is missing.");const b=new LibvirtLeaseBinding(spec.binding);const assignment=read("assignment.json"),marker=readPrivate(join(dirname(b.disk),"canaveral-owner.json"));
    if(b.machine_id!==machine.id||b.fingerprint!==fingerprint(machine)||assignment?.fingerprint!==b.fingerprint||marker?.fingerprint!==b.fingerprint||!this.location(b,spec))refuse("Resource assignment ownership differs.");this.assertStorage(b,spec);const boot=uuid(this.boot());
    if(machine.lease&&(b.host_boot_id!==boot||object(machine.lease).id!==b.lease_id||assignment.leaseId!==b.lease_id))refuse("Resource lease boot differs.");
    const connection=this.connection(spec,b);try{const s=connection.snapshot();if(s.uuid!==b.machine_id)refuse("Resource native UUID differs.");validateDomainXML(s.xml,b,this.label(spec));let result:BoundUsageProcess[]=[];
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
