import hashlib
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from canaveral.model import Error
from canaveral.templates import prepare_image


def specification(path, payload):
    return {'path':str(path),'sha256':hashlib.sha256(payload).hexdigest(),'format':'raw'}


class BaseCacheTests(unittest.TestCase):
    def test_competing_publisher_keeps_its_file_and_corrupt_data_is_not_overwritten(self):
        for valid in (False, True):
            with self.subTest(valid=valid), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/'source';payload=b'base-image';source.write_bytes(payload)
                spec=specification(source,payload);cache=root/'cache';target=cache/(spec['sha256']+'.raw')
                fsync=os.fsync;winner=[]
                def publish_competitor(descriptor):
                    fsync(descriptor)
                    if not winner:
                        target.write_bytes(payload if valid else b'competing-data')
                        winner.append(target.stat().st_ino)
                with patch('canaveral.templates.os.fsync',side_effect=publish_competitor):
                    if valid:self.assertEqual(prepare_image(spec,cache),str(target.resolve()))
                    else:
                        with self.assertRaises(Error):prepare_image(spec,cache)
                self.assertEqual(target.stat().st_ino,winner[0])
                self.assertEqual(target.read_bytes(),payload if valid else b'competing-data')
                self.assertEqual(list(cache.iterdir()),[target])

    @unittest.skipIf(os.name=='nt','POSIX nonregular-file fixtures; Windows acceptance is separate.')
    def test_nonregular_cache_and_local_sources_fail_without_waiting_or_fetching(self):
        with tempfile.TemporaryDirectory() as folder:
            code='''import hashlib,os,pathlib,sys
from unittest.mock import patch
from canaveral.model import Error
from canaveral.templates import prepare_image
root=pathlib.Path(sys.argv[1]);payload=b"base-image";digest=hashlib.sha256(payload).hexdigest()
retained=root/"retained";retained.write_bytes(payload)
for kind in ("fifo","symlink","dangling","directory"):
 cache=root/kind;cache.mkdir();target=cache/(digest+".raw")
 if kind=="fifo":os.mkfifo(target)
 elif kind=="directory":target.mkdir()
 else:target.symlink_to(retained if kind=="symlink" else root/"missing")
 inode=target.lstat().st_ino
 with patch("canaveral.templates.urllib.request.build_opener",side_effect=AssertionError("Fetched despite existing entry")):
  try:prepare_image({"url":"https://fixture.invalid/base","sha256":digest,"format":"raw"},cache)
  except Error:pass
  else:raise AssertionError("Accepted nonregular cache")
 assert target.lstat().st_ino==inode and not list(cache.glob("*.partial"))
for kind in ("fifo","directory"):
 source=root/(kind+"-source")
 if kind=="fifo":os.mkfifo(source)
 else:source.mkdir()
 cache=root/(kind+"-local-cache")
 try:prepare_image({"path":str(source),"sha256":digest,"format":"raw"},cache)
 except Error:pass
 else:raise AssertionError("Accepted nonregular source")
 assert list(cache.iterdir())==[]
assert retained.read_bytes()==payload
'''
            result=subprocess.run([sys.executable,'-c',code,folder],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)

    @unittest.skipIf(os.name=='nt','Source symlink fixture requires POSIX permissions.')
    def test_owner_selected_source_symlink_produces_an_independent_regular_cache_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source';payload=b'base-image';source.write_bytes(payload)
            link=root/'configured-source';link.symlink_to(source)
            target=Path(prepare_image(specification(link,payload),root/'cache'))
            self.assertTrue(stat.S_ISREG(target.lstat().st_mode))
            self.assertNotEqual(target.stat().st_ino,source.stat().st_ino)
            source.write_bytes(b'changed-at-source')
            self.assertEqual(target.read_bytes(),payload)

    def test_source_mutation_is_rejected_and_reads_do_not_follow_a_growing_tail(self):
        for kind in ('growth','replacement','restored-mtime'):
            if os.name=='nt' and kind=='restored-mtime':continue
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/'source';payload=b'x'*2097152;source.write_bytes(payload)
                spec=specification(source,payload);before=source.stat();fdopen=os.fdopen;limits=[]
                class Changed:
                    def __init__(self,stream):self.stream=stream;self.done=False
                    def __enter__(self):return self
                    def __exit__(self,*args):self.stream.close()
                    def fileno(self):return self.stream.fileno()
                    def read(self,count):
                        limits.append(count);data=self.stream.read(count)
                        if not self.done:
                            self.done=True
                            if kind=='growth':
                                with source.open('ab') as output:output.write(b'extension')
                            elif kind=='replacement':source.rename(root/'retained');source.write_bytes(payload)
                            else:
                                with source.open('r+b') as output:output.seek(1048576);output.write(b'y'*1048576)
                                os.utime(source,ns=(before.st_atime_ns,before.st_mtime_ns))
                        return data
                def wrapped(descriptor,mode):
                    stream=fdopen(descriptor,mode)
                    return Changed(stream) if mode=='rb' else stream
                with patch('canaveral.templates.os.fdopen',side_effect=wrapped):
                    with self.assertRaises(Error):prepare_image(spec,root/'cache')
                self.assertEqual(limits,[1048576,1048576])
                self.assertEqual(list((root/'cache').iterdir()),[])

    def test_sparse_and_empty_sources_preserve_logical_contents(self):
        for payload in (b'', b'prefix'+b'\0'*(2097152-6)+b'end'):
            with self.subTest(size=len(payload)), tempfile.TemporaryDirectory() as folder:
                root=Path(folder);source=root/'source';source.write_bytes(payload)
                target=Path(prepare_image(specification(source,payload),root/'cache'))
                self.assertEqual(target.stat().st_size,len(payload))
                self.assertEqual(target.read_bytes(),payload)

    def test_interrupted_invalid_and_wrong_digest_https_streams_leave_no_cache_entry(self):
        class Interrupted(io.BytesIO):
            def read(self,count):
                if self.tell():raise OSError('fixture interrupted')
                return super().read(count)
        class Oversized(io.BytesIO):
            def read(self,count):return b'x'*(count+1)
        for stream,error in ((Interrupted(b'partial'),OSError),(Oversized(),Error),(io.BytesIO(b'wrong'),Error)):
            with self.subTest(stream=type(stream).__name__), tempfile.TemporaryDirectory() as folder:
                cache=Path(folder)/'cache';spec={'url':'https://fixture.invalid/base','sha256':'0'*64,'format':'raw'}
                with patch('canaveral.templates.urllib.request.build_opener') as opener:
                    opener.return_value.open.return_value=stream
                    with self.assertRaises(error):prepare_image(spec,cache)
                self.assertTrue(stream.closed)
                self.assertEqual(list(cache.iterdir()),[])

    def test_verified_https_streams_publish_complete_multichunk_and_empty_images(self):
        for payload in (b'', b'prefix'+b'\0'*2097152+b'end'):
            with self.subTest(size=len(payload)), tempfile.TemporaryDirectory() as folder:
                cache=Path(folder)/'cache';spec={'url':'https://fixture.invalid/base',
                    'sha256':hashlib.sha256(payload).hexdigest(),'format':'raw'}
                stream=io.BytesIO(payload)
                with patch('canaveral.templates.urllib.request.build_opener') as opener:
                    opener.return_value.open.return_value=stream
                    target=Path(prepare_image(spec,cache))
                self.assertTrue(stream.closed)
                self.assertEqual(target.read_bytes(),payload)
                self.assertEqual(list(cache.iterdir()),[cache/target.name])

    @unittest.skipIf(os.name=='nt','POSIX directory synchronization contract.')
    def test_directory_sync_failure_preserves_visible_image_and_reports_uncertain_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source';payload=b'base-image';source.write_bytes(payload)
            spec=specification(source,payload);cache=root/'cache';fsync=os.fsync
            def fail_directory(descriptor):
                if stat.S_ISDIR(os.fstat(descriptor).st_mode):raise OSError('fixture directory sync failed')
                fsync(descriptor)
            with patch('canaveral.templates.os.fsync',side_effect=fail_directory):
                with self.assertRaises(Error) as caught:prepare_image(spec,cache)
            self.assertEqual(caught.exception.code,'image_cache_publication_uncertain')
            self.assertEqual(caught.exception.outcome,'unknown')
            self.assertFalse(caught.exception.retryable)
            target=cache/(spec['sha256']+'.raw')
            self.assertEqual(target.read_bytes(),payload)
            self.assertEqual(list(cache.iterdir()),[target])

    def test_failed_no_clobber_publication_does_not_fall_back_to_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source';payload=b'base-image';source.write_bytes(payload)
            with patch('canaveral.templates.os.link',side_effect=OSError('fixture link unsupported')):
                with self.assertRaises(Error) as caught:prepare_image(specification(source,payload),root/'cache')
            self.assertEqual(caught.exception.code,'image_cache_publication_uncertain')
            self.assertEqual(list((root/'cache').iterdir()),[])
