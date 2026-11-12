import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('mirror binds metadata and rejects corrupt archives before apt receives bytes', async t => {
 const root=mkdtempSync(join(tmpdir(),'canaveral-mirror-'));
 const hash=createHash('sha256').update('good').digest('hex');
 mkdirSync(join(root,'bin'));
 for (const [name,bytes] of Object.entries({'Release':'authenticated release','Release.gpg':'signature','debian-Packages.xz':'compressed index','debian-Packages':`Filename: pool/a+1.deb\nSHA256: ${hash}\n`})) writeFileSync(join(root,name),bytes);
 writeFileSync(join(root,'bin/curl'),'#!/bin/sh\ncat "$MIRROR_TEST_BYTES"\n',{mode:0o700});
 writeFileSync(join(root,'bytes'),'good');
 const child=spawn(process.execPath,[resolve('tools/linux-guest-builder/verified-mirror.mjs'),root,join(root,'port')],{env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,MIRROR_TEST_BYTES:join(root,'bytes')},stdio:'ignore'});
 t.after(async()=>{child.kill(); await once(child,'exit'); rmSync(root,{recursive:true,force:true});});
 for(let n=0;!existsSync(join(root,'port'));n++) {assert(n<100); await new Promise(r=>setTimeout(r,20));}
 const origin='http://127.0.0.1:'+readFileSync(join(root,'port'),'utf8');
 assert.equal(await (await fetch(origin+'/dists/bookworm/Release')).text(),'authenticated release');
 assert.equal((await fetch(origin+'/dists/bookworm/InRelease')).status,404);
 assert.equal(await (await fetch(origin+'/pool/a%2b1.deb')).text(),'good');
 writeFileSync(join(root,'bytes'),'corrupt');
 assert.equal((await fetch(origin+'/pool/a%2b1.deb')).status,502);
 assert.equal((await fetch(origin+'/pool/unknown.deb')).status,404);
});
