"""Transactional consumer lease lifecycle. Cleanup is distinct from stopping."""
import datetime
import json
import secrets
import uuid

from .consumers import capabilities
from .model import Error, digest, identifier, integer, machine_request, secret, text


ACTIVE=('provisioning','ready')


def utc(timestamp):
    return datetime.datetime.fromtimestamp(timestamp,datetime.timezone.utc).isoformat().replace('+00:00','Z')


class LeaseStore:
    def initialize_leases(self,db):
        db.execute('CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY,consumer TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,provision_deadline REAL NOT NULL,credential TEXT,cleanup TEXT NOT NULL)')
        db.execute('CREATE TABLE IF NOT EXISTS lease_members (lease TEXT NOT NULL,name TEXT NOT NULL,machine TEXT NOT NULL UNIQUE,PRIMARY KEY(lease,name))')
        db.execute('CREATE TABLE IF NOT EXISTS lease_mutations (consumer TEXT NOT NULL,lease TEXT NOT NULL,action TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(consumer,lease,action,id))')
        db.execute('CREATE INDEX IF NOT EXISTS leases_consumer ON leases(consumer,state)')

    def _end_lease(self,db,row,state):
        if row['state'] not in ACTIVE:return
        db.execute("UPDATE leases SET state=?,revision=revision+1,cleanup='pending' WHERE id=?",(state,row['id']))
        self._close_consumer_operations(db,row['id'])
        for member in db.execute('SELECT machine FROM lease_members WHERE lease=?',(row['id'],)):
            db.execute("UPDATE machines SET desired='stopped' WHERE id=?",(member['machine'],))
            db.execute("UPDATE device_operations SET state='failed',result=?,updated=? WHERE machine=? AND state='queued'",
                       (json.dumps({'detail':'Lease ended before operation completion; any in-flight effects require inspection.'}),self.clock(),member['machine']))
        self._ensure_lease_cleanup(db,row['id'])

    def _refresh_leases(self,db):
        now=self.clock()
        for row in db.execute("SELECT * FROM leases WHERE state IN ('provisioning','ready')").fetchall():
            principal=db.execute('SELECT revoked FROM consumers WHERE id=?',(row['consumer'],)).fetchone()
            if not principal or principal['revoked']:
                self._end_lease(db,row,'released');continue
            if now>=row['expires']:
                self._end_lease(db,row,'expired');continue
            members=db.execute('SELECT m.*,h.seen FROM machines m JOIN lease_members l ON l.machine=m.id JOIN hosts h ON h.id=m.host WHERE l.lease=?',(row['id'],)).fetchall()
            if any(m['observed']=='error' or m['preparation_state']=='failed' for m in members) or (row['state']=='provisioning' and now>=row['provision_deadline']):
                self._end_lease(db,row,'failed');continue
            if row['state']=='provisioning' and members and all(self._machine(m,now-m['seen']<self.lease_seconds)['ready'] for m in members):
                db.execute("UPDATE leases SET state='ready',revision=revision+1 WHERE id=?",(row['id'],))
        self._refresh_lease_cleanup(db)

    def _lease_access(self,db,lease_id,token,consumer_only=False):
        lease_id=identifier(lease_id)
        try:secret(token)
        except Error:raise Error('Lease credential rejected.',401)
        row=db.execute('SELECT * FROM leases WHERE id=?',(lease_id,)).fetchone()
        consumer=db.execute('SELECT * FROM consumers WHERE credential=? AND revoked=0',(digest(token),)).fetchone()
        if consumer:
            if not row or row['consumer']!=consumer['id']:raise Error('Unknown lease.',404)
            return row,consumer
        if not consumer_only and row and row['credential'] and secrets.compare_digest(row['credential'],digest(token)):
            consumer=db.execute('SELECT * FROM consumers WHERE id=? AND revoked=0',(row['consumer'],)).fetchone()
            if consumer:return row,consumer
        raise Error('Lease credential rejected.',401)

    def _lease_view(self,db,row):
        members=[]
        for m in db.execute('SELECT m.*,h.seen,l.name AS member_name FROM machines m JOIN lease_members l ON l.machine=m.id JOIN hosts h ON h.id=m.host WHERE l.lease=? ORDER BY l.name',(row['id'],)):
            machine=self._machine(m,self.clock()-m['seen']<self.lease_seconds)
            members.append({'name':m['member_name'],'machineId':m['id'],'state':machine['observed'],'ready':machine['ready'] and row['state'] in ACTIVE,
                            'capabilities':capabilities(machine['template']),'resources':machine['resources']})
            cleanup=self._lease_cleanup(db,m['id'])
            if cleanup:members[-1]['cleanup']=self._cleanup_view(cleanup)
        return {'id':row['id'],'state':row['state'],'runtimeState':members[0]['state'] if len(members)==1 else 'unknown',
                'revision':row['revision'],'createdAt':utc(row['created']),'expiresAt':utc(row['expires']),
                'cleanup':{'state':row['cleanup']},'members':members,
                'capabilities':members[0]['capabilities'] if len(members)==1 else {}}

    def acquire_lease(self,token,value,with_status=False):
        if not isinstance(value,dict) or set(value)-{'id','name','templateId','templateRevision','arch','resources','ttlSeconds','requiredCapabilities'}:
            raise Error('Invalid lease acquisition.',400)
        lease_id=identifier(value.get('id'))
        with self.transaction() as db:
            consumer=self._authenticate_consumer(db,token);policy=json.loads(consumer['specification'])
            ttl=integer(value.get('ttlSeconds',policy['limits']['defaultTTLSeconds']),'lease TTL',policy['limits']['maxTTLSeconds'])
            request=machine_request({**value,'id':str(uuid.uuid5(uuid.UUID(lease_id),'primary')),'name':value.get('name','lease-'+lease_id)})
            if 'templateRevision' not in request or 'arch' not in request:raise Error('Lease image revision and architecture must be explicit.',400)
            required=value.get('requiredCapabilities',[])
            if not isinstance(required,list) or any(not isinstance(k,str) or k not in capabilities({'os':'linux','mode':'headless'}) for k in required) or len(set(required))!=len(required):
                raise Error('Invalid required capabilities.',400)
            frozen={'machine':request,'ttlSeconds':ttl,'requiredCapabilities':sorted(required)}
            old=db.execute('SELECT * FROM leases WHERE id=?',(lease_id,)).fetchone()
            if old:
                if old['consumer']!=consumer['id']:raise Error('Unknown lease.',404)
                if json.loads(old['request'])!=frozen:raise Error('Lease ID already belongs to another acquisition.',409)
                view=self._lease_view(db,old)
                return (view,False) if with_status else view
            allowed={'id':request['templateId'],'revision':request['templateRevision'],'arch':request['arch']}
            if allowed not in policy['templates']:raise Error('Image is not permitted for this application.',403)
            image=json.loads(db.execute('SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?',tuple(allowed[k] for k in ('id','revision','arch'))).fetchone()[0])
            if any(not capabilities(image)[key] for key in required):raise Error('Required capability is unsupported by this image.',409,code='capability_unsupported')
            count=db.execute("SELECT COUNT(*) FROM leases WHERE consumer=? AND state IN ('provisioning','ready')",(consumer['id'],)).fetchone()[0]
            if count>=policy['limits']['activeLeases']:raise Error('Application active lease limit exceeded.',429)
            if db.execute('SELECT 1 FROM machines WHERE id=?',(request['id'],)).fetchone():raise Error('Lease machine identity already exists.',409)
            try:machine=self._create_machine(db,request,leased=True)
            except Error as error:
                if str(error).startswith('No online accepting host'):raise Error('No eligible lease-capable host has capacity.',503,code='capacity_unavailable')
                raise
            now=self.clock();expires=now+ttl
            db.execute("INSERT INTO leases VALUES (?,?,?,'provisioning',1,?,?,?,?, 'notRequested')",(lease_id,consumer['id'],json.dumps(frozen),now,expires,now+policy['limits']['provisioningTimeoutSeconds'],None))
            db.execute('INSERT INTO lease_members VALUES (?,?,?)',(lease_id,'primary',machine['id']))
            used={'cpu':0,'memoryMiB':0,'diskGiB':0}
            for m in db.execute('SELECT m.* FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN leases l ON l.id=lm.lease WHERE l.consumer=?',(consumer['id'],)):
                if self._deleted(db,m['id']):continue
                size=json.loads(m['request'])['resources'];used['diskGiB']+=size['diskGiB']
                if self._compute_reserved(db,m):
                    for key in ('cpu','memoryMiB'):used[key]+=size[key]
            if any(used[key]>policy['limits']['resources'][key] for key in used):raise Error('Application resource limit exceeded.',429)
            view=self._lease_view(db,db.execute('SELECT * FROM leases WHERE id=?',(lease_id,)).fetchone())
            return (view,True) if with_status else view

    def get_lease(self,lease_id,token):
        with self.transaction() as db:
            row,_=self._lease_access(db,lease_id,token)
            return self._lease_view(db,row)

    def list_leases(self,token,after=None):
        if after is not None:after=identifier(after)
        with self.transaction() as db:
            consumer=self._authenticate_consumer(db,token)
            rows=db.execute('SELECT * FROM leases WHERE consumer=? AND id>? ORDER BY id LIMIT 101',(consumer['id'],after or '')).fetchall()
            return {'leases':[self._lease_view(db,row) for row in rows[:100]],'nextCursor':rows[99]['id'] if len(rows)>100 else None}

    def lease_credential(self,lease_id,token):
        with self.transaction() as db:
            row,_=self._lease_access(db,lease_id,token,consumer_only=True)
            if row['state'] not in ACTIVE:raise Error('Lease has ended.',410)
            credential=secrets.token_urlsafe(32)
            db.execute('UPDATE leases SET credential=? WHERE id=?',(digest(credential),row['id']))
            return {'id':row['id'],'credential':credential}

    def mutate_lease(self,lease_id,token,action,value):
        fields={'id','expectedRevision','ttlSeconds'} if action=='renew' else {'id'}
        if not isinstance(value,dict) or set(value)!=fields:raise Error('Invalid lease mutation.',400)
        mutation=identifier(value['id'])
        with self.transaction() as db:
            row,consumer=self._lease_access(db,lease_id,token)
            key=(consumer['id'],row['id'],action,mutation)
            old=db.execute('SELECT * FROM lease_mutations WHERE consumer=? AND lease=? AND action=? AND id=?',key).fetchone()
            if old:
                if json.loads(old['request'])!=value:raise Error('Mutation ID already belongs to another request.',409)
                return {'mutation':json.loads(old['result']),'lease':self._lease_view(db,row)}
            if action=='renew':
                limits=json.loads(consumer['specification'])['limits']
                ttl=integer(value['ttlSeconds'],'lease TTL',limits['maxTTLSeconds'])
                revision=integer(value['expectedRevision'],'lease revision',2**53)
                if row['state'] not in ACTIVE:raise Error('Ended leases cannot be renewed.',409)
                if revision!=row['revision']:raise Error('Lease revision changed.',409)
                expires=max(row['expires'],min(self.clock()+ttl,row['created']+limits['maxLifetimeSeconds']))
                db.execute('UPDATE leases SET expires=?,revision=revision+1 WHERE id=?',(expires,row['id']))
            else:self._end_lease(db,row,'released')
            current=db.execute('SELECT * FROM leases WHERE id=?',(row['id'],)).fetchone()
            result={'id':mutation,'state':current['state'],'revision':current['revision'],'expiresAt':utc(current['expires'])}
            db.execute('INSERT INTO lease_mutations VALUES (?,?,?,?,?,?)',(*key,json.dumps(value),json.dumps(result)))
            return {'mutation':result,'lease':self._lease_view(db,current)}

    def _leased_assignment(self,db,machine):
        row=db.execute('SELECT l.* FROM leases l JOIN lease_members m ON m.lease=l.id WHERE m.machine=?',(machine['id'],)).fetchone()
        if row:
            machine['lease']={'id':row['id'],'state':row['state'],'revision':row['revision'],'authorizationDeadline':row['expires'],'controllerNow':self.clock(),'cleanup':row['cleanup']}
        return machine
