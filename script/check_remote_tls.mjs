#!/usr/bin/env node
/** Optional operator-selected read-only acceptance against an existing TLS controller. */
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{url:{type:'string'},'token-file':{type:'string'},'ca-file':{type:'string'}}});
try {
  const origin=new URL(values.url??'');
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.search || origin.hash || !['','/'].includes(origin.pathname)) throw new Error('Use an HTTPS controller origin.');
  const token=values['token-file']?readFileSync(values['token-file'],'utf8').trim():process.env.CANAVERAL_ACCEPTANCE_TOKEN;
  if(!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Provide a private operator credential file or acceptance secret.');
  const ca=values['ca-file']?readFileSync(values['ca-file']):undefined;
  async function get(path) {
    return await new Promise((resolve,reject)=>{
      let size=0;const chunks=[];
      const request=https.get(new URL(path,origin),{ca,minVersion:'TLSv1.2',rejectUnauthorized:true,agent:false,headers:{Authorization:'Bearer '+token,Accept:'application/json'}},response=>{
        response.on('data',data=>{size+=data.length;if(size>8*1048576){response.destroy();reject(new Error('Oversized response.'));}else chunks.push(data);});
        response.on('error',reject);
        response.on('end',()=>{
          if(response.statusCode!==200) {reject(new Error('Authenticated acceptance request failed.'));return;}
          try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('Invalid acceptance response.'));}
        });
      });
      request.setTimeout(20_000,()=>request.destroy(new Error('Acceptance timed out.')));request.on('error',reject);
    });
  }
  await get('/healthz');await get('/v1/hosts');
  console.log(JSON.stringify({scope:'remote-tls-controller',authenticated:true,nativeRuntimeAcceptance:false}));
} catch {console.error('Remote TLS acceptance failed; credentials, response data and private paths were withheld.');process.exitCode=1;}
