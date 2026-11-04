"""Bounded WebSocket pairs for outbound runner-to-consumer access.

This module relays capability payloads; provider execution stays on the runner.
No payload or connection credential is written to session metadata.
"""
import json
import logging
import socket
import threading
import time

from wsproto import ConnectionType, WSConnection
from wsproto.events import AcceptConnection, BytesMessage, CloseConnection, Ping, Pong, Request, TextMessage

from .model import Error


PROTOCOL='canaveral-session-v1'


class Peer:
    def __init__(self,handler):
        self.socket=handler.connection
        self.ws=WSConnection(ConnectionType.SERVER)
        self.ws_lock=threading.Lock();self.send_lock=threading.Lock()
        raw=('GET '+handler.path+' HTTP/1.1\r\n'+''.join(key+': '+value+'\r\n' for key,value in handler.headers.items())+'\r\n').encode('latin1')
        try:
            self.ws.receive_data(raw)
            request=next(iter(self.ws.events()),None)
        except Exception as error:raise Error('Invalid session WebSocket upgrade.',400) from error
        if not isinstance(request,Request) or PROTOCOL not in request.subprotocols:
            raise Error('Use the canaveral-session-v1 WebSocket protocol.',400)
        self.socket.settimeout(.5)

    def send(self,event):
        with self.send_lock:
            with self.ws_lock:data=self.ws.send(event)
            remaining=memoryview(data);deadline=time.monotonic()+30
            while remaining:
                if time.monotonic()>=deadline:raise Error('Session output remained blocked.',408)
                try:written=self.socket.send(remaining)
                except socket.timeout:continue
                if not written:raise OSError('Session socket closed')
                remaining=remaining[written:]

    def receive(self):
        data=self.socket.recv(4096)
        if not data:raise EOFError()
        with self.ws_lock:
            self.ws.receive_data(data)
            return list(self.ws.events())

    def close(self):
        # Authorization loss must interrupt blocked sends/reads without waiting
        # for the peer's protocol or output locks.
        try:self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.socket.close()


class Pair:
    def __init__(self,view):
        self.view=view;self.peers={};self.accepted=set()
        self.lock=threading.RLock();self.started=threading.Event();self.closed=threading.Event()
        self.receipt_claimed=False

    def close(self):
        self.closed.set()
        with self.lock:peers=list(self.peers.values())
        for peer in peers:peer.close()


class SessionBroker:
    def __init__(self,store):
        self.store=store;self.lock=threading.RLock();self.pairs={};self.stopping=threading.Event()
        self.condition=threading.Condition(self.lock);self.active=0
        self.worker=None

    def start(self):
        self.worker=threading.Thread(target=self.monitor,daemon=True);self.worker.start()

    def close(self):
        self.stopping.set()
        with self.lock:pairs=list(self.pairs.values())
        for pair in pairs:pair.close()
        if self.worker:self.worker.join(2)
        with self.condition:
            if not self.condition.wait_for(lambda:self.active==0,timeout=5):
                logging.error('Session workers remain closing; restart will fence their persisted claims.')

    def monitor(self):
        while not self.stopping.wait(.25):
            with self.lock:pairs=dict(self.pairs)
            if not pairs:continue
            try:live=self.store.access_sessions_live(set(pairs))
            except Exception:
                live=set()
                logging.error('Session authorization unavailable; closing access peers.')
            for identity,pair in pairs.items():
                if identity not in live:pair.close()

    def serve(self,handler,session_id,generation,side,owner_id,token):
        with self.condition:
            if self.stopping.is_set():raise Error('Session service is shutting down.',503)
            self.active+=1
        try:self._serve(handler,session_id,generation,side,owner_id,token)
        finally:
            with self.condition:self.active-=1;self.condition.notify_all()

    def _serve(self,handler,session_id,generation,side,owner_id,token):
        peer=Peer(handler) # Parse the upgrade before recording any attachment.
        view=self.store.attach_access_session(session_id,generation,side,owner_id,token)
        identity=(view['id'],view['generation']);pair=None;upgraded=False
        try:
            with self.lock:
                pair=self.pairs.setdefault(identity,Pair(view))
                with pair.lock:
                    if side in pair.peers or pair.closed.is_set():raise Error('Session peer cannot be replaced.',409)
                    pair.peers[side]=peer
            handler.server.promote_session(handler.connection)
            peer.send(AcceptConnection(subprotocol=PROTOCOL))
            upgraded=True;handler.close_connection=True
            with pair.lock:
                pair.accepted.add(side)
                complete=len(pair.accepted)==2
                endpoints=list(pair.peers.values())
            if complete:
                if not self.store.access_session_frame_authorized(*identity):raise Error('Session authorization ended.',410)
                # No socket send holds the pair lock: the monitor must be able
                # to interrupt a blocked write immediately on authorization loss.
                control=TextMessage(data=json.dumps({'type':'ready','sessionId':view['id'],'generation':view['generation'],'capability':view['capability']}))
                for endpoint in endpoints:endpoint.send(control)
                pair.started.set()
            self.forward(pair,peer,side)
        except Exception:
            if not upgraded:raise
        finally:
            record=True
            if pair:
                pair.close()
                with pair.lock:
                    record=not pair.receipt_claimed
                    pair.receipt_claimed=True
                with self.lock:
                    if self.pairs.get(identity) is pair:self.pairs.pop(identity,None)
            else:peer.close()
            if record:
                try:self.store.disconnect_access_session(*identity)
                except Exception:logging.error('Session disconnection receipt requires recovery.')

    def forward(self,pair,peer,side):
        binary_size=0;text='';text_size=0
        last_ping=last_pong=time.monotonic()
        while not pair.closed.is_set():
            now=time.monotonic()
            if now-last_pong>=30:raise Error('Session peer did not answer keepalive.',408)
            if now-last_ping>=10:
                peer.send(Ping(payload=b'canaveral'));last_ping=now
            try:events=peer.receive()
            except socket.timeout:continue
            for event in events:
                if isinstance(event,Ping):peer.send(event.response());continue
                if isinstance(event,Pong):last_pong=time.monotonic();continue
                if isinstance(event,CloseConnection):
                    try:peer.send(event.response())
                    except Exception:pass
                    return
                if not isinstance(event,(BytesMessage,TextMessage)):raise Error('Unsupported session message.',400)
                if isinstance(event,TextMessage):
                    text_size+=len(event.data.encode('utf8'))
                    if text_size>16384:raise Error('Session control exceeds its frame budget.',400)
                    text+=event.data
                    if not event.message_finished:continue
                    value=json.loads(text,parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Non-finite control value')))
                    if not isinstance(value,dict) or value.get('type')=='ready':raise Error('Invalid session control.',400)
                    outgoing=TextMessage(data=text);text='';text_size=0
                else:
                    if (pair.view['capability']=='pty' and side=='consumer') or (pair.view['capability']=='upload' and side=='host') or (pair.view['capability'] in ('download','accessibility') and side=='consumer'):
                        raise Error('Binary payload is not valid in this session direction.',400)
                    binary_size+=len(event.data)
                    if binary_size>65536:raise Error('Session binary message exceeds its frame budget.',400)
                    outgoing=BytesMessage(data=event.data,message_finished=event.message_finished)
                    if event.message_finished:binary_size=0
                while not pair.started.wait(.1):
                    if pair.closed.is_set():return
                if pair.closed.is_set():return
                if not self.store.access_session_frame_authorized(pair.view['id'],pair.view['generation']):
                    raise Error('Session authorization ended.',410)
                with pair.lock:other=pair.peers['consumer' if side=='host' else 'host']
                other.send(outgoing)
