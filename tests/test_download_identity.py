import http.client
import base64
import io
import json
import os
import secrets
import tempfile
import threading
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from canaveral.guest import server as guest
from canaveral.guest_access import GuestAccess
from canaveral.model import Error
from canaveral.dashboard import server as dashboard_server
from canaveral.transfers import Download
from test_dashboard import DashboardFixture


class DownloadIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        token=secrets.token_urlsafe(32);self.patch=patch.object(guest,'TOKEN',token);self.patch.start();self.addCleanup(self.patch.stop)
        (self.root/'access-token.json').write_text(json.dumps({'token':token}))
        self.service=ThreadingHTTPServer(('127.0.0.1',0),guest.Handler)
        thread=threading.Thread(target=self.service.serve_forever,daemon=True);thread.start()
        self.addCleanup(self.service.server_close);self.addCleanup(self.service.shutdown)
        self.access=GuestAccess({},self.root);self.access.tunnel=lambda *args:self.service.server_port

    def download(self,path):return self.access.stream_download({'id':'fixture'},{},self.root,str(path),None)

    def test_guest_http_identity_verifies_unchanged_file_and_rejects_replacement(self):
        path=self.root/'file';path.write_bytes(b'original data')
        source=self.download(path)
        try:
            self.assertEqual(source.read(source.size),b'original data');source.verify()
            replacement=self.root/'replacement';replacement.write_bytes(b'original data');replacement.replace(path)
            with self.assertRaises(Error):source.verify()
        finally:source.close()

    def test_same_inode_mutation_and_unauthenticated_head_are_rejected(self):
        path=self.root/'file';path.write_bytes(b'original data');source=self.download(path)
        try:
            self.assertEqual(source.read(source.size),b'original data')
            previous=path.stat();path.write_bytes(b'modified data')
            os.utime(path,ns=(previous.st_atime_ns,previous.st_mtime_ns+1000000000))
            with self.assertRaises(Error):source.verify()
        finally:source.close()
        connection=http.client.HTTPConnection('127.0.0.1',self.service.server_port,timeout=2)
        try:
            connection.request('HEAD','/file',headers={'X-Canaveral-Path':str(path)})
            response=connection.getresponse();self.assertEqual(response.status,401)
            self.assertIsNone(response.getheader('X-Canaveral-File-Identity'));self.assertEqual(response.read(),b'')
        finally:connection.close()


class DashboardDownloadIdentityTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.path=Path(self.temp.name)/'file';self.path.write_bytes(b'a'*(1048576+17))
        self.allowed=True;self.closed=0;self.reads=0;self.checks=0
        self.source_closed=threading.Event()
        self.after_read=lambda:None
        self.before_verify=lambda:None
        self.open_source=lambda:Download(self.path.open('rb'),self.path.stat().st_size)
        owner=self
        def download(machine,path=None,app=None,check_only=False):
            if check_only:return owner.allowed
            source=owner.open_source()
            class Source:
                size=source.size
                def read(self,count):
                    data=source.read(count);owner.reads+=1;owner.after_read();return data
                def verify(self):
                    owner.checks+=1;owner.before_verify();source.verify()
                def close(self):
                    source.close();owner.closed+=1;owner.source_closed.set()
            return Source()
        service=dashboard_server(('127.0.0.1',0),self.upstream,download_connector=download)
        self.start(service);self.url='http://127.0.0.1:'+str(service.server_port)
        options=base64.urlsafe_b64encode(json.dumps({'path':'file'}).encode()).decode().rstrip('=')
        self.route='/api/v1/machines/'+str(uuid.uuid4())+'/files/download/'+options

    def fetch(self,*args,**kwargs):
        # Receiving the last byte (or zero-length headers) can precede the
        # server's finally block. Join its cleanup before inspecting counters.
        try:
            return super().fetch(*args,**kwargs)
        finally:
            self.assertTrue(self.source_closed.wait(3), 'Download source did not close')

    def test_unchanged_multichunk_file_completes_and_closes(self):
        status,_,body=self.fetch(self.route,token=self.admin)
        self.assertEqual(status,200);self.assertEqual(body,self.path.read_bytes())
        self.assertEqual((self.reads,self.checks,self.closed),(2,2,1))

    def test_same_size_mutation_withholds_final_block(self):
        def mutate():
            if self.reads==1:
                previous=self.path.stat()
                self.path.write_bytes(b'b'*(1048576+17))
                os.utime(self.path,ns=(previous.st_atime_ns,previous.st_mtime_ns+1000000000))
        self.after_read=mutate
        with self.assertRaises(http.client.IncompleteRead) as failure:self.fetch(self.route,token=self.admin)
        self.assertEqual(failure.exception.partial,b'a'*1048576)
        self.assertEqual((self.checks,self.closed),(2,1))

    def test_truncation_ends_short_and_closes(self):
        def truncate():
            if self.reads==1:self.path.write_bytes(b'')
        self.after_read=truncate
        with self.assertRaises(http.client.IncompleteRead) as failure:self.fetch(self.route,token=self.admin)
        self.assertEqual(len(failure.exception.partial),1048576);self.assertEqual(self.closed,1)

    def test_changed_before_headers_returns_conflict_without_file_bytes(self):
        self.before_verify=lambda:self.path.write_bytes(b'changed')
        status,headers,body=self.fetch(self.route,token=self.admin)
        self.assertEqual(status,409);self.assertIn('application/json',headers['Content-Type'])
        self.assertEqual(set(json.loads(body)),{'error'});self.assertEqual((self.reads,self.closed),(0,1))

    def test_empty_file_is_verified_and_closed(self):
        self.path.write_bytes(b'')
        status,_,body=self.fetch(self.route,token=self.admin)
        self.assertEqual((status,body,self.checks,self.closed),(200,b'',1,1))

    def test_unverifiable_source_is_refused_before_success_headers(self):
        self.open_source=lambda:Download(io.BytesIO(b'file'),4)
        status,headers,_=self.fetch(self.route,token=self.admin)
        self.assertEqual(status,409);self.assertIn('application/json',headers['Content-Type'])
        self.assertEqual((self.reads,self.closed),(0,1))

    def test_revocation_during_final_verification_withholds_final_block(self):
        def revoke():
            if self.checks==2:self.allowed=False
        self.before_verify=revoke
        with self.assertRaises(http.client.IncompleteRead) as failure:self.fetch(self.route,token=self.admin)
        self.assertEqual(failure.exception.partial,b'a'*1048576);self.assertEqual(self.closed,1)
