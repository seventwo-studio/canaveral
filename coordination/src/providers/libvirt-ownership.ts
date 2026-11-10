import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ServiceError, object } from "../errors.ts";

export type RecordValue = Record<string, unknown>;
export const NAMESPACE = "urn:canaveral:libvirt:lease:1";
export function refuse(message: string): never { throw new ServiceError(message, 409); }
export function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) refuse("Canonical ownership UUID required.");
  return value;
}
function ascii(value: string): string { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`); }
/** Python sort_keys/ensure_ascii/default-separator digest, preserving existing receipts. */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return ascii(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(", ")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${ascii(k)}: ${canonical((value as RecordValue)[k])}`).join(", ")}}`;
  return refuse("Ownership record contains a non-JSON value.");
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function hash(data: Uint8Array | string): string { return createHash("sha256").update(data).digest("hex"); }
export function fingerprint(machine: RecordValue): string { return digest({ id: machine.id, template: machine.template, resources: machine.resources }); }
export function matches(value: unknown, expected: RecordValue): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(expected).every(([k,v]) => Object.hasOwn(value,k) && typeof (value as RecordValue)[k] === typeof v && canonical((value as RecordValue)[k]) === canonical(v));
}
export function exact(value: RecordValue, keys: string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
export function absolute(path: unknown): string {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || normalize(path) !== path || path.split("/").includes("..")) refuse("An absolute canonical owned path is required.");
  return path;
}
export function noSymlinks(path: string): void {
  absolute(path); let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) { current = join(current, part); if (fs.lstatSync(current).isSymbolicLink()) refuse("Symbolic-link ownership is refused."); }
}
export interface Inode { device: number; inode: number }
export function inode(s: fs.Stats): Inode { return { device: s.dev, inode: s.ino }; }
export function sameInode(s: fs.Stats, expected: Inode): boolean { return s.dev === expected.device && s.ino === expected.inode; }
export function owned(s: fs.Stats, privateMode = false): void {
  if (s.uid !== process.getuid?.() || (s.mode & (privateMode ? 0o077 : 0o022))) refuse("Owned file permissions are unsafe.");
}
export function regular(s: fs.Stats, privateMode = true): void { owned(s, privateMode); if (!s.isFile() || s.nlink !== 1) refuse("A regular file without linked aliases is required."); }
function stamp(s: fs.Stats): string { return [s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(":"); }
/** Open each ancestor relative to its retained descriptor on Linux. */
export function openDirectory(path:string):number {
  absolute(path);
  if(process.platform!=="linux") { noSymlinks(path); return fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW); }
  let fd=fs.openSync("/",fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try {
    for(const part of path.split("/").filter(Boolean)) {
      const next=fs.openSync(`/proc/self/fd/${fd}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd=next;
    }
    return fd;
  } catch(error) { fs.closeSync(fd); throw error; }
}
export function readPrivate(path: string, limit = 16384): RecordValue | null {
  try { return object(JSON.parse(snapshotFile(path, limit, true).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function snapshotFile(path: string, limit: number, privateMode = false): Buffer {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd); regular(before, privateMode); if (before.size > limit) refuse("Owned file exceeds its envelope.");
    const data = Buffer.alloc(before.size + 1); let size = 0;
    while (size < data.length) { const n = fs.readSync(fd, data, size, data.length-size, null); if (!n) break; size += n; }
    if (size !== before.size || stamp(before) !== stamp(fs.fstatSync(fd))) refuse("Owned file changed during inspection.");
    return data.subarray(0,size);
  } finally { fs.closeSync(fd); }
}
export interface BindingData { machine_id: string; lease_id: string; boot_id: string; host_boot_id: string; fingerprint: string; disk: string }
export class LibvirtLeaseBinding implements BindingData {
  readonly machine_id: string; readonly lease_id: string; readonly boot_id: string; readonly host_boot_id: string; readonly fingerprint: string; readonly disk: string;
  constructor(value: BindingData) {
    this.machine_id=uuid(value.machine_id); this.lease_id=uuid(value.lease_id); this.boot_id=uuid(value.boot_id); this.host_boot_id=uuid(value.host_boot_id);
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint)) refuse("Invalid assignment fingerprint."); this.fingerprint=value.fingerprint; this.disk=absolute(value.disk); Object.freeze(this);
  }
  identity(): RecordValue { return {version:1,machineId:this.machine_id,leaseId:this.lease_id,bootId:this.boot_id,hostBootId:this.host_boot_id,fingerprint:this.fingerprint,diskBinding:digest(this.disk)}; }
  metadata(): Record<string,string> { return Object.fromEntries(Object.entries(this.identity()).map(([k,v])=>[k,String(v)])); }
}

