// Compare Git archive content across Git versions with differing tar headers.
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export function archiveEntries(bytes) {
 const entries=[];
 const string=b=>b.toString('utf8').replace(/\0.*$/s,'');
 let extended={};
 for(let offset=0;offset+512<=bytes.length;) {
  const header=bytes.subarray(offset,offset+512);offset+=512;
  if(header.every(v=>v===0)) break;
  const size=parseInt(string(header.subarray(124,136)).trim(),8)||0;
  assert(Number.isSafeInteger(size) && offset+size<=bytes.length,'invalid tar entry size');
  const body=bytes.subarray(offset,offset+size);offset+=Math.ceil(size/512)*512;
  const type=string(header.subarray(156,157));
  if(type==='g') continue; // Git commit global header is packaging metadata.
  if(type==='x') {
   extended={};
   let at=0;
   while(at<body.length) {
    const space=body.indexOf(32,at), length=Number(body.subarray(at,space).toString());
    assert(Number.isSafeInteger(length)&&length>0&&at+length<=body.length);
    const field=body.subarray(space+1,at+length-1).toString(),eq=field.indexOf('=');
    extended[field.slice(0,eq)]=field.slice(eq+1);at+=length;
   }
   continue;
  }
  const prefix=string(header.subarray(345,500));
  const path=extended.path || (prefix?prefix+'/':'')+string(header.subarray(0,100));
  assert(!path.startsWith('/')&&!path.split('/').includes('..'),'unsafe archive path');
  assert(['0','','5','2'].includes(type),'unexpected Git archive entry type');
  entries.push({path,type:type||'0',mode:parseInt(string(header.subarray(100,108)).trim(),8),
   link:extended.linkpath||string(header.subarray(157,257)),sha256:createHash('sha256').update(body).digest('hex')});
  extended={};
 }
 assert(entries.length>0);
 assert.equal(new Set(entries.map(e=>e.path)).size,entries.length,'duplicate tar entry');
 return entries.sort((a,b)=>a.path.localeCompare(b.path));
}
