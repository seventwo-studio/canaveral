import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from canaveral.files import HostLock, save_json
from canaveral.model import Error
from canaveral.owned_removal import assignment_fingerprint, remove_apple_storage


class OwnedRemovalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.storage=self.root/'disks';self.storage.mkdir()
        self.folder=self.root/'assignment';self.folder.mkdir()
        self.machine={'id':str(uuid.uuid4()),'desired':'stopped','template':{'id':'fixture'},'resources':{'diskGiB':1}}
        self.request=str(uuid.uuid4());self.fingerprint=assignment_fingerprint(self.machine)
        self.disk=self.storage/self.machine['id'];self.native=self.disk/self.machine['id'].upper();self.native.mkdir(parents=True)
        (self.native/'disk.img').write_bytes(b'owned disk')
        save_json(self.disk/'canaveral-owner.json',{'fingerprint':self.fingerprint})
        save_json(self.folder/'assignment.json',{'fingerprint':self.fingerprint})
        self.provider=Mock(config={'storage':str(self.storage)});self.provider.confirmed_stopped.return_value=True
        self.quarantine=self.storage/('.removing-'+self.machine['id']+'-'+self.request)
        self.receipt=self.folder/'deletion.json'

    def remove(self):
        with patch('canaveral.owned_removal.disk_closed',return_value=True):
            return remove_apple_storage(self.provider,self.machine,self.folder,self.request)

    def test_only_owned_storage_is_removed_and_complete_retry_is_idempotent(self):
        other=self.storage/str(uuid.uuid4());other.mkdir();(other/'keep').write_text('retained')
        outside=self.root/'outside';outside.write_text('safe')
        (self.native/'external-link').symlink_to(outside)
        self.assertEqual(self.remove()['state'],'complete')
        self.assertFalse(self.disk.exists());self.assertFalse(self.quarantine.exists())
        self.assertEqual(outside.read_text(),'safe');self.assertEqual((other/'keep').read_text(),'retained')
        self.assertTrue((self.folder/'assignment.json').exists())
        self.assertEqual(self.remove()['state'],'complete')
        with self.assertRaises(Error):remove_apple_storage(self.provider,self.machine,self.folder,str(uuid.uuid4()))

    def test_unowned_live_or_open_disk_is_never_removed_or_tombstoned(self):
        save_json(self.disk/'canaveral-owner.json',{'fingerprint':'wrong'})
        with self.assertRaises(Error):self.remove()
        save_json(self.disk/'canaveral-owner.json',{'fingerprint':self.fingerprint})
        self.provider.confirmed_stopped.return_value=False
        with self.assertRaises(Error):self.remove()
        self.provider.confirmed_stopped.return_value=True
        with patch('canaveral.owned_removal.disk_closed',return_value=False):
            with self.assertRaises(Error):remove_apple_storage(self.provider,self.machine,self.folder,self.request)
        with HostLock(self.native/'runtime.lock'):
            with self.assertRaises(RuntimeError):self.remove()
        self.assertTrue((self.native/'disk.img').exists());self.assertFalse(self.receipt.exists())

    def test_restart_after_rename_finishes_without_recreating_storage(self):
        with patch('canaveral.owned_removal.shutil.rmtree',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):self.remove()
        self.assertFalse(self.disk.exists());self.assertTrue(self.quarantine.exists())
        self.assertEqual(json.loads(self.receipt.read_text())['state'],'removing')
        self.assertEqual(self.remove()['state'],'complete');self.assertFalse(self.disk.exists())

    def test_missing_storage_requires_durable_removal_evidence(self):
        import shutil
        shutil.rmtree(self.disk)
        with self.assertRaises(Error):self.remove()
        save_json(self.receipt,{'id':self.request,'machineId':self.machine['id'],'fingerprint':self.fingerprint,'state':'planned'})
        with self.assertRaises(Error):self.remove()
        save_json(self.receipt,{'id':self.request,'machineId':self.machine['id'],'fingerprint':self.fingerprint,'state':'removing'})
        self.assertEqual(self.remove()['state'],'complete')

    def test_restart_in_rename_receipt_window_and_reappearing_storage(self):
        save_json(self.receipt,{'id':self.request,'machineId':self.machine['id'],'fingerprint':self.fingerprint,'state':'planned'})
        os.rename(self.disk,self.quarantine)
        self.assertEqual(self.remove()['state'],'complete')
        self.disk.mkdir()
        with self.assertRaises(Error):self.remove()

    def test_symlink_storage_and_runtime_records_are_rejected(self):
        for name in ('disk.img','runtime.lock','status.json'):
            path=self.native/name;original=path.read_bytes() if path.exists() else None
            path.unlink(missing_ok=True);path.symlink_to(self.root/'outside')
            with self.assertRaises(Error):self.remove()
            path.unlink()
            if original is not None:path.write_bytes(original)
        os.rename(self.disk,self.root/'moved');self.disk.symlink_to(self.root/'moved',target_is_directory=True)
        with self.assertRaises(Error):self.remove()
