import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from canaveral.host import Agent
from canaveral.model import Error, offer
from test_orchestration import host_offer, image, request
from test_devices import config as mobile_config


class MachineRuntimeTests(unittest.TestCase):
    def config(self,root):
        mobile=mobile_config('android')
        return {'name':'One Mac','provider':'macos','storage':str(root/'storage'),'capacity':{'cpu':8,'memoryMiB':16384,'diskGiB':200},
                'templates':[image(arch='arm64'),mobile['templates'][0]],
                'runtimes':{'apple':{'runner':'/installed/runner'},'android':{'androidSDK':'/installed/sdk'}}}

    def test_one_host_offer_contains_vm_and_simulator_runtime_without_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            config=self.config(Path(directory));public=offer(config)
            self.assertEqual(public['provider'],'macos')
            self.assertEqual(public['runtimes'],['android','apple'])
            self.assertEqual(offer(public),public)
            self.assertNotIn('/installed',json.dumps(public))
            self.assertEqual(len(public['templates']),2)

    def test_dispatch_preserves_separate_runtime_state_and_pinned_image_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=self.config(root)
            config['runtimes']['android']['stateDirectory']=str(root/'old-android-state')
            agent=Agent(config,'http://127.0.0.1:8765',root/'agent')
            for definition in agent.offer['templates']:
                machine={**request(templateId=definition['id']), 'template':definition}
                runtime,resolved,folder=agent.context(machine)
                expected='android' if definition['os']=='android' else 'apple'
                self.assertEqual(runtime.config['provider'],expected)
                self.assertEqual([t['os'] for t in runtime.config['templates']],[definition['os']])
                if expected=='android':self.assertEqual(folder,root/'old-android-state'/'machines'/machine['id'])

    def test_incompatible_or_disabled_runtime_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            config=self.config(Path(directory))
            with self.assertRaises(Error):offer({**config,'provider':'linux'})
            with self.assertRaises(Error):offer({**config,'runtimes':{'apple':config['runtimes']['apple']}})
            with self.assertRaises(Error):offer({**config,'runtimes':{}})
