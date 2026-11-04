from lease_fixture import lease_offer
import concurrent.futures
import copy
import json
import secrets
import uuid
import urllib.request
import urllib.error

from canaveral.client import Client
from canaveral.model import Error
from canaveral.store import Store
from test_consumers import application
from test_dashboard import DashboardFixture
from test_orchestration import host_offer


def acquire(**extra):
    return {'id':str(uuid.uuid4()),'templateId':'linux','templateRevision':'1','arch':'amd64','ttlSeconds':60,**extra}


class LeaseTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.offer=lease_offer(host_offer());self.host=str(uuid.uuid4());self.host_token=secrets.token_urlsafe(32)
        self.store.enroll({'id':self.host,'credential':self.host_token,'offer':self.offer})
        self.a=self.store.create_consumer(application());self.b=self.store.create_consumer(application())
        self.client=Client(self.upstream,self.a['credential']);self.other=Client(self.upstream,self.b['credential'])

    def beat(self,**extra):return self.store.heartbeat(self.host,self.host_token,{'offer':self.offer,**extra})

    def test_acquisition_ownership_credentials_and_idempotent_terminal_tombstone(self):
        request=acquire();lease=self.client.request('POST','/v1/leases',request);id=lease['id']
        self.assertEqual(lease['state'],'provisioning');self.assertEqual(len(self.store.machines()),1)
        self.assertEqual(self.client.request('POST','/v1/leases',request)['id'],id)
        for body in ({**request,'ttlSeconds':61},):
            with self.assertRaises(Error) as raised:self.client.request('POST','/v1/leases',body)
            self.assertEqual(raised.exception.status,409)
        for action in (lambda:self.other.request('GET','/v1/leases/'+id),lambda:self.other.request('POST','/v1/leases',request)):
            with self.assertRaises(Error) as raised:action()
            self.assertEqual(raised.exception.status,404)
        self.assertEqual(self.other.request('GET','/v1/leases')['leases'],[])
        token=self.client.request('POST','/v1/leases/'+id+'/credential',{})['credential'];scoped=Client(self.upstream,token)
        self.assertEqual(scoped.request('GET','/v1/leases/'+id)['id'],id)
        with self.assertRaises(Error):scoped.request('GET','/v1/leases')
        with self.assertRaises(Error):scoped.request('POST','/v1/leases/'+id+'/credential',{})
        self.client.request('POST','/v1/leases/'+id+'/credential',{})
        with self.assertRaises(Error):scoped.request('GET','/v1/leases/'+id)
        release={'id':str(uuid.uuid4())};ended=self.client.request('POST','/v1/leases/'+id+'/release',release)
        self.assertEqual(ended['lease']['state'],'released');self.assertEqual(ended['lease']['cleanup']['state'],'pending')
        self.assertEqual(self.client.request('POST','/v1/leases/'+id+'/release',release)['mutation'],ended['mutation'])
        self.assertEqual(self.client.request('POST','/v1/leases',request)['state'],'released')
        self.assertEqual(len(self.store.machines()),1)
        with self.store.transaction() as db:
            self.assertNotIn(token,json.dumps([dict(row) for row in db.execute('SELECT * FROM leases')]))

    def test_renewal_receipts_exact_expiry_and_restart_keep_reserved_disks(self):
        lease=self.store.acquire_lease(self.a['credential'],acquire());id=lease['id'];machine=lease['members'][0]['machineId']
        self.beat(reports={machine:{'state':'running'}})
        ready=self.store.get_lease(id,self.a['credential']);self.assertEqual(ready['state'],'ready')
        self.now+=10
        body={'id':str(uuid.uuid4()),'expectedRevision':ready['revision'],'ttlSeconds':120}
        renewed=self.store.mutate_lease(id,self.a['credential'],'renew',body)
        old=self.store.mutate_lease(id,self.a['credential'],'renew',body);self.assertEqual(renewed['mutation'],old['mutation'])
        with self.assertRaises(Error):self.store.mutate_lease(id,self.a['credential'],'renew',{**body,'id':str(uuid.uuid4())})
        self.now=1130
        with self.assertRaises(Error):self.store.mutate_lease(id,self.a['credential'],'renew',{'id':str(uuid.uuid4()),'expectedRevision':renewed['lease']['revision'],'ttlSeconds':60})
        restored=Store(self.store.path,clock=lambda:self.now)
        expired=restored.get_lease(id,self.a['credential']);self.assertEqual(expired['state'],'expired')
        self.assertEqual(expired['runtimeState'],'unknown');self.assertEqual(expired['cleanup']['state'],'pending')
        self.assertEqual(restored.host_resources(self.host)['reserved']['diskGiB'],4)
        # A late running receipt never restores consumer access or releases capacity.
        restored.heartbeat(self.host,self.host_token,{'offer':self.offer,'reports':{machine:{'state':'running'}}})
        self.assertEqual(restored.get_lease(id,self.a['credential'])['state'],'expired')
        restored.heartbeat(self.host,self.host_token,{'offer':self.offer,'reports':{machine:{'state':'stopped'}}})
        self.assertEqual(restored.host_resources(self.host)['reserved']['cpu'],1)
        self.assertEqual(restored.host_resources(self.host)['reserved']['diskGiB'],4)
        self.assertEqual(restored.get_lease(id,self.a['credential'])['cleanup']['state'],'pending')

    def test_concurrent_quota_admission_rolls_back_machines(self):
        spec=application();spec['limits']['activeLeases']=1
        consumer=self.store.create_consumer(spec)
        def attempt(_):
            try:return Client(self.upstream,consumer['credential']).request('POST','/v1/leases',acquire())
            except Error as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(attempt,range(2)))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1);self.assertIn(429,results)
        self.assertEqual(len(self.store.machines()),1)
        # Resource rejection must roll back the placement as well as the lease.
        spec=application();spec['limits']['resources']['diskGiB']=1
        consumer=self.store.create_consumer(spec)
        with self.assertRaises(Error) as raised:self.store.acquire_lease(consumer['credential'],acquire())
        self.assertEqual(raised.exception.status,429);self.assertEqual(len(self.store.machines()),1)

    def test_protocol_capability_gate_revocation_and_provisioning_deadline(self):
        with self.assertRaises(Error):self.store.acquire_lease(self.a['credential'],acquire(requiredCapabilities=['displayStream']))
        self.offer.pop('leaseProtocol');self.beat()
        with self.assertRaises(Error) as raised:self.store.acquire_lease(self.a['credential'],acquire())
        self.assertEqual(raised.exception.status,503)
        self.offer['leaseProtocol']=1;self.beat()
        lease=self.store.acquire_lease(self.a['credential'],acquire(ttlSeconds=1800))
        self.now+=900
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['state'],'failed')
        self.beat();lease=self.store.acquire_lease(self.b['credential'],acquire())
        self.store.consumer_credential(self.b['id'],revoke=True)
        with self.assertRaises(Error):self.store.get_lease(lease['id'],self.b['credential'])
        with self.store.transaction() as db:
            row=db.execute('SELECT state,cleanup FROM leases WHERE id=?',(lease['id'],)).fetchone()
            self.assertEqual(tuple(row),('released','pending'))

    def test_http_status_error_contract_and_no_administrative_resurrection(self):
        request=acquire();body=json.dumps(request).encode()
        for expected in (201,200):
            req=urllib.request.Request(self.upstream+'/v1/leases',data=body,headers={'Authorization':'Bearer '+self.a['credential'],'Content-Type':'application/json'})
            with urllib.request.urlopen(req) as response:self.assertEqual(response.status,expected)
        lease=self.store.get_lease(request['id'],self.a['credential'])
        self.store.mutate_lease(lease['id'],self.a['credential'],'release',{'id':str(uuid.uuid4())})
        with self.assertRaises(Error):self.store.desired(lease['members'][0]['machineId'],'running')
        req=urllib.request.Request(self.upstream+'/v1/leases',data=json.dumps(acquire(requiredCapabilities=['displayStream'])).encode(),headers={'Authorization':'Bearer '+self.a['credential']})
        with self.assertRaises(urllib.error.HTTPError) as raised:urllib.request.urlopen(req)
        error=json.loads(raised.exception.read());raised.exception.close()
        self.assertEqual(error['code'],'capability_unsupported');self.assertFalse(error['retryable'])
        self.assertEqual(str(uuid.UUID(error['requestId'])),error['requestId'])
