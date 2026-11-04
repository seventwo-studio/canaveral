import base64
import collections
import hashlib
import itertools
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.client import Client
from canaveral.contracts import session_protocol_schema
from canaveral.display_access import DisplayControls,DisplayEndpoint,INPUT_ACTIONS
from canaveral.model import Error
from canaveral.runner_sessions import RunnerSession
from canaveral.session_transport import SessionConnection
from test_access_sessions import AccessFixture
from test_runner_sessions import FixtureProvider

try:
    from jsonschema import Draft202012Validator,FormatChecker,ValidationError
    from referencing import Registry,Resource
    from referencing.jsonschema import DRAFT202012
except ImportError:Draft202012Validator=None


def validate(name,value):
    schema=session_protocol_schema();uri=schema['$id']
    Draft202012Validator({'$ref':uri+'#/$defs/'+name},format_checker=FormatChecker(),
        registry=Registry().with_resource(uri,Resource(schema,DRAFT202012))).validate(value)


class Channel:
    def __init__(self,capability,values):
        self.capability=capability;self.values=collections.deque(values);self.controls=[];self.binary=[]
    def receive(self,timeout):
        value=self.values.popleft() if self.values else None
        if isinstance(value,dict):validate(self.capability+'Consumer',value)
        return value
    def send_control(self,value):
        validate(self.capability+'Host',value);self.controls.append(value)
    def send_bytes(self,value):
        assert isinstance(value,bytes) and len(value)<=65536
        self.binary.append(value)


