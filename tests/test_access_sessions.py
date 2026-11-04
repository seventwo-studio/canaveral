from lease_fixture import lease_offer
import json
import secrets
import uuid

from canaveral.client import Client
from canaveral.model import Error
from canaveral.store import Store
from test_consumers import application
from test_dashboard import DashboardFixture
from test_devices import config,mobile


class AccessFixture(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.offer=lease_offer(config())
        self.host=str(uuid.uuid4());self.host_token=secrets.token_urlsafe(32)
        self.other_host=str(uuid.uuid4());self.other_host_token=secrets.token_urlsafe(32)
        for host,token in [(self.host,self.host_token),(self.other_host,self.other_host_token)]:
            self.store.enroll({'id':host,'credential':token,'offer':self.offer})
        permission={key:mobile()[key] for key in ('id','revision','arch')}
        self.a=self.store.create_consumer(application(permission));self.b=self.store.create_consumer(application(permission))
        self.lease=self.store.acquire_lease(self.a['credential'],{'id':str(uuid.uuid4()),'templateId':permission['id'],'templateRevision':'1','arch':'arm64','ttlSeconds':getattr(self,'lease_ttl',120)})
        self.machine=self.lease['members'][0]['machineId']
        owner=self.store.machines()[0]['hostId']
        if owner!=self.host:self.host,self.other_host=self.other_host,self.host;self.host_token,self.other_host_token=self.other_host_token,self.host_token
        self.token=self.store.lease_credential(self.lease['id'],self.a['credential'])['credential']
        self.client=Client(self.upstream,self.token)
        self.path='/v1/leases/'+self.lease['id']+'/sessions'

    def ready(self):
        return self.store.heartbeat(self.host,self.host_token,{'offer':self.offer,'reports':{self.machine:{'state':'running'}}})

    def create(self,**extra):
        request={'id':str(uuid.uuid4()),'member':'primary','capability':'pty',**extra}
        return self.client.request('POST',self.path,request)

    def attach(self,session,side='consumer',**extra):
        return self.store.attach_access_session(session['id'],extra.get('generation',session['generation']),side,
                                               extra.get('owner',self.host if side=='host' else self.lease['id']),
                                               extra.get('token',self.host_token if side=='host' else self.token))


class AccessSessionTests(AccessFixture):
    def test_ready_scoped_idempotent_admission_and_terminal_tombstone(self):
        with self.assertRaises(Error) as error:self.create()
        self.assertEqual(error.exception.code,'member_not_ready')
        self.ready();session=self.create();request={key:session[key] for key in ('id','member','capability')}
        self.assertEqual(self.client.request('POST',self.path,request),session)
        with self.assertRaises(Error):self.client.request('POST',self.path,{**request,'capability':'display'})
        with self.assertRaises(Error):Client(self.upstream,self.a['credential']).request('POST',self.path,{'id':str(uuid.uuid4()),'member':'primary','capability':'pty'})
        with self.assertRaises(Error):self.create(member='another')
        for capability in ('display','upload','download','accessibility'):self.assertEqual(self.create(capability=capability)['capability'],capability)
        self.assertNotIn('hostId',session);self.assertNotIn(self.host_token,json.dumps(session))
        self.assertNotIn('machineId',session)
        closed=self.client.request('POST',self.path+'/'+session['id']+'/close',{})
        self.assertEqual(closed['state'],'closed')
        self.assertEqual(self.client.request('POST',self.path+'/'+session['id']+'/close',{}),closed)
        self.assertEqual(self.client.request('POST',self.path,request)['state'],'closed')
        with self.assertRaises(Error):self.attach(session)

    def test_two_peers_exact_host_generation_and_duplicate_claims(self):
        self.ready();session=self.create()
        assigned=self.ready()['accessSessions'];self.assertEqual(assigned[0]['machineId'],self.machine)
        with self.assertRaises(Error):self.attach(session,'host',owner=self.other_host,token=self.other_host_token)
        with self.assertRaises(Error):self.attach(session,generation=str(uuid.uuid4()))
        first=self.attach(session);self.assertEqual(first['state'],'attaching')
        with self.assertRaises(Error):self.attach(session)
        second=self.attach(session,'host');self.assertEqual(second['state'],'ready')
        with self.assertRaises(Error):self.attach(session,'host')
        self.assertEqual(self.ready()['accessSessions'],[])
        with self.store.transaction() as db:
            data=json.dumps([dict(row) for row in db.execute('SELECT * FROM access_sessions')])
            self.assertNotIn(self.token,data);self.assertNotIn(self.host_token,data)

    def test_rotation_revocation_exact_attach_timeout_and_restart(self):
        self.ready();session=self.create();self.attach(session)
        self.token=self.store.lease_credential(self.lease['id'],self.a['credential'])['credential']
        self.client=Client(self.upstream,self.token)
        self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'revoked')
        next_session=self.create();self.now+=30
        self.assertEqual(self.client.request('GET',self.path+'/'+next_session['id'])['state'],'expired')
        self.ready();last=self.create();self.attach(last);self.attach(last,'host')
        restored=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(restored.get_access_session(self.lease['id'],last['id'],self.token)['state'],'disconnected')
        with self.assertRaises(Error):restored.attach_access_session(last['id'],last['generation'],'host',self.host,self.host_token)

    def test_renewal_deadline_and_lease_termination_invalidate_access(self):
        self.ready();session=self.create();self.attach(session);self.attach(session,'host')
        before=session['authorizationDeadline'];lease=self.store.get_lease(self.lease['id'],self.token)
        self.now+=10;self.ready()
        self.store.mutate_lease(lease['id'],self.token,'renew',{'id':str(uuid.uuid4()),'expectedRevision':lease['revision'],'ttlSeconds':180})
        self.assertGreater(self.client.request('GET',self.path+'/'+session['id'])['authorizationDeadline'],before)
        self.store.mutate_lease(lease['id'],self.token,'release',{'id':str(uuid.uuid4())})
        self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'revoked')
        self.assertEqual(self.store.access_sessions_live({(session['id'],session['generation'])}),set())

    def test_other_consumer_member_capability_and_host_loss_boundaries(self):
        self.ready();session=self.create()
        with self.assertRaises(Error):Client(self.upstream,self.b['credential']).request('GET',self.path+'/'+session['id'])
        with self.assertRaises(Error):self.client.request('POST',self.path,{'id':str(uuid.uuid4()),'member':'primary','capability':'host-shell'})
        self.attach(session);self.attach(session,'host')
        self.now+=30
        self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'disconnected')

    def test_runner_protocol_withdrawal_closes_access_and_blocks_new_sessions(self):
        self.ready();session=self.create();self.attach(session);self.attach(session,'host')
        self.assertTrue(self.store.access_session_frame_authorized(session['id'],session['generation']))
        self.offer.pop('leaseProtocol');self.ready()
        self.assertFalse(self.store.access_session_frame_authorized(session['id'],session['generation']))
        self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'disconnected')
        with self.assertRaises(Error):self.create()
