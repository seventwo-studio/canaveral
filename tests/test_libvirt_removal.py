import copy
import json
import os
import shutil
import uuid
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from canaveral.libvirt_removal import remove_storage
from canaveral.libvirt_storage_handles import StorageHandleGuard, StorageHandlesUnknown
from canaveral.libvirt_supervision import SupervisorJournal
from canaveral.model import Error
from canaveral.lease_cleanup import cleanup_assignment
from canaveral.assignment_gate import paths
from canaveral.files import save_json
from canaveral.providers.libvirt import Libvirt
from test_libvirt_execution import ExecutionFixture
from test_libvirt_storage_handles import FakeLease


class RemovalConnection:
    def __init__(self, driver): self.driver = driver
    def validate(self, binding, active):
        if self.driver['present'] is not True or self.driver.get('active'):
            raise Error('fixture domain not inactive', 409)
    def absent(self):
        if self.driver.get('unknown'): raise Error('fixture native query unknown', 409)
        return not self.driver['present']
    def retire(self, binding):
        self.validate(binding, False)
        self.driver['retirements'] += 1; self.driver['present'] = False
        if self.driver.get('lostAck'): raise Error('fixture lost undefine acknowledgement', 409)
    def close(self):
        if self.driver.get('closeFails'): raise Error('fixture close failure', 409)


class RemovalFixture(ExecutionFixture):
    def setUp(self):
        super().setUp(); self.prepare(); self.publish(stopping=True)
        self.machine['desired'] = 'stopped'; self.machine['lease']['state'] = 'expired'
        self.request = str(uuid.uuid4())
        self.machine['leaseCleanup'] = {'id': self.request, 'leaseId': self.machine['lease']['id'], 'attempts': 0, 'notBefore': 0}
        self.driver = {'present': True, 'retirements': 0}
        self.factory = Mock(side_effect=lambda *_: RemovalConnection(self.driver))
        self.quarantine = self.storage.with_name('.removing-'+self.machine['id']+'-'+self.request)
        self.leases = []
        self.guard = self.make_guard

    def make_guard(self, path, expected):
        def lease(fd):
            result = FakeLease(fd); self.leases.append(result); return result
        return StorageHandleGuard(path, expected, lease)

    def remove(self, **kwargs):
        return remove_storage(self.machine, self.folder, self.request, lambda *_: True,
            connection_factory=self.factory, host_boot=lambda: self.host_boot, guard_factory=self.guard, **kwargs)

    def receipt(self): return json.loads((self.folder/'deletion.json').read_text())


