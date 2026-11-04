"""Pre-execution reclamation fixtures; no provider or device is launched."""
import copy
import json
import secrets
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from canaveral.assignment_gate import assignment_access, paths
from canaveral.client import Client
from canaveral.display_access import DisplayControls
from canaveral.files import save_json
from canaveral.host import Agent
from canaveral.lease_cleanup import cleanup_assignment
from canaveral.lease_guard import LeaseGuard
from canaveral.model import Error
from canaveral.owned_removal import assignment_fingerprint
from lease_fixture import lease_offer
from test_consumers import application
from test_dashboard import DashboardFixture
from test_leases import acquire
from test_orchestration import host_offer


class UnstartedLeaseCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.guard_root = self.root/'guard'
        self.machine = {'id': str(uuid.uuid4()), 'desired': 'stopped', 'template': {'id': 'fixture'},
            'resources': {'cpu': 1, 'memoryMiB': 512, 'diskGiB': 4},
            'lease': {'id': str(uuid.uuid4()), 'state': 'released', 'revision': 2,
                      'authorizationDeadline': 160, 'controllerNow': 100}}
        self.machine['leaseCleanup'] = {'id': str(uuid.uuid4()), 'leaseId': self.machine['lease']['id'],
                                       'attempts': 0, 'notBefore': 0}
        self.folder = self.root/'assignments'/self.machine['id']; self.folder.mkdir(parents=True)
        self.storage = self.root/'disks'/self.machine['id']; self.storage.mkdir(parents=True)
        self.fingerprint = assignment_fingerprint(self.machine)
        save_json(self.folder/'assignment.json', {'fingerprint': self.fingerprint, 'leaseId': self.machine['lease']['id']})
        save_json(self.folder/'credentials.json', {'secret': 'private-unstarted-fixture'})
        save_json(self.storage/'canaveral-owner.json', {'fingerprint': self.fingerprint})
        self.runtime = SimpleNamespace(config={'provider': 'libvirt', 'storage': str(self.storage.parent)}, access=None,
            reconcile=Mock(side_effect=AssertionError('No native reconciliation for unstarted resources')),
            remove_owned_storage=Mock(side_effect=AssertionError('No native storage remover for unstarted resources')))
        self.guard = self.new_guard(); self.observe_active(); self.guard.observe([self.machine], 0)
        self.agent = SimpleNamespace(access_runner=Mock(), display_controls=DisplayControls(self.root/'displays.json'), lease_guard=self.guard)
        self.receipt = paths(self.folder, self.machine['id'])[1]

    def new_guard(self):
        return LeaseGuard(self.guard_root, clock=lambda: 100, monotonic=lambda: 10)

    def observe_active(self):
        active = copy.deepcopy(self.machine); active['desired'] = 'running'; active.pop('leaseCleanup')
        active['lease'].update(state='provisioning', revision=1)
        self.guard.observe([active], 0)
        return active

    def cleanup(self):
        result = cleanup_assignment(self.agent, self.machine, self.runtime, {}, self.folder)
        self.runtime.reconcile.assert_not_called(); self.runtime.remove_owned_storage.assert_not_called()
        return result

    def test_unstarted_nonapple_assignment_erases_only_owned_empty_storage_and_credentials(self):
        keep = self.root/'retained'; keep.mkdir(); (keep/'disk').write_bytes(b'keep')
        first = self.cleanup()
        self.assertEqual(first['leaseCleanup']['state'], 'complete')
        self.assertFalse(self.folder.exists()); self.assertFalse(self.storage.exists())
        self.assertEqual((keep/'disk').read_bytes(), b'keep'); self.assertEqual(self.cleanup(), first)
        proof = json.loads(self.receipt.read_text()); self.assertEqual(proof['evidence'], 'never-started')
        self.assertNotIn('private-unstarted-fixture', self.receipt.read_text())
        with self.assertRaises(Error):
            with assignment_access(self.machine, self.folder): self.fail('Cleanup must prevent credential recreation')

    def test_runtime_selection_does_not_turn_unstarted_cleanup_into_native_teardown(self):
        for provider in ('android', 'ios', 'hyperv', 'kubevirt', 'libvirt'):
            with self.subTest(provider=provider):
                self.runtime.config['provider'] = provider
                result = self.cleanup()
                self.assertEqual(result['leaseCleanup']['state'], 'complete')

    def test_possible_execution_still_requires_supported_native_cleanup(self):
        # A separately observed active assignment with execution begun cannot
        # use the empty-storage shortcut, even after it becomes terminal.
        self.guard_root.joinpath('lease-execution.json').unlink()
        self.guard = self.new_guard(); active = self.observe_active()
        self.guard.begin_execution(active['id'], active['lease']['id'])
        self.guard.observe([self.machine], 0); self.agent.lease_guard = self.guard
        result = self.cleanup()
        self.assertEqual(result['leaseCleanup']['reason'], 'unsupported')
        self.assertTrue(self.storage.exists()); self.assertTrue((self.folder/'credentials.json').exists())

    def test_missing_history_is_not_unstarted_evidence(self):
        self.guard_root.joinpath('lease-execution.json').unlink()
        save_json(self.guard_root/'identity.json', {'id': str(uuid.uuid4())})
        self.guard = self.new_guard(); self.observe_active(); self.guard.observe([self.machine], 0)
        self.agent.lease_guard = self.guard
        self.assertEqual(self.cleanup()['leaseCleanup']['reason'], 'unsupported')
        self.assertTrue(self.folder.exists()); self.assertTrue(self.storage.exists())

    def test_unexpected_storage_content_is_retained_despite_unstarted_guard(self):
        (self.storage/'disk.qcow2').write_bytes(b'unexplained guest contents')
        result = self.cleanup(); self.assertEqual(result['leaseCleanup']['reason'], 'ownership')
        self.assertEqual((self.storage/'disk.qcow2').read_bytes(), b'unexplained guest contents')
        self.assertTrue((self.folder/'credentials.json').exists())

    def test_wrong_lease_or_storage_ownership_never_erases(self):
        for location, value in ((self.folder/'assignment.json', {'fingerprint': self.fingerprint, 'leaseId': str(uuid.uuid4())}),
                                (self.storage/'canaveral-owner.json', {'fingerprint': 'foreign'})):
            original = location.read_text(); save_json(location, value)
            with self.subTest(location=location.name):
                self.assertEqual(self.cleanup()['leaseCleanup']['reason'], 'ownership')
                self.assertTrue((self.folder/'credentials.json').exists()); self.assertTrue(self.storage.exists())
            location.write_text(original)

    def test_existing_deletion_or_removal_quarantine_is_contradictory(self):
        for path in (self.folder/'deletion.json', self.storage.parent/('.removing-'+self.machine['id']+'-foreign')):
            path.write_text('{}')
            with self.subTest(path=path.name):
                self.assertEqual(self.cleanup()['leaseCleanup']['state'], 'blocked')
                self.assertTrue((self.folder/'credentials.json').exists()); self.assertTrue(self.storage.exists())
            path.unlink()

    def test_active_assignment_reader_blocks_cleanup_and_new_work(self):
        with assignment_access(self.machine, self.folder):
            self.assertEqual(self.cleanup()['leaseCleanup']['reason'], 'operations_pending')
            self.assertTrue(self.storage.exists())
            with self.assertRaises(Error):
                with assignment_access(self.machine, self.folder): self.fail('New work admitted after cleanup intent')
        self.assertEqual(self.cleanup()['leaseCleanup']['state'], 'complete')

    def test_restart_recovers_credential_erasure_after_storage_was_removed(self):
        with patch('canaveral.lease_cleanup.os.rename', side_effect=OSError('Fixture interruption')):
            self.assertEqual(self.cleanup()['leaseCleanup']['state'], 'blocked')
        self.assertFalse(self.storage.exists()); self.assertTrue((self.folder/'credentials.json').exists())
        proof = json.loads(self.receipt.read_text())
        self.assertEqual((proof['phase'], proof['evidence']), ('erasing', 'never-started'))
        self.agent.lease_guard = self.new_guard()
        self.assertEqual(self.cleanup()['leaseCleanup']['state'], 'complete')
        self.assertFalse(self.folder.exists())

    def test_missing_storage_needs_positive_guard_and_complete_storage_cannot_reappear(self):
        (self.storage/'canaveral-owner.json').unlink(); self.storage.rmdir()
        self.assertEqual(self.cleanup()['leaseCleanup']['state'], 'complete')
        self.storage.mkdir(); (self.storage/'foreign').write_text('retain')
        self.assertEqual(self.cleanup()['leaseCleanup']['reason'], 'recovery')
        self.assertEqual((self.storage/'foreign').read_text(), 'retain')

    def test_recovered_nonapple_receipt_without_unstarted_evidence_cannot_authorize_erasure(self):
        self.receipt.parent.mkdir()
        save_json(self.receipt, {'id': self.machine['leaseCleanup']['id'], 'machineId': self.machine['id'],
            'leaseId': self.machine['lease']['id'], 'fingerprint': self.fingerprint, 'phase': 'storageRemoved', 'attempt': 1})
        self.assertEqual(self.cleanup()['leaseCleanup']['reason'], 'unsupported')
        self.assertTrue(self.folder.exists()); self.assertTrue(self.storage.exists())


