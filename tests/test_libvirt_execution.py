import copy
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from canaveral.files import save_json
from canaveral.libvirt_execution import (inspect_execution, launch, library_identity,
    prepare, publish, read_spec, supervisor_alive)
from canaveral.libvirt_supervision import LibvirtLeaseBinding, SupervisorJournal, bind_domain_xml
from canaveral.libvirt_supervisor_child import run_child
from canaveral.model import Error
from canaveral.owned_removal import assignment_fingerprint
from canaveral.providers.libvirt import Libvirt, domain_xml
from test_libvirt_supervision import Connection


@unittest.skipIf(os.name == 'nt', 'POSIX libvirt child and publication fixtures')
class ExecutionFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.now = 100; self.host_boot = str(uuid.uuid4())
        self.machine = {'id': str(uuid.uuid4()), 'desired': 'running', 'name': 'lease fixture',
            'template': {'id': 'linux'}, 'resources': {'cpu': 1, 'memoryMiB': 512, 'diskGiB': 4},
            'lease': {'id': str(uuid.uuid4()), 'state': 'provisioning'}}
        self.folder = self.root/'assignments'/self.machine['id']; self.folder.mkdir(mode=0o700, parents=True)
        self.storage = self.root/'disks'/self.machine['id']; self.storage.mkdir(parents=True)
        self.disk = self.storage/'disk.qcow2'; self.disk.write_bytes(b'private fake guest disk')
        self.library = self.root/'deadline.so'; self.library.write_bytes(b'fixture code; never dynamically loaded')
        fingerprint = assignment_fingerprint(self.machine)
        save_json(self.folder/'assignment.json', {'fingerprint': fingerprint, 'leaseId': self.machine['lease']['id']})
        save_json(self.storage/'canaveral-owner.json', {'fingerprint': fingerprint})
        self.binding = LibvirtLeaseBinding(self.machine['id'], self.machine['lease']['id'], str(uuid.uuid4()), self.host_boot, fingerprint, str(self.disk))
        self.authority = {'leaseID': self.binding.lease_id, 'revision': 1, 'remainingSeconds': 30, 'fenced': False}

    def prepare(self): return prepare(self.binding, self.folder, 'qemu:///session', self.library)
    def publish(self, **kwargs):
        return publish(self.machine, self.folder, lambda: dict(self.authority), clock=lambda: self.now,
                       host_boot=lambda: self.host_boot, **kwargs)
    def launch(self, popen=None, birth=None):
        return launch(self.machine, self.folder, popen=popen or Mock(return_value=SimpleNamespace(pid=12345)), birth=birth or (lambda pid: 1000))


