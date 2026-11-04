import json
import os
import shutil
import uuid
from unittest.mock import Mock, patch

from canaveral.libvirt_execution import publish
from canaveral.libvirt_reboot import fence_cleanup
from canaveral.libvirt_stop import confirm_stopped
from canaveral.libvirt_supervision import SupervisorJournal
from canaveral.model import Error
from canaveral.files import save_json
from canaveral.libvirt_storage_handles import StorageHandlesUnknown
from test_libvirt_removal import RemovalFixture


class RebootRecoveryTests(RemovalFixture):
    def setUp(self):
        super().setUp(); self.original_boot = self.host_boot
        self.authority.update(fenced=True, remainingSeconds=0)
        self.new_boot = str(uuid.uuid4()); self.boot = lambda: self.new_boot

    def fence(self):
        return fence_cleanup(self.machine, self.folder, lambda: self.authority,
                             lambda *_: True, host_boot=self.boot)

    def stop(self):
        return confirm_stopped(self.machine, self.folder, lambda *_: True,
                               connection_factory=self.factory, host_boot=self.boot)

    def reboot_record(self): return json.loads((self.folder/'libvirt-reboot.json').read_text())

    def test_new_boot_retires_original_execution_without_querying_or_signalling_old_pid(self):
        self.launch() # Original birth receipt is intentionally no longer inspected.
        with patch('psutil.Process', side_effect=AssertionError('No old PID lookup after reboot')):
            fenced = self.fence(); self.assertEqual(fenced['phase'], 'fenced')
            stopped = self.stop()
        self.assertEqual(stopped['evidence'], 'host-reboot')
        self.assertEqual(stopped['hostBootId'], self.original_boot)
        self.assertEqual(stopped['observedHostBootId'], self.new_boot)
        self.assertEqual(self.reboot_record()['phase'], 'stopped')
        self.assertEqual(stopped['storageHandles'], 'unknown'); self.assertTrue(self.disk.exists())
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try:
            self.assertTrue(state.read()['fenced']); self.assertEqual(state.read()['deadline'], 0)
        finally: state.close()

    def test_changed_boot_without_explicit_terminal_fence_does_not_prove_stop(self):
        self.assertIsNone(self.stop()); self.factory.assert_not_called(); self.assertTrue(self.disk.exists())

    def test_reboot_fence_never_renews_old_clock_or_enables_new_execution(self):
        self.fence()
        with patch('canaveral.libvirt_execution.execution_monotonic', side_effect=AssertionError('Old clock cannot renew')):
            with self.assertRaises(Error):
                publish(self.machine, self.folder, lambda: self.authority, clock=lambda: 1, host_boot=self.boot)
        with self.assertRaises(Error): self.launch()

    def test_missing_birth_receipt_is_safe_only_with_fresh_reboot_and_native_inactive_proof(self):
        launch = SupervisorJournal(self.folder, 'libvirt-launch')
        try: launch.write({**self.binding.identity(), 'parentPid': os.getpid()})
        finally: launch.close()
        self.fence(); self.driver['active'] = True
        self.assertIsNone(self.stop()); self.assertEqual(self.reboot_record()['phase'], 'fenced')
        self.driver['active'] = False
        self.assertEqual(self.stop()['evidence'], 'host-reboot')

    def test_active_or_missing_domain_and_unconfirmed_close_never_publish_stopped(self):
        self.fence()
        for change in ({'active': True}, {'present': False}, {'closeFails': True}):
            original = dict(self.driver); self.driver.update(change)
            self.assertIsNone(self.stop()); self.assertEqual(self.reboot_record()['phase'], 'fenced')
            self.driver.clear(); self.driver.update(original)

    def test_foreign_authorization_revision_namespace_and_nonterminal_intent_are_rejected(self):
        self.authority['fenced'] = False
        with self.assertRaises(Error): self.fence()
        self.authority['fenced'] = True; self.authority['revision'] = 0
        with self.assertRaises(Error): self.fence()
        self.authority['revision'] = 1
        with self.assertRaises(Error): fence_cleanup(self.machine, self.folder, lambda: self.authority, lambda *_: False, self.boot)
        self.machine['lease']['state'] = 'running'
        with self.assertRaises(Error): self.fence()
        self.assertFalse((self.folder/'libvirt-reboot.json').exists())

    def test_changed_kernel_boot_during_authorization_sampling_never_publishes_receipt(self):
        def callback(): self.new_boot = str(uuid.uuid4()); return self.authority
        with self.assertRaises(Error): fence_cleanup(self.machine, self.folder, callback, lambda *_: True, self.boot)
        self.assertFalse((self.folder/'libvirt-reboot.json').exists())

    def test_corrupted_or_foreign_reboot_receipt_is_never_adopted(self):
        self.fence(); record = self.reboot_record()
        for key, value in (('cleanupId', str(uuid.uuid4())), ('observedHostBootId', self.original_boot),
                           ('authorityDigest', '0'*64), ('version', True)):
            changed = {**record, key: value}
            save_json(self.folder/'libvirt-reboot.json', changed)
            self.assertIsNone(self.stop())
        save_json(self.folder/'libvirt-reboot.json', record)
        self.assertIsNotNone(self.stop())

    def test_lost_reboot_receipt_publication_retries_only_fencing_not_execution(self):
        actual = SupervisorJournal.write
        def fail_reboot(state, value):
            if state.record == 'libvirt-reboot.json': raise OSError('fixture reboot journal sync failure')
            return actual(state, value)
        with patch.object(SupervisorJournal, 'write', new=fail_reboot):
            with self.assertRaises(OSError): self.fence()
        self.assertIsNone(self.stop())
        self.assertEqual(self.fence()['phase'], 'fenced'); self.assertIsNotNone(self.stop())
        with self.assertRaises(Error): self.launch()

    def test_boot_change_during_native_observation_does_not_publish_current_stop(self):
        self.fence()
        factory = self.factory.side_effect
        def connection(*args):
            native = factory(*args)
            validate = native.validate
            def changed(*values, **kwargs): validate(*values, **kwargs); self.new_boot = str(uuid.uuid4())
            native.validate = changed; return native
        self.factory.side_effect = connection
        self.assertIsNone(self.stop()); self.assertEqual(self.reboot_record()['phase'], 'fenced')

    def test_original_boot_cannot_replace_already_observed_reboot_history(self):
        self.fence(); self.assertIsNotNone(self.stop()); self.new_boot = self.original_boot
        with self.assertRaises(Error): self.fence()
        self.assertIsNone(self.stop())

    def test_reboot_before_initial_teardown_completes_with_fresh_native_and_handle_checks(self):
        self.fence(); self.host_boot = self.new_boot
        result = self.remove()
        self.assertEqual(result['state'], 'complete'); self.assertEqual(result['evidence'], 'host-reboot')
        self.assertEqual(result['observedHostBootId'], self.new_boot); self.assertFalse(self.quarantine.exists())

    def test_reboot_at_quarantine_after_lost_retirement_ack_recovers_without_pid_adoption(self):
        self.driver['lostAck'] = True
        with self.assertRaises(Error): self.remove()
        self.host_boot = self.new_boot
        with patch('psutil.Process', side_effect=AssertionError('Old process IDs are not recovery authority')):
            self.assertEqual(self.remove()['state'], 'complete')
        self.assertEqual(self.driver['retirements'], 1)

    def test_reboot_during_partial_content_clear_keeps_full_inode_manifest_required(self):
        with patch('canaveral.libvirt_storage_handles.os.ftruncate', side_effect=OSError('fixture partial clear')):
            with self.assertRaises(StorageHandlesUnknown): self.remove()
        self.assertEqual(self.receipt()['state'], 'erasing'); self.host_boot = self.new_boot
        self.assertEqual(self.remove()['state'], 'complete')

    def test_reboot_after_partial_unlink_recovers_remaining_empty_owned_entries(self):
        actual = shutil.rmtree
        def partial(path): (path/'disk.qcow2').unlink(); raise OSError('fixture partial unlink')
        partial.avoids_symlink_attacks = actual.avoids_symlink_attacks
        with patch('canaveral.libvirt_removal.shutil.rmtree', new=partial):
            with self.assertRaises(OSError): self.remove()
        self.host_boot = self.new_boot
        self.assertEqual(self.remove()['state'], 'complete')

    def test_retired_domain_reappearance_and_unknown_absence_after_reboot_block_erasure(self):
        actual = shutil.rmtree
        def interrupted(path): raise OSError('fixture before unlink')
        interrupted.avoids_symlink_attacks = actual.avoids_symlink_attacks
        with patch('canaveral.libvirt_removal.shutil.rmtree', new=interrupted):
            with self.assertRaises(OSError): self.remove()
        self.host_boot = self.new_boot
        self.driver['present'] = True
        with self.assertRaises(Error): self.remove()
        self.driver['present'] = False; self.driver['unknown'] = True
        with self.assertRaises(Error): self.remove()
        self.assertTrue(self.quarantine.exists()); self.assertNotEqual(self.receipt()['state'], 'complete')

    def test_repeated_reboots_before_cleanup_completion_require_each_fresh_native_observation(self):
        self.guard = Mock(side_effect=OSError('fixture handles unknown'))
        with self.assertRaises(OSError): self.remove()
        self.host_boot = self.new_boot
        with self.assertRaises(OSError): self.remove()
        self.assertEqual(self.receipt()['observedHostBootId'], self.new_boot)
        self.host_boot = str(uuid.uuid4()); self.guard = self.make_guard
        self.assertEqual(self.remove()['state'], 'complete')
        self.assertEqual(self.reboot_record()['observedHostBootId'], self.host_boot)

    def test_same_boot_fencing_remains_independent_of_supervisor_execution_lock(self):
        self.new_boot = self.original_boot
        execution = SupervisorJournal(self.folder)
        try: self.assertTrue(self.fence()['fenced'])
        finally: execution.close()
        self.factory.assert_not_called()

    def test_reboot_fencing_requires_exclusive_execution_ownership(self):
        before = (self.folder/'libvirt-authorization.json').read_bytes()
        execution = SupervisorJournal(self.folder)
        try:
            with self.assertRaises(BlockingIOError): self.fence()
        finally: execution.close()
        self.assertEqual((self.folder/'libvirt-authorization.json').read_bytes(), before)

    def test_failed_stop_receipt_sync_cannot_be_replaced_by_only_fenced_execution_record(self):
        self.fence(); actual = SupervisorJournal.write
        def fail(state, value):
            if state.record == 'libvirt-reboot.json' and value.get('phase') == 'stopped':
                raise OSError('fixture lost stopped receipt')
            return actual(state, value)
        with patch.object(SupervisorJournal, 'write', new=fail): self.assertIsNone(self.stop())
        self.assertEqual(self.reboot_record()['phase'], 'fenced')
        self.assertEqual(self.stop()['evidence'], 'host-reboot')

    def test_reboot_after_quarantine_rename_ack_loss_revalidates_domain_before_erasure(self):
        actual = os.rename
        def lost(*args, **kwargs): actual(*args, **kwargs); raise OSError('fixture lost rename receipt')
        with patch('canaveral.libvirt_removal.os.rename', new=lost):
            with self.assertRaises(OSError): self.remove()
        self.assertEqual(self.receipt()['state'], 'planned'); self.host_boot = self.new_boot
        self.assertEqual(self.remove()['state'], 'complete')

    def test_context_change_after_reboot_native_connection_close_never_advances_receipt(self):
        self.guard = Mock(side_effect=OSError('fixture quarantine retained'))
        with self.assertRaises(OSError): self.remove()
        old = self.receipt(); self.host_boot = self.new_boot
        original_factory = self.factory.side_effect
        def changed(*args):
            connection = original_factory(*args)
            def close(): self.host_boot = str(uuid.uuid4())
            connection.close = close; return connection
        self.factory.side_effect = changed
        with self.assertRaises(Error): self.remove()
        self.assertEqual(self.receipt(), old); self.assertTrue(self.quarantine.exists())

    def test_floating_point_zero_deadline_is_normalized_before_receipt_digest(self):
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try:
            value = state.read(); value['deadline'] = 0.0; value['fenced'] = True; state.write(value)
        finally: state.close()
        self.fence(); self.assertEqual(self.stop()['evidence'], 'host-reboot')
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try: self.assertIs(type(state.read()['deadline']), int)
        finally: state.close()
