import contextlib
import json
import os
import stat
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.files import save_json
from canaveral.image_library import ImageLibrary,checksum
from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer,request
import secrets


class CaptureIntegrityTests(unittest.TestCase):
    def fixture(self,root,callback=None):
        disk=root/'source.raw';disk.write_bytes(b'a'*1048576+b'b'*1048576)
        machine_id=str(uuid.uuid4());task={'id':str(uuid.uuid4()),'machineId':machine_id,'name':'Configured fixture',
            'machine':{'id':machine_id,'desired':'stopped','observed':'stopped','resources':{'cpu':2,'memoryMiB':4096,'diskGiB':32}}}
        library=ImageLibrary(root/'runner');image={'os':'linux','arch':'arm64','mode':'desktop'}
        class Runtime:
            calls=0
            @contextlib.contextmanager
            def capture_source(self,*args):
                self.calls+=1;yield disk,'raw'
                if callback:callback(library,task,disk)
        return library,task,disk,Runtime(),image

    def test_fence_exit_failure_never_publishes_and_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            def failed_exit(library,task,disk):
                self.assertTrue((library.root/(task['id']+'.staged')).exists())
                self.assertFalse((library.root/(task['id']+'.json')).exists())
                raise OSError('Fixture fence release failed')
            library,task,disk,runtime,image=self.fixture(Path(directory),failed_exit);original=checksum(disk)
            result=library.capture(task,runtime,image,None)
            self.assertEqual(result['state'],'unknown');self.assertEqual(library.records(),[])
            self.assertTrue((library.root/(task['id']+'.quarantined')).exists())
            self.assertEqual(checksum(disk),original)
            self.assertEqual(library.capture(task,runtime,image,None),result);self.assertEqual(runtime.calls,1)

    @unittest.skipIf(os.name=='nt','Windows native change-time capture acceptance remains open.')
    def test_write_with_restored_mtime_during_copy_is_quarantined(self):
        with tempfile.TemporaryDirectory() as directory:
            library,task,disk,runtime,image=self.fixture(Path(directory));before=disk.stat();original=library.import_stream
            def copy(metadata,reader,size,authorized,**kwargs):
                class Changed:
                    done=False
                    def read(inner,count):
                        data=reader.read(count)
                        if not inner.done:
                            inner.done=True
                            with disk.open('r+b') as output:output.seek(1048576);output.write(b'c'*1048576)
                            os.utime(disk,ns=(before.st_atime_ns,before.st_mtime_ns))
                        return data
                return original(metadata,Changed(),size,authorized,**kwargs)
            with patch.object(library,'import_stream',side_effect=copy):result=library.capture(task,runtime,image,None)
            self.assertEqual(disk.stat().st_mtime_ns,before.st_mtime_ns)
            self.assertNotEqual(disk.stat().st_ctime_ns,before.st_ctime_ns)
            self.assertEqual(result['state'],'unknown');self.assertEqual(library.records(),[])
            self.assertTrue((library.root/(task['id']+'.quarantined')).exists())

    def test_source_path_swap_before_open_cannot_change_the_pinned_copy(self):
        for kind in (('file',) if os.name=='nt' else ('file','symlink','fifo')):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                library,task,disk,runtime,image=self.fixture(Path(directory));opened=os.open;swapped=[]
                def open_source(path,flags,*args,**kwargs):
                    if Path(path)==disk and not swapped:
                        swapped.append(True);old=disk.with_suffix('.retained');disk.rename(old)
                        if kind=='file':disk.write_bytes(b'x'*2097152)
                        elif kind=='symlink':disk.symlink_to(old)
                        else:os.mkfifo(disk)
                    return opened(path,flags,*args,**kwargs)
                with patch('canaveral.image_library.os.open',side_effect=open_source):result=library.capture(task,runtime,image,None)
                self.assertEqual(result['state'],'failed');self.assertEqual(library.records(),[])
                self.assertEqual(list(library.root.glob('*.partial')),[])

    def test_source_change_during_context_exit_is_not_published(self):
        with tempfile.TemporaryDirectory() as directory:
            def changed_exit(library,task,disk):
                before=disk.stat()
                disk.write_bytes(b'changed source')
                os.utime(disk,ns=(before.st_atime_ns,before.st_mtime_ns))
            library,task,disk,runtime,image=self.fixture(Path(directory),changed_exit)
            self.assertEqual(library.capture(task,runtime,image,None)['state'],'unknown')
            self.assertEqual(library.records(),[])

    def test_success_is_independent_and_lost_receipt_recovery_checks_manifest_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            exited=[]
            def finish(library,task,disk):
                self.assertFalse((library.root/(task['id']+'.json')).exists());exited.append(True)
            library,task,disk,runtime,image=self.fixture(Path(directory),finish)
            result=library.capture(task,runtime,image,None);self.assertEqual(result['state'],'succeeded');self.assertEqual(exited,[True])
            record_path=library.root/(task['id']+'.json');record=json.loads(record_path.read_text());artifact=Path(record['definition']['image'])
            self.assertNotEqual(artifact.stat().st_ino,disk.stat().st_ino)
            disk.write_bytes(b'reconfigured source')
            self.assertEqual(checksum(artifact),result['result']['sha256'])
            receipt=library.root/(task['id']+'.capture.json.receipt');started=json.loads(receipt.read_text());started.pop('report');started['started']=True
            save_json(receipt,started);self.assertEqual(library.capture(task,runtime,image,None),result)
            record['public']['name']='Different capture';save_json(record_path,record)
            self.assertEqual(library.capture(task,runtime,image,None)['state'],'unknown');self.assertEqual(runtime.calls,1)

    def test_directory_sync_failure_after_publication_is_unknown_not_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            library,task,disk,runtime,image=self.fixture(Path(directory));sync=os.fsync;fault=[]
            def fail_publication_sync(descriptor):
                if stat.S_ISDIR(os.fstat(descriptor).st_mode) and (library.root/(task['id']+'.json')).exists() and not fault:
                    fault.append(True);raise OSError('Publication directory sync unconfirmed')
                return sync(descriptor)
            with patch('canaveral.image_library.os.fsync',side_effect=fail_publication_sync):result=library.capture(task,runtime,image,None)
            self.assertEqual(fault,[True]);self.assertEqual(result['state'],'unknown');self.assertEqual(library.definitions(),[])
            record=library.records()[0];self.assertEqual(checksum(record['definition']['image']),record['public']['sha256'])
            self.assertEqual(library.capture(task,runtime,image,None),result);self.assertEqual(runtime.calls,1)

    def test_unknown_capture_retains_controller_storage_and_blocks_source_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);store=Store(root/'controller.db');host=str(uuid.uuid4());token=secrets.token_urlsafe(32);offer=host_offer()
            store.enroll({'id':host,'credential':token,'offer':offer});machine=store.create(request(hostId=host));store.desired(machine['id'],'stopped')
            store.heartbeat(host,token,{'offer':offer,'reports':{machine['id']:{'state':'stopped'}}})
            task_id=str(uuid.uuid4());store.create_image_capture({'id':task_id,'machineId':machine['id'],'name':'Configured fixture'})
            assigned=store.heartbeat(host,token,{'offer':offer})['imageTasks'][0];reserved=store.hosts()[0]['reserved']['diskGiB']
            disk=root/'source.raw';disk.write_bytes(b'x'*512);library=ImageLibrary(root/'runner')
            class Runtime:
                @contextlib.contextmanager
                def capture_source(self,*args):
                    yield disk,'raw'
                    raise OSError('Fence exit unconfirmed')
            result=library.capture(assigned,Runtime(),assigned['machine']['template'],None)
            self.assertEqual(result['state'],'unknown')
            store.heartbeat(host,token,{'offer':offer,'imageReports':{task_id:result}})
            self.assertEqual(store.hosts()[0]['reserved']['diskGiB'],reserved)
            with self.assertRaises(Error):store.desired(machine['id'],'running')
            self.assertEqual(disk.read_bytes(),b'x'*512)
