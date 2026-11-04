import base64
import json
import socket
import threading
import uuid

from canaveral.dashboard import server
from test_dashboard import DashboardFixture
from wsproto import WSConnection, ConnectionType
from wsproto.events import Request, AcceptConnection, TextMessage, BytesMessage, CloseConnection


class ShellSocketTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.allowed=True;self.inputs=[];self.output=b''
        def connector(machine,request=None,check_only=False):
            if check_only:return self.allowed
            if request['action']=='shell-write':
                self.inputs.append(request['arguments']['text'])
                self.output+=request['arguments']['text'].encode()
            return {'data':base64.b64encode(self.output[request['arguments'].get('offset',len(self.output)):]).decode(),
                    'offset':len(self.output),'exited':False}
        service=server(('127.0.0.1',0),self.upstream,bootstrap_token=self.admin,shell_connector=connector)
        self.start(service);self.port=service.server_port;self.url='http://127.0.0.1:'+str(self.port)
        status,headers,_=self.fetch('/api/v1/auth/setup',{'username':'terminal-test','password':'fixture-password-long-enough'},headers={'Origin':self.url})
        self.assertEqual(status,200);self.cookie=headers['Set-Cookie'].split(';')[0]
    def connect(self,origin=None):
        sock=socket.create_connection(('127.0.0.1',self.port));sock.settimeout(3);self.addCleanup(sock.close)
        ws=WSConnection(ConnectionType.CLIENT)
        ws_request=Request(host='127.0.0.1:'+str(self.port),target='/api/v1/machines/'+str(uuid.uuid4())+'/shells/'+str(uuid.uuid4())+'/stream',
            extra_headers=[(b'origin',(origin or self.url).encode()),(b'cookie',self.cookie.encode())])
        sock.sendall(ws.send(ws_request));return sock,ws
    def test_direct_input_output_and_connection_revocation(self):
        sock,ws=self.connect();ws.receive_data(sock.recv(4096))
        self.assertTrue(any(isinstance(e,AcceptConnection) for e in ws.events()))
        sock.sendall(ws.send(TextMessage(data=json.dumps({'action':'shell-write','arguments':{'text':'live input'}}))))
        output=b''
        while not output:
            ws.receive_data(sock.recv(4096));output+=b''.join(e.data for e in ws.events() if isinstance(e,BytesMessage))
        self.assertEqual(output,b'live input');self.assertEqual(self.inputs,['live input'])
        self.allowed=False
        ws.receive_data(sock.recv(4096))
        self.assertTrue(any(isinstance(e,CloseConnection) for e in ws.events()))
    def test_many_sessions_do_not_consume_the_http_request_pool(self):
        connections=[]
        for _ in range(40):
            sock,ws=self.connect();connections.append(sock);ws.receive_data(sock.recv(4096))
            self.assertTrue(any(isinstance(e,AcceptConnection) for e in ws.events()))
        status,_,_=self.fetch('/api/v1/hosts',headers={'Cookie':self.cookie})
        self.assertEqual(status,200)
        for sock in connections:sock.close()
    def test_cross_origin_is_rejected(self):
        sock,_=self.connect('https://other.example')
        self.assertIn(b'403',sock.recv(4096).split(b'\r\n')[0])
