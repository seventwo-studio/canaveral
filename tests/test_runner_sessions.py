import hashlib
import io
import json
import os
import threading
import time
import uuid
import struct
from pathlib import Path
from unittest.mock import Mock

from canaveral.client import Client
from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.lease_guard import LeaseGuard
from canaveral.model import Error,digest
from canaveral.runner_sessions import RunnerSessions
from canaveral.sdk import LeaseClient
from canaveral.shell_sessions import ShellSessions
from canaveral.transfers import Download,atomic_upload,confined_file
from test_access_sessions import AccessFixture
from test_devices import config,mobile


class FixtureProvider:
    """Only disposable fixture files/processes; never an adb or host-shell adapter."""
    access=None
    def __init__(self,root):
        self.root=root;self.root.mkdir();self.shells=ShellSessions();self.opens=0;self.upload_started=threading.Event();self.mutate_download=False
    def control(self,machine,image,folder,request):
        action=request['action'];args=request['arguments']
        if action=='shell-open':
            self.opens+=1;return self.shells.open(machine['id'],args['session'],['/bin/sh'])
        return self.shells.control(machine['id'],action,args)
    def stream_upload(self,machine,image,folder,path,app,reader,size,authorized):
        parent,name=confined_file(self.root,path)
        self.upload_started.set()
        try:return atomic_upload(parent,name,reader,size,authorized)
        finally:os.close(parent)
    def stream_download(self,machine,image,folder,path,app):
        parent,name=confined_file(self.root,path)
        try:descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parent)
        finally:os.close(parent)
        source=os.fdopen(descriptor,'rb');size=os.fstat(descriptor).st_size
        if self.mutate_download:
            original=source
            target=self.root/path
            class ChangedSource:
                def fileno(self):return original.fileno()
                def close(self):original.close()
                def read(self,count):
                    data=original.read(count)
                    if original.tell()==size:target.write_bytes(b'changed while downloading')
                    return data
            source=ChangedSource()
        return Download(source,size)


class RunnerFixture(AccessFixture):
    def setUp(self):
        super().setUp();self.ready()
        root=Path(self.temp.name)
        self.agent=Agent(config(),self.upstream,root/'runner')
        # Fixture protocol opt-in only; production Agent configuration still
        # rejects leaseProtocol. No live VM or simulator is used by these tests.
        self.agent.offer=self.offer;self.agent.identity={'id':self.host,'credential':self.host_token}
        self.agent.client=Client(self.upstream,self.host_token)
        self.agent.lease_guard=LeaseGuard(root/'runner',clock=lambda:self.now)
        self.backend=FixtureProvider(root/'fixture-guest');self.folder=root/'owned-assignment';self.folder.mkdir()
        self.agent.context=Mock(side_effect=lambda machine:(self.backend,mobile(),self.folder))
        self.agent.poll()
        machine=self.agent.assignments[0]
        save_json(self.folder/'assignment.json',{'fingerprint':digest({key:machine[key] for key in ('id','template','resources')})})
        self.sdk=LeaseClient(self.upstream,self.lease['id'],self.token)
        self.stop_poll=threading.Event();self.poll_errors=[]
        def poll():
            while not self.stop_poll.wait(.05):
                try:self.agent.poll()
                except Exception as error:self.poll_errors.append(error);return
        self.poll_thread=threading.Thread(target=poll,daemon=True);self.poll_thread.start()
        self.access_thread=threading.Thread(target=self.agent.access_runner.work,daemon=True);self.access_thread.start()
        self.addCleanup(self.finish_runner)

    def finish_runner(self):
        self.stop_poll.set();self.agent.stopping.set();self.poll_thread.join(3);self.access_thread.join(3)
        self.agent.access_runner.close();self.backend.shells.sweep(active=set())
        self.assertEqual(self.poll_errors,[])

    def terminal(self):
        session=self.sdk.create_session(str(uuid.uuid4()),'primary','pty')
        return session,self.sdk.connect_session(session)

    def wait_receipt(self,session_id):
        path=self.agent.access_runner.root/(session_id+'.json');until=time.monotonic()+5;record={}
        while time.monotonic()<until:
            if path.exists():
                record=json.loads(path.read_text())
                if record['state'] in ('complete','unknown','notStarted'):return record
            time.sleep(.02)
        self.fail('Session receipt remained incomplete: '+str(record))

    def output_until(self,connection,expected):
        data=b'';until=time.monotonic()+4
        while time.monotonic()<until:
            value=connection.receive(.5)
            if isinstance(value,bytes):data+=value
            if expected in data:return data
        self.fail('Terminal did not produce its expected output')