class AuthorizationPublicationTests(ExecutionFixture):
    def test_duration_subtracts_sampling_delay_and_same_revision_never_extends(self):
        self.prepare()
        first = publish(self.machine, self.folder, lambda: self.authority, clock=Mock(side_effect=[100, 101]), host_boot=lambda: self.host_boot)
        self.assertEqual(first['deadline'], 129.75)
        self.now = 110; self.authority['remainingSeconds'] = 100
        self.assertEqual(self.publish()['deadline'], first['deadline'])
        self.authority['revision'] = 2
        self.assertEqual(self.publish()['deadline'], 209.75)

    def test_expired_previous_deadline_and_explicit_stop_are_sticky_across_restarts(self):
        self.prepare(); self.publish(); self.now = 130
        self.authority.update(revision=2, remainingSeconds=60)
        self.assertTrue(self.publish()['fenced'])
        self.now = 131; self.authority.update(revision=3)
        self.assertTrue(self.publish()['fenced'])

    def test_missing_changed_or_replaced_storage_and_other_lease_are_not_adopted(self):
        self.prepare(); self.publish()
        self.disk.rename(self.storage/'old'); self.disk.write_bytes(b'replacement')
        with self.assertRaises(Error): self.publish()
        self.disk.unlink(); (self.storage/'old').rename(self.disk)
        changed = copy.deepcopy(self.machine); changed['lease']['id'] = str(uuid.uuid4())
        with self.assertRaises(Error): publish(changed, self.folder, lambda: self.authority)
        self.assertEqual(inspect_execution(self.machine, self.folder)[0], self.binding)

    def test_wrong_clock_host_boot_revision_and_boolean_versions_do_not_publish(self):
        self.prepare(); original = self.publish()
        for changes in ({'revision': True}, {'remainingSeconds': float('nan')}, {'fenced': 1}, {'leaseID': str(uuid.uuid4())}):
            with self.subTest(changes=changes), self.assertRaises(Error):
                publish(self.machine, self.folder, lambda: {**self.authority, **changes}, clock=lambda: 100, host_boot=lambda: self.host_boot)
        with self.assertRaises(Error): publish(self.machine, self.folder, lambda: self.authority, clock=Mock(side_effect=[100, 99]), host_boot=lambda: self.host_boot)
        with self.assertRaises(Error): publish(self.machine, self.folder, lambda: self.authority, clock=lambda: 100, host_boot=lambda: str(uuid.uuid4()))
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try:
            self.assertEqual(state.read(), original); state.write({**original, 'version': True})
        finally: state.close()
        with self.assertRaises(Error): self.publish()

    def test_atomic_publication_failure_retains_previous_deadline(self):
        self.prepare(); first = self.publish(); self.authority['revision'] = 2
        with patch('canaveral.libvirt_supervision.os.replace', side_effect=OSError('fixture rename failure')):
            with self.assertRaises(OSError): self.publish()
        state = SupervisorJournal(self.folder, 'libvirt-authorization')
        try: self.assertEqual(state.read(), first)
        finally: state.close()


class ChildLaunchTests(ExecutionFixture):
    def test_launch_records_attempt_before_spawn_and_closes_inherited_helper_descriptors(self):
        self.prepare(); self.publish()
        def spawn(argv, **kwargs):
            state = SupervisorJournal(self.folder, 'libvirt-binding')
            try: self.assertEqual(state.read_named('libvirt-launch.json')['parentPid'], os.getpid())
            finally: state.close()
            self.assertIn('canaveral.libvirt_supervisor_child', argv)
            self.assertTrue(kwargs['close_fds']); self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('pass_fds', kwargs)
            return SimpleNamespace(pid=12345)
        self.launch(popen=spawn)
        self.assertEqual(inspect_execution(self.machine, self.folder)[3]['createdAt'], 1000)
        with self.assertRaises(Error): self.launch()

    def test_failed_spawn_or_missing_pid_publication_is_never_retried(self):
        self.prepare(); self.publish(); popen = Mock(side_effect=OSError('fixture spawn uncertainty'))
        with self.assertRaises(OSError): self.launch(popen=popen)
        with self.assertRaises(Error): self.launch(popen=popen)
        self.assertEqual(popen.call_count, 1)

    def test_failed_child_birth_publication_keeps_unknown_attempt_without_replay(self):
        self.prepare(); self.publish(); popen = Mock(return_value=SimpleNamespace(pid=12345))
        with self.assertRaises(OSError): self.launch(popen=popen, birth=Mock(side_effect=OSError('fixture birth lookup failed')))
        with self.assertRaises(Error): self.launch(popen=popen)
        self.assertEqual(popen.call_count, 1)
        self.assertNotIn('pid', inspect_execution(self.machine, self.folder)[3])

    def test_child_pins_verified_artifact_and_executes_the_owned_core_without_native_effects(self):
        self.prepare(); self.publish(); self.launch()
        events = []; connection = Connection(events); fence = Mock()
        def install(path, parent_pid):
            self.assertEqual(parent_pid, os.getpid())
            descriptor = int(path.rsplit('/', 1)[1])
            self.assertEqual(os.fstat(descriptor).st_ino, self.library.stat().st_ino)
            return fence
        def revoke(delay):
            self.assertEqual(delay, .1); self.publish(stopping=True)
        run_child(self.folder, os.getpid(), fence_factory=install, connection_factory=lambda *args: connection,
                  host_boot=lambda: self.host_boot, parent=os.getpid, wait=revoke, clock=lambda: self.now)
        self.assertEqual(events.count(('create',)), 1); self.assertEqual(events.count(('resume',)), 1)
        self.assertEqual(connection.state, 'closed')
        with self.assertRaises(Error): run_child(self.folder, os.getpid(), fence_factory=install, parent=os.getpid)

    def test_wrong_parent_changed_library_or_missing_history_prevents_connection(self):
        self.prepare(); self.publish(); self.launch(); connect = Mock()
        with self.assertRaises(Error): run_child(self.folder, os.getpid()+1, connection_factory=connect)
        self.library.write_bytes(b'changed artifact')
        with self.assertRaises(Error): run_child(self.folder, os.getpid(), parent=os.getpid, connection_factory=connect)
        connect.assert_not_called()

    def test_artifact_permissions_aliases_and_envelope_are_checked(self):
        self.library.chmod(0o666)
        with self.assertRaises(Error): library_identity(self.library)
        self.library.chmod(0o644); alias = self.root/'alias'; alias.symlink_to(self.library)
        with self.assertRaises(OSError): library_identity(alias)

    def test_supervisor_observation_uses_only_recorded_birth_command_owner_and_parent(self):
        self.prepare(); self.publish(); self.launch(); record = inspect_execution(self.machine, self.folder)[3]
        process = Mock(); process.create_time.return_value = record['createdAt']; process.uids.return_value = SimpleNamespace(real=os.getuid())
        process.ppid.return_value = os.getpid(); process.exe.return_value = sys.executable
        process.cmdline.return_value = [sys.executable, '-m', 'canaveral.libvirt_supervisor_child', '--state-directory', str(self.folder.resolve()), '--parent-pid', str(os.getpid())]
        with patch('psutil.Process', return_value=process):
            self.assertTrue(supervisor_alive(self.binding, self.folder, record))
            process.create_time.return_value += 1
            self.assertFalse(supervisor_alive(self.binding, self.folder, record))
        process.terminate.assert_not_called(); process.kill.assert_not_called()


