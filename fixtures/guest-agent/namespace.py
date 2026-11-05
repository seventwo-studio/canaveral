#!/usr/bin/env python3
"""Explicit Linux-only namespace acceptance gate; never falls back to host execution."""
import os
import sys

if sys.platform != 'linux' or os.environ.get('CANAVERAL_NAMESPACE_FIXTURE') != '1':
    sys.exit('GATED: Linux and CANAVERAL_NAMESPACE_FIXTURE=1 required')
# Preserve proof of the original namespaces for the helper to compare after exec.
for target, name in enumerate(('pid', 'mnt', 'net'), 3):
    fd = os.open('/proc/self/ns/' + name, os.O_RDONLY)
    if fd != target:
        os.dup2(fd, target)
        os.close(fd)
    os.set_inheritable(target, True)
# --map-auto requires configured subordinate uid/gid ranges and mapping helpers.
# Denial is a failed acceptance gate, never permission for sudo or a host fallback.
os.execvp('unshare', ['unshare', '--user', '--map-auto', '--map-root-user',
    '--pid', '--fork', '--mount', '--net', '--mount-proc', '--kill-child',
    sys.argv[1] if len(sys.argv) == 2 else 'target/debug/examples/namespace-supervision'])
