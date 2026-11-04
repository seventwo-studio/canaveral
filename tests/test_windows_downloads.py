"""Shared download interoperability with filesystem doubles, not Windows proof."""
import base64
import hashlib
import threading
import unittest
import uuid

from canaveral.guest.windows_downloads import WindowsDownloads
from canaveral.guest.windows_file_handles import WindowsRoot
from canaveral.guest_chunk_files import GuestChunkFiles, CHUNK
from canaveral.model import Error
from test_windows_file_handles import API


class WindowsDownloadTests(unittest.TestCase):
    def setup_files(self, data=b'hello', cleanup=None):
        api = API()
        api.file.data = data
        api.file.info['size'] = len(data)
        root = WindowsRoot('C:', ('home',), api=api)
        root.start()
        active = [True]
        def resolve(path):
            if path == '/': return ()
            if path == '/data': return ('data',)
            raise Error('Unbound guest path.', 400)
        files = WindowsDownloads(root, resolve, lambda: active[0], cleanup)
        def close():
            api.fail_close = None
            api.release.set()
            files.close()
        self.addCleanup(close)
        return files, api, active

    def call(self, files, route, identity, **values):
        return files('/v1/files/'+route, {'id': identity, **values})

    def begin(self, files):
        identity = str(uuid.uuid4())
        self.assertEqual(self.call(files, 'download/begin', identity, path='/data')['state'], 'reading')
        return identity

    def test_common_adapter_binary_multichunk_and_empty(self):
        for data in (b'', bytes(range(256))*(CHUNK//256+19)):
            with self.subTest(size=len(data)):
                files, api, _ = self.setup_files(data)
                adapter = GuestChunkFiles(files)
                download = adapter.download('/data')
                download.verify()
                received = bytearray()
                while True:
                    part = download.read(7919)
                    if not part: break
                    received.extend(part)
                self.assertEqual(received, data)
                download.verify()
                record = next(iter(files.records.values()))
                self.assertEqual(record.state, 'verified')
                self.assertEqual(record.sha256, hashlib.sha256(data).hexdigest())
                self.assertIsNone(record.pin)
                self.assertTrue(all(event[3] <= CHUNK for event in api.events if event[0] == 'read'))
                before = list(api.events)
                download.verify()
                self.assertEqual(api.events, before)
                download.close()

    def test_cursor_and_path_conflicts_preserve_original(self):
        files, _, _ = self.setup_files()
        identity = self.begin(files)
        for route, values in [('download/begin', {'path': '/other'}),
                              ('download/chunk', {'offset': 1}),
                              ('download/finish', {}), ('download/verify', {})]:
            with self.subTest(route=route), self.assertRaises(Error): self.call(files, route, identity, **values)
            self.assertEqual(self.call(files, 'status', identity)['state'], 'reading')
        result = self.call(files, 'download/chunk', identity, offset=0)
        self.assertEqual(base64.b64decode(result['data']), b'hello')
        with self.assertRaises(Error): self.call(files, 'download/chunk', identity, offset=0)
        self.assertEqual(self.call(files, 'download/finish', identity)['state'], 'verified')

    def test_verification_advances_only_one_bounded_step(self):
        files, api, _ = self.setup_files(b'x'*(CHUNK*2+1))
        identity = self.begin(files)
        for offset in (0, CHUNK, CHUNK*2): self.call(files, 'download/chunk', identity, offset=offset)
        first = self.call(files, 'download/finish', identity)
        self.assertEqual((first['state'], first['verified']), ('verifying', CHUNK))
        events = list(api.events)
        self.assertEqual(self.call(files, 'download/finish', identity), first)
        self.assertEqual(api.events, events)
        self.assertEqual(self.call(files, 'download/verify', identity)['verified'], CHUNK*2)
        self.assertEqual(self.call(files, 'download/verify', identity)['state'], 'verified')
        events = list(api.events)
        self.assertEqual(self.call(files, 'download/verify', identity)['state'], 'verified')
        self.assertEqual(api.events, events)

    def test_metadata_change_and_short_read_fail_and_release_pin(self):
        for failure in ('metadata', 'short'):
            files, api, _ = self.setup_files()
            identity = self.begin(files)
            if failure == 'metadata': api.file.info['changed'] += 1
            else: api.file.data = b'a'
            with self.subTest(failure=failure), self.assertRaises(Error):
                self.call(files, 'download/chunk', identity, offset=0)
            record = files.records[identity]
            self.assertEqual(record.state, 'failed')
            self.assertIsNone(record.pin)
            with self.assertRaises(Error): self.call(files, 'download/begin', identity, path='/other')
            self.assertEqual(self.call(files, 'download/begin', identity, path='/data')['state'], 'failed')

    def test_second_pass_rejects_changed_content_even_with_same_metadata(self):
        files, api, _ = self.setup_files()
        identity = self.begin(files)
        self.call(files, 'download/chunk', identity, offset=0)
        api.file.data = b'other'
        with self.assertRaises(Error): self.call(files, 'download/finish', identity)
        result = self.call(files, 'status', identity)
        self.assertEqual(result['state'], 'failed')
        self.assertNotIn('sha256', result)
        self.assertIsNone(files.records[identity].pin)

    def test_cleanup_must_confirm_before_verified_receipt(self):
        files, api, _ = self.setup_files()
        identity = self.begin(files)
        self.call(files, 'download/chunk', identity, offset=0)
        api.fail_close = files.records[identity].pin.handle
        with self.assertRaises(Error) as caught: self.call(files, 'download/finish', identity)
        self.assertEqual(caught.exception.code, 'file_cleanup_uncertain')
        pending = self.call(files, 'status', identity)
        self.assertEqual(pending['state'], 'cleanupPending')
        self.assertTrue(pending['cleanupPending'])
        self.assertNotIn('sha256', pending)
        reads = [e for e in api.events if e[0] == 'read']
        api.fail_close = None
        self.assertEqual(self.call(files, 'download/verify', identity)['state'], 'verified')
        self.assertEqual([e for e in api.events if e[0] == 'read'], reads)

    def test_abort_failure_is_retained_until_positive_retry(self):
        files, api, _ = self.setup_files()
        identity = self.begin(files)
        api.fail_close = files.records[identity].pin.handle
        with self.assertRaises(Error): self.call(files, 'abort', identity)
        self.assertTrue(self.call(files, 'status', identity)['cleanupPending'])
        api.fail_close = None
        self.assertEqual(self.call(files, 'abort', identity)['state'], 'aborted')
        self.assertEqual(self.call(files, 'abort', identity)['state'], 'aborted')
        self.assertEqual(self.call(files, 'download/begin', identity, path='/data')['state'], 'aborted')

    def test_large_file_begin_and_bounded_read_without_total_size_cap(self):
        files, api, _ = self.setup_files()
        api.file.info['size'] = 64*1024**3
        api.file.data = lambda offset, count: b'x'*count
        identity = self.begin(files)
        self.assertEqual(self.call(files, 'status', identity)['bytes'], 64*1024**3)
        result = self.call(files, 'download/chunk', identity, offset=0)
        self.assertEqual(len(base64.b64decode(result['data'])), CHUNK)

    def test_revocation_during_read_returns_no_data_and_fences_reauthorization(self):
        files, api, active = self.setup_files(cleanup=lambda: True)
        identity = self.begin(files)
        def revoke(offset, count):
            active[0] = False
            return b'x'*count
        api.file.data = revoke
        with self.assertRaises(Error) as caught: self.call(files, 'download/chunk', identity, offset=0)
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(files.records[identity].state, 'failed')
        active[0] = True
        with self.assertRaises(Error): self.call(files, 'status', identity)
        self.assertEqual(self.call(files, 'abort', identity)['state'], 'aborted')

    def test_cleanup_authority_cannot_read_after_revocation(self):
        files, api, active = self.setup_files(cleanup=lambda: True)
        identity = self.begin(files)
        active[0] = False
        before = list(api.events)
        with self.assertRaises(Error): self.call(files, 'download/chunk', identity, offset=0)
        self.assertEqual(api.events, before)
        self.assertEqual(self.call(files, 'abort', identity)['state'], 'aborted')

    def test_busy_transfer_does_not_block_independent_transfer(self):
        files, api, _ = self.setup_files()
        first, second = self.begin(files), self.begin(files)
        api.block_read = True
        errors = []
        def read():
            try: self.call(files, 'download/chunk', first, offset=0)
            except Exception as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            with self.assertRaises(Error) as caught: self.call(files, 'status', first)
            self.assertEqual(caught.exception.code, 'input_busy')
            api.block_read = False
            self.assertEqual(self.call(files, 'download/chunk', second, offset=0)['offset'], 5)
        finally:
            api.release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_restart_unknown_identity_never_reopens_and_upload_is_unsupported(self):
        files, api, _ = self.setup_files()
        identity = self.begin(files)
        fresh = WindowsDownloads(files.root, files.resolve, lambda: True)
        before = list(api.events)
        for route, values in [('status', {}), ('download/chunk', {'offset': 0})]:
            with self.assertRaises(Error) as caught: self.call(fresh, route, identity, **values)
            self.assertEqual(caught.exception.status, 404)
        self.assertEqual(api.events, before)
        with self.assertRaises(Error) as caught: self.call(files, 'upload/begin', identity, path='/data')
        self.assertEqual(caught.exception.code, 'capability_unsupported')

    def test_listing_uses_same_explicit_root_and_returns_guest_path(self):
        files, api, _ = self.setup_files()
        api.list_entries = [{'name': 'data', 'kind': 'file', 'size': 5}]
        listing = GuestChunkFiles(files).list('/')
        self.assertEqual(listing['path'], '/')
        self.assertEqual(listing['entries'][0]['name'], 'data')

    def test_malformed_controls_and_unbound_paths_have_no_native_effect(self):
        files, api, _ = self.setup_files()
        identity = str(uuid.uuid4())
        before = list(api.events)
        for route, body in [('download/begin', {'id': identity, 'path': '/unbound'}),
                            ('download/begin', {'id': [], 'path': '/data'}),
                            ('download/chunk', {'id': identity, 'offset': True}),
                            ('status', {'id': identity, 'extra': True})]:
            with self.subTest(route=route), self.assertRaises(Error): files('/v1/files/'+route, body)
        self.assertEqual(api.events, before)

    def test_check_detects_source_change_before_eof(self):
        files, api, _ = self.setup_files()
        download = GuestChunkFiles(files).download('/data')
        api.file.info['fileId'] = 'replacement'
        with self.assertRaises(Error): download.verify()
        self.assertEqual(next(iter(files.records.values())).state, 'failed')
        download.close()

    def test_owner_close_during_read_refuses_late_data_and_retains_cleanup(self):
        files, api, _ = self.setup_files()
        identity = self.begin(files)
        api.block_read = True
        results, errors = [], []
        def read():
            try: results.append(self.call(files, 'download/chunk', identity, offset=0))
            except Error as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            self.assertFalse(files.close())
            self.assertTrue(api.handles)
        finally:
            api.release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].status, 410)
        self.assertTrue(files.close())
        self.assertEqual(api.handles, {})

    def test_failed_open_retains_unknown_cleanup_until_root_shutdown(self):
        files, api, _ = self.setup_files(cleanup=lambda: True)
        api.file.info['attributes'] = 0x400
        api.fail_close = api.next+1
        identity = str(uuid.uuid4())
        with self.assertRaises(Error) as caught:
            self.call(files, 'download/begin', identity, path='/data')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(self.call(files, 'status', identity)['cleanupPending'])
        with self.assertRaises(Error): self.call(files, 'abort', identity)
        api.fail_close = None
        self.assertTrue(files.close())
        self.assertEqual(self.call(files, 'abort', identity)['state'], 'aborted')


if __name__ == '__main__': unittest.main()
