import json
import os
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.client import Client
from canaveral.files import HostLock
from canaveral.model import Error
from canaveral.native_fence import force_stop
from test_dashboard import DashboardFixture
from test_orchestration import host_offer,request


class PowerOffTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.offer={**host_offer(),'provider':'apple'};self.host=str(uuid.uuid4());self.credential=secrets.token_urlsafe(32)
        self.store.enroll({'id':self.host,'credential':self.credential,'offer':self.offer})

    def beat(self,**extra):return self.store.heartbeat(self.host,self.credential,{'offer':self.offer,**extra})

    def test_explicit_intent_requires_matching_stop_ack_and_keeps_compute_until_then(self):
        machine=self.store.create(request());id=machine['id'];intent={'id':str(uuid.uuid4())};admin=Client(self.upstream,self.admin)
        queued=admin.request('POST','/v1/machines/'+id+'/power-off',intent);self.assertEqual(queued['state'],'queued')
        assignment=self.beat()['machines'][0];self.assertEqual(assignment['powerOffRequest'],intent['id']);self.assertEqual(assignment['desired'],'stopped')
        self.beat(reports={id:{'state':'stopped'}})
        resources=self.store.host_resources(self.host);self.assertEqual(resources['reserved']['cpu'],2)
        self.assertEqual(sum(g['cpu'] for g in resources['categories']),2)
        with self.assertRaises(Error):self.store.desired(id,'running')
        with self.assertRaises(Error):self.store.create_image_capture({'id':str(uuid.uuid4()),'machineId':id,'name':'Blocked source'})
        with self.assertRaises(Error):self.beat(reports={id:{'state':'stopped','powerOffId':str(uuid.uuid4())}})
        self.beat(reports={id:{'state':'stopped','powerOffId':intent['id']}})
        self.assertEqual(admin.request('POST','/v1/machines/'+id+'/power-off',intent)['state'],'succeeded')
        self.assertEqual(self.store.host_resources(self.host)['reserved']['cpu'],0)
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],10)
        self.store.desired(id,'running')
        admin.request('POST','/v1/machines/'+id+'/power-off',intent)
        self.assertEqual(self.store.machines()[0]['desired'],'running')

    def test_unconfirmed_stop_is_not_replaced_and_wrong_machine_cannot_reuse_intent(self):
        a=self.store.create(request());b=self.store.create(request());intent={'id':str(uuid.uuid4())}
        self.store.request_power_off(a['id'],intent)
        with self.assertRaises(Error):self.store.request_power_off(b['id'],intent)
        self.beat(reports={a['id']:{'state':'unknown','powerOffId':intent['id']}})
        self.assertEqual(self.store.request_power_off(a['id'],intent)['state'],'unknown')
        with self.assertRaises(Error):self.store.request_power_off(a['id'],{'id':str(uuid.uuid4())})
        self.assertEqual(self.store.host_resources(self.host)['reserved']['cpu'],4)


class NativeFenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.path=Path(self.temp.name)
        (self.path/'runner-launch.json').write_text(json.dumps({'attemptedAt':100}))
        (self.path/'status.json').write_text(json.dumps({'pid':123,'phase':'Running'}))
        self.process=Mock();self.process.pid=123;self.process.create_time.return_value=100
        self.process.exe.return_value='/approved/runner';self.process.cmdline.return_value=['/approved/runner','run',str(self.path)]
        self.process.uids.return_value=Mock(real=os.getuid());self.intent=str(uuid.uuid4())

    def test_pid_reuse_wrong_executable_and_wrong_directory_never_signal(self):
        for field,value in [('create_time',999),('exe','/unrelated/runner'),('cmdline',['/approved/runner','run','/another/vm'])]:
            original=getattr(self.process,field).return_value;getattr(self.process,field).return_value=value
            with patch('psutil.Process',return_value=self.process):
                with self.assertRaises(Error):force_stop(self.path,self.intent,['/approved/runner'])
            self.process.terminate.assert_not_called();getattr(self.process,field).return_value=original

    def test_native_exit_and_lock_are_not_enough_until_disk_handles_close(self):
        lock=HostLock(self.path/'runtime.lock');lock.__enter__()
        self.addCleanup(lambda:None if lock.handle.closed else lock.__exit__())
        self.process.wait.side_effect=lambda timeout:lock.__exit__()
        with patch('psutil.Process',return_value=self.process),patch('canaveral.native_fence.same_process',return_value=False),patch('canaveral.native_fence.disk_closed',return_value=False):
            result=force_stop(self.path,self.intent,['/approved/runner'])
        self.assertEqual(result['state'],'unknown');self.assertFalse((self.path/'fenced-stop.json').exists())
        with patch('canaveral.native_fence.same_process',return_value=False),patch('canaveral.native_fence.disk_closed',return_value=True):
            result=force_stop(self.path,self.intent,['/approved/runner'])
        self.assertEqual(result['state'],'stopped');self.process.terminate.assert_called_once()
        self.assertEqual(json.loads((self.path/'fenced-stop.json').read_text())['consistency'],'crash-consistent')

    def test_started_termination_is_never_replayed_against_live_pid(self):
        (self.path/('power-off-'+self.intent+'.json')).write_text(json.dumps({'boot':100,'pid':123,'createdAt':100}))
        with patch('psutil.Process',return_value=self.process):result=force_stop(self.path,self.intent,['/approved/runner'])
        self.assertEqual(result['state'],'unknown');self.process.terminate.assert_not_called()
