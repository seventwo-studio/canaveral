"""Build an uninstalled Linux lease timer library at an explicit new path."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    if not sys.platform.startswith('linux'): parser.error('The native deadline shim must be built on Linux.')
    output = args.output
    if not output.is_absolute() or output.exists() or output.is_symlink():
        parser.error('Choose a new absolute output path; existing artifacts are retained.')
    source = Path(__file__).resolve().parents[1]/'canaveral/native/linux_lease_deadline.c'
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.linux-deadline-', suffix='.so', dir=output.parent)
    os.close(descriptor)
    try:
        subprocess.run(['cc', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(source), '-lrt', '-o', temporary], check=True)
        with open(temporary, 'rb') as stream: os.fsync(stream.fileno())
        # Link publication refuses a destination created during compilation.
        os.link(temporary, output)
        os.unlink(temporary)
        temporary = None
        directory = os.open(output.parent, os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
        print(json.dumps({'path': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'sourceSHA256': hashlib.sha256(source.read_bytes()).hexdigest(), 'abi': 1,
            'installed': False, 'nativeLeaseAcceptance': False}))
    finally:
        if temporary is not None and os.path.exists(temporary): os.unlink(temporary)


if __name__ == '__main__': main()
