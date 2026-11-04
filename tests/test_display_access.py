import json
import queue
import socket
import struct
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.display_access import ClientMessages, DisplayControls, DisplayEndpoint
from canaveral.model import Error
from canaveral.simulator_screen import connect
from test_simulator_screen import Provider


class Channel:
    def __init__(self):
        self.incoming=queue.Queue();self.outgoing=queue.Queue();self.closed=False
    def receive(self,timeout):
        if self.closed:raise EOFError()
        try:return self.incoming.get(timeout=timeout)
        except queue.Empty:return None
    def send_bytes(self,value):self.outgoing.put(value)
    def send_control(self,value):self.outgoing.put(value)
    def close(self):self.closed=True
    def next(self):return self.outgoing.get(timeout=3)


class DisplayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'controls.json';self.controls=DisplayControls(self.path)
        self.addCleanup(self.controls.close)
        self.machine=str(uuid.uuid4());self.epoch={'startedAt':1,'identity':'boot-one'}
        self.provider=Provider();self.threads=[]

    def start(self,action_handler=None,system='android'):
        channel=Channel()
        endpoint=DisplayEndpoint(self.controls,self.machine,
            lambda:connect(self.provider,{}, {'os':system},None,lambda:True),
            lambda:True,lambda:self.epoch,action_handler=action_handler)
        errors=[]
        def run():
            try:endpoint.run_display(channel)
            except (EOFError,Error,OSError):pass
            except Exception as error:errors.append(error)
        worker=threading.Thread(target=run);worker.start()
        def stop():
            endpoint.close();worker.join(4)
            self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
        self.addCleanup(stop)
        self.assertEqual(channel.next(),b'RFB 003.008\n')
        channel.incoming.put(b'RFB 003.008\n')
        self.assertEqual(channel.next(),b'\x01\x01')
        channel.incoming.put(b'\x01')
        self.assertEqual(channel.next(),bytes(4))
        channel.incoming.put(b'\x00')
        info=channel.next();self.assertEqual(struct.unpack('!HH',info[:4]),(1080,2400))
        self.assertEqual(channel.next(),{'type':'control','state':'view-only'})
        return channel,endpoint

    def command(self,channel,action,state):
        channel.incoming.put({'type':'input-control','action':action})
        self.assertEqual(channel.next(),{'type':'control','state':state})

    def test_two_viewers_exclusive_input_and_cancel_partial_gesture(self):
        first,endpoint=self.start();second,_=self.start()
        down=struct.pack('!BBHH',5,1,50,60);up=struct.pack('!BBHH',5,0,50,60)
        first.incoming.put(down+up)
        self.assertEqual(first.next()['state'],'view-only')
        self.command(first,'take','owned');self.command(second,'take','busy')
        first.incoming.put(down)
        self.command(first,'release','view-only')
        self.assertEqual([r for r in self.provider.calls if r['action']!='screenshot'],[])
        self.command(second,'take','owned')
        second.incoming.put(down+up)
        # The release barrier confirms all preceding simulator messages ran.
        self.command(second,'release','view-only')
        self.assertEqual([(r['action'],r['arguments']) for r in self.provider.calls if r['action']!='screenshot'],[('tap',{'x':50,'y':60})])
        self.command(first,'take','owned');first.incoming.put(down)
        endpoint.close();self.assertTrue(endpoint.finished.wait(3))
        self.command(second,'take','owned');self.command(second,'release','view-only')
        self.assertEqual(len([r for r in self.provider.calls if r['action']=='tap']),1)

    def test_demand_frame_and_fragmented_input(self):
        channel,_=self.start();self.command(channel,'take','owned')
        frame=struct.pack('!BBHii',2,0,2,-260,-223)+struct.pack('!BBHHHH',3,0,0,0,1080,2400)
        for byte in frame:channel.incoming.put(bytes([byte]))
        output=channel.next();self.assertEqual(output[:4],b'\0\0\0\1')
        key=struct.pack('!BB2xI',4,1,ord('a'))
        for byte in key:channel.incoming.put(bytes([byte]))
        self.command(channel,'release','view-only')
        self.assertEqual([r['arguments'] for r in self.provider.calls if r['action']=='text'],[{'text':'a'}])

    def test_both_simulators_share_owned_pointer_keyboard_and_clipboard_framing(self):
        for system,scale,key in (('android',1,'ENTER'),('ios',3,'40')):
            with self.subTest(system=system):
                channel,endpoint=self.start(system=system)
                self.command(channel,'take','owned')
                frames=(struct.pack('!BBHH',5,1,300,600)+struct.pack('!BBHH',5,0,300,600)+
                    struct.pack('!BBHH',5,1,300,600)+struct.pack('!BBHH',5,0,600,900)+
                    struct.pack('!BB2xI',4,1,0xff0d)+struct.pack('!BB2xI',4,0,0xff0d)+
                    struct.pack('!BB2xI',4,1,ord('a'))+struct.pack('!BB2xI',4,0,ord('a'))+
                    struct.pack('!B3xI',6,5)+b'paste')
                # Arbitrary transport boundaries cannot split a native gesture.
                for offset in range(0,len(frames),7):channel.incoming.put(frames[offset:offset+7])
                self.command(channel,'release','view-only')
                inputs=[r for r in self.provider.calls if r['action']!='screenshot']
                self.assertEqual([r['action'] for r in inputs],['tap','swipe','key','text','text'])
                self.assertEqual(inputs[0]['arguments'],{'x':300//scale,'y':600//scale})
                args=inputs[1]['arguments']
                self.assertEqual((args['x'],args['y'],args['toX'],args['toY']),
                    (300//scale,600//scale,600//scale,900//scale))
                self.assertEqual(inputs[2]['arguments'],{'key':key})
                self.assertEqual(inputs[3]['arguments'],{'text':'a'})
                self.assertEqual(inputs[4]['arguments'],{'text':'paste'})
                self.provider.calls.clear()
                endpoint.close();self.assertTrue(endpoint.finished.wait(3))

    def test_restart_fences_uncertain_owner_and_requires_newer_boot(self):
        self.assertEqual(self.controls.claim(self.machine,'one',self.epoch,lambda:True),'owned')
        recovered=DisplayControls(self.path)
        self.assertEqual(recovered.claim(self.machine,'two',self.epoch,lambda:True),'reset-uncertain')
        self.assertEqual(recovered.claim(self.machine,'two',{'startedAt':0,'identity':'old'},lambda:True),'stale')
        self.assertEqual(recovered.claim(self.machine,'two',{'startedAt':2,'identity':'new'},lambda:False),'stale')
        self.assertEqual(recovered.claim(self.machine,'two',{'startedAt':2,'identity':'new'},lambda:True),'owned')
        record=json.loads(self.path.read_text())[self.machine]
        self.assertEqual(set(record),{'phase','owner','epoch'})

    def test_reset_dispatch_releases_native_keys_and_buttons(self):
        endpoint=DisplayEndpoint(self.controls,self.machine,lambda:None,lambda:True)
        class Remote:
            def __init__(self):self.sent=[]
            def sendall(self,data):self.sent.append(data)
        endpoint.remote=Remote();endpoint.keys={0xffe1,ord('a')};endpoint.pointer=(1,12,34)
        self.assertTrue(endpoint.reset_input())
        self.assertEqual(endpoint.remote.sent,[struct.pack('!BB2xI',4,0,key) for key in (ord('a'),0xffe1)]+[struct.pack('!BBHH',5,0,12,34)])
        self.assertEqual(endpoint.keys,set());endpoint.stream_ok=False
        self.assertFalse(endpoint.reset_input())

    def test_failed_reset_blocks_ownership(self):
        channel,endpoint=self.start();self.command(channel,'take','owned')
        with patch.object(endpoint,'reset_input',return_value=False):
            self.command(channel,'release','reset-uncertain')
        self.command(channel,'take','reset-uncertain')
        endpoint.close();self.assertTrue(endpoint.finished.wait(3))

    def test_failed_release_receipt_still_closes_endpoint(self):
        channel,endpoint=self.start();self.command(channel,'take','owned')
        with patch('canaveral.display_access.save_json',side_effect=Error('Fixture disk write failed.')):
            endpoint.close();self.assertTrue(endpoint.finished.wait(3))
        self.assertEqual(self.controls.records[self.machine]['phase'],'blocked')
        self.assertNotIn(endpoint,self.controls.endpoints)

    def test_stale_connection_cannot_take_control_after_new_boot(self):
        channel,endpoint=self.start()
        self.epoch={'startedAt':2,'identity':'boot-two'}
        channel.incoming.put({'type':'input-control','action':'take'})
        self.assertTrue(endpoint.finished.wait(3))
        self.assertFalse(self.controls.owns(self.machine,endpoint.viewer,endpoint.epoch))

    def test_client_parser_bounds_and_extension_denial(self):
        parser=ClientMessages()
        enc=struct.pack('!BBHiii',2,0,3,-260,-258,-308)
        self.assertEqual(list(parser.feed(enc)),[(2,struct.pack('!BBHi',2,0,1,-260))])
        for data in [b'\xf9'+bytes(16),struct.pack('!B3xI',6,16001),struct.pack('!BB2xI',4,2,1),struct.pack('!BBH',2,0,257)]:
            with self.assertRaises(Error):list(ClientMessages().feed(data))
        with self.assertRaises(Error):list(ClientMessages().feed(bytes(81921)))

    def test_owned_discrete_action_and_uncertain_outcome_blocks_handover(self):
        from unittest.mock import Mock
        handler=Mock(return_value={'state':'succeeded','result':{'posted':True}})
        channel,endpoint=self.start(handler)
        action={'type':'action','id':str(uuid.uuid4()),'action':'tap','arguments':{'x':1,'y':2}}
        channel.incoming.put(action)
        self.assertEqual(channel.next()['result']['code'],'input_not_owned');handler.assert_not_called()
        self.command(channel,'take','owned');channel.incoming.put(action)
        self.assertEqual(channel.next(),{'type':'action-result','id':action['id'],'state':'succeeded','result':{'posted':True}})
        self.assertNotIn('type',handler.call_args.args[0])
        handler.return_value={'state':'unknown','result':{'detail':'Fixture interruption'}}
        channel.incoming.put({**action,'id':str(uuid.uuid4())})
        self.assertEqual(channel.next()['state'],'reset-uncertain')
        self.assertEqual(channel.next()['state'],'unknown')
        self.command(channel,'take','reset-uncertain')
        self.assertFalse(self.controls.owns(self.machine,endpoint.viewer,endpoint.epoch))


if __name__=='__main__':unittest.main()
