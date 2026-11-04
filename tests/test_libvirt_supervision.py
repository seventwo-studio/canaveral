import copy
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from canaveral.libvirt_supervision import (LibvirtLeaseBinding, LibvirtLeaseSupervisor,
    LinuxKernelDeadline, NativeLibvirtConnection, SupervisorJournal, bind_domain_xml, validate_domain_xml)
from canaveral.model import Error


class Connection:
    """Fake driver: closing the owned connection models auto-destroy only."""
    def __init__(self, events):
        self.events = events; self.state = 'inactive'; self.after_create = self.after_resume = self.after_close = lambda: None
    def validate(self, binding, active, paused=None):
        self.events.append(('validate', active, paused))
        if self.state != ('inactive' if not active else 'paused' if paused else 'running'):
            raise Error('Fixture domain state differs', 409)
    def start_paused(self):
        self.events.append(('create',)); self.state = 'paused'; self.after_create()
    def resume(self):
        self.events.append(('resume',)); self.state = 'running'; self.after_resume()
    def close(self):
        self.events.append(('close',)); self.state = 'closed'; self.after_close()


@unittest.skipIf(os.name == 'nt', 'POSIX libvirt supervisor component')
class SupervisorFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.now = 100
        self.binding = LibvirtLeaseBinding(*(str(uuid.uuid4()) for _ in range(4)), 'a'*64, '/private/owned/disk.qcow2')
        self.journal = SupervisorJournal(self.root); self.addCleanup(self.journal.close); self.journal.prepare(self.binding)
        self.auth = {**self.binding.identity(), 'revision': 1, 'deadline': 130, 'fenced': False}
        self.events = []; self.connection = Connection(self.events)
        self.fence = Mock(); self.fence.arm.side_effect = lambda deadline: self.events.append(('arm', deadline))
        self.connect = Mock(return_value=self.connection)
        self.supervisor = self.make_supervisor()

    def make_supervisor(self):
        return LibvirtLeaseSupervisor(self.binding, self.journal, lambda: copy.deepcopy(self.auth), lambda: True,
            lambda: self.binding.host_boot_id, self.connect, self.fence, clock=lambda: self.now)


