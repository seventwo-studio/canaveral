from lease_fixture import lease_offer
from canaveral.lease_clock import execution_monotonic
import copy
import json
import secrets
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.assignment_gate import assignment_access,paths
from canaveral.display_access import DisplayControls
from canaveral.files import save_json
from canaveral.lease_cleanup import cleanup_assignment
from canaveral.model import Error,digest
from canaveral.owned_removal import assignment_fingerprint,remove_apple_storage
from canaveral.store import Store
from canaveral.lease_guard import LeaseGuard
from canaveral.host import Agent
from canaveral.client import Client
from test_leases import acquire
from test_dashboard import DashboardFixture
from test_consumers import application
from test_orchestration import host_offer


class LeaseCleanupStoreTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.offer=lease_offer(host_offer());self.host=str(uuid.uuid4());self.host_token=secrets.token_urlsafe(32)
        self.store.enroll({'id':self.host,'credential':self.host_token,'offer':self.offer})
        self.a=self.store.create_consumer(application())

    def beat(self,**extra):return self.store.heartbeat(self.host,self.host_token,{'offer':self.offer,**extra})

    def terminal(self):
        self.last_request=acquire()
        lease=self.store.acquire_lease(self.a['credential'],self.last_request)
        machine=lease['members'][0]['machineId']
        self.store.mutate_lease(lease['id'],self.a['credential'],'release',{'id':str(uuid.uuid4())})
        assignment=next(m for m in self.beat()['machines'] if m['id']==machine)
        return lease,assignment

    def receipt(self,machine,state='complete',attempt=1,**extra):
        intent=machine['leaseCleanup']
        value={'id':intent['id'],'leaseId':intent['leaseId'],'state':state,'attempt':attempt,**extra}
        if state=='complete':value.update(executionStopped=True,storageRemoved=True,credentialsErased=True)
        return {'state':'stopped','leaseCleanup':value}

    def test_matching_complete_ack_reclaims_quotas_but_keeps_terminal_identity(self):
        lease,machine=self.terminal();machine_id=machine['id']
        prepared={'state':'ready','tokenHash':digest('p'*32)}
        self.beat(reports={machine_id:{'state':'stopped','preparation':prepared}})
        self.assertTrue(self.store.prepared(machine_id,'p'*32)['prepared'])
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],4)
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'pending')
        self.beat(reports={machine_id:self.receipt(machine)})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'complete')
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],0)
        self.assertFalse(any(m['id']==machine_id for m in self.beat()['machines']))
        replayed=self.store.acquire_lease(self.a['credential'],self.last_request)
        self.assertEqual(replayed['state'],'released');self.assertEqual(replayed['cleanup']['state'],'complete')
        self.beat(reports={machine_id:{'state':'running','preparation':prepared}})
        with self.assertRaises(Error):self.store.prepared(machine_id,'p'*32)

    def test_wrong_identity_missing_erasure_and_stale_attempt_do_not_complete(self):
        lease,machine=self.terminal();machine_id=machine['id']
        for key in ('id','leaseId'):
            value=self.receipt(machine);value['leaseCleanup'][key]=str(uuid.uuid4())
            with self.assertRaises(Error):self.beat(reports={machine_id:value})
        value=self.receipt(machine);value['leaseCleanup'].pop('credentialsErased')
        with self.assertRaises(Error):self.beat(reports={machine_id:value})
        blocked=self.receipt(machine,'blocked',2,reason='storage_removal')
        self.beat(reports={machine_id:blocked})
        current=self.store.get_lease(lease['id'],self.a['credential'])
        retry=current['members'][0]['cleanup']['retryAt']
        self.beat(reports={machine_id:blocked})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['members'][0]['cleanup']['retryAt'],retry)
        self.beat(reports={machine_id:self.receipt(machine,attempt=1)})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'blocked')
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],4)
        restarted=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(restarted.get_lease(lease['id'],self.a['credential'])['members'][0]['cleanup']['id'],machine['leaseCleanup']['id'])

    def test_all_members_must_complete_before_cleanup_is_complete(self):
        lease=self.store.acquire_lease(self.a['credential'],acquire())
        companion=self.store.create({'id':str(uuid.uuid4()),'name':'Composite cleanup fixture','templateId':'linux'})
        # Fixture-only member bookkeeping; this does not implement pair acquisition.
        with self.store.transaction() as db:db.execute('INSERT INTO lease_members VALUES (?,?,?)',(lease['id'],'companion',companion['id']))
        self.store.mutate_lease(lease['id'],self.a['credential'],'release',{'id':str(uuid.uuid4())})
        members=self.beat()['machines'];first,second=members
        self.beat(reports={first['id']:self.receipt(first)})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'running')
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],4)
        self.beat(reports={second['id']:self.receipt(second,'blocked',reason='unsupported')})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'blocked')
        self.beat(reports={second['id']:self.receipt(second,attempt=2)})
        self.assertEqual(self.store.get_lease(lease['id'],self.a['credential'])['cleanup']['state'],'complete')
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],0)

    def test_retained_disk_counts_against_application_quota_until_ack(self):
        policy=application();policy['limits']['resources']['diskGiB']=4
        consumer=self.store.create_consumer(policy);key=consumer['credential']
        lease=self.store.acquire_lease(key,acquire())
        self.store.mutate_lease(lease['id'],key,'release',{'id':str(uuid.uuid4())})
        machine=self.beat()['machines'][0]
        with self.assertRaises(Error) as exhausted:self.store.acquire_lease(key,acquire())
        self.assertEqual(exhausted.exception.status,429)
        self.beat(reports={machine['id']:self.receipt(machine)})
        replacement=self.store.acquire_lease(key,acquire())
        self.assertNotEqual(replacement['members'][0]['machineId'],machine['id'])
        new_key=self.store.lease_credential(replacement['id'],key)['credential']
        with self.assertRaises(Error):self.store.get_lease(lease['id'],new_key)


class OwnedLeaseCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.folder=self.root/'machines'/str(uuid.uuid4());self.folder.mkdir(parents=True)
        self.machine={'id':self.folder.name,'desired':'stopped','template':{'id':'fixture'},'resources':{'diskGiB':1},
            'lease':{'id':str(uuid.uuid4()),'state':'released'}}
        self.machine['leaseCleanup']={'id':str(uuid.uuid4()),'leaseId':self.machine['lease']['id'],'state':'pending','attempts':0,'notBefore':0}
        self.fingerprint=assignment_fingerprint(self.machine)
        save_json(self.folder/'assignment.json',{'fingerprint':self.fingerprint,'leaseId':self.machine['lease']['id']})
        save_json(self.folder/'access-token.json',{'token':'private-fixture-token'})
        (self.folder/'ssh_host_ed25519_key').write_text('private-fixture-key')
        self.disk=self.root/'disks'/self.machine['id'];self.native=self.disk/self.machine['id'].upper();self.native.mkdir(parents=True)
        save_json(self.disk/'canaveral-owner.json',{'fingerprint':self.fingerprint})
        (self.native/'disk.img').write_bytes(b'private guest disk fixture')
        self.runtime=Mock(config={'provider':'apple','storage':str(self.root/'disks')},access=None)
        del self.runtime.shells
        self.runtime.confirmed_stopped.return_value=True
        self.runtime.reconcile.return_value={'state':'stopped'}
        self.runtime.remove_owned_storage.side_effect=lambda machine,image,folder,request,**kwargs:remove_apple_storage(self.runtime,machine,folder,request,**kwargs)
        self.agent=SimpleNamespace(access_runner=Mock(),display_controls=DisplayControls(self.root/'displays.json'),lease_guard=Mock())
        self.receipt=paths(self.folder,self.machine['id'])[1]

    def cleanup(self):
        with patch('canaveral.owned_removal.disk_closed',return_value=True):
            return cleanup_assignment(self.agent,self.machine,self.runtime,{},self.folder)

    def test_owned_storage_and_credentials_erased_with_idempotent_tombstone(self):
        unrelated=self.root/'machines'/'retained';unrelated.mkdir();(unrelated/'key').write_text('keep')
        result=self.cleanup();self.assertEqual(result['leaseCleanup']['state'],'complete')
        self.assertFalse(self.disk.exists());self.assertFalse(self.folder.exists())
        self.assertEqual((unrelated/'key').read_text(),'keep')
        self.assertEqual(self.cleanup(),result)
        proof=self.receipt.read_text();self.assertNotIn('private-fixture',proof)
        with self.assertRaises(Error):
            with assignment_access(self.machine,self.folder):self.fail('Retired work cannot recreate credentials')

    def test_active_reader_blocks_cleanup_and_new_readers_are_refused(self):
        with assignment_access(self.machine,self.folder):
            result=self.cleanup();self.assertEqual(result['leaseCleanup']['reason'],'operations_pending')
            self.assertTrue(self.disk.exists());self.assertTrue((self.folder/'access-token.json').exists())
            with self.assertRaises(Error):
                with assignment_access(self.machine,self.folder):pass
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')

    def orphan_helper(self,close_inherited):
        import psutil
        ready=self.root/'helper-ready';release=self.root/'helper-release'
        child="""import os,sys,time
from pathlib import Path
if sys.argv[3]=='close':os.closerange(3,1024)
Path(sys.argv[1]).touch()
while not Path(sys.argv[2]).exists():time.sleep(.02)
"""
        parent="""import json,sys
from canaveral.assignment_gate import assignment_access
from canaveral.assignment_process import assignment_popen
machine,folder,child,ready,release,mode=json.loads(sys.argv[1])
with assignment_access(machine,folder):
 process=assignment_popen([sys.executable,'-c',child,ready,release,mode],stdin=-3,stdout=-3,stderr=-3)
 print(process.pid,flush=True)
 sys.stdin.read()
"""
        arguments=[self.machine,str(self.folder),child,str(ready),str(release),'close' if close_inherited else 'retain']
        process=subprocess.Popen([sys.executable,'-c',parent,json.dumps(arguments)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            cwd=str(Path(__file__).resolve().parents[1]))
        try:
            import select
            self.assertTrue(select.select([process.stdout],[],[],5)[0],'Helper parent did not publish its child')
            child_pid=int(process.stdout.readline());orphan=psutil.Process(child_pid)
            until=time.monotonic()+5
            while not ready.exists() and time.monotonic()<until:time.sleep(.02)
            self.assertTrue(ready.exists())
            process.kill();process.wait(timeout=5)
            self.assertTrue(orphan.is_running())
            result=self.cleanup()
            self.assertEqual(result['leaseCleanup']['state'],'blocked')
            self.assertEqual(result['leaseCleanup']['reason'],'operations_pending')
            self.assertTrue(self.disk.exists());self.assertTrue((self.folder/'access-token.json').exists())
            self.runtime.reconcile.assert_not_called()
            release.touch();orphan.wait(timeout=5)
            self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        finally:
            release.touch()
            if process.poll() is None:process.kill()
            process.communicate(timeout=5)

    @unittest.skipIf(os.name=='nt','POSIX assignment locking')
    def test_orphan_helper_retains_gate_after_runner_process_is_killed(self):
        self.orphan_helper(False)

    @unittest.skipIf(os.name=='nt','POSIX assignment locking')
    def test_orphan_helper_closing_inherited_gate_still_blocks_via_durable_identity(self):
        self.orphan_helper(True)

    def test_storage_failure_retains_credentials_and_retry_resumes(self):
        self.runtime.remove_owned_storage.side_effect=Error('Fixture interrupted removal')
        result=self.cleanup();self.assertEqual(result['leaseCleanup']['reason'],'storage_removal')
        self.assertTrue((self.folder/'access-token.json').exists())
        self.runtime.remove_owned_storage.side_effect=lambda machine,image,folder,request:remove_apple_storage(self.runtime,machine,folder,request)
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')

    def test_crash_after_disk_removal_resumes_without_reconciliation_or_recreation(self):
        # Simulate process loss after the owned remover completed but before the
        # outer cleanup phase was published.
        intent=self.machine['leaseCleanup'];expected={'id':intent['id'],'machineId':self.machine['id'],
            'leaseId':self.machine['lease']['id'],'fingerprint':self.fingerprint,'phase':'planned','attempt':1}
        save_json(self.receipt,expected)
        with patch('canaveral.owned_removal.disk_closed',return_value=True):
            remove_apple_storage(self.runtime,self.machine,self.folder,intent['id'])
        self.assertFalse(self.disk.exists())
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.runtime.reconcile.assert_not_called()
        self.assertFalse(self.disk.exists());self.assertFalse(self.folder.exists())

    def prepare_journal(self):
        from canaveral.provisioning import record_preparation
        record_preparation(self.machine,self.folder,True)

    def test_partial_native_disk_is_erased_without_reconciliation_or_boot_metadata(self):
        self.prepare_journal()
        with patch('canaveral.owned_removal.tree_closed',return_value=True):
            self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.runtime.reconcile.assert_not_called();self.runtime.confirmed_stopped.assert_not_called()
        self.assertFalse(self.folder.exists());self.assertFalse(self.disk.exists())

    def test_failure_before_storage_creation_still_erases_guest_credentials(self):
        import shutil
        self.prepare_journal();shutil.rmtree(self.disk)
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.runtime.reconcile.assert_not_called();self.runtime.remove_owned_storage.assert_not_called()
        self.assertFalse(self.folder.exists());self.assertFalse(self.disk.exists())

    def test_partial_seed_only_storage_and_interrupted_removal_resume(self):
        import shutil
        self.prepare_journal();shutil.rmtree(self.native)
        (self.disk/'cloud-init.iso').write_bytes(b'partial private seed fixture')
        remove=__import__('shutil').rmtree
        def interrupted(path,*args,**kwargs):
            if '.removing-' in str(path):raise OSError('Fixture interruption during partial-disk removal')
            return remove(path,*args,**kwargs)
        with patch('canaveral.owned_removal.tree_closed',return_value=True),patch('canaveral.owned_removal.shutil.rmtree',side_effect=interrupted):
            result=self.cleanup()
        self.assertEqual(result['leaseCleanup']['reason'],'storage_removal')
        self.assertTrue((self.folder/'access-token.json').exists());self.assertFalse(self.disk.exists())
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.runtime.reconcile.assert_not_called()

    def test_preboot_journal_never_overrides_contradictory_launch_or_foreign_ownership(self):
        self.prepare_journal();save_json(self.native/'runner-launch.json',{'attemptedAt':1})
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'blocked')
        self.assertTrue(self.disk.exists());self.runtime.remove_owned_storage.assert_not_called()
        (self.native/'runner-launch.json').unlink()
        save_json(self.native/'machine.json',{'executionLeaseID':str(uuid.uuid4())})
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'blocked')
        self.assertTrue((self.folder/'ssh_host_ed25519_key').exists())

    def test_partial_storage_with_open_handles_stays_reserved_until_closed(self):
        self.prepare_journal()
        with patch('canaveral.owned_removal.tree_closed',return_value=False):
            self.assertEqual(self.cleanup()['leaseCleanup']['reason'],'storage_removal')
        self.assertTrue(self.disk.exists());self.assertTrue(self.folder.exists())
        with patch('canaveral.owned_removal.tree_closed',return_value=True):
            self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')

    @unittest.skipUnless(sys.platform == 'darwin', 'Native Apple disk ownership requires macOS lsof')
    def test_real_partial_disk_handle_prevents_erasure_until_closed(self):
        self.prepare_journal()
        with (self.native/'disk.img').open('rb'):
            self.assertEqual(self.cleanup()['leaseCleanup']['reason'],'storage_removal')
            self.assertTrue(self.disk.exists());self.assertTrue(self.folder.exists())
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')

    def test_preboot_journal_does_not_adopt_unmarked_storage_or_ignore_quarantine(self):
        self.prepare_journal();(self.disk/'canaveral-owner.json').unlink()
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'blocked')
        self.assertTrue(self.disk.exists());self.runtime.remove_owned_storage.assert_not_called()
        save_json(self.disk/'canaveral-owner.json',{'fingerprint':self.fingerprint})
        quarantine=self.disk.parent/('.removing-'+self.machine['id']+'-'+str(uuid.uuid4()))
        self.disk.rename(quarantine)
        self.assertEqual(self.cleanup()['leaseCleanup']['reason'],'recovery')
        self.assertTrue(quarantine.exists());self.assertTrue((self.folder/'access-token.json').exists())

    def test_erasure_failure_resumes_without_recreating_the_assignment(self):
        original=__import__('shutil').rmtree
        def remove(path,*args,**kwargs):
            if '.erasing-' in str(path):raise OSError('Fixture interrupted credential erasure')
            return original(path,*args,**kwargs)
        with patch('canaveral.lease_cleanup.shutil.rmtree',side_effect=remove):
            result=self.cleanup();self.assertEqual(result['leaseCleanup']['state'],'blocked')
        self.assertFalse(self.folder.exists());self.assertFalse(self.disk.exists())
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.assertFalse(list(self.folder.parent.glob('.erasing-*')))

    def test_cancel_before_execution_uses_durable_admission_without_touching_other_data(self):
        machine=copy.deepcopy(self.machine);machine['id']=str(uuid.uuid4())
        machine['lease'].update(revision=1,authorizationDeadline=1060,controllerNow=1000)
        machine['leaseCleanup']['id']=str(uuid.uuid4())
        self.agent.lease_guard=LeaseGuard(self.root/'guard',clock=lambda:1000)
        self.agent.lease_guard.observe([machine],0)
        folder=self.folder.parent/machine['id']
        with patch('canaveral.owned_removal.disk_closed',return_value=True):
            value=cleanup_assignment(self.agent,machine,self.runtime,{},folder)
        self.assertEqual(value['leaseCleanup']['state'],'complete')
        self.assertTrue((self.folder/'access-token.json').exists())
        self.runtime.remove_owned_storage.assert_not_called()

    def test_cleanup_does_not_wait_for_unrelated_vm_reconciliation(self):
        from canaveral.lease_cleanup import LeaseCleanupRunner
        agent=self.agent;agent.lock=threading.Lock();agent.stopping=threading.Event();agent.reports={}
        ordinary={'id':str(uuid.uuid4()),'desired':'running'}
        agent.assignments=[self.machine,ordinary];agent.lease_guard.assignments.side_effect=lambda current:current
        agent.last_contact=execution_monotonic();agent.poll_interval=.25;agent.health=None
        agent.sweep_connections=Mock();agent.device_work=Mock()
        entered=threading.Event();release=threading.Event()
        def reconcile(machine):
            if machine.get('leaseCleanup'):return cleanup_assignment(agent,machine,self.runtime,{},self.folder)
            entered.set();release.wait(4);return {'state':'running'}
        agent.reconcile=reconcile
        main=threading.Thread(target=Agent.work,args=(agent,),daemon=True);main.start()
        self.assertTrue(entered.wait(2))
        manager=LeaseCleanupRunner(agent);worker=threading.Thread(target=manager.work,daemon=True)
        with patch('canaveral.owned_removal.disk_closed',return_value=True):
            worker.start()
            try:
                until=time.monotonic()+2
                while time.monotonic()<until:
                    if agent.reports.get(self.machine['id'],{}).get('leaseCleanup',{}).get('state')=='complete':break
                    time.sleep(.02)
                self.assertEqual(agent.reports[self.machine['id']]['leaseCleanup']['state'],'complete')
                self.assertTrue(main.is_alive());self.assertFalse(release.is_set())
            finally:agent.stopping.set();release.set();main.join(2);worker.join(2);manager.close()

    def test_assignment_symlinks_are_unlinked_without_erasing_their_targets(self):
        outside=self.root/'retained-key';outside.write_text('retained global credential fixture')
        (self.folder/'shared-key-link').symlink_to(outside)
        self.assertEqual(self.cleanup()['leaseCleanup']['state'],'complete')
        self.assertEqual(outside.read_text(),'retained global credential fixture')

    def test_inflight_cleanup_is_visible_before_slow_removal_finishes(self):
        self.agent.lock=threading.Lock();self.agent.reports={}
        entered=threading.Event();release=threading.Event();results=[]
        original=self.runtime.remove_owned_storage.side_effect
        def remove(*args):entered.set();release.wait(3);return original(*args)
        self.runtime.remove_owned_storage.side_effect=remove
        worker=threading.Thread(target=lambda:results.append(self.cleanup()),daemon=True);worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.agent.reports[self.machine['id']]['leaseCleanup']['state'],'running')
            self.assertTrue(self.disk.exists())
        finally:release.set();worker.join(3)
        self.assertEqual(results[0]['leaseCleanup']['state'],'complete')

    def test_unknown_or_active_lifecycle_never_authorizes_cleanup(self):
        for state in (None,'ready','provisioning','future-retained'):
            self.machine['lease']['state']=state
            with self.assertRaises(Error):self.cleanup()
        self.runtime.remove_owned_storage.assert_not_called()
        self.assertTrue(self.disk.exists());self.assertTrue((self.folder/'access-token.json').exists())

    def test_missing_execution_history_is_not_proof_that_resources_never_started(self):
        state=self.root/'missing-history';save_json(state/'identity.json',{'id':'retained-host-fixture'})
        guard=LeaseGuard(state,clock=lambda:1000)
        machine=copy.deepcopy(self.machine)
        machine['lease'].update(revision=1,authorizationDeadline=1060,controllerNow=1000)
        guard.observe([machine],0)
        self.assertFalse(guard.never_started(machine['id'],machine['lease']['id']))


