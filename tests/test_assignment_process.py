import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.assignment_gate import assignment_access,current_assignment
from canaveral.assignment_process import assignment_popen,assignment_run,helper_directory,helpers_closed
from canaveral.files import save_json


@unittest.skipIf(os.name=='nt','POSIX assignment locking')
class AssignmentProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)/'machines'/str(uuid.uuid4())
        self.machine={'id':self.folder.name,'lease':{'id':str(uuid.uuid4())}}
        self.root=helper_directory(self.folder,self.machine['id'])

    def test_synchronous_helper_input_output_exit_and_timeout_leave_no_pending_records(self):
        with assignment_access(self.machine,self.folder):
            result=assignment_run([sys.executable,'-c','import sys;sys.stdout.write(sys.stdin.read().upper())'],input=b'fixture',stdout=subprocess.PIPE,check=True)
            self.assertEqual(result.stdout,b'FIXTURE')
            with self.assertRaises(subprocess.CalledProcessError):assignment_run([sys.executable,'-c','raise SystemExit(7)'],check=True)
            with self.assertRaises(subprocess.TimeoutExpired):assignment_run([sys.executable,'-c','import time;time.sleep(30)'],timeout=.05)
            self.assertEqual(list(self.root.iterdir()),[])

    def test_live_helper_is_tracked_without_arguments_and_completion_removes_receipt(self):
        with assignment_access(self.machine,self.folder):
            process=assignment_popen([sys.executable,'-c','import sys;sys.stdin.read()','private-fixture-value'],stdin=subprocess.PIPE)
        try:
            records=list(self.root.iterdir());self.assertEqual(len(records),1)
            self.assertNotIn('private-fixture-value',records[0].read_text())
            self.assertFalse(helpers_closed(self.machine,self.folder))
            process.communicate(timeout=5)
            self.assertTrue(helpers_closed(self.machine,self.folder))
            self.assertEqual(list(self.root.iterdir()),[])
        finally:
            if process.poll() is None:process.kill()
            process.wait(timeout=5)

    def test_unknown_launch_and_foreign_lease_are_not_exit_evidence(self):
        record={'machineId':self.machine['id'],'leaseId':self.machine['lease']['id'],'state':'launching'}
        path=self.root/'fixture.json';save_json(path,record)
        self.assertFalse(helpers_closed(self.machine,self.folder))
        save_json(path,{**record,'state':'running','leaseId':str(uuid.uuid4()),'pid':os.getpid(),'startedAt':0})
        self.assertFalse(helpers_closed(self.machine,self.folder));self.assertTrue(path.exists())

    def test_reused_pid_is_never_signalled_and_unleased_work_is_untracked(self):
        import psutil
        path=self.root/'fixture.json'
        save_json(path,{'version':2,'machineId':self.machine['id'],'leaseId':self.machine['lease']['id'],'state':'running',
            'pid':os.getpid(),'startedAt':psutil.Process().create_time()-100,'processGroupId':os.getpid()})
        with patch('canaveral.assignment_process.group_present',return_value=False):
            self.assertTrue(helpers_closed(self.machine,self.folder));self.assertFalse(path.exists())
        with assignment_access({'id':self.machine['id']},self.folder):
            self.assertIsNone(current_assignment())
            self.assertEqual(assignment_run([sys.executable,'-c','pass']).returncode,0)

    def test_nested_gates_restore_context_and_failed_spawn_does_not_leave_a_child_intent(self):
        with assignment_access(self.machine,self.folder):
            first=current_assignment()
            with assignment_access(self.machine,self.folder):self.assertIsNot(current_assignment(),first)
            self.assertIs(current_assignment(),first)
            with self.assertRaises(OSError):assignment_popen(['/nonexistent-canaveral-fixture'])
            self.assertEqual(list(self.root.iterdir()),[])
        self.assertIsNone(current_assignment())
