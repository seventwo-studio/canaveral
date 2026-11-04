import base64
import json
import queue
import struct
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.display_access import DisplayControls,DisplayEndpoint
from canaveral.guest_stream_display import GuestStreamScreen,connect
from canaveral.model import Error
from test_display_access import Channel

PNG='iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAE0lEQVR4nGMU0QhggAEmOAudAwAUnACSJ66rswAAAABJRU5ErkJggg=='


class Helper:
    def __init__(self):
        self.calls=[];self.lock=threading.RLock();self.owner=None;self.sequence=0
        self.fail=None;self.fail_after=False;self.busy=False;self.payload=None;self.effects=[];self.releases=[]
    def __call__(self,path,body):
        with self.lock:
            self.calls.append((path,body))
            if path==self.fail:raise Error('Fixture acknowledgement lost',409)
            if path=='/v1/display/frame':
                return self.payload or {'frame':{'id':str(uuid.uuid4()),'width':4,'height':3,'pngBase64':PNG,'capturedAt':100},
                                        'displayID':1,'bounds':{'x':10,'y':20,'width':1440,'height':900}}
            stream=body['streamId']
            if path=='/v1/display/take':
                if self.busy or (self.owner and self.owner!=stream):raise Error('Native owner busy',409,code='input_busy')
                self.owner=stream
                return {'streamId':stream.upper(),'sequence':self.sequence,'state':'owned'}
            if path=='/v1/display/input':
                assert self.owner==stream;assert body['sequence']==self.sequence+1
                self.sequence+=1;self.effects.append(body['event'])
                return {'streamId':stream,'sequence':self.sequence,'posted':True}
            if path=='/v1/display/action':
                assert self.owner==stream
                self.effects.append({'type':'semantic','id':body['id'],'action':body['action'],'arguments':body['arguments']})
                if self.fail_after:raise Error('Fixture loses posted semantic acknowledgement',409)
                return {'id':body['id'],'status':'posted'}
            if path=='/v1/display/release':
                assert self.owner==stream
                self.owner=None;self.sequence=0;self.releases.append(stream)
                return {'released':True}
            raise AssertionError(path)