class LibvirtSupervisorTests(SupervisorFixture):
    def test_paused_start_and_resume_use_fresh_authority_and_durable_one_use_receipt(self):
        self.supervisor.start()
        kinds = [event[0] for event in self.events]
        self.assertLess(kinds.index('arm'), kinds.index('create')); self.assertLess(kinds.index('create'), kinds.index('resume'))
        self.assertIn(('validate', True, True), self.events); self.assertEqual(self.journal.read()['phase'], 'running')
        self.assertTrue(self.supervisor.step()); self.assertIn(('validate', True, False), self.events)
        with self.assertRaises(Error): self.supervisor.start()
        with self.assertRaises(Error): self.make_supervisor().start()
        self.assertEqual(kinds.count('create'), 1); self.supervisor.close()
        self.assertEqual(self.journal.read()['phase'], 'fenced')
        self.assertNotIn('executionStopped', self.journal.read())
        self.assertNotIn(self.binding.disk, (self.root/'libvirt-execution.json').read_text())

    def test_same_revision_cannot_extend_but_fresh_renewal_before_expiry_can(self):
        self.supervisor.start(); self.auth['deadline'] = 200; self.now = 110
        self.assertTrue(self.supervisor.step()); self.assertEqual(self.supervisor.deadline, 130)
        self.auth.update(revision=2, deadline=160)
        self.assertTrue(self.supervisor.step()); self.assertEqual(self.supervisor.deadline, 160)
        self.now = 160; self.auth.update(revision=3, deadline=300)
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.supervisor.phase, 'fenced')
        self.assertEqual(self.connection.state, 'closed'); self.assertFalse(self.supervisor.step())

    def test_clock_rollback_suspend_jump_revision_rollback_and_wrong_host_boot_fence(self):
        self.supervisor.start()
        for mutate in (lambda: setattr(self, 'now', 99), lambda: setattr(self, 'now', 500),
                       lambda: self.auth.update(revision=0), lambda: self.auth.update(hostBootId=str(uuid.uuid4()))):
            with self.subTest(mutate=mutate):
                # Independent state for each failure; no launch record is reset.
                self.auth.update(revision=1, deadline=130, hostBootId=self.binding.host_boot_id); self.now = 100
                component = self.make_supervisor(); component.admitted = True; component.phase = 'running'
                component.revision = 1; component.deadline = 130; component.last_clock = 100
                component.connection = Connection([]); component.connection.state = 'running'
                mutate(); self.assertFalse(component.step()); self.assertEqual(component.connection, None)
        self.supervisor.close()

    def test_fenced_malformed_or_other_ownership_authorization_never_creates(self):
        for changes in ({'version': True}, {'version': 1.0}, {'fenced': True}, {'fenced': 1}, {'revision': True}, {'deadline': float('nan')},
                        {'deadline': 10**1000}, {'leaseId': str(uuid.uuid4())}, {'bootId': str(uuid.uuid4())}, {'extra': 'bad'}):
            auth = {**self.auth, **changes}
            component = LibvirtLeaseSupervisor(self.binding, self.journal, lambda: auth, lambda: True,
                lambda: self.binding.host_boot_id, self.connect, self.fence, clock=lambda: self.now)
            with self.subTest(changes=list(changes)), self.assertRaises(Error): component._authorize()
        self.connect.assert_not_called()

    def test_lost_create_acknowledgement_closes_owner_and_never_resumes_or_replays(self):
        self.connection.after_create = Mock(side_effect=OSError('private endpoint secret'))
        with self.assertRaises(Error) as caught: self.supervisor.start()
        self.assertNotIn('secret', str(caught.exception))
        self.assertNotIn(('resume',), self.events); self.assertEqual(self.events.count(('create',)), 1)
        self.assertEqual(self.events.count(('close',)), 1); self.assertEqual(self.journal.read()['phase'], 'fenced')
        with self.assertRaises(Error): self.make_supervisor().start()
        self.assertEqual(self.events.count(('create',)), 1)

    def test_expiry_during_paused_start_never_resumes(self):
        self.connection.after_create = lambda: setattr(self, 'now', 130)
        with self.assertRaises(Error): self.supervisor.start()
        self.assertNotIn(('resume',), self.events); self.assertEqual(self.connection.state, 'closed')

    def test_delayed_metadata_read_cannot_make_late_renewal_reopen_execution(self):
        self.supervisor.start(); self.now = 129
        def late():
            self.now = 131
            return {**self.auth, 'revision': 2, 'deadline': 200}
        self.supervisor.authorization = late
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.connection.state, 'closed')

    def test_unknown_resume_acknowledgement_never_replays_native_effect(self):
        self.connection.after_resume = Mock(side_effect=OSError('lost resume ack'))
        with self.assertRaises(Error): self.supervisor.start()
        self.assertEqual(self.events.count(('resume',)), 1); self.assertEqual(self.connection.state, 'closed')
        with self.assertRaises(Error): self.make_supervisor().start()

    def test_failed_pending_write_prevents_create_and_retains_uncertain_launch(self):
        write = self.journal.write
        def fail(value):
            if value['phase'] in ('creating', 'fenced'): raise OSError('Fixture fsync failure')
            write(value)
        with patch.object(self.journal, 'write', side_effect=fail):
            with self.assertRaises(Error): self.supervisor.start()
        self.assertNotIn(('create',), self.events); self.assertEqual(self.events.count(('close',)), 1)
        self.assertEqual(self.journal.read()['phase'], 'starting')
        with self.assertRaises(Error): self.make_supervisor().start()

    def test_revocation_shortens_kernel_timer_before_persistence_or_native_close(self):
        self.supervisor.start(); self.auth['fenced'] = True
        def close(): self.assertLessEqual(self.fence.arm.call_args.args[0], 100.1)
        self.connection.after_close = close
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.journal.read()['phase'], 'fenced')

    def test_lost_assignment_or_actual_host_boot_closes_existing_owner(self):
        self.supervisor.start(); self.supervisor.ownership = lambda: False
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.connection.state, 'closed')
        self.connect.assert_called_once()
        # A different host boot is refused before a connection is opened.
        component = self.make_supervisor(); component.host_boot = lambda: str(uuid.uuid4())
        with self.assertRaises(Error): component._authorize()
        self.connect.assert_called_once()

    def test_replaced_journal_is_retained_while_owned_connection_still_closes(self):
        self.supervisor.start(); value = self.journal.read(); value['leaseId'] = str(uuid.uuid4())
        self.journal.write(value)
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.connection.state, 'closed')
        self.assertEqual(self.journal.read(), value)

    def test_kernel_arm_failure_cannot_leave_the_new_renewal_running(self):
        self.supervisor.start(); self.auth.update(revision=2, deadline=160)
        def arm(deadline):
            if deadline > 130: raise OSError('Fixture timer update failed')
        self.fence.arm.side_effect = arm
        self.assertFalse(self.supervisor.step()); self.assertEqual(self.connection.state, 'closed')
        self.assertLessEqual(self.fence.arm.call_args.args[0], 100.1)

    def test_missing_foreign_and_interrupted_journals_never_get_replaced_on_start(self):
        original = self.journal.read()
        for value in (None, {**original, 'version': True}, {**original, 'leaseId': str(uuid.uuid4())}, {**original, 'phase': 'creating'}):
            path = self.root/'libvirt-execution.json'
            if value is None: path.unlink()
            else: path.write_text(json.dumps(value)); path.chmod(0o600)
            component = self.make_supervisor()
            with self.subTest(value=value), self.assertRaises(Error): component.run()
            self.assertEqual(self.journal.read(), value)
            if value is None: path.write_text(json.dumps(original)); path.chmod(0o600)
        self.connect.assert_not_called()


