import base64
import json
import socket
import struct
import threading
import unittest
from unittest.mock import patch

from canaveral.model import Error
from canaveral.simulator_screen import SimulatorScreen, dimensions, compact_length


# Minimal header is enough here: rendering is exercised by the browser fixture.
PNG = b'\x89PNG\r\n\x1a\n' + struct.pack('!I',13) + b'IHDR' + struct.pack('!II',1080,2400)


class Provider:
    def __init__(self):
        self.calls = []
    def control(self,machine,image,folder,request):
        self.calls.append(request)
        return {'data':base64.b64encode(PNG).decode()}
    def storage(self,machine):return None
    def owned(self,*args):return {'udid':'owned'}
    def idb(self,*args):return json.dumps({'screen_dimensions':{'density':3}})


class SimulatorScreenTests(unittest.TestCase):
    def screen(self,system='android'):
        provider = Provider()
        screen = SimulatorScreen(provider,{'id':'owned'}, {'os':system},None,lambda:True)
        screen.size = (1080,2400)
        return provider,screen

    def test_shared_rfb_handshake_frames_and_input(self):
        provider, screen = self.screen()
        client,server = socket.socketpair()
        client.settimeout(3)
        worker = threading.Thread(target=screen.serve,args=(server,))
        worker.start()
        def read(size):
            data=b''
            while len(data)<size:data+=client.recv(size-len(data))
            return data
        try:
            self.assertEqual(read(12),b'RFB 003.008\n')
            client.sendall(b'RFB 003.008\n')
            self.assertEqual(read(2),b'\x01\x01')
            client.sendall(b'\x01')
            self.assertEqual(read(4),bytes(4))
            client.sendall(b'\x01')
            info=read(24)
            self.assertEqual(struct.unpack('!HH',info[:4]),(1080,2400))
            read(struct.unpack('!I',info[20:24])[0])
            client.sendall(struct.pack('!BBHii',2,0,2,-260,-223))
            request=struct.pack('!BBHHHH',3,0,0,0,1080,2400)
            client.sendall(request)
            frame=read(18+len(PNG))
            self.assertEqual(frame[:4],b'\0\0\0\1')
            self.assertEqual(frame[16],0xa0)
            self.assertEqual(frame[18:],PNG)
            # A second frame arrives without a durable operation or manual refresh.
            client.sendall(request)
            self.assertEqual(read(18+len(PNG))[18:],PNG)
            client.sendall(struct.pack('!BBHH',5,1,50,60)+struct.pack('!BBHH',5,0,50,60))
            client.sendall(struct.pack('!BB2xI',4,1,ord('a')))
            client.sendall(request)
            read(18+len(PNG))
            inputs=[(r['action'],r['arguments']) for r in provider.calls if r['action']!='screenshot']
            self.assertEqual(inputs,[('tap',{'x':50,'y':60}),('text',{'text':'a'})])
        finally:
            client.close()
            worker.join(3)
            self.assertFalse(worker.is_alive())

    def test_ios_points_drag_scroll_and_keys(self):
        provider,screen=self.screen('ios')
        screen.pointer(1,300,600)
        screen.pointer(0,600,900)
        args=provider.calls[-1]['arguments']
        self.assertEqual((args['x'],args['y'],args['toX'],args['toY']),(100,200,200,300))
        screen.pointer(8,300,600)
        self.assertEqual(provider.calls[-1]['action'],'swipe')
        screen.key(1,0xff0d)
        self.assertEqual(provider.calls[-1]['arguments'],{'key':'40'})
        screen.key(0,0xff0d)
        self.assertEqual(len(provider.calls),3)

    def test_revocation_and_frame_validation(self):
        provider,screen=self.screen()
        screen.authorized=lambda:False
        with self.assertRaises(Error):screen.capture()
        self.assertEqual(provider.calls,[])
        with self.assertRaises(Error):dimensions(b'not png')
        self.assertEqual(compact_length(128),b'\x80\x01')
        self.assertEqual(compact_length(16384),b'\x80\x80\x01')
        with self.assertRaises(Error):compact_length(4194304)

    def test_ios_unknown_scale_refuses_input(self):
        provider,screen=self.screen('ios')
        with patch.object(provider,'idb',return_value='{}'):
            with self.assertRaises(Error):screen.point(300,600)
        self.assertEqual(provider.calls,[])

    def test_ios_gesture_endpoints_share_one_scale_observation(self):
        for scroll in (False,True):
            with self.subTest(scroll=scroll):
                provider,screen=self.screen('ios')
                with patch.object(provider,'idb',side_effect=[
                    json.dumps({'screen_dimensions':{'density':2}}),
                    json.dumps({'screen_dimensions':{'density':4}})]) as describe:
                    if scroll:screen.pointer(8,200,400)
                    else:screen.pointer(1,200,400);screen.pointer(0,400,800)
                describe.assert_called_once()
                args=provider.calls[-1]['arguments']
                expected=(100,200,100,300) if scroll else (100,200,200,400)
                self.assertEqual((args['x'],args['y'],args['toX'],args['toY']),expected)

    def test_invalid_ios_scales_refuse_tap_drag_and_scroll_before_native_dispatch(self):
        for density in (True,False,None,'3',0,-1,float('nan'),float('inf'),10**400,1e-320):
            for gesture in ('tap','drag','scroll'):
                with self.subTest(density=density,gesture=gesture):
                    provider,screen=self.screen('ios')
                    with patch.object(provider,'idb',return_value=json.dumps({'screen_dimensions':{'density':density}})):
                        with self.assertRaises(Error):
                            if gesture=='scroll':screen.pointer(8,200,400)
                            else:
                                screen.pointer(1,200,400)
                                screen.pointer(0,400 if gesture=='drag' else 200,800 if gesture=='drag' else 400)
                    self.assertEqual(provider.calls,[])
                    self.assertIsNone(screen.pressed)
