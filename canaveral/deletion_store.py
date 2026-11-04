"""Explicit machine deletion receipts; stopped disks remain reserved until ACK."""
import json

from .model import Error, identifier


class DeletionStore:
    def initialize_deletions(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS machine_deletions (id TEXT PRIMARY KEY,machine TEXT NOT NULL UNIQUE,state TEXT NOT NULL,created REAL NOT NULL)')

    def _deletion(self,db,machine_id):
        return db.execute('SELECT * FROM machine_deletions WHERE machine=?',(machine_id,)).fetchone()

    def _deleted(self,db,machine_id):
        row=self._deletion(db,machine_id)
        cleanup=self._lease_cleanup(db,machine_id)
        return bool(row and row['state']=='complete' or cleanup and cleanup['state']=='complete')

    def request_deletion(self,machine_id,value):
        if not isinstance(value,dict) or set(value)!={'id'}:raise Error('Deletion requires a stable request UUID.',400)
        machine_id=identifier(machine_id);request_id=identifier(value['id'])
        with self.transaction() as db:
            old=db.execute('SELECT * FROM machine_deletions WHERE id=?',(request_id,)).fetchone()
            if old:
                if old['machine']!=machine_id:raise Error('Deletion identity belongs to another machine.',409)
                return {'id':request_id,'machineId':machine_id,'state':old['state']}
            row=db.execute('SELECT m.*,h.seen,h.offer FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?',(machine_id,)).fetchone()
            if not row:raise Error('Unknown machine.',404)
            if self._deletion(db,machine_id):raise Error('A deletion intent already exists. Reuse its request ID.',409)
            if db.execute('SELECT 1 FROM lease_members WHERE machine=?',(machine_id,)).fetchone():raise Error('Lease-owned machines use lease cleanup.',409)
            if row['desired']!='stopped' or row['observed']!='stopped' or self.clock()-row['seen']>=self.lease_seconds:
                raise Error('Deletion requires confirmed shutdown on a connected host.',409)
            if json.loads(row['offer'])['provider'] not in ('apple','macos') or json.loads(row['template'])['os'] not in ('linux','macos'):
                raise Error('Owned deletion is not implemented for this runtime.',409,code='capability_unsupported')
            if db.execute("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'",(machine_id,)).fetchone():raise Error('Resolve the power-off intent before deleting storage.',409)
            if db.execute("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')",(machine_id,)).fetchone():raise Error('Resolve the source image capture before deleting storage.',409)
            db.execute("INSERT INTO machine_deletions VALUES (?,?,'queued',?)",(request_id,machine_id,self.clock()))
            return {'id':request_id,'machineId':machine_id,'state':'queued'}

    def _deletion_assignment(self,db,machine):
        row=self._deletion(db,machine['id'])
        if row:
            machine['deletion']={'id':row['id'],'state':row['state']}
            machine['ready']=False
        return machine

    def _report_deletion(self,db,machine_id,report):
        receipt=report.get('deletion')
        if receipt is None:return
        if not isinstance(receipt,dict) or set(receipt)!={'id','state'} or receipt['state'] not in ('running','blocked','complete'):
            raise Error('Invalid deletion receipt.',400)
        row=self._deletion(db,machine_id)
        if not row or row['id']!=identifier(receipt['id']):raise Error('Deletion receipt does not match this assignment.',403)
        if row['state']=='complete':return
        if receipt['state']=='complete' and report['state']!='stopped':raise Error('Deletion completion requires a stopped runtime.',409)
        db.execute('UPDATE machine_deletions SET state=? WHERE machine=?',(receipt['state'],machine_id))