class LibvirtJournalAndXMLTests(SupervisorFixture):
    def xml(self):
        return ('<domain><name>cvm-'+self.binding.machine_id+'</name><uuid>'+self.binding.machine_id+
            '</uuid><devices><disk type="file" device="disk"><source file="'+self.binding.disk+'"/></disk></devices></domain>')

    def test_domain_binding_refuses_rebinding_foreign_disks_and_passthrough(self):
        xml = bind_domain_xml(self.xml(), self.binding); validate_domain_xml(xml, self.binding)
        with self.assertRaises(Error): bind_domain_xml(xml, self.binding)
        for changed in (xml.replace(self.binding.lease_id, str(uuid.uuid4())), xml.replace('disk.qcow2', 'foreign.qcow2'),
                        xml.replace('</devices>', '<filesystem/></devices>'), xml.replace('</devices>', '<hostdev/></devices>'),
                        xml.replace('</devices>', '<disk type="file" device="disk"><source file="/foreign"/></disk></devices>')):
            with self.subTest(changed=changed[-70:]), self.assertRaises(Error): validate_domain_xml(changed, self.binding)

    def test_lost_lock_or_replaced_directory_does_not_write_into_foreign_state(self):
        with self.assertRaises((OSError, Error)): SupervisorJournal(self.root)
        moved = self.root.with_name(self.root.name+'-moved'); self.root.rename(moved)
        self.addCleanup(lambda: shutil.rmtree(moved))
        foreign = moved/'foreign'; foreign.mkdir(); self.root.symlink_to(foreign, target_is_directory=True)
        self.addCleanup(self.root.unlink)
        with self.assertRaises(Error): self.journal.write({'foreign': 'must not write'})
        self.assertEqual(list(foreign.iterdir()), [])

    def test_private_journal_refuses_symlink_hardlink_fifo_and_oversize(self):
        path = self.root/'libvirt-execution.json'; original = path.read_bytes(); path.unlink()
        foreign = self.root/'foreign'; foreign.write_bytes(original); foreign.chmod(0o600)
        for mode in ('symlink', 'hardlink', 'fifo', 'oversize', 'public'):
            if mode == 'symlink': path.symlink_to(foreign)
            elif mode == 'hardlink': os.link(foreign, path)
            elif mode == 'fifo': os.mkfifo(path, 0o600)
            else:
                path.write_bytes(b' ' * 16385 if mode == 'oversize' else original)
                path.chmod(0o644 if mode == 'public' else 0o600)
            with self.subTest(mode=mode), self.assertRaises((Error, OSError)): self.journal.read()
            path.unlink()

    def test_preparation_is_one_use_and_journal_contains_no_disk_path(self):
        with self.assertRaises(Error): self.journal.prepare(self.binding)
        value = self.journal.read(); self.assertEqual(value['phase'], 'prepared')
        self.assertNotIn(self.binding.disk, json.dumps(value))


