import base64
import collections
import io
import json
import secrets
import struct
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.client import Client
from canaveral.display_access import DisplayControls,DisplayEndpoint
from canaveral.model import Error
from canaveral.providers.mobile import Mobile,operation_receipt
from canaveral.sdk import LeaseClient
from canaveral.session_transport import SessionConnection
from canaveral.simulator_screen import compact_length,connect
from canaveral.visual_sdk import DisplayClient
from test_access_sessions import AccessFixture

try:
    from PIL import Image
except ImportError:Image=None


class VisualSDKOptionsTests(unittest.TestCase):
    def test_missing_extra_fails_before_creating_a_remote_session(self):
        sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),secrets.token_urlsafe(32))
        sdk.create_session=Mock()
        with patch.dict(sys.modules,{'PIL':None}):
            with self.assertRaises(Error) as failure:sdk.display(str(uuid.uuid4()))
        self.assertEqual(failure.exception.code,'capability_unsupported')
        sdk.create_session.assert_not_called()

    @unittest.skipUnless(Image,'Install the visual extra for display option validation')
    def test_invalid_options_do_not_create_a_session(self):
        sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),secrets.token_urlsafe(32));sdk.create_session=Mock()
        for options in ({'timeout':0},{'timeout':float('nan')},{'max_frame_bytes':3}):
            with self.assertRaises(Error):sdk.display(str(uuid.uuid4()),**options)
        sdk.create_session.assert_not_called()


def png(size,color):
    out=io.BytesIO();Image.new('RGB',size,color).save(out,format='PNG');return out.getvalue()


class WireFixture:
    """A fragmented RFB peer, not a guest or native device."""
    def __init__(self):
        self.queue=collections.deque();self.sent=[];self.controls=[];self.closed=False;self.reply=None
        pixel=struct.pack('!BBBBHHHBBB3x',32,24,0,1,255,255,255,16,8,0)
        initial=b'RFB 003.008\n'+b'\x01\x01'+bytes(4)+struct.pack('!HH',2,2)+pixel+struct.pack('!I',4)+b'test'
        self.queue.extend(bytes([byte]) for byte in initial)
        self.queue.append({'type':'control','state':'view-only'})
    def send_bytes(self,value):
        self.sent.append(value)
        if value and value[0]==3 and self.reply:self.reply()
    def send_control(self,value):self.controls.append(value)
    def receive(self,timeout=30):return self.queue.popleft() if self.queue else None
    def close(self):self.closed=True
    def update(self,*rectangles):
        value=struct.pack('!BBH',0,0,len(rectangles))+b''.join(rectangles)
        self.queue.extend(value[i:i+7] for i in range(0,len(value),7))