class UnstartedLeaseCleanupHTTPTests(DashboardFixture):
    def test_unstarted_release_reclaims_quota_only_after_credential_erasure_ack(self):
        host = str(uuid.uuid4()); host_key = secrets.token_urlsafe(32); offer = lease_offer(host_offer())
        self.store.enroll({'id': host, 'credential': host_key, 'offer': offer})
        policy = application(); policy['limits']['resources']['diskGiB'] = 4
        consumer = self.store.create_consumer(policy); client = Client(self.upstream, consumer['credential'])
        lease = client.request('POST', '/v1/leases', acquire()); machine_id = lease['members'][0]['machineId']
        root = Path(self.temp.name)/'unstarted-runner'; folder = root/'machines'/machine_id
        # Synthetic catalogue/runner fixture only. Production Agent still
        # rejects leaseProtocol and no native libvirt process is created.
        agent = Agent({k: v for k, v in offer.items() if k not in ('leaseProtocol', 'leaseImages')}, self.upstream, root/'agent')
        agent.identity = {'id': host, 'credential': host_key}; agent.client = Client(self.upstream, host_key); agent.offer = offer
        agent.lease_guard = LeaseGuard(root/'guard', clock=lambda: self.now)
        runtime = SimpleNamespace(config={'provider': 'libvirt', 'storage': str(root/'disks')}, access=None,
            reconcile=Mock(side_effect=AssertionError('No native runtime needed')),
            remove_owned_storage=Mock(side_effect=AssertionError('No native disk created')))
        agent.context = Mock(side_effect=lambda machine: (runtime, {}, root/'machines'/machine['id']))
        agent.poll(); machine = agent.assignments[0]
        save_json(folder/'assignment.json', {'fingerprint': assignment_fingerprint(machine), 'leaseId': lease['id']})
        save_json(folder/'credentials.json', {'secret': 'private fixture credentials'})
        client.request('POST', '/v1/leases/'+lease['id']+'/release', {'id': str(uuid.uuid4())})
        agent.poll(); terminal = agent.assignments[0]
        with patch('canaveral.lease_cleanup.os.rename', side_effect=OSError('Fixture credential erasure failure')):
            blocked = agent.reconcile(terminal)
        self.assertEqual(blocked['leaseCleanup']['state'], 'blocked')
        agent.reports[machine_id] = blocked; agent.poll()
        self.assertEqual(self.store.host_resources(host)['reserved']['diskGiB'], 4)
        with self.assertRaises(Error): client.request('POST', '/v1/leases', acquire())
        complete = agent.reconcile(terminal); self.assertEqual(complete['leaseCleanup']['state'], 'complete')
        self.assertFalse(folder.exists()); agent.reports[machine_id] = complete; agent.poll()
        self.assertEqual(self.store.host_resources(host)['reserved']['diskGiB'], 0)
        self.assertEqual(client.request('GET', '/v1/leases/'+lease['id'])['cleanup']['state'], 'complete')
        fresh = client.request('POST', '/v1/leases', acquire())
        self.assertNotEqual(fresh['members'][0]['machineId'], machine_id)
        runtime.reconcile.assert_not_called(); runtime.remove_owned_storage.assert_not_called()


if __name__ == '__main__': unittest.main()