class Function:
    def __init__(self, body): self.body = body
    def __call__(self, *args): return self.body(*args)


class FakeCLibrary:
    """C ABI fixture: allocated XML is real memory, libvirt calls are fake."""
    def __init__(self, binding, xml):
        self.binding = binding; self.xml = xml; self.events = []; self.state = 5; self.active = 0
        self.saved = self.snapshots = self.checkpoints = 0; self.alive = 1; self.fail_create = False
        self.present = True; self.persistent = 1; self.last_error = 0
        self.libc = ctypes.CDLL(None); self.libc.malloc.argtypes = [ctypes.c_size_t]; self.libc.malloc.restype = ctypes.c_void_p
        for name, body in {
            'virConnectOpen': lambda uri: 101,
            'virConnectClose': lambda conn: self.event('close'),
            'virConnectGetType': lambda conn: b'QEMU',
            'virConnectIsAlive': lambda conn: self.alive,
            'virDomainLookupByUUIDString': self.lookup,
            'virDomainGetUUIDString': self.identity,
            'virDomainGetXMLDesc': self.xml_pointer,
            'virDomainIsActive': lambda domain: self.active,
            'virDomainGetState': self.get_state,
            'virDomainHasManagedSaveImage': lambda domain, flags: self.saved,
            'virDomainSnapshotNum': lambda domain, flags: self.snapshots,
            'virDomainListAllCheckpoints': lambda domain, pointer, flags: self.checkpoints,
            'virDomainCreateWithFlags': self.create,
            'virDomainResume': self.resume,
            'virDomainFree': lambda domain: self.event('free'),
            'virDomainUndefineFlags': self.undefine,
            'virDomainIsPersistent': lambda domain: self.persistent,
            'virGetLastErrorCode': lambda: self.last_error,
            'virResetLastError': self.reset_error,
        }.items(): setattr(self, name, Function(body))
    def event(self, name): self.events.append(name); return 0
    def lookup(self, conn, identity):
        if self.present: return 202
        self.last_error = 42; return None
    def reset_error(self): self.last_error = 0
    def undefine(self, domain, flags):
        assert flags == 72
        self.events.append('undefine-keep-nvram-tpm'); self.persistent = 0
        if not self.active: self.present = False
        return 0
    def identity(self, domain, buffer): ctypes.memmove(buffer, (self.binding.machine_id+'\0').encode(), 37); return 0
    def xml_pointer(self, domain, flags):
        data = self.xml.encode()+b'\0'; pointer = self.libc.malloc(len(data)); ctypes.memmove(pointer, data, len(data)); return pointer
    def get_state(self, domain, state, reason, flags): ctypes.cast(state, ctypes.POINTER(ctypes.c_int))[0] = self.state; return 0
    def create(self, domain, flags):
        assert flags == 3; self.events.append('create-paused-autodestroy'); self.state = 3; self.active = 1
        return -1 if self.fail_create else 0
    def resume(self, domain): self.events.append('resume'); self.state = 1; return 0


