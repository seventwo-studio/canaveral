import concurrent.futures
import json
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path

from canaveral.client import Client
from canaveral.model import Error
from canaveral.store import Store
from test_dashboard import DashboardFixture
from test_inference import inference, job_request_value
from test_orchestration import host_offer, request


class HostLimitTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.now=1000
        self.store=Store(Path(self.temp.name)/'db',clock=lambda:self.now)
        self.host=str(uuid.uuid4());self.token=secrets.token_urlsafe(32)
        self.offer={**host_offer(),'inference':inference()}
        self.store.enroll({'id':self.host,'credential':self.token,'offer':self.offer})

    def save(self,**changes):
        return self.store.save_host_limits(self.host,{'limits':{**self.offer['capacity'],**changes}})

    def beat(self,**changes):
        return self.store.heartbeat(self.host,self.token,{'offer':self.offer,**changes})

    def test_defaults_and_saved_limits_survive_heartbeat_reenrollment_and_restart(self):
        self.assertEqual(self.store.hosts()[0]['limits'],self.offer['capacity'])
        saved=self.save(cpu=2)
        self.offer={**self.offer,'capacity':{'cpu':100,'memoryMiB':100000,'diskGiB':1000}}
        self.beat(limits=self.offer['capacity'])
        self.store.enroll({'id':self.host,'credential':self.token,'offer':self.offer})
        restored=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(restored.host_resources(self.host)['limits'],saved['limits'])
        self.assertEqual(restored.hosts()[0]['available']['cpu'],2)

    def test_each_resource_limits_admission_independently(self):
        for changes in ({'cpu':1},{'memoryMiB':1024},{'diskGiB':9}):
            with self.subTest(changes=changes):
                self.save(**changes)
                with self.assertRaises(Error):self.store.create(request(hostId=self.host))
        self.save(cpu=2,memoryMiB=2048,diskGiB=10)
        self.store.create(request(hostId=self.host))
        with self.assertRaises(Error):self.store.create(request(hostId=self.host))

    def test_parallel_vm_and_inference_admission_obeys_one_host_limit(self):
        self.save(cpu=2)
        def acquire(index):
            try:return self.store.create(request()) if index%2 else self.store.create_job(job_request_value())
            except Error:return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            admitted=list(filter(None,pool.map(acquire,range(20))))
        self.assertEqual(len(admitted),1)
        self.assertEqual(self.store.hosts()[0]['reserved']['cpu'],2)

    def test_limits_are_independent_and_cannot_increase_the_hosts_offer(self):
        self.save(cpu=1)
        other=str(uuid.uuid4())
        self.store.enroll({'id':other,'credential':secrets.token_urlsafe(32),'offer':self.offer})
        self.assertEqual(self.store.create(request())['hostId'],other)
        self.save(cpu=100,memoryMiB=100000,diskGiB=1000)
        self.assertEqual(self.store.host_resources(self.host)['available'],self.offer['capacity'])
        self.offer={**self.offer,'capacity':{'cpu':1,'memoryMiB':1024,'diskGiB':5}}
        self.beat()
        self.assertEqual(self.store.host_resources(self.host)['available'],self.offer['capacity'])

    def test_lowering_limits_preserves_allocations_and_confirmed_stop_is_required(self):
        machine=self.store.create(request())
        self.save(cpu=1,diskGiB=10)
        self.assertTrue(self.store.hosts()[0]['overcommitted'])
        self.assertEqual(self.store.hosts()[0]['reserved']['cpu'],2)
        self.store.desired(machine['id'],'stopped')
        self.assertEqual(self.store.hosts()[0]['reserved']['cpu'],2)
        self.beat(reports={machine['id']:{'state':'stopped'}})
        self.assertEqual(self.store.hosts()[0]['reserved'],{'cpu':0,'memoryMiB':0,'diskGiB':10})
        with self.assertRaises(Error):self.store.desired(machine['id'],'running')
        with self.assertRaises(Error):self.store.create(request())
        self.assertEqual(self.store.machines()[0]['id'],machine['id'])
        self.save(cpu=2)
        self.store.desired(machine['id'],'running')
        self.now+=31
        self.assertEqual(self.store.hosts()[0]['reserved']['cpu'],2)

    def test_image_import_and_capture_use_host_disk_limit(self):
        self.save(diskGiB=1)
        metadata={'id':str(uuid.uuid4()),'name':'Image','os':'linux','arch':'amd64','mode':'headless','mediaType':'disk','format':'raw','minimum':{'cpu':1,'memoryMiB':1024,'diskGiB':1}}
        self.store.reserve_image_import(self.host,metadata,512)
        with self.assertRaises(Error):self.store.reserve_image_import(self.host,{**metadata,'id':str(uuid.uuid4())},512)
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],1)
        self.save(diskGiB=20)
        machine=self.store.create(request())
        self.store.desired(machine['id'],'stopped');self.beat(reports={machine['id']:{'state':'stopped'}})
        self.save(diskGiB=11)
        with self.assertRaises(Error):self.store.create_image_capture({'id':str(uuid.uuid4()),'machineId':machine['id'],'name':'Capture'})

    def test_invalid_limits_leave_state_intact_and_unknown_hosts_are_rejected(self):
        original=self.store.hosts()[0]['limits']
        for value in ({},{'limits':{}},{'limits':{**original,'cpu':0}},{'limits':{**original,'cpu':True}},{'limits':{**original,'cpu':1.5}},{'limits':original,'hostId':self.host}):
            with self.subTest(value=value):
                with self.assertRaises(Error):self.store.save_host_limits(self.host,value)
        with self.assertRaises(Error) as error:self.store.save_host_limits(str(uuid.uuid4()),{'limits':original})
        self.assertEqual(error.exception.status,404)
        self.assertEqual(self.store.hosts()[0]['limits'],original)

    def test_old_shared_budget_rows_do_not_constrain_hosts_and_legacy_host_limits_are_seeded_once(self):
        with self.store.transaction() as db:
            db.execute('CREATE TABLE resource_budgets (id TEXT PRIMARY KEY,name TEXT,capacity TEXT)')
            db.execute('CREATE TABLE resource_budget_members (budget TEXT,host TEXT)')
            db.execute('INSERT INTO resource_budgets VALUES (?,?,?)',('old','Old shared allowance',json.dumps({'cpu':1,'memoryMiB':1,'diskGiB':1})))
            db.execute('INSERT INTO resource_budget_members VALUES (?,?)',('old',self.host))
            db.execute('DELETE FROM host_limits')
        restored=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(restored.hosts()[0]['limits'],self.offer['capacity'])
        restored.create(request())
        self.assertNotIn('sharedBudgets',restored.hosts()[0])
        self.assertNotIn('budget',restored.host_resources(self.host))


