"""Authenticated outbound WebSocket client with bounded messages and no replay."""
import collections
import json
import queue
import select
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

from wsproto import ConnectionType,WSConnection
from wsproto.events import AcceptConnection,BytesMessage,CloseConnection,Ping,RejectConnection,Request,TextMessage

from .model import Error
from .session_errors import worker_error


class SessionConnection:
    def __init__(self,client,path,authorized=lambda:True):
        origin=urlsplit(client.url)
        if not path.startswith('/v1/') or '?' in path or '#' in path:raise Error('Invalid session attachment path.',400)
        self.authorized=authorized;self.closed=threading.Event();self.ws=WSConnection(ConnectionType.CLIENT)
        self.events=collections.deque();self.send_lock=threading.Lock();self.ws_lock=threading.Lock()
        self.messages=queue.Queue(maxsize=1);self.failure=None
        self.worker_error=None
        parts=path.split('/')
        self.session_id=parts[5] if len(parts)==7 and parts[2]=='leases' and parts[4]=='sessions' else None
        self.inbox_space=threading.Event();self.inbox_space.set()
        self.text='';self.binary=bytearray();self.text_size=0
        self.socket=None
        try:
            self.socket=socket.create_connection((origin.hostname,origin.port or (443 if origin.scheme=='https' else 80)),timeout=10)
            if origin.scheme=='https':
                context=getattr(client,'ssl_context',None) or ssl.create_default_context()
                self.socket=context.wrap_socket(self.socket,server_hostname=origin.hostname)
            self.socket.settimeout(.25)
            self._send(Request(host=origin.netloc,target=path,subprotocols=['canaveral-session-v1'],extra_headers=[(b'authorization',('Bearer '+client.token).encode())]))
            response=self._next(20)
            if isinstance(response,RejectConnection):raise Error('Session upgrade rejected.',response.status_code)
            if not isinstance(response,AcceptConnection) or response.subprotocol!='canaveral-session-v1':raise Error('Session upgrade was not accepted.',503)
            self.reader=threading.Thread(target=self._read,daemon=True);self.reader.start()
        except Error:
            self.close();raise
        except Exception as error:
            self.close();raise Error('Session connection failed; no input is automatically replayed.',503) from error

    def _check(self):
        if self.closed.is_set() or not self.authorized():
            raise Error('Session authorization or connection ended.',410,code='session_disconnected')

    def _check_write(self):
        if getattr(self,'worker_error',None):raise self.worker_error
        self._check()

    def _send(self,event):
        with self.send_lock:
            self._check_write()
            with self.ws_lock:data=self.ws.send(event)
            pending=memoryview(data);deadline=time.monotonic()+30
            while pending:
                self._check_write()
                if time.monotonic()>=deadline:raise Error('Session output remained blocked; input may have been delivered.',408)
                try:written=self.socket.send(pending)
                except socket.timeout:continue
                except OSError as error:raise Error('Session output failed; input may have been delivered. Do not replay automatically.',503) from error
                if not written:raise Error('Session disconnected during output.',410,code='session_disconnected')
                pending=pending[written:]

    def _next(self,timeout):
        deadline=time.monotonic()+timeout
        while True:
            self._check()
            if self.events:return self.events.popleft()
            remaining=deadline-time.monotonic()
            if remaining<=0:return None
            buffered=isinstance(self.socket,ssl.SSLSocket) and self.socket.pending()
            if not buffered and not select.select([self.socket],[],[],min(.25,remaining))[0]:continue
            try:data=self.socket.recv(4096)
            except socket.timeout:continue
            if not data:raise Error('Session disconnected; unacknowledged input may have been delivered.',410,code='session_disconnected')
            with self.ws_lock:
                self.ws.receive_data(data);self.events.extend(self.ws.events())

    def send_control(self,value):
        if not isinstance(value,dict):raise Error('Session control must be an object.',400)
        data=json.dumps(value,allow_nan=False)
        if len(data.encode('utf8'))>16384:raise Error('Session control exceeds 16 KiB.',400)
        self._send(TextMessage(data=data))

    def send_bytes(self,data):
        if not isinstance(data,(bytes,bytearray,memoryview)) or (data.nbytes if isinstance(data,memoryview) else len(data))>65536:raise Error('Session binary messages must fit 64 KiB.',400)
        self._send(BytesMessage(data=bytes(data)))

    def _read_message(self,timeout=30):
        deadline=time.monotonic()+timeout
        try:
            while True:
                event=self._next(max(0,deadline-time.monotonic()))
                if event is None:return None
                if isinstance(event,Ping):self._send(event.response());continue
                if isinstance(event,CloseConnection):raise Error('Session disconnected; open a new session without replaying input.',410,code='session_disconnected')
                if isinstance(event,TextMessage):
                    self.text_size+=len(event.data.encode('utf8'))
                    if self.text_size>16384:raise Error('Session control exceeds 16 KiB.',400)
                    self.text+=event.data
                    if event.message_finished:
                        value=json.loads(self.text,parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Non-finite value')))
                        self.text='';self.text_size=0
                        if not isinstance(value,dict):raise Error('Invalid session control.',400)
                        return value
                if isinstance(event,BytesMessage):
                    if len(self.binary)+len(event.data)>65536:raise Error('Session binary message exceeds 64 KiB.',400)
                    self.binary.extend(event.data)
                    if event.message_finished:
                        value=bytes(self.binary);self.binary.clear();return value
        except Error:
            self.close();raise
        except Exception as error:
            self.close();raise Error('Session protocol or connection failed; input is not replayed.',503) from error

    def _read(self):
        try:
            while not self.closed.is_set():
                # Do not read ahead behind a full queue. One assembled message
                # plus its conversion buffer stays within 128 KiB per direction.
                if not self.inbox_space.wait(.25):continue
                if self.closed.is_set():break
                self.inbox_space.clear()
                message=self._read_message(.5)
                if message is not None:
                    # Keep raw receive() behavior, while stopping writes after a
                    # consumer has already received a worker refusal/failure.
                    if self.session_id:self.worker_error=worker_error(message,self.session_id)
                    self.messages.put_nowait(message)
                else:self.inbox_space.set()
        except Error as error:self.failure=error;self.close()

    def receive(self,timeout=30):
        deadline=time.monotonic()+timeout
        while True:
            try:message=self.messages.get_nowait()
            except queue.Empty:message=None
            if message is not None:
                self.inbox_space.set()
                if not self.authorized():raise Error('Session authorization ended.',410,code='session_disconnected')
                return message
            if self.failure:raise self.failure
            self._check()
            remaining=deadline-time.monotonic()
            if remaining<=0:return None
            try:message=self.messages.get(timeout=min(.25,remaining))
            except queue.Empty:continue
            self.inbox_space.set()
            if not self.authorized():raise Error('Session authorization ended.',410,code='session_disconnected')
            return message

    def close(self):
        self.closed.set()
        self.inbox_space.set()
        if self.socket is not None:
            try:self.socket.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            self.socket.close()

    def __enter__(self):return self
    def __exit__(self,*args):self.close()
