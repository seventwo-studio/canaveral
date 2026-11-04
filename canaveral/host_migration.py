"""Offline, locally fenced consolidation of historical runtime agents.

This is deliberately not an HTTP operation. The local launcher holds every old
agent lock before moving ownership, and retains each runtime's storage/state.
"""
import json

from .model import Error, identifier, offer


class HostMigrationStore:
    def initialize_host_migration(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS retired_runners (id TEXT PRIMARY KEY, target TEXT NOT NULL)')

    def consolidate_local_runtimes(self,target_id,source_ids,definition):
        target_id=identifier(target_id);source_ids=[identifier(value) for value in source_ids]
        if target_id in source_ids or len(source_ids)!=len(set(source_ids)):raise Error('Invalid runtime consolidation.')
        proposed=offer(definition)
        if proposed['provider'] not in ('macos','linux','windows'):raise Error('Consolidation requires a physical host.')
        with self.transaction() as db:
            ids=[target_id,*source_ids]
            for host_id in ids:
                row=db.execute('SELECT * FROM hosts WHERE id=?',(host_id,)).fetchone()
                if not row:raise Error('Runtime identity is missing; do not adopt another host.',404)
                old=json.loads(row['offer'])
                if old['provider'] not in proposed['runtimes'] and not (host_id==target_id and old['provider']==proposed['provider']):
                    raise Error('Runtime does not belong to this physical host configuration.')
                if db.execute("SELECT 1 FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')",(host_id,)).fetchone():
                    raise Error('Active historical inference work requires separate migration.')
                for machine in db.execute('SELECT template FROM machines WHERE host=?',(host_id,)):
                    if json.loads(machine['template']) not in proposed['templates']:
                        raise Error('Retain every assigned immutable image definition during consolidation.')
            for source in source_ids:
                retired=db.execute('SELECT target FROM retired_runners WHERE id=?',(source,)).fetchone()
                if retired and retired[0]!=target_id:raise Error('Runtime was already moved to another host.')
                for table in ('machines','device_operations','inference_jobs'):
                    db.execute('UPDATE '+table+' SET host=? WHERE host=?',(target_id,source))
                for membership in db.execute('SELECT budget FROM resource_budget_members WHERE host=?',(source,)).fetchall():
                    db.execute('INSERT OR IGNORE INTO resource_budget_members VALUES (?,?)',(membership[0],target_id))
                db.execute('DELETE FROM resource_budget_members WHERE host=?',(source,))
                db.execute('UPDATE hosts SET enabled=0 WHERE id=?',(source,))
                db.execute('INSERT OR IGNORE INTO retired_runners VALUES (?,?)',(source,target_id))
            self._register_templates(db,proposed)
            db.execute('UPDATE hosts SET offer=? WHERE id=?',(json.dumps(proposed),target_id))
            report={'status':'checking','checkedAt':self.clock(),'checks':[]}
            db.execute('INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received',
                       (target_id,json.dumps(report),self.clock()))
        return {'id':target_id,'retiredRunnerIds':source_ids}
