import base64
import hashlib
import io
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.inspection_protocol import MAX_BYTES,SCHEMA,validate_snapshot
from canaveral.model import Error
from canaveral.providers.mobile import Mobile
from canaveral.runner_sessions import RunnerSession
from canaveral.sdk import LeaseClient
from canaveral.simulator_screen import connect
from test_runner_sessions import RunnerFixture

try:
    from PIL import Image
except ImportError:Image=None


XML='<hierarchy><node class="Button" resource-id="continue" text="Continue" clickable="true" enabled="true" bounds="[0,0][2,2]" custom="preserved"/></hierarchy>'


class InspectionSessionTests(RunnerFixture):
    def setUp(self):
        super().setUp();self.backend.control=Mock(return_value=XML)

    def test_snapshot_is_scoped_native_data_without_input_or_image_requests(self):
        credential=Path(self.temp.name)/'lease.key';credential.write_text(self.token);credential.chmod(0o600)
        client=LeaseClient.from_credential_file(self.upstream,self.lease['id'],credential)
        request=str(uuid.uuid4());value=client.accessibility(request)
        self.assertEqual(value['source'],'android-uiautomator');self.assertEqual(value['coordinateSpace'],'screen-pixels')
        node=value['nodes'][0]
        self.assertEqual(node['role'],'Button');self.assertEqual(node['name'],'Continue')
        self.assertEqual(node['identifier'],'continue');self.assertEqual(node['properties']['custom'],'preserved')
        self.assertTrue(node['states']['enabled']);self.assertEqual(node['actions'],['click'])
        self.assertNotIn('frame',value);self.assertFalse(value['truncated']);self.assertTrue(value['coverage'])
        self.assertEqual([c.args[3]['action'] for c in self.backend.control.call_args_list],['hierarchy'])
        self.assertEqual(self.agent.display_controls.records,{})
        receipt=self.wait_receipt(request);self.assertEqual(receipt['state'],'complete')
        raw=(self.agent.access_runner.root/(request+'.json')).read_text()
        self.assertNotIn('Continue',raw);self.assertNotIn('preserved',raw)
        with self.assertRaises(Error):self.sdk.accessibility(request)
        self.assertEqual(self.backend.control.call_count,1)

    def test_large_tree_crosses_control_and_binary_frame_sizes_without_losing_properties(self):
        nodes=''.join('<node class="Text" text="'+('detail'*70)+'" resource-id="n'+str(i)+'" bounds="[0,0][1,1]"/>' for i in range(500))
        self.backend.control.return_value='<hierarchy>'+nodes+'</hierarchy>'
        value=self.sdk.accessibility(str(uuid.uuid4()))
        self.assertEqual(len(value['nodes']),500)
        self.assertGreater(len(json.dumps(value).encode()),65536)
        self.assertEqual(value['nodes'][-1]['identifier'],'n499')
        self.assertEqual(value['nodes'][-1]['properties']['text'],'detail'*70)

    def test_invalid_begin_cannot_request_input_or_dispatch_the_provider(self):
        session=self.sdk.create_session(str(uuid.uuid4()),'primary','accessibility')
        with self.sdk.connect_session(session) as connection:
            connection.send_control({'type':'begin','action':'tap','arguments':{'x':1,'y':1}})
            self.assertEqual(connection.receive(3)['type'],'error')
        self.backend.control.assert_not_called()

    def test_consumer_binary_input_is_not_allowed_in_an_inspection_session(self):
        session=self.sdk.create_session(str(uuid.uuid4()),'primary','accessibility')
        with self.sdk.connect_session(session) as connection:
            connection.send_bytes(b'input is forbidden')
            with self.assertRaises(Error):connection.receive(3)
        self.backend.control.assert_not_called()

    def test_admission_requires_declared_hierarchy_support(self):
        with patch('canaveral.access_sessions.capabilities',return_value={'hierarchy':False}):
            with self.assertRaises(Error) as failure:self.sdk.create_session(str(uuid.uuid4()),'primary','accessibility')
        self.assertEqual(failure.exception.code,'capability_unsupported')
        self.backend.control.assert_not_called()

    def test_native_truncation_is_explicit_instead_of_silently_dropping_metadata(self):
        self.backend.control.return_value='<hierarchy>'+('<node class="Text" text="native"/>'*2001)+'</hierarchy>'
        value=self.sdk.accessibility(str(uuid.uuid4()))
        self.assertEqual(len(value['nodes']),2000);self.assertTrue(value['truncated'])
        self.assertTrue(value['coverage'])

    def test_expiry_during_native_read_does_not_forward_a_snapshot(self):
        entered=threading.Event();release=threading.Event();errors=[]
        def inspect(*args):entered.set();release.wait(3);return XML
        self.backend.control.side_effect=inspect
        def request():
            try:self.sdk.accessibility(str(uuid.uuid4()))
            except Error as error:errors.append(error)
        worker=threading.Thread(target=request);worker.start()
        try:
            self.assertTrue(entered.wait(2));self.now+=121;release.set();worker.join(4)
            self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
        finally:release.set();worker.join(4)

    @unittest.skipUnless(Image,'Install the visual extra for scoped inspection-to-click proof')
    def test_read_only_inspection_and_owned_semantic_click_share_target_state(self):
        native=Mobile({},self.folder);native.shells=self.backend.shells;calls=[]
        original='<hierarchy><node class="Window" text="Documents" bounds="[0,0][2,2]">'+XML.removeprefix('<hierarchy>').removesuffix('</hierarchy>')+'</node></hierarchy>'
        xml=[original]
        def control(machine,image,folder,request):
            calls.append(request)
            if request['action']=='hierarchy':return xml[0]
            if request['action']=='screenshot':
                png=io.BytesIO();Image.new('RGB',(2,2),(10,20,30)).save(png,format='PNG')
                return {'data':base64.b64encode(png.getvalue()).decode()}
            return {'posted':True}
        native.control=control
        native.desktop=lambda machine,image,folder:connect(native,machine,image,folder,lambda:not self.agent.stopping.is_set())
        native.display_epoch=lambda *args:{'startedAt':1,'identity':'fixture-boot'}
        self.backend=native
        with self.sdk.display(str(uuid.uuid4()),timeout=5) as display:
            self.assertEqual(display.take_control(3),'owned')
            value=self.sdk.accessibility(str(uuid.uuid4()))
            target=next(n for n in value['nodes'] if n['identifier']=='continue')
            args={'snapshotId':value['snapshotId'],'nodeId':target['id'],'nativeAction':'click'}
            request=str(uuid.uuid4());result=display.action(request,'accessibility-action',args,3)
            self.assertEqual(result['state'],'succeeded')
            self.assertEqual([c['arguments'] for c in calls if c['action']=='tap'],[{'x':1,'y':1}])
            self.assertEqual(display.receipt(request,3),result)
            xml[0]=original.replace('text="Documents"','text="Different window"')
            changed_context=display.action(str(uuid.uuid4()),'accessibility-action',args,3)
            self.assertEqual(changed_context['state'],'failed');self.assertEqual(changed_context['result']['code'],'input_rejected')
            self.assertEqual(len([c for c in calls if c['action']=='tap']),1)
            xml[0]=original.replace('[0,0][2,2]','[1,0][2,2]')
            stale=display.action(str(uuid.uuid4()),'accessibility-action',args,3)
            self.assertEqual(stale['state'],'failed');self.assertEqual(stale['result']['code'],'input_rejected')
            self.assertEqual(len([c for c in calls if c['action']=='tap']),1)
            self.assertEqual(display.release_control(3),'view-only')


