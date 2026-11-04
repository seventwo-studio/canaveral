"""Explicit administrative power cuts; graceful stop remains the default."""
import json

from .model import Error,identifier


class PowerStore:
    def initialize_power(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS machine_power_offs (id TEXT PRIMARY KEY,machine TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL)')
        db.execute('CREATE INDEX IF NOT EXISTS machine_power_offs_machine ON machine_power_offs(machine,state)')

    def request_power_off(self,machine_id,value):
        if not isinstance(value,dict) or set(value)!={'id'}:raise Error('Power off requires a stable request UUID.',400)
        machine_id=identifier(machine_id);request_id=identifier(value['id'])
        with self.transaction() as db:
            previous=db.execute('SELECT * FROM machine_power_offs WHERE id=?',(request_id,)).fetchone()
            if previous:
                if previous['machine']!=machine_id:raise Error('Power-off ID belongs to another machine.',409)
                return dict(id=request_id,machineId=machine_id,state=previous['state'])
            machine=db.execute('SELECT * FROM machines WHERE id=?',(machine_id,)).fetchone()
            if not machine:raise Error('Unknown machine.',404)
            if self._deletion(db,machine_id):raise Error('This machine has a deletion intent.',409)
            if db.execute('SELECT 1 FROM lease_members WHERE machine=?',(machine_id,)).fetchone():raise Error('Lease-owned machines use lease cleanup.',409)
            host=db.execute('SELECT * FROM hosts WHERE id=?',(machine['host'],)).fetchone()
            if self.clock()-host['seen']>=self.lease_seconds:raise Error('Power off requires a connected host.',409)
            if json.loads(host['offer'])['provider'] not in ('apple','macos') or json.loads(machine['template'])['os'] not in ('linux','macos'):
                raise Error('Explicit power off is not implemented for this runtime.',409,code='capability_unsupported')
            if db.execute("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')",(machine_id,)).fetchone():raise Error('Resolve the image capture before powering off its source.',409)
            if db.execute("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'",(machine_id,)).fetchone():raise Error('An unresolved power-off intent already exists. Reuse its request ID.',409)
            db.execute("INSERT INTO machine_power_offs VALUES (?,?,'queued',?)",(request_id,machine_id,self.clock()))
            db.execute("UPDATE machines SET desired='stopped' WHERE id=?",(machine_id,))
            return {'id':request_id,'machineId':machine_id,'state':'queued'}

    def _power_assignment(self,db,machine):
        row=db.execute("SELECT id FROM machine_power_offs WHERE machine=? AND state!='succeeded' ORDER BY created LIMIT 1",(machine['id'],)).fetchone()
        if row:machine['powerOffRequest']=row['id']
        return machine

    def _report_power_off(self,db,machine_id,report):
        request_id=report.get('powerOffId')
        if request_id is None:return
        row=db.execute('SELECT * FROM machine_power_offs WHERE id=?',(identifier(request_id),)).fetchone()
        if not row or row['machine']!=machine_id:raise Error('Power-off receipt does not match this machine.',403)
        if row['state']=='succeeded':return
        if report['state'] in ('stopped','unknown','error'):
            db.execute('UPDATE machine_power_offs SET state=? WHERE id=?',('succeeded' if report['state']=='stopped' else 'unknown',request_id))

    def _compute_reserved(self,db,row):
        if self._deleted(db,row['id']):return False
        # A stopped lease is still an unreclaimed environment. Hold all lease
        # quota until the matching stop/storage/credential cleanup receipt;
        # observed zero usage and reservation ownership are distinct facts.
        if db.execute('SELECT 1 FROM lease_members WHERE machine=?',(row['id'],)).fetchone():return True
        return row['desired']=='running' or row['observed']!='stopped' or bool(db.execute("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'",(row['id'],)).fetchone())
