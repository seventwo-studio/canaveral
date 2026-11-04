"""Disposable stdio child for worker tests; imports no native Windows API."""
import contextlib
import json
from pathlib import Path
import struct
import signal
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_windows_accessibility import WindowsAccessibilityTests
from canaveral.guest.windows_worker import serve, _read_packet, _packet, _write_packet, MAX_REQUEST


mode = sys.argv[1]
marker = Path(sys.argv[2])
if mode == 'never-read':
    time.sleep(60)
    sys.exit(0)


@contextlib.contextmanager
def fixture_api():
    fixture = WindowsAccessibilityTests()
    fixture.setUp()
    api = fixture.api
    if mode == 'mark-inspect':
        original = api.root
        def marked_root():
            marker.write_text('inspection was dispatched')
            return original()
        api.root = marked_root
    if mode in ('hang-inspect', 'ignore-terminate'):
        def root():
            if mode == 'ignore-terminate':
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            marker.write_text('entered inspection')
            time.sleep(60)
        api.root = root
    if mode in ('hang-invoke', 'uncertain'):
        def invoke(element):
            with marker.open('a') as stream:
                stream.write('invoked\n')
            if mode == 'hang-invoke':
                time.sleep(60)
            raise OSError('private credential and endpoint')
        api.invoke = invoke
    yield api


if mode in ('normal', 'hang-inspect', 'hang-invoke', 'uncertain', 'mark-inspect', 'ignore-terminate'):
    serve(sys.stdin.buffer, sys.stdout.buffer, fixture_api)
else:
    request = _read_packet(sys.stdin.buffer, MAX_REQUEST)
    if mode == 'oversized':
        sys.stdout.buffer.write(struct.pack('!I', 2**31))
        sys.stdout.buffer.flush()
    elif mode == 'truncated':
        sys.stdout.buffer.write(struct.pack('!I', 50)+b'{}')
        sys.stdout.buffer.flush()
    elif mode == 'mismatched':
        _write_packet(sys.stdout.buffer, _packet({'id': 'other', 'ok': True, 'result': {}}, 16384))
    elif mode == 'bad-snapshot':
        _write_packet(sys.stdout.buffer, _packet({'id': request['id'], 'ok': True, 'result': {}}, 16384))
    elif mode == 'bad-action':
        _write_packet(sys.stdout.buffer, _packet({'id': request['id'], 'ok': True, 'result': {}}, 16384))
    elif mode == 'crash':
        sys.exit(9)
    elif mode == 'false-refusal':
        _write_packet(sys.stdout.buffer, _packet({'id': request['id'], 'ok': False,
            'status': 409, 'code': 'input_rejected', 'outcome': 'unknown'}, 16384))
    else:
        raise AssertionError(mode)