class InspectionSDKValidationTests(unittest.TestCase):
    def test_missing_finish_or_bad_digest_never_returns_partial_tree(self):
        for finish in (None,{'type':'finish','bytes':2,'sha256':'0'*64}):
            sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),'x'*43)
            sdk.create_session=Mock(return_value={});connection=Mock()
            connection.__enter__=Mock(return_value=connection);connection.__exit__=Mock(return_value=False)
            sdk.connect_session=Mock(return_value=connection)
            connection.receive.side_effect=[{'type':'begin','schema':SCHEMA,'size':2},b'{}',finish]
            with self.assertRaises(Error):sdk.accessibility(str(uuid.uuid4()))

    def test_byte_budget_rejects_before_creating_a_session(self):
        sdk=LeaseClient('http://127.0.0.1:1',str(uuid.uuid4()),'x'*43);sdk.create_session=Mock()
        for limit in (0,True,MAX_BYTES+1):
            with self.assertRaises(Error):sdk.accessibility(str(uuid.uuid4()),max_snapshot_bytes=limit)
        sdk.create_session.assert_not_called()

    def test_invalid_snapshot_shape_and_parent_links_are_not_accepted(self):
        from canaveral.accessibility import snapshot
        value=snapshot('android',XML)
        self.assertIs(validate_snapshot(value),value)
        value['nodes'][0]['parentId']='absent'
        with self.assertRaises(Error):validate_snapshot(value)
        value['nodes'][0]['parentId']=None;value['nodes'].append(value['nodes'][0])
        with self.assertRaises(Error):validate_snapshot(value)

    def test_linux_states_and_provider_details_survive_worker_transfer_without_frame(self):
        from canaveral.accessibility import snapshot
        value=snapshot('android',XML);value.update(source='linux-atspi',unavailableNodes=2,frame={'data':'not transferred'})
        value['nodes'][0]['states']=['enabled','focused'];value['nodes'][0]['properties']['description']='Native detail'
        runtime=SimpleNamespace(control=Mock(return_value=value))
        connection=Mock();connection.receive.return_value={'type':'begin'}
        worker=object.__new__(RunnerSession);worker.connection=connection;worker.runtime=runtime
        worker.machine={'id':str(uuid.uuid4())};worker.image={'os':'linux'};worker.folder=Path('.')
        worker.authorized=lambda:True;worker.accessibility()
        raw=b''.join(c.args[0] for c in connection.send_bytes.call_args_list);result=json.loads(raw)
        self.assertNotIn('frame',result);self.assertEqual(result['unavailableNodes'],2)
        self.assertEqual(result['nodes'][0]['states'],['enabled','focused'])
        self.assertEqual(result['nodes'][0]['properties']['description'],'Native detail')
        self.assertEqual(runtime.control.call_args.args[3]['arguments'],{'includeFrame':False})
        self.assertEqual(connection.send_control.call_args_list[-1].args[0]['sha256'],hashlib.sha256(raw).hexdigest())

    def test_ios_coordinate_space_and_nested_frame_are_validated(self):
        from canaveral.accessibility import snapshot
        value=snapshot('ios',[{'AXType':'Button','AXLabel':'Submit','AXIdentifier':'submit',
            'frame':{'origin':{'x':1,'y':2},'size':{'width':3,'height':4}}}])
        self.assertIs(validate_snapshot(value),value)
        self.assertEqual(value['coordinateSpace'],'screen-points')
        self.assertEqual(value['nodes'][0]['bounds'],{'x':1,'y':2,'width':3,'height':4})
        value['capturedAt']=10**1000
        with self.assertRaises(Error):validate_snapshot(value)
