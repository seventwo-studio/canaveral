import secrets
import tempfile
import unittest
import uuid
from pathlib import Path

from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer,request
from test_devices import config as mobile_config


class HostConsolidationTests(unittest.TestCase):
    def test_offline_consolidation_preserves_ownership_images_reservations_and_rejects_retired_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'db')
            target,source=str(uuid.uuid4()),str(uuid.uuid4())
            a,b=secrets.token_urlsafe(32),secrets.token_urlsafe(32)
            android=mobile_config('android');linux={**host_offer(),'provider':'apple'}
            store.enroll({'id':target,'credential':a,'offer':android})
            store.enroll({'id':source,'credential':b,'offer':linux})
            machine=store.create(request(hostId=source))
            original=store.machines()[0]['template']
            definition={'name':'Local Mac','provider':'macos','capacity':{'cpu':8,'memoryMiB':16384,'diskGiB':200},
                        'runtimes':{'apple':{},'android':{}},'templates':[*android['templates'],*linux['templates']]}
            store.consolidate_local_runtimes(target,[source],definition)
            self.assertEqual(len(store.hosts()),1)
            self.assertEqual(store.hosts()[0]['provider'],'macos')
            self.assertEqual(store.machines()[0]['hostId'],target)
            self.assertEqual(store.machines()[0]['template'],original)
            self.assertEqual(store.hosts()[0]['reserved']['diskGiB'],10)
            with self.assertRaises(Error):store.heartbeat(source,b,{'offer':linux})
            response=store.heartbeat(target,a,{'offer':definition})
            self.assertEqual(response['machines'][0]['id'],machine['id'])
            store.consolidate_local_runtimes(target,[source],definition)
            self.assertEqual(len(store.machines()),1)