class RunnerSessionTests(RunnerFixture):
    def test_local_eligibility_withdrawal_closes_pty_before_controller_receives_a_heartbeat(self):
        session,connection=self.terminal()
        with connection:
            connection.send_control({'action':'shell-write','arguments':{'text':'printf eligibility-ready\\n\n'}})
            self.output_until(connection,b'eligibility-ready')
            self.stop_poll.set();self.poll_thread.join(3)
            self.assertFalse(self.poll_thread.is_alive())
            with self.agent.lock:self.agent.offer={**self.agent.offer,'leaseImages':[]}
            receipt=self.wait_receipt(session['id'])
            self.assertEqual(receipt['state'],'unknown')
            self.assertEqual(receipt['cleanup'],'complete')
            self.assertNotIn((self.machine,session['id']),self.backend.shells.sessions)
            # The local check acted without an updated controller declaration.
            self.assertTrue(next(host for host in self.store.hosts() if host['id']==self.host)['leaseImages'])

    def test_display_through_broker_with_runner_owned_input(self):
        from canaveral.simulator_screen import connect
        from test_simulator_screen import Provider
        provider=Provider()
        from canaveral.providers.mobile import Mobile
        self.backend.operate=lambda machine,image,folder,operation:Mobile.operate(provider,machine,{},folder,operation)
        self.backend.desktop=lambda machine,image,folder:connect(provider,machine,{'os':'android'},folder,lambda:True)
        session=self.sdk.create_session(str(uuid.uuid4()),'primary','display')
        with self.sdk.connect_session(session) as connection:
            pending=b''
            def read(size):
                nonlocal pending
                while len(pending)<size:
                    value=connection.receive(3)
                    self.assertIsInstance(value,bytes);pending+=value
                value,pending=pending[:size],pending[size:]
                return value
            self.assertEqual(read(12),b'RFB 003.008\n');connection.send_bytes(b'RFB 003.008\n')
            self.assertEqual(read(2),b'\x01\x01');connection.send_bytes(b'\x01')
            self.assertEqual(read(4),bytes(4));connection.send_bytes(b'\x01')
            header=read(24);self.assertEqual(struct.unpack('!HH',header[:4]),(1080,2400))
            self.assertEqual(read(struct.unpack('!I',header[20:])[0]),b'Canaveral display')
            self.assertEqual(connection.receive(3),{'type':'control','state':'view-only'})
            key=struct.pack('!BB2xI',4,1,ord('a'))
            connection.send_bytes(key)
            self.assertEqual(connection.receive(3)['state'],'view-only')
            self.assertEqual([r for r in provider.calls if r['action']=='text'],[])
            connection.send_control({'type':'input-control','action':'take'})
            self.assertEqual(connection.receive(3)['state'],'owned')
            action={'type':'action','id':str(uuid.uuid4()),'action':'tap','arguments':{'x':4,'y':5}}
            connection.send_control(action)
            first=connection.receive(3);self.assertEqual(first['state'],'succeeded')
            connection.send_control(action);self.assertEqual(connection.receive(3),first)
            self.assertEqual([r['arguments'] for r in provider.calls if r['action']=='tap'],[{'x':4,'y':5}])
            connection.send_bytes(key)
            connection.send_control({'type':'input-control','action':'release'})
            self.assertEqual(connection.receive(3)['state'],'view-only')
            self.assertEqual([r['arguments'] for r in provider.calls if r['action']=='text'],[{'text':'a'}])
            connection.send_control({'type':'action-receipt','id':action['id']})
            self.assertEqual(connection.receive(3),first)
        self.wait_receipt(session['id'])

    def test_unimplemented_display_adapter_reports_capability_without_guest_effects(self):
        session=self.sdk.create_session(str(uuid.uuid4()),'primary','display')
        with self.sdk.connect_session(session) as connection:
            result=connection.receive(3);self.assertEqual(result['code'],'capability_unsupported')
        self.assertEqual(self.backend.opens,0)
        self.assertEqual(self.wait_receipt(session['id'])['state'],'unknown')

    def test_multiple_stateful_ptys_close_owned_processes_and_never_replay(self):
        first,a=self.terminal();second,b=self.terminal()
        try:
            a.send_control({'action':'shell-write','arguments':{'text':'export CANAVERAL_STATE=first; printf "RESULT:%s\\n" "$CANAVERAL_STATE"\n'}})
            b.send_control({'action':'shell-write','arguments':{'text':'export CANAVERAL_STATE=second; printf "RESULT:%s\\n" "$CANAVERAL_STATE"\n'}})
            self.assertIn(b'RESULT:first',self.output_until(a,b'RESULT:first'))
            self.assertIn(b'RESULT:second',self.output_until(b,b'RESULT:second'))
            a.close();receipt=self.wait_receipt(first['id']);self.assertEqual(receipt['cleanup'],'complete')
            self.assertIn((self.machine,second['id']),self.backend.shells.sessions)
            with self.agent.lock:self.agent.access_sessions=[{**first,'machineId':self.machine}]
            replacement=RunnerSessions(self.agent);replacement.step();self.assertEqual(self.backend.opens,2)
            self.assertEqual(json.loads((replacement.root/(first['id']+'.json')).read_text()),receipt)
        finally:a.close();b.close()

    def test_large_and_empty_file_round_trip_with_digest_and_durable_finish(self):
        payload=(b'canaveral-outbound-file\x00'*4096)*40
        upload_id=str(uuid.uuid4())
        result=self.sdk.upload(upload_id,'primary','proof.bin',io.BytesIO(payload),len(payload))
        self.assertTrue(result['durable']);self.assertEqual(result['sha256'],hashlib.sha256(payload).hexdigest())
        self.assertEqual((self.backend.root/'proof.bin').read_bytes(),payload)
        self.assertEqual(self.wait_receipt(upload_id)['state'],'complete')
        target=io.BytesIO();download_id=str(uuid.uuid4())
        result=self.sdk.download(download_id,'primary','proof.bin',target)
        self.assertEqual(target.getvalue(),payload);self.assertEqual(result['bytes'],len(payload))
        self.assertEqual(self.wait_receipt(download_id)['state'],'complete')
        self.sdk.upload(str(uuid.uuid4()),'primary','empty',io.BytesIO(),0)
        target=io.BytesIO();self.sdk.download(str(uuid.uuid4()),'primary','empty',target)
        self.assertEqual(target.getvalue(),b'')

    def test_missing_or_wrong_upload_finish_does_not_replace_destination(self):
        target=self.backend.root/'existing';target.write_bytes(b'original')
        for finish in (None,{'type':'finish','bytes':3,'sha256':'0'*64}):
            session=self.sdk.create_session(str(uuid.uuid4()),'primary','upload')
            with self.sdk.connect_session(session) as connection:
                connection.send_control({'type':'begin','path':'existing','size':3});connection.send_bytes(b'new')
                self.assertTrue(self.backend.upload_started.wait(2));time.sleep(.1)
                self.assertEqual(target.read_bytes(),b'original')
                if finish:
                    connection.send_control(finish)
                    result=connection.receive(3);self.assertEqual(result['type'],'error')
            self.assertEqual(self.wait_receipt(session['id'])['state'],'unknown')
            self.assertEqual(target.read_bytes(),b'original')
            self.assertEqual([path.name for path in self.backend.root.iterdir()],['existing'])

    def test_mutated_download_is_not_reported_as_complete(self):
        (self.backend.root/'changing').write_bytes(b'original content')
        self.backend.mutate_download=True;target=io.BytesIO();request=str(uuid.uuid4())
        with self.assertRaises(Error):self.sdk.download(request,'primary','changing',target)
        self.assertEqual(self.wait_receipt(request)['state'],'unknown')


class RunnerDeadlineTests(RunnerFixture):
    lease_ttl=2
    def test_disconnected_runner_closes_pty_at_its_local_deadline(self):
        session,connection=self.terminal();self.stop_poll.set();self.poll_thread.join(2)
        try:
            connection.send_control({'action':'shell-write','arguments':{'text':'sleep 60\n'}})
            until=time.monotonic()+5;closed=False
            while time.monotonic()<until:
                try:connection.receive(.5)
                except Error:closed=True;break
            self.assertTrue(closed)
            self.assertEqual(self.wait_receipt(session['id'])['cleanup'],'complete')
            self.assertEqual(self.store.get_lease(self.lease['id'],self.token)['state'],'ready')
            self.assertFalse(self.agent.lease_guard.allowed(self.machine))
        finally:connection.close()
