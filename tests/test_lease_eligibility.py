import copy
import json
from pathlib import Path
import secrets
import tempfile
import unittest
import uuid

from canaveral.host import Agent
from canaveral.lease_eligibility import lease_eligible
from canaveral.model import Error, offer
from canaveral.store import Store
from test_consumers import application
from test_orchestration import host_offer, image, request


def mixed_offer():
    linux={**image(arch='arm64'),'id':'desktop','mode':'desktop','guestAccess':True,'runtime':'apple'}
    phone={'id':'phone','revision':'1','os':'android','arch':'arm64','mode':'device',
           'device':{'systemImage':'system-images;android-35;google_apis;arm64-v8a','profile':'pixel_8'},
           'minimum':{'cpu':1,'memoryMiB':1024,'diskGiB':4},'runtime':'android'}
    return {'name':'Fixture Mac','provider':'macos','runtimes':{'apple':{},'android':{}},
            'capacity':{'cpu':8,'memoryMiB':8192,'diskGiB':80},'templates':[linux,phone],
            'leaseProtocol':1,'leaseImages':[{'id':'desktop','revision':'1','arch':'arm64','runtime':'apple'}]}


class LeaseEligibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.now=1000;self.path=Path(self.temp.name)/'controller.db'
        self.store=Store(self.path,clock=lambda:self.now)
        self.host=str(uuid.uuid4());self.key=secrets.token_urlsafe(32);self.offer=mixed_offer()
        self.store.enroll({'id':self.host,'credential':self.key,'offer':self.offer})
        self.application=self.store.create_consumer(application({'id':'desktop','revision':'1','arch':'arm64'}))
        self.phone_application=self.store.create_consumer(application({'id':'phone','revision':'1','arch':'arm64'}))

    def acquire(self,phone=False):
        app=self.phone_application if phone else self.application
        return self.store.acquire_lease(app['credential'],{'id':str(uuid.uuid4()),
            'templateId':'phone' if phone else 'desktop','templateRevision':'1','arch':'arm64','ttlSeconds':120})

    def heartbeat(self,**extra):
        return self.store.heartbeat(self.host,self.key,{'offer':self.offer,**extra})

    def session(self,lease,application,capability='display'):
        token=self.store.lease_credential(lease['id'],application['credential'])['credential']
        session=self.store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':capability})
        self.store.attach_access_session(session['id'],session['generation'],'consumer',lease['id'],token)
        self.store.attach_access_session(session['id'],session['generation'],'host',self.host,self.key)
        return session,token

    def test_mixed_host_only_admits_the_explicit_runtime_image_and_keeps_admin_inventory(self):
        self.assertTrue(self.store.consumer_catalogue(self.application['credential'])['templates'][0]['available'])
        self.assertFalse(self.store.consumer_catalogue(self.phone_application['credential'])['templates'][0]['available'])
        lease=self.acquire();self.assertEqual(lease['state'],'provisioning')
        with self.assertRaises(Error) as refused:self.acquire(phone=True)
        self.assertEqual(refused.exception.status,503)
        self.assertEqual(len(self.store.machines()),1)
        administrative=self.store.create(request(templateId='phone',templateRevision='1',arch='arm64'))
        self.assertEqual(administrative['template']['os'],'android')
        self.assertEqual(len(self.store.host_resources(self.host)['images']),2)

    def test_legacy_host_wide_protocol_and_empty_selectors_do_not_grant_eligibility(self):
        for missing in (True,False):
            with self.subTest(missing=missing):
                self.offer['leaseImages']=[]
                if missing:self.offer.pop('leaseImages')
                self.heartbeat()
                self.assertFalse(self.store.consumer_catalogue(self.application['credential'])['templates'][0]['available'])
                with self.assertRaises(Error):self.acquire()
        self.assertEqual(self.store.machines(),[])
        # A persisted pre-change offer is not silently promoted on controller restart.
        old={key:value for key,value in self.offer.items() if key!='leaseImages'}
        with self.store.transaction() as db:db.execute('UPDATE hosts SET offer=? WHERE id=?',(json.dumps(old),self.host))
        restored=Store(self.path,clock=lambda:self.now)
        self.assertFalse(restored.consumer_catalogue(self.application['credential'])['templates'][0]['available'])

    def test_selectors_pin_revision_architecture_and_runtime_and_new_images_do_not_inherit(self):
        value={**host_offer(),'leaseProtocol':1,'templates':[image(),{**image(),'revision':'2'},image(arch='arm64')],
               'leaseImages':[{'id':'linux','revision':'1','arch':'amd64','runtime':'libvirt'}]}
        normalized=offer(value)
        self.assertEqual([lease_eligible(normalized,item) for item in normalized['templates']],[True,False,False])
        stale=copy.deepcopy(normalized['templates'][0]);stale['minimum']['cpu']=2
        self.assertFalse(lease_eligible(normalized,stale))
        added={**self.offer['templates'][0],'id':'new-image'}
        self.offer['templates'].append(added);self.heartbeat()
        app=self.store.create_consumer(application({'id':'new-image','revision':'1','arch':'arm64'}))
        self.assertFalse(self.store.consumer_catalogue(app['credential'])['templates'][0]['available'])

    def test_invalid_selectors_are_rejected_and_failed_heartbeat_preserves_previous_support(self):
        selector=self.offer['leaseImages'][0]
        for invalid in (None,{},'all',[{**selector,'runtime':'android'}],[{**selector,'revision':'missing'}],
                        [selector,selector],[{key:value for key,value in selector.items() if key!='runtime'}],
                        [{**selector,'path':'private-fixture-path'}]):
            with self.subTest(invalid=invalid):
                bad=copy.deepcopy(self.offer);bad['leaseImages']=invalid
                with self.assertRaises(Error):offer(bad)
                with self.assertRaises(Error):self.store.heartbeat(self.host,self.key,{'offer':bad})
                self.assertTrue(self.store.consumer_catalogue(self.application['credential'])['templates'][0]['available'])

    def test_withdrawing_one_image_disconnects_only_its_sessions_without_releasing_storage(self):
        self.offer['leaseImages'].append({'id':'phone','revision':'1','arch':'arm64','runtime':'android'})
        self.heartbeat();desktop=self.acquire();phone=self.acquire(phone=True)
        ids=[lease['members'][0]['machineId'] for lease in (desktop,phone)]
        self.heartbeat(reports={machine:{'state':'running','accessReady':True} for machine in ids})
        first,first_key=self.session(desktop,self.application)
        second,second_key=self.session(phone,self.phone_application)
        reserved=self.store.host_resources(self.host)['reserved']
        self.offer['leaseImages']=[self.offer['leaseImages'][1]]
        beat=self.heartbeat()
        self.assertEqual(beat['accessSessions'],[])
        self.assertEqual(self.store.get_access_session(desktop['id'],first['id'],first_key)['state'],'disconnected')
        self.assertEqual(self.store.get_access_session(phone['id'],second['id'],second_key)['state'],'ready')
        self.assertFalse(self.store.access_session_frame_authorized(first['id'],first['generation']))
        self.assertTrue(self.store.access_session_frame_authorized(second['id'],second['generation']))
        self.assertEqual(self.store.host_resources(self.host)['reserved'],reserved)
        self.assertEqual(self.store.get_lease(desktop['id'],first_key)['state'],'ready')
        with self.assertRaises(Error):self.store.create_access_session(desktop['id'],first_key,
            {'id':str(uuid.uuid4()),'member':'primary','capability':'display'})

    def test_frame_authorization_reads_current_eligibility_before_refresh_and_cannot_resurrect_a_session(self):
        lease=self.acquire();machine=lease['members'][0]['machineId'];self.heartbeat(reports={machine:{'state':'running','accessReady':True}})
        session,token=self.session(lease,self.application)
        self.assertTrue(self.store.access_session_frame_authorized(session['id'],session['generation']))
        withdrawn=offer({**self.offer,'leaseImages':[]})
        with self.store.transaction() as db:db.execute('UPDATE hosts SET offer=? WHERE id=?',(json.dumps(withdrawn),self.host))
        self.assertFalse(self.store.access_session_frame_authorized(session['id'],session['generation']))
        self.assertEqual(self.store.access_sessions_live({(session['id'],session['generation'])}),set())
        self.heartbeat() # Restoring support cannot revive a disconnected stream.
        self.assertEqual(self.store.get_access_session(lease['id'],session['id'],token)['state'],'disconnected')
        new=self.store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':'display'})
        self.assertEqual(new['state'],'pending')
        self.assertEqual(self.store.get_lease(lease['id'],token)['state'],'ready')

    def test_withdrawal_removes_pending_delivery_and_refuses_both_attach_peers(self):
        lease=self.acquire();machine=lease['members'][0]['machineId'];self.heartbeat(reports={machine:{'state':'running','accessReady':True}})
        token=self.store.lease_credential(lease['id'],self.application['credential'])['credential']
        session=self.store.create_access_session(lease['id'],token,{'id':str(uuid.uuid4()),'member':'primary','capability':'display'})
        self.assertEqual(self.heartbeat()['accessSessions'][0]['id'],session['id'])
        self.offer['leaseImages']=[]
        self.assertEqual(self.heartbeat()['accessSessions'],[])
        for side,owner,key in (('host',self.host,self.key),('consumer',lease['id'],token)):
            with self.assertRaises(Error):self.store.attach_access_session(session['id'],session['generation'],side,owner,key)
        self.assertEqual(self.store.get_access_session(lease['id'],session['id'],token)['state'],'disconnected')

    def test_selectors_without_protocol_and_ordinary_runner_configs_remain_gated(self):
        value=copy.deepcopy(self.offer);value.pop('leaseProtocol');normalized=offer(value)
        self.assertFalse(lease_eligible(normalized,normalized['templates'][0]))
        for config in (self.offer,value):
            state=Path(self.temp.name)/'must-not-start'
            with self.assertRaises(Error):Agent(config,'http://127.0.0.1:1',state)
            self.assertFalse(state.exists())