class LeaseCleanupRoundTripTests(DashboardFixture):
    def test_release_to_erasure_ack_and_restart_retirement_through_real_http(self):
        host=str(uuid.uuid4());host_key=secrets.token_urlsafe(32)
        offer=lease_offer({**host_offer(),'provider':'apple'})
        self.store.enroll({'id':host,'credential':host_key,'offer':offer})
        consumer=self.store.create_consumer(application())
        client=Client(self.upstream,consumer['credential'])
        lease=client.request('POST','/v1/leases',acquire());machine_id=lease['members'][0]['machineId']
        root=Path(self.temp.name)/'owned-runner';folder=root/'machines'/machine_id
        agent=Agent({key:value for key,value in offer.items() if key not in ('leaseProtocol','leaseImages')},self.upstream,root/'agent')
        agent.identity={'id':host,'credential':host_key};agent.client=Client(self.upstream,host_key);agent.offer=offer
        agent.lease_guard=LeaseGuard(root/'guard',clock=lambda:self.now)
        runtime=Mock(config={'provider':'apple','storage':str(root/'disks')},access=None);del runtime.shells
        runtime.reconcile.return_value={'state':'stopped'};runtime.confirmed_stopped.return_value=True
        runtime.remove_owned_storage.side_effect=lambda machine,image,folder,request:remove_apple_storage(runtime,machine,folder,request)
        agent.context=Mock(side_effect=lambda machine:(runtime,{},root/'machines'/machine['id']))
        agent.poll();machine=agent.assignments[0]
        agent.lease_guard.begin_execution(machine_id,lease['id'])
        fingerprint=assignment_fingerprint(machine)
        save_json(folder/'assignment.json',{'fingerprint':fingerprint,'leaseId':lease['id']})
        save_json(folder/'preparation.json',{'token':'private-roundtrip-fixture'})
        native=root/'disks'/machine_id/machine_id.upper();native.mkdir(parents=True)
        save_json(native.parent/'canaveral-owner.json',{'fingerprint':fingerprint})
        (native/'disk.img').write_bytes(b'old consumer data')
        client.request('POST','/v1/leases/'+lease['id']+'/release',{'id':str(uuid.uuid4())})
        agent.poll();assigned=agent.assignments[0]
        with patch('canaveral.owned_removal.disk_closed',return_value=True):value=agent.reconcile(assigned)
        self.assertEqual(value['leaseCleanup']['state'],'complete')
        self.assertFalse(folder.exists());self.assertFalse(native.parent.exists())
        agent.reports[machine_id]=value;agent.poll()
        self.assertEqual(client.request('GET','/v1/leases/'+lease['id'])['cleanup']['state'],'complete')
        self.assertEqual(agent.assignments,[]);self.assertEqual(agent.lease_guard.assignments([]),[])
        restarted=LeaseGuard(root/'guard',clock=lambda:self.now)
        restarted.observe([machine],0)
        self.assertEqual(restarted.assignments([machine]),[])
        self.assertFalse(restarted.allowed(machine_id))
        with self.assertRaises(Error):restarted.retire(machine_id,lease['id'],str(uuid.uuid4()))
        self.assertEqual(self.store.host_resources(host)['reserved']['diskGiB'],0)


if __name__=='__main__':unittest.main()