@unittest.skipUnless(Image,'Install the visual extra for image decoder tests')
class VisualSDKWireTests(unittest.TestCase):
    def test_fragmented_raw_rectangles_are_assembled_without_blank_regions(self):
        wire=WireFixture();display=DisplayClient(wire)
        pixel=lambda c:bytes((*c,0))*2
        wire.reply=lambda:wire.update(struct.pack('!HHHHi',0,0,2,1,0)+pixel((255,0,0)),
            struct.pack('!HHHHi',0,1,2,1,0)+pixel((0,0,255)))
        with Image.open(io.BytesIO(display.screenshot())) as image:
            self.assertEqual(list(image.getdata()),[(255,0,0)]*2+[(0,0,255)]*2)
        self.assertEqual(display.state,'view-only')
        with self.assertRaises(Error):display.key(ord('a'))
        self.assertFalse(wire.closed)

    def test_tight_png_fill_and_resize_use_one_current_coordinate_space(self):
        wire=WireFixture();display=DisplayClient(wire)
        data=png((3,1),(7,8,9))
        wire.reply=lambda:wire.update(struct.pack('!HHHHi',0,0,3,1,-223),
            struct.pack('!HHHHi',0,0,3,1,-260)+b'\xa0'+compact_length(len(data))+data)
        with Image.open(io.BytesIO(display.screenshot())) as image:
            self.assertEqual(image.size,(3,1));self.assertEqual(image.getpixel((2,0)),(7,8,9))
        wire.reply=lambda:wire.update(struct.pack('!HHHHi',0,0,3,1,-260)+b'\x80\x01\x02\x03')
        with Image.open(io.BytesIO(display.screenshot())) as image:self.assertEqual(image.getpixel((0,0)),(1,2,3))

    def test_partial_or_malformed_frames_never_return_a_screenshot(self):
        for kind in ('partial','outside','compressed-mismatch','budget'):
            with self.subTest(kind=kind):
                wire=WireFixture();display=DisplayClient(wire,max_frame_bytes=1024)
                if kind=='partial':
                    def reply():
                        wire.reply=None;wire.update(struct.pack('!HHHHi',0,0,1,1,0)+b'\x01\x02\x03\0')
                elif kind=='outside':reply=lambda:wire.update(struct.pack('!HHHHi',1,1,2,2,0))
                elif kind=='budget':reply=lambda:wire.update(struct.pack('!HHHHi',0,0,100,100,-223))
                else:
                    data=png((1,1),(1,2,3))
                    reply=lambda:wire.update(struct.pack('!HHHHi',0,0,2,2,-260)+b'\xa0'+compact_length(len(data))+data)
                wire.reply=reply
                with self.assertRaises(Error) as failure:display.screenshot(timeout=.1)
                if kind=='compressed-mismatch':self.assertIn('dimensions differ',str(failure.exception))
                self.assertTrue(wire.closed)

    def test_jpeg_rectangle_and_unknown_action_receipt_do_not_bypass_ownership(self):
        wire=WireFixture();display=DisplayClient(wire)
        data=io.BytesIO();Image.new('RGB',(2,2),(20,30,40)).save(data,format='JPEG',quality=100)
        encoded=data.getvalue()
        wire.reply=lambda:wire.update(struct.pack('!HHHHi',0,0,2,2,-260)+b'\x90'+compact_length(len(encoded))+encoded)
        with Image.open(io.BytesIO(display.screenshot())) as image:
            self.assertTrue(all(abs(a-b)<4 for a,b in zip(image.getpixel((0,0)),(20,30,40))))
        display.state='owned';request=str(uuid.uuid4())
        def send(value):
            wire.controls.append(value)
            wire.queue.append({'type':'action-result','id':str(uuid.uuid4()),'state':'succeeded','result':{}})
            wire.queue.append({'type':'action-result','id':value['id'],'state':'unknown','result':{'detail':'Fixture interrupted action'}})
        wire.send_control=send
        self.assertEqual(display.action(request,'text',{'text':'uncertain'})['state'],'unknown')
        self.assertEqual(display.state,'reset-uncertain')
        with self.assertRaises(Error):display.key(ord('a'))
        self.assertEqual(display.receipt(request)['state'],'unknown')
        self.assertEqual([v['type'] for v in wire.controls],['action','action-receipt'])

    def test_timeout_keeps_action_id_and_never_replays_after_close(self):
        wire=WireFixture();display=DisplayClient(wire);display.state='owned';request=str(uuid.uuid4())
        with self.assertRaises(Error) as failure:display.action(request,'text',{'text':'once'},timeout=.1)
        self.assertEqual(failure.exception.request_id,request)
        self.assertEqual(failure.exception.outcome,'unknown');self.assertFalse(failure.exception.retryable)
        self.assertEqual(wire.controls,[{'type':'action','id':request,'action':'text','arguments':{'text':'once'}}])
        with self.assertRaises(Error):display.action(request,'text',{'text':'once'})
        self.assertEqual(len(wire.controls),1)

    def test_dispatch_failure_preserves_unknown_outcome_and_does_not_retry(self):
        for exception in (EOFError('private-peer-detail'),OSError('private-socket-detail')):
            with self.subTest(exception=type(exception).__name__):
                wire=WireFixture();display=DisplayClient(wire);display.state='owned';request=str(uuid.uuid4())
                def interrupted(value):
                    wire.controls.append(value)
                    raise exception
                wire.send_control=interrupted
                with self.assertRaises(Error) as failure:display.action(request,'text',{'text':'once'})
                error=failure.exception
                self.assertEqual((error.code,error.request_id,error.outcome,error.retryable),
                                 ('session_incomplete',request,'unknown',False))
                self.assertNotIn('private-',str(error));self.assertTrue(wire.closed)
                with self.assertRaises(Error):display.action(request,'text',{'text':'once'})
                self.assertEqual(len(wire.controls),1)

    def test_invalid_timeout_is_rejected_before_action_dispatch(self):
        wire=WireFixture();display=DisplayClient(wire);display.state='owned'
        with self.assertRaises(Error):display.action(str(uuid.uuid4()),'text',{'text':'never'},timeout=0)
        self.assertEqual(wire.controls,[]);self.assertFalse(wire.closed)

    def test_new_capture_does_not_fill_missing_pixels_with_a_previous_capture(self):
        wire=WireFixture();display=DisplayClient(wire)
        wire.reply=lambda:wire.update(struct.pack('!HHHHi',0,0,2,2,0)+b'\x01\x02\x03\0'*4)
        display.screenshot()
        def partial():
            wire.reply=None;wire.update(struct.pack('!HHHHi',0,0,1,1,0)+b'\x04\x05\x06\0')
        wire.reply=partial
        with self.assertRaises(Error):display.screenshot(timeout=.1)
        self.assertTrue(wire.closed)


