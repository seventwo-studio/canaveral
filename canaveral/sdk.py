"""Consumer lifecycle client. Mutating requests require caller-owned stable UUIDs."""
import os
import hashlib
import json
import stat
import urllib.parse
from pathlib import Path

from .client import Client
from .model import Error, identifier, secret
from .session_errors import checked


def credential_file(path):
    path=Path(path)
    with path.open('r') as handle:
        info=os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or (os.name!='nt' and (info.st_uid!=os.getuid() or info.st_mode & 0o077)):
            raise Error('Credential file must be a private regular file owned by the current user.',400)
        raw=handle.read(131)
        if len(raw)>130:raise Error('Invalid credential file.',400)
        return secret(raw.strip())


class ConsumerClient:
    def __init__(self,url,credential,allow_http=False,ca_file=None):
        self.client=Client(url,secret(credential),allow_http,ca_file=ca_file)

    @classmethod
    def from_credential_file(cls,url,path,allow_http=False,ca_file=None):
        return cls(url,credential_file(path),allow_http,ca_file=ca_file)

    def catalogue(self):
        return self.client.request('GET','/v1/environments/templates')

    def acquire(self,request_id,image_id,revision,arch,ttl_seconds=None,resources=None,required_capabilities=None,name=None):
        value={'id':identifier(request_id),'templateId':image_id,'templateRevision':revision,'arch':arch}
        for key,item in [('ttlSeconds',ttl_seconds),('resources',resources),('requiredCapabilities',required_capabilities),('name',name)]:
            if item is not None:value[key]=item
        return self.client.request('POST','/v1/leases',value)

    def leases(self,after=None):
        path='/v1/leases'
        if after is not None:path+='?after='+urllib.parse.quote(identifier(after),safe='')
        return self.client.request('GET',path)

    def inspect(self,lease_id):
        return self.client.request('GET','/v1/leases/'+identifier(lease_id))

    def scoped_lease(self,lease_id):
        lease_id=identifier(lease_id)
        # Local TLS setup must succeed before the non-idempotent key rotation.
        scoped=LeaseClient(self.client.url,lease_id,self.client.token,self.client.allow_http,ca_file=self.client.ca_file)
        result=self.client.request('POST','/v1/leases/'+lease_id+'/credential',{})
        scoped.client.token=secret(result['credential'])
        return scoped

    def renew(self,lease_id,request_id,expected_revision,ttl_seconds):
        return self.client.request('POST','/v1/leases/'+identifier(lease_id)+'/renew',{'id':identifier(request_id),'expectedRevision':expected_revision,'ttlSeconds':ttl_seconds})

    def release(self,lease_id,request_id):
        return self.client.request('POST','/v1/leases/'+identifier(lease_id)+'/release',{'id':identifier(request_id)})