class NativeLibvirtABITests(SupervisorFixture):
    def native(self):
        xml = '<domain><name>cvm-'+self.binding.machine_id+'</name><uuid>'+self.binding.machine_id+'</uuid><devices><disk type="file" device="disk"><source file="'+self.binding.disk+'"/></disk></devices></domain>'
        library = FakeCLibrary(self.binding, bind_domain_xml(xml, self.binding))
        connection = NativeLibvirtConnection('qemu:///session', self.binding.machine_id, _library=library)
        self.addCleanup(connection.close); return connection, library

    def test_c_api_uses_combined_flags_and_frees_all_domain_handles_before_close(self):
        connection, library = self.native()
        connection.validate(self.binding, active=False); connection.start_paused()
        connection.validate(self.binding, active=True, paused=True); connection.resume()
        connection.validate(self.binding, active=True, paused=False); connection.close()
        self.assertEqual(library.events, ['free', 'create-paused-autodestroy', 'free', 'free', 'resume', 'free', 'free', 'close'])

    def test_saved_snapshot_checkpoint_unknown_and_wrong_state_prevent_validation(self):
        connection, library = self.native()
        for key, value in (('saved', 1), ('saved', -1), ('snapshots', 1), ('checkpoints', 1), ('checkpoints', -1), ('state', 1)):
            old = getattr(library, key); setattr(library, key, value)
            with self.subTest(key=key, value=value), self.assertRaises(Error): connection.validate(self.binding, active=False)
            setattr(library, key, old)
        self.assertNotIn('create-paused-autodestroy', library.events)

    def test_lost_create_ack_and_connection_loss_do_not_repeat_or_destroy_by_identity(self):
        connection, library = self.native(); library.fail_create = True
        with self.assertRaises(Error): connection.start_paused()
        with self.assertRaises(Error): connection.start_paused()
        library.alive = 0
        with self.assertRaises(Error): connection.validate(self.binding, active=True)
        connection.close(); self.assertEqual(library.events.count('create-paused-autodestroy'), 1)
        self.assertEqual(library.events[-1], 'close')

    def test_retirement_keeps_auxiliary_files_and_requires_typed_domain_absence(self):
        connection, library = self.native()
        connection.retire(self.binding)
        self.assertTrue(connection.absent()); self.assertEqual(library.events, ['undefine-keep-nvram-tpm', 'free'])
        library.virDomainLookupByUUIDString.body = lambda *_: None
        library.last_error = 42 # A stale error is cleared before every lookup.
        with self.assertRaises(Error): connection.absent()

    def test_active_saved_foreign_or_transient_domains_are_never_retired(self):
        connection, library = self.native()
        for key, value in (('active', 1), ('saved', 1), ('persistent', 0), ('xml', '<domain/>')):
            prior = getattr(library, key); setattr(library, key, value)
            with self.subTest(key=key), self.assertRaises(Error): connection.retire(self.binding)
            setattr(library, key, prior)
        self.assertNotIn('undefine-keep-nvram-tpm', library.events)

    def test_execution_started_during_undefine_remains_transient_and_blocks_removal(self):
        connection, library = self.native()
        def concurrent(domain, flags):
            library.active = 1
            return library.undefine(domain, flags)
        library.virDomainUndefineFlags.body = concurrent
        with self.assertRaises(Error): connection.retire(self.binding)
        self.assertTrue(library.present); self.assertFalse(connection.absent())


@unittest.skipIf(os.name == 'nt', 'Linux kernel shim with POSIX unsupported branch')
class KernelDeadlineShimTests(unittest.TestCase):
    def test_kernel_shim_compiles_and_supported_branch_or_failure_is_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/'deadline.so'; source = Path(__file__).parents[1]/'canaveral/native/linux_lease_deadline.c'
            command = ['cc', '-Wall', '-Wextra', '-Werror', '-dynamiclib' if sys.platform == 'darwin' else '-shared', '-fPIC', str(source), '-o', str(output)]
            if sys.platform.startswith('linux'): command.append('-lrt')
            subprocess.run(command, check=True, capture_output=True)
            if sys.platform.startswith('linux'):
                script = ('import os,time\nfrom canaveral.libvirt_supervision import LinuxKernelDeadline\n'
                          'f=LinuxKernelDeadline('+repr(str(output))+',os.getppid())\n'
                          'f.arm(time.clock_gettime(time.CLOCK_BOOTTIME)+.1)\ntime.sleep(10)\n')
                process = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try: process.communicate(timeout=3); self.assertEqual(process.returncode, -signal.SIGKILL)
                finally:
                    if process.poll() is None: process.kill(); process.communicate(timeout=3)
            else:
                library = ctypes.CDLL(str(output))
                self.assertEqual(library.canaveral_lease_deadline_install(os.getpid()), -1)
                self.assertEqual(library.canaveral_lease_deadline_arm(100, 1), -1)
                with self.assertRaises(Error): LinuxKernelDeadline(output, os.getppid())


if __name__ == '__main__': unittest.main()
