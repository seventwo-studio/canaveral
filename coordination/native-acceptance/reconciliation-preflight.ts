import assert from 'node:assert/strict';
import {lstatSync, readdirSync, readFileSync, realpathSync, openSync, readSync, closeSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {requireQuiescent} from './reconciliation.ts';
// Operator inventory is a prerequisite, not an attestation or a stopped-resource flag.
// Scan every supplied canonical state root before creating the new isolated controller.
export function inspectPhysicalState(roots: string[], ps: string) {
  let files = 0, held = 0;
  const seen = new Set<string>();
  function walk(path:string, depth:number) {
    assert(depth < 12 && ++files < 20000);
    const st = lstatSync(path);
    assert(!st.isSymbolicLink());
    assert.equal(st.uid, process.getuid!());
    assert.equal(st.mode & 0o022, 0);
    if(st.isDirectory()) {for(const n of readdirSync(path)) walk(join(path,n),depth+1);return;}
    assert(st.isFile());
    if(path.endsWith('/state.json')) {
      const j = JSON.parse(readFileSync(path,'utf8'));
      assert.equal(j.released,true);assert.equal(j.cleaned,true);assert.equal(j.stopped,true);
    }
    const fd = openSync(path,'r');
    const header = Buffer.alloc(16);
    try {readSync(fd,header,0,16,0);} finally {closeSync(fd);}
    if(header.toString() === 'SQLite format 3\0') {
      const db = new DatabaseSync(path,{readOnly:true});
      try {
        held += Number(db.prepare("SELECT count(*) AS n FROM resource_reservations WHERE state != 'released'").get()!.n);
        // Generic host allocations are outside this case. Require their entire
        // inventories empty rather than guessing which rows still hold capacity.
        for(const table of ['hosts','machines','images','image_tasks','inference_jobs'])
          assert.equal(Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),0);
      } finally {db.close();}
    }
  }
  for(const root of roots) {assert.equal(realpathSync(root),root);assert(!seen.has(root));seen.add(root);walk(root,0);}
  requireQuiescent(ps.split('\n').map(command=>({command})),held,false);
}
