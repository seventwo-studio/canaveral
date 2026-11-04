import copy
import base64
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import Mock,patch

from canaveral.accessibility import inspect_provider
from canaveral.display_access import InputDenied
from canaveral.guest import server as guest
from canaveral.guest_access import GuestAccess,guest_ready,guest_recipe
from canaveral.host import Agent
from canaveral.model import Error
from canaveral.shell_sessions import ShellSessions
from canaveral.store import Store
from lease_fixture import lease_offer
from test_consumers import application
from test_orchestration import host_offer,image


class HeadlessGuestTests(unittest.TestCase):
    def test_recipe_has_no_graphical_runtime_and_keeps_owned_ssh_and_file_access(self):
        recipe=guest_recipe('ssh-ed25519 fixture-public','headless')
        self.assertEqual(recipe['driver'],'cloud-init')
        self.assertEqual(recipe['user'],'desktop')
        self.assertEqual(recipe['packages'],['python3','curl','openssh-server'])
        files={item['path']:item for item in recipe['files']}
        service=files['/etc/systemd/system/canaveral-headless.service']['content']
        self.assertIn('Environment=CANAVERAL_GUEST_MODE=headless',service)
        self.assertNotIn('dbus-run-session',service)
        self.assertNotIn('/opt/canaveral/start-desktop',files)
        self.assertNotIn('/etc/systemd/system/canaveral-desktop.service',files)
        self.assertTrue(any('disable --now canaveral-desktop.service' in command for command in recipe['commands']))
        desktop=guest_recipe('ssh-ed25519 fixture-public','desktop')
        self.assertIn('xfce4',desktop['packages'])
        self.assertTrue(any('disable --now canaveral-headless.service' in command for command in desktop['commands']))
        with self.assertRaises(Error):guest_recipe('ssh-ed25519 fixture-public','device')

    def test_instance_preparation_refreshes_managed_helpers_and_preserves_application_files_and_source_recipe(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);folder=root/'assignment';folder.mkdir()
            (folder/'ssh_host_ed25519_key').write_text('fixture-private-host-key')
            (folder/'ssh_host_ed25519_key.pub').write_text('ssh-ed25519 fixture-host-public')
            (folder/'access-token.json').write_text(json.dumps({'token':'fixture-token'}))
            image={'mode':'headless','prepare':guest_recipe('ssh-ed25519 fixture-user-key','headless')}
            pinned=next(item for item in image['prepare']['files'] if item['path']=='/opt/canaveral/server.py')
            pinned['content']='fixture-pinned-server-version'
            image['prepare']['files'].append({'path':'/opt/application/config','content':'fixture-application-config','mode':'0600'})
            before=copy.deepcopy(image)
            access=GuestAccess({'guestAccess':{'identityFile':'fixture-user-key'}},root)
            prepared=access.prepare({'id':str(uuid.uuid4())},image,folder)
            result={item['path']:item for item in prepared['prepare']['files']}
            self.assertIn('CANAVERAL_GUEST_MODE',result['/opt/canaveral/server.py']['content'])
            self.assertNotIn('fixture-pinned-server-version',result['/opt/canaveral/server.py']['content'])
            self.assertEqual(result['/opt/application/config']['content'],'fixture-application-config')
            self.assertEqual(result['/opt/canaveral/token']['content'],'fixture-token')
            self.assertEqual(image,before)

    def test_host_and_inspection_entrypoints_refuse_ui_before_guest_or_native_access(self):
        with tempfile.TemporaryDirectory() as directory:
            access=GuestAccess({},directory)
            access.tunnel=Mock(side_effect=AssertionError('No headless UI tunnel'))
            access.host=Mock(side_effect=AssertionError('No headless display address lookup'))
            image={'os':'linux','mode':'headless'}
            for action in ('screenshot','accessibility','accessibility-action','tap','swipe','text','key'):
                with self.subTest(action=action),self.assertRaises(InputDenied):
                    access.control({},image,directory,{'action':action,'arguments':{}})
            with self.assertRaises(Error):access.desktop({},image,directory)
            provider=Mock()
            with self.assertRaises(Error) as failure:inspect_provider(provider,{},image,directory)
            self.assertEqual(failure.exception.code,'capability_unsupported');provider.control.assert_not_called()
            access.host.assert_not_called();access.tunnel.assert_not_called()

    def test_guest_profile_denies_graphics_without_launching_tools_and_still_lists_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'fixture-file').write_bytes(b'contents')
            with patch.object(guest,'MODE','headless'),patch.object(guest.subprocess,'run') as tools:
                for action in ('screenshot','accessibility','accessibility-action','tap','text','key'):
                    with self.subTest(action=action),self.assertRaises(Error) as failure:guest.control(action,{})
                    self.assertEqual(failure.exception.code,'capability_unsupported')
                self.assertEqual(guest.control('list-files',{'path':str(root)})['entries'][0]['name'],'fixture-file')
                with patch.object(guest,'Path') as marker:
                    marker.return_value.exists.return_value=False
                    self.assertEqual(guest.control('health',{})['mode'],'headless')
                tools.assert_not_called()

    def test_readiness_requires_matching_headless_profile_and_keeps_legacy_desktop_compatibility(self):
        for value in ({'ready':True},{'ready':True,'mode':'desktop'},{'ready':False,'mode':'headless'},None,{'ready':1,'mode':'headless'}):
            self.assertFalse(guest_ready(value,{'mode':'headless'}))
        self.assertTrue(guest_ready({'ready':True,'mode':'headless'},{'mode':'headless'}))
        self.assertTrue(guest_ready({'ready':True},{'mode':'desktop'}))
        self.assertFalse(guest_ready({'ready':True,'mode':'headless'},{'mode':'desktop'}))

    def test_catalogue_machine_and_session_capabilities_agree_and_unverified_access_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'controller.db');host=str(uuid.uuid4());key=secrets.token_urlsafe(32)
            offered=lease_offer({**host_offer(),'templates':[{**image(),'guestAccess':True}]})
            store.enroll({'id':host,'credential':key,'offer':offered})
            app=store.create_consumer(application())
            lease=store.acquire_lease(app['credential'],{'id':str(uuid.uuid4()),'templateId':'linux','templateRevision':'1','arch':'amd64','ttlSeconds':120})
            machine=lease['members'][0]['machineId'];token=store.lease_credential(lease['id'],app['credential'])['credential']
            store.heartbeat(host,key,{'offer':offered,'reports':{machine:{'state':'running'}}})
            self.assertFalse(store.machines()[0]['ready'])
            store.heartbeat(host,key,{'offer':offered,'reports':{machine:{'state':'running','accessReady':True}}})
            metadata=store.machines()[0];self.assertTrue(metadata['ready'])
            self.assertEqual(metadata['capabilities'],{'desktopStream':False,'screenshot':False,'files':True,'shell':True,'accessibility':False})
            catalog=store.consumer_catalogue(app['credential'])['templates'][0]['capabilities']
            self.assertTrue(catalog['pty']);self.assertTrue(catalog['files'])
            self.assertFalse(catalog['displayStream']);self.assertFalse(catalog['hierarchy'])
            for capability in ('display','accessibility'):
                with self.assertRaises(Error) as failure:store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':capability})
                self.assertEqual(failure.exception.code,'capability_unsupported')
            for capability in ('pty','upload','download'):
                self.assertEqual(store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':capability})['state'],'pending')
            for action in ('screenshot','accessibility'):
                with self.assertRaises(Error) as failure:
                    store.create_consumer_operation(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','action':action,'arguments':{}})
                self.assertEqual(failure.exception.code,'capability_unsupported')
            self.assertEqual(store.create_consumer_operation(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','action':'shell',
                'arguments':{'argv':['printf','headless']}})['state'],'queued')

    def test_headless_import_selects_mode_specific_pinned_recipe(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);identity=root/'user-key';Path(str(identity)+'.pub').write_text('ssh-ed25519 fixture-public')
            config={**host_offer(),'storage':str(root/'disks'),'guestAccess':{'identityFile':str(identity)}}
            agent=Agent(config,'http://127.0.0.1:1',root/'agent')
            metadata={'id':str(uuid.uuid4()),'name':'Headless fixture','os':'linux','arch':'arm64','mode':'headless',
                      'mediaType':'disk','format':'raw','minimum':{'cpu':1,'memoryMiB':1024,'diskGiB':4},'guestAccess':True}
            with patch('canaveral.providers.base.architecture',return_value='arm64'):
                public=agent.import_image(metadata,io.BytesIO(b'x'*512),512,lambda:True)
            record=agent.library.records()[0]
            self.assertEqual(public['mode'],'headless')
            self.assertNotIn('xfce4',record['definition']['prepare']['packages'])
            self.assertTrue(any('canaveral-headless' in item['path'] for item in record['definition']['prepare']['files']))

    def test_headless_profile_keeps_nine_confined_shells_independent(self):
        class ConfinedShells(ShellSessions):
            def open(self,machine,session,argv,env=None):
                return super().open(machine,session,[sys.executable,'-u','-c',
                    'import sys\nfor line in sys.stdin:print("ACK-"+line.strip(),flush=True)'])
        shells=ConfinedShells();sessions=[str(uuid.uuid4()) for _ in range(9)]
        try:
            with patch.object(guest,'MODE','headless'),patch.object(guest,'SHELLS',shells):
                for index,session in enumerate(sessions):
                    guest.control('shell-open',{'session':session})
                    guest.control('shell-write',{'session':session,'text':'fixture-'+str(index)+'\n'})
                pending=set(range(9));received={index:b'' for index in pending};deadline=time.monotonic()+4
                while pending and time.monotonic()<deadline:
                    for index in list(pending):
                        value=guest.control('shell-read',{'session':sessions[index],'offset':0})
                        received[index]=base64.b64decode(value['data'])
                        if ('ACK-fixture-'+str(index)).encode() in received[index]:pending.remove(index)
                    time.sleep(.01)
                self.assertEqual(pending,set())
                for index,data in received.items():
                    for other in range(9):
                        if other!=index:self.assertNotIn(('ACK-fixture-'+str(other)).encode(),data)
                for session in sessions:self.assertTrue(guest.control('shell-close',{'session':session})['closed'])
        finally:shells.sweep(active=set())

    def test_generated_headless_bundle_imports_without_graphical_packages_and_rejects_invalid_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for item in guest_recipe('ssh-ed25519 fixture-public','headless')['files']:
                if not item['path'].startswith('/opt/canaveral/'):continue
                target=root/Path(item['path']).relative_to('/opt/canaveral')
                target.parent.mkdir(parents=True,exist_ok=True);target.write_text(item['content'])
            code='''import sys
sys.path.insert(0,sys.argv[1])
import server,canaveral.model
assert canaveral.model.__file__.startswith(sys.argv[1])
assert server.MODE=="headless"
try:server.control("screenshot",{})
except canaveral.model.Error as error:assert error.code=="capability_unsupported"
else:raise AssertionError("Headless visual dispatch")
'''
            env={**os.environ,'CANAVERAL_GUEST_MODE':'headless'}
            result=subprocess.run([sys.executable,'-I','-c',code,str(root)],cwd=root,env=env,capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([sys.executable,'-I','-c',code,str(root)],cwd=root,
                env={**env,'CANAVERAL_GUEST_MODE':'invalid-fixture-profile'},capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode,0);self.assertIn('Invalid guest service mode.',result.stderr)
