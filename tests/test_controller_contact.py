import contextlib
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.host import Agent
from canaveral.lease_clock import contact_fresh
from canaveral.lease_guard import LeaseGuard
from test_orchestration import host_offer
from lease_fixture import lease_offer


class ControllerContactTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.agent=Agent(host_offer(),'http://127.0.0.1:1',Path(self.temp.name)/'agent')
        self.agent.identity={'id':str(uuid.uuid4())};self.agent.client=Mock()
        self.agent.lease_guard=Mock()
        self.elapsed=100

    @contextlib.contextmanager
    def clock(self):
        # Awake time stays frozen while the host's continuous clock advances.
        # No actual host sleep, networking or device work occurs in this fixture.
        with patch('canaveral.lease_clock.sys.platform','linux'),\
                patch('canaveral.lease_clock.time.CLOCK_BOOTTIME',7,create=True),\
                patch('canaveral.lease_clock.time.clock_gettime',side_effect=lambda clock:self.elapsed),\
                patch('canaveral.lease_clock.time.monotonic',return_value=50):yield

    def test_suspend_counts_toward_freshness_and_invalid_or_future_contacts_are_denied(self):
        with self.clock():
            for invalid in (None,0,-1,float('nan'),float('inf'),101):self.assertFalse(contact_fresh(invalid))
            self.assertTrue(contact_fresh(100))
            self.elapsed=119.99;self.assertTrue(contact_fresh(100))
            self.elapsed=120;self.assertFalse(contact_fresh(100))

    def test_sleep_during_heartbeat_counts_in_rtt_and_cannot_publish_fresh_work(self):
        def response(*args):self.elapsed=125;return {'machines':[]}
        self.agent.client.request.side_effect=response
        with self.clock():
            self.agent.poll()
            self.assertEqual(self.agent.lease_guard.observe.call_args.args[1],25)
            self.assertEqual(self.agent.last_contact,100)
            self.assertFalse(contact_fresh(self.agent.last_contact))
            self.assertTrue(self.agent.inference_cancelled('fixture-job'))

    def test_delayed_authorization_has_its_real_elapsed_duration_removed(self):
        machine={'id':str(uuid.uuid4()),'desired':'running','lease':{'id':str(uuid.uuid4()),'state':'ready',
            'revision':1,'controllerNow':1000,'authorizationDeadline':1020}}
        guard=LeaseGuard(Path(self.temp.name)/'guard',clock=lambda:1000)
        self.agent.lease_guard=guard
        def response(*args):self.elapsed=125;return {'machines':[machine]}
        self.agent.client.request.side_effect=response
        with self.clock():
            self.agent.poll()
            self.assertFalse(guard.allowed(machine['id']))

    def test_slow_local_processing_is_not_new_contact_and_fresh_heartbeat_recovers(self):
        self.agent.client.request.side_effect=lambda *args:({'machines':[]})
        self.agent.refresh_images=Mock(side_effect=lambda:setattr(self,'elapsed',125))
        with self.clock():
            self.agent.poll()
            self.assertEqual(self.agent.lease_guard.observe.call_args.args[1],0)
            self.assertFalse(contact_fresh(self.agent.last_contact))
            self.agent.refresh_images.side_effect=None
            self.agent.poll()
            self.assertTrue(contact_fresh(self.agent.last_contact))
            self.assertFalse(self.agent.inference_cancelled('fixture-job'))

    def test_sleep_closes_existing_broker_access_and_refuses_new_attachment(self):
        self.agent.offer=lease_offer(host_offer()) # Explicit fixture support; no live protocol is enabled.
        machine={'id':str(uuid.uuid4()),'desired':'running','ready':True,'template':self.agent.offer['templates'][0],
                 'lease':{'id':str(uuid.uuid4()),'state':'ready'}}
        job={'id':str(uuid.uuid4()),'generation':str(uuid.uuid4()),'machineId':machine['id'],'leaseId':machine['lease']['id'],'capability':'pty'}
        new_job={**job,'id':str(uuid.uuid4()),'generation':str(uuid.uuid4())}
        self.agent.assignments=[machine];self.agent.access_sessions=[job,new_job];self.agent.last_contact=100
        self.agent.context=Mock();session=Mock(job=job);session.thread.is_alive.return_value=True
        self.agent.access_runner.sessions[job['id']]=session
        with self.clock():
            self.assertTrue(self.agent.access_runner.authorized(job))
            self.assertTrue(self.agent.access_runner.authorized(new_job))
            pinned=machine.pop('template')
            self.assertFalse(self.agent.access_runner.authorized(job))
            machine['template']=pinned
            self.elapsed=125
            self.agent.access_runner.step()
            session.close.assert_called_once()
            self.assertFalse(self.agent.access_runner.authorized(job))
            self.agent.context.assert_not_called()

    def test_stale_contact_does_not_begin_vm_reconciliation_or_device_operations(self):
        class OneIteration:
            calls=0
            def wait(self,timeout):self.calls+=1;return self.calls>1
            def is_set(self):return False
        self.agent.stopping=OneIteration();self.agent.last_contact=100
        self.agent.assignments=[{'id':str(uuid.uuid4()),'desired':'running'}]
        self.agent.lease_guard.assignments.return_value=self.agent.assignments
        self.agent.reconcile=Mock();self.agent.sweep_connections=Mock();self.agent.context=Mock()
        self.agent.device_operations=[{'id':str(uuid.uuid4())}]
        with self.clock():
            self.elapsed=125;self.agent.work()
        self.agent.reconcile.assert_not_called();self.agent.context.assert_not_called()
        self.agent.sweep_connections.assert_called_once_with(set())

    def test_image_batch_rechecks_contact_before_starting_the_next_job(self):
        class OneIteration:
            calls=0
            def wait(self,timeout):self.calls+=1;return self.calls>1
            def is_set(self):return False
        self.agent.stopping=OneIteration();self.agent.last_contact=100
        first,second=({'id':str(uuid.uuid4()),'kind':'registry'} for _ in range(2))
        self.agent.image_tasks=[first,second]
        def process(job):self.elapsed=125;return {'state':'succeeded'}
        self.agent.registry_import=Mock(side_effect=process)
        with self.clock():self.agent.image_work()
        self.agent.registry_import.assert_called_once_with(first)
        self.assertNotIn(second['id'],self.agent.image_reports)
