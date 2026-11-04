import copy
import json
import threading
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

from canaveral.client import Client
from canaveral.host import Agent
from canaveral.lease_clock import execution_monotonic
from canaveral.model import Error
from canaveral.providers.mobile import Mobile
from canaveral.sdk import LeaseClient
from canaveral.store import Store
from test_access_sessions import AccessFixture


class ConsumerOperationTests(AccessFixture):
    def setUp(self):
        super().setUp()
        self.route='/v1/leases/'+self.lease['id']+'/operations'
        self.scoped=LeaseClient(self.upstream,self.lease['id'],self.token)

    def command(self,**extra):
        return {'id':str(uuid.uuid4()),'member':'primary','action':'tap','arguments':{'x':10,'y':20},**extra}

    def submit(self,request):
        return self.client.request('POST',self.route,request)

    def beat(self,**extra):
        return self.store.heartbeat(self.host,self.host_token,{'offer':self.offer,**extra})

    def test_sdk_durable_fifo_first_receipt_restart_and_no_secret_addresses(self):
        self.ready();request=self.command()
        queued=self.scoped.create_operation(request['id'],'primary','tap',request['arguments'])
        self.assertEqual(queued['state'],'queued')
        self.assertEqual(self.submit(request),queued)
        with self.assertRaises(Error) as caught:self.submit({**request,'arguments':{'x':30,'y':20}})
        self.assertEqual(caught.exception.status,409)
        other=self.command(action='shell',arguments={'argv':['printf','hello']});self.submit(other)
        assignment=self.beat()['deviceOperations'][0]
        self.assertEqual(assignment['id'],request['id']);self.assertEqual(assignment['leaseId'],self.lease['id'])
        self.assertEqual(assignment['expiresAt'],1120)
        self.store=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(self.store.get_consumer_operation(self.lease['id'],request['id'],self.token),queued)
        receipt={'state':'unknown','result':{'detail':'fixture interrupted effect'}}
        self.assertEqual(self.beat(deviceReports={request['id']:receipt})['deviceOperations'][0]['id'],other['id'])
        self.beat(deviceReports={request['id']:{'state':'succeeded','result':{'unexpected':True}}})
        result=self.store.get_consumer_operation(self.lease['id'],request['id'],self.token)
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['result'],receipt['result'])
        self.assertNotIn('hostId',result);self.assertNotIn('machineId',result)
        for secret in (self.host_token,self.token):self.assertNotIn(secret,json.dumps(result))

    def test_role_member_capability_and_request_identity_boundaries(self):
        request=self.command()
        for token in (self.a['credential'],self.b['credential'],self.host_token):
            with self.assertRaises(Error):Client(self.upstream,token).request('POST',self.route,request)
        with self.assertRaises(Error) as caught:self.submit(request)
        self.assertEqual(caught.exception.code,'member_not_ready')
        self.ready()
        for bad,status in (({**request,'member':'other'},404),({**request,'action':'install','arguments':{'artifact':'owner-artifact'}},409),
                           ({**request,'hostId':self.host},400),({**request,'arguments':{'x':True,'y':2}},400)):
            with self.assertRaises(Error) as caught:self.submit(bad)
            self.assertEqual(caught.exception.status,status)
        self.submit(request)
        second=self.store.acquire_lease(self.b['credential'],{'id':str(uuid.uuid4()),'templateId':'android-phone','templateRevision':'1','arch':'arm64'})
        token=self.store.lease_credential(second['id'],self.b['credential'])['credential']
        for action in (lambda:self.store.create_consumer_operation(second['id'],token,request),
                       lambda:self.store.get_consumer_operation(second['id'],request['id'],token)):
            with self.assertRaises(Error) as caught:action()
            self.assertEqual(caught.exception.status,404)
        with self.assertRaises(Error):self.client.request('GET',self.route+'/'+str(uuid.uuid4()))

    def test_release_distinguishes_never_dispatched_and_uncertain_inflight(self):
        self.ready();first=self.command();second=self.command()
        self.submit(first);self.submit(second);self.beat()
        self.scoped.release(str(uuid.uuid4()))
        self.assertEqual(self.scoped.operation(first['id'])['state'],'unknown')
        self.assertEqual(self.scoped.operation(second['id'])['state'],'failed')
        self.assertEqual(self.beat(deviceReports={first['id']:{'state':'succeeded'}})['deviceOperations'],[])
        self.assertEqual(self.submit(first)['state'],'unknown')
        with self.assertRaises(Error) as caught:self.submit(self.command())
        self.assertEqual(caught.exception.status,410)
        self.assertEqual(self.scoped.inspect()['cleanup']['state'],'pending')

    def test_rotation_withdrawal_and_readiness_loss_never_resurrect_work(self):
        self.ready();first=self.command();self.submit(first);self.beat()
        token=self.store.lease_credential(self.lease['id'],self.a['credential'])['credential']
        with self.assertRaises(Error):self.scoped.operation(first['id'])
        self.token=token;self.client=Client(self.upstream,token)
        self.assertEqual(self.client.request('GET',self.route+'/'+first['id'])['state'],'unknown')
        second=self.command();self.submit(second)
        withdrawn=copy.deepcopy(self.offer);withdrawn['leaseImages']=[]
        response=self.store.heartbeat(self.host,self.host_token,{'offer':withdrawn})
        self.assertEqual(response['deviceOperations'],[])
        self.assertEqual(self.submit(second)['state'],'failed')
        self.beat();self.assertEqual(self.submit(second)['state'],'failed')
        third=self.command();self.submit(third)
        self.beat(reports={self.machine:{'state':'stopped'}})
        self.assertEqual(self.submit(third)['state'],'failed')

    def test_exact_deadline_unknown_receipt_and_wrong_host_report(self):
        self.ready();request=self.command();self.submit(request);self.beat()
        with self.assertRaises(Error) as caught:
            self.store.heartbeat(self.other_host,self.other_host_token,{'offer':self.offer,'deviceReports':{request['id']:{'state':'succeeded'}}})
        self.assertEqual(caught.exception.status,403)
        self.now=1120
        self.assertEqual(self.scoped.operation(request['id'])['state'],'unknown')
        self.assertEqual(self.scoped.inspect()['state'],'expired')
        self.assertEqual(self.beat()['deviceOperations'],[])

    def test_renewal_does_not_extend_command_deadline_or_replay_expired_intent(self):
        self.ready();request=self.command();self.submit(request);self.beat()
        lease=self.scoped.inspect()
        self.scoped.renew(str(uuid.uuid4()),lease['revision'],300)
        for now in range(1010,1120,10):
            self.now=now;self.beat()
        self.now=1119;self.beat()
        self.assertEqual(self.scoped.operation(request['id'])['state'],'queued')
        self.now=1120
        self.assertEqual(self.scoped.inspect()['state'],'ready')
        self.assertEqual(self.scoped.operation(request['id'])['state'],'unknown')
        self.assertEqual(self.submit(request)['state'],'unknown')
        self.assertEqual(self.beat()['deviceOperations'],[])

    def test_bounded_queue_does_not_impose_a_shell_session_limit(self):
        self.ready()
        for _ in range(32):self.submit(self.command(action='shell-open',arguments={'session':str(uuid.uuid4())}))
        with self.assertRaises(Error) as caught:self.submit(self.command())
        self.assertEqual(caught.exception.status,429)
        assignment=self.beat()['deviceOperations'][0]
        self.beat(deviceReports={assignment['id']:{'state':'succeeded','result':{}}})
        self.assertEqual(self.submit(self.command())['state'],'queued')

    def test_ios_denies_guest_shell_without_substituting_host_execution(self):
        from pathlib import Path
        from lease_fixture import lease_offer
        from test_devices import config,mobile
        from test_consumers import application
        store=Store(Path(self.temp.name)/'ios-operation.db',clock=lambda:self.now)
        offered=lease_offer(config('ios'));host=str(uuid.uuid4());key='i'*43
        store.enroll({'id':host,'credential':key,'offer':offered})
        app=store.create_consumer(application({k:mobile('ios')[k] for k in ('id','revision','arch')}))
        lease=store.acquire_lease(app['credential'],{'id':str(uuid.uuid4()),'templateId':'ios-phone','templateRevision':'1','arch':'arm64'})
        token=store.lease_credential(lease['id'],app['credential'])['credential'];machine=lease['members'][0]['machineId']
        store.heartbeat(host,key,{'offer':offered,'reports':{machine:{'state':'running'}}})
        for action,arguments in [('shell',{'argv':['host-command-must-not-run']}),('shell-open',{'session':str(uuid.uuid4())})]:
            with self.assertRaises(Error) as failure:
                store.create_consumer_operation(lease['id'],token,self.command(action=action,arguments=arguments))
            self.assertEqual(failure.exception.code,'capability_unsupported')
        self.assertEqual(store.create_consumer_operation(lease['id'],token,
            self.command(action='list-files',arguments={'path':'/','app':'com.example.fixture'}))['state'],'queued')

    def test_runner_checks_local_eligibility_assignment_and_receipts_before_effects(self):
        self.ready();request=self.command(action='shell',arguments={'argv':['fixture-command']});self.submit(request)
        response=self.beat()
        # The other host may sort first in the fixture; select the pinned member.
        assignment=next(m for m in response['machines'] if m['id']==self.machine)
        folder=self.store.path+'-operation-fixture'
        from pathlib import Path
        Path(folder).mkdir()
        self.addCleanup(lambda:__import__('shutil').rmtree(folder))
        runtime=object.__new__(Mobile);runtime.control=Mock(return_value={'output':'fixture-only'})
        agent=object.__new__(Agent);agent.lock=threading.Lock();agent.stopping=threading.Event()
        agent.last_contact=execution_monotonic();agent.offer=self.offer
        agent.assignments=[assignment];agent.device_operations=response['deviceOperations'];agent.device_reports={}
        agent.reports={self.machine:{'state':'running'}};agent.lease_guard=SimpleNamespace(allowed=lambda _:True,begin_execution=Mock())
        agent.context=lambda _:(runtime,assignment['template'],Path(folder))
        # Controller fixture wall time is historical; bind only this disposable operation to current time.
        import time
        agent.device_operations[0]['expiresAt']=time.time()+60
        agent.device_work();agent.device_reports={};agent.device_work()
        self.assertEqual(runtime.control.call_count,1)
        self.assertEqual(agent.device_reports[request['id']]['state'],'succeeded')
        agent.device_reports={};agent.offer={**self.offer,'leaseImages':[]}
        agent.device_work();self.assertEqual(runtime.control.call_count,1)
        self.assertEqual(agent.device_reports[request['id']]['state'],'failed')

    def test_runner_rechecks_after_waiting_for_provider_receipt_lock(self):
        self.ready();request=self.command(action='shell',arguments={'argv':['fixture-command']});self.submit(request)
        response=self.beat();assignment=next(m for m in response['machines'] if m['id']==self.machine)
        agent=object.__new__(Agent);agent.lock=threading.Lock();agent.stopping=threading.Event()
        agent.last_contact=execution_monotonic();agent.offer=self.offer;agent.assignments=[assignment]
        agent.device_operations=response['deviceOperations'];agent.device_reports={};agent.reports={self.machine:{'state':'running'}}
        agent.lease_guard=SimpleNamespace(allowed=lambda _:True,begin_execution=Mock())
        import time
        agent.device_operations[0]['expiresAt']=time.time()+60
        effects=[]
        def operate(*args,input_guard=None):
            agent.device_operations=[]
            with input_guard():effects.append('must not run')
        agent.context=lambda _:(SimpleNamespace(operate=operate),assignment['template'],None)
        agent.device_work();self.assertEqual(effects,[])
        self.assertEqual(agent.device_reports[request['id']]['state'],'unknown')
