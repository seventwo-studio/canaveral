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
const identities=[], retained=[];
for(const name of packages) {
 const hash=createHash('sha256').update(readFileSync(inputs+'/packages/'+name)).digest('hex');
 const entry=entries.get(hash); assert(entry, 'package outside authenticated snapshot: '+name);
 assert.equal(name,hash+'.deb');
 assert(entry.Architecture === "arm64" || entry.Architecture === "all", "unexpected package architecture");
 retained.push({...entry, archive: name});
 identities.push(entry.Package+'='+entry.Version+':'+entry.Architecture+'\tpackages/'+name);
}
assert.deepEqual(identities.sort(), readFileSync(inputs+'/packages.tsv','utf8').trim().split('\n').sort());
// Apt resolves version constraints against this immutable snapshot. Independently
// require the formatter's entire Depends/Pre-Depends closure among retained,
// hash-authenticated archives. Record exact versions/hashes, never guess pins.
const byName = new Map(retained.map(entry => [entry.Package, entry]));
const providers = new Map();
for (const entry of retained) for (const provided of (entry.Provides ?? '').split(',')) {
 const name = provided.trim().split(/[ (]/)[0];
 if (name) providers.set(name, entry);
}
assert(byName.has('e2fsprogs'), 'v2 requires authenticated e2fsprogs');
const closure = new Map();
function visit(entry) {
 if (closure.has(entry.Package)) return;
 closure.set(entry.Package, entry);
 for (const group of [entry.Depends, entry['Pre-Depends']].filter(Boolean).join(',').split(',').filter(s=>s.trim())) {
  const alternatives = group.split('|').map(s=>s.trim().split(/[ (]/)[0].replace(/:(any|native)$/, ''));
  const dependency = alternatives.map(n=>byName.get(n) ?? providers.get(n)).find(Boolean);
  assert(dependency, `missing formatter dependency: ${entry.Package}: ${group}`);
  visit(dependency);
 }
}
visit(byName.get('e2fsprogs'));
const formatterClosure = [...closure.values()].sort((a,b)=>a.Package.localeCompare(b.Package)).map(e=>({
 identity: `${e.Package}=${e.Version}:${e.Architecture}`, sha256:e.SHA256, archive:e.archive
}));
writeFileSync(inputs+'/debian-packages-verified.json',JSON.stringify({method:'pinned Release signature -> SHA256 Packages -> SHA256 each archive',packages, formatterClosure},null,2));
