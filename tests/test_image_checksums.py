import hashlib
import io
import os
import json
import pathlib
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

from canaveral.image_library import ImageLibrary,checksum
from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer
import secrets


def metadata(**extra):
    return {'id':str(uuid.uuid4()),'name':'Fixture image','os':'linux','arch':'amd64','mode':'headless',
            'mediaType':'disk','format':'raw','minimum':{'cpu':1,'memoryMiB':1024,'diskGiB':4},**extra}


class ImageChecksumTests(unittest.TestCase):
    def test_stable_sparse_file_hashes_its_complete_logical_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'artifact'
            with path.open('wb') as output:output.write(b'prefix');output.seek(2097152);output.write(b'end')
            expected=hashlib.sha256(b'prefix'+b'\0'*(2097152-6)+b'end').hexdigest()
            self.assertEqual(checksum(path),expected)

    @unittest.skipIf(os.name=='nt','POSIX FIFO/symlink fixture; native Windows acceptance is separate.')
    def test_nonregular_artifact_reuse_is_bounded_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            code='''import sys,os,pathlib,hashlib,io,stat
from canaveral.image_library import ImageLibrary,checksum
from canaveral.model import Error
root=pathlib.Path(sys.argv[1]);payload=b"x"*512;digest=hashlib.sha256(payload).hexdigest()
for kind in ("fifo","symlink","directory"):
 library=ImageLibrary(root/kind);artifact=library.root/(digest+".raw")
 if kind=="fifo":os.mkfifo(artifact)
 elif kind=="symlink":
  target=root/"retained";target.write_bytes(payload);artifact.symlink_to(target)
 else:artifact.mkdir()
 before=artifact.lstat()
 image={"image":str(artifact),"artifactSha256":digest}
 metadata={"id":"90eac290-44dc-448d-aa50-53a0f00a1400","name":"Fixture","os":"linux","arch":"amd64","mode":"headless","mediaType":"disk","format":"raw","minimum":{"cpu":1,"memoryMiB":1024,"diskGiB":4}}
 for attempt in (lambda:checksum(artifact),lambda:library.verify_definition(image),lambda:library.import_stream(metadata,io.BytesIO(payload),512,lambda:True)):
  try:attempt()
  except Error:pass
  else:raise AssertionError("Nonregular artifact accepted")
 assert artifact.lstat().st_ino==before.st_ino and library.records()==[] and library.verified=={}
 assert list(library.root.glob("*.partial"))==[]
print("Nonregular checksum/provision/reuse refusal: PASS")
'''
            result=subprocess.run([sys.executable,'-c',code,directory],capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_replaced_path_before_descriptor_open_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'artifact';path.write_bytes(b'x'*512);opened=os.open;swapped=[]
            def open_artifact(file,flags,*args,**kwargs):
                if pathlib.Path(file)==path and not swapped:
                    swapped.append(True);path.rename(path.with_suffix('.retained'));path.write_bytes(b'y'*512)
                return opened(file,flags,*args,**kwargs)
            with patch('canaveral.image_library.os.open',side_effect=open_artifact):
                with self.assertRaises(Error):checksum(path)
            self.assertEqual(path.read_bytes(),b'y'*512)

    def test_growing_replaced_and_restored_timestamp_files_never_return_a_verified_digest(self):
        for kind in ('growth','replacement','restored-mtime'):
            if os.name=='nt' and kind=='restored-mtime':continue
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                path=pathlib.Path(directory)/'artifact';path.write_bytes(b'x'*2097152)
                before=path.stat();fdopen=os.fdopen;limits=[]
                class Changed:
                    def __init__(self,source):self.source=source;self.done=False
                    def __enter__(self):return self
                    def __exit__(self,*args):self.source.close()
                    def fileno(self):return self.source.fileno()
                    def read(self,count):
                        limits.append(count);data=self.source.read(count)
                        if not self.done:
                            self.done=True
                            if kind=='growth':
                                with path.open('ab') as output:output.write(b'extension')
                            elif kind=='replacement':path.rename(path.with_suffix('.retained'));path.write_bytes(b'y'*2097152)
                            else:
                                with path.open('r+b') as output:output.seek(1048576);output.write(b'y'*1048576)
                                os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))
                        return data
                with patch('canaveral.image_library.os.fdopen',side_effect=lambda descriptor,mode:Changed(fdopen(descriptor,mode))):
                    with self.assertRaises(Error):checksum(path)
                self.assertEqual(limits,[1048576,1048576]) # Never follows a growing tail.
                if kind=='restored-mtime':
                    self.assertEqual(path.stat().st_mtime_ns,before.st_mtime_ns)
                    self.assertNotEqual(path.stat().st_ctime_ns,before.st_ctime_ns)

    def test_alias_dedup_and_format_specific_storage_accounting_match_actual_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);library=ImageLibrary(root/'runner');store=Store(root/'controller.db')
            host=str(uuid.uuid4());token=secrets.token_urlsafe(32)
            store.enroll({'id':host,'credential':token,'offer':host_offer()})
            payload=bytearray(512);payload[:4]=b'QFI\xfb';payload[4:8]=struct.pack('!I',3);payload=bytes(payload)
            results=[]
            for format,expected in (('raw',1),('raw',1),('qcow2',2)):
                value=metadata(format=format);store.reserve_image_import(host,value,len(payload))
                public=library.import_stream(value,io.BytesIO(payload),len(payload),lambda:True)
                store.finish_image_import(value['id'],host,public);results.append(public)
                self.assertEqual(store.hosts()[0]['reserved']['diskGiB'],expected)
            library.acknowledge({value['id']:value['sha256'] for value in results})
            definitions={value['id']:value for value in library.definitions()}
            self.assertEqual(definitions[results[0]['id']]['image'],definitions[results[1]['id']]['image'])
            self.assertNotEqual(definitions[results[0]['id']]['image'],definitions[results[2]['id']]['image'])
            for result in results:self.assertEqual(checksum(definitions[result['id']]['image']),result['sha256'])
            category=next(item for item in store.host_resources(host)['categories'] if item['id']=='images')
            self.assertEqual(category['diskGiB'],2)
