"""Shared owned RFB displays with runner-enforced input control.

Only RFB 3.8/None is accepted on the already protected provider connection.
Private VNC credentials and provider endpoints never reach the consumer.
"""
import json
import math
import select
import struct
import threading
import time
import uuid
from contextlib import contextmanager,nullcontext
from pathlib import Path

from .files import save_json
from .model import Error,identifier


INPUT_ACTIONS=frozenset(('tap','swipe','text','key','accessibility-action','launch','terminate',
                         'open-url','rotate','location','permission','install','uninstall'))


class InputDenied(Error):
    """A definite refusal before dispatch, safe to record as failed."""



class DisplayControls:
    def __init__(self,path):
        self.path=Path(path);self.lock=threading.RLock();self.endpoints=set()
        self.records=json.loads(self.path.read_text()) if self.path.exists() else {}
        for record in self.records.values():
            # Loading can precede acquisition of the agent process lock. Keep
            # recovery conservative in memory without mutating a live runner's
            # receipt merely because a second process attempted startup.
            if record['phase']=='active':record.update(phase='blocked',owner=None)

    def claim(self,machine,viewer,epoch,current):
        with self.lock:
            if epoch is not None and (not isinstance(epoch,dict) or set(epoch)!={'startedAt','identity'} or type(epoch['startedAt']) not in (float,int) or not math.isfinite(epoch['startedAt']) or not isinstance(epoch['identity'],str) or not epoch['identity']):
                raise Error('Invalid display boot identity.',409)
            if not current():return 'stale'
            record=self.records.setdefault(machine,{'phase':'idle','owner':None,'epoch':epoch})
            previous=record.get('epoch')
            if epoch and previous and epoch!=previous:
                if epoch['startedAt']<=previous['startedAt']:return 'stale'
                record.update(phase='idle',owner=None,epoch=epoch)
            if record['phase']=='blocked':return 'reset-uncertain'
            if record['phase']=='active' and record['owner']!=viewer:return 'busy'
            if record['phase']=='active':return 'owned'
            record.update(phase='active',owner=viewer,epoch=epoch)
            try:save_json(self.path,self.records)
            except Exception:
                record.update(phase='blocked',owner=None);raise
            return 'owned'

    def owns(self,machine,viewer,epoch):
        with self.lock:
            record=self.records.get(machine,{})
            return record.get('phase')=='active' and record.get('owner')==viewer and record.get('epoch')==epoch

    def release(self,machine,viewer,epoch,reset):
        with self.lock:
            if not self.owns(machine,viewer,epoch):return
            self.records[machine].update(phase='idle' if reset else 'blocked',owner=None)
            try:save_json(self.path,self.records)
            except Exception:
                self.records[machine].update(phase='blocked',owner=None);raise

    @contextmanager
    def discrete(self,machine,operation,epoch,authorized):
        operation='operation:'+identifier(operation)
        if not authorized():raise InputDenied('Input authorization ended before dispatch.',410,code='input_unavailable')
        boot=epoch()
        state=self.claim(machine,operation,boot,lambda:authorized() and epoch()==boot)
        if state!='owned':
            raise InputDenied('Input is owned by another connection.' if state=='busy' else 'Input recovery is required before dispatch.',409,code='input_'+state.replace('-','_'))
        completed=False
        try:
            if not authorized() or epoch()!=boot:
                completed=True
                raise InputDenied('Input authorization changed before dispatch.',410,code='input_unavailable')
            try:yield
            except InputDenied:
                completed=True;raise
            else:completed=True
        finally:self.release(machine,operation,boot,completed)

    def close(self):
        with self.lock:endpoints=list(self.endpoints)
        for endpoint in endpoints:endpoint.close()
        deadline=time.monotonic()+5
        for endpoint in endpoints:endpoint.finished.wait(max(0,deadline-time.monotonic()))