class LeaseClient:
    def __init__(self,url,lease_id,credential,allow_http=False,ca_file=None):
        self.id=identifier(lease_id)
        self.client=Client(url,secret(credential),allow_http,ca_file=ca_file)

    @classmethod
    def from_credential_file(cls,url,lease_id,path,allow_http=False,ca_file=None):
        return cls(url,lease_id,credential_file(path),allow_http,ca_file=ca_file)

    def inspect(self):return self.client.request('GET','/v1/leases/'+self.id)

    def renew(self,request_id,expected_revision,ttl_seconds):
        return self.client.request('POST','/v1/leases/'+self.id+'/renew',{'id':identifier(request_id),'expectedRevision':expected_revision,'ttlSeconds':ttl_seconds})

    def release(self,request_id):
        return self.client.request('POST','/v1/leases/'+self.id+'/release',{'id':identifier(request_id)})

    def create_operation(self,request_id,member,action,arguments):
        return self.client.request('POST','/v1/leases/'+self.id+'/operations',
                                   {'id':identifier(request_id),'member':member,'action':action,'arguments':arguments})

    def operation(self,operation_id):
        return self.client.request('GET','/v1/leases/'+self.id+'/operations/'+identifier(operation_id))

    def create_session(self,request_id,member,capability):
        return self.client.request('POST','/v1/leases/'+self.id+'/sessions',{'id':identifier(request_id),'member':member,'capability':capability})

    def session(self,session_id):
        return self.client.request('GET','/v1/leases/'+self.id+'/sessions/'+identifier(session_id))

    def close_session(self,session_id):
        return self.client.request('POST','/v1/leases/'+self.id+'/sessions/'+identifier(session_id)+'/close',{})

    def connect_session(self,session,timeout=30):
        from .session_transport import SessionConnection
        if not isinstance(session,dict) or session.get('leaseId')!=self.id or session.get('protocol')!='canaveral-session-v1':raise Error('Session does not belong to this lease or protocol.',400)
        session_id=identifier(session.get('id'));generation=identifier(session.get('generation'))
        connection=SessionConnection(self.client,'/v1/leases/'+self.id+'/sessions/'+session_id+'/'+generation)
        try:
            ready=connection.receive(timeout)
            if not isinstance(ready,dict) or ready.get('type')!='ready' or ready.get('sessionId')!=session_id or ready.get('generation')!=generation or ready.get('capability')!=session.get('capability'):
                raise Error('Session peers did not become ready. Create a new session; do not replay input.',408)
            return connection
        except Exception:
            connection.close();raise

    def display(self,request_id,member='primary',timeout=30,max_frame_bytes=64*1024*1024):
        from .visual_sdk import DisplayClient
        # Validate optional support before creating a persisted session intent.
        DisplayClient.require_images()
        DisplayClient.validate_options(timeout,max_frame_bytes)
        session=self.create_session(request_id,member,'display')
        return DisplayClient(self.connect_session(session,timeout),timeout,max_frame_bytes)

    def terminal(self,request_id,member='primary',timeout=30):
        from .terminal_sdk import TerminalClient
        TerminalClient.validate_timeout(timeout,allow_zero=False)
        session=self.create_session(request_id,member,'pty')
        connection=self.connect_session(session,timeout)
        try:return TerminalClient(connection,session['id'])
        except BaseException:
            connection.close();raise

    def upload(self,request_id,member,path,reader,size,app=None):
        from .runner_sessions import length
        size=length(size)
        session=self.create_session(request_id,member,'upload');checksum=hashlib.sha256();remaining=size
        with self.connect_session(session) as connection:
            value={'type':'begin','path':path,'size':size}
            if app is not None:value['app']=app
            connection.send_control(value)
            while remaining:
                data=reader.read(min(65536,remaining))
                if not isinstance(data,bytes) or not data or len(data)>min(65536,remaining):raise Error('Upload source ended early or returned an invalid chunk.',400)
                checksum.update(data);connection.send_bytes(data);remaining-=len(data)
            connection.send_control({'type':'finish','bytes':size,'sha256':checksum.hexdigest()})
            result=checked(connection.receive(30),identifier(request_id))
            if not isinstance(result,dict) or result.get('type')!='finish' or type(result.get('bytes')) is not int or result.get('bytes')!=size or result.get('sha256')!=checksum.hexdigest() or result.get('durable') is not True:
                raise Error('Upload publication was not confirmed. Inspect the destination before retrying.',409,
                            request_id=identifier(request_id),outcome='unknown')
            return result

    def accessibility(self,request_id,member='primary',max_snapshot_bytes=None):
        from .inspection_protocol import MAX_BYTES,SCHEMA,validate_snapshot
        limit=MAX_BYTES if max_snapshot_bytes is None else max_snapshot_bytes
        if type(limit) is not int or not 0<limit<=MAX_BYTES:raise Error('Choose an accessibility byte budget within the protocol envelope.',400)
        session=self.create_session(request_id,member,'accessibility')
        with self.connect_session(session) as connection:
            connection.send_control({'type':'begin'});metadata=checked(connection.receive(30),identifier(request_id))
            if not isinstance(metadata,dict) or set(metadata)!={'type','schema','size'} or metadata['type']!='begin' or metadata['schema']!=SCHEMA:
                raise Error('Accessibility snapshot metadata was not confirmed.',409)
            size=metadata['size']
            if type(size) is not int or not 0<size<=limit:raise Error('Accessibility snapshot exceeds the chosen byte budget.',413)
            data=bytearray();checksum=hashlib.sha256()
            while len(data)<size:
                chunk=checked(connection.receive(30),identifier(request_id))
                if not isinstance(chunk,bytes) or not chunk or len(chunk)>min(65536,size-len(data)):raise Error('Accessibility snapshot was incomplete or exceeded its declared size.',409)
                data.extend(chunk);checksum.update(chunk)
            finish=checked(connection.receive(30),identifier(request_id))
            if not isinstance(finish,dict) or set(finish)!={'type','bytes','sha256'} or finish['type']!='finish' or type(finish['bytes']) is not int or finish['bytes']!=size or finish['sha256']!=checksum.hexdigest():
                raise Error('Accessibility snapshot completion was not confirmed.',409)
            try:
                value=json.loads(data,parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Non-finite accessibility value')))
            except (UnicodeError,ValueError,RecursionError,OverflowError) as error:raise Error('Accessibility snapshot is not valid JSON.',409) from error
            return validate_snapshot(value)

    def download(self,request_id,member,path,writer,app=None):
        from .runner_sessions import length
        session=self.create_session(request_id,member,'download');checksum=hashlib.sha256()
        with self.connect_session(session) as connection:
            value={'type':'begin','path':path}
            if app is not None:value['app']=app
            connection.send_control(value);metadata=checked(connection.receive(30),identifier(request_id))
            if not isinstance(metadata,dict) or set(metadata)!={'type','size'} or metadata['type']!='begin':raise Error('Download metadata was not confirmed.',409)
            size=length(metadata['size']);remaining=size
            while remaining:
                data=checked(connection.receive(30),identifier(request_id))
                if not isinstance(data,bytes) or not data or len(data)>remaining:raise Error('Download ended early or exceeded its declared size.',409)
                checksum.update(data);remaining-=len(data);pending=memoryview(data)
                while pending:
                    written=writer.write(pending)
                    if type(written) is not int or not 0<written<=len(pending):raise Error('Download destination did not accept its bytes.',409)
                    pending=pending[written:]
            result=checked(connection.receive(30),identifier(request_id))
            if not isinstance(result,dict) or result.get('type')!='finish' or type(result.get('bytes')) is not int or result.get('bytes')!=size or result.get('sha256')!=checksum.hexdigest():
                raise Error('Download identity or digest was not confirmed; the destination may contain partial data.',409,
                            request_id=identifier(request_id),outcome='unknown')
            return result

    def download_to_file(self,request_id,member,path,destination,app=None,replace=False):
        from .download_destination import receive_file
        request_id=identifier(request_id)
        return receive_file(destination,lambda output:self.download(request_id,member,path,output,app),
                            replace=replace,request_id=request_id)
