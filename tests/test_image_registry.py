import copy
import hashlib
import io
import json
import struct
import time
import threading
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.client import Client
from canaveral.host import Agent
from canaveral.image_registry import catalogue,checksums,entry,resolve,validate_entry_source
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_orchestration import host_offer


class RegistryTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.agent=Agent(host_offer({'cpu':8,'memoryMiB':16384,'diskGiB':100}),self.upstream,Path(self.temp.name)/'worker')
        self.agent.connect(self.enrollment);self.agent.poll()
        self.payload=b'QFI\xfb'+struct.pack('!I',3)+bytes(504)
        self.source={'url':'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img','version':'fixture-pinned-build','sha256':hashlib.sha256(self.payload).hexdigest(),'bytes':len(self.payload)}
        self.intent={'id':str(uuid.uuid4()),'hostId':self.agent.identity['id'],'registryId':'ubuntu-noble-cloud-amd64'}

    def test_outbound_worker_resolves_reserves_verifies_and_waits_for_publication_ack(self):
        admin=Client(self.upstream,self.admin)
        task=admin.request('POST','/v1/image-registry/imports',self.intent)
        self.assertEqual(task['state'],'queued');self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],0)
        self.agent.poll();job=self.agent.image_tasks[0]
        with patch('canaveral.providers.base.architecture',return_value='amd64'),patch('canaveral.image_registry.resolve',return_value=self.source),patch('canaveral.image_registry.open_source',return_value=io.BytesIO(self.payload)):
            report=self.agent.registry_import(job)
        self.assertEqual(report['state'],'succeeded');self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],1)
        self.assertEqual(self.agent.library.definitions(),[])
        self.agent.image_reports[job['id']]=report;self.agent.poll()
        self.assertEqual(self.store.image_task(job['id'])['state'],'succeeded')
        self.assertEqual(self.store.images()[0]['registry']['publisherSha256'],self.source['sha256'])
        self.assertEqual(len(self.agent.library.definitions()),1)
        self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],1)
        self.assertEqual(admin.request('POST','/v1/image-registry/imports',self.intent)['state'],'succeeded')
        with self.assertRaises(Error):admin.request('POST','/v1/image-registry/imports',{**self.intent,'registryId':'debian-stable-netinst-amd64'})

    def test_wrong_checksum_never_publishes_and_interrupted_copy_retains_reservation(self):
        self.store.create_registry_import(self.intent);self.agent.poll();job=self.agent.image_tasks[0]
        wrong={**self.source,'sha256':'a'*64}
        with patch('canaveral.providers.base.architecture',return_value='amd64'),patch('canaveral.image_registry.resolve',return_value=wrong),patch('canaveral.image_registry.open_source',return_value=io.BytesIO(self.payload)):
            report=self.agent.registry_import(job)
        self.assertEqual(report['state'],'failed');self.assertEqual(self.agent.library.public_records(),[])
        self.assertEqual(list(self.agent.library.root.glob('*.partial')),[])
        self.agent.image_reports[job['id']]=report;self.agent.poll();self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],0)
        second={**self.intent,'id':str(uuid.uuid4())};self.store.create_registry_import(second);self.agent.poll();job=self.agent.image_tasks[0]
        with patch('canaveral.providers.base.architecture',return_value='amd64'),patch('canaveral.image_registry.resolve',return_value=self.source),patch('canaveral.image_registry.open_source',return_value=io.BytesIO(self.payload)),patch.object(self.agent.library,'import_stream',side_effect=OSError('Uncertain disk cleanup')):
            report=self.agent.registry_import(job)
        self.assertEqual(report['state'],'unknown');self.agent.image_reports[job['id']]=report;self.agent.poll()
        self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],1)

    def test_resolved_source_is_pinned_and_role_and_budget_boundaries_hold(self):
        self.store.create_registry_import(self.intent)
        host=self.agent.identity['id'];credential=self.agent.identity['credential']
        resolved=self.store.resolve_registry_import(host,credential,self.intent['id'],self.source)
        self.assertEqual(self.store.resolve_registry_import(host,credential,self.intent['id'],self.source),resolved)
        with self.assertRaises(Error):self.store.resolve_registry_import(host,credential,self.intent['id'],{**self.source,'sha256':'a'*64})
        with self.assertRaises(Error):Client(self.upstream,credential).request('GET','/v1/image-registry')
        second={**self.intent,'id':str(uuid.uuid4())};self.store.create_registry_import(second)
        with self.assertRaises(Error):self.store.resolve_registry_import(host,credential,second['id'],{**self.source,'bytes':101*1073741824})
        self.assertEqual(self.store.hosts()[0]['reserved']['diskGiB'],1)
        with self.assertRaises(Error):validate_entry_source(entry('ubuntu-noble-cloud-amd64'),{**self.source,'url':'https://127.0.0.1/private'})
        with self.assertRaises(Error):validate_entry_source(entry('ubuntu-noble-cloud-amd64'),{**self.source,'url':'https://cdn-apple.com/file'})

    def test_curated_catalogue_manual_windows_and_stable_version_selection(self):
        entries=Client(self.upstream,self.admin).request('GET','/v1/image-registry')['entries']
        self.assertEqual(len({e['id'] for e in entries}),len(entries))
        self.assertEqual(entry('windows-development-vm')['status'],'unavailable')
        with self.assertRaises(Error):self.store.create_registry_import({**self.intent,'registryId':'windows-development-vm'})
        manifest='a'*64+' *ubuntu-24.04.5-desktop-amd64.iso\n'+'b'*64+' *ubuntu-24.04.5.1-desktop-amd64.iso\n'+'c'*64+' *ubuntu-24.04.99-desktop-arm64.iso\n'
        class Response(io.BytesIO):headers={'Content-Length':'512'}
        with patch('canaveral.image_registry.metadata',return_value=manifest),patch('canaveral.image_registry.open_source',return_value=Response()):
            source=resolve(entry('ubuntu-24.04-desktop-amd64'))
        self.assertEqual(source['sha256'],'b'*64);self.assertTrue(source['url'].endswith('24.04.5.1-desktop-amd64.iso'))

    def test_unreadable_receipt_does_not_stop_other_image_tasks(self):
        self.store.create_registry_import(self.intent)
        second={**self.intent,'id':str(uuid.uuid4())};self.store.create_registry_import(second)
        self.agent.poll();first=self.intent['id']
        def run(job):
            if job['id']==first:raise OSError('Receipt unavailable')
            self.agent.stopping.set();return {'state':'failed','result':{'detail':'Second task safely rejected'}}
        with patch.object(self.agent,'registry_import',side_effect=run):
            worker=threading.Thread(target=self.agent.image_work,daemon=True);worker.start();worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.agent.image_reports[first]['state'],'unknown')
        self.assertEqual(self.agent.image_reports[second['id']]['state'],'failed')
