from canaveral.lease_clock import execution_monotonic
import json
import os
import select
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.files import HostLock,save_json
from canaveral.host import Agent
from canaveral.lease_guard import LeaseGuard
from canaveral.model import Error
from canaveral.native_lease import confirm_fenced,publish
from canaveral.providers.apple import Apple
from test_orchestration import host_offer


class NativeLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.machine={'id':str(uuid.uuid4()),'lease':{'id':str(uuid.uuid4())}}
        self.boot_session=str(uuid.uuid4());self.boot=1000
        save_json(self.root/'runner-launch.json',{'attemptedAt':self.boot})
        self.value={'leaseID':self.machine['lease']['id'],'revision':1,'remainingSeconds':10,'fenced':False}
        self.image={'_leaseAuthorization':lambda:self.value}
        self.provider=SimpleNamespace(config={'runner':'fixture'})
        self.clock={'version':1,'bootSessionID':self.boot_session,'continuous':500}

    def publish(self,stopping=False):
        with patch('canaveral.native_lease.run',return_value=json.dumps(self.clock)),patch('canaveral.native_lease.execution_monotonic',side_effect=[100,101]):
            return publish(self.provider,self.machine,self.image,self.root,stopping)

    def test_conservative_duration_and_same_revision_never_extend(self):
        first=self.publish();self.assertEqual(first['deadline'],508.75)
        self.value['remainingSeconds']=100
        self.assertEqual(self.publish()['deadline'],first['deadline'])
        self.value['revision']=2
        self.assertGreater(self.publish()['deadline'],first['deadline'])
        self.assertTrue(self.publish(stopping=True)['fenced'])
        self.value['revision']=3
        self.assertTrue(self.publish()['fenced'])

    def test_missing_guard_invalid_clock_and_wrong_lease_or_boot_are_refused(self):
        with self.assertRaises(Error):publish(self.provider,self.machine,{},self.root)
        self.clock['continuous']=float('inf')
        with self.assertRaises(Error):self.publish()
        self.clock['continuous']=500;self.publish()
        save_json(self.root/'runner-launch.json',{'attemptedAt':1001})
        with self.assertRaises(Error):self.publish()

    def test_fence_requires_gone_process_closed_disk_and_unowned_runtime_lock(self):
        proof={'machineID':self.machine['id'],'leaseID':self.machine['lease']['id'],'boot':1000,'pid':12345}
        save_json(self.root/'lease-fenced.json',proof)
        (self.root/'disk.img').write_bytes(b'fixture')
        with patch('psutil.pid_exists',return_value=True),patch('canaveral.native_lease.disk_closed',return_value=True):
            self.assertFalse(confirm_fenced(self.machine,self.root))
        with patch('psutil.pid_exists',return_value=False),patch('canaveral.native_lease.disk_closed',return_value=False):
            self.assertFalse(confirm_fenced(self.machine,self.root))
        with patch('psutil.pid_exists',return_value=False),patch('canaveral.native_lease.disk_closed',return_value=True):
            with HostLock(self.root/'runtime.lock'):self.assertFalse(confirm_fenced(self.machine,self.root))
            self.assertTrue(confirm_fenced(self.machine,self.root))
        self.assertEqual(json.loads((self.root/'fenced-stop.json').read_text())['leaseID'],self.machine['lease']['id'])
        save_json(self.root/'lease-fenced.json',{**proof,'leaseID':str(uuid.uuid4())})
        with self.assertRaises(Error):confirm_fenced(self.machine,self.root)

    def test_guest_shutdown_before_expiry_can_be_positively_reclaimed(self):
        save_json(self.root/'machine.json',{'executionLeaseID':self.machine['lease']['id']})
        save_json(self.root/'status.json',{'phase':'Stopped','updatedAt':1001-978307200,'pid':12345})
        with patch('psutil.pid_exists',return_value=False),patch('canaveral.native_lease.disk_closed',return_value=True):
            self.assertTrue(confirm_fenced(self.machine,self.root))
        with patch('psutil.pid_exists',return_value=True),patch('canaveral.native_lease.disk_closed',return_value=True):
            self.assertFalse(confirm_fenced(self.machine,self.root))

    def test_refresh_never_creates_unprepared_storage_or_adopts_a_vm(self):
        provider=Apple({'storage':str(self.root/'missing')},self.root/'state')
        self.machine.update(template={},resources={})
        self.assertIsNone(provider.refresh_execution(self.machine,{},self.root/'assignment',lambda:self.value))
        self.assertFalse((self.root/'missing').exists())

    def test_refresh_updates_only_the_owned_native_binding(self):
        from canaveral.model import digest
        self.machine.update(template={},resources={},desired='running')
        storage=self.root/'disks'/self.machine['id'];native=storage/self.machine['id'].upper();folder=self.root/'assignment'
        native.mkdir(parents=True)
        fingerprint=digest({key:self.machine[key] for key in ('id','template','resources')})
        save_json(folder/'assignment.json',{'fingerprint':fingerprint})
        save_json(storage/'canaveral-owner.json',{'fingerprint':fingerprint})
        save_json(native/'machine.json',{'executionLeaseID':self.machine['lease']['id']})
        save_json(native/'runner-launch.json',{'attemptedAt':1000})
        provider=Apple({'storage':str(self.root/'disks'),'runner':'fixture'},self.root/'state')
        with patch('canaveral.native_lease.run',return_value=json.dumps(self.clock)) as sample,patch('canaveral.native_lease.execution_monotonic',return_value=100):
            self.assertIsNone(provider.refresh_execution(self.machine,{},folder,lambda:self.value))
            self.assertIsNone(provider.refresh_execution(self.machine,{},folder,lambda:self.value))
            self.assertEqual(sample.call_count,1)
            self.value['revision']=2
            self.assertIsNone(provider.refresh_execution(self.machine,{},folder,lambda:self.value))
            self.assertEqual(sample.call_count,2)
            save_json(storage/'canaveral-owner.json',{'fingerprint':'wrong'})
            with self.assertRaises(Error):provider.refresh_execution(self.machine,{},folder,lambda:self.value)
            self.assertEqual(sample.call_count,2)

    def test_stop_bypasses_guest_preparation_and_credential_generation(self):
        agent=Agent(host_offer(),'http://127.0.0.1:1',self.root/'stop-agent')
        access=Mock();runtime=SimpleNamespace(access=access,reconcile=Mock(return_value={'state':'stopped'}))
        folder=self.root/'stopped-assignment'
        agent.context=Mock(return_value=(runtime,{'guestAccess':True,'prepare':{'driver':'ssh'}},folder))
        machine={'id':str(uuid.uuid4()),'template':{},'resources':{},'desired':'stopped'}
        self.assertEqual(agent.reconcile(machine)['state'],'stopped')
        access.prepare.assert_not_called()
        self.assertFalse((folder/'guest-token.json').exists())

    def test_suspend_aware_linux_clock_expires_even_when_awake_clock_is_frozen(self):
        from canaveral.lease_clock import execution_monotonic
        elapsed=[10]
        with patch('canaveral.lease_clock.sys.platform','linux'),patch('canaveral.lease_clock.time.CLOCK_BOOTTIME',7,create=True),\
                patch('canaveral.lease_clock.time.clock_gettime',side_effect=lambda clock:elapsed[0]),\
                patch('canaveral.lease_clock.time.monotonic',return_value=10):
            machine={'id':self.machine['id'],'lease':{'id':self.machine['lease']['id'],'revision':1,
                'state':'ready','controllerNow':1000,'authorizationDeadline':1060}}
            guard=LeaseGuard(self.root/'sleep-guard',clock=lambda:1000,monotonic=execution_monotonic)
            guard.observe([machine],0);self.assertTrue(guard.allowed(machine['id']))
            elapsed[0]=70
            self.assertFalse(guard.allowed(machine['id']))

    def test_independent_updates_progress_while_vm_reconciliation_is_blocked(self):
        agent=Agent(host_offer(),'http://127.0.0.1:1',self.root/'agent')
        wall=1000;mono=[10]
        machine={'id':self.machine['id'],'desired':'running','lease':{'id':self.machine['lease']['id'],
            'revision':1,'state':'ready','authorizationDeadline':1060,'controllerNow':1000}}
        agent.lease_guard=LeaseGuard(self.root/'guard',clock=lambda:wall,monotonic=lambda:mono[0])
        agent.lease_guard.observe([machine],0);agent.assignments=[machine]
        agent.last_contact=execution_monotonic();agent.sweep_connections=Mock()
        entered=threading.Event();release=threading.Event()
        def reconcile(machine):entered.set();release.wait(4);return {'state':'running'}
        agent.reconcile=Mock(side_effect=reconcile)
        refreshed=threading.Event()
        def refresh(machine,image,folder,authorization):
            if authorization()['fenced']:
                refreshed.set();return {'state':'stopped','leaseFenced':True}
        runtime=SimpleNamespace(refresh_execution=refresh)
        agent.context=Mock(return_value=(runtime,{},self.root))
        vm_worker=threading.Thread(target=agent.work,daemon=True);vm_worker.start()
        self.assertTrue(entered.wait(2))
        worker=threading.Thread(target=agent.native_lease_updates.work,daemon=True);worker.start()
        try:
            mono[0]=70
            self.assertTrue(refreshed.wait(2))
            deadline=time.monotonic()+1
            while self.machine['id'] not in agent.reports and time.monotonic()<deadline:time.sleep(.01)
            self.assertTrue(agent.reports[self.machine['id']]['leaseFenced'])
            self.assertTrue(vm_worker.is_alive());self.assertFalse(release.is_set())
        finally:
            agent.stopping.set();release.set();worker.join(2);vm_worker.join(2);agent.native_lease_updates.close()


