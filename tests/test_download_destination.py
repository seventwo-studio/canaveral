import collections
import errno
import hashlib
import os
import secrets
import stat
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.model import Error
from canaveral.sdk import LeaseClient


class Wire:
    def __init__(self,values):self.values=collections.deque(values);self.closed=0;self.sent=[];self.before_receive=lambda:None
    def receive(self,timeout):
        self.before_receive();value=self.values.popleft()
        if isinstance(value,Exception):raise value
        return value
    def send_control(self,value):self.sent.append(value)
    def __enter__(self):return self
    def __exit__(self,*args):self.closed+=1


class DownloadDestinationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.target=self.root/'download';self.request=str(uuid.uuid4())
        self.sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),secrets.token_urlsafe(32))
        self.sdk.create_session=Mock(return_value={'id':self.request})
        self.data=b'fixture\x00\r\n'*12000
        self.finish={'type':'finish','bytes':len(self.data),'sha256':hashlib.sha256(self.data).hexdigest()}
        self.wire=Wire([{'type':'begin','size':len(self.data)},
            *[self.data[i:i+65536] for i in range(0,len(self.data),65536)],self.finish])
        self.sdk.connect_session=Mock(return_value=self.wire)

    def receive(self,**kwargs):return self.sdk.download_to_file(self.request,'primary','guest/file',self.target,**kwargs)
    def no_temporary(self):self.assertEqual(list(self.root.glob('.canaveral-download-*')),[])

    def test_verified_file_is_private_complete_and_published_once(self):
        self.assertEqual(self.receive(),self.finish);self.assertEqual(self.target.read_bytes(),self.data)
        if os.name!='nt':self.assertEqual(stat.S_IMODE(self.target.stat().st_mode),0o600)
        self.no_temporary();self.assertEqual(self.wire.closed,1)
        self.sdk.create_session.assert_called_once_with(self.request,'primary','download')
        self.sdk.connect_session.assert_called_once()

    def test_bad_digest_preserves_existing_destination_and_removes_partial(self):
        self.target.write_bytes(b'original');self.wire.values[-1]={**self.finish,'sha256':'0'*64}
        with self.assertRaises(Error):self.receive(replace=True)
        self.assertEqual(self.target.read_bytes(),b'original');self.no_temporary();self.assertEqual(self.wire.closed,1)
        self.sdk.create_session.assert_called_once()

    def test_disconnect_preserves_existing_destination_without_replay(self):
        self.target.write_bytes(b'original');self.wire.values=collections.deque([
            {'type':'begin','size':8},b'part',Error('fixture disconnect',410)])
        with self.assertRaises(Error):self.receive(replace=True)
        self.assertEqual(self.target.read_bytes(),b'original');self.no_temporary()
        self.sdk.create_session.assert_called_once();self.sdk.connect_session.assert_called_once()

    def test_empty_file_is_published_only_after_verified_finish(self):
        finish={'type':'finish','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}
        self.wire.values=collections.deque([{'type':'begin','size':0},finish])
        self.assertEqual(self.receive(),finish);self.assertEqual(self.target.read_bytes(),b'');self.no_temporary()

    def test_cleanup_failure_is_explicit_and_keeps_destination_unchanged(self):
        self.target.write_bytes(b'original');self.wire.values[-1]={**self.finish,'sha256':'0'*64}
        with patch('canaveral.download_destination.os.unlink',side_effect=PermissionError('fixture cleanup')):
            with self.assertRaises(Error) as failure:self.receive(replace=True)
        self.assertEqual(failure.exception.code,'download_temporary_cleanup_failed')
        self.assertEqual(self.target.read_bytes(),b'original')
        self.assertEqual(len(list(self.root.glob('.canaveral-download-*'))),1)

    def test_existing_destination_is_refused_before_session_creation(self):
        self.target.write_bytes(b'original')
        with self.assertRaises(Error) as failure:self.receive()
        self.assertEqual(failure.exception.code,'download_destination_exists')
        self.assertEqual(self.target.read_bytes(),b'original');self.no_temporary();self.sdk.create_session.assert_not_called()

    @unittest.skipIf(os.name=='nt','POSIX symlink fixture')
    def test_dangling_symlink_is_an_existing_destination(self):
        self.target.symlink_to(self.root/'missing')
        with self.assertRaises(Error) as failure:self.receive()
        self.assertEqual(failure.exception.code,'download_destination_exists')
        self.assertTrue(self.target.is_symlink());self.sdk.create_session.assert_not_called()

    def test_concurrent_destination_creation_is_not_overwritten(self):
        def connect(session):self.target.write_bytes(b'racer');return self.wire
        self.sdk.connect_session.side_effect=connect
        with self.assertRaises(Error) as failure:self.receive()
        self.assertEqual(failure.exception.code,'download_destination_exists')
        self.assertEqual(self.target.read_bytes(),b'racer');self.no_temporary()

    def test_explicit_replace_preserves_old_file_until_verified_finish(self):
        self.target.write_bytes(b'original')
        self.wire.before_receive=lambda:self.assertEqual(self.target.read_bytes(),b'original')
        self.receive(replace=True)
        self.assertEqual(self.target.read_bytes(),self.data);self.no_temporary()

    def test_file_sync_failure_preserves_destination(self):
        self.target.write_bytes(b'original')
        with patch('canaveral.download_destination.os.fsync',side_effect=OSError(errno.ENOSPC,'fixture full')):
            with self.assertRaises(Error) as failure:self.receive(replace=True)
        self.assertEqual(failure.exception.code,'download_destination_failed')
        self.assertEqual(failure.exception.request_id,self.request)
        self.assertEqual(self.target.read_bytes(),b'original');self.no_temporary()

    @unittest.skipIf(os.name=='nt','POSIX directory fsync fixture')
    def test_directory_sync_failure_reports_uncertain_after_publication(self):
        original=os.fsync
        def sync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError(errno.EIO,'fixture directory sync')
            return original(fd)
        with patch('canaveral.download_destination.os.fsync',side_effect=sync):
            with self.assertRaises(Error) as failure:self.receive()
        self.assertEqual(failure.exception.code,'download_publication_uncertain')
        self.assertEqual(failure.exception.request_id,self.request)
        self.assertFalse(failure.exception.retryable)
        self.assertEqual(self.target.read_bytes(),self.data);self.no_temporary();self.sdk.create_session.assert_called_once()

    def test_lost_replace_receipt_never_claims_rollback(self):
        self.target.write_bytes(b'original');original=os.replace
        def replace(*args,**kwargs):original(*args,**kwargs);raise OSError(errno.EIO,'fixture lost receipt')
        with patch('canaveral.download_destination.os.replace',side_effect=replace):
            with self.assertRaises(Error) as failure:self.receive(replace=True)
        self.assertEqual(failure.exception.code,'download_publication_uncertain')
        self.assertEqual(self.target.read_bytes(),self.data);self.no_temporary();self.sdk.create_session.assert_called_once()

    def test_unowned_temporary_collision_is_not_removed(self):
        collision=self.root/('.canaveral-download-'+'a'*32);collision.write_bytes(b'foreign')
        with patch('canaveral.download_destination.secrets.token_hex',return_value='a'*32):
            with self.assertRaises(Error):self.receive()
        self.assertEqual(collision.read_bytes(),b'foreign');self.assertFalse(self.target.exists())
        self.sdk.create_session.assert_not_called()

    @unittest.skipIf(os.name=='nt','POSIX directory descriptor fixture')
    def test_parent_rename_keeps_publication_bound_to_original_directory(self):
        parent=self.root/'original';parent.mkdir();self.target=parent/'download';self.target.write_bytes(b'original')
        moved=self.root/'moved'
        def move():
            if self.wire.values and self.wire.values[0] is self.finish:
                parent.rename(moved);parent.mkdir();(parent/'download').write_bytes(b'other-directory')
        self.wire.before_receive=move;self.receive(replace=True)
        self.assertEqual((moved/'download').read_bytes(),self.data)
        self.assertEqual((parent/'download').read_bytes(),b'other-directory')
        self.assertFalse(list(moved.glob('.canaveral-download-*')))
