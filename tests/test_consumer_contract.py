import copy
import http.client
import json
import unittest
import uuid
from unittest.mock import patch

from canaveral.contracts import consumer_api_schema
from test_access_sessions import AccessFixture

try:
    from jsonschema import Draft202012Validator,FormatChecker,ValidationError
    from referencing import Registry,Resource
    from referencing.jsonschema import DRAFT202012
    from openapi_spec_validator import validate as validate_spec
except ImportError:
    Draft202012Validator=None


@unittest.skipUnless(Draft202012Validator,'Install the test extra for public contract validation.')
class ConsumerContractTests(AccessFixture):
    def setUp(self):
        super().setUp()
        self.contract=consumer_api_schema();self.uri='urn:canaveral:consumer-http-contract'
        self.registry=Registry().with_resource(self.uri,Resource(self.contract,DRAFT202012))

    def validate(self,name,value):
        validator=Draft202012Validator({'$ref':self.uri+'#/components/schemas/'+name},
            registry=self.registry,format_checker=FormatChecker())
        validator.validate(value)

    def request(self,route,method='GET',value=None,token=None,pattern=None,status=200):
        connection=http.client.HTTPConnection('127.0.0.1',self.api.server_port,timeout=5)
        headers={'Authorization':'Bearer '+(self.token if token is None else token)}
        if value is not None:headers['Content-Type']='application/json'
        try:
            connection.request(method,route,body=None if value is None else json.dumps(value),headers=headers)
            response=connection.getresponse();body=json.loads(response.read())
            self.assertEqual(response.status,status,body)
            self.assertEqual(response.getheader('Cache-Control'),'no-store')
            if status==429:self.assertEqual(response.getheader('Retry-After'),'60')
            operation=self.contract['paths'][pattern or route.split('?')[0]][method.lower()]
            if value is not None:
                self.validate(operation['requestBody']['content']['application/json']['schema']['$ref'].split('/')[-1],value)
            schema=operation['responses'].get(str(status),operation['responses']['default'])['content']['application/json']['schema']
            self.validate(schema['$ref'].split('/')[-1],body)
            return body
        finally:connection.close()

    def lease_route(self,suffix=''):return '/v1/leases/'+self.lease['id']+suffix
    def pattern(self,suffix=''):return '/v1/leases/{leaseId}'+suffix

    def test_openapi_structure_internal_references_and_all_component_metaschemas(self):
        validate_spec(self.contract)
        for schema in self.contract['components']['schemas'].values():Draft202012Validator.check_schema(schema)
        self.assertEqual(self.contract['openapi'],'3.1.1')
        self.assertEqual(len(self.contract['paths']),12)
        self.assertNotIn('/v1/hosts',self.contract['paths'])
        # A fresh load cannot mutate the canonical packaged contract.
        self.contract['info']['title']='changed'
        self.assertNotEqual(consumer_api_schema()['info']['title'],'changed')

    def test_catalogue_acquisition_replay_and_pagination_use_live_http_shapes(self):
        self.request('/v1/environments/templates',token=self.a['credential'])
        # Replay the fixture acquisition, then acquire a second request identity.
        acquisition={'id':self.lease['id'],'templateId':'android-phone','templateRevision':'1','arch':'arm64','ttlSeconds':120}
        self.request('/v1/leases','POST',acquisition,self.a['credential'])
        self.request('/v1/leases','POST',{**acquisition,'id':str(uuid.uuid4())},self.a['credential'],status=201)
        self.request('/v1/leases','POST',{**acquisition,'id':str(uuid.uuid4())},self.a['credential'],status=429)
        page=self.request('/v1/leases',token=self.a['credential'])
        self.assertIn(self.lease['id'],[lease['id'] for lease in page['leases']])
        self.request('/v1/leases?after='+self.lease['id'],token=self.a['credential'])

    def test_ready_renewal_replay_current_view_and_terminal_cleanup_shapes(self):
        self.ready()
        lease=self.request(self.lease_route(),pattern=self.pattern())
        self.assertEqual(lease['state'],'ready')
        renew={'id':str(uuid.uuid4()),'expectedRevision':lease['revision'],'ttlSeconds':180}
        result=self.request(self.lease_route('/renew'),'POST',renew,pattern=self.pattern('/renew'))
        self.assertEqual(result['lease']['revision'],lease['revision']+1)
        release={'id':str(uuid.uuid4())}
        ended=self.request(self.lease_route('/release'),'POST',release,pattern=self.pattern('/release'))
        self.assertEqual(ended['lease']['cleanup']['state'],'pending')
        replay=self.request(self.lease_route('/renew'),'POST',renew,pattern=self.pattern('/renew'))
        self.assertEqual(replay['mutation'],result['mutation'])
        self.assertEqual(replay['lease']['state'],'released')
        cleanup=ended['lease']['members'][0]['cleanup']
        self.store.heartbeat(self.host,self.host_token,{'offer':self.offer,'reports':{self.machine:{'state':'running',
            'leaseCleanup':{'id':cleanup['id'],'leaseId':self.lease['id'],'state':'blocked','attempt':1,'reason':'execution_pending'}}}})
        blocked=self.request(self.lease_route(),pattern=self.pattern())
        self.assertEqual(blocked['members'][0]['cleanup']['reason'],'execution_pending')

    def test_credential_rotation_and_all_session_capabilities_shapes(self):
        key=self.request(self.lease_route('/credential'),'POST',{},self.a['credential'],self.pattern('/credential'))
        self.token=key['credential'];self.ready()
        for capability in ('pty','display','upload','download','accessibility'):
            value={'id':str(uuid.uuid4()),'member':'primary','capability':capability}
            session=self.request(self.path,'POST',value,pattern=self.pattern('/sessions'),status=201)
            self.request(self.path,'POST',value,pattern=self.pattern('/sessions'))
            route=self.path+'/'+session['id'];pattern=self.pattern('/sessions/{sessionId}')
            self.request(route,pattern=pattern)
            self.request(route+'/close','POST',{},pattern=pattern+'/close')

    def test_durable_operation_requests_receipts_replay_and_revoked_dispatch(self):
        self.ready()
        route=self.lease_route('/operations');pattern=self.pattern('/operations')
        request={'id':str(uuid.uuid4()),'member':'primary','action':'tap','arguments':{'x':1,'y':2}}
        self.request(route,'POST',request,pattern=pattern,status=201)
        self.request(route,'POST',request,pattern=pattern)
        self.store.heartbeat(self.host,self.host_token,{'offer':self.offer})
        self.request(self.lease_route('/release'),'POST',{'id':str(uuid.uuid4())},pattern=self.pattern('/release'))
        result=self.request(route+'/'+request['id'],pattern=pattern+'/{operationId}')
        self.assertEqual(result['state'],'unknown')
        self.request(route,'POST',request,pattern=pattern)
        self.validate('CreateOperation',{'id':str(uuid.uuid4()),'member':'primary','action':'shell','arguments':{'argv':['printf','ok']}})
        for bad in ({**request,'arguments':{'x':True,'y':2}}, {**request,'hostId':str(uuid.uuid4())},
                    {**request,'action':'install','arguments':{'artifact':'host-artifact'}},
                    {**request,'action':'shell','arguments':{'argv':[]}}):
            with self.assertRaises(ValidationError):self.validate('CreateOperation',bad)
        with self.assertRaises(ValidationError):self.validate('Operation',{**result,'hostId':str(uuid.uuid4())})

    def test_cross_application_and_wrong_role_errors_match_contract(self):
        self.request(self.lease_route(),token=self.b['credential'],pattern=self.pattern(),status=404)
        self.request(self.lease_route('/credential'),'POST',{},pattern=self.pattern('/credential'),status=401)
        self.ready()
        self.request(self.path,'POST',{'id':str(uuid.uuid4()),'member':'primary','capability':'pty'},
            self.a['credential'],self.pattern('/sessions'),status=403)

    def test_legacy_unexpected_service_failure_is_a_real_error_only_503(self):
        with patch.object(self.store,'get_lease',side_effect=RuntimeError('fixture storage failure')),patch('canaveral.api.logging.exception'):
            body=self.request(self.lease_route(),pattern=self.pattern(),status=503)
        self.assertEqual(set(body),{'error'})

    def test_session_attach_states_and_exact_expiry_http_views(self):
        self.ready();session=self.create()
        route=self.path+'/'+session['id'];pattern=self.pattern('/sessions/{sessionId}')
        self.attach(session)
        self.assertEqual(self.request(route,pattern=pattern)['state'],'attaching')
        self.attach(session,'host')
        self.assertEqual(self.request(route,pattern=pattern)['state'],'ready')
        self.now+=120
        lease=self.request(self.lease_route(),pattern=self.pattern())
        self.assertEqual(lease['state'],'expired')
        self.assertEqual(self.request(route,pattern=pattern)['state'],'expired')
        self.request(self.path,'POST',{'id':str(uuid.uuid4()),'member':'primary','capability':'pty'},
            pattern=self.pattern('/sessions'),status=410)

    def test_contract_refuses_secret_leaks_bad_capabilities_and_malformed_requests(self):
        self.ready();session=self.create()
        with self.assertRaises(ValidationError):self.validate('Session',{**session,'credential':'unexpected-secret'})
        self.validate('Session',session)
        for bad in ({'id':'not-a-uuid','member':'primary','capability':'pty'},
                    {'id':str(uuid.uuid4()),'member':'primary','capability':'host-shell'},
                    {'id':str(uuid.uuid4()),'member':'primary','capability':'pty','hostId':str(uuid.uuid4())}):
            with self.assertRaises(ValidationError):self.validate('CreateSession',bad)
        acquisition={'id':str(uuid.uuid4()),'templateId':'android-phone','templateRevision':'1','arch':'arm64'}
        self.validate('AcquireLease',acquisition)
        for key,value in [('ttlSeconds',True),('resources',{'cpu':0}),('requiredCapabilities',['pty','pty']),('hostId',str(uuid.uuid4()))]:
            with self.assertRaises(ValidationError):self.validate('AcquireLease',{**acquisition,key:value})
        broken=copy.deepcopy(self.lease);broken['members'][0]['ready']='yes'
        with self.assertRaises(ValidationError):self.validate('Lease',broken)
