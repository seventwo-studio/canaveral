"""Interactive PTY transport, independent of durable operation polling."""
import base64
import json
import select
import time
import uuid

from .devices import operation_request
from .model import Error


def relay(handler, session, control, authorized):
    from wsproto import WSConnection, ConnectionType
    from wsproto.events import Request, AcceptConnection, BytesMessage, TextMessage, Ping, CloseConnection
    from wsproto.utilities import LocalProtocolError, RemoteProtocolError
    ws=WSConnection(ConnectionType.SERVER)
    raw=('GET '+handler.path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in handler.headers.items())+'\r\n').encode('latin1')
    ws.receive_data(raw)
    if not isinstance(next(iter(ws.events()),None),Request):raise Error('Invalid terminal handshake.',400)
    handler.connection.sendall(ws.send(AcceptConnection()))
    handler.close_connection=True
    handler.connection.settimeout(10)
    offset=0
    checked=last_read=0
    pending=''
    def send(event):handler.connection.sendall(ws.send(event))
    try:
        while True:
            now=time.monotonic()
            if now-checked>=1:
                if not authorized():break
                checked=now
            readable,_,_=select.select([handler.connection],[],[],.02)
            if readable:
                data=handler.connection.recv(32768)
                if not data:break
                ws.receive_data(data)
                for event in ws.events():
                    if isinstance(event,TextMessage):
                        pending+=event.data
                        if len(pending)>20000:raise Error('Terminal control message is too large.')
                        if not event.message_finished:continue
                        value=json.loads(pending);pending=''
                        if not isinstance(value,dict) or value.get('action') not in ('shell-write','shell-resize'):
                            raise Error('Unsupported terminal input.')
                        request=operation_request({'id':str(uuid.uuid4()),'action':value['action'],
                                                   'arguments':{**value.get('arguments',{}),'session':session}})
                        control(request)
                    elif isinstance(event,Ping):send(event.response())
                    elif isinstance(event,CloseConnection):return
                    elif isinstance(event,BytesMessage):raise Error('Terminal input requires structured text messages.')
            if time.monotonic()-last_read>=.05:
                result=control({'id':str(uuid.uuid4()),'action':'shell-read','arguments':{'session':session,'offset':offset}})
                last_read=time.monotonic()
                if result.get('truncated'):send(TextMessage(data=json.dumps({'truncated':True})))
                data=base64.b64decode(result['data'],validate=True)
                if data:send(BytesMessage(data=data))
                offset=result['offset']
                if result.get('exited'):
                    send(TextMessage(data=json.dumps({'exited':True,'exitCode':result.get('exitCode')})))
                    return
    except (OSError,Error,ValueError,TypeError,KeyError,LocalProtocolError,RemoteProtocolError):
        try:send(TextMessage(data=json.dumps({'error':'Terminal connection ended. Input may have been delivered; inspect before retrying.'})))
        except Exception:pass
    finally:
        try:send(CloseConnection(code=1000,reason='Terminal connection ended'))
        except Exception:pass
