import os
import secrets
import tempfile
import unittest
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import Mock, patch

from canaveral.libvirt_execution import inspect_execution
from canaveral.libvirt_stop import confirm_stopped
from canaveral.libvirt_supervision import SupervisorJournal, bind_domain_xml, validate_domain_xml
from canaveral.model import Error
from canaveral.providers.libvirt import leased_domain_xml
from canaveral.store import Store
from lease_fixture import lease_offer
from test_consumers import application
from test_leases import acquire
from test_libvirt_execution import ExecutionFixture
from test_orchestration import host_offer


class LibvirtStopTests(ExecutionFixture):
    def setUp(self):
        super().setUp(); self.prepare(); self.publish(stopping=True)
        self.native = Mock(); self.native.close.return_value = None
        self.factory = Mock(return_value=self.native)
        self.location = Mock(return_value=True)

    def confirm(self):
        return confirm_stopped(self.machine, self.folder, self.location, connection_factory=self.factory,
                               host_boot=lambda: self.host_boot)

    def test_unused_boot_is_observed_inactive_and_permanently_retired_without_erasure(self):
        result = self.confirm()
        self.assertTrue(result['executionStopped']); self.assertEqual(result['evidence'], 'never-launched')
        self.assertEqual(result['storageHandles'], 'unknown'); self.assertFalse(result['storageRemoved'])
        self.native.validate.assert_called_once_with(self.binding, active=False)
        self.native.close.assert_called_once()
        self.assertEqual(self.disk.read_bytes(), b'private fake guest disk')
        self.assertTrue((self.folder/'assignment.json').exists())
        with self.assertRaises(Error): self.launch()
        self.assertTrue(self.confirm()['executionStopped'])

    def test_original_supervisor_must_be_gone_before_native_observation(self):
        self.launch(); process = Mock(); process.create_time.return_value = 1000
        with patch('psutil.Process', return_value=process):
            self.assertIsNone(self.confirm()); self.factory.assert_not_called()
        process.create_time.return_value = 1001
        with patch('psutil.Process', return_value=process):
            result = self.confirm(); self.assertEqual(result['evidence'], 'supervisor-exited')
        process.kill.assert_not_called(); process.terminate.assert_not_called()

    def test_missing_pid_birth_remains_unknown_even_if_inactive(self):
        state = SupervisorJournal(self.folder, 'libvirt-launch')
        try: state.write({**self.binding.identity(), 'parentPid': os.getpid(), 'attemptedAt': 1000})
        finally: state.close()
        self.assertIsNone(self.confirm()); self.factory.assert_not_called()

    def test_held_execution_lock_blocks_observation_and_never_cancels_by_pid(self):
        state = SupervisorJournal(self.folder)
        try: self.assertIsNone(self.confirm()); self.factory.assert_not_called()
        finally: state.close()

    def test_unfenced_or_wrong_boot_location_and_unknown_history_are_refused(self):
        self.location.return_value = False
        self.assertIsNone(self.confirm()); self.factory.assert_not_called()
        self.location.return_value = True
        self.assertIsNone(confirm_stopped(self.machine, self.folder, self.location, self.factory, host_boot=lambda: str(uuid.uuid4())))
        path = self.folder/'libvirt-execution.json'; original = path.read_bytes(); path.unlink()
        self.assertIsNone(self.confirm()); path.write_bytes(original); path.chmod(0o600)
        self.factory.assert_not_called()
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try:
            value = state.read(); value['fenced'] = False; state.write(value)
        finally: state.close()
        self.assertIsNone(self.confirm()); self.factory.assert_not_called()

    def test_failed_native_state_or_close_never_creates_stop_evidence(self):
        before = (self.folder/'libvirt-execution.json').read_bytes()
        self.native.validate.side_effect = Error('running, saved state or unknown native reply', 409)
        self.assertIsNone(self.confirm()); self.assertEqual((self.folder/'libvirt-execution.json').read_bytes(), before)
        self.native.validate.side_effect = None; self.native.close.side_effect = Error('Native close uncertain', 409)
        self.assertIsNone(self.confirm()); self.assertEqual((self.folder/'libvirt-execution.json').read_bytes(), before)

    def test_changed_launch_or_storage_during_observation_does_not_retire_preparation(self):
        def change(binding, active):
            state = SupervisorJournal(self.folder, 'libvirt-launch')
            try: state.write({**self.binding.identity(), 'parentPid': os.getpid()})
            finally: state.close()
        self.native.validate.side_effect = change
        self.assertIsNone(self.confirm())
        self.assertEqual(inspect_execution(self.machine, self.folder)[2]['phase'], 'prepared')

    def test_failed_retirement_sync_keeps_result_unknown_and_disk_retained(self):
        with patch('canaveral.libvirt_supervision.os.fsync', side_effect=OSError('fixture sync failure')):
            self.assertIsNone(self.confirm())
        self.assertTrue(self.disk.exists()); self.assertTrue((self.folder/'assignment.json').exists())