class ClientMessages:
    """Incremental client framing, including fragmented/coalesced input."""
    encodings={0,1,2,4,5,6,7,16,-260,-223,-239}
    def __init__(self):self.pending=bytearray()
    def feed(self,data):
        if len(self.pending)+len(data)>81920:raise Error('Display input buffer exceeded.',400)
        self.pending.extend(data)
        while self.pending:
            kind=self.pending[0]
            if kind in (0,3,4,5):size={0:20,3:10,4:8,5:6}[kind]
            elif kind==2:
                if len(self.pending)<4:return
                count=struct.unpack('!H',self.pending[2:4])[0]
                if count>256:raise Error('Too many display encodings.',400)
                size=4+count*4
            elif kind==6:
                if len(self.pending)<8:return
                count=struct.unpack('!I',self.pending[4:8])[0]
                if count>16000:raise Error('Display clipboard exceeds 16 KiB.',400)
                size=8+count
            else:raise Error('Unsupported RFB client message.',400)
            if len(self.pending)<size:return
            frame=bytes(self.pending[:size]);del self.pending[:size]
            if kind==2:
                values=struct.unpack('!'+'i'*((size-4)//4),frame[4:])
                values=[value for value in values if value in self.encodings] or [0]
                frame=struct.pack('!BBH',2,0,len(values))+struct.pack('!'+'i'*len(values),*values)
            if kind==4 and frame[1] not in (0,1):raise Error('Invalid RFB key state.',400)
            yield kind,frame


class ChannelReader:
    def __init__(self,channel,command,authorized):
        self.channel=channel;self.command=command;self.authorized=authorized;self.pending=b''
    def read(self,size):
        deadline=time.monotonic()+30
        while len(self.pending)<size:
            if not self.authorized() or time.monotonic()>=deadline:raise Error('Display handshake ended.',410)
            value=self.channel.receive(.25)
            if isinstance(value,dict):self.command(value)
            elif isinstance(value,bytes):self.pending+=value
            elif value is not None:raise Error('Invalid display payload.',400)
            if len(self.pending)>81920:raise Error('Display handshake buffer exceeded.',400)
        value,self.pending=self.pending[:size],self.pending[size:]
        return value


class DisplayEndpoint:
    def __init__(self,controls,machine,factory,authorized,epoch=lambda:None,viewer=None,action_handler=None,receipt_handler=None,resource_gate=None,context_action_handler=None):
        self.controls=controls;self.machine=identifier(machine);self.factory=factory;self.authorized_callback=authorized
        self.epoch_callback=epoch;self.epoch=None;self.viewer=viewer or str(uuid.uuid4())
        self.cancelled=threading.Event();self.finished=threading.Event()
        self.channel=None;self.remote=None;self.keys=set();self.pointer=(0,0,0)
        self.initialized=False;self.stream_ok=True
        self.action_handler=action_handler
        self.context_action_handler=context_action_handler
        self.receipt_handler=receipt_handler
        self.resource_gate=resource_gate

    def authorized(self):return not self.cancelled.is_set() and self.authorized_callback()
    def close(self):
        self.cancelled.set()
        if self.channel:self.channel.close()
    def current(self):return self.epoch_callback()==self.epoch

    def write(self,data,cleanup=False):
        if not cleanup and (not self.authorized() or not self.current()):raise Error('Display authorization ended.',410)
        try:self.remote.sendall(data)
        except Exception:
            self.stream_ok=False;raise

    def read_source(self,size):
        pending=bytearray();deadline=time.monotonic()+10
        while len(pending)<size:
            if not self.authorized() or time.monotonic()>=deadline:raise Error('Provider display handshake timed out.',409)
            if not select.select([self.remote],[],[],.1)[0]:continue
            data=self.remote.recv(size-len(pending))
            if not data:raise Error('Provider display ended.',409)
            pending.extend(data)
        return bytes(pending)

    def handshake(self):
        if self.read_source(12)!=b'RFB 003.008\n':raise Error('This display adapter requires RFB 3.8.',409,code='capability_unsupported')
        self.write(b'RFB 003.008\n')
        count=self.read_source(1)[0]
        if not 0<count<=64 or 1 not in self.read_source(count):raise Error('Provider display authentication is not configured.',409,code='capability_unsupported')
        self.write(b'\x01')
        if self.read_source(4)!=b'\0'*4:raise Error('Provider display refused initialization.',409)
        self.write(b'\x01') # Always share; a viewer cannot evict other clients.
        header=self.read_source(24);width,height=struct.unpack('!HH',header[:4]);name_length=struct.unpack('!I',header[20:])[0]
        if not 0<width<=32768 or not 0<height<=32768 or name_length>4096:raise Error('Unsupported display initialization.',409)
        self.read_source(name_length)
        reader=ChannelReader(self.channel,self.command,self.authorized)
        self.channel.send_bytes(b'RFB 003.008\n')
        if reader.read(12)!=b'RFB 003.008\n':raise Error('RFB 3.8 is required.',400)
        self.channel.send_bytes(b'\x01\x01')
        if reader.read(1)!=b'\x01':raise Error('Invalid display security selection.',400)
        self.channel.send_bytes(b'\0'*4)
        if reader.read(1) not in (b'\0',b'\x01'):raise Error('Invalid display client initialization.',400)
        name=b'Canaveral display'
        self.channel.send_bytes(header[:20]+struct.pack('!I',len(name))+name)
        self.initialized=True
        self.channel.send_control({'type':'control','state':'view-only'})
        return reader.pending

    def reset_input(self):
        if not self.stream_ok:return False
        try:
            if hasattr(self.remote,'cancel_input'):
                if self.remote.cancel_input() is not True:return False
            else:
                for key in sorted(self.keys):self.write(struct.pack('!BB2xI',4,0,key),cleanup=True)
                _,x,y=self.pointer
                self.write(struct.pack('!BBHH',5,0,x,y),cleanup=True)
            self.keys.clear();self.pointer=(0,0,0)
            return True
        except Exception:return False

    def command(self,value):
        if value.get('type')=='action-receipt':
            if set(value)!={'type','id'}:raise Error('Invalid input receipt request.',400)
            operation_id=identifier(value['id'])
            if not self.initialized or not self.authorized() or not self.current():raise Error('Display authorization ended.',410)
            if not self.receipt_handler:report={'state':'failed','result':{'code':'capability_unsupported','detail':'Input receipt inspection is unavailable.'}}
            else:report=self.receipt_handler(operation_id)
            return self.action_result(operation_id,report)
        if value.get('type')=='action':return self.action(value)
        if set(value)!={'type','action'} or value.get('type')!='input-control' or value.get('action') not in ('take','release'):
            raise Error('Invalid display control.',400)
        if not self.initialized:state='not-ready'
        elif not self.authorized() or not self.current():raise Error('Display authorization ended.',410)
        elif value['action']=='take':
            state=self.controls.claim(self.machine,self.viewer,self.epoch,self.current)
            if state=='owned' and getattr(self.remote,'supports_input_claim',False) is True:
                try:
                    native=self.remote.take_input()
                    if native not in ('owned','busy','reset-uncertain'):
                        raise Error('Native input ownership response is invalid.',409)
                    if not self.authorized() or not self.current():
                        self.reset_input()
                        raise Error('Display authorization ended during native input claim.',410)
                    if native!='owned':
                        self.controls.release(self.machine,self.viewer,self.epoch,native=='busy')
                    state=native
                except BaseException:
                    self.controls.release(self.machine,self.viewer,self.epoch,False)
                    raise
        else:
            reset=self.reset_input() if self.controls.owns(self.machine,self.viewer,self.epoch) else True
            self.controls.release(self.machine,self.viewer,self.epoch,reset)
            state='view-only' if reset else 'reset-uncertain'
        self.channel.send_control({'type':'control','state':state})

    def action(self,value):
        from .devices import operation_request
        if set(value)!={'type','id','action','arguments'}:raise Error('Invalid display action.',400)
        request=operation_request({key:value[key] for key in ('id','action','arguments')})
        if request['action'] not in INPUT_ACTIONS:raise Error('This action does not belong to the input channel.',400)
        if not self.initialized or not self.authorized() or not self.current():raise Error('Display authorization ended.',410)
        report=None
        if not self.controls.owns(self.machine,self.viewer,self.epoch):
            report={'state':'failed','result':{'code':'input_not_owned','detail':'Take input control before issuing this action.'}}
        elif self.action_handler is None and not (self.context_action_handler and getattr(self.remote,'supports_semantic_context',False) is True):
            report={'state':'failed','result':{'code':'capability_unsupported','detail':'This display adapter has no discrete input actions.'}}
        else:
            try:
                if self.context_action_handler and getattr(self.remote,'supports_semantic_context',False) is True:
                    report=self.context_action_handler(request,self.remote.control_action)
                else:report=self.action_handler(request)
            except Exception:
                report={'state':'unknown','result':{'detail':'Input outcome requires inspection before retrying.'}}
            if not isinstance(report,dict) or report.get('state') not in ('succeeded','failed','unknown'):
                report={'state':'unknown','result':{'detail':'Input completion was not confirmed.'}}
            if report['state']=='unknown':
                # A timed-out provider process might still complete input. Do
                # not admit a new owner merely because RFB key reset succeeds.
                self.reset_input()
                self.controls.release(self.machine,self.viewer,self.epoch,False)
                self.channel.send_control({'type':'control','state':'reset-uncertain'})
        self.action_result(request['id'],report)

    def action_result(self,operation_id,report):
        response={'type':'action-result','id':operation_id,'state':report['state'],'result':report.get('result',{})}
        if len(json.dumps(response).encode())>16384:
            response={'type':'action-result','id':operation_id,'state':report['state'],
                      'result':{'outputOmitted':True,'detail':'Action response exceeds the display control envelope.'}}
        self.channel.send_control(response)

    def input(self,kind,frame):
        if kind in (4,5,6):
            if not self.controls.owns(self.machine,self.viewer,self.epoch):return False
            if not self.authorized() or not self.current():raise Error('Display authorization ended.',410)
            if kind==4:
                key=struct.unpack('!I',frame[4:])[0]
                if frame[1]:
                    if len(self.keys)>=128 and key not in self.keys:raise Error('Too many held display keys.',400)
                    self.keys.add(key)
                self.write(frame)
                if not frame[1]:self.keys.discard(key)
                return True
            if kind==5:self.pointer=struct.unpack('!BHH',frame[1:])
        self.write(frame);return True

    def run_display(self,channel):
        with self.resource_gate() if self.resource_gate else nullcontext():return self._run_display(channel)

    def _run_display(self,channel):
        self.channel=channel;outgoing=None
        with self.controls.lock:self.controls.endpoints.add(self)
        try:
            if not self.authorized():raise Error('Display authorization ended.',410)
            self.epoch=self.epoch_callback();self.remote=self.factory();self.remote.settimeout(2)
            pending=self.handshake()
            def output():
                try:
                    while self.authorized():
                        if not select.select([self.remote],[],[],.1)[0]:continue
                        data=self.remote.recv(65536)
                        if not data:break
                        self.channel.send_bytes(data)
                except Exception:pass
                finally:self.close()
            outgoing=threading.Thread(target=output,daemon=True);outgoing.start()
            parser=ClientMessages()
            while self.authorized():
                value=pending if pending else channel.receive(.1);pending=b''
                if isinstance(value,dict):self.command(value)
                elif isinstance(value,bytes):
                    denied=False
                    for kind,frame in parser.feed(value):denied=not self.input(kind,frame) or denied
                    if denied:channel.send_control({'type':'control','state':'view-only'})
                elif value is not None:raise Error('Invalid display payload.',400)
        finally:
            try:
                if self.remote and self.controls.owns(self.machine,self.viewer,self.epoch):
                    self.controls.release(self.machine,self.viewer,self.epoch,self.reset_input())
            finally:
                try:
                    if self.remote:self.remote.close()
                finally:
                    try:self.close()
                    finally:
                        if outgoing:outgoing.join(2)
                        with self.controls.lock:self.controls.endpoints.discard(self)
                        self.finished.set()
