from lease_fixture import lease_offer
import json
import secrets
import uuid

from canaveral.client import Client
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_orchestration import host_offer


def application(image=None):
    return {'id':str(uuid.uuid4()),'name':'Build agent','templates':[image or {'id':'linux','revision':'1','arch':'amd64'}],
            'limits':{'resources':{'cpu':4,'memoryMiB':8192,'diskGiB':80},'activeLeases':2}}


class ConsumerTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.admin_client=Client(self.upstream,self.admin)
        self.host=str(uuid.uuid4());self.host_token=secrets.token_urlsafe(32);self.offer=lease_offer(host_offer())
        self.store.enroll({'id':self.host,'credential':self.host_token,'offer':self.offer})

    def test_scoped_catalogue_rotation_revocation_and_no_plaintext_storage(self):
        spec=application();result=self.admin_client.request('POST','/v1/consumers',spec)
        token=result['credential'];client=Client(self.upstream,token)
        catalog=client.request('GET','/v1/environments/templates')
        self.assertEqual(len(catalog['templates']),1)
        self.assertTrue(catalog['templates'][0]['available'])
        self.assertNotIn('hostId',catalog['templates'][0])
        self.assertFalse(catalog['templates'][0]['capabilities']['displayStream'])
        for path in ('/v1/hosts','/v1/machines','/v1/consumers','/v1/templates'):
            with self.assertRaises(Error) as raised:client.request('GET',path)
            self.assertEqual(raised.exception.status,401)
        with self.assertRaises(Error):client.request('POST','/v1/consumers',application())
        with self.assertRaises(Error):self.admin_client.request('POST','/v1/consumers',spec)
        listed=self.admin_client.request('GET','/v1/consumers')
        self.assertNotIn(token,json.dumps(listed))
        with self.store.transaction() as db:
            self.assertNotIn(token,json.dumps([dict(r) for r in db.execute('SELECT * FROM consumers')]))
        fresh=self.admin_client.request('POST','/v1/consumers/'+spec['id']+'/credential',{})['credential']
        with self.assertRaises(Error):client.request('GET','/v1/environments/templates')
        client=Client(self.upstream,fresh);client.request('GET','/v1/environments/templates')
        self.admin_client.request('POST','/v1/consumers/'+spec['id']+'/revoke',{})
        with self.assertRaises(Error):client.request('GET','/v1/environments/templates')
        with self.assertRaises(Error):self.admin_client.request('POST','/v1/consumers/'+spec['id']+'/credential',{})

    def test_invalid_permissions_limits_and_separate_catalogues(self):
        bad=application();bad['templates'][0]['revision']='missing'
        with self.assertRaises(Error):self.store.create_consumer(bad)
        bad=application();bad['limits']['activeLeases']=True
        with self.assertRaises(Error):self.store.create_consumer(bad)
        bad=application();bad['limits']['maxTTLSeconds']=60
        with self.assertRaises(Error):self.store.create_consumer(bad)
        bad=application();bad['templates'].append(dict(bad['templates'][0]))
        with self.assertRaises(Error):self.store.create_consumer(bad)
        a=self.store.create_consumer(application());empty=application();empty['templates']=[]
        b=self.store.create_consumer(empty)
        self.assertEqual(self.store.consumer_catalogue(b['credential'])['templates'],[])
        self.now+=31
        self.assertFalse(self.store.consumer_catalogue(a['credential'])['templates'][0]['available'])
