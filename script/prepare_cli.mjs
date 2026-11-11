#!/usr/bin/env node
/** Finalize the npm executable after TypeScript emits it. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModuleClosure } from './package_checks.mjs';

export function checkEmittedModules(root) {
  const files = new Map();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(root, path).replaceAll('\\', '/'), /\.(?:js|mjs|cjs)$/.test(path) ? readFileSync(path, 'utf8') : '');
      else throw new Error('Emitted package must contain regular files and directories.');
    }
  }
  walk(root); checkModuleClosure(files);
}
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
  checkEmittedModules(fileURLToPath(new URL('../coordination/dist/src/', import.meta.url)));
}
