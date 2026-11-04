"""Outbound provider sessions, pinned to an authorized lease assignment.

Attempt receipts prevent reconnect/restart from replaying an uncertain PTY open
or file publication. This does not enable lease execution before VM cleanup and
in-guest command fencing are complete.
"""
import base64
import hashlib
import json
import logging
import threading
import time
import uuid
from pathlib import Path

from .devices import operation_request,string
from .files import HostLock,save_json
from .lease_clock import contact_fresh
from .model import Error,digest,identifier
from .lease_eligibility import lease_eligible
from .session_transport import SessionConnection


def length(value):
    if type(value) is not int or not 0<=value<=2**53-1:raise Error('Invalid transfer length.',400)
    return value


def begin(connection,upload=False):
    value=connection.receive(30)
    allowed={'type','path','app','size'} if upload else {'type','path','app'}
    required={'type','path','size'} if upload else {'type','path'}
    if not isinstance(value,dict) or set(value)-allowed or not required<=set(value) or value['type']!='begin':raise Error('Invalid file transfer begin control.',400)
    string(value['path'],'guest file path')
    if 'app' in value:string(value['app'],'app identifier',200)
    if upload:length(value['size'])
    return value


class UploadReader:
    def __init__(self,connection,size):
        self.connection=connection;self.size=size;self.remaining=size;self.pending=b'';self.hash=hashlib.sha256();self.finished=False

    def finish(self):
        value=self.connection.receive(30)
        if not isinstance(value,dict) or set(value)!={'type','bytes','sha256'} or value['type']!='finish' or type(value['bytes']) is not int or value['bytes']!=self.size or value['sha256']!=self.hash.hexdigest():
            raise Error('Upload finish or content digest did not match.',400)
        self.finished=True

    def read(self,size):
        if not self.remaining:return b''
        if not self.pending:
            value=self.connection.receive(30)
            if not isinstance(value,bytes) or not value or len(value)>self.remaining:raise Error('Upload ended early or exceeded its declared length.',400)
            self.pending=value
        value=self.pending[:min(size,self.remaining)];self.pending=self.pending[len(value):]
        self.remaining-=len(value);self.hash.update(value)
        # Withhold the final bytes from the provider until an explicit valid
        # finish arrives. Its atomic-upload path cannot publish before finish.
        if not self.remaining:self.finish()
        return value


