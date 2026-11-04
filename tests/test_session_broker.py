import collections
import http.client
import json
import socket
import threading
import time
import tracemalloc
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit

from wsproto import ConnectionType,WSConnection
from wsproto.events import AcceptConnection,BytesMessage,CloseConnection,Ping,Request,TextMessage

from canaveral.client import Client
from test_access_sessions import AccessFixture


class Endpoint:
    def __init__(self,sock,ws):self.socket=sock;self.ws=ws;self.events=collections.deque()
    def send(self,event):self.socket.sendall(self.ws.send(event))
    def next(self,timeout=3):
        self.socket.settimeout(timeout)
        while not self.events:
            data=self.socket.recv(4096)
            if not data:raise EOFError()
            self.ws.receive_data(data);self.events.extend(self.ws.events())
        event=self.events.popleft()
        if isinstance(event,Ping):self.send(event.response());return self.next(timeout)
        return event
    def message(self,timeout=3):
        text='';binary=bytearray()
        while True:
            event=self.next(timeout)
            if isinstance(event,TextMessage):
                text+=event.data
                if event.message_finished:return json.loads(text)
            elif isinstance(event,BytesMessage):
                binary.extend(event.data)
                if event.message_finished:return bytes(binary)
            elif isinstance(event,CloseConnection):raise EOFError()
    def close(self):
        try:self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.socket.close()


