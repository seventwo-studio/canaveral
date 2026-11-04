from canaveral.lease_clock import execution_monotonic
import contextlib
import io
import json
import secrets
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import quote

from canaveral.client import Client
from canaveral.dashboard import server
from canaveral.host import Agent
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_orchestration import host_offer,request


class ImagePipelineTests(DashboardFixture):
    def test_durable_preparation_does_not_imply_current_guest_connection_ready(self):
        offered=host_offer();offered['templates'][0]['guestAccess']=True
        offered['templates'][0]['prepare']={'driver':'cloud-init','commands':['true']}
        host=str(uuid.uuid4());token=secrets.token_urlsafe(32)
        self.store.enroll({'id':host,'credential':token,'offer':offered})
        machine=self.store.create(request());id=machine['id']
        self.store.heartbeat(host,token,{'offer':offered,'reports':{id:{'state':'running','accessReady':False,'preparation':{'state':'ready','tokenHash':'a'*64}}}})
        self.assertFalse(self.store.machines()[0]['ready'])
        self.assertEqual(self.store.machines()[0]['preparation']['state'],'ready')
        self.store.heartbeat(host,token,{'offer':offered,'reports':{id:{'state':'running','accessReady':True}}})
        self.assertTrue(self.store.machines()[0]['ready'])
        self.store.heartbeat(host,token,{'offer':offered,'reports':{id:{'state':'running','accessReady':False}}})
        self.assertFalse(self.store.machines()[0]['ready'])

    def metadata(self):return {'id':str(uuid.uuid4()),'name':'Reusable disk','os':'linux','arch':'arm64','mode':'desktop','mediaType':'disk','format':'raw','minimum':{'cpu':1,'memoryMiB':1024,'diskGiB':4}}

    def test_host_overview_scopes_images_and_distinguishes_installed_from_offered(self):
        agent=Agent(host_offer(),self.upstream,Path(self.temp.name)/'overview-worker');agent.connect(self.enrollment);agent.poll()
        other=str(uuid.uuid4());other_token=secrets.token_urlsafe(32)
        self.store.enroll({'id':other,'credential':other_token,'offer':host_offer()})
        metadata=self.metadata();payload=b'x'*512
        self.store.reserve_image_import(agent.identity['id'],metadata,len(payload))
        public=agent.library.import_stream(metadata,io.BytesIO(payload),len(payload),lambda:True)
        self.store.finish_image_import(metadata['id'],agent.identity['id'],public)
        admin=Client(self.upstream,self.admin)
        resources=admin.request('GET','/v1/hosts/'+agent.identity['id']+'/resources')
        installed=next(image for image in resources['images'] if image['id']==metadata['id'])
        self.assertFalse(installed['offered']);self.assertEqual(installed['origin'],'library')
        self.assertEqual(installed['sha256'],public['sha256'])
        self.assertNotIn(str(Path(self.temp.name)),json.dumps(resources['images']))
        self.assertNotIn(metadata['id'],[image['id'] for image in admin.request('GET','/v1/hosts/'+other+'/resources')['images']])
        agent.poll();agent.refresh_images();agent.poll()
        images=admin.request('GET','/v1/hosts/'+agent.identity['id']+'/resources')['images']
        self.assertEqual(sum(image['id']==metadata['id'] for image in images),1)
        self.assertTrue(next(image for image in images if image['id']==metadata['id'])['offered'])
        self.assertEqual(next(image for image in images if image['id']=='linux')['origin'],'runtime')

    def test_retained_runtime_revisions_are_listed_without_becoming_schedulable(self):
        offered=host_offer();retained={**offered['templates'][0],'revision':'retained'}
        agent=Agent({**offered,'templates':[retained,*offered['templates']],'offerTemplateRevisions':['linux@1:amd64']},self.upstream,Path(self.temp.name)/'retained-worker')
        agent.connect(self.enrollment);agent.poll()
        overview=self.store.host_resources(agent.identity['id'])
        images={image['revision']:image for image in overview['images']}
        self.assertEqual(set(images),{'1','retained'})
        self.assertFalse(images['retained']['offered']);self.assertTrue(images['1']['offered'])
        self.assertNotIn('retained',[image['revision'] for image in self.store.templates()])
        with self.assertRaises(Error):self.store.create(request(templateRevision='retained'))
        with self.assertRaises(Error):self.store.heartbeat(agent.identity['id'],agent.identity['credential'],{'offer':agent.offer,'installedImages':[retained,retained]})

    def test_publication_waits_for_storage_ack_and_host_can_recover_import_receipt(self):
        offered=host_offer({'cpu':8,'memoryMiB':16384,'diskGiB':100})
        agent=Agent(offered,self.upstream,Path(self.temp.name)/'worker')
        agent.connect(self.enrollment);agent.poll()
        metadata=self.metadata();payload=b'\0'*1048576
        self.store.reserve_image_import(agent.identity['id'],metadata,len(payload))
        public=agent.library.import_stream(metadata,io.BytesIO(payload),len(payload),lambda:True)
        # Completed host files cannot be offered until controller storage acknowledgement.
        agent.refresh_images()
        self.assertNotIn(metadata['id'],[item['id'] for item in agent.offer['templates']])
        agent.poll()
        agent.last_contact=execution_monotonic()
        thread=threading.Thread(target=agent.image_work,daemon=True);thread.start()
        try:
            deadline=time.monotonic()+3
            while not agent.image_reports and time.monotonic()<deadline:time.sleep(.01)
            agent.poll()
            self.assertEqual(self.store.image_task(metadata['id'])['state'],'succeeded')
            self.assertIn(metadata['id'],[item['id'] for item in agent.offer['templates']])
            agent.poll()
            self.assertEqual(self.store.images()[0]['sha256'],public['sha256'])
            self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],1)
        finally:agent.stopping.set();thread.join(2)

    def test_unregistered_or_cross_host_catalogue_offer_is_rejected(self):
        agent=Agent(host_offer(),self.upstream,Path(self.temp.name)/'worker')
        agent.connect(self.enrollment)
        metadata=self.metadata();payload=b'x'*512
        public=agent.library.import_stream(metadata,io.BytesIO(payload),len(payload),lambda:True)
        agent.library.acknowledge({public['id']:public['sha256']});agent.refresh_images()
        with self.assertRaises(Error):agent.poll()

    def test_capture_api_and_stream_upload_gateway_keep_role_boundaries(self):
        received=[]
        def connector(host,metadata=None,reader=None,size=None,authorized=None,check_only=False):
            if check_only:return True
            received.append((metadata,reader.read(size)));return {'id':metadata['id'],'name':metadata['name']}
        gateway=server(('127.0.0.1',0),self.upstream,bootstrap_token=self.admin,image_import_connector=connector)
        self.start(gateway);self.url='http://127.0.0.1:'+str(gateway.server_port)
        status,headers,_=self.fetch('/api/v1/auth/setup',{'username':'image-test','password':'fixture-password-long-enough'},headers={'Origin':self.url})
        self.assertEqual(status,200);cookie=headers['Set-Cookie'].split(';')[0]
        import urllib.request
        metadata=self.metadata();host=str(uuid.uuid4());payload=b'x'*2097152
        req=urllib.request.Request(self.url+'/api/v1/hosts/'+host+'/images/import',data=payload,method='POST',headers={'Cookie':cookie,'Origin':self.url,'Content-Type':'application/octet-stream','X-Canaveral-Image':quote(json.dumps(metadata))})
        with urllib.request.urlopen(req) as response:self.assertEqual(response.status,200)
        self.assertEqual(received[0][0]['id'],metadata['id']);self.assertEqual(received[0][1],payload)
        status,_,_=self.fetch('/api/v1/images',headers={'Cookie':cookie});self.assertEqual(status,200)
