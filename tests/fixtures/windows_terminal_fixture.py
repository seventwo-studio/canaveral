"""Private ConPTY-shaped worker fixture; never launches a native shell."""
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_windows_conpty import API
from canaveral.guest.windows_conpty import ConPTY
from canaveral.guest.windows_terminal_worker import serve
from canaveral.guest.windows_worker import _read_packet, _packet, _write_packet

mode, marker = sys.argv[1], Path(sys.argv[2])
if mode == 'mismatch':
    _read_packet(sys.stdin.buffer, 65536)
    _write_packet(sys.stdout.buffer, _packet({'id': 'other', 'ok': True, 'result': {}}, 98304))
    sys.exit(0)


def factory(session, executable, argv, directory):
    if mode == 'constructor-failure':
        raise ValueError('No native resource has been created')
    api = API()
    original_write = api.write
    if mode in ('slow-write', 'hang-write'):
        def slow(handle, data):
            marker.write_text('write entered')
            deadline = time.monotonic()+30
            while not marker.with_suffix('.release').exists() and time.monotonic() < deadline:
                time.sleep(.01)
            return original_write(handle, data)
        api.write = slow
    if mode == 'uncertain-write':
        def uncertain(handle, data):
            marker.write_text('input may have been dispatched')
            raise OSError('private guest path and credential')
        api.write = uncertain
    if mode == 'uncertain-close':
        api.failure = 'terminate'
    if mode == 'hang-start':
        def console(*args):
            marker.write_text('startup entered')
            time.sleep(60)
        api.console = console
    terminal = ConPTY(session, executable, argv, directory, api=api)
    api.output.put(b'output while input is pending')
    if mode == 'bad-write-ack':
        terminal.write = lambda text: {'written': 0}
    return terminal


serve(sys.stdin.buffer, sys.stdout.buffer, factory)
