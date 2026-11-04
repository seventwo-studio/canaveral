from canaveral.lease_clock import execution_monotonic
import copy
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
from types import SimpleNamespace

from canaveral.host import Agent
from canaveral.lease_guard import LeaseGuard
from canaveral.model import Error
from canaveral.shell_sessions import ShellSessions
from test_orchestration import host_offer


class LeaseGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.wall=1000;self.mono=10
        self.machine={'id':str(uuid.uuid4()),'desired':'running','lease':{'id':str(uuid.uuid4()),'revision':1,'state':'ready','authorizationDeadline':1060,'controllerNow':1000}}
        self.guard=LeaseGuard(self.temp.name,clock=lambda:self.wall,monotonic=lambda:self.mono)

    def test_offline_monotonic_deadline_cannot_be_extended_by_replay_or_late_renewal(self):
        self.guard.observe([self.machine],2)
        self.mono=67;self.wall=500 # Host wall-clock rollback cannot extend live authorization.
        self.assertTrue(self.guard.allowed(self.machine['id']))
        self.mono=68;self.assertFalse(self.guard.allowed(self.machine['id']))
        renewed=copy.deepcopy(self.machine);renewed['lease'].update(revision=2,authorizationDeadline=1200,controllerNow=1010)
        self.wall=1010;self.guard.observe([renewed],0)
        self.assertFalse(self.guard.allowed(self.machine['id']))

    def test_stale_revision_and_clock_skew_do_not_restore_or_extend_execution(self):
        self.guard.observe([self.machine],0)
        newer=copy.deepcopy(self.machine);newer['lease'].update(revision=2,authorizationDeadline=1100)
        self.guard.observe([newer],0)
        self.guard.observe([self.machine],0)
        self.mono=71;self.assertTrue(self.guard.allowed(self.machine['id']))
        self.mono=110;self.assertFalse(self.guard.allowed(self.machine['id']))
        other=copy.deepcopy(self.machine);other['id']=str(uuid.uuid4());other['lease']['controllerNow']=900
        self.guard.observe([other],0);self.assertFalse(self.guard.allowed(other['id']))

    def test_restart_expiry_missing_assignment_and_unleased_machine_isolation(self):
        self.guard.observe([self.machine],0)
        self.wall=1060
        recovered=LeaseGuard(self.temp.name,clock=lambda:self.wall,monotonic=lambda:self.mono)
        self.assertFalse(recovered.allowed(self.machine['id']))
        self.wall=1020
        again=LeaseGuard(self.temp.name,clock=lambda:self.wall,monotonic=lambda:self.mono)
        self.assertFalse(again.allowed(self.machine['id']))
        ordinary={'id':str(uuid.uuid4()),'desired':'running'}
        assignments=recovered.assignments([ordinary]);self.assertEqual(next(m for m in assignments if m['id']==ordinary['id'])['desired'],'running')
        self.assertEqual(next(m for m in assignments if m['id']==self.machine['id'])['desired'],'stopped')
        self.guard.observe([],0);self.assertFalse(self.guard.allowed(self.machine['id']))

    def test_agent_reconciles_only_fenced_lease_stops_while_offline(self):
        agent=Agent(host_offer(),'http://127.0.0.1:1',Path(self.temp.name)/'agent')
        agent.lease_guard=self.guard;self.guard.observe([self.machine],0);self.mono=70
        ordinary={'id':str(uuid.uuid4()),'desired':'running'}
        agent.assignments=[self.machine,ordinary];agent.last_contact=execution_monotonic()-30
        agent.sweep_connections=Mock()
        def reconcile(machine):agent.stopping.set();return {'state':'stopping'}
        agent.reconcile=Mock(side_effect=reconcile)
        worker=threading.Thread(target=agent.work,daemon=True);worker.start();worker.join(3)
        self.assertFalse(worker.is_alive());agent.reconcile.assert_called_once()
        called=agent.reconcile.call_args.args[0]
        self.assertEqual(called['id'],self.machine['id']);self.assertEqual(called['desired'],'stopped')
        self.assertTrue(agent.reports[self.machine['id']]['leaseFenced'])

    def test_configuration_cannot_opt_an_incomplete_runner_into_lease_admission(self):
        with self.assertRaises(Error):Agent({**host_offer(),'leaseProtocol':1},'http://127.0.0.1:1',Path(self.temp.name)/'agent')

    def test_changed_lease_owner_fences_the_original_assignment_immediately(self):
        self.guard.observe([self.machine],0)
        changed=copy.deepcopy(self.machine);changed['lease']['id']=str(uuid.uuid4())
        with self.assertRaises(Error):self.guard.observe([changed],0)
        self.assertFalse(self.guard.allowed(self.machine['id']))

    def test_deadline_watcher_revokes_pty_while_reconciliation_is_blocked(self):
        agent=Agent(host_offer(),'http://127.0.0.1:1',Path(self.temp.name)/'deadline-agent')
        agent.lease_guard=self.guard;self.guard.observe([self.machine],0)
        shells=ShellSessions();self.addCleanup(lambda:shells.sweep(active=set()))
        session=str(uuid.uuid4());ordinary=str(uuid.uuid4())
        shells.open(self.machine['id'],session,['/bin/cat']);shells.open('administrative',ordinary,['/bin/cat'])
        process=shells.sessions[(self.machine['id'],session)]['process']
        agent.runtime_providers=Mock(return_value=[SimpleNamespace(shells=shells)])
        agent.sweep_connections=Mock();agent.assignments=[self.machine];agent.last_contact=execution_monotonic()
        entered=threading.Event();release=threading.Event()
        def reconcile(machine):entered.set();release.wait(5);return {'state':'running'}
        agent.reconcile=Mock(side_effect=reconcile)
        worker=threading.Thread(target=agent.work,daemon=True)
        watcher=threading.Thread(target=agent.enforce_access_deadlines,daemon=True)
        worker.start();watcher.start()
        try:
            self.assertTrue(entered.wait(2));self.mono=70
            until=time.monotonic()+2
            while time.monotonic()<until and process.poll() is None:time.sleep(.02)
            self.assertIsNotNone(process.poll());self.assertTrue(worker.is_alive())
            self.assertFalse(release.is_set())
            with self.assertRaises(Error):shells.open(self.machine['id'],str(uuid.uuid4()),['/bin/cat'])
            self.assertIn(('administrative',ordinary),shells.sessions)
        finally:
            agent.stopping.set();release.set();worker.join(3);watcher.join(3)
        self.assertFalse(worker.is_alive());self.assertFalse(watcher.is_alive())
