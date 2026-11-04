import socket
import threading
import time
import uuid
import unittest
from email.parser import Parser
from types import SimpleNamespace
from unittest.mock import Mock

from canaveral.dashboard import server
from canaveral.desktop_socket import relay
from canaveral.model import Error
from test_dashboard import DashboardFixture

try:
    from wsproto import WSConnection, ConnectionType
    from wsproto.events import Request, AcceptConnection, BytesMessage, CloseConnection
except ImportError:
    WSConnection = None


class DesktopSocketTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.allowed=True
        def connector(machine,check_only=False):
            if check_only:return self.allowed
            left,right=socket.socketpair()
            def echo():
                try:
                    while True:
                        data=right.recv(65536)
                        if not data:return
                        right.sendall(data)
                finally:right.close()
            threading.Thread(target=echo,daemon=True).start()
            return left
        service=server(('127.0.0.1',0),self.upstream,bootstrap_token=self.admin,desktop_connector=connector)
        self.start(service)
        self.url='http://127.0.0.1:'+str(service.server_port)
        status,headers,_=self.fetch('/api/v1/auth/setup',{'username':'desktop-test','password':'fixture-password-long-enough'},headers={'Origin':self.url})
        self.assertEqual(status,200)
        self.cookie=headers['Set-Cookie'].split(';')[0]
        self.port=service.server_port

    def handshake(self,origin,cookie):
        sock=socket.create_connection(('127.0.0.1',self.port));sock.settimeout(3)
        self.addCleanup(sock.close)
        ws=WSConnection(ConnectionType.CLIENT)
        sock.sendall(ws.send(Request(host='127.0.0.1:'+str(self.port),target='/api/v1/machines/'+str(uuid.uuid4())+'/desktop',
            extra_headers=[(b'origin',origin.encode()),(b'cookie',cookie.encode())])))
        return sock,ws

    def test_desktop_rejects_cross_origin_and_missing_sessions(self):
        if WSConnection is None:self.skipTest('Install project dependencies for WebSocket tests')
        sock,_=self.handshake('https://other.example',self.cookie)
        self.assertIn(b'403',sock.recv(4096).split(b'\r\n')[0])
        sock,_=self.handshake(self.url,'')
        self.assertIn(b'401',sock.recv(4096).split(b'\r\n')[0])

    def test_binary_relay_and_live_session_revocation(self):
        if WSConnection is None:self.skipTest('Install project dependencies for WebSocket tests')
        sock,ws=self.handshake(self.url,self.cookie)
        ws.receive_data(sock.recv(4096))
        self.assertTrue(any(isinstance(e,AcceptConnection) for e in ws.events()))
        payload=b'RFB-stream-binary\x00\xff'
        sock.sendall(ws.send(BytesMessage(data=payload)))
        ws.receive_data(sock.recv(4096))
        self.assertEqual(b''.join(e.data for e in ws.events() if isinstance(e,BytesMessage)),payload)
        self.allowed=False
        ws.receive_data(sock.recv(4096))
        self.assertTrue(any(isinstance(e,CloseConnection) for e in ws.events()))

    def test_many_screens_leave_short_http_requests_available(self):
        if WSConnection is None:self.skipTest('Install project dependencies for WebSocket tests')
        connections=[]
        try:
            for _ in range(40):
                sock,ws=self.handshake(self.url,self.cookie);connections.append((sock,ws))
                ws.receive_data(sock.recv(4096))
                self.assertTrue(any(isinstance(e,AcceptConnection) for e in ws.events()))
            status,_,_=self.fetch('/api/v1/hosts',headers={'Cookie':self.cookie})
            self.assertEqual(status,200)
            for sock,ws in (connections[0],connections[-1]):
                sock.sendall(ws.send(BytesMessage(data=b'still-connected')))
                ws.receive_data(sock.recv(4096))
                self.assertEqual(b''.join(e.data for e in ws.events() if isinstance(e,BytesMessage)),b'still-connected')
        finally:
            for sock,_ in connections:sock.close()


class DesktopRelayCleanupTests(unittest.TestCase):
    def handler(self):
        if WSConnection is None:self.skipTest('Install project dependencies for WebSocket tests')
        ws=WSConnection(ConnectionType.CLIENT)
        raw=ws.send(Request(host='fixture',target='/desktop')).decode('latin1')
        headers=Parser().parsestr(raw.split('\r\n',1)[1])
        return SimpleNamespace(path='/desktop',headers=headers,connection=Mock())

    def test_invalid_handshake_closes_provider_once(self):
        handler=self.handler();handler.headers.replace_header('Sec-WebSocket-Version','12');remote=Mock()
        with self.assertRaises(Error):relay(handler,remote,lambda:True)
        remote.close.assert_called_once();remote.run_display.assert_not_called()

    def test_disconnect_during_upgrade_closes_provider_once(self):
        handler=self.handler();handler.connection.sendall.side_effect=ConnectionResetError('Fixture disconnect');remote=Mock()
        with self.assertRaises(OSError):relay(handler,remote,lambda:True)
        remote.close.assert_called_once();remote.run_display.assert_not_called()

    def test_provider_stream_failure_closes_channel_and_provider(self):
        handler=self.handler();remote=Mock();remote.run_display.side_effect=Error('Fixture stream failure')
        relay(handler,remote,lambda:True)
        remote.close.assert_called_once();handler.connection.shutdown.assert_called_once()