interface Element { name: string; uri: string; attrs: Record<string,string>; children: Element[]; text: string }
function decode(text: string): string {
  if (/&(?![^;&\s]+;)/.test(text)) refuse("Malformed XML entity.");
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    const known: Record<string,string> = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}; if (known[entity]) return known[entity];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) return refuse("Unsupported XML entity.");
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return refuse("Invalid XML character."); return String.fromCodePoint(code);
  });
}
/** Small, bounded namespace-aware parser. DTDs and external entities are never accepted. */
function xmlTree(xml: string): Element {
  if (typeof xml !== "string" || Buffer.byteLength(xml)>1048576 || /<!|\u0000/.test(xml)) refuse("Unsupported domain XML envelope.");
  xml=xml.replace(/^\s*<\?xml[^?]*\?>/,"");
  const stack: {node:Element; ns:Record<string,string>; raw:string}[]=[]; let root: Element | undefined; let pos=0; let count=0;
  const token=/<[^>]*>|[^<]+/g;
  for (const match of xml.matchAll(token)) {
    if (match.index!==pos || ++count>50000) refuse("Malformed domain XML."); pos+=match[0].length; const t=match[0];
    if (!t.startsWith("<")) { if (stack.length) stack.at(-1)!.node.text+=decode(t); else if(t.trim()) refuse("XML text outside domain."); continue; }
    if(t.startsWith("</")) { const top=stack.pop(); if (!top || t!==`</${top.raw}>`) refuse("Unbalanced domain XML."); continue; }
    const opening=/^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(t); if(!opening) refuse("Malformed XML element.");
    const raw=opening[1]!; let rest=opening[2]!; const ns={...(stack.at(-1)?.ns ?? {})}; const attrs: Record<string,string>={};
    while(rest.trim()) {
      const a=/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest); if(!a) refuse("Malformed XML attribute.");
      const key=a[1]!; if(Object.hasOwn(attrs,key)) refuse("Duplicate XML attribute."); attrs[key]=decode(a[2]??a[3]!); rest=rest.slice(a[0].length);
    }
    for(const [key,val] of Object.entries(attrs)) if(key==="xmlns"||key.startsWith("xmlns:")) { ns[key==="xmlns"?"":key.slice(6)]=val; delete attrs[key]; }
    const parts=raw.split(":"); if(parts.length>2 || (parts.length===2&&!ns[parts[0]!])) refuse("Unbound XML namespace.");
    const node: Element={name:parts.at(-1)!,uri:ns[parts.length===2?parts[0]!:""]??"",attrs,children:[],text:""};
    if(stack.length) stack.at(-1)!.node.children.push(node); else { if(root) refuse("Multiple domain roots."); root=node; }
    if(!opening[3]) stack.push({node,ns,raw}); if(stack.length>64) refuse("Domain XML is too deep.");
  }
  if(pos!==xml.length || stack.length || !root || root.name!=="domain" || root.uri) refuse("Malformed domain XML."); return root;
}
const nodes=(node:Element,name:string):Element[]=>node.children.filter(n=>n.name===name&&!n.uri);
function one(node:Element,name:string):Element { const values=nodes(node,name); if(values.length!==1) refuse(`Domain requires one ${name}.`); return values[0]!; }
function textOf(node:Element,name:string):string { const n=one(node,name); if(n.children.length) refuse("Unexpected XML content."); return n.text.trim(); }
const attrsEqual=(node:Element,expected:Record<string,string>):boolean=>canonical(node.attrs)===canonical(expected);
export function escapeXML(value: unknown): string { return String(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!)); }
export function bindDomainXML(xml: string, binding: LibvirtLeaseBinding): string {
  const root=xmlTree(xml); if(textOf(root,"uuid")!==binding.machine_id) refuse("Domain UUID differs.");
  const metadata=nodes(root,"metadata"); if(metadata.length || /<metadata\b/.test(xml)) refuse("Domain metadata cannot be rebound.");
  const owner=`<metadata><cv:owner xmlns:cv="${NAMESPACE}" ${Object.entries(binding.metadata()).map(([k,v])=>`${k}="${escapeXML(v)}"`).join(" ")}/></metadata>`;
  const result=xml.replace(/<\/domain>\s*$/,`${owner}</domain>`); validateDomainXML(result,binding); return result;
}
export function validateDomainXML(xml: string,binding:LibvirtLeaseBinding): void {
  const root=xmlTree(xml);
  if(textOf(root,"uuid")!==binding.machine_id||textOf(root,"name")!==`cvm-${binding.machine_id}`) refuse("Native UUID or name differs.");
  const owners=one(root,"metadata").children.filter(n=>n.name==="owner"&&n.uri===NAMESPACE);
  if(owners.length!==1 || !attrsEqual(owners[0]!,binding.metadata()) || owners[0]!.children.length) refuse("Native ownership metadata differs.");
  const devices=one(root,"devices");
  if(root.children.some(n=>n.uri)||devices.children.some(n=>n.uri)) refuse("Namespaced native extensions are not owned.");
  if(nodes(devices,"filesystem").length||nodes(devices,"hostdev").length) refuse("Passthrough ownership is unsupported.");
  const disks=nodes(devices,"disk"), primary=disks.filter(d=>d.attrs.device==="disk");
  if(primary.length!==1||primary[0]!.attrs.type!=="file"||nodes(primary[0]!,"readonly").length||!attrsEqual(one(primary[0]!,"source"),{file:binding.disk})) refuse("Native writable disk is not owned.");
  for(const disk of disks) if(disk!==primary[0]) {
    const source=one(disk,"source"); const path=source.attrs.file;
    if(disk.attrs.device!=="cdrom"||disk.attrs.type!=="file"||nodes(disk,"readonly").length!==1||!path||absolute(path)!==path||dirname(path)!==dirname(binding.disk)||!attrsEqual(source,{file:path})) refuse("Additional media is not an owned read-only CD-ROM.");
  }
  const systems=nodes(root,"os"); if(systems.length>1) refuse("Ambiguous domain firmware.");
  if(systems[0]) {
    if(nodes(systems[0],"varstore").length) refuse("Varstore ownership is unsupported.");
    const nvram=nodes(systems[0],"nvram"); if(nvram.length>1||nvram.some(n=>n.children.length||n.text.trim()!==join(dirname(binding.disk),"nvram.fd"))) refuse("Firmware state is outside owned storage.");
  }
  const tpms=nodes(devices,"tpm"); if(tpms.length>1) refuse("Multiple TPM backends are unsupported.");
  for(const tpm of tpms) { const b=one(tpm,"backend"); if(b.attrs.type!=="emulator"||b.attrs.persistent_state!=="yes"||nodes(b,"encryption").length||!attrsEqual(one(b,"source"),{type:"dir",path:join(dirname(binding.disk),"tpm-state")})) refuse("TPM state is outside owned storage."); }
}
export function domainEmulator(xml:string):string|undefined { const d=one(xmlTree(xml),"devices"); const e=nodes(d,"emulator"); return e.length===1?absolute(e[0]!.text.trim()):undefined; }
export function domainHasTPM(xml:string):boolean { return nodes(one(xmlTree(xml),"devices"),"tpm").length>0; }

