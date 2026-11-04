import base64
import hashlib
import http.client
import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.dashboard import server
from canaveral.guest_access import GuestAccess
from canaveral.model import Error
from canaveral.runner_sessions import RunnerSession
from canaveral.transfers import atomic_upload
from test_dashboard import DashboardFixture


class DashboardTransferAuthorizationTests(DashboardFixture):
    def setUp(self):
        super().setUp();self.allowed=True;self.closed=0
        self.target=Path(self.temp.name)/'existing';self.target.write_bytes(b'original')
        owner=self
        def upload(machine,path=None,app=None,reader=None,size=None,authorized=None,check_only=False):
            if check_only:return owner.allowed
            class RevokingReader:
                def read(self,count):
                    data=reader.read(count);owner.allowed=False;return data
            parent=os.open(owner.temp.name,os.O_RDONLY|os.O_DIRECTORY)
            try:return atomic_upload(parent,'existing',RevokingReader(),size,authorized)
            finally:os.close(parent)
        def download(machine,path=None,app=None,check_only=False):
            if check_only:return owner.allowed
            class Source:
                size=4
                def verify(self):pass
                def read(self,count):owner.allowed=False;return b'late'
                def close(self):owner.closed+=1
            return Source()
        service=server(('127.0.0.1',0),self.upstream,upload_connector=upload,download_connector=download)
        self.start(service);self.url='http://127.0.0.1:'+str(service.server_port)

    def test_upload_rechecks_lease_inside_cached_identity_window_and_preserves_destination(self):
        with patch('canaveral.dashboard.execution_monotonic',return_value=100):
            status,_,_=self.fetch('/api/v1/machines/'+str(uuid.uuid4())+'/files/upload',raw=b'new',token=self.admin,
                headers={'Content-Type':'application/octet-stream','X-Canaveral-Path':'existing'})
        self.assertEqual(status,401);self.assertEqual(self.target.read_bytes(),b'original')
        self.assertFalse(list(Path(self.temp.name).glob('.canaveral-upload-*')))

    def test_download_does_not_forward_data_returned_after_revocation_and_closes_source(self):
        options=base64.urlsafe_b64encode(json.dumps({'path':'fixture'}).encode()).decode().rstrip('=')
        with self.assertRaises(http.client.IncompleteRead) as failure:
            self.fetch('/api/v1/machines/'+str(uuid.uuid4())+'/files/download/'+options,token=self.admin)
        self.assertEqual(failure.exception.partial,b'');self.assertEqual(self.closed,1)


class BrokerTransferAuthorizationTests(unittest.TestCase):
    def session(self,connection,backend,allowed):
        session=object.__new__(RunnerSession)
        session.connection=connection;session.runtime=SimpleNamespace(access=backend)
        session.machine={};session.image={};session.folder=Path('.')
        session.authorized=lambda:allowed[0]
        return session

    def test_empty_upload_expiring_while_finish_arrives_never_opens_provider(self):
        allowed=[True];connection=Mock();backend=Mock()
        def receive(timeout):
            if connection.receive.call_count==1:return {'type':'begin','path':'fixture','size':0}
            allowed[0]=False
            return {'type':'finish','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}
        connection.receive.side_effect=receive
        with self.assertRaises(Error):self.session(connection,backend,allowed).upload()
        backend.stream_upload.assert_not_called()

    def test_final_upload_finish_after_expiry_preserves_destination(self):
        allowed=[True];connection=Mock();backend=Mock()
        responses=iter([{'type':'begin','path':'existing','size':3},b'new',
            {'type':'finish','bytes':3,'sha256':hashlib.sha256(b'new').hexdigest()}])
        def receive(timeout):
            value=next(responses)
            if isinstance(value,dict) and value['type']=='finish':allowed[0]=False
            return value
        connection.receive.side_effect=receive
        with tempfile.TemporaryDirectory() as root:
            target=Path(root)/'existing';target.write_bytes(b'original')
            def upload(machine,image,folder,path,app,reader,size,authorized):
                parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
                try:return atomic_upload(parent,'existing',reader,size,authorized)
                finally:os.close(parent)
            backend.stream_upload.side_effect=upload
            with self.assertRaises(Error):self.session(connection,backend,allowed).upload()
            self.assertEqual(target.read_bytes(),b'original')
            self.assertEqual([p.name for p in Path(root).iterdir()],['existing'])
        connection.send_control.assert_not_called()

    def test_download_expiring_inside_source_read_forwards_no_bytes_or_finish(self):
        allowed=[True];connection=Mock();backend=Mock();source=Mock(size=4)
        connection.receive.return_value={'type':'begin','path':'fixture'}
        def read(size):allowed[0]=False;return b'late'
        source.read.side_effect=read;backend.stream_download.return_value=source
        with self.assertRaises(Error):self.session(connection,backend,allowed).download()
        connection.send_bytes.assert_not_called();source.close.assert_called_once()
        self.assertEqual([call.args[0]['type'] for call in connection.send_control.call_args_list],['begin'])

    def test_expired_download_begin_never_opens_provider(self):
        connection=Mock();connection.receive.return_value={'type':'begin','path':'fixture'};backend=Mock()
        with self.assertRaises(Error):self.session(connection,backend,[False]).download()
        backend.stream_download.assert_not_called()


class GuestUploadAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'access-token.json').write_text('{"token":"fixture"}')
        self.access=GuestAccess({},self.root);self.access.tunnel=Mock(return_value=12345)

    def upload(self,authorized):
        return self.access.stream_upload({'id':'fixture'},{},self.root,'/fixture',None,io.BytesIO(b'new'),3,authorized)

    def test_expired_upload_never_opens_guest_connection(self):
        with patch('canaveral.guest_access.http.client.HTTPConnection') as connection:
            with self.assertRaises(Error):self.upload(lambda:False)
        connection.assert_not_called();self.access.tunnel.assert_not_called()

    def test_expiry_during_connection_setup_does_not_dispatch_headers(self):
        allowed=iter([True,False]);connection=Mock()
        with patch('canaveral.guest_access.http.client.HTTPConnection',return_value=connection):
            with self.assertRaises(Error):self.upload(lambda:next(allowed))
        connection.endheaders.assert_not_called();connection.close.assert_called_once()

    def test_expiry_during_guest_acknowledgement_is_uncertain_not_success(self):
        allowed=[True];connection=Mock();response=Mock(status=200)
        def read(count):allowed[0]=False;return b'{"uploaded":3,"durable":true}'
        response.read.side_effect=read;connection.getresponse.return_value=response
        with patch('canaveral.guest_access.http.client.HTTPConnection',return_value=connection):
            with self.assertRaises(Error) as failure:self.upload(lambda:allowed[0])
        self.assertIn('publication may have occurred',str(failure.exception))
        connection.send.assert_called_once_with(b'new');connection.close.assert_called_once()
