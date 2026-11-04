import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

import psutil

from canaveral.assignment_gate import assignment_access
from canaveral.assignment_process import assignment_popen, assignment_run, helper_directory, helpers_closed
from canaveral.files import save_json
from canaveral.model import Error
from canaveral.process_groups import LeasedPopen, unreaped_child


@unittest.skipIf(os.name=='nt','POSIX child/group fixtures; Windows enforcement is separate.')
class HelperCancellationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)/'machines'/str(uuid.uuid4())
        self.machine={'id':self.folder.name,'lease':{'id':str(uuid.uuid4())}}
        self.records=helper_directory(self.folder,self.machine['id'])

    def fixture(self,leader_exits=False,escaped=False):
        code='''import os,subprocess,sys,time
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=ESCAPED)
print(child.pid,flush=True)
if not LEADER_EXITS:child.wait()
'''.replace('ESCAPED',repr(escaped)).replace('LEADER_EXITS',repr(leader_exits))
        process=assignment_popen([sys.executable,'-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        child=psutil.Process(int(process.stdout.readline().strip()))
        leader=psutil.Process(process.pid)
        return process,leader,child

    def stop_fixture(self,process,leader,child,worker):
        # Only handles for these exact disposable children; never a recovered PGID.
        for owned in (child,leader):
            try:
                if owned.is_running() and owned.status()!=psutil.STATUS_ZOMBIE:owned.kill()
            except psutil.NoSuchProcess:pass
        worker.join(3);process.wait(timeout=3)
        for stream in (process.stdout,process.stderr):
            if stream and not stream.closed:stream.close()

    def test_timeout_cancels_group_and_never_waits_on_inherited_pipe_forever(self):
        for leader_exits in (False,True):
            with self.subTest(leader_exits=leader_exits),assignment_access(self.machine,self.folder):
                process,leader,child=self.fixture(leader_exits=leader_exits)
                errors=[]
                if leader_exits:
                    until=time.monotonic()+3
                    while leader.status()!=psutil.STATUS_ZOMBIE and time.monotonic()<until:time.sleep(.01)
                    self.assertEqual(leader.status(),psutil.STATUS_ZOMBIE)
                def run():
                    try:
                        with assignment_access(self.machine,self.folder):
                            assignment_run(['fixture-owned-process'],timeout=.1)
                    except BaseException as error:errors.append(error)
                worker=threading.Thread(target=run)
                try:
                    with patch('canaveral.assignment_process.assignment_popen',return_value=process):
                        worker.start();worker.join(1.5);finished_before_rescue=not worker.is_alive()
                finally:self.stop_fixture(process,leader,child,worker)
                self.assertTrue(finished_before_rescue,'Timeout depended on descendant exit instead of cancelling its group.')
                self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
                self.assertIsInstance(errors[0],subprocess.TimeoutExpired)
                try:self.assertEqual(child.status(),psutil.STATUS_ZOMBIE)
                except psutil.NoSuchProcess:pass

    def test_escaped_pipe_produces_bounded_unknown_and_sticky_cleanup_refusal(self):
        with assignment_access(self.machine,self.folder):
            process,leader,child=self.fixture(escaped=True);errors=[]
            def run():
                try:
                    with assignment_access(self.machine,self.folder):
                        assignment_run(['fixture-owned-process'],timeout=.1)
                except BaseException as error:errors.append(error)
            worker=threading.Thread(target=run)
            try:
                with patch('canaveral.assignment_process.assignment_popen',return_value=process),\
                        patch('canaveral.assignment_process.CANCEL_WAIT',.15):
                    worker.start();worker.join(1.5);finished_before_rescue=not worker.is_alive()
                self.assertTrue(finished_before_rescue)
                self.assertEqual(len(errors),1);self.assertIsInstance(errors[0],subprocess.TimeoutExpired)
                records=list(self.records.glob('*.json'));self.assertEqual(len(records),1)
                self.assertEqual(json.loads(records[0].read_text())['state'],'uncertain')
                process.mark('cancelling')
                self.assertEqual(json.loads(records[0].read_text())['state'],'uncertain')
                self.assertFalse(helpers_closed(self.machine,self.folder))
            finally:self.stop_fixture(process,leader,child,worker)
        self.assertFalse(helpers_closed(self.machine,self.folder))

    def test_group_cancellation_can_interrupt_active_communication(self):
        with assignment_access(self.machine,self.folder):
            process,leader,child=self.fixture();errors=[]
            def read():
                try:process.communicate(timeout=10)
                except BaseException as error:errors.append(error)
            worker=threading.Thread(target=read)
            try:
                worker.start();process.terminate();worker.join(1.5)
                self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
            finally:self.stop_fixture(process,leader,child,worker)

    def test_recovered_legacy_uncertain_and_live_group_records_are_not_stop_evidence(self):
        record={'machineId':self.machine['id'],'leaseId':self.machine['lease']['id'],
                'state':'running','pid':123456,'startedAt':1}
        path=self.records/'fixture.json'
        for value in (record,{**record,'version':2,'processGroupId':record['pid'],'state':'uncertain'}):
            save_json(path,value);self.assertFalse(helpers_closed(self.machine,self.folder));self.assertTrue(path.exists())
        save_json(path,{**record,'version':2,'processGroupId':record['pid']})
        with patch('psutil.Process',side_effect=psutil.NoSuchProcess(record['pid'])),\
                patch('canaveral.assignment_process.group_present',return_value=True):
            self.assertFalse(helpers_closed(self.machine,self.folder));self.assertTrue(path.exists())
        with patch('psutil.Process',side_effect=psutil.NoSuchProcess(record['pid'])),\
                patch('canaveral.assignment_process.group_present',return_value=False):
            self.assertTrue(helpers_closed(self.machine,self.folder));self.assertFalse(path.exists())

    def test_group_signal_requires_unreaped_ownership_and_never_signals_a_recovered_id(self):
        fake=SimpleNamespace(pid=123456,returncode=None,isolated_group=True,
                             group_lock=threading.RLock(),_waitpid_lock=threading.Lock())
        with patch('canaveral.process_groups.unreaped_child',return_value=False),\
                patch('canaveral.process_groups.os.killpg') as send:
            with self.assertRaises(Error) as caught:LeasedPopen.signal_group(fake,signal.SIGKILL)
            self.assertEqual(caught.exception.outcome,'unknown');self.assertFalse(caught.exception.retryable)
            send.assert_not_called()
        fake.returncode=0
        with patch('canaveral.process_groups.group_present',return_value=True),\
                patch('canaveral.process_groups.os.killpg') as send:
            with self.assertRaises(Error):LeasedPopen.signal_group(fake,signal.SIGKILL)
            send.assert_not_called()

    def test_nonreaping_native_query_preserves_exit_status_and_refuses_reaped_child(self):
        child=subprocess.Popen([sys.executable,'-c','raise SystemExit(7)'],start_new_session=True)
        try:
            identity=psutil.Process(child.pid);until=time.monotonic()+3
            while identity.status()!=psutil.STATUS_ZOMBIE and time.monotonic()<until:time.sleep(.01)
            self.assertEqual(identity.status(),psutil.STATUS_ZOMBIE)
            self.assertTrue(unreaped_child(child.pid));self.assertTrue(unreaped_child(child.pid))
            self.assertEqual(child.wait(timeout=3),7)
            self.assertFalse(unreaped_child(child.pid))
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=3)

    def test_context_exit_is_bounded_and_failed_intent_write_does_not_signal(self):
        with assignment_access(self.machine,self.folder):
            started=time.monotonic()
            with patch('canaveral.assignment_process.CANCEL_WAIT',.05):
                with assignment_popen([sys.executable,'-c','import time;time.sleep(30)']) as process:pass
            self.assertLess(time.monotonic()-started,1.5)
            self.assertIsNotNone(process.returncode)
            process=assignment_popen([sys.executable,'-c','import time;time.sleep(30)'])
            try:
                with patch('canaveral.assignment_process.save_json',side_effect=OSError('fixture write failure')),\
                        patch.object(process.process,'send_signal') as send:
                    with self.assertRaises(OSError):process.kill()
                    send.assert_not_called()
            finally:
                process.process.kill();process.wait(timeout=3)

    def test_foreign_group_override_is_rejected_before_spawn_and_no_launch_intent_remains(self):
        with assignment_access(self.machine,self.folder):
            for settings in ({'preexec_fn':lambda:None},{'process_group':0}):
                with self.subTest(settings=list(settings)):
                    with self.assertRaises(Error):assignment_popen([sys.executable,'-c','pass'],**settings)
            with patch('canaveral.assignment_process.signal.getsignal',return_value=signal.SIG_IGN):
                with self.assertRaises(Error):assignment_popen([sys.executable,'-c','pass'])
        self.assertFalse(self.records.exists())

    def test_leased_shell_close_uses_owned_group_signal_and_keeps_uncertain_groups_tracked(self):
        from canaveral.shell_sessions import ShellSessions
        from unittest.mock import Mock
        manager=ShellSessions()
        process=Mock(leased_group=True);process.poll.return_value=0;process.group_closed.return_value=False
        process.kill.side_effect=Error('Fixture uncertain group',409)
        read,write=os.pipe()
        key=(self.machine['id'],str(uuid.uuid4()))
        entry={'process':process,'fd':read,'key':key}
        manager.closing[key]=entry
        try:
            with patch('canaveral.shell_sessions.os.killpg') as unowned_signal:
                self.assertFalse(manager._terminate([entry]))
                unowned_signal.assert_not_called()
            self.assertIn(key,manager.closing)
            self.assertTrue(process.kill.called)
            process.group_closed.return_value=True;process.kill.side_effect=None
            self.assertTrue(manager._terminate([entry]))
            self.assertNotIn(key,manager.closing)
        finally:
            os.close(write)
            if not entry.get('fd_closed'):os.close(read)