@unittest.skipUnless(Image,'Install the visual extra for broker display tests')
class VisualSDKBrokerTests(AccessFixture):
    def setUp(self):
        super().setUp();self.ready();self.sdk=LeaseClient(self.upstream,self.lease['id'],self.token)
        self.controls=DisplayControls(Path(self.temp.name)/'input.json');self.calls=[];self.connections=[];self.workers=[];self.seen=set()
        self.stop=threading.Event();self.size=(2,2);self.color=(10,20,30);self.folder=Path(self.temp.name)/'display';self.folder.mkdir()
        self.machine_definition={'id':self.machine,'desired':'running'}
        self.provider=Mobile({},self.folder);self.provider.control=self.control
        self.errors=[]
        self.dispatch=threading.Thread(target=self.poll_host,daemon=True);self.dispatch.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.stop.set();self.controls.close()
        for connection in self.connections:connection.close()
        self.dispatch.join(3)
        for worker in self.workers:worker.join(3)
        self.assertFalse(self.dispatch.is_alive())
        self.assertTrue(all(not worker.is_alive() for worker in self.workers));self.assertEqual(self.errors,[])

    def control(self,machine,image,folder,request):
        self.calls.append(request)
        if request['action']=='screenshot':return {'data':base64.b64encode(png(self.size,self.color)).decode()}
        return {'posted':True}

    def poll_host(self):
        while not self.stop.wait(.01):
            try:jobs=self.ready()['accessSessions']
            except Error:continue
            for job in jobs:
                if job['id'] in self.seen:continue
                self.seen.add(job['id']);worker=threading.Thread(target=self.serve,args=(job,),daemon=True)
                self.workers.append(worker);worker.start()

    def serve(self,job):
        connection=None
        try:
            client=Client(self.upstream,self.host_token)
            connection=SessionConnection(client,'/v1/hosts/'+self.host+'/sessions/'+job['id']+'/'+job['generation'])
            self.connections.append(connection)
            if connection.receive(3)['type']!='ready':raise AssertionError('Broker did not pair fixture display')
            image={'os':'android'};machine=self.machine_definition
            endpoint=DisplayEndpoint(self.controls,self.machine,
                lambda:connect(self.provider,machine,image,self.folder,lambda:not self.stop.is_set()),
                lambda:not self.stop.is_set(),lambda:{'startedAt':1,'identity':'fixture-boot'},job['id'],
                action_handler=lambda request:self.provider.operate(machine,image,self.folder,{**request,'expiresAt':time.time()+30}),
                receipt_handler=lambda request_id:operation_receipt(self.folder,request_id))
            endpoint.run_display(connection)
        except (Error,EOFError,OSError):pass
        except Exception as error:self.errors.append(error)
        finally:
            if connection:connection.close()

    def test_scoped_capture_two_viewers_input_receipt_and_rotation(self):
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as first,self.sdk.display(str(uuid.uuid4()),timeout=5) as second:
            self.assertEqual(first.take_control(3),'owned');self.assertEqual(second.take_control(3),'busy')
            with self.assertRaises(Error):second.pointer(0,0,1)
            self.assertFalse(second.closed)
            with Image.open(io.BytesIO(second.screenshot(3))) as image:self.assertEqual(image.getpixel((0,0)),(10,20,30))
            request=str(uuid.uuid4());result=first.action(request,'text',{'text':'one action'},3)
            self.assertEqual(result['state'],'succeeded');self.assertEqual(second.receipt(request,3),result)
            self.assertEqual(first.action(request,'text',{'text':'one action'},3),result)
            self.assertEqual(len([c for c in self.calls if c['action']=='text']),1)
            first.key(ord('a'),True);first.key(ord('a'),False);first.pointer(1,1,1);first.pointer(1,1,0)
            first.press_key(ord('b'));first.click(0,0)
            self.assertEqual(first.release_control(3),'view-only');self.assertEqual(second.take_control(3),'owned')
            self.assertEqual([c['arguments'] for c in self.calls if c['action']=='tap'],[{'x':1,'y':1},{'x':0,'y':0}])
            self.size=(3,1)
            with Image.open(io.BytesIO(second.screenshot(3))) as image:self.assertEqual(image.size,(3,1))
            with self.assertRaises(Error):second.pointer(0,1)
            self.assertEqual(second.release_control(3),'view-only')
            self.assertEqual(second.receipt(str(uuid.uuid4()),3)['state'],'unknown')

    def test_expired_lease_cannot_capture_or_reconnect_the_same_session(self):
        request=str(uuid.uuid4());display=self.sdk.display(request,timeout=5)
        self.addCleanup(display.close)
        display.screenshot(3);self.now+=121
        with self.assertRaises(Error):display.screenshot(3)
        with self.assertRaises(Error):self.sdk.display(request,timeout=3)

    def test_first_capture_after_action_uses_current_provider_pixels(self):
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as display:
            self.assertEqual(display.take_control(3),'owned')
            display.action(str(uuid.uuid4()),'text',{'text':'changed UI'},3)
            self.color=(100,110,120)
            with Image.open(io.BytesIO(display.screenshot(3))) as image:self.assertEqual(image.getpixel((0,0)),self.color)
            display.release_control(3)

    def test_lost_success_acknowledgement_is_recovered_by_read_only_receipt(self):
        request=str(uuid.uuid4())
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as display:
            self.assertEqual(display.take_control(3),'owned')
            receive=display.connection.receive
            def drop_ack(timeout=30):
                value=receive(timeout)
                if isinstance(value,dict) and value.get('type')=='action-result' and value.get('id')==request:
                    self.assertEqual(value['state'],'succeeded')
                    raise EOFError('Fixture loses the acknowledgement after provider completion')
                return value
            display.connection.receive=drop_ack
            with self.assertRaises(Error) as failure:display.action(request,'text',{'text':'once'},3)
            self.assertEqual((failure.exception.request_id,failure.exception.outcome,failure.exception.retryable),
                             (request,'unknown',False))
            self.assertTrue(display.closed)
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as inspector:
            self.assertEqual(inspector.state,'view-only')
            receipt=inspector.receipt(request,3)
            self.assertEqual((receipt['id'],receipt['state']),(request,'succeeded'))
            self.assertEqual(len([call for call in self.calls if call['action']=='text']),1)
            self.assertEqual(inspector.state,'view-only')