class SessionBrokerTests(AccessFixture):
    def connect(self,session,side='consumer',owner=None,token=None,generation=None,rejected=None):
        origin=urlsplit(self.upstream)
        sock=socket.create_connection((origin.hostname,origin.port),timeout=3);self.addCleanup(sock.close)
        role='hosts' if side=='host' else 'leases'
        owner=owner or (self.host if side=='host' else self.lease['id'])
        token=token or (self.host_token if side=='host' else self.token)
        path='/v1/'+role+'/'+owner+'/sessions/'+session['id']+'/'+(generation or session['generation'])
        ws=WSConnection(ConnectionType.CLIENT)
        sock.sendall(ws.send(Request(host=origin.netloc,target=path,subprotocols=['canaveral-session-v1'],extra_headers=[(b'authorization',('Bearer '+token).encode())])))
        if rejected:
            self.assertIn((' '+str(rejected)+' ').encode(),sock.recv(4096).split(b'\r\n')[0]);sock.close();return
        endpoint=Endpoint(sock,ws)
        self.assertIsInstance(endpoint.next(),AcceptConnection)
        return endpoint

    def pair(self,capability='pty'):
        session=self.create(capability=capability)
        consumer=self.connect(session);host=self.connect(session,'host')
        for endpoint in (consumer,host):
            ready=endpoint.message();self.assertEqual(ready['type'],'ready');self.assertEqual(ready['generation'],session['generation'])
        return session,consumer,host

    def ended(self,endpoint):
        try:
            while True:endpoint.message(timeout=3)
        except (EOFError,ConnectionResetError):return
        self.fail('Session did not close')

    def test_outbound_pair_ordered_terminal_data_and_disconnection(self):
        self.ready();session,consumer,host=self.pair()
        command={'action':'shell-write','arguments':{'text':'printf hello\n'}}
        consumer.send(TextMessage(data=json.dumps(command)))
        self.assertEqual(host.message(),command)
        host.send(BytesMessage(data=b'hello\r\n'))
        self.assertEqual(consumer.message(),b'hello\r\n')
        consumer.close();self.ended(host)
        until=time.monotonic()+3
        while time.monotonic()<until:
            state=self.client.request('GET',self.path+'/'+session['id'])['state']
            if state=='disconnected':break
            time.sleep(.02)
        self.assertEqual(state,'disconnected')
        self.connect(session,'host',rejected=410)

    def test_wrong_host_generation_duplicate_rotation_and_exact_expiry(self):
        self.ready();session=self.create()
        self.connect(session,'host',owner=self.other_host,token=self.other_host_token,rejected=404)
        self.connect(session,generation=str(uuid.uuid4()),rejected=409)
        consumer=self.connect(session);self.connect(session,rejected=409)
        host=self.connect(session,'host');consumer.message();host.message()
        new_token=self.store.lease_credential(self.lease['id'],self.a['credential'])['credential']
        self.ended(consumer);self.ended(host)
        self.token=new_token;self.client=Client(self.upstream,new_token)
        self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'revoked')
        session,consumer,host=self.pair()
        self.assertTrue(self.store.access_session_frame_authorized(session['id'],session['generation']))
        self.now+=120
        self.assertFalse(self.store.access_session_frame_authorized(session['id'],session['generation']))
        try:consumer.send(TextMessage(data=json.dumps({'action':'shell-write','arguments':{'text':'late'}})))
        except OSError:pass
        self.ended(host);self.ended(consumer)

    def test_bounded_messages_and_parallel_session_isolation(self):
        self.ready();bad,consumer,host=self.pair();good,other,runner=self.pair('upload')
        consumer.send(TextMessage(data=json.dumps({'text':'x'*17000})))
        self.ended(host);self.ended(consumer)
        block=b'proof'*12000
        for _ in range(20):
            other.send(BytesMessage(data=block));self.assertEqual(runner.message(),block)
        other.send(BytesMessage(data=b'x'*65537))
        self.ended(other);self.ended(runner)
        self.assertEqual(self.client.request('GET',self.path+'/'+good['id'])['state'],'disconnected')

    def test_many_pairs_leave_http_and_renewal_responsive(self):
        self.ready();endpoints=[]
        for _ in range(36):
            _,consumer,host=self.pair();endpoints.extend((consumer,host))
        self.assertEqual(Client(self.upstream,'').request('GET','/healthz'),{'ok':True})
        lease=self.store.get_lease(self.lease['id'],self.token)
        renewed=self.client.request('POST','/v1/leases/'+lease['id']+'/renew',{'id':str(uuid.uuid4()),'expectedRevision':lease['revision'],'ttlSeconds':120})
        self.assertEqual(renewed['lease']['state'],'ready')
        for endpoint in endpoints:endpoint.close()

    def test_slow_reader_applies_backpressure_without_large_application_buffers(self):
        self.ready();session,consumer,host=self.pair('upload')
        stopped=threading.Event();complete=threading.Event();block=b'x'*65536
        def produce():
            try:
                for _ in range(1024):consumer.send(BytesMessage(data=block))
                complete.set()
            except OSError:pass
            finally:stopped.set()
        tracemalloc.start()
        worker=threading.Thread(target=produce,daemon=True);worker.start()
        try:
            self.assertFalse(stopped.wait(.6));self.assertFalse(complete.is_set())
            _,peak=tracemalloc.get_traced_memory()
            self.assertLess(peak,4*1024*1024)
            self.assertEqual(Client(self.upstream,'').request('GET','/healthz'),{'ok':True})
            self.client.request('POST',self.path+'/'+session['id']+'/close',{})
            self.assertTrue(stopped.wait(3));self.ended(host)
        finally:
            consumer.close();host.close();worker.join(3);tracemalloc.stop()

    def test_server_shutdown_closes_both_peers_and_finishes_the_receipt(self):
        self.ready();session,consumer,host=self.pair()
        self.api.shutdown()
        with patch('canaveral.session_broker.logging.error') as error:
            self.api.server_close()
            error.assert_not_called()
        self.ended(consumer);self.ended(host)
        self.assertEqual(self.store.get_access_session(self.lease['id'],session['id'],self.token)['state'],'disconnected')

    def test_invalid_upgrades_do_not_claim_peers_or_bypass_browser_boundary(self):
        self.ready();session=self.create();origin=urlsplit(self.upstream)
        path='/v1/leases/'+self.lease['id']+'/sessions/'+session['id']+'/'+session['generation']
        headers=['Host: '+origin.netloc,'Authorization: Bearer '+self.token,'Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version: 13','Sec-WebSocket-Protocol: canaveral-session-v1']
        for extra,target,expected in [(['Origin: https://untrusted.example'],path,403),(['Authorization: Bearer different'],path,400),(['Host: different.example'],path,400),([],path+'?credential=forbidden',400)]:
            with socket.create_connection((origin.hostname,origin.port),timeout=3) as sock:
                sock.sendall(('GET '+target+' HTTP/1.1\r\n'+'\r\n'.join(headers+extra)+'\r\n\r\n').encode())
                self.assertIn((' '+str(expected)+' ').encode(),sock.recv(4096).split(b'\r\n')[0])
            self.assertEqual(self.client.request('GET',self.path+'/'+session['id'])['state'],'pending')
        consumer=self.connect(session);host=self.connect(session,'host');consumer.message();host.message()
        consumer.send(BytesMessage(data=b'PTY input must be structured'))
        with self.assertRaises((EOFError,ConnectionResetError)):host.message()

    def test_worker_exhaustion_returns_retryable_error_without_losing_capacity(self):
        origin=urlsplit(self.upstream)
        with patch('threading.Thread.start',side_effect=RuntimeError('fixture worker unavailable')):
            connection=http.client.HTTPConnection(origin.hostname,origin.port,timeout=3)
            try:
                connection.request('GET','/healthz');response=connection.getresponse()
                self.assertEqual(response.status,503)
                result=json.loads(response.read());self.assertTrue(result['retryable'])
                self.assertEqual(result['code'],'service_unavailable')
            finally:connection.close()
        self.assertEqual(Client(self.upstream,'').request('GET','/healthz'),{'ok':True})

    def test_application_revocation_isolates_two_consumers_and_two_runners(self):
        self.ready();_,consumer,host=self.pair()
        lease=self.store.acquire_lease(self.b['credential'],{'id':str(uuid.uuid4()),'templateId':'android-phone','templateRevision':'1','arch':'arm64','ttlSeconds':120})
        machine=lease['members'][0]['machineId']
        self.store.heartbeat(self.other_host,self.other_host_token,{'offer':self.offer,'reports':{machine:{'state':'running'}}})
        token=self.store.lease_credential(lease['id'],self.b['credential'])['credential']
        session=self.store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':'pty'})
        other=self.connect(session,owner=lease['id'],token=token)
        runner=self.connect(session,'host',owner=self.other_host,token=self.other_host_token)
        other.message();runner.message()
        self.store.consumer_credential(self.a['id'],revoke=True)
        self.ended(consumer);self.ended(host)
        value={'action':'shell-write','arguments':{'text':'owned by another application'}}
        other.send(TextMessage(data=json.dumps(value)));self.assertEqual(runner.message(),value)
        runner.send(BytesMessage(data=b'other application remains connected'))
        self.assertEqual(other.message(),b'other application remains connected')
