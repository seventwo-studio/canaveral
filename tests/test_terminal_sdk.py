import collections
import contextlib
import threading
import time
import unittest
import uuid
from unittest.mock import Mock

from canaveral.model import Error
from canaveral.sdk import LeaseClient
from canaveral.terminal_sdk import TerminalClient
from test_runner_sessions import RunnerFixture


class Wire:
    def __init__(self,values=()):self.values=collections.deque(values);self.controls=[];self.closes=0
    def receive(self,timeout):return self.values.popleft() if self.values else None
    def send_control(self,value):self.controls.append(value)
    def close(self):self.closes+=1


class TerminalSDKTests(unittest.TestCase):
    def terminal(self,values=()):
        wire=Wire(values);return TerminalClient(wire,str(uuid.uuid4())),wire

    def test_binary_output_preserves_fragments_truncation_and_unknown_exit_status(self):
        terminal,wire=self.terminal([b'\xe2',b'\x82\xac',{'type':'truncated'},b'\x1b[0m',{'type':'exited','exitCode':None}])
        self.assertEqual(terminal.receive(),b'\xe2');self.assertEqual(terminal.receive(),b'\x82\xac')
        self.assertEqual(terminal.receive(),{'type':'truncated'});self.assertTrue(terminal.truncated)
        self.assertEqual(terminal.receive(),b'\x1b[0m');self.assertEqual(terminal.receive(),{'type':'exited','exitCode':None})
        self.assertTrue(terminal.exited);self.assertIsNone(terminal.exit_code);self.assertTrue(terminal.closed)
        terminal.close();self.assertEqual(wire.closes,1)
        with self.assertRaises(Error):terminal.write('not sent')
        self.assertEqual(wire.controls,[])

    def test_invalid_input_dimensions_and_timeouts_leave_connection_usable(self):
        terminal,wire=self.terminal()
        for text in ('\x00','x'*16001,'\U0001f680'*2000,'\ud800',b'bytes'):
            with self.assertRaises(Error):terminal.write(text)
        for dims in ((True,20),(0,20),(80,501),(80,'24')):
            with self.assertRaises(Error):terminal.resize(*dims)
        for timeout in (-1,True,float('inf'),10**1000):
            with self.assertRaises(Error):terminal.receive(timeout)
        self.assertFalse(terminal.closed);self.assertEqual(wire.controls,[])
        terminal.resize(120,40);terminal.write('hello\n')
        self.assertEqual(wire.controls,[{'action':'shell-resize','arguments':{'cols':120,'rows':40}},
                                        {'action':'shell-write','arguments':{'text':'hello\n'}}])
        self.assertIsNone(terminal.receive(0));self.assertFalse(terminal.closed)

    def test_blocked_reader_does_not_hold_input_or_resize(self):
        terminal,wire=self.terminal();entered=threading.Event();release=threading.Event();errors=[]
        def receive(timeout):entered.set();release.wait(2);return None
        wire.receive=receive
        def read():
            try:terminal.receive(2)
            except Exception as error:errors.append(error)
        reader=threading.Thread(target=read);reader.start()
        try:
            self.assertTrue(entered.wait(1));terminal.write('immediate');terminal.resize(100,30)
            self.assertEqual(len(wire.controls),2);self.assertTrue(reader.is_alive())
        finally:release.set();reader.join(3);terminal.close()
        self.assertFalse(reader.is_alive());self.assertEqual(errors,[])

    def test_interrupted_input_preserves_unknown_session_identity_without_replay(self):
        for failure in (OSError('private-socket-detail'),EOFError(),Error('Fixture disconnect',410,code='session_disconnected')):
            terminal,wire=self.terminal();wire.send_control=Mock(side_effect=failure)
            with self.assertRaises(Error) as error:terminal.write('once\n')
            self.assertEqual((error.exception.request_id,error.exception.outcome,error.exception.retryable),
                             (terminal.session_id,'unknown',False))
            self.assertNotIn('private-',str(error.exception));self.assertTrue(terminal.closed)
            with self.assertRaises(Error):terminal.write('once\n')
            wire.send_control.assert_called_once()

    def test_invalid_controls_and_worker_errors_close_with_stable_correlation(self):
        for value,code in (({'type':'exited','exitCode':True},'session_protocol_error'),
                           ({'type':'truncated','extra':True},'session_protocol_error'),
                           (b'x'*65537,'session_protocol_error'),
                           ({'type':'error','code':'capability_unsupported','message':'private-provider','outcome':'unknown'},'capability_unsupported')):
            terminal,wire=self.terminal([value])
            with self.assertRaises(Error) as error:terminal.receive()
            self.assertEqual((error.exception.code,error.exception.request_id,error.exception.outcome),
                             (code,terminal.session_id,'unknown'))
            self.assertNotIn('private-provider',str(error.exception));self.assertTrue(terminal.closed)

    def test_factory_checks_timeout_before_admission_and_never_reconnects(self):
        sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),'x'*43);request=str(uuid.uuid4())
        sdk.create_session=Mock(return_value={'id':request});wire=Wire();sdk.connect_session=Mock(return_value=wire)
        with self.assertRaises(Error):sdk.terminal(request,timeout=0)
        sdk.create_session.assert_not_called()
        with sdk.terminal(request) as terminal:
            terminal.write('once');self.assertEqual(terminal.session_id,request)
        sdk.create_session.assert_called_once_with(request,'primary','pty');sdk.connect_session.assert_called_once()

    def test_cancelled_dispatch_closes_without_replaying_or_masking_cancellation(self):
        for operation in ('write','read'):
            terminal,wire=self.terminal();wire.send_control=Mock(side_effect=KeyboardInterrupt)
            wire.receive=Mock(side_effect=KeyboardInterrupt);wire.close=Mock(side_effect=OSError('Close unconfirmed'))
            with self.assertRaises(KeyboardInterrupt):
                if operation=='write':terminal.write('once\n')
                else:terminal.receive()
            self.assertTrue(terminal.closed)
            with self.assertRaises(Error):terminal.write('once\n')
            self.assertEqual(wire.send_control.call_count,1 if operation=='write' else 0)


