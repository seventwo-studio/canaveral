// Reverify retained packages against a signed snapshot's exact Packages index.
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const [inputs, index] = process.argv.slice(2);
const entries = new Map();
for (const stanza of readFileSync(index,'utf8').split('\n\n')) {
  const fields = Object.fromEntries(stanza.split('\n').filter(l=>/^[A-Za-z]/.test(l)).map(l=>{const i=l.indexOf(':');return [l.slice(0,i),l.slice(i+1).trim()]}));
  if(fields.SHA256) entries.set(fields.SHA256, fields);
}
const packages = readdirSync(inputs+'/packages').filter(n=>n.endsWith('.deb'));
assert(packages.length>0, 'no authenticated Debian packages');
const identities=[];
for(const name of packages) {
 const hash=createHash('sha256').update(readFileSync(inputs+'/packages/'+name)).digest('hex');
 const entry=entries.get(hash); assert(entry, 'package outside authenticated snapshot: '+name);
 assert.equal(name,hash+'.deb');
 identities.push(entry.Package+'='+entry.Version+':'+entry.Architecture+'\tpackages/'+name);
}
assert.deepEqual(identities.sort(), readFileSync(inputs+'/packages.tsv','utf8').trim().split('\n').sort());
writeFileSync(inputs+'/debian-packages-verified.json',JSON.stringify({method:'pinned Release signature -> SHA256 Packages -> SHA256 each archive',packages},null,2));