class LibvirtRemovalTests(RemovalFixture):
    def test_owned_disk_firmware_tpm_removed_credentials_retained_and_repeat_is_observed(self):
        (self.storage/'nvram.fd').write_bytes(b'private nvram')
        (self.storage/'tpm-state').mkdir(); (self.storage/'tpm-state'/'state').write_bytes(b'private tpm')
        result = self.remove()
        self.assertEqual(result['state'], 'complete'); self.assertTrue(result['storageRemoved'])
        self.assertFalse(self.storage.exists()); self.assertFalse(self.quarantine.exists())
        self.assertTrue((self.folder/'assignment.json').exists()); self.assertNotIn('credentialsErased', result)
        self.assertTrue(all(lease.closed for lease in self.leases)); self.assertEqual(self.driver['retirements'], 1)
        self.assertEqual(self.remove(), result); self.assertEqual(self.driver['retirements'], 1)

    def test_terminal_intent_and_exact_execution_fence_required(self):
        for key, value in (('desired', 'running'), ('leaseCleanup', {'id': str(uuid.uuid4())})):
            before = copy.deepcopy(self.machine); self.machine[key] = value
            with self.assertRaises(Error): self.remove()
            self.machine = before
        self.driver['active'] = True
        with self.assertRaises(Error): self.remove()
        self.assertTrue(self.disk.exists()); self.assertFalse(self.quarantine.exists())

    def test_live_execution_lock_prevents_native_teardown(self):
        state = SupervisorJournal(self.folder)
        try:
            with self.assertRaises(BlockingIOError): self.remove()
        finally: state.close()
        self.factory.assert_not_called(); self.assertTrue(self.disk.exists())

    def test_missing_birth_does_not_authorize_teardown(self):
        state = SupervisorJournal(self.folder, 'libvirt-launch')
        try: state.write({**self.binding.identity(), 'parentPid': os.getpid()})
        finally: state.close()
        with self.assertRaises(Error): self.remove()
        self.assertTrue(self.disk.exists()); self.assertEqual(self.driver['retirements'], 0)

    def test_lost_undefine_ack_recovers_exact_quarantine_without_repeating_retirement(self):
        self.driver['lostAck'] = True
        with self.assertRaises(Error): self.remove()
        self.assertEqual(self.receipt()['state'], 'quarantined')
        self.assertEqual((self.quarantine/'disk.qcow2').read_bytes(), b'private fake guest disk')
        self.assertEqual(self.remove()['state'], 'complete'); self.assertEqual(self.driver['retirements'], 1)

    def test_rename_ack_loss_recovers_original_inode(self):
        actual = os.rename
        def lost(*args, **kwargs): actual(*args, **kwargs); raise OSError('fixture lost rename acknowledgement')
        with patch('canaveral.libvirt_removal.os.rename', side_effect=lost):
            with self.assertRaises(OSError): self.remove()
        self.assertEqual(self.receipt()['state'], 'planned'); self.assertTrue(self.quarantine.exists())
        self.assertEqual(self.remove()['state'], 'complete')

    def test_content_sync_failure_keeps_manifest_and_every_file_for_recovery(self):
        actual = os.fsync
        # Capture original inode before the storage directory moves.
        inode = self.disk.stat().st_ino
        def fail(fd):
            if os.fstat(fd).st_ino == inode: raise OSError('fixture content sync')
            return actual(fd)
        with patch('canaveral.libvirt_storage_handles.os.fsync', side_effect=fail):
            with self.assertRaises(StorageHandlesUnknown): self.remove()
        self.assertEqual(self.receipt()['state'], 'erasing'); self.assertTrue((self.quarantine/'disk.qcow2').exists())
        self.assertEqual(self.remove()['state'], 'complete')

    def test_missing_disk_during_content_erasure_is_not_inferred_success(self):
        with patch('canaveral.libvirt_storage_handles.os.ftruncate', side_effect=OSError('fixture interrupt')):
            with self.assertRaises(StorageHandlesUnknown): self.remove()
        (self.quarantine/'disk.qcow2').unlink()
        with self.assertRaises(Error): self.remove()
        self.assertEqual(self.receipt()['state'], 'erasing')

    def test_partial_unlink_recovers_only_empty_manifest_owned_files(self):
        actual = shutil.rmtree
        def partial(path):
            (path/'disk.qcow2').unlink(); raise OSError('fixture interrupted unlink')
        # Preserve the platform's safe-rmtree capability on the fake function.
        partial.avoids_symlink_attacks = actual.avoids_symlink_attacks
        with patch('canaveral.libvirt_removal.shutil.rmtree', new=partial):
            with self.assertRaises(OSError): self.remove()
        self.assertEqual(self.receipt()['state'], 'removing'); self.assertTrue(self.receipt()['contentsErased'])
        self.assertTrue(all(p.stat().st_size == 0 for p in self.quarantine.iterdir() if p.is_file()))
        self.assertEqual(self.remove()['state'], 'complete')

    def test_missing_tree_requires_durable_cleared_content_and_removing_stage(self):
        def missing(*_): raise OSError('fixture guard unavailable')
        self.guard = missing
        with self.assertRaises(OSError): self.remove()
        shutil.rmtree(self.quarantine); self.guard = self.make_guard
        with self.assertRaises(Error): self.remove()
        self.assertEqual(self.receipt()['state'], 'quarantined')

    def test_missing_tree_after_owned_removal_ack_loss_can_complete(self):
        actual = shutil.rmtree
        def lost(path): actual(path); raise OSError('fixture lost removal acknowledgement')
        lost.avoids_symlink_attacks = actual.avoids_symlink_attacks
        with patch('canaveral.libvirt_removal.shutil.rmtree', new=lost):
            with self.assertRaises(OSError): self.remove()
        self.assertFalse(self.quarantine.exists()); self.assertEqual(self.receipt()['state'], 'removing')
        self.assertEqual(self.remove()['state'], 'complete')

    def test_manifest_tamper_replaced_file_and_new_contents_block_recovery(self):
        actual = shutil.rmtree
        def interrupted(path): raise OSError('fixture removal interrupted')
        interrupted.avoids_symlink_attacks = actual.avoids_symlink_attacks
        with patch('canaveral.libvirt_removal.shutil.rmtree', new=interrupted):
            with self.assertRaises(OSError): self.remove()
        (self.quarantine/'disk.qcow2').write_bytes(b'new private contents')
        with self.assertRaises(Error): self.remove()
        (self.quarantine/'disk.qcow2').write_bytes(b'')
        manifest = self.folder/'libvirt-removal-manifest.jsonl'; original = manifest.read_bytes()
        manifest.write_bytes(original+b'{}\n')
        with self.assertRaises((Error, KeyError)): self.remove()
        manifest.write_bytes(original)
        (self.quarantine/'disk.qcow2').rename(self.quarantine/'retained-disk')
        (self.quarantine/'disk.qcow2').write_bytes(b'')
        with self.assertRaises(Error): self.remove()

    def test_reappeared_domain_or_storage_blocks_and_reboot_requires_fresh_absence(self):
        result = self.remove(); self.driver['present'] = True
        with self.assertRaises(Error): self.remove()
        self.driver['present'] = False; self.storage.mkdir()
        with self.assertRaises(Error): self.remove()
        self.storage.rmdir(); self.host_boot = str(uuid.uuid4())
        recovered = self.remove()
        self.assertEqual(recovered['state'], 'complete')
        self.assertEqual(recovered['observedHostBootId'], self.host_boot)
        self.assertEqual(recovered['bootId'], result['bootId']) # Original execution identity is retained.

    def test_failed_closed_handles_retains_quarantine_and_never_retires_domain(self):
        self.guard = Mock(side_effect=StorageHandlesUnknown('fixture other handle'))
        with self.assertRaises(StorageHandlesUnknown): self.remove()
        self.assertEqual(self.driver['retirements'], 0)
        self.assertEqual((self.quarantine/'disk.qcow2').read_bytes(), b'private fake guest disk')

    def test_native_unknown_or_observer_close_failure_never_grants_cleanup(self):
        for failure in ('unknown', 'closeFails'):
            self.driver[failure] = True
            with self.assertRaises(Error): self.remove()
            self.driver[failure] = False
        self.assertTrue(self.quarantine.exists() or self.storage.exists())
        self.assertNotEqual(self.receipt()['state'], 'complete')

    def cleanup_context(self):
        runtime = Libvirt({'provider': 'libvirt', 'storage': str(self.storage.parent), 'uri': 'qemu:///session'}, self.root/'runtime')
        runtime.access = None
        runtime.stop_for_cleanup = Mock(return_value={'state': 'stopped'})
        runtime.reconcile = Mock(side_effect=AssertionError('Cleanup must not enter ordinary reconciliation.'))
        agent = SimpleNamespace(access_runner=Mock(),
            display_controls=SimpleNamespace(lock=threading.Lock(), endpoints=[]), lease_guard=Mock())
        agent.lease_guard.never_started.return_value = False
        save_json(self.folder/'access-token.json', {'token': 'private fixture credential'})
        return runtime, agent

    def test_cleanup_pipeline_erases_credentials_only_after_owned_storage_completion(self):
        runtime, agent = self.cleanup_context()
        with patch('canaveral.libvirt_removal.remove_storage', side_effect=lambda *_: self.remove()):
            result = cleanup_assignment(agent, self.machine, runtime, {}, self.folder)
        self.assertEqual(result['leaseCleanup']['state'], 'complete')
        self.assertTrue(all(result['leaseCleanup'][key] for key in ('executionStopped', 'storageRemoved', 'credentialsErased')))
        self.assertFalse(self.folder.exists()); self.assertFalse(self.storage.exists())
        runtime.reconcile.assert_not_called(); runtime.stop_for_cleanup.assert_called_once()
        self.assertEqual(cleanup_assignment(agent, self.machine, runtime, {}, self.folder), result)

    def test_cleanup_pipeline_recovers_native_receipt_and_keeps_credentials_on_unknown_handles(self):
        runtime, agent = self.cleanup_context()
        self.guard = Mock(side_effect=StorageHandlesUnknown('fixture open disk'))
        with patch('canaveral.libvirt_removal.remove_storage', side_effect=lambda *_: self.remove()):
            result = cleanup_assignment(agent, self.machine, runtime, {}, self.folder)
            self.assertEqual(result['leaseCleanup']['state'], 'blocked')
            self.assertEqual((self.folder/'access-token.json').read_text().count('private fixture credential'), 1)
            self.guard = self.make_guard
            result = cleanup_assignment(agent, self.machine, runtime, {}, self.folder)
        self.assertEqual(result['leaseCleanup']['state'], 'complete'); self.assertFalse(self.folder.exists())
        runtime.stop_for_cleanup.assert_called_once() # Recovery uses its exact owned native receipt.

    def test_provider_cleanup_fences_without_acquiring_a_shared_assignment_gate(self):
        runtime, _ = self.cleanup_context()
        del runtime.stop_for_cleanup
        runtime.confirm_execution_stopped = Mock(return_value={'executionStopped': True})
        authorization = Mock(return_value=self.authority)
        with patch('canaveral.libvirt_reboot.fence_cleanup') as publish:
            result = runtime.stop_for_cleanup(self.machine, {'_leaseAuthorization': authorization}, self.folder)
        self.assertEqual(result['state'], 'stopped')
        publish.assert_called_once_with(self.machine, self.folder, authorization, runtime._lease_location_matches)
        runtime.reconcile.assert_not_called()

    def test_completed_receipt_requires_all_erasure_evidence_on_every_recovery(self):
        original = self.remove(); receipt = self.folder/'deletion.json'
        for key, value in (('storageRemoved', False), ('contentsErased', False), ('manifest', None)):
            changed = {**original, key: value}; save_json(receipt, changed)
            with self.subTest(key=key), self.assertRaises(Error): self.remove()
        save_json(receipt, original)
        self.assertEqual(self.remove(), original)

    def test_outer_cleanup_cannot_adopt_historical_receipt_without_provider_bound_erasure(self):
        runtime, agent = self.cleanup_context()
        receipt = paths(self.folder, self.machine['id'])[1]; receipt.parent.mkdir()
        save_json(receipt, {'id': self.request, 'machineId': self.machine['id'],
            'leaseId': self.machine['lease']['id'], 'fingerprint': self.binding.fingerprint,
            'phase': 'storageRemoved', 'attempt': 1})
        result = cleanup_assignment(agent, self.machine, runtime, {}, self.folder)
        self.assertEqual(result['leaseCleanup']['reason'], 'ownership')
        self.assertTrue((self.folder/'access-token.json').exists()); self.assertTrue(self.disk.exists())
