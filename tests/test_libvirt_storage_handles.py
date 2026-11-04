import errno
import os
import signal
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.libvirt_storage_handles import LinuxFileLease, StorageHandleGuard, StorageHandlesUnknown


class FakeLease:
    def __init__(self, fd): self.fd = fd; self.closed = False; self.broken = False
    def verify(self):
        if self.closed or self.broken: raise OSError(errno.EAGAIN, 'fixture lease break')
    def close(self): self.closed = True


class StorageHandleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'owned'; self.root.mkdir(mode=0o700)
        self.disk = self.root/'disk.qcow2'; self.disk.write_bytes(b'private guest disk'); self.disk.chmod(0o600)
        self.state = self.root/'tpm-state'; self.state.mkdir(mode=0o700)
        (self.state/'state').write_bytes(b'private tpm state')
        value = self.root.stat(); self.expected = (value.st_dev, value.st_ino)
        self.leases = []

    def factory(self, fd):
        lease = FakeLease(fd); self.leases.append(lease); return lease

    def guard(self): return StorageHandleGuard(self.root, self.expected, self.factory)

    def assert_closed(self, descriptors):
        for fd in descriptors:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_all_files_held_until_context_exit_without_any_erasure(self):
        with self.guard() as guard:
            self.assertEqual(len(self.leases), 2); guard.verify()
            descriptors = [item[0] for item in guard.files + guard.directories]
            self.assertTrue(all(not os.get_inheritable(fd) for fd in descriptors))
            self.assertEqual(self.disk.read_bytes(), b'private guest disk') # Fake leases only.
        self.assert_closed(descriptors); self.assertTrue(all(item.closed for item in self.leases))
        self.assertTrue(self.disk.exists()); self.assertTrue((self.state/'state').exists())
        with self.assertRaises(StorageHandlesUnknown): guard.verify()
        guard.close() # Idempotent descriptor release.

    def test_break_request_latches_failure_even_if_fake_lease_is_restored(self):
        with self.guard() as guard:
            self.leases[0].broken = True
            with self.assertRaises(StorageHandlesUnknown): guard.verify()
            self.leases[0].broken = False
            with self.assertRaises(StorageHandlesUnknown): guard.verify()

    def test_partial_acquisition_closes_earlier_leases_and_all_opened_fds(self):
        opened = []
        def factory(fd):
            opened.append(fd)
            if len(opened) == 2: raise OSError(errno.EAGAIN, 'fixture existing open')
            return self.factory(fd)
        with self.assertRaises(StorageHandlesUnknown): StorageHandleGuard(self.root, self.expected, factory)
        self.assert_closed(opened); self.assertTrue(self.leases[0].closed)

    def test_fd_exhaustion_retains_files_and_releases_partial_guard(self):
        actual = os.open
        def limited(path, *args, **kwargs):
            if path == 'state': raise OSError(errno.EMFILE, 'fixture limit')
            return actual(path, *args, **kwargs)
        with patch('canaveral.libvirt_storage_handles.os.open', side_effect=limited):
            with self.assertRaises(StorageHandlesUnknown): self.guard()
        self.assertTrue(all(item.closed for item in self.leases)); self.assertTrue(self.disk.exists())

    def test_symlinks_hardlinks_and_special_files_are_refused(self):
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind):
                extra = self.root/'alias'
                if kind == 'symlink': extra.symlink_to(self.disk)
                elif kind == 'hardlink': os.link(self.disk, extra)
                else: os.mkfifo(extra)
                try:
                    with self.assertRaises(StorageHandlesUnknown): self.guard()
                finally: extra.unlink()

    def test_wrong_root_inode_and_unsafe_permissions_are_refused(self):
        with self.assertRaises(StorageHandlesUnknown): StorageHandleGuard(self.root, (0, 0), self.factory)
        for target in (self.root, self.disk, self.state):
            prior = target.stat().st_mode & 0o777
            target.chmod(prior | 0o020)
            try:
                with self.assertRaises(StorageHandlesUnknown): self.guard()
            finally: target.chmod(prior)

    def test_path_replacement_content_mutation_and_added_entries_are_refused(self):
        for mutation in ('replace', 'write', 'add'):
            with self.subTest(mutation=mutation), self.guard() as guard:
                if mutation == 'replace':
                    self.disk.unlink(); self.disk.write_bytes(b'replacement'); self.disk.chmod(0o600)
                elif mutation == 'write': self.disk.write_bytes(b'changed')
                else: (self.root/'new').write_bytes(b'new')
                with self.assertRaises(StorageHandlesUnknown): guard.verify()

    def test_root_replacement_is_refused_without_following_new_tree(self):
        with self.guard() as guard:
            old = self.root.with_name('quarantined'); self.root.rename(old); self.root.mkdir(mode=0o700)
            with self.assertRaises(StorageHandlesUnknown): guard.verify()
            self.assertTrue((old/'disk.qcow2').exists())

    def test_lease_release_failure_still_closes_every_descriptor(self):
        guard = self.guard(); descriptors = [item[0] for item in guard.files + guard.directories]
        self.leases[-1].close = lambda: (_ for _ in ()).throw(OSError('fixture release'))
        with self.assertRaises(StorageHandlesUnknown): guard.close()
        self.assert_closed(descriptors); self.assertTrue(self.leases[0].closed)

    def test_unsupported_platform_refuses_even_empty_storage(self):
        self.disk.unlink(); (self.state/'state').unlink(); self.state.rmdir()
        with patch('canaveral.libvirt_storage_handles.sys.platform', 'darwin'):
            with self.assertRaises(StorageHandlesUnknown): StorageHandleGuard(self.root, self.expected)

    def test_foreign_uid_and_directory_replacement_are_refused(self):
        with patch('canaveral.libvirt_storage_handles.os.geteuid', return_value=os.geteuid() + 1):
            with self.assertRaises(StorageHandlesUnknown): self.guard()
        with self.guard() as guard:
            self.state.rename(self.root/'old-state'); self.state.mkdir(mode=0o700)
            with self.assertRaises(StorageHandlesUnknown): guard.verify()

    def test_open_to_pin_race_is_refused_before_acquiring_lease(self):
        actual = os.open
        def replaced(path, *args, **kwargs):
            if path == 'disk.qcow2':
                self.disk.rename(self.root/'retained-old-disk')
                self.disk.write_bytes(b'replacement'); self.disk.chmod(0o600)
            return actual(path, *args, **kwargs)
        with patch('canaveral.libvirt_storage_handles.os.open', side_effect=replaced):
            with self.assertRaises(StorageHandlesUnknown): self.guard()
        self.assertEqual(self.leases, [])
        self.assertEqual((self.root/'retained-old-disk').read_bytes(), b'private guest disk')


