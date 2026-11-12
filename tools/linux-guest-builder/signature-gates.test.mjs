import * as crypto from "node:crypto";

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('Rust detached-signature gate rejects failed verification', t => {
  const root = mkdtempSync(join(tmpdir(), 'canaveral-signature-gate-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(join(root,'inputs')); mkdirSync(join(root,'bin'));
  // Existing but unauthenticated key material must not authorize execution.
  writeFileSync(join(root,'inputs','rust-key.asc'), 'invalid-key');
  writeFileSync(join(root,'inputs','rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz.asc'), 'invalid-signature');
  writeFileSync(join(root,'bin','gpg'), '#!/bin/sh\ncase "$*" in *show-only*) printf "pub::::::::::\\nfpr:::::::::108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE:\\n" ;; *--verify*) touch verify-attempted; exit 1 ;; *) exit 0 ;; esac\n', {mode:0o700});
  const result = spawnSync('/bin/bash', [resolve('tools/linux-guest-builder/build-rust.sh')], {
    cwd:root, env:{...process.env, BUILD:root, INPUTS:join(root,'inputs'), PATH:join(root,'bin')+':'+process.env.PATH}, encoding:'utf8'
  });
  assert.notEqual(result.status, 0);
  assert(existsSync(join(root,'inputs','verify-attempted')));
  assert(!existsSync(join(root,'rust')), 'installer destination created before authentication');
});

for (const mode of ['fetched primary mismatch', 'VALIDSIG primary mismatch']) {
 test('Rust authentication refuses '+mode+' even when gpg succeeds', t => {
  const root=mkdtempSync(join(tmpdir(),'canaveral-fingerprint-gate-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'inputs'));mkdirSync(join(root,'bin'));
  writeFileSync(join(root,'inputs','rust-key.asc'),'existing-key');
  writeFileSync(join(root,'inputs','rust-1.99.1-aarch64-unknown-linux-gnu.tar.xz.asc'),'existing-signature');
  const pin='108F66205EAEB0AAA8DD5E1C85AB96E6FA1BE5FE';
  const wrong='0000000000000000000000000000000000000000';
  writeFileSync(join(root,'bin','gpg'),`#!/bin/sh
case "$*" in
 *show-only*) printf 'pub::::::::::\\nfpr:::::::::${mode==='fetched primary mismatch'?wrong:pin}:\\n';;
 *--verify*) printf '[GNUPG:] VALIDSIG ${pin} 2026-10-15 1792085099 0 4 0 1 10 00 ${wrong}\\n' >&3;;
esac
exit 0
`,{mode:0o700});
  const result=spawnSync('/bin/bash',[resolve('tools/linux-guest-builder/build-rust.sh')],{cwd:root,env:{...process.env,BUILD:root,INPUTS:join(root,'inputs'),PATH:join(root,'bin')+':'+process.env.PATH},encoding:'utf8'});
  assert.notEqual(result.status,0);assert(!existsSync(join(root,'rust')));
 });
}
test('Debian status refuses an unpinned primary even in a valid keyring', t=>{
 const root=mkdtempSync(join(tmpdir(),'canaveral-debian-pin-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const status=join(root,'status');
 writeFileSync(status,'[GNUPG:] VALIDSIG 4CB50190207B4758A3F73A796ED0E7B82643E131 2026-09-12 1789199777 0 4 0 1 8 00 0000000000000000000000000000000000000000\n');
 const result=spawnSync('/bin/bash',['-c','source "$1"; require_primary_signature "$2" "$DEBIAN_PRIMARIES"','bash',resolve('tools/linux-guest-builder/signature-policy.sh'),status]);
 assert.notEqual(result.status,0);
});

test('complete signature gate refuses missing kernel input before acceptance', t=>{
 const root=mkdtempSync(join(tmpdir(),'canaveral-complete-gate-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const result=spawnSync('/bin/bash',[resolve('tools/linux-guest-builder/verify-signatures.sh')],{env:{...process.env,INPUTS:root},encoding:'utf8'});
 assert.notEqual(result.status,0);
 assert(!existsSync(join(root,'authenticated-inputs.json')));
});

test('archive content comparison rejects changed source bytes', async ()=>{
 const {archiveEntries}=await import('./archive-entries.mjs');
 const bytes=spawnSync('git',['archive','HEAD','Cargo.toml'],{maxBuffer:1024*1024}).stdout;
 const changed=Buffer.from(bytes);
 // Locate the first regular-file payload rather than packaging metadata.
 for(let offset=0;offset+512<changed.length;) {
  const header=changed.subarray(offset,offset+512);
  const size=parseInt(header.subarray(124,136).toString().replace(/\0.*$/s,'').trim(),8)||0;
  const type=header[156];offset+=512;
  if(type===48||type===0) {changed[offset]^=1;break;}
  offset+=Math.ceil(size/512)*512;
 }
 assert.notDeepEqual(archiveEntries(bytes),archiveEntries(changed));
});

test('formatter archives require signed-index hashes and a retained dependency closure', t=>{
 const root=mkdtempSync(join(tmpdir(),'canaveral-formatter-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'packages'));
 const index=join(root,'signed-index');
 const verify=()=>spawnSync(process.execPath,[resolve('tools/linux-guest-builder/verify-debian-packages.mjs'),root,index],{encoding:'utf8'});
 const hash='a'.repeat(64);
 writeFileSync(index,`Package: e2fsprogs\nVersion: fixture\nArchitecture: arm64\nSHA256: ${hash}\n\n`);
 writeFileSync(join(root,'packages',hash+'.deb'),'tampered');
 writeFileSync(join(root,'packages.tsv'),`e2fsprogs=fixture:arm64\tpackages/${hash}.deb\n`);
 assert.notEqual(verify().status,0);
 rmSync(join(root,'packages',hash+'.deb'));
 // Synthetic hashes model an already authenticated Packages index, not real packages.
 const {createHash}=crypto;
 const actual=createHash('sha256').update('fixture').digest('hex');
 writeFileSync(join(root,'packages',actual+'.deb'),'fixture');
 writeFileSync(join(root,'packages.tsv'),`e2fsprogs=fixture:arm64\tpackages/${actual}.deb\n`);
 const stanza=`Package: e2fsprogs\nVersion: fixture\nArchitecture: arm64\nSHA256: ${actual}\n`;
 writeFileSync(index,stanza+'Depends: missing-lib (>= 1)\n\n');
 assert.notEqual(verify().status,0);
 writeFileSync(index,stanza+'\n');
 assert.equal(verify().status,0);
});
