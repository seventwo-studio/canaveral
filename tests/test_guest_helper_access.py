import copy
import hashlib
import io
import json
import struct
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from canaveral.accessibility import inspect_provider, inspection_supported
from canaveral.guest_helper_access import GuestHelperAccess, GuestHelperBinding
from canaveral.model import Error
from canaveral.runner_sessions import RunnerSession
from test_display_access import Channel
from test_guest_chunk_files import Helper as Files
from test_guest_stream_display import Helper as Display


class GuestHelperAccessTests(unittest.TestCase):
    """Injected fake guest transport; no enrollment, VM or native UI effects."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.machine = {'id': str(uuid.uuid4())}; self.image = {'os': 'macos'}
        self.allowed = True; self.cleanup_allowed = False
        self.files = Files(); self.display = Display(); self.calls = []; self.shells = {}
        self.snapshot = {'snapshotId': str(uuid.uuid4()), 'capturedAt': 100,
            'source': 'macos-accessibility', 'coordinateSpace': 'screen-points',
            'nodes': [{'id': 'button', 'parentId': None, 'depth': 0, 'role': 'AXButton',
                       'name': 'Save', 'identifier': 'save-button', 'states': {'enabled': True},
                       'actions': ['click'], 'bounds': {'x': 1, 'y': 2, 'width': 20, 'height': 10},
                       'properties': {}}], 'truncated': False, 'coverage': 'Fixture native controls only.'}
        self.binding = GuestHelperBinding(self.request, lambda: self.allowed, lambda: self.cleanup_allowed)
        self.resolve = Mock(return_value=self.binding)
        self.access = GuestHelperAccess(self.resolve)

    def request(self, path, body):
        self.calls.append((path, body))
        if path.startswith('/v1/files/'): return self.files(path, body)
        if path.startswith('/v1/display/'): return self.display(path, body)
        if path == '/v1/accessibility': return copy.deepcopy(self.snapshot)
        session = body['session']
        if path == '/v1/shell/open': self.shells[session] = b''; return {'session': session}
        if path == '/v1/shell/write':
            data = body['text'].encode(); self.shells[session] += data; return {'written': len(data)}
        if path == '/v1/shell/close': self.shells.pop(session); return {'closed': True}
        raise AssertionError(path)

    def control(self, action, arguments):
        return self.access.control(self.machine, self.image, self.folder,
                                   {'action': action, 'arguments': arguments})

    def worker(self, capability):
        job = {key: str(uuid.uuid4()) for key in ('id', 'generation', 'leaseId', 'machineId')}
        job['capability'] = capability
        manager = SimpleNamespace(root=self.folder, authorized=lambda job: True)
        runtime = SimpleNamespace(access=self.access)
        worker = RunnerSession(manager, job, self.machine, runtime, self.image, self.folder)
        worker.connection = Channel()
        return worker

    def test_common_runner_upload_and_verified_download_use_bound_native_files(self):
        data = bytes(range(256)) * 2100
        upload = self.worker('upload'); checksum = hashlib.sha256(data).hexdigest()
        upload.connection.incoming.put({'type': 'begin', 'path': '/guest/file', 'size': len(data)})
        for offset in range(0, len(data), 65536): upload.connection.incoming.put(data[offset:offset+65536])
        upload.connection.incoming.put({'type': 'finish', 'bytes': len(data), 'sha256': checksum})
        upload.upload()
        self.assertEqual(upload.connection.next(), {'type': 'finish', 'bytes': len(data), 'sha256': checksum, 'durable': True})
        self.assertEqual(self.files.data, data); self.files.verified = 0
        download = self.worker('download'); download.connection.incoming.put({'type': 'begin', 'path': '/guest/file'})
        download.download(); self.assertEqual(download.connection.next(), {'type': 'begin', 'size': len(data)})
        received = bytearray()
        while True:
            value = download.connection.next()
            if isinstance(value, dict): break
            received.extend(value)
        self.assertEqual(bytes(received), data)
        self.assertEqual(value, {'type': 'finish', 'bytes': len(data), 'sha256': checksum})
        self.resolve.assert_called_with(self.machine, self.image, self.folder)

    def test_native_inspection_flows_through_common_worker_with_exact_digest(self):
        worker = self.worker('accessibility'); worker.connection.incoming.put({'type': 'begin'})
        worker.accessibility()
        begin = worker.connection.next(); data = worker.connection.next(); finish = worker.connection.next()
        self.assertEqual(begin, {'type': 'begin', 'schema': 'canaveral-accessibility-v1', 'size': len(data)})
        self.assertEqual(json.loads(data), self.snapshot)
        self.assertEqual(finish, {'type': 'finish', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        self.assertEqual(self.calls, [('/v1/accessibility', None)])
        self.assertIsNone(self.display.owner)

    def test_inspection_requires_explicit_adapter_and_keeps_native_snapshot_ids(self):
        provider = SimpleNamespace(access=self.access)
        self.assertTrue(inspection_supported(provider, self.image))
        self.assertFalse(inspection_supported(SimpleNamespace(access=None), self.image))
        self.assertFalse(inspection_supported(SimpleNamespace(access=Mock()), self.image))
        result = inspect_provider(provider, self.machine, self.image, self.folder)
        self.assertEqual(result, self.snapshot)
        self.assertEqual(self.calls, [('/v1/accessibility', None)])

    def test_nine_terminals_keep_distinct_sessions_and_explicit_owned_cleanup(self):
        sessions = [str(uuid.uuid4()) for _ in range(9)]
        for session in sessions:
            self.control('shell-open', {'session': session})
            self.control('shell-write', {'session': session, 'text': session})
        self.assertEqual(len(self.shells), 9)
        for session in sessions: self.assertEqual(self.shells[session], session.encode())
        self.allowed = False
        with self.assertRaises(Error): self.control('shell-close', {'session': sessions[0]})
        self.cleanup_allowed = True
        for session in sessions: self.assertEqual(self.control('shell-close', {'session': session}), {'closed': True})
        self.assertFalse(self.shells)
        with self.assertRaises(Error): self.control('shell-open', {'session': str(uuid.uuid4())})

    def test_legacy_input_has_no_fallback_without_owned_stream_context(self):
        for action, args in [('tap', {'x': 1, 'y': 2}), ('text', {'text': 'private'}),
                             ('accessibility-action', {'snapshotId': self.snapshot['snapshotId'], 'nodeId': 'button', 'nativeAction': 'click'})]:
            with self.subTest(action=action), self.assertRaises(Error): self.control(action, args)
        self.assertFalse(self.calls); self.resolve.assert_not_called()

    def test_bound_display_keeps_ordered_raw_and_durable_semantic_input_on_one_owner(self):
        from canaveral.providers.base import Provider
        provider = Provider({}, self.folder); provider.access = self.access
        connection = self.access.desktop(self.machine, self.image, self.folder)
        connection.settimeout(2); self.addCleanup(connection.close)
        def read(size):
            data = bytearray()
            while len(data) < size:
                part = connection.recv(size-len(data))
                if not part: self.fail('Fixture display closed before handshake completed')
                data.extend(part)
            return bytes(data)
        self.assertEqual(read(12), b'RFB 003.008\n'); connection.sendall(b'RFB 003.008\n')
        self.assertEqual(read(2), b'\x01\x01'); connection.sendall(b'\x01')
        self.assertEqual(read(4), bytes(4)); connection.sendall(b'\x01')
        header = read(24); read(struct.unpack('!I', header[20:])[0])
        self.assertEqual(connection.take_input(), 'owned'); owner = self.display.owner
        connection.sendall(struct.pack('!BB2xI', 4, 1, 65)+struct.pack('!BB2xI', 4, 0, 65))
        self.assertTrue(connection.barrier(reset=False))
        self.control('accessibility', {})
        self.assertEqual(self.display.owner, owner); self.assertFalse(self.display.releases)
        operation = {'id': str(uuid.uuid4()), 'action': 'text', 'arguments': {'text': 'once'},
                     'expiresAt': time.time()+30}
        machine = {**self.machine, 'desired': 'running'}
        first = provider.operate(machine, self.image, self.folder, operation, control_handler=connection.control_action)
        self.assertEqual(first['state'], 'succeeded')
        second = provider.operate(machine, self.image, self.folder, operation, control_handler=connection.control_action)
        self.assertEqual(second, first)
        self.assertEqual([effect['type'] for effect in self.display.effects], ['key', 'key', 'semantic'])
        self.assertEqual(self.display.owner, owner)
        self.cleanup_allowed = True; self.assertTrue(connection.cancel_input())
        self.assertEqual(self.display.releases, [owner])

    def test_display_session_revocation_blocks_native_dispatch_even_if_assignment_is_current(self):
        session_active = [True]
        connection = self.access.desktop_session(self.machine, self.image, self.folder, lambda: session_active[0])
        self.addCleanup(connection.close)
        screen = connection.screen
        # The fake helper's initial capture and this claim share its native lock.
        screen.capture()
        self.assertEqual(screen.take_input(), 'owned')
        session_active[0] = False
        with self.assertRaisesRegex(Error, 'authorization ended'): screen.key(1, 65)
        self.assertTrue(self.allowed); self.assertFalse(self.display.effects)
        self.cleanup_allowed = True
        self.assertTrue(screen.reset_input()); self.assertEqual(len(self.display.releases), 1)

    def test_common_runner_display_selects_bound_access_and_records_owned_semantic_action(self):
        from canaveral.display_access import DisplayControls
        from canaveral.providers.base import Provider
        worker = self.worker('display'); worker.machine['desired'] = 'running'
        worker.runtime = Provider({}, self.folder); worker.runtime.access = self.access
        controls = DisplayControls(self.folder/'display-controls.json')
        worker.manager.agent = SimpleNamespace(display_controls=controls)
        self.cleanup_allowed = True; errors = []
        def run():
            try: worker.display()
            except Exception as error: errors.append(error)
        thread = threading.Thread(target=run); thread.start()
        def stop():
            worker.close(); thread.join(4); controls.close()
            self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])
        self.addCleanup(stop)
        channel = worker.connection
        self.assertEqual(channel.next(), b'RFB 003.008\n'); channel.incoming.put(b'RFB 003.008\n')
        self.assertEqual(channel.next(), b'\x01\x01'); channel.incoming.put(b'\x01')
        self.assertEqual(channel.next(), bytes(4)); channel.incoming.put(b'\x01')
        self.assertEqual(struct.unpack('!HH', channel.next()[:4]), (4, 3))
        self.assertEqual(channel.next(), {'type': 'control', 'state': 'view-only'})
        channel.incoming.put({'type': 'input-control', 'action': 'take'})
        self.assertEqual(channel.next(), {'type': 'control', 'state': 'owned'})
        channel.incoming.put({'type': 'action', 'id': str(uuid.uuid4()), 'action': 'text', 'arguments': {'text': 'once'}})
        self.assertEqual(channel.next()['state'], 'succeeded')
        self.assertEqual(len(self.display.effects), 1)
        channel.incoming.put({'type': 'input-control', 'action': 'release'})
        self.assertEqual(channel.next(), {'type': 'control', 'state': 'view-only'})
        self.assertIsNone(self.display.owner)

    def test_binding_revocation_during_acknowledgement_never_reports_success(self):
        def revoke(path, body): self.allowed = False; return {'written': 1}
        self.binding = GuestHelperBinding(revoke, lambda: self.allowed)
        self.resolve.return_value = self.binding
        with self.assertRaisesRegex(Error, 'before acknowledgement'):
            self.control('shell-write', {'session': str(uuid.uuid4()), 'text': 'x'})
        self.assertFalse(self.allowed)

    def test_private_transport_errors_are_redacted_and_never_retried(self):
        for failure in (Error('token=secret host=private', 409, code='input_busy'), OSError('private guest path')):
            request = Mock(side_effect=failure); binding = GuestHelperBinding(request, lambda: True)
            with self.subTest(failure=type(failure).__name__), self.assertRaises(Error) as caught:
                binding.call('/v1/display/take', {'streamId': str(uuid.uuid4())})
            self.assertNotIn('private', str(caught.exception)); self.assertNotIn('secret', str(caught.exception))
            self.assertEqual(request.call_count, 1)
            if isinstance(failure, Error): self.assertEqual(caught.exception.code, 'input_busy')

    def test_cleanup_authority_cannot_be_used_for_inspection_files_or_input(self):
        self.allowed = False; self.cleanup_allowed = True
        for route in ('/v1/accessibility', '/v1/files/upload/finish', '/v1/display/input', '/v1/shell/write'):
            with self.subTest(route=route), self.assertRaises(Error): self.binding.call(route, {}, cleanup=True)
        self.assertFalse(self.calls)

    def test_unbound_other_platforms_and_container_paths_do_not_dispatch(self):
        with self.assertRaises(Error): self.access.inspect(self.machine, {'os': 'windows'}, self.folder)
        self.resolve.assert_not_called()
        with self.assertRaises(Error): self.access.stream_download(self.machine, self.image, self.folder, '/file', 'app')
        self.resolve.assert_not_called()
        self.resolve.return_value = None
        with self.assertRaisesRegex(Error, 'binding is missing'): self.control('list-files', {'path': '/'})
        self.assertFalse(self.calls)

    def test_malformed_or_wrong_native_inspection_cannot_enter_common_session(self):
        for change in ({'source': 'ios-accessibility'}, {'coordinateSpace': 'screen-pixels'},
                       {'snapshotId': 'bad'}, {'frame': {}}, {'capturedAt': float('nan')},
                       {'coverage': 'x' * (6*1048576)}):
            original = self.snapshot; self.snapshot = {**original, **change}
            with self.subTest(change=list(change)), self.assertRaises(Error): self.control('accessibility', {})
            self.snapshot = original


if __name__ == '__main__': unittest.main()