class AuxiliaryStateTests(ExecutionFixture):
    def image(self, system): return {'os': system, 'arch': 'amd64', 'mode': 'desktop'}

    def test_new_linux_and_windows_leases_bind_writable_firmware_and_tpm_paths(self):
        for system in ('linux', 'windows'):
            xml = leased_domain_xml(self.machine, self.image(system), self.disk)
            root = ET.fromstring(xml)
            self.assertEqual(root.findtext('os/nvram'), str(self.storage/'nvram.fd'))
            if system == 'windows':
                backend = root.find('devices/tpm/backend')
                self.assertEqual(backend.get('persistent_state'), 'yes')
                self.assertEqual(backend.find('source').attrib, {'type': 'dir', 'path': str(self.storage/'tpm-state')})
            validate_domain_xml(bind_domain_xml(xml, self.binding), self.binding)

    def test_external_firmware_tpm_varstore_or_encryption_is_not_owned(self):
        xml = bind_domain_xml(leased_domain_xml(self.machine, self.image('windows'), self.disk), self.binding)
        for changed in (xml.replace(str(self.storage/'nvram.fd'), '/external/nvram.fd'),
                        xml.replace(str(self.storage/'tpm-state'), '/external/tpm'),
                        xml.replace('persistent_state="yes"', 'persistent_state="no"'),
                        xml.replace('</os>', '<varstore path="/external/state"/></os>'),
                        xml.replace('</backend>', '<encryption secret="foreign"/></backend>')):
            with self.subTest(changed=changed[-90:]), self.assertRaises(Error): validate_domain_xml(changed, self.binding)


class StopReservationTests(unittest.TestCase):
    def test_stopped_lease_cannot_bypass_application_compute_quota_while_host_has_capacity(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder)/'controller.sqlite3', clock=lambda: 1000)
            offer = lease_offer(host_offer()); host = str(uuid.uuid4()); credential = secrets.token_urlsafe(32)
            store.enroll({'id': host, 'credential': credential, 'offer': offer})
            policy = application(); policy['limits']['resources']['cpu'] = 1
            consumer = store.create_consumer(policy); lease = store.acquire_lease(consumer['credential'], acquire())
            store.mutate_lease(lease['id'], consumer['credential'], 'release', {'id': str(uuid.uuid4())})
            machine = store.heartbeat(host, credential, {'offer': offer})['machines'][0]
            store.heartbeat(host, credential, {'offer': offer, 'reports': {machine['id']: {'state': 'stopped'}}})
            with self.assertRaises(Error) as caught: store.acquire_lease(consumer['credential'], acquire())
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(len(store.machines()), 1) # Failed admission rolls its assignment back.

    def test_stopped_runtime_report_retains_all_lease_quota_until_erasure(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder)/'controller.sqlite3', clock=lambda: 1000)
            offer = lease_offer(host_offer()); host = str(uuid.uuid4()); credential = secrets.token_urlsafe(32)
            store.enroll({'id': host, 'credential': credential, 'offer': offer})
            policy = application(); policy['limits']['resources']['diskGiB'] = 4
            consumer = store.create_consumer(policy); lease = store.acquire_lease(consumer['credential'], acquire())
            store.mutate_lease(lease['id'], consumer['credential'], 'release', {'id': str(uuid.uuid4())})
            machine = store.heartbeat(host, credential, {'offer': offer})['machines'][0]
            store.heartbeat(host, credential, {'offer': offer, 'reports': {machine['id']: {'state': 'stopped', 'leaseFenced': True}}})
            self.assertEqual(store.host_resources(host)['reserved'], machine['resources'])
            self.assertEqual(store.get_lease(lease['id'], consumer['credential'])['cleanup']['state'], 'pending')
            with self.assertRaises(Error): store.acquire_lease(consumer['credential'], acquire())
            intent = machine['leaseCleanup']
            complete = {'state': 'stopped', 'leaseCleanup': {'id': intent['id'], 'leaseId': lease['id'],
                'state': 'complete', 'attempt': 1, 'executionStopped': True, 'storageRemoved': True, 'credentialsErased': True}}
            store.heartbeat(host, credential, {'offer': offer, 'reports': {machine['id']: complete}})
            self.assertEqual(store.host_resources(host)['reserved'], {'cpu': 0, 'memoryMiB': 0, 'diskGiB': 0})
            self.assertNotEqual(store.acquire_lease(consumer['credential'], acquire())['members'][0]['machineId'], machine['id'])


if __name__ == '__main__': unittest.main()