class HostLimitAPITests(DashboardFixture):
    def test_host_limits_require_current_admin_authority_and_cookie_csrf(self):
        from canaveral.accounts import Accounts
        accounts=Accounts(self.store)
        admin=accounts.setup({'username':'admin','password':'disposable-host-limit-password'})
        pending=accounts.create_user(self.admin,{'id':str(uuid.uuid4()),'username':'host-limit-user'},True)
        claim=accounts.issue_claim(self.admin,'invite',pending['id'],True)
        user=accounts.redeem({'token':claim['token'],'password':'disposable-host-limit-password'})
        host,_,offered=self.enroll()
        value={'limits':offered['capacity']}
        path='/api/v1/hosts/'+host+'/limits'
        self.assertEqual(self.fetch(path,value,user['token'])[0],403)
        cookie={'Cookie':'canaveral_session='+admin['token']}
        self.assertEqual(self.fetch(path,value,headers=cookie)[0],403)
        self.assertEqual(self.fetch(path,value,headers={**cookie,'Origin':self.url})[0],200)

    def test_admin_limits_endpoint_and_removed_budget_routes(self):
        host,credential,offered=self.enroll()
        path='/api/v1/hosts/'+host+'/limits'
        value={'limits':{**offered['capacity'],'cpu':1}}
        for token in (None,self.enrollment,credential):
            self.assertEqual(self.fetch(path,value,token)[0],401)
        self.assertEqual(self.fetch(path,value,self.admin,{'Origin':'https://example.com'})[0],403)
        status,_,body=self.fetch(path,value,self.admin,{'Origin':self.url})
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body),{'hostId':host,**value})
        self.assertEqual(json.loads(self.fetch('/api/v1/hosts/'+host+'/resources',token=self.admin)[2])['limits'],value['limits'])
        admin=Client(self.upstream,self.admin)
        for method in ('GET','POST'):
            with self.assertRaises(Error) as error:admin.request(method,'/v1/resource-budgets',{} if method=='POST' else None)
            self.assertEqual(error.exception.status,404)
            self.assertEqual(self.fetch('/api/v1/resource-budgets',{} if method=='POST' else None,self.admin)[0],404)