class TerminalSDKBrokerTests(RunnerFixture):
    def test_nine_independent_sessions_resize_input_and_owned_cleanup(self):
        ids=[str(uuid.uuid4()) for _ in range(9)]
        with contextlib.ExitStack() as stack:
            terminals=[stack.enter_context(self.sdk.terminal(request,timeout=5)) for request in ids]
            for index,terminal in enumerate(terminals):
                terminal.resize(100+index,30+index)
                terminal.write('printf "terminal_'+str(index)+'\\n"\nstty size\n')
            for index,terminal in enumerate(terminals):
                data=self.output_until(terminal,('30 100' if index==0 else str(30+index)+' '+str(100+index)).encode())
                self.assertIn(('terminal_'+str(index)).encode(),data)
                for other in range(9):
                    if other!=index:self.assertNotIn(('terminal_'+str(other)).encode(),data)
            self.assertEqual(self.backend.opens,9)
        for request in ids:self.assertEqual(self.wait_receipt(request)['cleanup'],'complete')
        self.assertEqual(self.backend.shells.sessions,{})

    def test_expiry_closes_terminal_without_reopening_or_replaying_input(self):
        request=str(uuid.uuid4());terminal=self.sdk.terminal(request,timeout=5);self.addCleanup(terminal.close)
        terminal.write('printf "before-expiry\\n"\n');self.output_until(terminal,b'before-expiry')
        self.now+=121
        with self.assertRaises(Error) as failure:
            while True:terminal.receive(3)
        self.assertEqual((failure.exception.request_id,failure.exception.outcome,failure.exception.retryable),
                         (request,'unknown',False))
        self.assertTrue(terminal.closed)
        with self.assertRaises(Error):terminal.write('not replayed\n')
        with self.assertRaises(Error):self.sdk.terminal(request,timeout=3)
        self.assertEqual(self.backend.opens,1)
