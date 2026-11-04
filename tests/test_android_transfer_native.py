"""Native protocol conformance on disposable host files; no Android execution."""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


@unittest.skipUnless(os.name!='nt' and shutil.which('cc'),'POSIX C compiler required for native fixture tests.')
class AndroidTransferNativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.build.cleanup)
        cls.binary=Path(cls.build.name)/'transfer';cls.fault_binary=Path(cls.build.name)/'transfer-faults'
        source=Path(__file__).resolve().parents[1]/'canaveral/native/android_transfer.c'
        flags=['cc','-std=c11','-Wall','-Wextra','-Werror','-DCANAVERAL_TRANSFER_TIMEOUT_MS=250',str(source)]
        subprocess.run([*flags,'-o',str(cls.binary)],check=True,capture_output=True)
        subprocess.run([*flags,'-DCANAVERAL_TRANSFER_TESTING','-o',str(cls.fault_binary)],check=True,capture_output=True)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.target=self.root/"file' ;$(touch sentinel)"
        self.target.write_bytes(b'retained');self.request=str(uuid.uuid4())
        self.temporary=self.root/('.canaveral-upload-'+self.request)

    def start(self,size,failure=None):
        process=subprocess.Popen([str(self.fault_binary if failure else self.binary),'upload',str(self.target),str(size),self.request],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env={**os.environ,**({'CANAVERAL_TRANSFER_TEST_FAIL':failure} if failure else {})})
        def cleanup():
            if process.poll() is None:process.kill();process.wait(timeout=3)
            for stream in (process.stdin,process.stdout,process.stderr):stream.close()
        self.addCleanup(cleanup)
        return process

    def staged(self,process,data):
        process.stdin.write(data);process.stdin.flush()
        self.assertEqual(process.stdout.readline(),('CANAVERAL_TRANSFER_V1 STAGED '+self.request+' '+str(len(data))+'\n').encode())
        self.assertEqual(self.target.read_bytes(),b'retained')

    def commit(self,process,request=None,extra=b''):
        process.stdin.write(('COMMIT '+(request or self.request)+'\n').encode()+extra);process.stdin.close()
        output=process.stdout.read();code=process.wait(timeout=3)
        return code,output

    def test_binary_multichunk_and_empty_publish_only_after_matching_commit(self):
        for data in (b'\x00\r\n\xff'*300000,b''):
            with self.subTest(size=len(data)):
                self.target.write_bytes(b'retained');process=self.start(len(data));self.staged(process,data)
                code,output=self.commit(process)
                self.assertEqual(code,0,process.stderr.read())
                self.assertEqual(output,('CANAVERAL_TRANSFER_V1 COMMITTED '+self.request+' '+str(len(data))+'\n').encode())
                self.assertEqual(self.target.read_bytes(),data);self.assertFalse(self.temporary.exists())
                self.assertEqual(stat.S_IMODE(self.target.stat().st_mode),0o600)
                self.assertFalse((self.root/'sentinel').exists())

    def test_short_body_and_eof_before_commit_preserve_destination(self):
        for size,data in ((8,b'part'),(4,b'data')):
            with self.subTest(size=size):
                process=self.start(size);process.stdin.write(data);process.stdin.close()
                process.stdout.read();self.assertNotEqual(process.wait(timeout=3),0)
                self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_wrong_commit_uuid_and_trailing_input_are_not_publication(self):
        for request,extra in ((str(uuid.uuid4()),b''),(self.request,b'extra')):
            with self.subTest(extra=extra):
                process=self.start(4);self.staged(process,b'data');code,output=self.commit(process,request,extra)
                self.assertNotEqual(code,0);self.assertEqual(output,b'')
                self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_commit_wait_times_out_without_publishing(self):
        process=self.start(4);self.staged(process,b'data')
        self.assertEqual(process.stdout.read(),b'');self.assertNotEqual(process.wait(timeout=3),0)
        self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_exclusive_creation_does_not_remove_foreign_temporary(self):
        self.temporary.write_bytes(b'foreign');process=self.start(0);process.stdin.close()
        self.assertEqual(process.stdout.read(),b'');self.assertNotEqual(process.wait(timeout=3),0)
        self.assertEqual(self.temporary.read_bytes(),b'foreign');self.assertEqual(self.target.read_bytes(),b'retained')

    def test_mutation_after_staging_is_rejected_before_rename(self):
        process=self.start(4);self.staged(process,b'data');self.temporary.write_bytes(b'changed')
        code,output=self.commit(process)
        self.assertNotEqual(code,0);self.assertEqual(output,b'')
        self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_replaced_temporary_is_not_published_or_deleted(self):
        process=self.start(4);self.staged(process,b'data')
        replacement=self.root/'replacement';replacement.write_bytes(b'foreign');replacement.replace(self.temporary)
        code,output=self.commit(process)
        self.assertNotEqual(code,0);self.assertEqual(output,b'')
        self.assertEqual(self.temporary.read_bytes(),b'foreign');self.assertEqual(self.target.read_bytes(),b'retained')

    def test_data_sync_or_staged_ack_failure_never_claims_staged(self):
        for failure in ('file-sync','stage-ack'):
            with self.subTest(failure=failure):
                process=self.start(0,failure);process.stdin.close()
                self.assertEqual(process.stdout.read(),b'');self.assertNotEqual(process.wait(timeout=3),0)
                self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_rename_failure_preserves_old_file_without_committed_ack(self):
        process=self.start(4,'publish');self.staged(process,b'data');code,output=self.commit(process)
        self.assertNotEqual(code,0);self.assertEqual(output,b'')
        self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())

    def test_postpublication_sync_or_ack_failure_is_not_reported_as_rollback(self):
        for failure in ('file-close','directory-sync','commit-ack'):
            with self.subTest(failure=failure):
                self.target.write_bytes(b'retained');process=self.start(4,failure);self.staged(process,b'data')
                code,output=self.commit(process)
                self.assertNotEqual(code,0);self.assertEqual(output,b'')
                self.assertEqual(self.target.read_bytes(),b'data');self.assertFalse(self.temporary.exists())

    def test_directory_descriptor_survives_parent_path_replacement(self):
        parent=self.root/'original';parent.mkdir();self.target=parent/'file';self.target.write_bytes(b'retained')
        self.temporary=parent/('.canaveral-upload-'+self.request)
        process=self.start(4);self.staged(process,b'data')
        moved=self.root/'moved';parent.rename(moved);parent.mkdir();(parent/'file').write_bytes(b'other')
        code,_=self.commit(process);self.assertEqual(code,0)
        self.assertEqual((moved/'file').read_bytes(),b'data');self.assertEqual((parent/'file').read_bytes(),b'other')

    def test_invalid_count_or_uuid_has_no_filesystem_effect(self):
        for count,request in (('-1',self.request),('9007199254740992',self.request),('0','not-a-uuid')):
            result=subprocess.run([str(self.binary),'upload',str(self.target),count,request],input=b'',capture_output=True,timeout=3)
            self.assertEqual(result.returncode,2);self.assertEqual(result.stdout,b'')
        self.assertEqual(self.target.read_bytes(),b'retained');self.assertFalse(self.temporary.exists())