class LinuxFileLeaseTests(unittest.TestCase):
    def setUp(self):
        self.calls = []; self.owner = os.getpid(); self.sig = signal.SIGURG; self.kind = 2
        self.native = SimpleNamespace(F_SETOWN=1, F_SETSIG=2, F_SETLEASE=3, F_WRLCK=2,
            F_GETOWN=4, F_GETSIG=5, F_GETLEASE=6, F_UNLCK=8, fcntl=self.call)
        self.platform = patch('canaveral.libvirt_storage_handles.sys.platform', 'linux'); self.platform.start()
        self.addCleanup(self.platform.stop)
        self.api = patch('canaveral.libvirt_storage_handles.fcntl', self.native); self.api.start(); self.addCleanup(self.api.stop)
        self.disposition = patch('canaveral.libvirt_storage_handles.signal.getsignal', return_value=signal.SIG_DFL)
        self.disposition.start(); self.addCleanup(self.disposition.stop)

    def call(self, fd, command, *args):
        self.calls.append((fd, command, *args))
        return {4: self.owner, 5: self.sig, 6: self.kind}.get(command, 0)

    def test_notification_is_configured_before_lease_and_release_is_explicit(self):
        lease = LinuxFileLease(99)
        self.assertEqual(self.calls[:3], [(99, 1, os.getpid()), (99, 2, signal.SIGURG), (99, 3, 2)])
        lease.verify(); lease.close(); self.assertEqual(self.calls[-1], (99, 3, 8))
        with self.assertRaises(StorageHandlesUnknown): lease.verify()

    def test_kernel_break_wrong_signal_and_wrong_owner_are_refused(self):
        for field, value in (('kind', 8), ('kind', 1), ('owner', -1), ('sig', signal.SIGIO)):
            self.owner = os.getpid(); self.sig = signal.SIGURG; self.kind = 2
            lease = LinuxFileLease(99); setattr(self, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(StorageHandlesUnknown): lease.verify()
            lease.close()

    def test_failed_acquisition_and_initial_verification_release_safely(self):
        def conflict(fd, command, *args):
            if command == 3 and args == (2,): raise OSError(errno.EAGAIN, 'fixture open handle')
            return self.call(fd, command, *args)
        self.native.fcntl = conflict
        with self.assertRaises(StorageHandlesUnknown): LinuxFileLease(99)
        self.native.fcntl = self.call; self.kind = 8; self.calls.clear()
        with self.assertRaises(StorageHandlesUnknown): LinuxFileLease(99)
        self.assertEqual(self.calls[-1], (99, 3, 8))

    def test_custom_signal_handler_is_refused_without_changing_it(self):
        with patch('canaveral.libvirt_storage_handles.signal.getsignal', return_value=lambda *_: None):
            with self.assertRaises(StorageHandlesUnknown): LinuxFileLease(99)
        self.assertEqual(self.calls, [])

    def test_forked_copy_cannot_validate_or_unlock_original_lease(self):
        lease = LinuxFileLease(99); self.calls.clear()
        with patch('canaveral.libvirt_storage_handles.os.getpid', return_value=os.getpid() + 1):
            with self.assertRaises(StorageHandlesUnknown): lease.verify()
            lease.close()
        self.assertEqual(self.calls, [])

    def test_query_failure_is_latched_and_cannot_be_revived(self):
        lease = LinuxFileLease(99)
        self.native.fcntl = lambda *_: (_ for _ in ()).throw(OSError(errno.EIO, 'fixture kernel query'))
        with self.assertRaises(StorageHandlesUnknown): lease.verify()
        self.native.fcntl = self.call
        with self.assertRaises(StorageHandlesUnknown): lease.verify()
        lease.close()


if __name__ == '__main__': unittest.main()
