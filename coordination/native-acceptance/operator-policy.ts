import {readFileSync, statSync} from 'node:fs';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {proxyProbe, assertProxy} from './proxy.ts';

type Address = {family:number; value:bigint};
function address(text:string): Address {
  const family=isIP(text);
  if (family===4) return {family,value:text.split('.').reduce((v,n)=>(v<<8n)+BigInt(n),0n)};
  if (family!==6 || text.includes('%') || text.includes('.')) throw Error();
  const halves=text.split('::');
  const left=halves[0] ? halves[0].split(':') : [];
  const right=halves[1] ? halves[1].split(':') : [];
  const words=halves.length===2 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  return {family,value:words.reduce((v,n)=>(v<<16n)+BigInt('0x'+n),0n)};
}
function cidr(text:string) {
  const parts=text.split('/');
  if(parts.length!==2 || !/^(0|[1-9][0-9]*)$/.test(parts[1]!)) throw Error();
  const ip=address(parts[0]!); const bits=Number(parts[1]),width=ip.family===4?32:128;
  if(bits>width || (ip.value>>BigInt(width-bits))<<BigInt(width-bits)!==ip.value) throw Error();
  // URL's IPv6 serializer uses RFC5952 lowercase/longest-zero-run spelling.
  const canonical=ip.family===4 ? parts[0] : new URL('http://['+parts[0]+']/').hostname.slice(1,-1);
  if(canonical!==parts[0]) throw Error();
  return {...ip,bits,width};
}
function contains(range:ReturnType<typeof cidr>,ip:Address) {
  return range.family===ip.family && range.value>>BigInt(range.width-range.bits)===ip.value>>BigInt(range.width-range.bits);
}

/** Discard filesystem/parser errors at the boundary, including their causes. */
export function loadOperatorDenyList(path:unknown) {
  let bytes:Buffer;
  try {
    if(typeof path!=='string' || resolve(path)!==path || (statSync(path).mode & 0o777)!==0o600) throw Error();
    bytes=readFileSync(path);
  } catch {throw Error('operator deny list unreadable');}
  try {
    const value=JSON.parse(bytes.toString('utf8'));
    // Unversioned files are the original v1 format; reject unknown explicit versions.
    if(!value || typeof value!=='object' || Array.isArray(value) || (value.version!==undefined && value.version!==1) ||
      !Array.isArray(value.operatorDenyCidrs) || value.operatorDenyCidrs.length===0 || value.operatorDenyCidrs.length>4096) throw Error();
    for(const entry of value.operatorDenyCidrs) {if(typeof entry!=='string') throw Error();cidr(entry);}
    return {operatorDenyCidrs:value.operatorDenyCidrs as string[],denyEvidence:{count:value.operatorDenyCidrs.length,digest:createHash('sha256').update(bytes).digest('hex')}};
  } catch {throw Error('operator deny list invalid');}
}

/** Same pinned tables and address rules as apple-satellite's Policy, without operator CIDRs. */
export function builtInPolicyAllows(target:string,interfaces:string[]):boolean {
  try {
    if(!interfaces.length) return false;
    const ip=address(target);
    const table=(name:string,digest:string)=> {
      const bytes=readFileSync(new URL('../../crates/apple-satellite/policy/'+name,import.meta.url));
      if(createHash('sha256').update(bytes).digest('hex')!==digest) throw Error();
      return bytes.toString().trim().split('\n').map(cidr);
    };
    const denied=table('public-https-v1.cidrs','2d8b719c77f473e854167deff0eb2d551ff1f7df34d3bb52be8aba88465f6130');
    const allocated=table('ipv6-allocated.cidrs','e4d88628225247190ed94324edd90a1cead5c9317b857cedb7ea6b772199bbb3');
    return !denied.some(c=>contains(c,ip)) && (ip.family===4 || allocated.some(c=>contains(c,ip))) &&
      !interfaces.some(s=>{const other=address(s.split('%')[0]!);return other.family===ip.family && other.value===ip.value;});
  } catch {throw Error('operator probe policy unavailable');}
}
export async function verifyOperatorDenials(entries:string[],evidence:{count:number;digest:string},command:(argv:string[])=>Promise<any>,
  interfaces=()=>Object.values(networkInterfaces()).flatMap(list=>(list??[]).map(x=>x.address))) {
  const targets=entries.map(entry=>entry.split('/')[0]!).filter(target=>builtInPolicyAllows(target,interfaces()));
  if(!targets.length) throw Error('operator denial probe requires an otherwise allowed target');
  let deniedCount=0;
  for(const target of targets) {
    try {
      // Refresh interfaces immediately before each probe; route outcomes cannot satisfy this assertion.
      if(!builtInPolicyAllows(target,interfaces())) throw Error();
      assertProxy(await command(proxyProbe(target.includes(':')?'['+target+']:443':target+':443')),'HTTP/1.1 403 Forbidden','destination_denied');
      deniedCount++;
    } catch {throw Error('operator destination denial probe failed');}
  }
  return {...evidence,deniedCount,passed:true};
}