class ProviderLeaseIntegrationTests(ExecutionFixture):
    def setUp(self):
        super().setUp()
        self.provider = Libvirt({'storage': str(self.storage.parent), 'leaseDeadlineLibrary': str(self.library), 'uri': 'qemu:///session'}, self.root/'provider')
        self.image = {'os': 'linux', 'arch': 'amd64', 'mode': 'headless', 'image': str(self.root/'base.raw'), '_leaseAuthorization': lambda: self.authority}
        # Explicit callback arguments avoid captured production defaults; no
        # Linux boot identity or native clock/source is queried by these fixtures.
        real_publish = publish
        self.patches = [patch('canaveral.libvirt_execution.publish', side_effect=lambda machine, folder, authorization, **kwargs:
            real_publish(machine, folder, authorization, clock=lambda: self.now, host_boot=lambda: self.host_boot, **kwargs)),
            patch('canaveral.libvirt_execution.linux_boot_id', return_value=self.host_boot)]
        for item in self.patches: item.start(); self.addCleanup(item.stop)

    def test_existing_owned_preparation_launches_only_one_supervisor_and_never_virsh_start(self):
        self.prepare()
        xml = bind_domain_xml(domain_xml(self.machine, self.image, self.disk), self.binding)
        calls = []
        def virsh(*args):
            calls.append(args)
            if args[0] == 'dumpxml': return xml
            if args[0] == 'domstate': return 'shut off'
            raise AssertionError(args)
        def spawn(machine, folder): self.launch()
        with patch.object(self.provider, 'virsh', side_effect=virsh), patch.object(self.provider, 'start_lease_supervisor', side_effect=spawn) as launch_once:
            self.assertEqual(self.provider.reconcile(self.machine, self.image, self.folder)['state'], 'starting')
            self.assertEqual(self.provider.reconcile(self.machine, self.image, self.folder)['state'], 'starting')
            self.assertEqual(launch_once.call_count, 1)
        self.assertFalse(any(args[0] == 'start' for args in calls))

    def test_stop_and_independent_refresh_publish_fence_without_native_shutdown_or_storage_creation(self):
        self.prepare(); self.publish(); stopped = {**self.machine, 'desired': 'stopped'}
        with patch.object(self.provider, 'virsh', side_effect=AssertionError('No CLI stop fallback')):
            report = self.provider.refresh_execution(stopped, self.image, self.folder, lambda: self.authority)
            self.assertTrue(report['leaseFenced'])
            self.assertEqual(self.provider.reconcile(stopped, self.image, self.folder)['state'], 'stopping')
        self.assertEqual(self.disk.read_bytes(), b'private fake guest disk')
        missing = self.root/'absent'
        self.assertIsNone(self.provider.refresh_execution(self.machine, self.image, missing, lambda: self.authority))
        self.assertFalse(missing.exists())

    def test_missing_library_or_foreign_domain_is_refused_before_provisioning(self):
        self.disk.unlink(); self.provider.config.pop('leaseDeadlineLibrary')
        with patch.object(self.provider, 'virsh') as command, self.assertRaises(Error): self.provider.reconcile(self.machine, self.image, self.folder)
        command.assert_not_called()
        self.provider.config['leaseDeadlineLibrary'] = str(self.library)
        with patch.object(self.provider, 'virsh', return_value=self.provider.name(self.machine)), self.assertRaises(Error):
            self.provider.reconcile(self.machine, self.image, self.folder)
        self.assertFalse(self.disk.exists())

    def test_wrong_lease_authority_or_partial_history_never_creates_a_disk(self):
        self.disk.unlink(); original = dict(self.authority)
        for changes in ({'leaseID': str(uuid.uuid4())}, {'remainingSeconds': True}, {'revision': True}):
            self.authority.update(changes)
            with self.subTest(changes=changes), patch.object(self.provider, 'virsh') as command, self.assertRaises(Error):
                self.provider.reconcile(self.machine, self.image, self.folder)
            command.assert_not_called(); self.authority = dict(original)
        save_json(self.folder/'libvirt-execution.json', {'phase': 'unknown previous boot'})
        with patch.object(self.provider, 'virsh') as command, self.assertRaises(Error):
            self.provider.reconcile(self.machine, self.image, self.folder)
        command.assert_not_called(); self.assertFalse(self.disk.exists())

    def test_duplicate_reconciliation_is_exclusive_without_blocking_deadline_publication(self):
        self.prepare(); self.publish()
        state = SupervisorJournal(self.folder, 'libvirt-reconcile')
        try:
            with self.assertRaises(OSError): self.provider.reconcile(self.machine, self.image, self.folder)
            self.authority['revision'] = 2
            self.assertEqual(self.publish()['revision'], 2)
        finally: state.close()

    def test_running_requires_native_owner_and_loss_fences_independently_without_restart(self):
        self.prepare(); self.publish(); self.launch()
        state = SupervisorJournal(self.folder)
        try: state.write({**self.binding.identity(), 'phase': 'running', 'revision': 1, 'deadline': 129.75})
        finally: state.close()
        xml = bind_domain_xml(domain_xml(self.machine, self.image, self.disk), self.binding)
        with patch.object(self.provider, 'virsh', side_effect=lambda *args: xml if args[0] == 'dumpxml' else 'running'), patch.object(self.provider, 'start_lease_supervisor') as start, patch('canaveral.libvirt_execution.supervisor_alive', return_value=True):
            self.assertEqual(self.provider.reconcile(self.machine, self.image, self.folder), {'state': 'running'})
            start.assert_not_called()
        with patch('canaveral.libvirt_execution.supervisor_alive', return_value=False), patch.object(self.provider, 'virsh') as driver:
            result = self.provider.refresh_execution(self.machine, self.image, self.folder, lambda: self.authority)
            self.assertTrue(result['leaseFenced']); driver.assert_not_called()
        self.authority['revision'] = 2
        self.assertTrue(self.publish()['fenced'])

    def test_fenced_child_history_propagates_without_waiting_for_reconciliation(self):
        self.prepare(); self.publish()
        state = SupervisorJournal(self.folder)
        try: state.write({**self.binding.identity(), 'phase': 'fenced', 'revision': 1, 'deadline': 129.75})
        finally: state.close()
        self.assertTrue(self.provider.refresh_execution(self.machine, self.image, self.folder, lambda: self.authority)['leaseFenced'])

    def test_changed_uri_fences_old_owner_without_querying_or_adopting_other_namespace(self):
        self.prepare(); self.publish(); self.provider.config['uri'] = 'qemu:///system'
        with patch.object(self.provider, 'virsh') as driver:
            report = self.provider.reconcile(self.machine, self.image, self.folder)
            self.assertTrue(report['leaseFenced']); self.assertEqual(report['state'], 'unknown')
            driver.assert_not_called()
        self.assertTrue(self.publish()['fenced'])

    def test_lost_domain_definition_acknowledgement_never_repeats_creation(self):
        self.disk.unlink(); defined = [None]; native_launch = Mock()
        def command(argv, **kwargs):
            if argv[1] == 'info': return json.dumps({'format': 'raw', 'virtual-size': 1})
            self.disk.write_bytes(b'new overlay'); return ''
        def virsh(*args):
            if args[0] == 'list': return ''
            if args[0] == 'define':
                defined[0] = Path(args[1]).read_text(); raise Error('Fixture loses define acknowledgement', 409)
            if args[0] == 'dumpxml': return defined[0]
            if args[0] == 'domstate': return 'shut off'
            raise AssertionError(args)
        with patch('canaveral.providers.libvirt.run', side_effect=command) as tools, patch('canaveral.providers.libvirt.ensure_seed', return_value=None), patch.object(self.provider, 'virsh', side_effect=virsh) as driver, patch.object(self.provider, 'start_lease_supervisor', side_effect=lambda machine, folder: (native_launch(), self.launch())):
            with self.assertRaises(Error): self.provider.reconcile(self.machine, self.image, self.folder)
            self.assertEqual(self.provider.reconcile(self.machine, self.image, self.folder)['state'], 'starting')
            self.assertEqual(sum(call.args[0] == 'define' for call in driver.call_args_list), 1)
            self.assertEqual(sum(call.args[0][1] == 'create' for call in tools.call_args_list), 1)
            native_launch.assert_called_once()

    def test_new_owned_definition_binds_preparation_before_define_and_launch(self):
        self.disk.unlink(); calls = []; defined = [None]
        def command(argv, **kwargs):
            calls.append(tuple(str(item) for item in argv))
            if argv[1] == 'info': return json.dumps({'format': 'raw', 'virtual-size': 1})
            if argv[1] == 'create': self.disk.write_bytes(b'new overlay'); return ''
            raise AssertionError(argv)
        def virsh(*args):
            if args[0] == 'list': return ''
            if args[0] == 'define':
                defined[0] = Path(args[1]).read_text()
                self.assertEqual(inspect_execution(self.machine, self.folder)[2]['phase'], 'prepared')
                return ''
            if args[0] == 'dumpxml': return defined[0]
            if args[0] == 'domstate': return 'shut off'
            raise AssertionError(args)
        with patch('canaveral.providers.libvirt.run', side_effect=command), patch('canaveral.providers.libvirt.ensure_seed', return_value=None), patch.object(self.provider, 'virsh', side_effect=virsh), patch.object(self.provider, 'start_lease_supervisor', side_effect=lambda machine, folder: self.launch()):
            self.assertEqual(self.provider.reconcile(self.machine, self.image, self.folder)['state'], 'starting')
        self.assertIn('urn:canaveral:libvirt:lease:1', defined[0]); self.assertEqual(calls[1][1], 'create')
