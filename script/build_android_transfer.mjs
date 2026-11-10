#!/usr/bin/env node
/** Build Android upload helpers with an installed NDK; never deploy them. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run, ROOT } from './tasks.mjs';
export function inspectArtifact(data,machine) {
  if(data.length<20 || !data.subarray(0,6).equals(Buffer.from([127,69,76,70,2,1])) || data.readUInt16LE(18)!==machine) throw new Error('Compiler produced an unexpected Android artifact.');
  if(data.includes(Buffer.from('CANAVERAL_TRANSFER_TEST_FAIL'))) throw new Error('Test fault injection must not ship.');
  return {sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length};
}
export function main(args) {
  const {values}=parseArgs({args,options:{ndk:{type:'string'},'output-dir':{type:'string',default:'dist/android-transfer'}}});
  if(!values.ndk) throw new Error('--ndk is required.');
  const system={darwin:'darwin',linux:'linux',win32:'windows'}[process.platform];
  if(!system) throw new Error('Unsupported NDK build host.');
  const prebuilt=join(values.ndk,'toolchains/llvm/prebuilt',system+'-x86_64');
  const compiler=join(prebuilt,'bin',system==='windows'?'clang.exe':'clang');
  if(!existsSync(compiler)) throw new Error('The configured installed NDK has no matching compiler.');
  const output=resolve(values['output-dir']);mkdirSync(output,{recursive:true});
  const manifest={schemaVersion:1,protocol:'CANAVERAL_TRANSFER_V1',minimumAPI:26,artifacts:{}};
  const temporary=mkdtempSync(join(output,'.build-'));
  try {
    for(const [arch,target,machine] of [['arm64','aarch64-linux-android26',183],['amd64','x86_64-linux-android26',62]]) {
      const name='canaveral-transfer-'+arch, artifact=join(temporary,name);
      run(compiler,['--target='+target,'--sysroot='+join(prebuilt,'sysroot'),'-std=c11','-O2','-Wall','-Wextra','-Werror','-fPIE','-pie','-Wl,-z,relro,-z,now',join(ROOT,'canaveral/native/android_transfer.c'),'-o',artifact]);
      manifest.artifacts[arch]={file:name,...inspectArtifact(readFileSync(artifact),machine)};
    }
    // Validate both architectures before publishing either artifact.
    for(const {file} of Object.values(manifest.artifacts)) renameSync(join(temporary,file),join(output,file));
    writeFileSync(join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    renameSync(join(temporary,'manifest.json'),join(output,'manifest.json'));
  } finally { rmSync(temporary,{recursive:true,force:true}); }
  console.log(JSON.stringify(manifest,null,2));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
