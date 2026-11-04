"""Real private IPC with filesystem doubles; opens no native Windows files."""
import json
from pathlib import Path
import struct
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_windows_file_handles import API
from canaveral.guest.windows_file_handles import WindowsRoot
from canaveral.guest.windows_file_worker import serve, RESPONSE_BYTES
from canaveral.guest.windows_worker import _packet, _write_packet

mode, marker = sys.argv[1], Path(sys.argv[2])
if mode == 'never-read':
    marker.write_text('entered')
    time.sleep(60)
    sys.exit(0)


def factory(drive, prefix):
    if mode == 'constructor-failure': raise ValueError('private configuration')
    api = API()
    api.file.data = bytes(range(256))*4100
    api.file.info['size'] = len(api.file.data)
    api.list_entries = [{'name': 'data', 'kind': 'file', 'size': api.file.info['size']}]
    if mode == 'large-list':
        api.list_entries = [{'name': 'x'*1000+str(i), 'kind': 'file', 'size': i} for i in range(1000)]
    read = api.read
    def wrapped_read(handle, offset, count):
        with marker.open('a') as f: f.write(str(offset)+'\n')
        if mode in ('hang-read', 'slow-read'):
            while not marker.with_suffix('.release').exists(): time.sleep(.01)
        if mode == 'crash-read': sys.exit(1)
        return read(handle, offset, count)
    api.read = wrapped_read
    if mode in ('uncertain-close', 'retry-close'):
        close = api.close
        def uncertain(handle):
            if mode == 'uncertain-close' or not marker.with_suffix('.release').exists():
                raise OSError('private file handle path')
            return close(handle)
        api.close = uncertain
    root = WindowsRoot(drive, prefix, api=api)
    if mode == 'hang-open':
        start = root.start
        def hang():
            marker.write_text('opening')
            time.sleep(60)
            return start()
        root.start = hang
    return root


class Writer:
    def write(self, packet):
        value = json.loads(bytes(packet)[4:])
        if mode == 'mismatch': value['id'] = 'other'
        if mode == 'bad-open' and value.get('result', {}).get('fileId'):
            value['result'] = {'volume': True, 'fileId': 'bad'}
        if mode == 'bad-chunk' and 'data' in value.get('result', {}):
            value['result']['data'] = '*'
        if mode == 'bad-close' and 'closed' in value.get('result', {}):
            value['result']['closed'] = 1
        if mode == 'false-refusal':
            value = {'id': value['id'], 'ok': False, 'status': 200,
                     'code': 'input_busy', 'outcome': None}
        if mode == 'oversize':
            sys.stdout.buffer.write(struct.pack('!I', RESPONSE_BYTES+1))
            sys.stdout.buffer.flush()
        elif mode == 'truncated':
            sys.stdout.buffer.write(struct.pack('!I', 100)+b'{')
            sys.stdout.buffer.flush()
            sys.exit(0)
        else: _write_packet(sys.stdout.buffer, _packet(value, RESPONSE_BYTES))
        if mode == 'never-files' and value.get('result', {}).get('fileId'):
            marker.write_text('not reading file requests')
            time.sleep(60)
        return len(packet)

    def flush(self): pass


serve(sys.stdin.buffer, Writer(), factory)
