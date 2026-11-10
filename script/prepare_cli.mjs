#!/usr/bin/env node
/** Finalize the npm executable after TypeScript emits it. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function prepareCli(file) {
  const source=readFileSync(file,'utf8');
  if(!source.startsWith('#!')) writeFileSync(file,'#!/usr/bin/env node\n'+source);
  chmodSync(file,0o755);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  prepareCli(new URL('../coordination/dist/src/cli.js',import.meta.url));
  const windows = new URL('../coordination/dist/src/guest/windows/',import.meta.url);
  mkdirSync(windows,{recursive:true});
  for(const name of ['native.ps1','native.cs']) copyFileSync(new URL('../coordination/src/guest/windows/'+name,import.meta.url),new URL(name,windows));
}
