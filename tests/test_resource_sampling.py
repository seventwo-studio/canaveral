import copy
import threading
import time
from pathlib import Path
from unittest.mock import Mock,patch

from canaveral.host import Agent
from canaveral.lease_clock import contact_fresh
from canaveral.model import Error
from test_dashboard import DashboardFixture
from test_devices import config


class ResourceSamplingTests(DashboardFixture):
    def setUp(self):
        super().setUp();self.agent=Agent(config(),self.upstream,Path(self.temp.name)/'runner')
        self.agent.connect(self.enrollment)
        self.agent.health={'status':'passed','checkedAt':self.now,'checks':[]}
        self.observation={'scope':'host','domain':'fixture','sampledAt':self.now,'cpuPercent':1}

    def test_blocked_collector_does_not_delay_repeated_real_heartbeats_or_spawn_replacements(self):
        entered=threading.Event();release=threading.Event();completed=threading.Event();errors=[]
        def blocked(*args,**kwargs):entered.set();release.wait(5);return self.observation
        with patch('canaveral.host_health.sample',side_effect=blocked) as sample:
            worker=threading.Thread(target=self.agent.resource_work,daemon=True);worker.start()
            def heartbeat():
                try:
                    for _ in range(3):self.agent.poll()
                except Exception as error:errors.append(error)
                finally:completed.set()
            poller=threading.Thread(target=heartbeat)
            try:
                self.assertTrue(entered.wait(1));poller.start()
                self.assertTrue(completed.wait(1),'Heartbeat waited behind resource collection')
                self.assertTrue(worker.is_alive());self.assertEqual(errors,[]);sample.assert_called_once()
                self.assertTrue(contact_fresh(self.agent.last_contact))
                self.assertEqual(self.store.host_resources(self.agent.identity['id'])['samples'],[])
            finally:
                self.agent.stopping.set();release.set();worker.join(3)
                if poller.ident:poller.join(3)
            self.assertFalse(worker.is_alive());self.assertIsNone(self.agent.resource_sample)

    def test_cached_observation_eventually_passes_history_throttle_without_freshening_repeats(self):
        original=copy.deepcopy(self.observation)
        with self.agent.lock:self.agent.resource_sample=original;self.agent.resource_generation=1
        self.agent.poll();self.now+=5
        newer={**original,'sampledAt':self.now,'cpuPercent':2}
        with self.agent.lock:self.agent.resource_sample=newer;self.agent.resource_generation=2
        self.agent.poll() # Controller retains its ten-second history interval.
        self.assertEqual(len(self.store.host_resources(self.agent.identity['id'])['samples']),1)
        self.now+=6;self.agent.poll()
        history=self.store.host_resources(self.agent.identity['id'])['samples']
        self.assertEqual(len(history),2);self.assertEqual(history[0]['sampledAt'],1005)
        self.assertEqual(history[0]['receivedAt'],1011)
        self.now+=11;self.agent.poll()
        self.assertEqual(self.store.host_resources(self.agent.identity['id'])['samples'],history)
        self.assertEqual(self.agent.resource_generation,2);self.assertEqual(newer['sampledAt'],1005)

    def test_new_cache_while_request_is_in_flight_is_not_overwritten_by_old_response(self):
        self.agent.resource_sample=copy.deepcopy(self.observation);self.agent.resource_generation=1
        newer={**self.observation,'sampledAt':self.now+11,'cpuPercent':2}
        request=self.agent.client.request;bodies=[]
        def delayed(method,path,value=None):
            bodies.append(copy.deepcopy(value))
            result=request(method,path,value)
            if len(bodies)==1:
                with self.agent.lock:self.agent.resource_sample=newer;self.agent.resource_generation=2
            return result
        with patch.object(self.agent.client,'request',side_effect=delayed):
            self.agent.poll();self.now+=11;self.agent.poll()
        self.assertEqual(bodies[0]['resources']['cpuPercent'],1);self.assertEqual(bodies[1]['resources']['cpuPercent'],2)
        self.assertIs(self.agent.resource_sample,newer)

    def test_lost_heartbeat_response_retries_original_observation_without_new_history_age(self):
        self.agent.resource_sample=copy.deepcopy(self.observation);self.agent.resource_generation=1
        request=self.agent.client.request
        def lost(*args,**kwargs):request(*args,**kwargs);raise Error('Fixture loses response',503)
        with patch.object(self.agent.client,'request',side_effect=lost):
            with self.assertRaises(Error):self.agent.poll()
        before=self.store.host_resources(self.agent.identity['id'])['samples']
        self.now+=11;self.agent.poll()
        self.assertEqual(self.store.host_resources(self.agent.identity['id'])['samples'],before)
        self.assertTrue(contact_fresh(self.agent.last_contact))

    def test_collector_error_keeps_original_time_and_does_not_expose_private_failure(self):
        entered=threading.Event();release=threading.Event();calls=[]
        def collect(*args,**kwargs):
            calls.append(True)
            if len(calls)==1:return self.observation
            entered.set();release.wait(3);self.agent.stopping.set();raise OSError('PRIVATE-RESOURCE-DETAIL')
        with patch('canaveral.host_health.sample',side_effect=collect),self.assertLogs(level='WARNING') as logs:
            worker=threading.Thread(target=self.agent.resource_work,args=(.01,),daemon=True);worker.start()
            try:
                self.assertTrue(entered.wait(1));self.agent.poll();release.set();worker.join(3)
            finally:self.agent.stopping.set();release.set();worker.join(3)
        self.assertEqual(self.agent.resource_generation,1);self.assertEqual(self.agent.resource_sample,self.observation)
        self.assertNotIn('PRIVATE-RESOURCE-DETAIL',' '.join(logs.output));self.assertFalse(worker.is_alive())

    def test_shutdown_does_not_wait_for_blocked_observer_and_discards_its_late_result(self):
        entered=threading.Event();release=threading.Event()
        def blocked(*args,**kwargs):entered.set();release.wait(5);return self.observation
        def stop():
            self.assertTrue(entered.wait(1));self.agent.stopping.set()
        # Exercise real Agent.run thread lifecycle with every runtime/control
        # worker replaced by a no-op. No provider command or real host metric runs.
        names=('connect','check_environment','enforce_access_deadlines','work','image_work')
        from contextlib import ExitStack
        with ExitStack() as stack:
            for name in names:stack.enter_context(patch.object(self.agent,name,return_value=None))
            for runner in (self.agent.access_runner,self.agent.native_lease_updates,self.agent.cleanup_runner):
                stack.enter_context(patch.object(runner,'work',return_value=None))
            stack.enter_context(patch.object(self.agent,'poll',side_effect=stop))
            stack.enter_context(patch('canaveral.host_health.sample',side_effect=blocked))
            started=time.monotonic()
            try:
                self.agent.run();self.assertLess(time.monotonic()-started,2)
                self.assertTrue(self.agent.resource_worker.daemon);self.assertTrue(self.agent.resource_worker.is_alive())
            finally:
                self.agent.stopping.set();release.set();self.agent.resource_worker.join(3)
        self.assertFalse(self.agent.resource_worker.is_alive());self.assertEqual(self.agent.resource_generation,0)
        self.assertIsNone(self.agent.resource_sample)

    def test_invalid_collector_output_cannot_poison_the_next_heartbeat(self):
        entered=threading.Event();release=threading.Event();calls=[]
        self.agent.resource_sample=copy.deepcopy(self.observation);self.agent.resource_generation=1
        def invalid(*args,**kwargs):
            calls.append(True)
            if len(calls)>1:entered.set();release.wait(3)
            return {**self.observation,'PRIVATE-FIELD':'not public telemetry'}
        with patch('canaveral.host_health.sample',side_effect=invalid),self.assertLogs(level='WARNING') as logs:
            worker=threading.Thread(target=self.agent.resource_work,args=(.01,),daemon=True);worker.start()
            try:
                self.assertTrue(entered.wait(1));self.agent.poll()
                self.assertTrue(contact_fresh(self.agent.last_contact))
                self.assertEqual(self.agent.resource_generation,1)
                self.assertEqual(self.agent.resource_sample,self.observation)
            finally:self.agent.stopping.set();release.set();worker.join(3)
        self.assertNotIn('PRIVATE-FIELD',' '.join(logs.output));self.assertFalse(worker.is_alive())