class GuestStreamDisplayTests(unittest.TestCase):
    def test_frames_full_key_edges_modifiers_drag_and_clipboard_keep_one_native_owner(self):
        helper=Helper();screen=GuestStreamScreen(helper,lambda:True)
        self.assertEqual(screen.capture(),base64.b64decode(PNG));self.assertEqual(screen.take_input(),'owned')
        screen.key(1,0xffe3);screen.key(1,ord('c'));screen.key(0,ord('c'))
        screen.pointer(1,0,0);screen.pointer(1,3,2);screen.pointer(0,3,2);screen.key(0,0xffe3)
        screen.action('text',{'text':'héllo\n'})
        self.assertEqual(screen.take_input(),'owned') # Revalidates helper ownership without a new/reset stream.
        self.assertEqual(helper.effects,[{'type':'key','keysym':0xffe3,'down':True},{'type':'key','keysym':99,'down':True},
            {'type':'key','keysym':99,'down':False},{'type':'pointer','x':0,'y':0,'buttons':1},
            {'type':'pointer','x':3,'y':2,'buttons':1},{'type':'pointer','x':3,'y':2,'buttons':0},
            {'type':'key','keysym':0xffe3,'down':False},{'type':'text','text':'héllo\n'}])
        self.assertTrue(screen.reset_input());self.assertEqual(len(helper.releases),1)
        self.assertEqual(screen.take_input(),'owned');self.assertNotEqual(helper.owner,helper.releases[0]);screen.close_input()

    def test_typed_busy_claim_is_definite_and_can_be_attempted_later_without_resetting_other_owner(self):
        helper=Helper();helper.busy=True;screen=GuestStreamScreen(helper,lambda:True)
        self.assertEqual(screen.take_input(),'busy');self.assertIsNone(screen.stream);self.assertFalse(screen.uncertain)
        self.assertTrue(screen.reset_input());self.assertFalse(helper.releases)
        helper.busy=False;self.assertEqual(screen.take_input(),'owned');screen.close_input()

    def test_lost_claim_or_input_acknowledgement_is_not_replayed(self):
        for path in ('/v1/display/take','/v1/display/input'):
            helper=Helper();screen=GuestStreamScreen(helper,lambda:True);screen.capture()
            if path.endswith('/input'):self.assertEqual(screen.take_input(),'owned')
            helper.fail=path
            if path.endswith('/take'):self.assertEqual(screen.take_input(),'reset-uncertain')
            else:
                with self.assertRaises(Error):screen.key(1,65)
            self.assertTrue(screen.uncertain);self.assertEqual(screen.take_input(),'reset-uncertain')
            self.assertEqual(sum(route==path for route,_ in helper.calls),1)

    def test_failed_release_does_not_confirm_ordered_reset(self):
        helper=Helper();screen=GuestStreamScreen(helper,lambda:True);screen.take_input();helper.fail='/v1/display/release'
        with self.assertRaises(Error):screen.reset_input()
        self.assertIsNotNone(screen.stream);self.assertFalse(helper.releases)

    def test_revocation_blocks_input_but_explicit_owned_cleanup_can_still_release(self):
        helper=Helper();allowed=[True];screen=GuestStreamScreen(helper,lambda:allowed[0],cleanup_authorized=lambda:True)
        screen.capture();screen.take_input();allowed[0]=False
        with self.assertRaises(Error):screen.key(1,65)
        self.assertFalse(helper.effects);self.assertTrue(screen.reset_input());self.assertEqual(len(helper.releases),1)
        with self.assertRaises(Error):screen.take_input()

    def test_no_cleanup_authorization_never_creates_a_hidden_transport_bypass(self):
        helper=Helper();allowed=[True];screen=GuestStreamScreen(helper,lambda:allowed[0]);screen.capture();screen.take_input()
        allowed[0]=False;before=len(helper.calls)
        with self.assertRaises(Error):screen.reset_input()
        screen.close_input();self.assertEqual(len(helper.calls),before)

    def test_malformed_frames_and_pointer_coordinates_never_send_input(self):
        helper=Helper();screen=GuestStreamScreen(helper,lambda:True);screen.capture();screen.take_input()
        for point in [(4,0),(0,3),(-1,0),(True,0)]:
            with self.subTest(point=point),self.assertRaises(Error):screen.pointer(1,*point)
        self.assertFalse(helper.effects)
        good=helper('/v1/display/frame',None)
        for changed in [{'displayID':True},{'bounds':{'x':0,'y':0,'width':float('inf'),'height':1}},
                        {'frame':{**good['frame'],'width':True}},{'frame':{**good['frame'],'id':'bad'}},
                        {'frame':{**good['frame'],'pngBase64':'!!!!'}}]:
            helper.payload={**good,**changed}
            with self.subTest(change=list(changed)),self.assertRaises(Error):screen.capture()
        screen.close_input()

    def test_bad_input_acknowledgement_fences_future_input(self):
        helper=Helper();screen=GuestStreamScreen(helper,lambda:True);screen.capture();screen.take_input()
        original=screen.request
        screen.request=lambda path,body: {**original(path,body),'posted':1}
        with self.assertRaises(Error):screen.key(1,65)
        with self.assertRaises(Error):screen.key(0,65)
        self.assertEqual(len(helper.effects),1);screen.request=original;screen.close_input()

    def test_input_requires_ownership_and_preserves_response_frame_binding(self):
        helper=Helper();screen=GuestStreamScreen(helper,lambda:True);screen.capture();frame=screen.frame
        with self.assertRaises(Error):screen.key(1,65)
        screen.take_input();screen.key(1,65)
        self.assertEqual(helper.calls[-1][1]['frameId'],frame)
        self.assertEqual(sum(path=='/v1/display/frame' for path,_ in helper.calls),1) # No unseen refresh before input.
        screen.close_input()

    def test_readonly_busy_frame_can_retry_but_input_never_fetches_hidden_pixels(self):
        helper=Helper();request=Mock(side_effect=[Error('Busy frame',409,code='input_busy'),helper('/v1/display/frame',None)])
        screen=GuestStreamScreen(request,lambda:True)
        with patch('canaveral.guest_stream_display.time.sleep'):
            self.assertEqual(screen.capture(),base64.b64decode(PNG))
        self.assertEqual(request.call_count,2)
        self.assertTrue(all(call.args==('/v1/display/frame',None) for call in request.call_args_list))

    def test_swift_bridge_transcript_is_consumed_by_the_python_adapter(self):
        fixture=Path(__file__).parent/'fixtures/native_guest_stream.json'
        events=json.loads(fixture.read_text())['events'];pending=list(events)
        def request(path,body):
            event=pending.pop(0);self.assertEqual(path,event['route'])
            def normalize(value):
                if value is None:return None
                return {k:str(uuid.UUID(v)) if k in ('streamId','frameId') else v for k,v in value.items()}
            self.assertEqual(normalize(body),normalize(event['request']));return event['response']
        screen=GuestStreamScreen(request,lambda:True)
        with patch('canaveral.guest_stream_display.uuid.uuid4',return_value=uuid.UUID('40404040-4040-4040-8040-404040404040')):
            screen.capture();screen.take_input()
        screen.key(1,0xffe3);screen.key(1,99);screen.key(0,99)
        screen.pointer(1,3,2);screen.pointer(0,3,2);screen.key(0,0xffe3);self.assertTrue(screen.reset_input())
        self.assertEqual(pending,[])


class GuestStreamSharedViewerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.controls=DisplayControls(Path(self.temp.name)/'controls.json');self.addCleanup(self.controls.close)
        self.helper=Helper();self.machine=str(uuid.uuid4());self.active=True
        self.epoch={'identity':'fixture-boot','startedAt':1}

    def start(self):
        from canaveral.providers.mobile import Mobile,operation_receipt
        channel=Channel();connection=[]
        folder=Path(self.temp.name)/'operations-root';folder.mkdir(exist_ok=True)
        provider=Mobile({},folder)
        provider.control=Mock(side_effect=AssertionError('No administrative/native input fallback'))
        machine={'id':self.machine,'desired':'running'}
        def operate(request,handler):
            return provider.operate(machine,{'os':'macos'},folder,{**request,'expiresAt':time.time()+30},control_handler=handler)
        def factory():
            result=connect(self.helper,lambda:self.active,cleanup_authorized=lambda:True);connection.append(result);return result
        endpoint=DisplayEndpoint(self.controls,self.machine,factory,lambda:self.active,lambda:self.epoch,
            context_action_handler=operate,receipt_handler=lambda operation_id:operation_receipt(folder,operation_id))
        errors=[]
        def run():
            try:endpoint.run_display(channel)
            except (Error,EOFError,OSError):pass
            except BaseException as error:errors.append(error)
        thread=threading.Thread(target=run);thread.start()
        def stop():
            endpoint.close();thread.join(4);self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
        self.addCleanup(stop)
        self.assertEqual(channel.next(),b'RFB 003.008\n');channel.incoming.put(b'RFB 003.008\n')
        self.assertEqual(channel.next(),b'\x01\x01');channel.incoming.put(b'\x01')
        self.assertEqual(channel.next(),bytes(4));channel.incoming.put(b'\x01')
        info=channel.next();self.assertEqual(struct.unpack('!HH',info[:4]),(4,3))
        self.assertEqual(channel.next(),{'type':'control','state':'view-only'})
        return channel,endpoint,connection

    def command(self,channel,action,state):
        channel.incoming.put({'type':'input-control','action':action})
        self.assertEqual(channel.next(),{'type':'control','state':state})

    def test_two_viewers_native_claim_precedes_owned_and_release_resets_held_keys(self):
        first,_,_=self.start();second,_,_=self.start()
        self.command(first,'take','owned');self.assertIsNotNone(self.helper.owner)
        self.command(second,'take','busy')
        first.incoming.put(struct.pack('!BB2xI',4,1,0xffe3)+struct.pack('!BB2xI',4,1,99)+struct.pack('!BB2xI',4,0,99))
        first.incoming.put(struct.pack('!BBHH',5,1,0,0)+struct.pack('!BBHH',5,1,3,2)+struct.pack('!BBHH',5,0,3,2))
        self.command(first,'release','view-only');self.assertIsNone(self.helper.owner)
        self.assertEqual(len(self.helper.effects),6);self.assertEqual(len(self.helper.releases),1)
        self.command(second,'take','owned');self.command(second,'release','view-only')

    def test_native_busy_is_not_announced_as_owned_and_does_not_block_future_claim(self):
        channel,_,_=self.start();self.helper.busy=True
        self.command(channel,'take','busy');self.assertIsNone(self.helper.owner)
        self.helper.busy=False;self.command(channel,'take','owned');self.command(channel,'release','view-only')

    def test_semantic_action_cannot_overtake_queued_keys_and_keeps_durable_deduplication(self):
        channel,_,_=self.start();self.command(channel,'take','owned')
        channel.incoming.put(struct.pack('!BB2xI',4,1,65)+struct.pack('!BB2xI',4,0,65))
        operation=str(uuid.uuid4());action={'type':'action','id':operation,'action':'text','arguments':{'text':'once'}}
        channel.incoming.put(action);report=channel.next();self.assertEqual(report['state'],'succeeded')
        self.assertEqual([value['type'] for value in self.helper.effects],['key','key','semantic'])
        channel.incoming.put(action);self.assertEqual(channel.next(),report)
        self.assertEqual(len(self.helper.effects),3)
        self.command(channel,'release','view-only')
        channel.incoming.put({'type':'action-receipt','id':operation});self.assertEqual(channel.next(),report)

    def test_lost_semantic_acknowledgement_keeps_unknown_receipt_and_never_redispatches(self):
        channel,_,_=self.start();self.command(channel,'take','owned');self.helper.fail_after=True
        operation=str(uuid.uuid4());action={'type':'action','id':operation,'action':'text','arguments':{'text':'once'}}
        channel.incoming.put(action)
        state=channel.next();self.assertEqual(state,{'type':'control','state':'reset-uncertain'})
        result=channel.next();self.assertEqual(result['state'],'unknown')
        channel.incoming.put({'type':'action-receipt','id':operation});self.assertEqual(channel.next(),result)
        self.assertEqual(len([event for event in self.helper.effects if event['type']=='semantic']),1)


    def test_unknown_native_claim_keeps_the_common_control_ledger_blocked(self):
        channel,endpoint,_=self.start();self.helper.fail='/v1/display/take'
        self.command(channel,'take','reset-uncertain')
        self.assertEqual(self.controls.records[self.machine]['phase'],'blocked')
        self.helper.fail=None;self.command(channel,'take','reset-uncertain')
        endpoint.close()

