#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Scan both indexed files and new source files. Deleted index entries are ignored
// so this also checks a rewrite before its deletions have been staged.
export function violations(path, content) {
  const reasons = [];
  if (/\.py[co]?$/i.test(path)) reasons.push('forbidden source extension');
  if (/^#![^\r\n]*\bpython(?:[\d.]*)?\b/im.test(content)) reasons.push('interpreter shebang');
  if (/\b(?:python[\d.]*|pypy[\d.]*)\s+(?:-[A-Za-z]|[^\s"'`]*\.py\b)/i.test(content)) reasons.push('interpreter invocation');
  // Also inspect quoted/escaped source strings, including native command payloads.
  const lines = content.replaceAll('\\n', '\n').replace(/^(?:@testable\s+)?import\s+(?:AppKit|ApplicationServices|Canaveral\w+|Carbon|CryptoKit|Darwin|Foundation|ImageIO|Observation|PackageDescription|ScreenCaptureKit|Security|SwiftUI|UniformTypeIdentifiers|Virtualization|XCTest|zlib)\s*$/gm, '');
  if (/(?:Command::new|spawn(?:Sync)?|execFile(?:Sync)?)\s*\(\s*["'`](?:[^"'`]*[\/\\])?(?:python[\d.]*|pypy[\d.]*)["'`]|["'`][^"'`]*[\/\\](?:python[\d.]*|pypy[\d.]*)["'`]/i.test(content)) reasons.push('interpreter command');
  if (/(?:^|["'`])\s*(?:from\s+[\w.]+\s+import\s+\w|import\s+[A-Za-z_][\w.]*(?:\s*,\s*[\w.]+)*(?=\s*(?:$|[;\"'`#]))|(?:async\s+)?def\s+\w+\([^\n]*\)\s*:|if\s+__name__\s*==|class\s+\w+\([^\n]*\)\s*:)/m.test(lines) || /\b__import__\s*\(/.test(lines)) reasons.push('embedded interpreter source');
  return reasons;
}
export function scan(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const found=[];
  for(const path of new Set(files)) {
    let stat;
    try { stat=lstatSync(resolve(root,path)); } catch(error) { if(error.code==='ENOENT') continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const source = stat.isFile() ? readFileSync(resolve(root,path)) : Buffer.alloc(0);
    for(const reason of violations(path, source.includes(0) ? '' : source.toString('utf8'))) found.push(`${path}: ${reason}`);
  }
  return found;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const found=scan(fileURLToPath(new URL('../',import.meta.url)));
  if(found.length) { console.error(found.join('\n')); process.exitCode=1; }
  else console.log('No forbidden runtime source or embedded interpreter code found.');
}