NATIVE_RUNNER=os.environ.get('CANAVERAL_NATIVE_RUNNER')
@unittest.skipUnless(NATIVE_RUNNER,'Set CANAVERAL_NATIVE_RUNNER to test the actual signed native supervisor')
class NativeLeaseProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);machine_id=str(uuid.uuid4());lease_id=str(uuid.uuid4())
        self.directory=self.root/machine_id.upper();self.directory.mkdir()
        self.machine={'id':machine_id,'lease':{'id':lease_id}}
        save_json(self.directory/'machine.json',{'id':machine_id,'name':'Supervisor fixture','os':'linux','mode':'server',
            'cpuCount':1,'memoryGiB':1,'diskGiB':4,'installation':'ready','macAddress':'02:00:00:00:00:01','executionLeaseID':lease_id})
        save_json(self.directory/'runner-launch.json',{'attemptedAt':1000})
        (self.directory/'disk.img').write_bytes(b'not a bootable disk; watcher fixture only')
        self.provider=SimpleNamespace(config={'runner':NATIVE_RUNNER})
        self.value={'leaseID':lease_id,'revision':1,'remainingSeconds':2,'fenced':False}
        self.image={'_leaseAuthorization':lambda:self.value}
        self.publish()

    def publish(self):return publish(self.provider,self.machine,self.image,self.directory)

    def watch(self,ready=True):
        process=subprocess.Popen([NATIVE_RUNNER,'lease-watch',str(self.directory)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def close():
            if process.poll() is None:process.kill()
            process.communicate(timeout=3)
        self.addCleanup(close)
        if ready:
            self.assertTrue(select.select([process.stdout],[],[],3)[0])
            self.assertEqual(json.loads(process.stdout.readline()),{'ready':True})
        return process

    def test_native_process_exits_at_deadline_without_python_renewal(self):
        process=self.watch()
        self.assertEqual(process.wait(timeout=4),70)
        proof=json.loads((self.directory/'lease-fenced.json').read_text())
        self.assertEqual(proof['machineID'].lower(),self.machine['id'])
        self.assertEqual(proof['pid'],process.pid)
        self.assertTrue(confirm_fenced(self.machine,self.directory))
        self.assertTrue(Apple({},self.root).confirmed_stopped(self.directory))

    def test_renewal_then_missing_file_fences_and_restart_cannot_reopen(self):
        process=self.watch();self.value.update(revision=2,remainingSeconds=10);self.publish()
        # Observe beyond the first authorization. Renewal must reach the separate process.
        time.sleep(2);self.assertIsNone(process.poll())
        (self.directory/'lease-authorization.json').unlink()
        self.assertEqual(process.wait(timeout=2),70)
        self.value.update(revision=3,remainingSeconds=60);self.publish()
        replacement=self.watch(ready=False)
        self.assertEqual(replacement.wait(timeout=2),70)

    def test_same_revision_raw_file_replay_cannot_extend_cached_deadline(self):
        process=self.watch()
        path=self.directory/'lease-authorization.json';value=json.loads(path.read_text())
        save_json(path,{**value,'deadline':value['deadline']+1000})
        self.assertEqual(process.wait(timeout=4),70)

    def test_python_and_native_continuous_clocks_share_the_host_timebase(self):
        from canaveral.lease_clock import execution_monotonic
        before=execution_monotonic()
        clock=json.loads(subprocess.check_output([NATIVE_RUNNER,'lease-clock']))
        after=execution_monotonic()
        self.assertLessEqual(before,clock['continuous'])
        self.assertLessEqual(clock['continuous'],after)


if __name__=='__main__':unittest.main()
