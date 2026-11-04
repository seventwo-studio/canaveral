"""Terminal lease cleanup intents and positively acknowledged reclamation."""
import uuid

from .model import Error,identifier


REASONS=frozenset(('execution_pending','operations_pending','sessions_pending','ownership',
                  'storage_removal','credential_erasure','unsupported','recovery'))


class LeaseCleanupStore:
    def initialize_lease_cleanup(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS lease_cleanup_members (id TEXT PRIMARY KEY,machine TEXT NOT NULL UNIQUE,lease TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,attempts INTEGER NOT NULL,next_retry REAL NOT NULL,updated REAL NOT NULL)')
        db.execute('CREATE INDEX IF NOT EXISTS lease_cleanup_lease ON lease_cleanup_members(lease,state)')

    def _ensure_lease_cleanup(self,db,lease_id):
        for member in db.execute('SELECT machine FROM lease_members WHERE lease=?',(lease_id,)).fetchall():
            cleanup_id=str(uuid.uuid5(uuid.UUID(lease_id),'cleanup:'+member['machine']))
            db.execute("INSERT OR IGNORE INTO lease_cleanup_members VALUES (?,?,?,'pending',NULL,0,0,?)",
                       (cleanup_id,member['machine'],lease_id,self.clock()))

    def _refresh_lease_cleanup(self,db):
        for row in db.execute("SELECT id FROM leases WHERE state IN ('failed','released','expired') AND cleanup!='complete'").fetchall():
            self._ensure_lease_cleanup(db,row['id'])
            states=[item[0] for item in db.execute('SELECT state FROM lease_cleanup_members WHERE lease=?',(row['id'],))]
            state='complete' if states and all(s=='complete' for s in states) else 'blocked' if 'blocked' in states else 'running' if any(s in ('running','complete') for s in states) else 'pending'
            db.execute('UPDATE leases SET cleanup=? WHERE id=?',(state,row['id']))

    def _lease_cleanup(self,db,machine_id):
        return db.execute('SELECT * FROM lease_cleanup_members WHERE machine=?',(machine_id,)).fetchone()

    def _lease_cleanup_assignment(self,db,machine):
        row=self._lease_cleanup(db,machine['id'])
        if row:
            machine['leaseCleanup']={'id':row['id'],'leaseId':row['lease'],'state':row['state'],
                                     'attempts':row['attempts'],'notBefore':row['next_retry']}
            machine['ready']=False
        return machine

    def _cleanup_view(self,row):
        return {'id':row['id'],'state':row['state'],'reason':row['reason'],'attempts':row['attempts'],
                'retryAt':row['next_retry'] or None}

    def _report_lease_cleanup(self,db,machine_id,report):
        receipt=report.get('leaseCleanup')
        if receipt is None:return
        base={'id','leaseId','state','attempt'};optional={'reason','storageRemoved','credentialsErased','executionStopped'}
        if not isinstance(receipt,dict) or not base<=set(receipt) or set(receipt)-base-optional or receipt['state'] not in ('running','blocked','complete'):
            raise Error('Invalid lease cleanup receipt.',400)
        row=self._lease_cleanup(db,machine_id)
        if not row or row['id']!=identifier(receipt['id']) or row['lease']!=identifier(receipt['leaseId']):
            raise Error('Lease cleanup receipt does not match its pinned assignment.',403)
        attempt=receipt['attempt']
        if type(attempt) is not int or not 1<=attempt<=2**31:raise Error('Invalid cleanup attempt.',400)
        if attempt<row['attempts']:return False
        if attempt==row['attempts'] and row['state']=='blocked' and receipt['state']=='running':return False
        if row['state']=='complete':return True
        lease=db.execute('SELECT state FROM leases WHERE id=?',(row['lease'],)).fetchone()
        if not lease or lease['state'] not in ('failed','released','expired'):raise Error('Active leases cannot be reclaimed.',409)
        reason=receipt.get('reason')
        if reason is not None and (not isinstance(reason,str) or reason not in REASONS):raise Error('Invalid cleanup reason.',400)
        if any(key in receipt and type(receipt[key]) is not bool for key in ('storageRemoved','credentialsErased','executionStopped')):
            raise Error('Invalid cleanup completion flags.',400)
        if receipt['state']=='complete':
            if report['state']!='stopped' or any(receipt.get(key) is not True for key in ('storageRemoved','credentialsErased','executionStopped')):
                raise Error('Cleanup completion requires stopped execution, removed storage and erased guest credentials.',409)
            reason=None
            db.execute("UPDATE machines SET desired='stopped',observed='stopped',preparation_hash=NULL,prepared_at=0,access_ready=0 WHERE id=?",(machine_id,))
        if receipt['state']=='blocked' and reason is None:raise Error('Blocked cleanup requires a bounded reason.',400)
        # Re-sending the same observation must not keep pushing retry into the future.
        changed=attempt>row['attempts'] or receipt['state']!=row['state'] or reason!=row['reason']
        retry=self.clock()+min(60,2**min(attempt,6)) if changed and receipt['state']=='blocked' else row['next_retry'] if receipt['state']=='blocked' else 0
        db.execute('UPDATE lease_cleanup_members SET state=?,reason=?,attempts=?,next_retry=?,updated=? WHERE machine=?',
                   (receipt['state'],reason,attempt,retry,self.clock(),machine_id))
        return True
