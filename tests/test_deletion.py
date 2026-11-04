import secrets
import uuid
from pathlib import Path
from unittest.mock import Mock

from canaveral.client import Client
from canaveral.host import Agent
from canaveral.model import Error
from canaveral.store import Store
from test_dashboard import DashboardFixture
from test_orchestration import host_offer,request


class DeletionTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.offer={**host_offer(),'provider':'apple'};self.host=str(uuid.uuid4());self.credential=secrets.token_urlsafe(32)
        self.store.enroll({'id':self.host,'credential':self.credential,'offer':self.offer})
        self.machine=self.store.create(request());self.id=self.machine['id'];self.intent={'id':str(uuid.uuid4())}

    def beat(self,**extra):return self.store.heartbeat(self.host,self.credential,{'offer':self.offer,**extra})

    def stop(self):
        self.store.desired(self.id,'stopped');self.beat(reports={self.id:{'state':'stopped'}})

    def test_matching_receipt_reclaims_disk_and_retains_creation_tombstone(self):
        self.stop();client=Client(self.upstream,self.admin)
        queued=client.request('POST','/v1/machines/'+self.id+'/delete',self.intent)
        self.assertEqual(queued['state'],'queued')
        self.assertEqual(self.beat()['machines'][0]['deletion'],self.intent|{'state':'queued'})
        self.beat(reports={self.id:{'state':'stopped'}})
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],10)
        with self.assertRaises(Error):self.beat(reports={self.id:{'state':'stopped','deletion':{'id':str(uuid.uuid4()),'state':'complete'}}})
        self.beat(reports={self.id:{'state':'unknown','deletion':self.intent|{'state':'blocked'}}})
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],10)
        self.assertEqual(client.request('POST','/v1/machines/'+self.id+'/delete',self.intent)['state'],'blocked')
        self.beat(reports={self.id:{'state':'stopped','deletion':self.intent|{'state':'complete'}}})
        self.assertEqual(self.beat()['machines'],[]);self.assertEqual(self.store.machines(),[])
        resources=self.store.host_resources(self.host)
        self.assertEqual(resources['reserved']['diskGiB'],0);self.assertEqual(resources['allocations'],[])
        self.assertEqual(sum(category['diskGiB'] for category in resources['categories']),0)
        self.beat(reports={self.id:{'state':'running'}})
        self.assertEqual(self.store.host_resources(self.host)['reserved']['diskGiB'],0)
        original=self.store.create(request(id=self.id))
        self.assertEqual(original['deletion']['state'],'complete');self.assertFalse(original['ready'])
        restarted=Store(self.store.path)
        self.assertEqual(restarted.request_deletion(self.id,self.intent)['state'],'complete')
        with self.assertRaises(Error):restarted.desired(self.id,'running')

    def test_shutdown_capture_and_identity_conflicts_are_enforced(self):
        with self.assertRaises(Error):self.store.request_deletion(self.id,self.intent)
        self.stop();self.store.request_deletion(self.id,self.intent)
        with self.assertRaises(Error):self.store.request_deletion(self.id,{'id':str(uuid.uuid4())})
        with self.assertRaises(Error):self.store.desired(self.id,'running')
        with self.assertRaises(Error):self.store.request_power_off(self.id,{'id':str(uuid.uuid4())})
        with self.assertRaises(Error):self.store.create_image_capture({'id':str(uuid.uuid4()),'machineId':self.id,'name':'Deleted source'})
        other=self.store.create(request())
        with self.assertRaises(Error):self.store.request_deletion(other['id'],self.intent)
        with self.assertRaises(Error):self.beat(reports={self.id:{'state':'running','deletion':self.intent|{'state':'complete'}}})

    def test_agent_removal_bypasses_boot_preparation_and_exposes_blocked_outcome(self):
        agent=Agent.__new__(Agent);provider=Mock();folder=Path(self.temp.name)/'assignment'
        agent.context=Mock(return_value=(provider,{},folder))
        machine={**self.machine,'desired':'stopped','deletion':self.intent|{'state':'queued'}}
        provider.remove_owned_storage.return_value={**self.intent,'machineId':self.id,'state':'complete'}
        result=agent.reconcile(machine)
        provider.remove_owned_storage.assert_called_once_with(machine,{},folder,self.intent['id'])
        provider.reconcile.assert_not_called();provider.access.prepare.assert_not_called()
        self.assertEqual(result['deletion']['state'],'complete')
        provider.remove_owned_storage.side_effect=Error('Unknown ownership')
        self.assertEqual(agent.reconcile(machine)['deletion']['state'],'blocked')
