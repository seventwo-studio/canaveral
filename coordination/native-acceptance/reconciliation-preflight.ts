import assert from 'node:assert/strict';
import {lstatSync, readdirSync, readFileSync, realpathSync, openSync, readSync, closeSync} from 'node:fs';
import {basename,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {requireQuiescent} from './reconciliation.ts';
// Node 24.11 warns when node:sqlite is imported. Keep that known built-in
// warning out of the harness's fatal warning boundary without relaxing it.
// Only this fixed read-only child accepts SQLite's exact built-in warning; it
// inherits no environment hooks, and every other diagnostic or malformed result fails.
function sqliteInventory(path:string):number {
  const script=`
    process.removeAllListeners('warning');
    process.on('warning',warning=>{
      if(warning.name!=='ExperimentalWarning' || warning.code!==undefined ||
          warning.message!=='SQLite is an experimental feature and might change at any time')
        process.exitCode=1;
    });
    try {
      const {readFileSync}=await import('node:fs');
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync(JSON.parse(readFileSync(0,'utf8')),{readOnly:true,timeout:1000});
      try {
        const held=Number(db.prepare("SELECT count(*) AS n FROM resource_reservations WHERE state IS NOT 'released'").get().n);
        for(const table of ['hosts','machines','images','image_tasks','inference_jobs'])
          if(Number(db.prepare('SELECT count(*) AS n FROM '+table).get().n)!==0) throw Error();
        process.stdout.write(JSON.stringify({held}));
      } finally {db.close();}
    } catch {process.exitCode=1;}
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
    input:JSON.stringify(path),encoding:'utf8',env:{},timeout:5000,maxBuffer:65536,
  });
  assert.equal(child.status,0);assert.equal(child.stderr,'');
  const result=JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(result),['held']);
  assert(Number.isSafeInteger(result.held) && result.held >= 0);
  return result.held;
}
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
    const name=basename(path);
    assert.notEqual(name,'state.next','unpublished journal candidate requires inspection');
    if(name==='state.json') {
      assert(st.size <= 16*1024*1024);
      const j = JSON.parse(readFileSync(path,'utf8'));
      assert.equal(j.released,true);assert.equal(j.cleaned,true);assert.equal(j.stopped,true);
    }
    const fd = openSync(path,'r');
    const header = Buffer.alloc(16);
    try {readSync(fd,header,0,16,0);} finally {closeSync(fd);}
    if(header.toString() === 'SQLite format 3\0') {
      // Generic allocations must also be absent; unknown schemas fail closed.
      held += sqliteInventory(path);
    } else {
      assert(!/^(?:db|.*\.db|.*\.sqlite.*|.*-(?:wal|shm|journal))$/i.test(name),'unrecognized database state requires inspection');
    }
  }
  for(const root of roots) {assert.equal(realpathSync(root),root);assert(!seen.has(root));seen.add(root);walk(root,0);}
  requireQuiescent(ps.split('\n').map(command=>({command})),held,false);
}
