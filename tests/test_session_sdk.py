import json
import socket
import threading
import time
import uuid
from urllib.parse import urlsplit
from unittest.mock import patch

from wsproto import ConnectionType,WSConnection
from wsproto.events import AcceptConnection,BytesMessage,Ping,Pong,Request

from canaveral.model import Error
from canaveral.sdk import LeaseClient
from canaveral.session_broker import Peer
from test_access_sessions import AccessFixture
from test_session_broker import Endpoint


class SessionSDKTests(AccessFixture):
    def host_connection(self,session):
        origin=urlsplit(self.upstream);sock=socket.create_connection((origin.hostname,origin.port),timeout=3)
        self.addCleanup(sock.close);ws=WSConnection(ConnectionType.CLIENT)
        path='/v1/hosts/'+self.host+'/sessions/'+session['id']+'/'+session['generation']
        sock.sendall(ws.send(Request(host=origin.netloc,target=path,subprotocols=['canaveral-session-v1'],extra_headers=[(b'authorization',('Bearer '+self.host_token).encode())])))
        host=Endpoint(sock,ws);self.assertIsInstance(host.next(),AcceptConnection);return host

    def test_scoped_sdk_session_controls_bytes_close_and_no_replay(self):
        self.ready();sdk=LeaseClient(self.upstream,self.lease['id'],self.token)
        request=str(uuid.uuid4());session=sdk.create_session(request,'primary','pty')
        self.assertEqual(sdk.create_session(request,'primary','pty'),session)
        self.assertEqual(sdk.session(session['id'])['state'],'pending')
        host=self.host_connection(session)
        with sdk.connect_session(session) as consumer:
            self.assertEqual(host.message()['type'],'ready')
            command={'action':'shell-write','arguments':{'text':'printf SDK\n'}}
            consumer.send_control(command);self.assertEqual(host.message(),command)
            host.send(BytesMessage(data=b'SDK\r\n'));self.assertEqual(consumer.receive(),b'SDK\r\n')
            with self.assertRaises(Error):consumer.send_bytes(b'x'*65537)
            with self.assertRaises(Error):consumer.send_bytes(memoryview(b'x'*65540).cast('I'))
            with self.assertRaises(Error):consumer.send_control({'text':'x'*17000})
            self.assertEqual(sdk.close_session(session['id'])['state'],'closed')
            with self.assertRaises(Error):consumer.receive(timeout=2)
        self.assertEqual(sdk.session(session['id'])['state'],'closed')
        with self.assertRaises(Error):sdk.connect_session(session)

    def test_sdk_answers_ping_while_application_is_not_reading(self):
        self.ready();sdk=LeaseClient(self.upstream,self.lease['id'],self.token)
        session=sdk.create_session(str(uuid.uuid4()),'primary','upload')
        host=self.host_connection(session);answered=threading.Event()
        original_send=Peer.send;original_receive=Peer.receive
        def send(peer,event):
            original_send(peer,event)
            if getattr(event,'data',None) and isinstance(event.data,str) and '"type": "ready"' in event.data:
                original_send(peer,Ping(payload=b'sdk-idle-proof'))
        def receive(peer):
            events=original_receive(peer)
            if any(isinstance(event,Pong) and event.payload==b'sdk-idle-proof' for event in events):answered.set()
            return events
        with patch.object(Peer,'send',send),patch.object(Peer,'receive',receive):
            with sdk.connect_session(session) as consumer:
                # The host endpoint deliberately does not consume its ready or
                # ping here. Only the SDK background reader can answer this.
                self.assertTrue(answered.wait(2))
                consumer.send_bytes(b'upload-data')
                self.assertEqual(host.message()['type'],'ready')
                self.assertEqual(host.message(),b'upload-data')
