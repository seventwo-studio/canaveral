import collections
import io
import queue
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.model import Error
from canaveral.sdk import LeaseClient
from canaveral.session_errors import WORKER_MESSAGES,checked,worker_error
from canaveral.session_transport import SessionConnection


def message(code='session_incomplete'):
    return {'type':'error','code':code,'message':'provider-private-content','outcome':'unknown'}


class SessionErrorTests(unittest.TestCase):
    def test_codes_unknown_outcome_and_correlation_are_preserved_without_provider_text(self):
        request=str(uuid.uuid4())
        for code in WORKER_MESSAGES:
            error=worker_error(message(code),request)
            self.assertEqual((error.code,error.outcome,error.request_id,error.retryable),(code,'unknown',request,False))
            self.assertNotIn('provider-private-content',str(error))
        self.assertIsNone(worker_error({'type':'finish'}))

    def test_invalid_or_extra_error_fields_never_become_success_or_leak_content(self):
        for value in ({**message(),'outcome':'succeeded'},{**message(),'credential':'private-credential'},
                      {**message(),'code':['bad']},{**message(),'code':'unexpected-private-code'},
                      {'type':'error','code':'session_incomplete'}):
            with self.subTest(value=value):
                with self.assertRaises(Error) as failure:checked(value)
                self.assertEqual(failure.exception.code,'session_protocol_error')
                self.assertEqual(failure.exception.outcome,'unknown')
                self.assertNotIn('private',str(failure.exception))

    def test_received_refusal_blocks_writes_but_raw_receive_keeps_json_contract(self):
        request=str(uuid.uuid4());value=message('capability_unsupported')
        connection=object.__new__(SessionConnection)
        connection.worker_error=worker_error(value,request);connection.closed=threading.Event()
        connection.authorized=lambda:True;connection.messages=queue.Queue(maxsize=1)
        connection.messages.put(value);connection.inbox_space=threading.Event();connection.failure=None
        with self.assertRaises(Error) as failure:connection._check_write()
        self.assertEqual(failure.exception.code,'capability_unsupported')
        self.assertEqual(connection.receive(),value)
        class Arriving(queue.Queue):
            def get(self,*args,**kwargs):
                if kwargs.get('block') is False:return super().get(*args,**kwargs)
                self.put(value);return super().get(*args,**kwargs)
        # The reader may cache a reason just before queueing its raw control.
        connection.messages=Arriving(maxsize=1)
        self.assertEqual(connection.receive(),value)
        connection.closed.set()
        with self.assertRaises(Error) as failure:connection._check_write()
        self.assertEqual(failure.exception.request_id,request)

    def sdk(self,values):
        sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),'x'*43)
        sdk.create_session=Mock(return_value={});connection=Mock()
        connection.__enter__=Mock(return_value=connection);connection.__exit__=Mock(return_value=False)
        connection.receive.side_effect=values;sdk.connect_session=Mock(return_value=connection)
        return sdk

    def test_upload_download_and_accessibility_keep_received_worker_reasons(self):
        for operation in ('upload','download','accessibility'):
            with self.subTest(operation=operation):
                request=str(uuid.uuid4());sdk=self.sdk([message('capability_unsupported')])
                with self.assertRaises(Error) as failure:
                    if operation=='upload':sdk.upload(request,'primary','file',io.BytesIO(b'data'),4)
                    elif operation=='download':sdk.download(request,'primary','file',io.BytesIO())
                    else:sdk.accessibility(request)
                self.assertEqual((failure.exception.code,failure.exception.outcome,failure.exception.request_id),
                                 ('capability_unsupported','unknown',request))
                sdk.create_session.assert_called_once()

    def test_mid_download_error_keeps_reason_and_staged_destination(self):
        sdk=self.sdk([{'type':'begin','size':8},b'part',message()]);request=str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'retained';target.write_bytes(b'original')
            with self.assertRaises(Error) as failure:sdk.download_to_file(request,'primary','file',target,replace=True)
            self.assertEqual(failure.exception.code,'session_incomplete');self.assertEqual(failure.exception.outcome,'unknown')
            self.assertEqual(failure.exception.request_id,request);self.assertEqual(target.read_bytes(),b'original')
            self.assertFalse(list(Path(directory).glob('.canaveral-download-*')))

    def test_display_action_keeps_action_uuid_when_transport_reports_session_uuid(self):
        try:from PIL import Image
        except ImportError:self.skipTest('Install the visual extra for display error correlation.')
        from canaveral.visual_sdk import DisplayClient
        from test_visual_sdk import WireFixture
        wire=WireFixture();wire.session_id=str(uuid.uuid4());display=DisplayClient(wire);display.state='owned'
        request=str(uuid.uuid4())
        wire.send_control=Mock(side_effect=worker_error(message(),wire.session_id))
        with self.assertRaises(Error) as failure:display.action(request,'tap',{'x':1,'y':1})
        self.assertEqual(failure.exception.request_id,request);self.assertEqual(failure.exception.outcome,'unknown')
        self.assertTrue(display.closed);wire.send_control.assert_called_once()
