import concurrent.futures
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path

from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer, request


class SharedCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'db')
        self.hosts=[str(uuid.uuid4()),str(uuid.uuid4())]
        self.tokens={h:secrets.token_urlsafe(32) for h in self.hosts}
        for h in self.hosts:self.store.enroll({'id':h,'credential':self.tokens[h],'offer':host_offer()})
        self.budget={'id':str(uuid.uuid4()),'name':'One physical machine','capacity':{'cpu':4,'memoryMiB':4096,'diskGiB':40},'hostIds':self.hosts}
        self.store.save_resource_budget(self.budget)

    def test_parallel_admission_across_runners_cannot_oversubscribe_shared_host(self):
        def acquire(index):
            try:return self.store.create(request(hostId=self.hosts[index%2]))['id']
            except Error:return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            admitted=list(filter(None,pool.map(acquire,range(20))))
        self.assertEqual(len(admitted),2)
        budget=self.store.resource_budgets()[0]
        self.assertEqual(budget['reserved'],{'cpu':4,'memoryMiB':4096,'diskGiB':20})
        self.assertEqual(budget['available']['cpu'],0)

    def test_shutdown_offline_and_restart_keep_shared_reservations_correct(self):
        first=self.store.create(request(hostId=self.hosts[0]))
        second=self.store.create(request(hostId=self.hosts[1]))
        self.store.desired(first['id'],'stopped')
        with self.assertRaises(Error):self.store.create(request())
        self.store.heartbeat(self.hosts[0],self.tokens[self.hosts[0]],{'offer':host_offer(),'reports':{first['id']:{'state':'stopped'}}})
        third=self.store.create(request(hostId=self.hosts[1]))
        with self.assertRaises(Error):self.store.desired(first['id'],'running')
        self.assertEqual(self.store.resource_budgets()[0]['reserved']['diskGiB'],30)
        recovered=Store(self.store.path)
        with self.assertRaises(Error):recovered.create(request())
        self.assertEqual(recovered.resource_budgets()[0]['hostIds'],sorted(self.hosts))

    def test_overlapping_budgets_all_apply_and_heartbeat_cannot_change_membership(self):
        group={'id':str(uuid.uuid4()),'name':'Department quota','capacity':{'cpu':2,'memoryMiB':2048,'diskGiB':15},'hostIds':[self.hosts[0]]}
        self.store.save_resource_budget(group)
        self.store.create(request(hostId=self.hosts[0]))
        with self.assertRaises(Error):self.store.create(request(hostId=self.hosts[0]))
        self.store.heartbeat(self.hosts[0],self.tokens[self.hosts[0]],{'offer':host_offer({'cpu':100,'memoryMiB':100000,'diskGiB':1000}),'resourceBudgets':[]})
        with self.assertRaises(Error):self.store.create(request(hostId=self.hosts[0]))
        self.store.create(request(hostId=self.hosts[1]))
        self.assertEqual(len(self.store.host_resources(self.hosts[0])['sharedBudgets']),2)

    def test_lower_budget_preserves_existing_allocations_and_invalid_membership_is_atomic(self):
        machine=self.store.create(request())
        lowered={**self.budget,'capacity':{'cpu':1,'memoryMiB':1024,'diskGiB':5}}
        self.assertTrue(self.store.save_resource_budget(lowered)['overcommitted'])
        with self.assertRaises(Error):self.store.create(request())
        with self.assertRaises(Error):self.store.save_resource_budget({**lowered,'hostIds':[str(uuid.uuid4())]})
        self.assertEqual(self.store.resource_budgets()[0]['hostIds'],sorted(self.hosts))
        self.assertEqual(self.store.machines()[0]['id'],machine['id'])
