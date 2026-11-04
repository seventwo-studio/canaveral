"""Persisted, lease-scoped outbound session admission and attachment ownership."""
import json
import contextlib
import secrets
import sqlite3
import uuid

from .consumers import capabilities
from .lease_store import ACTIVE, utc
from .model import Error, identifier, digest
from .lease_eligibility import lease_eligible


LIVE=('pending','attaching','ready')
CAPABILITIES={'pty':'pty','display':'displayStream','upload':'files','download':'files','accessibility':'hierarchy'}


class AccessSessionStore:
    def initialize_access_sessions(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS access_sessions (id TEXT PRIMARY KEY,lease TEXT NOT NULL,machine TEXT NOT NULL,host TEXT NOT NULL,request TEXT NOT NULL,generation TEXT NOT NULL,credential TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,attach_deadline REAL NOT NULL,deadline REAL NOT NULL,consumer_attached INTEGER NOT NULL DEFAULT 0,host_attached INTEGER NOT NULL DEFAULT 0)')
        db.execute('CREATE INDEX IF NOT EXISTS access_sessions_host_state ON access_sessions(host,state)')
        # A restarted controller has no surviving socket pairs. Never resurrect
        # a persisted claim just because its lease is still valid.
        db.execute("UPDATE access_sessions SET state='disconnected' WHERE state IN ('pending','attaching','ready')")

    def _refresh_access_sessions(self,db):
        now=self.clock()
        for row in db.execute("SELECT s.*,l.state AS lease_state,l.credential AS current_credential,l.expires,c.revoked,m.host AS current_host FROM access_sessions s JOIN leases l ON l.id=s.lease JOIN consumers c ON c.id=l.consumer JOIN machines m ON m.id=s.machine WHERE s.state IN ('pending','attaching','ready')").fetchall():
            state=None
            if row['revoked'] or row['current_credential']!=row['credential']:state='revoked'
            elif row['lease_state']=='expired' or now>=row['expires']:state='expired'
            elif row['lease_state'] not in ACTIVE:state='revoked'
            elif row['state']!='ready' and now>=row['attach_deadline']:state='expired'
            else:
                machine=db.execute('SELECT m.*,h.seen,h.offer AS host_offer FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?',(row['machine'],)).fetchone()
                if row['current_host']!=row['host'] or not lease_eligible(json.loads(machine['host_offer']),json.loads(machine['template'])) or not self._machine(machine,now-machine['seen']<self.lease_seconds)['ready'] or machine['desired']!='running' or self._deletion(db,machine['id']):state='disconnected'
            db.execute('UPDATE access_sessions SET state=?,deadline=? WHERE id=?',(state or row['state'],row['expires'],row['id']))

    def _session_lease(self,db,lease_id,token):
        row,_=self._lease_access(db,lease_id,token)
        if not row['credential'] or not secrets.compare_digest(row['credential'],digest(token)):
            raise Error('A lease-scoped credential is required for guest access.',403,code='lease_credential_required')
        return row

    def _access_session_view(self,row):
        return {'id':row['id'],'leaseId':row['lease'],'member':json.loads(row['request'])['member'],
                'capability':json.loads(row['request'])['capability'],'generation':row['generation'],
                'protocol':'canaveral-session-v1','state':row['state'],'createdAt':utc(row['created']),
                'attachBefore':utc(row['attach_deadline']),'authorizationDeadline':utc(row['deadline'])}

    def create_access_session(self,lease_id,token,value,with_status=False):
        if not isinstance(value,dict) or set(value)!={'id','member','capability'} or not isinstance(value.get('capability'),str) or value['capability'] not in CAPABILITIES or not isinstance(value.get('member'),str):
            raise Error('Session requires id, explicit member and supported capability.',400)
        session_id=identifier(value['id']);lease_id=identifier(lease_id)
        with self.transaction() as db:
            lease=self._session_lease(db,lease_id,token)
            old=db.execute('SELECT * FROM access_sessions WHERE id=?',(session_id,)).fetchone()
            if old:
                if old['lease']!=lease_id:raise Error('Unknown session.',404)
                if json.loads(old['request'])!=value:raise Error('Session identity belongs to another request.',409)
                result=self._access_session_view(old)
                return (result,False) if with_status else result
            if lease['state'] not in ACTIVE:raise Error('Lease has ended.',410)
            machine=db.execute('SELECT m.*,h.seen,h.offer AS host_offer FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN hosts h ON h.id=m.host WHERE lm.lease=? AND lm.name=?',(lease_id,value['member'])).fetchone()
            if not machine:raise Error('Unknown environment member.',404)
            if not capabilities(json.loads(machine['template']))[CAPABILITIES[value['capability']]]:
                raise Error('Requested session capability is unsupported.',409,code='capability_unsupported')
            if lease['state']!='ready' or not lease_eligible(json.loads(machine['host_offer']),json.loads(machine['template'])) or machine['desired']!='running' or not self._machine(machine,self.clock()-machine['seen']<self.lease_seconds)['ready']:
                raise Error('Environment member is not ready for access.',409,code='member_not_ready')
            now=self.clock()
            db.execute("INSERT INTO access_sessions VALUES (?,?,?,?,?,?,?,'pending',?,?,?,0,0)",
                       (session_id,lease_id,machine['id'],machine['host'],json.dumps(value),str(uuid.uuid4()),lease['credential'],now,now+30,lease['expires']))
            result=self._access_session_view(db.execute('SELECT * FROM access_sessions WHERE id=?',(session_id,)).fetchone())
            return (result,True) if with_status else result

    def get_access_session(self,lease_id,session_id,token):
        with self.transaction() as db:
            self._session_lease(db,lease_id,token)
            row=db.execute('SELECT * FROM access_sessions WHERE id=? AND lease=?',(identifier(session_id),identifier(lease_id))).fetchone()
            if not row:raise Error('Unknown session.',404)
            return self._access_session_view(row)

    def close_access_session(self,lease_id,session_id,token):
        with self.transaction() as db:
            self._session_lease(db,lease_id,token)
            row=db.execute('SELECT * FROM access_sessions WHERE id=? AND lease=?',(identifier(session_id),identifier(lease_id))).fetchone()
            if not row:raise Error('Unknown session.',404)
            if row['state'] in LIVE:db.execute("UPDATE access_sessions SET state='closed' WHERE id=?",(row['id'],))
            return self._access_session_view(db.execute('SELECT * FROM access_sessions WHERE id=?',(row['id'],)).fetchone())

    def attach_access_session(self,session_id,generation,side,owner_id,token):
        if side not in ('host','consumer'):raise Error('Invalid session peer.',400)
        session_id=identifier(session_id);generation=identifier(generation);owner_id=identifier(owner_id)
        with self.transaction() as db:
            if side=='host':self._authenticate(db,owner_id,token)
            else:self._session_lease(db,owner_id,token)
            row=db.execute('SELECT * FROM access_sessions WHERE id=?',(session_id,)).fetchone()
            if not row or row['host' if side=='host' else 'lease']!=owner_id:raise Error('Unknown session.',404)
            if row['generation']!=generation:raise Error('Session generation changed.',409)
            if row['state'] not in LIVE:raise Error('Session has ended. Negotiate a new session identity.',410)
            column='host_attached' if side=='host' else 'consumer_attached'
            if row[column]:raise Error('This session peer is already attached.',409)
            other=row['consumer_attached' if side=='host' else 'host_attached']
            db.execute('UPDATE access_sessions SET '+column+'=1,state=? WHERE id=?',('ready' if other else 'attaching',session_id))
            return self._access_session_view(db.execute('SELECT * FROM access_sessions WHERE id=?',(session_id,)).fetchone())

    def disconnect_access_session(self,session_id,generation):
        with self.transaction() as db:
            db.execute("UPDATE access_sessions SET state='disconnected' WHERE id=? AND generation=? AND state IN ('pending','attaching','ready')",(identifier(session_id),identifier(generation)))

    def access_sessions_live(self,identities):
        with contextlib.closing(sqlite3.connect(self.path,timeout=2)) as db:
            db.row_factory=sqlite3.Row
            return {(row['session_id'],row['generation']) for row in self._session_authorization_rows(db)
                    if (row['session_id'],row['generation']) in identities and self._session_row_authorized(row,row['generation'])}

    def _session_authorization_rows(self,db,session_id=None):
        query='SELECT m.*,h.seen,h.offer AS host_offer,s.id AS session_id,s.state AS session_state,s.generation,s.host AS session_host,s.credential AS session_credential,s.attach_deadline,l.state AS lease_state,l.expires,l.credential AS lease_credential,c.revoked FROM access_sessions s JOIN leases l ON l.id=s.lease JOIN consumers c ON c.id=l.consumer JOIN machines m ON m.id=s.machine JOIN hosts h ON h.id=m.host'
        return db.execute(query+(' WHERE s.id=?' if session_id else " WHERE s.state IN ('pending','attaching','ready')"),(session_id,) if session_id else ())

    def _session_row_authorized(self,row,generation,ready=False):
        if not row:return False
        now=self.clock()
        return (row['generation']==generation and row['session_state'] in (('ready',) if ready else LIVE)
                and (row['session_state']=='ready' or now<row['attach_deadline'])
                and row['lease_state'] in ACTIVE and now<row['expires'] and not row['revoked']
                and row['session_credential']==row['lease_credential'] and row['session_host']==row['host']
                and lease_eligible(json.loads(row['host_offer']),json.loads(row['template'])) and row['desired']=='running'
                and self._machine(row,now-row['seen']<self.lease_seconds)['ready'])

    def access_session_frame_authorized(self,session_id,generation):
        # Payloads need a fresh authorization snapshot without a global write
        # transaction or a scan of other sessions for every 4 KiB of file data.
        with contextlib.closing(sqlite3.connect(self.path,timeout=2)) as db:
            db.row_factory=sqlite3.Row
            return self._session_row_authorized(self._session_authorization_rows(db,session_id).fetchone(),generation,ready=True)

    def _assigned_access_sessions(self,db,host_id):
        # Delivery batching bounds heartbeat size, without limiting how many
        # independent sessions a caller can create. Claimed peers leave the batch.
        return [{**self._access_session_view(row),'machineId':row['machine'],'controllerNow':self.clock()} for row in db.execute("SELECT * FROM access_sessions WHERE host=? AND host_attached=0 AND state IN ('pending','attaching') ORDER BY created,id LIMIT 100",(host_id,))]
