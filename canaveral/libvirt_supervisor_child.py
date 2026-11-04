"""Dedicated native libvirt lease child. Never invoked for ordinary machines."""
import argparse
import os
import sys

from .libvirt_execution import library_digest, linux_boot_id, ownership, read_spec
from .lease_clock import execution_monotonic
from .libvirt_supervision import (LibvirtLeaseSupervisor, LinuxKernelDeadline,
    NativeLibvirtConnection, SupervisorJournal, matches_identity)
from .model import Error


def run_child(folder, parent_pid, fence_factory=LinuxKernelDeadline, connection_factory=NativeLibvirtConnection,
              host_boot=linux_boot_id, parent=os.getppid, wait=None, clock=execution_monotonic):
    if type(parent_pid) is not int or parent_pid <= 1 or parent() != parent_pid:
        raise Error('Libvirt supervisor parent identity differs.', 409)
    journal = SupervisorJournal(folder)
    try:
        binding, spec = read_spec(journal)
        prepared = journal.read()
        if not matches_identity(prepared, binding.identity()) or prepared != {**binding.identity(), 'phase': 'prepared'}:
            raise Error('Libvirt child launch history is already used or unknown.', 409)
        launch = journal.read_named('libvirt-launch.json')
        if not matches_identity(launch, binding.identity()) or type(launch.get('parentPid')) is not int or launch['parentPid'] != parent_pid:
            raise Error('Libvirt supervisor launch does not match this parent.', 409)
        library = spec['library']
        fd = os.open(library['path'], os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
        try:
            if library_digest(fd) != library['sha256']: raise Error('Libvirt deadline artifact digest differs.', 409)
            # The loader sees this pinned inode, not a path that can be swapped
            # after hashing. The mapping remains while the fence owns its CDLL.
            fence = fence_factory('/proc/self/fd/'+str(fd), parent_pid)
        finally: os.close(fd)
        supervisor = LibvirtLeaseSupervisor(binding, journal,
            lambda: journal.read_named('libvirt-authorization.json'),
            lambda: ownership(journal, binding, spec), host_boot,
            lambda: connection_factory(spec['uri'], binding.machine_id), fence, clock=clock)
        if wait is None: supervisor.run()
        else: supervisor.run(wait=wait)
    finally: journal.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Internal dedicated libvirt lease supervisor child.')
    parser.add_argument('--state-directory', required=True)
    parser.add_argument('--parent-pid', required=True, type=int)
    args = parser.parse_args(argv)
    if not sys.platform.startswith('linux'):
        print('Libvirt supervisor requires a dedicated Linux child.', file=sys.stderr); return 1
    try: run_child(args.state_directory, args.parent_pid)
    except BaseException:
        # Native/private paths, credentials and exception traces stay out of
        # the public worker protocol. Pending launch history is not cleared.
        print('Libvirt leased supervision ended without cleanup confirmation.', file=sys.stderr); return 1
    return 0


if __name__ == '__main__': raise SystemExit(main())
