import copy
import json
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from canaveral.client import Client
from canaveral.host_health import inspect
from canaveral.model import Error
from canaveral.store import Store
from test_orchestration import host_offer, request
from test_dashboard import DashboardFixture


class InfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.now=1000
        self.store=Store(Path(self.temp.name)/'db',clock=lambda:self.now)
        self.offer=host_offer()
        self.host=str(uuid.uuid4());self.credential=secrets.token_urlsafe(32)
    def setup(self):return self.store.create_setup({'id':str(uuid.uuid4()),**self.offer})
    def enroll(self,setup):return self.store.enroll({'id':self.host,'credential':self.credential,'offer':self.offer},setup['enrollmentToken'])
    def health(self,status='passed'):
        return {'status':status,'checkedAt':self.now,'checks':[{'id':'runtime','label':'Runtime','status':status,'detail':'Fixture report.'}]}
    def beat(self,**extra):return self.store.heartbeat(self.host,self.credential,{'offer':self.offer,**extra})

    def test_setup_is_scoped_single_use_idempotent_for_owned_identity_and_persistent(self):
        setup=self.setup()
        with self.assertRaises(Error):self.store.enroll({'id':self.host,'credential':self.credential,'offer':{**self.offer,'name':'wrong'}},setup['enrollmentToken'])
        self.enroll(setup);self.assertEqual(self.enroll(setup)['id'],self.host)
        with self.assertRaises(Error):self.store.enroll({'id':str(uuid.uuid4()),'credential':self.credential,'offer':self.offer},setup['enrollmentToken'])
        with self.assertRaises(Error):self.store.enroll({'id':self.host,'credential':secrets.token_urlsafe(32),'offer':self.offer},setup['enrollmentToken'])
        self.assertNotIn(setup['enrollmentToken'],json.dumps(self.store.setups()))
        restored=Store(self.store.path,clock=lambda:self.now)
        self.assertEqual(restored.setups()[0]['hostId'],self.host)
        with self.assertRaises(Error):self.store.create_setup({'id':setup['id'],**self.offer})

    def test_expiry_revocation_and_provider_identity(self):
        setup=self.setup();self.now+=1801
        with self.assertRaises(Error):self.enroll(setup)
        setup=self.setup();self.store.revoke_setup(setup['id'])
        with self.assertRaises(Error):self.enroll(setup)
        setup=self.setup();self.enroll(setup)
        with self.assertRaises(Error):self.store.heartbeat(self.host,self.credential,{'offer':{**self.offer,'provider':'kubevirt'}})

    def test_failed_and_stale_checks_block_admission_without_releasing_reservations(self):
        self.enroll(self.setup());self.beat(health=self.health())
        machine=self.store.create(request());health=self.health('failed');self.beat(health=health)
        self.assertFalse(self.store.hosts()[0]['placementReady'])
        with self.assertRaises(Error):self.store.create(request())
        self.assertEqual(self.store.hosts()[0]['reserved']['memoryMiB'],2048)
        good=self.health();self.beat(health=good);self.now+=121
        self.beat(health=good) # Repeating a cached result must not refresh its check age.
        self.assertFalse(self.store.hosts()[0]['health']['fresh'])
        with self.assertRaises(Error):self.store.create(request())
        good=self.health();self.beat(health=good)
        self.assertTrue(self.store.hosts()[0]['placementReady'])

    def test_samples_are_bounded_validated_and_do_not_replace_the_reservation_ledger(self):
        self.enroll(self.setup());self.store.create(request())
        sample={'scope':'host','domain':'physical-host','sampledAt':self.now,'cpuPercent':25,'cpuCount':8,
                'memoryTotalMiB':16000,'memoryAvailableMiB':8000,'diskTotalGiB':100,'diskFreeGiB':80}
        self.beat(resources=sample);self.beat(resources=sample)
        self.assertEqual(len(self.store.host_resources(self.host)['samples']),1)
        self.now+=10;self.beat(resources=sample)
        self.assertEqual(len(self.store.host_resources(self.host)['samples']),1)
        self.now+=1;self.beat(resources={**sample,'sampledAt':self.now})
        data=self.store.host_resources(self.host)
        self.assertEqual(len(data['samples']),2);self.assertEqual(data['reserved']['diskGiB'],10)
        self.assertEqual(data['allocations'][0]['resources']['memoryMiB'],2048)
        with self.assertRaises(Error):self.beat(resources={**sample,'cpuPercent':float('nan')})
        with self.assertRaises(Error):self.beat(health={'status':'passed','checks':[{'id':'x','label':'x','status':'failed','detail':'x'}]})
        self.store.request_checks(self.host)
        self.assertEqual(self.beat()['checksRequestedAt'],self.now)

    def test_empty_catalogue_can_connect_and_kubevirt_has_distinct_kind(self):
        self.offer.update(provider='kubevirt',templates=[])
        self.enroll(self.setup())
        self.assertEqual(self.store.hosts()[0]['kind'],'orchestrator')
        with self.assertRaises(Error):self.store.create(request())

    def test_category_totals_follow_ledger_and_keep_stopping_compute(self):
        self.enroll(self.setup());machine=self.store.create(request())
        self.store.desired(machine['id'],'stopped')
        data=self.store.host_resources(self.host)
        self.assertEqual(next(g for g in data['categories'] if g['id']=='virtualMachines')['cpu'],2)
        self.beat(reports={machine['id']:{'state':'stopped'}})
        data=self.store.host_resources(self.host)
        retained=next(g for g in data['categories'] if g['id']=='retainedDisks')
        self.assertEqual(retained['diskGiB'],10);self.assertEqual(retained['cpu'],0)
        for key in ('cpu','memoryMiB','diskGiB'):
            self.assertEqual(sum(g[key] for g in data['categories']),data['reserved'][key])

    def test_process_measurement_uses_owned_tree_and_handles_pid_reuse(self):
        from types import SimpleNamespace
        from canaveral.host_health import process_usage, _process_state
        _process_state.samples={}
        class Process:
            pid=99
            born=1
            cpu=2
            def name(self):return 'CanaveralVMRunner'
            def create_time(self):return self.born
            def cpu_times(self):return SimpleNamespace(user=self.cpu,system=0)
            def memory_info(self):return SimpleNamespace(rss=1048576)
            def children(self,recursive):return []
        process=Process();collector=SimpleNamespace(Process=lambda:process,cpu_count=lambda:4)
        with patch('canaveral.host_health.time.monotonic',side_effect=[10,12,14]):
            self.assertIsNone(process_usage(collector)['categories'][1]['cpuPercent'])
            process.cpu=4
            self.assertEqual(process_usage(collector)['categories'][1]['cpuPercent'],25)
            process.born=2
            result=process_usage(collector)
            self.assertIsNone(result['categories'][1]['cpuPercent'])
        from canaveral.infrastructure import validate_sample
        sample={'scope':'host','domain':'test','sampledAt':1,'canaveral':result}
        validate_sample(sample)
        result['categories'][1]['memoryMiB']=-1
        with self.assertRaises(Error):validate_sample(sample)

    def test_environment_failures_are_actionable_and_redact_backend_output(self):
        config={**self.offer,'provider':'apple','storage':self.temp.name,'templates':[],'runner':'/missing/runner'}
        provider=type('Fake',(),{'check':lambda self:None})()
        with patch('canaveral.host_health.platform.system',return_value='Linux'):
            result=inspect(config,provider,self.temp.name)
        self.assertEqual(result['status'],'failed')
        self.assertIn('skipped',[c['status'] for c in result['checks']])
        config.update(provider='kubevirt',namespace='guests')
        with patch('canaveral.host_health.shutil.which',return_value='/kubectl'),patch.object(provider,'check',side_effect=Error('SECRET-DO-NOT-REPORT')):
            result=inspect(config,provider,self.temp.name)
        self.assertEqual(result['status'],'failed')
        self.assertNotIn('SECRET-DO-NOT-REPORT',json.dumps(result))


class InfrastructureHTTPTests(DashboardFixture):
    def test_scoped_setup_cannot_read_inventory_or_create_another_setup(self):
        admin=Client(self.upstream,self.admin)
        setup=admin.request('POST','/v1/connection-setups',{'id':str(uuid.uuid4()),**host_offer()})
        client=Client(self.upstream,setup['enrollmentToken'])
        for path in ('/v1/hosts','/v1/connection-setups'):
            with self.assertRaises(Error):client.request('GET',path)
        client.request('POST','/v1/hosts/enroll',{'id':str(uuid.uuid4()),'credential':secrets.token_urlsafe(32),'offer':host_offer()})
        with self.assertRaises(Error):client.request('POST','/v1/connection-setups',{'id':str(uuid.uuid4()),**host_offer()})
