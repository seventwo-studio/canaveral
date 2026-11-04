import io
import os
import tempfile
import unittest
import stat
from unittest.mock import patch
from pathlib import Path
from canaveral.model import Error
from canaveral.transfers import CHUNK, copy_upload, atomic_upload, confined_file


class TransferTests(unittest.TestCase):
    def test_revocation_during_a_blocking_read_does_not_forward_returned_bytes(self):
        allowed=[True];sink=io.BytesIO()
        class Reader:
            def read(self,size):allowed[0]=False;return b'late'
        with self.assertRaises(Error):copy_upload(Reader(),sink,4,lambda:allowed[0])
        self.assertEqual(sink.getvalue(),b'')

    def test_oversized_source_chunk_is_rejected_before_writing(self):
        sink=io.BytesIO()
        class Reader:
            def read(self,size):return b'excess'
        with self.assertRaises(Error):copy_upload(Reader(),sink,1)
        self.assertEqual(sink.getvalue(),b'')

    def test_success_requires_file_and_published_directory_to_be_synced(self):
        with tempfile.TemporaryDirectory() as root:
            parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY);seen=[];original=os.fsync
            def sync(fd):
                directory=stat.S_ISDIR(os.fstat(fd).st_mode)
                if directory:self.assertEqual((Path(root)/'file').read_bytes(),b'durable')
                seen.append(directory);original(fd)
            try:
                with patch('canaveral.transfers.os.fsync',side_effect=sync):result=atomic_upload(parent,'file',io.BytesIO(b'durable'),7)
                self.assertTrue(result['durable'])
                self.assertEqual(seen,[False,True])
                def fail_directory(fd):
                    if fd==parent:raise OSError('Durability confirmation unavailable')
                    original(fd)
                with patch('canaveral.transfers.os.fsync',side_effect=fail_directory):
                    with self.assertRaises(OSError):atomic_upload(parent,'file',io.BytesIO(b'new'),3)
            finally:os.close(parent)

    def test_large_transfers_use_bounded_buffers_without_total_size_cap(self):
        total=513*1024*1024+17
        class Reader:
            largest=0
            def read(self,size):self.largest=max(self.largest,size);return b'x'*size
        class Writer:
            count=0
            def write(self,data):self.count+=len(data)
        source,sink=Reader(),Writer()
        copy_upload(source,sink,total)
        self.assertEqual(sink.count,total)
        self.assertLessEqual(source.largest,CHUNK)

    def test_interruption_and_revocation_preserve_existing_destination(self):
        with tempfile.TemporaryDirectory() as root:
            target=Path(root)/'existing';target.write_bytes(b'original')
            parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            try:
                with self.assertRaises(Error):atomic_upload(parent,'existing',io.BytesIO(b'partial'),100)
                self.assertEqual(target.read_bytes(),b'original')
                with self.assertRaises(Error):atomic_upload(parent,'existing',io.BytesIO(b'new'),3,lambda:False)
                self.assertEqual(target.read_bytes(),b'original')
                self.assertEqual([p.name for p in Path(root).iterdir()],['existing'])
                atomic_upload(parent,'existing',io.BytesIO(b'complete'),8)
                self.assertEqual(target.read_bytes(),b'complete')
            finally:os.close(parent)

    def test_app_container_transfers_cannot_follow_symlink_directories(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as other:
            (Path(root)/'outside').symlink_to(other,target_is_directory=True)
            for path in ('../escape','/absolute'):
                with self.assertRaises(Error):confined_file(root,path)
            with self.assertRaises(OSError):confined_file(root,'outside/file')
            parent,name=confined_file(root,'safe.txt')
            try:atomic_upload(parent,name,io.BytesIO(b'data'),4)
            finally:os.close(parent)
            self.assertEqual((Path(root)/'safe.txt').read_bytes(),b'data')
