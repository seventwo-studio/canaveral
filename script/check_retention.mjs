#!/usr/bin/env node
/** Compare saved reload evidence without contacting services or changing state. */
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, uniqueJSON } from './json.mjs';
export const SCHEMA='canaveral-retention-v1';
export const SECTIONS=['machineAssignments','imageInventory','nativeBootReceipts','hostBudgets','sharedBudgets','reservations','configurationHashes'];
export const MAX_BYTES=8*1048576;
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const exact=(v,keys)=>object(v) && Object.keys(v).sort().join('\0')===[...keys].sort().join('\0');
const fail=()=>{throw new Error('Invalid or incomplete retention evidence.');};
const text=v=>typeof v==='string' && v.length>0;
function resources(value, minimum) { return exact(value,['cpu','memoryMiB','diskGiB']) && Object.values(value).every(v=>Number.isSafeInteger(v) && v>=minimum); }
export function validate(value) {
  if(!exact(value,['schema','capturedAt','stable','observations']) || value.schema!==SCHEMA || typeof value.capturedAt!=='number' || !Number.isFinite(value.capturedAt) || value.capturedAt<=0 || !exact(value.stable,SECTIONS)) fail();
  const stable=value.stable;
  for(const section of SECTIONS) {
    const items=stable[section];
    if(!object(items) || Object.keys(items).some(k=>!k) || (section!=='sharedBudgets' && !Object.keys(items).length)) fail();
  }
  for(const section of ['nativeBootReceipts','configurationHashes']) if(Object.values(stable[section]).some(v=>typeof v!=='string' || !/^[a-f0-9]{64}$/.test(v))) fail();
  if(Object.keys(stable.nativeBootReceipts).some(k=>!Object.hasOwn(stable.machineAssignments,k))) fail();
  if(Object.keys(stable.hostBudgets).sort().join('\0')!==Object.keys(stable.reservations).sort().join('\0')) fail();
  for(const section of ['hostBudgets','reservations']) for(const r of Object.values(stable[section])) if(!resources(r, section==='hostBudgets'?1:0)) fail();
  for(const a of Object.values(stable.machineAssignments)) if(!object(a) || !text(a.hostId) || !Object.hasOwn(stable.hostBudgets,a.hostId) || !resources(a.resources,1) || !['running','stopped'].includes(a.desired) || !object(a.template) || ['id','revision','arch'].some(k=>!text(a.template[k]))) fail();
  for(const a of Object.values(stable.imageInventory)) if(!object(a) || ['hostId','id','revision','arch'].some(k=>!text(a[k])) || !Object.hasOwn(stable.hostBudgets,a.hostId)) fail();
  for(const b of Object.values(stable.sharedBudgets)) if(!object(b) || !resources(b.capacity,1) || !Array.isArray(b.hostIds) || !b.hostIds.length || new Set(b.hostIds).size!==b.hostIds.length || b.hostIds.some(h=>!text(h) || !Object.hasOwn(stable.hostBudgets,h))) fail();
  if(!exact(value.observations,['consumerLeaseIds','liveCleanupIntentIds']) || Object.values(value.observations).some(a=>!Array.isArray(a) || a.some(v=>!text(v)) || new Set(a).size!==a.length)) fail();
  canonical(value);
  return value;
}
const signature=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
export function load(path) {
  const before=lstatSync(path,{bigint:true});
  if(!before.isFile() || before.size>BigInt(MAX_BYTES)) fail();
  const fd=openSync(path,constants.O_RDONLY | (constants.O_NONBLOCK??0) | (constants.O_NOFOLLOW??0));
  try {
    if(signature(before)!==signature(fstatSync(fd,{bigint:true}))) fail();
    const data=Buffer.alloc(MAX_BYTES+1);
    let length=0, n;
    while(length<data.length && (n=readSync(fd,data,length,data.length-length,null))>0) length+=n;
    if(length>MAX_BYTES || signature(before)!==signature(fstatSync(fd,{bigint:true})) || signature(before)!==signature(lstatSync(path,{bigint:true}))) fail();
    return validate(uniqueJSON(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,length))));
  } finally { closeSync(fd); }
}
export function compare(before, after) {
  validate(before); validate(after);
  const changedSections=SECTIONS.filter(s=>canonical(before.stable[s])!==canonical(after.stable[s]));
  const reasonCodes=[];
  if(after.capturedAt<=before.capturedAt) reasonCodes.push('after_not_later_than_before');
  if([before,after].some(v=>v.observations.consumerLeaseIds.length)) reasonCodes.push('consumer_leases_present');
  if([before,after].some(v=>v.observations.liveCleanupIntentIds.length)) reasonCodes.push('live_cleanup_intents_present');
  return {scope:'offline-retention-comparison',retentionMatches:!changedSections.length && !reasonCodes.length,changedSections,reasonCodes};
}
export function main(args, print=console.log) {
  try {
    if(args.length!==2) fail();
    const result=compare(load(args[0]),load(args[1]));print(JSON.stringify(result)); return result.retentionMatches?0:1;
  } catch { print(JSON.stringify({scope:'offline-retention-comparison',retentionMatches:false,reasonCodes:['invalid_or_unreadable_evidence']}));return 2; }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=main(process.argv.slice(2));
