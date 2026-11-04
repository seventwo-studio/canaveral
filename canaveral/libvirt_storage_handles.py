"""Temporary exclusive access to an already stopped, owned storage tree.

This is an internal cleanup primitive, not a durable stop/erasure receipt. The
caller must fence execution and hold assignment/teardown locks independently.
No path is removed here. Content clearing requires a separately durable manifest
and transaction intent. Production use still requires Linux native acceptance.
"""
import fcntl
import os
import signal
import stat
import sys


class StorageHandlesUnknown(Exception):
    """Exclusive access could not be established or has been lost."""


class LinuxFileLease:
    """Hold a write lease on a caller-owned, non-inherited file descriptor."""
    def __init__(self, fd):
        self.fd = fd
        self.held = False
        self.failed = False
        self.pid = os.getpid()
        if sys.platform != 'linux':
            raise StorageHandlesUnknown('Linux file leases are unavailable.')
        # SIGURG has an ignored default disposition. Do not change process-wide
        # handlers or risk the default SIGIO termination on a break request.
        if signal.getsignal(signal.SIGURG) not in (signal.SIG_DFL, signal.SIG_IGN):
            raise StorageHandlesUnknown('Lease notification disposition is unavailable.')
        try:
            fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
            fcntl.fcntl(fd, fcntl.F_SETSIG, signal.SIGURG)
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
            self.held = True
            self.verify()
        except Exception as exc:
            self.close()
            raise StorageHandlesUnknown('Exclusive file lease is unavailable.') from exc

    def verify(self):
        # F_GETLEASE reports a requested break's target state immediately, even
        # before the kernel forcibly downgrades/releases the lease on timeout.
        try:
            if (not self.held or self.failed or os.getpid() != self.pid or
                    signal.getsignal(signal.SIGURG) not in (signal.SIG_DFL, signal.SIG_IGN) or
                    fcntl.fcntl(self.fd, fcntl.F_GETOWN) != self.pid or
                    fcntl.fcntl(self.fd, fcntl.F_GETSIG) != signal.SIGURG or
                    fcntl.fcntl(self.fd, fcntl.F_GETLEASE) != fcntl.F_WRLCK):
                raise StorageHandlesUnknown('Exclusive file lease was lost.')
        except Exception as exc:
            self.failed = True
            raise StorageHandlesUnknown('Exclusive file lease was lost.') from exc

    def close(self):
        if self.held:
            self.held = False
            # A forked child shares the open file description. Closing its fd
            # is safe; explicitly unlocking would release the parent's lease.
            if os.getpid() != self.pid: return
            # The owning guard closes the descriptor even if explicit release
            # fails; no other process inherits these descriptors.
            try: fcntl.fcntl(self.fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError: pass


def _identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class StorageHandleGuard:
    """Pin and lease every regular file, refusing aliases and tree changes.

    The root must be an absolute, privately owned directory reached through a
    trusted parent. An expected (device, inode) pair comes from the existing
    assignment binding. Symlinks, hard-linked files, special files and device
    boundaries are refused. A fake lease factory is solely an isolated-test seam.
    verify() is a point-in-time check; callers must retain this guard throughout
    their teardown transaction and must never persist it as reusable proof.
    """
    def __init__(self, root, expected, lease_factory=LinuxFileLease):
        self.root = os.fspath(root)
        self.expected = expected
        self.files = []
        self.directories = []
        self.closed = False
        self.failed = False
        self.pid = os.getpid()
        if not os.path.isabs(self.root) or self.root != os.path.normpath(self.root):
            raise StorageHandlesUnknown('Storage root must be absolute.')
        if (not isinstance(expected, tuple) or len(expected) != 2 or
                any(type(item) is not int or item < 0 for item in expected)):
            raise StorageHandlesUnknown('Storage identity is invalid.')
        if lease_factory is LinuxFileLease and sys.platform != 'linux':
            raise StorageHandlesUnknown('Linux file leases are unavailable.')
        try:
            descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.directories.append((descriptor, None, None, None, None))
            value = os.fstat(descriptor)
            if (value.st_dev, value.st_ino) != expected:
                raise StorageHandlesUnknown('Storage root identity changed.')
            self._walk(descriptor, lease_factory, 0)
            self.verify()
        except Exception as exc:
            self.failed = True
            self.close()
            raise StorageHandlesUnknown('Storage handles remain unconfirmed.') from exc

    def _walk(self, descriptor, lease_factory, index):
        value = os.fstat(descriptor)
        if (not stat.S_ISDIR(value.st_mode) or value.st_uid != os.geteuid() or
                value.st_mode & 0o022 or value.st_dev != self.expected[0]):
            raise StorageHandlesUnknown('Storage directory ownership is unconfirmed.')
        names = tuple(sorted(os.listdir(descriptor)))
        _, parent, name, _, _ = self.directories[index]
        self.directories[index] = (descriptor, parent, name, _identity(value), names)
        for name in names:
            before = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=descriptor)
                child_index = len(self.directories)
                self.directories.append((child, descriptor, name, None, None))
                if _identity(os.fstat(child)) != _identity(before):
                    raise StorageHandlesUnknown('Storage directory was replaced.')
                self._walk(child, lease_factory, child_index)
            elif stat.S_ISREG(before.st_mode):
                if (before.st_nlink != 1 or before.st_dev != self.expected[0] or
                        before.st_uid != os.geteuid() or before.st_mode & 0o022):
                    raise StorageHandlesUnknown('Storage file ownership is unconfirmed.')
                child = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                                dir_fd=descriptor)
                # Record the fd before any fallible check/factory call.
                self.files.append((child, descriptor, name, _identity(before), None))
                if _identity(os.fstat(child)) != _identity(before):
                    raise StorageHandlesUnknown('Storage file was replaced.')
                lease = lease_factory(child)
                self.files[-1] = (child, descriptor, name, _identity(before), lease)
            else:
                raise StorageHandlesUnknown('Storage contains an unsupported entry.')

    def verify(self):
        if self.closed or self.failed or os.getpid() != self.pid:
            raise StorageHandlesUnknown('Storage handle guard is no longer valid.')
        try:
            root = os.stat(self.root, follow_symlinks=False)
            if (root.st_dev, root.st_ino) != self.expected or not stat.S_ISDIR(root.st_mode):
                raise StorageHandlesUnknown('Storage root was replaced.')
            for fd, parent, name, identity, names in self.directories:
                if _identity(os.fstat(fd)) != identity or tuple(sorted(os.listdir(fd))) != names:
                    raise StorageHandlesUnknown('Storage directory changed.')
                if parent is not None and _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity:
                    raise StorageHandlesUnknown('Storage directory path changed.')
            for fd, parent, name, identity, lease in self.files:
                if (_identity(os.fstat(fd)) != identity or
                        _identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity):
                    raise StorageHandlesUnknown('Storage file changed.')
                lease.verify()
        except Exception as exc:
            self.failed = True # A later restored path/lease cannot revive proof.
            raise StorageHandlesUnknown('Storage handles remain unconfirmed.') from exc

    def close(self):
        if self.closed: return
        self.closed = True
        failed = False
        for fd, _, _, _, lease in reversed(self.files):
            try:
                if lease is not None: lease.close()
            except Exception: failed = True
            try: os.close(fd)
            except OSError: failed = True
        for fd, _, _, _, _ in reversed(self.directories):
            try: os.close(fd)
            except OSError: failed = True
        if failed: raise StorageHandlesUnknown('Storage handle release was uncertain.')

    def snapshot(self):
        """Stable path/inode inventory; does not persist or authorize erasure."""
        self.verify()
        names = {}
        result = []
        for fd, parent, name, identity, _ in self.directories:
            path = () if parent is None else names[parent] + (name,)
            names[fd] = path
            result.append({'path': list(path), 'identity': list(identity[:4]), 'kind': 'directory'})
        for _, parent, name, identity, _ in self.files:
            result.append({'path': list(names[parent] + (name,)), 'identity': list(identity[:4]), 'kind': 'file'})
        return sorted(result, key=lambda item: item['path'])

    def erase_contents(self):
        """Truncate and fsync every held file before any unlink is permitted.

        A transaction must durably bind snapshot() before calling this method.
        On interruption files remain present, allowing inode-checked recovery.
        This is logical erasure, not a claim of physical media sanitization.
        """
        self.verify()
        try:
            for index, (fd, parent, name, identity, lease) in enumerate(self.files):
                lease.verify()
                if _identity(os.fstat(fd)) != identity:
                    raise StorageHandlesUnknown('Storage file changed before clearing.')
                os.ftruncate(fd, 0)
                os.fsync(fd)
                after = _identity(os.fstat(fd))
                if after[:5] != identity[:5] or after[5] != 0:
                    raise StorageHandlesUnknown('Storage content clearing is unconfirmed.')
                self.files[index] = (fd, parent, name, after, lease)
            self.verify()
        except Exception as exc:
            self.failed = True
            raise StorageHandlesUnknown('Storage content clearing is unconfirmed.') from exc

    def verify_unlinked(self):
        """After owned removal, every pinned file must be empty and unlinked."""
        if self.closed or self.failed or os.getpid() != self.pid:
            raise StorageHandlesUnknown('Storage handle guard is no longer valid.')
        try:
            if os.path.lexists(self.root):
                raise StorageHandlesUnknown('Storage path remains after removal.')
            for fd, _, _, identity, lease in self.files:
                lease.verify()
                value = os.fstat(fd)
                if ((value.st_dev, value.st_ino, value.st_mode, value.st_uid) != identity[:4]
                        or value.st_size != 0 or value.st_nlink != 0):
                    raise StorageHandlesUnknown('Cleared storage remains linked or changed.')
        except Exception as exc:
            self.failed = True
            raise StorageHandlesUnknown('Storage removal is unconfirmed.') from exc

    def __enter__(self): return self

    def __exit__(self, *_): self.close()
