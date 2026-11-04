"""Same-origin authenticated WebSocket/RFB bridge for locally attached guest runners."""
import select
import socket
import time
import json
import threading

from .model import Error


class DisplayChannel:
    """Bounded local gateway channel with serialized WebSocket framing."""
    def __init__(self,connection,ws):
        self.connection=connection;self.ws=ws;self.lock=threading.Lock()
        self.pending=bytearray();self.text=None;self.closed=False;self.ready=[]

    def send(self,event):
        with self.lock:
            if self.closed:raise EOFError()
            self.connection.sendall(self.ws.send(event))

    def send_bytes(self,data):
        from wsproto.events import BytesMessage
        if len(data)>65536:raise Error('Display output exceeds its bounded frame.',400)
        self.send(BytesMessage(data=data))

    def send_control(self,value):
        from wsproto.events import TextMessage
        self.send(TextMessage(data=json.dumps(value)))

    def close(self):
        self.closed=True
        try:self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:pass

    def receive(self,timeout):
        from wsproto.events import BytesMessage,TextMessage,Ping,CloseConnection
        if self.closed:raise EOFError()
        if self.ready:return self.ready.pop(0)
        if not select.select([self.connection],[],[],timeout)[0]:return None
        data=self.connection.recv(4096)
        if not data:raise EOFError()
        # Parsing and encoding share one protocol state. Never hold this lock
        # while waiting for input; framebuffer output must stay independent.
        with self.lock:
            self.ws.receive_data(data);events=list(self.ws.events())
        result=[]
        for event in events:
            if isinstance(event,(BytesMessage,TextMessage)):
                text=isinstance(event,TextMessage)
                if self.text is not None and self.text!=text:raise Error('Mixed display message fragments.',400)
                self.text=text
                self.pending.extend(event.data.encode('utf-8') if text else event.data)
                if len(self.pending)>(16384 if text else 65536):raise Error('Display message exceeds its bounded frame.',400)
                if event.message_finished:
                    value=bytes(self.pending);self.pending.clear();self.text=None
                    if text:
                        try:value=json.loads(value)
                        except (ValueError,UnicodeError):raise Error('Invalid display control.',400)
                        if not isinstance(value,dict):raise Error('Invalid display control.',400)
                    result.append(value)
            elif isinstance(event,Ping):self.send(event.response())
            elif isinstance(event,CloseConnection):raise EOFError()
        self.ready.extend(result)
        return self.ready.pop(0) if self.ready else None


def relay(handler, remote, authorized):
    try:return _relay(handler,remote,authorized)
    finally:remote.close()


def _relay(handler, remote, authorized):
    from wsproto import WSConnection, ConnectionType
    from wsproto.events import Request, AcceptConnection, BytesMessage, TextMessage, Ping, CloseConnection
    from wsproto.utilities import LocalProtocolError, RemoteProtocolError
    ws=WSConnection(ConnectionType.SERVER)
    # Feed the already parsed handshake into the protocol engine; it validates RFC6455.
    raw=('GET '+handler.path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in handler.headers.items())+'\r\n').encode('latin1')
    try:
        ws.receive_data(raw)
    except RemoteProtocolError:
        raise Error('Invalid desktop WebSocket handshake.', 400)
    request=next(iter(ws.events()),None)
    if not isinstance(request,Request):raise Error('Invalid desktop WebSocket handshake.',400)
    handler.connection.sendall(ws.send(AcceptConnection(subprotocol='binary' if 'binary' in request.subprotocols else None)))
    handler.close_connection=True
    handler.connection.settimeout(10)
    if hasattr(remote,'run_display'):
        channel=DisplayChannel(handler.connection,ws)
        try:remote.run_display(channel)
        except Exception:pass
        finally:channel.close()
        return
    remote.settimeout(10)
    checked=time.monotonic()
    message_size=0
    try:
        while True:
            if time.monotonic()-checked>1:
                if not authorized():break
                checked=time.monotonic()
            ready,_,_=select.select([handler.connection,remote],[],[],.25)
            if remote in ready:
                data=remote.recv(65536)
                if not data:break
                handler.connection.sendall(ws.send(BytesMessage(data=data)))
            if handler.connection in ready:
                data=handler.connection.recv(65536)
                if not data:break
                ws.receive_data(data)
                for event in ws.events():
                    if isinstance(event,BytesMessage):
                        message_size+=len(event.data)
                        if message_size>1048576:raise Error('Desktop input exceeds the message limit.')
                        remote.sendall(event.data)
                        if event.message_finished:message_size=0
                    elif isinstance(event,Ping):handler.connection.sendall(ws.send(event.response()))
                    elif isinstance(event,CloseConnection):return
                    elif isinstance(event,TextMessage):raise Error('Desktop connection requires binary messages.')
    except (OSError,Error,LocalProtocolError,RemoteProtocolError):pass
    finally:
        try:handler.connection.sendall(ws.send(CloseConnection(code=1000,reason='Desktop connection ended')))
        except Exception:pass