const kinds=new Set(["libvirt-execution","libvirt-binding","libvirt-authorization","libvirt-launch","libvirt-reconcile","libvirt-reboot","deletion"]);
/** SQLite lifetime locks replace flock; no stale-lock reclamation or PID signalling.
 * Linux operations use a pinned directory descriptor. Other platforms are fixtures only.
 * Python flock participants must be quiesced before migration to this lock protocol.
 */
export class SupervisorJournal {
  private readonly directory:number; private readonly birth:Inode; private db:DatabaseSync|undefined; private closed=false;
  readonly folder:string; readonly prefix:string;
  constructor(folder:string,prefix="libvirt-execution",options:{fixture?:boolean}={}) {
    if(!kinds.has(prefix)) refuse("Invalid supervisor journal kind."); if(process.platform!=="linux"&&!options.fixture) refuse("Pinned libvirt journals require Linux.");
    this.folder=absolute(folder); this.prefix=prefix; noSymlinks(folder); const before=fs.lstatSync(folder); owned(before,true); if(!before.isDirectory()) refuse("Private supervisor directory required.");
    this.birth=inode(before); this.directory=openDirectory(folder);
    try {
      this.check(); const lock=this.path(`${prefix}.ts-lock.sqlite`);
      try{fs.closeSync(fs.openSync(lock,"wx",0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
      regular(fs.lstatSync(lock)); this.db=new DatabaseSync(lock,{timeout:0}); this.db.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); this.check();
    }catch(error){this.db?.close();fs.closeSync(this.directory);throw error;}
  }
  path(name:string):string { if(!/^[a-z0-9][a-z0-9.-]*$/.test(name)) refuse("Invalid journal path."); return join(process.platform==="linux"?`/proc/self/fd/${this.directory}`:this.folder,name); }
  check():void { if(this.closed) refuse("Supervisor journal is closed."); const s=fs.lstatSync(this.folder); owned(s,true); if(!s.isDirectory()||!sameInode(s,this.birth)||!sameInode(fs.fstatSync(this.directory),this.birth)) refuse("Supervisor directory changed."); }
  readNamed(name:string):RecordValue|null { if(name!=="assignment.json"&&!kinds.has(name.replace(/\.json$/,""))) refuse("Invalid supervisor record."); this.check(); const v=readPrivate(this.path(name)); this.check(); return v; }
  read():RecordValue|null{return this.readNamed(`${this.prefix}.json`);}
  write(value:RecordValue):void {
    this.check();this.read();const data=Buffer.from(canonical(value));if(data.length>16384)refuse("Supervisor record is oversized.");
    const tmp=this.path(`temporary-${randomUUID()}`);let fd:number|undefined;
    try {fd=fs.openSync(tmp,"wx",0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;this.check();fs.renameSync(tmp,this.path(`${this.prefix}.json`));fs.fsyncSync(this.directory);this.check();}
    finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  }
  prepare(binding:LibvirtLeaseBinding):void{if(this.read()!==null)refuse("Preparation cannot reset prior history.");this.write({...binding.identity(),phase:"prepared"});}
  close():void{if(this.closed)return;this.closed=true;try{this.db?.exec("ROLLBACK");}finally{this.db?.close();fs.closeSync(this.directory);}}
}

export interface FileLease {verify():void;close():void}
export type FileLeaseFactory=(fd:number)=>FileLease;
export interface ManifestEntry {path:string[];identity:number[];kind:"file"|"directory"}
interface Pinned {fd:number;path:string;identity:string;entry:ManifestEntry;names?:string[];lease?:FileLease}
/** Native F_SETLEASE is deliberately required; an empty process scan is never proof. */
export class StorageHandleGuard {
  private entries:Pinned[]=[]; private failed=false;private closed=false;private readonly pid=process.pid;
  constructor(readonly root:string,readonly expected:Inode,leaseFactory?:FileLeaseFactory){
    if(!leaseFactory)refuse("Linux write-file-lease binding is unavailable; storage handles are unknown.");
    try{absolute(root);noSymlinks(root);if(!sameInode(fs.lstatSync(root),expected))refuse("Storage root changed.");
      const parent=openDirectory(dirname(root));
      try { this.walk(process.platform==="linux"?`/proc/self/fd/${parent}/${root.slice(root.lastIndexOf("/")+1)}`:root,[],leaseFactory); }
      finally { fs.closeSync(parent); }
      // Root verification uses its public path; descendants use pinned parents.
      this.entries[0]!.path=root;this.verify();
    }catch(e){this.failed=true;this.close();throw e;}
  }
  private walk(path:string,parts:string[],factory:FileLeaseFactory):void{
    const s=fs.lstatSync(path);owned(s);if(s.dev!==this.expected.device||(!s.isDirectory()&&!s.isFile()))refuse("Unsupported storage entry.");if(s.isFile())regular(s,false);
    const fd=fs.openSync(path,(s.isDirectory()?fs.constants.O_RDONLY|fs.constants.O_DIRECTORY:fs.constants.O_RDWR)|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const pin:Pinned={fd,path,identity:stamp(s),entry:{path:parts,identity:[s.dev,s.ino,s.mode,s.uid],kind:s.isDirectory()?"directory":"file"}};this.entries.push(pin);
    if(stamp(fs.fstatSync(fd))!==pin.identity)refuse("Storage changed while pinning.");
    if(s.isDirectory()){const pinned=process.platform==="linux"?`/proc/self/fd/${fd}`:path;pin.names=fs.readdirSync(pinned).sort();for(const name of pin.names)this.walk(join(pinned,name),[...parts,name],factory);}else pin.lease=factory(fd);
  }
  verify():void{
    if(this.failed||this.closed||this.pid!==process.pid)refuse("Storage handle guard is invalid.");
    try{for(const p of this.entries){if(stamp(fs.lstatSync(p.path))!==p.identity||stamp(fs.fstatSync(p.fd))!==p.identity)refuse("Storage identity changed.");if(p.names&&canonical(fs.readdirSync(p.path).sort())!==canonical(p.names))refuse("Storage membership changed.");p.lease?.verify();}}catch(e){this.failed=true;throw e;}
  }
  snapshot():ManifestEntry[]{this.verify();return this.entries.map(p=>structuredClone(p.entry)).sort((a,b)=>a.path.join("/").localeCompare(b.path.join("/")));}
  eraseContents():void{this.verify();try{for(const p of this.entries)if(p.lease){p.lease.verify();if(stamp(fs.fstatSync(p.fd))!==p.identity)refuse("Storage changed before clearing.");fs.ftruncateSync(p.fd,0);fs.fsyncSync(p.fd);const after=fs.fstatSync(p.fd);if(after.size!==0||!sameInode(after,{device:p.entry.identity[0]!,inode:p.entry.identity[1]!}))refuse("Content erasure is unconfirmed.");p.identity=stamp(after);}this.verify();}catch(e){this.failed=true;throw e;}}
  empty():boolean{this.verify();return this.entries.filter(p=>p.lease).every(p=>fs.fstatSync(p.fd).size===0);}
  /** Protected unlink must be supplied by an fd-relative native adapter. Node rm is not sufficient. */
  remove(unlink:(root:string,entries:ManifestEntry[])=>void):void{this.verify();if(!this.empty())refuse("Nonempty storage cannot be removed.");unlink(this.root,this.snapshot());this.verifyUnlinked();}
  verifyUnlinked():void{if(this.failed||this.closed||this.pid!==process.pid)refuse("Storage guard is invalid.");try{if(fs.existsSync(this.root)||fs.lstatSync(dirname(this.root)).isSymbolicLink())refuse("Storage remains.");for(const p of this.entries)if(p.lease){p.lease.verify();const s=fs.fstatSync(p.fd);if(s.size||s.nlink||!sameInode(s,{device:p.entry.identity[0]!,inode:p.entry.identity[1]!}))refuse("Pinned content remains linked.");}}catch(e){this.failed=true;throw e;}}
  close():void{if(this.closed)return;this.closed=true;let failed=false;for(const p of [...this.entries].reverse()){try{p.lease?.close();}catch{failed=true;}try{fs.closeSync(p.fd);}catch{failed=true;}}if(failed)refuse("Storage descriptor release is uncertain.");}
}

/** Inspect only. No dlopen, helper execution or native acceptance claim. */
export function deadlineArtifact(path:string,arch:"amd64"|"arm64"):RecordValue{
  try{
    absolute(path);noSymlinks(path);const d=snapshotFile(path,8*1048576);const region=(o:number,n:number)=>{if(!Number.isSafeInteger(o)||!Number.isSafeInteger(n)||o<0||n<0||o+n>d.length)throw Error();return d.subarray(o,o+n);};
    const u64=(o:number)=>{const n=Number(d.readBigUInt64LE(o));if(!Number.isSafeInteger(n))throw Error();return n;};
    if(d.length<64||!d.subarray(0,7).equals(Buffer.from([127,69,76,70,2,1,1]))||![0,3].includes(d[7]!)||d.readUInt16LE(16)!==3||d.readUInt16LE(18)!==({amd64:62,arm64:183}[arch])||d.readUInt32LE(20)!==1||d.readUInt16LE(52)!==64||d.readUInt16LE(54)!==56||d.readUInt16LE(58)!==64)throw Error();
    const ph=u64(32),sh=u64(40),pc=d.readUInt16LE(56),sc=d.readUInt16LE(60);if(!pc||!sc)throw Error();region(ph,pc*56);region(sh,sc*64);const segments=new Set<number>();
    for(let i=0;i<pc;i++){const o=ph+i*56;region(u64(o+8),u64(o+32));if(u64(o+40)<u64(o+32))throw Error();segments.add(d.readUInt32LE(o));}if(!segments.has(1)||!segments.has(2))throw Error();
    const found=new Set<string>();const exports=["canaveral_lease_deadline_arm","canaveral_lease_deadline_install"];
    for(let i=0;i<sc;i++){const o=sh+i*64;if(d.readUInt32LE(o+4)!==11)continue;const off=u64(o+24),size=u64(o+32),link=d.readUInt32LE(o+40);if(u64(o+56)!==24||size%24||link>=sc)throw Error();region(off,size);const str=sh+link*64;if(d.readUInt32LE(str+4)!==3)throw Error();const names=region(u64(str+24),u64(str+32));
      for(let s=off;s<off+size;s+=24){const n=d.readUInt32LE(s),info=d[s+4]!,visibility=d[s+5]!,defined=d.readUInt16LE(s+6);if(n>=names.length)throw Error();if(info>>4!==1||(info&15)!==2||![0,3].includes(visibility&3)||!defined)continue;
        for(const name of exports){const expected=Buffer.from(name+"\0");if(!names.subarray(n,n+expected.length).equals(expected))continue;if(defined>=sc)throw Error();const code=sh+defined*64,addr=u64(s+8),length=u64(s+16);if(d.readUInt32LE(code+4)!==1||!(u64(code+8)&4)||!length||addr<u64(code+16)||addr+length>u64(code+16)+u64(code+32))throw Error();region(u64(code+24),u64(code+32));found.add(name);}
      }
    }if(exports.some(n=>!found.has(n)))throw Error();return{path,sha256:hash(d),arch,format:"elf64",exports};
  }catch{throw new ServiceError("Configured Linux deadline artifact is invalid or unsupported.",409,{code:"lease_deadline_artifact_invalid"});}
}
