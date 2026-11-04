import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.lease_guard import LeaseGuard
from canaveral.model import Error
from canaveral.owned_removal import assignment_fingerprint
from canaveral.providers.apple import Apple
from canaveral.provisioning import preboot_storage,read_journal,record_boot_request,record_preparation


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.folder=self.root/'assignment';self.folder.mkdir()
        self.machine={'id':str(uuid.uuid4()),'name':'Preparation fixture','desired':'running','template':{},
            'resources':{'cpu':1,'memoryMiB':1024,'diskGiB':4},
            'lease':{'id':str(uuid.uuid4()),'state':'provisioning','revision':1,'controllerNow':1000,'authorizationDeadline':1060}}
        save_json(self.folder/'assignment.json',{'fingerprint':assignment_fingerprint(self.machine),'leaseId':self.machine['lease']['id']})

    def test_journal_is_durable_before_guest_preparation_and_does_not_imply_guest_started(self):
        guard=LeaseGuard(self.root/'guard',clock=lambda:1000,monotonic=lambda:10)
        guard.observe([self.machine],0)
        def fail_prepare(*args):
            self.assertEqual(read_journal(self.machine,self.folder)['phase'],'preparing')
            self.assertFalse(guard.never_started(self.machine['id'],self.machine['lease']['id']))
            raise Error('Fixture failure while preparing credentials')
        runtime=SimpleNamespace(config={'provider':'apple'},access=SimpleNamespace(prepare=fail_prepare))
        with self.assertRaises(Error):Agent._reconcile(SimpleNamespace(lease_guard=guard),self.machine,runtime,{'guestAccess':True},self.folder)
        self.assertTrue(preboot_storage(self.machine,self.folder,self.root/'not-created'))

    def test_boot_request_is_sticky_across_restarts_and_unknown_history_cannot_be_upgraded(self):
        record_preparation(self.machine,self.folder,True)
        record_boot_request(self.machine,self.folder,1001)
        record_preparation(self.machine,self.folder,True)
        self.assertEqual(read_journal(self.machine,self.folder)['phase'],'bootRequested')
        self.assertFalse(preboot_storage(self.machine,self.folder,self.root/'not-created'))
        (self.folder/'provisioning.json').unlink()
        record_preparation(self.machine,self.folder,False)
        record_preparation(self.machine,self.folder,True)
        self.assertEqual(read_journal(self.machine,self.folder)['phase'],'unproven')

    def test_foreign_assignment_or_journal_is_never_adopted(self):
        record_preparation(self.machine,self.folder,True)
        other={**self.machine,'lease':{'id':str(uuid.uuid4())}}
        with self.assertRaises(Error):read_journal(other,self.folder)
        (self.folder/'provisioning.json').unlink()
        with self.assertRaises(Error):record_preparation(other,self.folder,True)

    def test_native_spawn_is_preceded_by_durable_boot_phase_and_matching_attempt(self):
        storage=self.root/'disks'/self.machine['id'];native=storage/self.machine['id'].upper();native.mkdir(parents=True)
        save_json(storage/'canaveral-owner.json',{'fingerprint':assignment_fingerprint(self.machine)})
        save_json(native/'machine.json',{'executionLeaseID':self.machine['lease']['id']})
        (native/'native-prepared').touch()
        record_preparation(self.machine,self.folder,True)
        runtime=Apple({'storage':str(self.root/'disks'),'runner':'fixture'},self.root/'runtime')
        def spawn(*args,**kwargs):
            journal=read_journal(self.machine,self.folder)
            self.assertEqual(journal['phase'],'bootRequested')
            self.assertEqual(journal['attemptedAt'],json.loads((native/'runner-launch.json').read_text())['attemptedAt'])
            return Mock()
        with patch('canaveral.providers.apple.run',return_value='{"locked":false}'),patch('canaveral.native_lease.publish'),\
                patch('canaveral.providers.apple.subprocess.Popen',side_effect=spawn) as process:
            self.assertEqual(runtime.reconcile(self.machine,{'os':'linux','mode':'headless','image':'fixture'},self.folder)['state'],'starting')
            process.assert_called_once()

    def test_missing_boot_history_does_not_count_as_native_shutdown(self):
        storage=self.root/'disks'/self.machine['id'];native=storage/self.machine['id'].upper();native.mkdir(parents=True)
        save_json(storage/'canaveral-owner.json',{'fingerprint':assignment_fingerprint(self.machine)})
        (native/'disk.img').write_bytes(b'partial native disk fixture')
        runtime=Apple({'storage':str(self.root/'disks'),'runner':'fixture'},self.root/'runtime')
        with patch('canaveral.providers.apple.run',return_value='{"locked":false}'),\
                patch('canaveral.providers.apple.subprocess.Popen') as process:
            result=runtime.reconcile({**self.machine,'desired':'stopped'},{'os':'linux','mode':'headless','image':'fixture'},self.folder)
        self.assertEqual(result['state'],'unknown');process.assert_not_called()
        self.assertTrue((native/'disk.img').exists())
