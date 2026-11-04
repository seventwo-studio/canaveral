import base64
import time
import sys
import threading
import unittest
import uuid
from unittest.mock import patch

from canaveral.model import Error
from canaveral.shell_sessions import ShellSessions
from canaveral.devices import operation_request


class ShellSessionTests(unittest.TestCase):
    def setUp(self):
        self.shells = ShellSessions()
        self.addCleanup(lambda: self.shells.sweep(active=set()))

    def test_two_persistent_shells_keep_separate_state_and_owner(self):
        first, second = str(uuid.uuid4()), str(uuid.uuid4())
        for session in (first, second):
            self.shells.open('machine', session, ['/bin/sh'])
        self.shells.control('machine', 'shell-write', {'session': first, 'text': 'export CANAVERAL_TEST=first\ncd /tmp\n'})
        self.shells.control('machine', 'shell-write', {'session': second, 'text': 'export CANAVERAL_TEST=second\n'})
        self.shells.control('machine', 'shell-write', {'session': first, 'text': 'printf "RESULT:%s\\n" "$CANAVERAL_TEST"\n'})
        self.shells.control('machine', 'shell-write', {'session': second, 'text': 'printf "RESULT:%s\\n" "$CANAVERAL_TEST"\n'})
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            a = self.shells.control('machine', 'shell-read', {'session': first, 'offset': 0})
            b = self.shells.control('machine', 'shell-read', {'session': second, 'offset': 0})
            if b'RESULT:first' in base64.b64decode(a['data']) and b'RESULT:second' in base64.b64decode(b['data']):
                break
            time.sleep(.02)
        self.assertIn(b'RESULT:first', base64.b64decode(a['data']))
        self.assertIn(b'RESULT:second', base64.b64decode(b['data']))
        with self.assertRaises(Error):
            self.shells.control('other-machine', 'shell-read', {'session': first, 'offset': 0})
        self.assertEqual(self.shells.control('machine', 'shell-read', {'session': first, 'offset': a['offset']})['data'], '')
        self.shells.sweep(active=set())
        with self.assertRaises(Error):
            self.shells.control('machine', 'shell-read', {'session': first, 'offset': 0})

    def test_restart_does_not_resume_and_limits_validate(self):
        session = str(uuid.uuid4())
        with self.assertRaises(Error):
            ShellSessions().control('machine', 'shell-write', {'session': session, 'text': 'danger'})
        for arguments in ({'session': '../escape'}, {'session': session, 'offset': -1}):
            with self.assertRaises(Error):
                operation_request({'id': str(uuid.uuid4()), 'action': 'shell-read', 'arguments': arguments})
        with self.assertRaises(Error):
            operation_request({'id': str(uuid.uuid4()), 'action': 'shell-resize', 'arguments': {'session': session, 'rows': 0, 'cols': 80}})

    def test_session_count_is_chosen_by_caller(self):
        for _ in range(70):
            self.shells.open('machine',str(uuid.uuid4()),['/bin/cat'])
        self.assertEqual(len(self.shells.sessions),70)

    def test_revocation_rejects_new_shells_and_leaves_other_assignments_usable(self):
        session=str(uuid.uuid4());other=str(uuid.uuid4())
        self.shells.open('leased',session,['/bin/cat'])
        process=self.shells.sessions[('leased',session)]['process']
        self.shells.open('administrative',other,['/bin/cat'])
        self.shells.revoke({'leased'})
        self.assertIsNotNone(process.poll())
        with self.assertRaises(Error):self.shells.open('leased',str(uuid.uuid4()),['/bin/cat'])
        with self.assertRaises(Error):self.shells.control('leased','shell-write',{'session':session,'text':'late input'})
        self.shells.control('administrative','shell-write',{'session':other,'text':'retained\n'})
        until=time.monotonic()+2;result={}
        while time.monotonic()<until:
            result=self.shells.control('administrative','shell-read',{'session':other,'offset':0})
            if b'retained' in base64.b64decode(result['data']):break
            time.sleep(.02)
        self.assertIn(b'retained',base64.b64decode(result['data']))

    def test_stubborn_shell_batch_closes_without_holding_other_terminal_io(self):
        program='import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGHUP,signal.SIG_IGN);print("READY",flush=True);time.sleep(60)'
        sessions=[str(uuid.uuid4()) for _ in range(4)]
        for session in sessions:self.shells.open('leased',session,[sys.executable,'-u','-c',program])
        processes=[self.shells.sessions[('leased',session)]['process'] for session in sessions]
        until=time.monotonic()+5
        for session in sessions:
            while time.monotonic()<until:
                result=self.shells.control('leased','shell-read',{'session':session,'offset':0})
                if b'READY' in base64.b64decode(result['data']):break
                time.sleep(.01)
            self.assertIn(b'READY',base64.b64decode(result['data']))
        ordinary=str(uuid.uuid4());self.shells.open('ordinary',ordinary,['/bin/cat'])
        started=time.monotonic();worker=threading.Thread(target=lambda:self.shells.revoke({'leased'}),daemon=True)
        worker.start()
        until=time.monotonic()+1
        while time.monotonic()<until:
            with self.shells.lock:detached=not any(key[0]=='leased' for key in self.shells.sessions)
            if detached:break
            time.sleep(.01)
        self.assertTrue(detached)
        self.assertTrue(worker.is_alive())
        io_started=time.monotonic()
        self.shells.control('ordinary','shell-write',{'session':ordinary,'text':'still responsive\n'})
        self.assertLess(time.monotonic()-io_started,.75)
        worker.join(4)
        self.assertFalse(worker.is_alive());self.assertLess(time.monotonic()-started,4.5)
        self.assertTrue(all(process.poll() is not None for process in processes))

    def test_failed_termination_keeps_process_tracked_until_a_later_cleanup(self):
        session=str(uuid.uuid4())
        program='import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGHUP,signal.SIG_IGN);print("READY",flush=True);time.sleep(60)'
        self.shells.open('leased',session,[sys.executable,'-u','-c',program])
        process=self.shells.sessions[('leased',session)]['process']
        until=time.monotonic()+3;result={}
        while time.monotonic()<until:
            result=self.shells.control('leased','shell-read',{'session':session,'offset':0})
            if b'READY' in base64.b64decode(result['data']):break
            time.sleep(.01)
        self.assertIn(b'READY',base64.b64decode(result['data']))
        with patch('canaveral.shell_sessions.os.killpg',side_effect=PermissionError('fixture signal unavailable')):
            with self.assertRaises(Error):self.shells.control('leased','shell-close',{'session':session})
        self.assertIsNone(process.poll());self.assertIn(('leased',session),self.shells.closing)
        with self.assertRaises(Error):self.shells.open('leased',session,['/bin/cat'])
        self.assertTrue(self.shells.revoke({'leased'}))
        self.assertIsNotNone(process.poll());self.assertNotIn(('leased',session),self.shells.closing)
