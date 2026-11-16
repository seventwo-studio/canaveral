import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {inspectPhysicalState} from './reconciliation-preflight.ts';

test('state inventory refuses old unresolved journals, renamed held stores, unsafe metadata and symlinks',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'reconciliation-preflight-')));
  try {
    inspectPhysicalState([root],'');
    const journal=join(root,'state.json');
    writeFileSync(journal,JSON.stringify({stopped:true,cleaned:true,released:false}),{mode:0o600});
    assert.throws(()=>inspectPhysicalState([root],''));
    writeFileSync(journal,JSON.stringify({stopped:true,cleaned:true,released:true}));
    inspectPhysicalState([root],'');
    chmodSync(journal,0o666);assert.throws(()=>inspectPhysicalState([root],''));chmodSync(journal,0o600);
    const path=join(root,'renamed-controller');
    const db=new DatabaseSync(path);chmodSync(path,0o600);
    db.exec("CREATE TABLE resource_reservations(state TEXT);CREATE TABLE machines(id TEXT);CREATE TABLE hosts(id TEXT);CREATE TABLE images(id TEXT);CREATE TABLE image_tasks(id TEXT);CREATE TABLE inference_jobs(id TEXT);INSERT INTO resource_reservations VALUES ('held')");
    assert.throws(()=>inspectPhysicalState([root],''));
    db.exec("UPDATE resource_reservations SET state='released'");inspectPhysicalState([root],'');
    db.exec("UPDATE resource_reservations SET state=NULL");assert.throws(()=>inspectPhysicalState([root],''));
    db.exec("UPDATE resource_reservations SET state='released'");
    db.exec("INSERT INTO machines VALUES ('unrelated')");assert.throws(()=>inspectPhysicalState([root],''));
    db.close();rmSync(path);
    symlinkSync(journal,join(root,'link'));assert.throws(()=>inspectPhysicalState([root],''));
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('inventory module preserves the harness fatal-warning boundary on supported Node versions',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'reconciliation-warning-')));
  try {
    const path=join(root,'inventory.sqlite');
    const db=new DatabaseSync(path);chmodSync(path,0o600);
    db.exec("CREATE TABLE resource_reservations(state TEXT);CREATE TABLE machines(id TEXT);CREATE TABLE hosts(id TEXT);CREATE TABLE images(id TEXT);CREATE TABLE image_tasks(id TEXT);CREATE TABLE inference_jobs(id TEXT)");
    db.close();
    const script=`await import(${JSON.stringify(new URL('./failure-boundary.ts',import.meta.url).href)});
      const {inspectPhysicalState}=await import(${JSON.stringify(new URL('./reconciliation-preflight.ts',import.meta.url).href)});
      inspectPhysicalState([${JSON.stringify(root)}],'');
      await new Promise(r=>setImmediate(r));`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('damaged or empty database names, SQLite sidecars and unpublished journals refuse admission',()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'reconciliation-unknown-state-')));
  try {
    for(const name of ['db','state.db','state.sqlite','state.sqlite3','state.sqlite-wal','renamed-wal','renamed-shm','renamed-journal','state.next']) {
      const path=join(root,name);
      for(const bytes of ['', '\0QLite format 3\0', JSON.stringify({stopped:true,cleaned:true,released:true})]) {
        writeFileSync(path,bytes,{mode:0o600});
        assert.throws(()=>inspectPhysicalState([root],''),name);
      }
      rmSync(path);
    }
    inspectPhysicalState([root],'');
  } finally {rmSync(root,{recursive:true,force:true});}
});