# Reuse the synthetic lease catalogue only for broker authentication. This does
# not admit a macOS image, run an Agent with leaseProtocol, or boot a guest.
from test_access_sessions import AccessFixture
from canaveral.client import Client
from canaveral.sdk import LeaseClient
from canaveral.session_transport import SessionConnection
from canaveral.providers.mobile import Mobile,operation_receipt
try:
    from PIL import Image
except ImportError:
    Image=None


@unittest.skipUnless(Image,'Install the declared visual extra for SDK decoding')
class GuestStreamSDKTests(AccessFixture):
    def setUp(self):
        super().setUp();self.ready();self.sdk=LeaseClient(self.upstream,self.lease['id'],self.token)
        self.helper=Helper();self.controls=DisplayControls(Path(self.temp.name)/'native-controls.json')
        self.stop=threading.Event();self.connections=[];self.workers=[];self.seen=set();self.errors=[]
        self.folder=Path(self.temp.name)/'native-operations';self.folder.mkdir()
        self.provider=Mobile({},self.folder);self.provider.control=Mock(side_effect=AssertionError('No administrative fallback'))
        self.dispatch=threading.Thread(target=self.poll_host,daemon=True);self.dispatch.start();self.addCleanup(self.finish)

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
            self.connections.append(connection);self.assertEqual(connection.receive(3)['type'],'ready')
            def operate(request,handler):
                return self.provider.operate({'id':self.machine,'desired':'running'},{'os':'macos'},self.folder,
                    {**request,'expiresAt':time.time()+30},control_handler=handler)
            endpoint=DisplayEndpoint(self.controls,self.machine,
                lambda:connect(self.helper,lambda:not self.stop.is_set(),cleanup_authorized=lambda:True),
                lambda:not self.stop.is_set(),lambda:{'startedAt':1,'identity':'native-protocol-fixture'},job['id'],
                context_action_handler=operate,receipt_handler=lambda operation_id:operation_receipt(self.folder,operation_id))
            endpoint.run_display(connection)
        except (Error,EOFError,OSError):pass
        except Exception as error:self.errors.append(error)
        finally:
            if connection:connection.close()

    def finish(self):
        self.stop.set();self.controls.close()
        for connection in self.connections:connection.close()
        self.dispatch.join(3)
        for worker in self.workers:worker.join(3)
        self.assertFalse(self.dispatch.is_alive());self.assertTrue(all(not worker.is_alive() for worker in self.workers));self.assertEqual(self.errors,[])

    def test_sdk_png_decode_keyboard_drag_semantic_receipts_and_two_viewers(self):
        import io
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as first,self.sdk.display(str(uuid.uuid4()),timeout=5) as second:
            with Image.open(io.BytesIO(first.screenshot(3))) as image:
                self.assertEqual(image.size,(4,3));self.assertEqual(image.getpixel((0,0)),(20,40,80))
            self.assertEqual(first.take_control(3),'owned');self.assertEqual(second.take_control(3),'busy')
            first.key(0xffe3,True);first.key(99,True);first.key(99,False);first.key(0xffe3,False)
            first.pointer(0,0,1);first.pointer(3,2,1);first.pointer(3,2,0)
            operation=str(uuid.uuid4());result=first.action(operation,'text',{'text':'one semantic action'},3)
            self.assertEqual(result['state'],'succeeded');self.assertEqual(second.receipt(operation,3),result)
            self.assertEqual(first.action(operation,'text',{'text':'one semantic action'},3),result)
            self.assertEqual([effect['type'] for effect in self.helper.effects],['key']*4+['pointer']*3+['semantic'])
            self.assertEqual(first.release_control(3),'view-only');self.assertIsNone(self.helper.owner)
            self.assertEqual(second.take_control(3),'owned');self.assertEqual(second.release_control(3),'view-only')
            self.provider.control.assert_not_called()

    def test_sdk_unknown_native_semantic_result_is_readable_from_a_new_view_only_session(self):
        operation=str(uuid.uuid4())
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as first:
            self.assertEqual(first.take_control(3),'owned');self.helper.fail_after=True
            result=first.action(operation,'text',{'text':'once'},3);self.assertEqual(result['state'],'unknown')
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as inspector:
            self.assertEqual(inspector.state,'view-only');self.assertEqual(inspector.receipt(operation,3),result)
            self.assertEqual(len([effect for effect in self.helper.effects if effect['type']=='semantic']),1)
            self.assertEqual(inspector.take_control(3),'reset-uncertain')

    def test_sdk_lease_expiry_does_not_reconnect_or_resume_native_stream(self):
        request=str(uuid.uuid4());display=self.sdk.display(request,timeout=5);self.addCleanup(display.close)
        self.assertEqual(display.take_control(3),'owned');display.screenshot(3);self.now+=121
        with self.assertRaises(Error):display.screenshot(3)
        with self.assertRaises(Error):self.sdk.display(request,timeout=3)
