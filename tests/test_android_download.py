"""Adapter scripts run against disposable files and command shims, never adb."""
import io
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.model import Error
from canaveral.providers.android import Android
from canaveral.runner_sessions import RunnerSession


class AndroidDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.path=self.root/"file' ;$(touch sentinel)"
        self.path.write_bytes(b'original\x00\r\nbytes')
        self.mode='normal';self.processes=[]
        self.env={**os.environ,'PATH':str(self.root)+os.pathsep+os.environ['PATH'],
                  'FIXTURE_FILE':str(self.path)}
        self.command('stat',"""import os,sys,datetime
p=sys.argv[-1]
s=os.fstat(3) if p=='/proc/self/fd/3' else os.stat(p)
def stamp(ns):
    return datetime.datetime.utcfromtimestamp(ns//1000000000).strftime('%Y-%m-%d %H:%M:%S')+'.'+format(ns%1000000000,'09d')+' +0000'
print('|'.join(map(str,(s.st_dev,s.st_ino,format(s.st_mode,'x'),s.st_size,stamp(s.st_mtime_ns),stamp(s.st_ctime_ns)))))
""")
        self.command('cat',"""import os,sys
from pathlib import Path
while True:
    data=os.read(0,65536)
    if not data:break
    sys.stdout.buffer.write(data)
sys.stdout.buffer.flush()
p=Path(os.environ['FIXTURE_FILE']);mode=os.environ['FIXTURE_MODE']
if mode=='replace':
    other=p.with_name('replacement');other.write_bytes(p.read_bytes());other.replace(p)
if mode=='modify':p.write_bytes(b'changed!')
if mode=='extra':sys.stdout.buffer.write(b'extra')
if mode=='fail':sys.exit(7)
""")
        self.provider=object.__new__(Android)
        self.provider.storage=lambda machine:self.root
        self.provider.endpoint=lambda *args:'fixture-serial'
        self.provider.owned=Mock()
        self.provider.tool=lambda name:'fixture-adb'
        self.provider.environment=lambda:self.env
        self.provider.adb=lambda serial,kind,command:subprocess.check_output(
            ['/bin/sh','-c',command],env=self.env,cwd=self.root).decode().strip()
        def launch(argv,**kwargs):
            self.assertEqual(argv[:6],['fixture-adb','-s','fixture-serial','exec-out','sh','-c'])
            # Legacy exec-out reports host success even after remote failure.
            process=subprocess.Popen(['/bin/sh','-c','( '+argv[6]+'\n); exit 0'],cwd=self.root,
                **{**kwargs,'env':{**self.env,'FIXTURE_MODE':self.mode}})
            self.processes.append(process);return process
        self.launch=patch('canaveral.providers.android.assignment_popen',side_effect=launch)
        self.launch.start();self.addCleanup(self.launch.stop)

    def command(self,name,body):
        path=self.root/name;path.write_text('#!'+sys.executable+'\n'+body);path.chmod(0o700)

    def source(self):
        source=self.provider.stream_download({}, {},self.root,str(self.path),None)
        self.addCleanup(source.close);return source

    def test_binary_multichunk_stream_verified_without_spooling_or_shell_injection(self):
        expected=b'\x00\r\n\xff'*(300000);self.path.write_bytes(expected)
        source=self.source();source.verify();parts=[]
        while sum(map(len,parts))<source.size:parts.append(source.read(65536))
        self.assertEqual(b''.join(parts),expected);source.verify();source.verify()
        self.assertFalse((self.root/'sentinel').exists())
        self.assertEqual(self.processes[0].poll(),0)

    def test_empty_file_requires_guest_completion_marker(self):
        self.path.write_bytes(b'');source=self.source();source.verify()
        self.assertEqual(source.size,0);self.assertEqual(source.read(1),b'')

    def test_descriptor_changes_path_replacement_failed_cat_and_extra_bytes_are_refused(self):
        for mode in ('replace','modify','fail','extra'):
            with self.subTest(mode=mode):
                self.path.write_bytes(b'original');self.mode=mode;source=self.source()
                source.read(source.size)
                with self.assertRaises(Error):source.verify()

    def test_missing_marker_is_not_accepted_even_with_successful_host_process(self):
        self.command('cat',"import sys\nsys.stdout.buffer.write(b'original')\nsys.exit(7)\n")
        self.path.write_bytes(b'original');source=self.source();source.read(source.size)
        with self.assertRaises(Error):source.verify()
        self.assertEqual(self.processes[-1].poll(),0)

    def test_completion_timeout_is_uncertain_and_never_verified(self):
        source=self.source();source.read(source.size)
        with patch.object(self.processes[-1],'wait',side_effect=subprocess.TimeoutExpired('fixture',30)):
            with self.assertRaisesRegex(Error,'uncertain'):source.verify()

    def test_path_changed_before_initial_verification_is_refused(self):
        source=self.source();self.path.write_bytes(b'changed')
        with self.assertRaises(Error):source.verify()

    def test_invalid_metadata_and_nonregular_file_never_launch_stream(self):
        for metadata in ('regular file 8','1|2|41ed|0|mtime|ctime','1|2|81a4|-1|mtime|ctime'):
            with self.subTest(metadata=metadata):
                self.provider.adb=lambda *args:metadata
                with self.assertRaises(Error):self.source()
        self.assertEqual(self.processes,[])

    def test_close_terminates_only_its_own_blocked_pipe(self):
        self.path.write_bytes(b'x'*(2*1024*1024));source=self.source()
        source.close();self.assertIsNotNone(self.processes[0].poll())
        # Cleanup also calls close; source resources must tolerate repetition.

    def test_launch_failure_closes_temporary_log(self):
        log=io.BytesIO()
        with patch('tempfile.TemporaryFile',return_value=log),patch('canaveral.providers.android.assignment_popen',side_effect=OSError('fixture')):
            with self.assertRaises(OSError):self.source()
        self.assertTrue(log.closed)

    def test_runner_session_digest_excludes_marker_and_failed_guest_has_no_finish(self):
        for mode in ('normal','fail'):
            with self.subTest(mode=mode):
                self.mode=mode;expected=self.path.read_bytes();connection=Mock()
                connection.receive.return_value={'type':'begin','path':str(self.path)}
                session=object.__new__(RunnerSession)
                session.connection=connection;session.runtime=SimpleNamespace(access=self.provider)
                session.machine={};session.image={};session.folder=self.root;session.authorized=lambda:True
                if mode=='fail':
                    with self.assertRaises(Error):session.download()
                else:session.download()
                self.assertEqual(b''.join(call.args[0] for call in connection.send_bytes.call_args_list),expected)
                controls=[call.args[0] for call in connection.send_control.call_args_list]
                if mode=='normal':self.assertEqual(controls[-1],{'type':'finish','bytes':len(expected),'sha256':hashlib.sha256(expected).hexdigest()})
                else:self.assertEqual([control['type'] for control in controls],['begin'])
                self.assertIsNotNone(self.processes[-1].poll())
