import hashlib
import io
import os
import shutil
import tempfile
import unittest
import uuid
import threading
import time
from pathlib import Path
from unittest.mock import patch

from android_transfer_fixture import compile_helper,provider
from canaveral.model import Error
from test_runner_sessions import RunnerFixture


@unittest.skipUnless(os.name!='nt' and shutil.which('cc'),'POSIX C compiler required for native helper fixtures.')
class AndroidTransferSessionTests(RunnerFixture):
    @classmethod
    def setUpClass(cls):
        super().setUpClass();cls.build=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.build.cleanup)
        cls.binary=compile_helper(cls.build.name)

    def setUp(self):
        super().setUp();root=Path(self.temp.name)/'android-helper';root.mkdir()
        self.native=provider(root,self.binary,filesystem_root=self.temp.name)
        self.backend.stream_upload=self.native.stream_upload
        self.backend.require_durable_upload=self.native.require_durable_upload
        loader=patch('canaveral.android_transfer.load_helper',return_value=(self.native.payload,self.native.digest))
        launcher=patch('canaveral.android_transfer.assignment_popen',side_effect=self.native.launch)
        loader.start();launcher.start();self.addCleanup(loader.stop);self.addCleanup(launcher.stop)

    def test_controller_runner_sdk_confirms_native_multichunk_and_empty_upload(self):
        for data in (b'native\x00\r\n'*12000,b''):
            with self.subTest(size=len(data)):
                destination=self.backend.root/'destination';request=str(uuid.uuid4())
                result=self.sdk.upload(request,'primary',str(destination),io.BytesIO(data),len(data))
                self.assertEqual(result,{'type':'finish','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'durable':True})
                self.assertEqual(destination.read_bytes(),data);self.assertEqual(self.wait_receipt(request)['state'],'complete')

    def test_bad_digest_preserves_destination_without_native_commit_or_replay(self):
        destination=self.backend.root/'retained';destination.write_bytes(b'original');request=str(uuid.uuid4())
        session=self.sdk.create_session(request,'primary','upload')
        with self.sdk.connect_session(session) as connection:
            connection.send_control({'type':'begin','path':str(destination),'size':3});connection.send_bytes(b'new')
            connection.send_control({'type':'finish','bytes':3,'sha256':'0'*64})
            result=connection.receive(3);self.assertEqual(result['type'],'error')
        self.assertEqual(destination.read_bytes(),b'original');self.assertEqual(self.wait_receipt(request)['state'],'unknown')
        self.assertEqual(len(self.native.processes),1)
        self.assertFalse(list(self.backend.root.glob('.canaveral-upload-*')))

    def test_unconfigured_consumer_upload_is_refused_before_guest_mutation(self):
        self.native.config={};destination=self.backend.root/'retained';destination.write_bytes(b'original')
        with self.assertRaises(Error):self.sdk.upload(str(uuid.uuid4()),'primary',str(destination),io.BytesIO(b'new'),3)
        self.assertEqual(destination.read_bytes(),b'original');self.assertEqual(self.native.calls,[])

    def test_observed_unsupported_worker_stops_upload_with_code_and_session_identity(self):
        self.native.config={};request=str(uuid.uuid4());connections=[]
        original=self.sdk.connect_session
        def connect(session):
            connection=original(session);connections.append(connection);return connection
        self.sdk.connect_session=connect
        owner=self
        class Reader:
            def read(self,size):
                deadline=time.monotonic()+3
                while connections[0].worker_error is None and time.monotonic()<deadline:threading.Event().wait(.01)
                owner.assertIsNotNone(connections[0].worker_error);return b'new'
        with self.assertRaises(Error) as failure:self.sdk.upload(request,'primary','/fixture',Reader(),3)
        self.assertEqual(failure.exception.code,'capability_unsupported')
        self.assertEqual(failure.exception.outcome,'unknown');self.assertEqual(failure.exception.request_id,request)
        self.assertEqual(self.native.calls,[])

    def test_native_postcommit_failure_reaches_sdk_as_uncertain_publication(self):
        destination=self.backend.root/'retained';destination.write_bytes(b'original')
        self.native.failure='directory-sync';request=str(uuid.uuid4())
        with self.assertRaises(Error) as failure:self.sdk.upload(request,'primary',str(destination),io.BytesIO(b'new'),3)
        self.assertEqual(failure.exception.code,'upload_publication_uncertain')
        self.assertEqual(failure.exception.outcome,'unknown');self.assertEqual(failure.exception.request_id,request)
        self.assertEqual(destination.read_bytes(),b'new');self.assertEqual(self.wait_receipt(request)['state'],'unknown')
