import contextlib
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

from canaveral.files import HostLock
from canaveral.host import Agent
from canaveral.lease_clock import execution_monotonic
from canaveral.model import Error
from test_devices import config


class HostWorkerLifecycleTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self,inference=True):
        with tempfile.TemporaryDirectory() as directory:
            agent=Agent(config(),'http://127.0.0.1:1',Path(directory))
            agent.connect=Mock();agent.sweep_connections=Mock();agent.last_contact=execution_monotonic()
            agent.poll=Mock(side_effect=agent.stopping.set)
            for actor in (agent.access_runner,agent.native_lease_updates,agent.cleanup_runner,agent.display_controls):actor.close=Mock()
            if inference:agent.inference_runner=SimpleNamespace(check=Mock())
            yield agent

    def factory(self,agent,failed=None,mode='start',error=None,join_failure=None):
        created=[];joined=[];error=error if error is not None else RuntimeError('Fixture startup failure')
        class Thread:
            def __init__(self,index,**kwargs):self.index=index;self.ident=None;self.target=kwargs['target'];self.daemon=kwargs['daemon']
            def start(self):
                if self.index==failed and mode=='start':raise error
                self.ident=self.index
                if self.index==failed and mode=='after-start':raise error
            def join(self,timeout):
                joined.append((self.index,timeout))
                if self.ident is None:raise AssertionError('Unstarted worker was joined')
                if not agent.stopping.is_set():raise AssertionError('Worker joined before stop')
                if self.index==join_failure:raise OSError('PRIVATE-JOIN-DETAIL')
        def make(**kwargs):
            index=len(created)+1
            if index==failed and mode=='construct':raise error
            thread=Thread(index,**kwargs);created.append(thread);return thread
        return make,created,joined,error

    def assert_cleanup(self,agent,created,joined):
        self.assertTrue(agent.stopping.is_set());self.assertTrue(agent.check_requested.is_set())
        self.assertEqual({i for i,_ in joined},{t.index for t in created if t.ident is not None})
        self.assertEqual(len(joined),len({i for i,_ in joined}))
        for actor in (agent.access_runner,agent.native_lease_updates,agent.cleanup_runner,agent.display_controls):actor.close.assert_called_once()
        self.assertEqual(agent.sweep_connections.call_count,2)
        with HostLock(agent.state_dir/'agent.lock'):pass

    def test_start_failure_at_each_boundary_stops_started_workers_and_releases_lock(self):
        for boundary in range(1,10):
            with self.subTest(boundary=boundary),self.fixture() as agent:
                factory,created,joined,failure=self.factory(agent,boundary)
                with patch('canaveral.host.threading.Thread',side_effect=factory):
                    with self.assertRaises(RuntimeError) as error:agent.run()
                self.assertIs(error.exception,failure);self.assert_cleanup(agent,created,joined)
                agent.poll.assert_not_called()

    def test_constructor_failure_at_each_boundary_uses_only_existing_handles(self):
        for boundary in range(1,10):
            with self.subTest(boundary=boundary),self.fixture() as agent:
                factory,created,joined,failure=self.factory(agent,boundary,mode='construct')
                with patch('canaveral.host.threading.Thread',side_effect=factory):
                    with self.assertRaises(RuntimeError) as error:agent.run()
                self.assertIs(error.exception,failure);self.assert_cleanup(agent,created,joined)

    def test_start_cancellation_before_and_after_bootstrap_is_preserved(self):
        for mode in ('start','after-start'):
            with self.subTest(mode=mode),self.fixture() as agent:
                factory,created,joined,failure=self.factory(agent,2,mode,error=KeyboardInterrupt())
                with patch('canaveral.host.threading.Thread',side_effect=factory):
                    with self.assertRaises(KeyboardInterrupt) as error:agent.run()
                self.assertIs(error.exception,failure);self.assert_cleanup(agent,created,joined)

    def test_exception_after_start_still_joins_the_ambiguous_worker(self):
        with self.fixture() as agent:
            factory,created,joined,failure=self.factory(agent,4,mode='after-start')
            with patch('canaveral.host.threading.Thread',side_effect=factory):
                with self.assertRaises(RuntimeError) as error:agent.run()
            self.assertIs(error.exception,failure);self.assert_cleanup(agent,created,joined)
            self.assertIn((4,310),joined)

    def test_cleanup_errors_do_not_mask_start_failure_or_skip_later_cleanup(self):
        with self.fixture() as agent:
            factory,created,joined,failure=self.factory(agent,8,join_failure=6)
            agent.access_runner.close.side_effect=OSError('PRIVATE-CLOSE-DETAIL')
            with patch('canaveral.host.threading.Thread',side_effect=factory),self.assertLogs(level='WARNING') as logs:
                with self.assertRaises(RuntimeError) as error:agent.run()
            self.assertIs(error.exception,failure);self.assert_cleanup(agent,created,joined)
            self.assertNotIn('PRIVATE-', ' '.join(logs.output))

    def test_normal_shutdown_cleanup_error_is_explicit_unknown_after_remaining_steps(self):
        with self.fixture() as agent:
            factory,created,joined,_=self.factory(agent,join_failure=6)
            agent.access_runner.close.side_effect=OSError('PRIVATE-CLOSE-DETAIL')
            with patch('canaveral.host.threading.Thread',side_effect=factory),self.assertLogs(level='WARNING') as logs:
                with self.assertRaises(Error) as error:agent.run()
            self.assertEqual((error.exception.code,error.exception.outcome,error.exception.retryable),('host_shutdown_incomplete','unknown',False))
            self.assert_cleanup(agent,created,joined);self.assertNotIn('PRIVATE-', ' '.join(logs.output))

    def test_normal_shutdown_preserves_role_join_budgets_and_optional_inference(self):
        for inference in (False,True):
            with self.subTest(inference=inference),self.fixture(inference=inference) as agent:
                factory,created,joined,_=self.factory(agent)
                with patch('canaveral.host.threading.Thread',side_effect=factory):agent.run()
                self.assert_cleanup(agent,created,joined)
                self.assertEqual(dict(joined),{**{1:1,2:1,3:5,4:310,5:310,6:5,7:2,8:2},**({9:150} if inference else {})})
                self.assertTrue(all(thread.daemon for thread in created))

    def test_real_started_waiters_stop_after_later_start_failure(self):
        with self.fixture(inference=False) as agent:
            entered=[threading.Event(),threading.Event()];exited=[threading.Event(),threading.Event()]
            def wait(index):
                entered[index].set();agent.stopping.wait(5);exited[index].set()
            agent.check_environment=lambda:wait(0);agent.resource_work=lambda:wait(1)
            real=threading.Thread;created=[]
            class Failed:
                ident=None
                def start(self):
                    if not all(event.wait(1) for event in entered):raise AssertionError('Fixture workers did not start')
                    raise RuntimeError('Fixture later start failure')
            def factory(**kwargs):
                if len(created)==2:thread=Failed()
                else:thread=real(**kwargs)
                created.append(thread);return thread
            try:
                with patch('canaveral.host.threading.Thread',side_effect=factory):
                    with self.assertRaises(RuntimeError):agent.run()
                self.assertTrue(all(event.is_set() for event in exited))
                self.assertTrue(all(not thread.is_alive() for thread in created[:2]))
                with HostLock(agent.state_dir/'agent.lock'):pass
            finally:
                agent.stopping.set()
                for thread in created[:2]:thread.join(3)

    def test_environment_worker_cannot_lose_shutdown_wake_during_initial_clear(self):
        with self.fixture(inference=False) as agent:
            entered=threading.Event();release=threading.Event();clear=agent.check_requested.clear
            def delayed_clear():entered.set();release.wait(3);clear()
            with patch.object(agent.check_requested,'clear',side_effect=delayed_clear),patch('canaveral.host_health.inspect') as inspect:
                worker=threading.Thread(target=agent.check_environment,daemon=True);worker.start()
                try:
                    self.assertTrue(entered.wait(1));agent.stopping.set();agent.check_requested.set();release.set();worker.join(1)
                    self.assertFalse(worker.is_alive());inspect.assert_not_called();self.assertIsNone(agent.health)
                finally:agent.stopping.set();release.set();agent.check_requested.set();worker.join(2)

    def test_environment_result_returning_after_stop_is_not_published_or_followed_by_more_probes(self):
        with self.fixture(inference=False) as agent:
            entered=threading.Event();release=threading.Event()
            def delayed(*args):entered.set();release.wait(3);return {'status':'passed','checkedAt':1,'checks':[]}
            with patch('canaveral.host_health.inspect',side_effect=delayed),patch.object(agent.provider,'resource_report',create=True) as resources:
                worker=threading.Thread(target=agent.check_environment,daemon=True);worker.start()
                try:
                    self.assertTrue(entered.wait(1));agent.stopping.set();agent.check_requested.set();release.set();worker.join(1)
                    self.assertFalse(worker.is_alive());resources.assert_not_called()
                    self.assertIsNone(agent.health);self.assertIsNone(agent.cluster_report)
                finally:agent.stopping.set();release.set();agent.check_requested.set();worker.join(2)