class RunnerSession:
    def __init__(self,manager,job,machine,runtime,image,folder):
        self.manager=manager;self.job=job;self.machine=machine;self.runtime=runtime;self.image=image;self.folder=Path(folder)
        self.cancelled=threading.Event();self.connection=None;self.thread=None;self.pty_started=False
        self.receipt=manager.root/(identifier(job['id'])+'.json')
        self.binding={key:job[key] for key in ('id','generation','leaseId','machineId','capability')}

    def authorized(self):return not self.cancelled.is_set() and self.manager.authorized(self.job)

    def close(self):
        self.cancelled.set()
        if self.connection:self.connection.close()

    def control(self,action,args):
        request=operation_request({'id':str(uuid.uuid4()),'action':action,'arguments':{**args,'session':self.job['id']}})
        return self.runtime.control(self.machine,self.image,self.folder,request)

    def run(self):
        from .assignment_gate import assignment_access
        try:
            with assignment_access(self.machine,self.folder):self._run()
        except Exception:
            # Cleanup admission has no provider effects and never replays a session.
            self.close()

    def _run(self):
        outcome='unknown';cleanup='notNeeded';attempted=False
        try:
            with HostLock(self.receipt.with_suffix('.lock')):
                if self.receipt.exists():return # An uncertain attempt is never replayed.
                save_json(self.receipt,{**self.binding,'state':'connecting','cleanup':cleanup})
                attempted=True
            if not self.authorized():raise Error('Lease access ended.',410)
            assignment=self.folder/'assignment.json'
            expected=digest({key:self.machine[key] for key in ('id','template','resources')})
            if not assignment.is_file() or json.loads(assignment.read_text()).get('fingerprint')!=expected:
                raise Error('Owned assignment receipt is missing or different.',409)
            self.manager.agent.lease_guard.begin_execution(self.machine['id'],self.job['leaseId'])
            host=identifier(self.manager.agent.identity['id'])
            path='/v1/hosts/'+host+'/sessions/'+self.job['id']+'/'+self.job['generation']
            self.connection=SessionConnection(self.manager.agent.client,path,self.authorized)
            ready=self.connection.receive(30)
            if not isinstance(ready,dict) or ready.get('type')!='ready' or ready.get('sessionId')!=self.job['id'] or ready.get('generation')!=self.job['generation'] or ready.get('capability')!=self.job['capability']:
                raise Error('Outbound session did not become ready.',409)
            if not self.authorized():raise Error('Lease access ended.',410)
            save_json(self.receipt,{**self.binding,'state':'active','cleanup':cleanup})
            capability=self.job['capability']
            if capability=='pty':self.pty()
            elif capability=='upload':self.upload()
            elif capability=='download':self.download()
            elif capability=='display':self.display()
            elif capability=='accessibility':self.accessibility()
            else:raise Error('This runner has no outbound adapter for this capability.',409,code='capability_unsupported')
            outcome='complete'
        except Exception as error:
            if self.connection:
                from .session_errors import WORKER_MESSAGES
                code=error.code if isinstance(error,Error) and isinstance(error.code,str) and error.code in WORKER_MESSAGES else 'session_incomplete'
                try:self.connection.send_control({'type':'error','code':code,'message':WORKER_MESSAGES[code],'outcome':'unknown'})
                except Exception:pass
        finally:
            if self.pty_started:
                cleanup='unknown'
                try:
                    if self.control('shell-close',{}).get('closed'):cleanup='complete'
                except Exception:pass
            if self.connection:self.connection.close()
            # No command text, file paths, content or credentials enter receipts.
            if attempted:save_json(self.receipt,{**self.binding,'state':outcome,'cleanup':cleanup})

    def pty(self):
        self.pty_started=True
        self.control('shell-open',{})
        offset=0;last_read=0
        while self.authorized():
            value=self.connection.receive(.02)
            if value is not None:
                if not isinstance(value,dict) or set(value)!={'action','arguments'} or value.get('action') not in ('shell-write','shell-resize') or not isinstance(value.get('arguments'),dict):raise Error('Invalid terminal control.',400)
                if 'session' in value['arguments']:raise Error('Terminal ownership is fixed by its broker session.',400)
                if not self.authorized():raise Error('Lease access ended.',410)
                self.control(value['action'],value['arguments'])
            if time.monotonic()-last_read>=.05:
                result=self.control('shell-read',{'offset':offset});last_read=time.monotonic()
                data=base64.b64decode(result['data'],validate=True)
                if len(data)>65536:raise Error('Terminal output exceeds its bounded read.',409)
                if result.get('truncated'):self.connection.send_control({'type':'truncated'})
                if data:self.connection.send_bytes(data)
                offset=result['offset']
                if result.get('exited'):
                    self.connection.send_control({'type':'exited','exitCode':result.get('exitCode')});return
        raise Error('Lease access ended.',410)

    def display(self):
        from .display_access import DisplayEndpoint
        from .providers.mobile import operation_receipt
        backend=self.runtime.access or self.runtime
        if getattr(backend,'supports_scoped_desktop',False) is True:
            factory=lambda:backend.desktop_session(self.machine,self.image,self.folder,self.authorized)
        elif hasattr(backend,'desktop'):
            factory=lambda:backend.desktop(self.machine,self.image,self.folder)
        elif self.image['os'] in ('android','ios') and hasattr(self.runtime,'display_epoch'):
            from .simulator_screen import connect
            factory=lambda:connect(self.runtime,self.machine,self.image,self.folder,self.authorized)
        else:raise Error('This runner has no display adapter.',409,code='capability_unsupported')
        epoch=lambda:self.runtime.display_epoch(self.machine,self.image,self.folder) if hasattr(self.runtime,'display_epoch') else None
        DisplayEndpoint(self.manager.agent.display_controls,self.machine['id'],factory,self.authorized,epoch,self.job['id'],
            action_handler=lambda request:self.runtime.operate(self.machine,self.image,self.folder,
                {**request,'machineId':self.machine['id'],'expiresAt':time.time()+30}),
            receipt_handler=lambda operation_id:operation_receipt(self.folder,operation_id),
            context_action_handler=lambda request,handler:self.runtime.operate(self.machine,self.image,self.folder,
                {**request,'machineId':self.machine['id'],'expiresAt':time.time()+30},control_handler=handler)).run_display(self.connection)

    def upload(self):
        value=begin(self.connection,True);reader=UploadReader(self.connection,value['size'])
        if not reader.size:reader.finish()
        if not self.authorized():raise Error('Upload authorization ended before opening the provider.',410)
        backend=self.runtime.access or self.runtime
        if not hasattr(backend,'stream_upload'):raise Error('This provider has no streaming upload.',409)
        if hasattr(backend,'require_durable_upload'):backend.require_durable_upload(self.image)
        result=backend.stream_upload(self.machine,self.image,self.folder,value['path'],value.get('app'),reader,reader.size,self.authorized)
        if reader.remaining or not reader.finished or result.get('uploaded')!=reader.size or result.get('durable') is not True:
            raise Error('Durable upload publication was not confirmed.',409)
        if not self.authorized():raise Error('Upload authorization ended before acknowledgement.',410)
        self.connection.send_control({'type':'finish','bytes':reader.size,'sha256':reader.hash.hexdigest(),'durable':True})

    def accessibility(self):
        from .accessibility import inspect_provider,inspection_supported
        from .inspection_protocol import MAX_BYTES,SCHEMA,validate_snapshot
        value=self.connection.receive(30)
        if value!={'type':'begin'}:raise Error('Accessibility reads accept only an empty begin control.',400)
        if not self.authorized():raise Error('Accessibility authorization ended before inspection.',410)
        image=self.image
        if not inspection_supported(self.runtime,image):
            raise Error('This provider has no native accessibility adapter.',409,code='capability_unsupported')
        snapshot=inspect_provider(self.runtime,self.machine,image,self.folder,include_frame=False)
        if not self.authorized():raise Error('Accessibility authorization ended during inspection.',410)
        if isinstance(snapshot,dict):snapshot={k:v for k,v in snapshot.items() if k!='frame'}
        validate_snapshot(snapshot)
        data=json.dumps(snapshot,allow_nan=False,ensure_ascii=False,separators=(',',':')).encode('utf8')
        if len(data)>MAX_BYTES:raise Error('Accessibility snapshot exceeds its transfer envelope.',413)
        self.connection.send_control({'type':'begin','schema':SCHEMA,'size':len(data)})
        for offset in range(0,len(data),65536):
            if not self.authorized():raise Error('Accessibility authorization ended during transfer.',410)
            self.connection.send_bytes(data[offset:offset+65536])
        if not self.authorized():raise Error('Accessibility authorization ended before completion.',410)
        self.connection.send_control({'type':'finish','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})

    def download(self):
        value=begin(self.connection);backend=self.runtime.access or self.runtime
        if not self.authorized():raise Error('Download authorization ended before opening the provider.',410)
        if not hasattr(backend,'stream_download'):raise Error('This provider has no streaming download.',409)
        source=backend.stream_download(self.machine,self.image,self.folder,value['path'],value.get('app'))
        try:
            size=length(source.size);remaining=size;checksum=hashlib.sha256()
            self.connection.send_control({'type':'begin','size':size})
            while remaining:
                if not self.authorized():raise Error('Download authorization ended.',410)
                data=source.read(min(65536,remaining))
                if not data or len(data)>min(65536,remaining):raise Error('Download source ended early or exceeded its declared size.',409)
                if not self.authorized():raise Error('Download authorization ended during read.',410)
                checksum.update(data);self.connection.send_bytes(data);remaining-=len(data)
            source.verify()
            if not self.authorized():raise Error('Download authorization ended before completion.',410)
            self.connection.send_control({'type':'finish','bytes':size,'sha256':checksum.hexdigest()})
        finally:source.close()


class RunnerSessions:
    def __init__(self,agent):
        self.agent=agent;self.root=Path(agent.state_dir)/'access-sessions';self.root.mkdir(mode=0o700,exist_ok=True)
        self.lock=threading.RLock();self.sessions={}

    def authorized(self,job):
        with self.agent.lock:
            if self.agent.stopping.is_set() or not contact_fresh(self.agent.last_contact):return False
            machine=next((m for m in self.agent.assignments if m['id']==job['machineId']),None)
            if not machine or machine['desired']!='running' or not machine.get('ready') or machine.get('lease',{}).get('id')!=job['leaseId'] or machine['lease']['state']!='ready':return False
            if not lease_eligible(self.agent.offer,machine.get('template')):return False
        return self.agent.lease_guard.allowed(job['machineId'])

    def step(self):
        with self.agent.lock:jobs=list(self.agent.access_sessions);machines={m['id']:m for m in self.agent.assignments}
        with self.lock:
            for session in list(self.sessions.values()):
                if not self.authorized(session.job):session.close()
            for job in jobs:
                for key in ('id','generation','leaseId','machineId'):identifier(job[key])
                if job['id'] in self.sessions or (self.root/(job['id']+'.json')).exists() or not self.authorized(job):continue
                machine=machines[job['machineId']];runtime,image,folder=self.agent.context(machine)
                session=RunnerSession(self,job,machine,runtime,image,folder)
                session.thread=threading.Thread(target=session.run,daemon=True)
                self.sessions[job['id']]=session
                try:session.thread.start()
                except RuntimeError:
                    self.sessions.pop(job['id'],None)
                    save_json(session.receipt,{**session.binding,'state':'notStarted','cleanup':'notNeeded'})
                    logging.error('Outbound session worker unavailable; negotiate a new session after recovery.')
            for key,session in list(self.sessions.items()):
                if not session.thread.is_alive():self.sessions.pop(key,None)

    def work(self):
        while not self.agent.stopping.wait(.1):
            try:self.step()
            except Exception:logging.error('Outbound session attachment requires inspection; no input is replayed.')

    def close(self):
        with self.lock:sessions=list(self.sessions.values())
        for session in sessions:session.close()
        deadline=time.monotonic()+5
        for session in sessions:session.thread.join(max(0,deadline-time.monotonic()))

    def close_machine(self,machine_id):
        with self.lock:sessions=[s for s in self.sessions.values() if s.job['machineId']==machine_id]
        for session in sessions:session.close()
