#!/usr/bin/env node
/** Build an uninstalled deadline library at a new absolute path. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run, ROOT } from './tasks.mjs';
export function main(args) {
  const {values}=parseArgs({args,options:{output:{type:'string'}}});
  if(process.platform!=='linux') throw new Error('The native deadline shim must be built on Linux.');
  const output=values.output;
  let occupied=false;
  if(output) try {lstatSync(output); occupied=true;} catch(error) {if(error.code!=='ENOENT') throw error;}
  if(!output || !isAbsolute(output) || occupied || existsSync(output)) throw new Error('Choose a new absolute output path; existing artifacts are retained.');
  const source=join(ROOT,'canaveral/native/linux_lease_deadline.c');
  mkdirSync(dirname(output),{recursive:true});
  const temporary=mkdtempSync(join(dirname(output),'.linux-deadline-')), artifact=join(temporary,'deadline.so');
  try {
    run('cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',source,'-lrt','-o',artifact]);
    const fd=openSync(artifact,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    // Hard-link publication cannot replace a destination created during the build.
    linkSync(artifact,output);unlinkSync(artifact);
    const dir=openSync(dirname(output),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
    const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
    console.log(JSON.stringify({path:output,sha256:sha(output),sourceSHA256:sha(source),abi:1,installed:false,nativeLeaseAcceptance:false}));
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