@unittest.skipUnless(Draft202012Validator,'Install the test extra for session contract validation.')
class SessionContractTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.backend=FixtureProvider(self.root/'guest')

    def worker(self,channel):
        worker=object.__new__(RunnerSession)
        worker.connection=channel;worker.runtime=self.backend;worker.folder=self.root
        worker.machine={'id':str(uuid.uuid4())};worker.image={'os':'android'}
        worker.authorized=lambda:True
        return worker

    def test_metaschema_directions_and_loader_copy(self):
        schema=session_protocol_schema();Draft202012Validator.check_schema(schema)
        from canaveral.session_errors import WORKER_MESSAGES
        self.assertEqual(set(schema['$defs']['WorkerError']['properties']['code']['enum']),set(WORKER_MESSAGES))
        self.assertEqual(set(schema['x-canaveral-streams']),{'pty','display','upload','download','accessibility'})
        for capability in schema['x-canaveral-streams']:
            self.assertEqual(schema['x-canaveral-streams'][capability]['binary']['maxMessageBytes'],65536)
        self.assertEqual(schema['x-canaveral-streams']['upload']['binary']['host'],'forbidden')
        schema['$defs'].clear();self.assertTrue(session_protocol_schema()['$defs'])

    def test_real_atomic_upload_and_download_worker_messages_match(self):
        data=b'fixture\x00\r\n'*12000;digest=hashlib.sha256(data).hexdigest()
        channel=Channel('upload',[{'type':'begin','path':'file','size':len(data)},
            *[data[offset:offset+65536] for offset in range(0,len(data),65536)],
            {'type':'finish','bytes':len(data),'sha256':digest}])
        self.worker(channel).upload()
        self.assertEqual(channel.controls,[{'type':'finish','bytes':len(data),'sha256':digest,'durable':True}])
        self.assertEqual((self.backend.root/'file').read_bytes(),data)
        output=Channel('download',[{'type':'begin','path':'file'}]);self.worker(output).download()
        self.assertEqual(b''.join(output.binary),data)
        self.assertEqual(output.controls,[{'type':'begin','size':len(data)},
            {'type':'finish','bytes':len(data),'sha256':digest}])

    def test_shape_valid_wrong_digest_cannot_publish_or_finish(self):
        target=self.backend.root/'file';target.write_bytes(b'original')
        channel=Channel('upload',[{'type':'begin','path':'file','size':3},b'new',
            {'type':'finish','bytes':3,'sha256':'0'*64}])
        with self.assertRaises(Error):self.worker(channel).upload()
        self.assertEqual(target.read_bytes(),b'original');self.assertEqual(channel.controls,[])

    def test_accessibility_worker_shapes_and_digest_for_large_native_tree(self):
        self.backend.control=Mock(return_value='<hierarchy>'+''.join(
            '<node class="Text" text="'+'detail'*70+'" bounds="[0,0][2,2]"/>' for _ in range(500))+'</hierarchy>')
        channel=Channel('accessibility',[{'type':'begin'}]);self.worker(channel).accessibility()
        data=b''.join(channel.binary);self.assertGreater(len(data),65536)
        self.assertEqual(channel.controls[0]['size'],len(data))
        self.assertEqual(channel.controls[-1],{'type':'finish','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        self.assertEqual(len(json.loads(data)['nodes']),500)

    def test_pty_worker_write_resize_truncation_and_exit_shapes(self):
        channel=Channel('pty',[{'action':'shell-write','arguments':{'text':'hello\n'}},
            {'action':'shell-resize','arguments':{'rows':40,'cols':120}}])
        worker=self.worker(channel)
        def control(action,args):
            if action=='shell-read':return {'data':base64.b64encode(b'output').decode(),'offset':6,'truncated':True,'exited':True,'exitCode':0}
            return {}
        worker.control=Mock(side_effect=control)
        with patch('canaveral.runner_sessions.time.monotonic',side_effect=itertools.count(0,.1)):worker.pty()
        self.assertEqual([call.args[0] for call in worker.control.call_args_list],['shell-open','shell-write','shell-resize','shell-read'])
        self.assertEqual(channel.controls,[{'type':'truncated'},{'type':'exited','exitCode':0}])
        self.assertEqual(channel.binary,[b'output'])

    def test_display_ownership_actions_unknown_and_readonly_receipt_shapes(self):
        channel=Channel('display',[])
        endpoint=DisplayEndpoint(DisplayControls(self.root/'input.json'),str(uuid.uuid4()),lambda:None,lambda:True,
            action_handler=lambda request:{'state':'succeeded','result':{}},
            receipt_handler=lambda request:{'state':'unknown','result':{}})
        endpoint.channel=channel;endpoint.initialized=True;endpoint.remote=SimpleNamespace(sendall=lambda data:None)
        take={'type':'input-control','action':'take'};validate('displayConsumer',take);endpoint.command(take)
        examples={'tap':{'x':1,'y':2},'swipe':{'x':1,'y':2,'toX':2,'toY':3,'durationMs':100},
            'text':{'text':'hello'},'key':{'key':'ENTER'},'launch':{'app':'example.app'},'terminate':{'app':'example.app'},
            'install':{'artifact':'fixture.apk'},'uninstall':{'app':'example.app'},'open-url':{'url':'https://example.invalid'},
            'rotate':{'orientation':'PORTRAIT'},'location':{'latitude':52.3,'longitude':4.9},
            'permission':{'app':'example.app','permission':'camera','state':'grant'},
            'accessibility-action':{'snapshotId':str(uuid.uuid4()),'nodeId':'node-1','nativeAction':'click'}}
        self.assertEqual(set(examples),INPUT_ACTIONS)
        for action,arguments in examples.items():
            request={'type':'action','id':str(uuid.uuid4()),'action':action,'arguments':arguments}
            validate('displayConsumer',request);endpoint.command(request)
        endpoint.action_handler=lambda request:{'state':'unknown','result':{}}
        endpoint.command({'type':'action','id':str(uuid.uuid4()),'action':'tap','arguments':examples['tap']})
        request={'type':'action-receipt','id':str(uuid.uuid4())};validate('displayConsumer',request);endpoint.command(request)
        self.assertIn({'type':'control','state':'reset-uncertain'},channel.controls)
        self.assertEqual(channel.controls[-1]['state'],'unknown')

    def test_wrong_direction_extra_fields_nul_and_invalid_digest_are_rejected(self):
        bad=[('uploadHost',{'type':'begin','path':'file','size':3}),
            ('downloadConsumer',{'type':'finish','bytes':3,'sha256':'a'*64}),
            ('accessibilityConsumer',{'type':'begin','action':'click'}),
            ('ptyConsumer',{'action':'shell-write','arguments':{'text':'x','session':str(uuid.uuid4())}}),
            ('displayConsumer',{'type':'action','id':str(uuid.uuid4()),'action':'shell','arguments':{'argv':['sh']}}),
            ('downloadConsumer',{'type':'begin','path':'\x00'}),
            ('uploadConsumer',{'type':'finish','bytes':3,'sha256':'a'*64+'\n'})]
        for name,value in bad:
            with self.subTest(name=name,value=value):
                with self.assertRaises(ValidationError):validate(name,value)

    def test_shape_validation_does_not_replace_utf8_byte_budget(self):
        value={'type':'action-result','id':str(uuid.uuid4()),'state':'succeeded','result':{'output':'字'*10000}}
        validate('displayHost',value)
        connection=object.__new__(SessionConnection);connection._send=Mock()
        with self.assertRaises(Error):connection.send_control(value)
        connection._send.assert_not_called()


@unittest.skipUnless(Draft202012Validator,'Install the test extra for session contract validation.')
class BrokerSessionContractTests(AccessFixture):
    def test_real_ready_shapes_allowed_pty_payload_and_forbidden_binary_direction(self):
        self.ready();session=self.create()
        consumer=SessionConnection(self.client,self.path+'/'+session['id']+'/'+session['generation']);self.addCleanup(consumer.close)
        host=SessionConnection(Client(self.upstream,self.host_token),'/v1/hosts/'+self.host+'/sessions/'+session['id']+'/'+session['generation']);self.addCleanup(host.close)
        for peer in (consumer,host):
            message=peer.receive(3);validate('Ready',message)
            self.assertEqual(message['sessionId'],session['id']);self.assertEqual(message['generation'],session['generation'])
        host.send_bytes(b'output');self.assertEqual(consumer.receive(3),b'output')
        command={'action':'shell-write','arguments':{'text':'fixture'}}
        validate('ptyConsumer',command);consumer.send_control(command);self.assertEqual(host.receive(3),command)
        consumer.send_bytes(b'forbidden')
        with self.assertRaises(Error):host.receive(3)
