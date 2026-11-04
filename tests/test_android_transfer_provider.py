import copy
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.android_transfer import load_helper,write_all
from canaveral.model import Error
from test_devices import mobile
from android_transfer_fixture import compile_helper,provider


class TransferManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        data=bytearray(128);data[:6]=b'\x7fELF\x02\x01';struct.pack_into('<HH',data,16,3,183)
        self.data=bytes(data);self.artifact=self.root/'canaveral-transfer-arm64';self.artifact.write_bytes(self.data)
        self.manifest={'schemaVersion':1,'protocol':'CANAVERAL_TRANSFER_V1','minimumAPI':26,
            'artifacts':{'arm64':{'file':self.artifact.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}}}
        self.path=self.root/'manifest.json';self.config={'transferHelperManifest':str(self.path)};self.save()

    def save(self):self.path.write_text(json.dumps(self.manifest))

    def test_valid_snapshot_and_invalid_hash_architecture_api_and_test_artifact(self):
        self.assertEqual(load_helper(self.config,mobile()),(self.data,hashlib.sha256(self.data).hexdigest()))
        for mutation in ('hash','architecture','api','hooks','boolean-version','traversal'):
            with self.subTest(mutation=mutation):
                manifest=copy.deepcopy(self.manifest);data=bytearray(self.data);image=mobile()
                if mutation=='hash':data[-1]=1
                elif mutation=='architecture':struct.pack_into('<H',data,18,62)
                elif mutation=='api':image['device']['systemImage']='system-images;android-25;google_apis;arm64-v8a'
                elif mutation=='hooks':data.extend(b'CANAVERAL_TRANSFER_TEST_FAIL')
                elif mutation=='boolean-version':manifest['schemaVersion']=True
                else:manifest['artifacts']['arm64']['file']='../outside'
                if mutation in ('architecture','hooks'):
                    manifest['artifacts']['arm64'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
                self.artifact.write_bytes(data);self.path.write_text(json.dumps(manifest))
                with self.assertRaises(Error) as failure:load_helper(self.config,image)
                self.assertEqual(failure.exception.code,'transfer_helper_invalid')
        self.artifact.write_bytes(self.data);self.save()

    def test_helper_health_is_explicit_without_guest_or_tool_commands(self):
        from canaveral.host_health import inspect
        from test_devices import config
        runtime=SimpleNamespace(tool=lambda name:'fixture-'+name,check=Mock())
        settings=config(androidSDK='/fixture/sdk',storage=str(self.root),transferHelperManifest=str(self.path))
        measured={'cpuCount':8,'memoryTotalMiB':16384,'diskFreeGiB':100}
        with patch('canaveral.host_health.sample',return_value=measured),patch('canaveral.host_health.shutil.which',return_value='/fixture'), \
             patch('canaveral.host_health.subprocess.run',return_value=Mock(stdout=b'fixture 1.0')):
            report=inspect(settings,runtime,self.root)
            self.assertTrue(report['capabilities']['androidUploadHelper'])
            self.assertEqual(next(c['status'] for c in report['checks'] if c['id']=='android-upload-helper'),'passed')
            runtime.check.reset_mock();self.artifact.write_bytes(b'changed')
            report=inspect(settings,runtime,self.root)
            self.assertFalse(report['capabilities']['androidUploadHelper']);self.assertEqual(report['status'],'failed')
            runtime.check.assert_not_called()
            del settings['transferHelperManifest'];report=inspect(settings,runtime,self.root)
            self.assertFalse(report['capabilities']['androidUploadHelper'])
            self.assertEqual(next(c['status'] for c in report['checks'] if c['id']=='android-upload-helper'),'warning')

    @unittest.skipUnless(hasattr(os,'mkfifo'),'POSIX FIFO fixture')
    def test_special_manifest_and_artifact_files_fail_without_blocking_preflight(self):
        code='''import json,sys
from canaveral.android_transfer import load_helper
from canaveral.model import Error
try:load_helper({'transferHelperManifest':sys.argv[1]},json.loads(sys.argv[2]))
except Error as error:
    assert error.code=='transfer_helper_invalid'
else:raise AssertionError('Special file was accepted')
'''
        for selected in (self.path,self.artifact):
            with self.subTest(file=selected.name):
                selected.unlink();os.mkfifo(selected)
                subprocess.run([sys.executable,'-c',code,str(self.path),json.dumps(mobile())],check=True,timeout=3,capture_output=True)
                selected.unlink()
                if selected==self.path:self.save()
                else:selected.write_bytes(self.data)


@unittest.skipUnless(os.name!='nt' and shutil.which('cc'),'POSIX C compiler required for helper transport fixtures.')
class AndroidTransferProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.build.cleanup);cls.binary=compile_helper(cls.build.name)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.provider=provider(self.root,self.binary);self.target=self.root/"target' ;$(touch sentinel)";self.target.write_bytes(b'old')
        loader=patch('canaveral.android_transfer.load_helper',return_value=(self.provider.payload,self.provider.digest))
        launcher=patch('canaveral.android_transfer.assignment_popen',side_effect=self.provider.launch)
        loader.start();launcher.start();self.addCleanup(loader.stop);self.addCleanup(launcher.stop)

    def upload(self,data=b'data'):
        return self.provider.stream_upload({'id':'fixture'},mobile(),self.root,str(self.target),None,io.BytesIO(data),len(data),lambda:self.provider.allowed)

    def test_binary_multichunk_and_empty_uploads_require_real_native_receipts(self):
        for data in (b'\x00\r\n\xff'*300000,b''):
            with self.subTest(size=len(data)):
                self.assertEqual(self.upload(data),{'uploaded':len(data),'durable':True})
                self.assertEqual(self.target.read_bytes(),data)
                self.assertEqual(list(self.provider.guest.iterdir()),[])
                self.assertFalse(list(self.root.glob('.canaveral-upload-*')))
                self.assertTrue(all(p.poll() is not None for p in self.provider.processes))
        self.assertFalse((self.root/'sentinel').exists())

    def test_precommit_revocation_preserves_destination_and_stops_guest_commands(self):
        from canaveral.android_transfer import read_line
        def revoke(*args,**kwargs):
            line=read_line(*args,**kwargs)
            if b' STAGED ' in line:self.provider.allowed=False
            return line
        with patch('canaveral.android_transfer.read_line',side_effect=revoke):
            with self.assertRaises(Error) as failure:self.upload()
        self.assertNotEqual(failure.exception.code,'upload_publication_uncertain')
        self.assertEqual(self.target.read_bytes(),b'old');self.assertFalse(list(self.root.glob('.canaveral-upload-*')))

    def test_postcommit_revocation_is_uncertain_without_rollback(self):
        from canaveral.android_transfer import read_line
        def revoke(*args,**kwargs):
            line=read_line(*args,**kwargs)
            if b' COMMITTED ' in line:self.provider.allowed=False
            return line
        with patch('canaveral.android_transfer.read_line',side_effect=revoke):
            with self.assertRaises(Error) as failure:self.upload()
        self.assertEqual(failure.exception.code,'upload_publication_uncertain');self.assertEqual(self.target.read_bytes(),b'data')

    def test_sync_failures_and_lost_ack_never_report_false_durability(self):
        for stage in ('file-sync','directory-sync','commit-ack'):
            with self.subTest(stage=stage):
                self.provider.failure=stage;self.target.write_bytes(b'old')
                with self.assertRaises(Error) as failure:self.upload()
                self.assertEqual(failure.exception.code=='upload_publication_uncertain',stage!='file-sync')
                self.assertEqual(self.target.read_bytes(),b'old' if stage=='file-sync' else b'data')

    def test_authorization_lost_during_cleanup_cannot_escape_as_success(self):
        original=self.provider.adb
        def adb(serial,action,*args,**kwargs):
            result=original(serial,action,*args,**kwargs)
            if action=='shell' and args[0].startswith('rm -f'):self.provider.allowed=False
            return result
        self.provider.adb=adb
        with self.assertRaises(Error) as failure:self.upload()
        self.assertEqual(failure.exception.code,'upload_publication_uncertain')
        self.assertEqual(self.target.read_bytes(),b'data')

    def test_malformed_staged_receipt_never_dispatches_commit(self):
        from canaveral.android_transfer import read_line
        def corrupt(*args,**kwargs):return read_line(*args,**kwargs).replace(b' STAGED ',b' WRONG ')
        with patch('canaveral.android_transfer.read_line',side_effect=corrupt):
            with self.assertRaises(Error):self.upload()
        self.assertEqual(self.target.read_bytes(),b'old')
        self.assertFalse(list(self.root.glob('.canaveral-upload-*')))

    def test_unknown_directory_receipt_and_bad_installed_hash_never_launch_helper(self):
        for field in ('bad_create','bad_hash'):
            with self.subTest(field=field):
                setattr(self.provider,field,True)
                with self.assertRaises(Error):self.upload()
                self.assertEqual(self.provider.processes,[]);self.assertEqual(self.target.read_bytes(),b'old')
                setattr(self.provider,field,False)

    def test_revoked_before_provider_work_creates_no_device_resources(self):
        self.provider.allowed=False
        with self.assertRaises(Error):self.upload()
        self.assertEqual(self.provider.calls,[]);self.provider.owned.assert_not_called()

    def test_revocation_during_artifact_preflight_creates_no_guest_resources(self):
        def load(*args):self.provider.allowed=False;return self.provider.payload,self.provider.digest
        with patch('canaveral.android_transfer.load_helper',side_effect=load):
            with self.assertRaises(Error):self.upload()
        self.assertEqual(self.provider.calls,[]);self.provider.owned.assert_not_called()

    def test_device_lookup_does_not_issue_ownership_rpc_after_revocation(self):
        from canaveral.providers.android import Android
        (self.root/'endpoint.json').write_text(json.dumps({'port':5554}))
        def devices():self.provider.allowed=False;return {'emulator-5554':'device'}
        self.provider.devices=devices
        with self.assertRaises(Error):Android.endpoint(self.provider,{},self.root,authorized=lambda:self.provider.allowed)
        self.provider.owned.assert_not_called()

    def test_unconfigured_legacy_upload_is_explicitly_not_durable(self):
        self.provider.config={}
        with patch('canaveral.providers.android.assignment_popen',side_effect=self.provider.launch):
            self.assertEqual(self.upload(),{'uploaded':4,'durable':False})
        self.assertEqual(self.target.read_bytes(),b'data')

    def test_short_pipe_writes_are_completed_and_invalid_counts_rejected(self):
        sent=bytearray()
        def write(data):sent.extend(data[:3]);return min(3,len(data))
        write_all(Mock(write=write),b'abcdefg',lambda:True);self.assertEqual(sent,b'abcdefg')
        with self.assertRaises(Error):write_all(Mock(write=Mock(return_value=0)),b'x',lambda:True)
