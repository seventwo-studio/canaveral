import base64
import hashlib
import io
import unittest

from canaveral.guest_chunk_files import CHUNK, GuestChunkFiles
from canaveral.model import Error


class Helper:
    def __init__(self, data=b''):
        self.data, self.stage, self.calls = data, bytearray(), []
        self.offset = self.verified = 0
        self.transform = lambda route, result: result
        self.fail = None

    def __call__(self, route, body):
        route = route.removeprefix('/v1/files/')
        self.calls.append((route, dict(body)))
        if route == self.fail: raise Error('Interrupted fixture', 409)
        identity = {'id': body.get('id')}
        if route == 'upload/begin':
            self.size = body['size']; result = {**identity, 'state': 'receiving', 'bytes': self.size}
        elif route == 'upload/chunk':
            assert body['offset'] == len(self.stage)
            self.stage.extend(base64.b64decode(body['data']))
            result = {**identity, 'offset': len(self.stage)}
        elif route in ('upload/finish', 'upload/verify'):
            if route.endswith('/finish'):
                assert body['bytes'] == len(self.stage)
                assert body['sha256'] == hashlib.sha256(self.stage).hexdigest()
            self.verified += min(CHUNK, self.size-self.verified)
            if self.verified < self.size:
                result = {**identity, 'state': 'verifyingUpload', 'verified': self.verified}
            else:
                self.data = bytes(self.stage)
                result = {**identity, 'state': 'committed', 'bytes': self.size,
                          'sha256': hashlib.sha256(self.data).hexdigest(), 'durable': True}
        elif route == 'download/begin': result = {**identity, 'state': 'reading', 'bytes': len(self.data)}
        elif route == 'download/check': result = {**identity, 'state': 'reading', 'bytes': len(self.data)}
        elif route == 'download/chunk':
            assert body['offset'] == self.offset
            part = self.data[self.offset:self.offset+CHUNK]; self.offset += len(part)
            result = {**identity, 'offset': self.offset, 'data': base64.b64encode(part).decode()}
        elif route in ('download/finish', 'download/verify'):
            self.verified += min(CHUNK, len(self.data)-self.verified)
            if self.verified < len(self.data): result = {**identity, 'state': 'verifying', 'verified': self.verified}
            else: result = {**identity, 'state': 'verified', 'bytes': len(self.data), 'sha256': hashlib.sha256(self.data).hexdigest()}
        elif route == 'abort': result = {**identity, 'state': 'aborted', 'bytes': 0}
        elif route == 'list': result = {'path': '/', 'entries': [], 'truncated': False}
        else: raise AssertionError(route)
        return self.transform(route, result)


class GuestChunkFilesTests(unittest.TestCase):
    def test_binary_upload_multiple_bounded_chunks_and_verification(self):
        helper = Helper(); data = bytes(range(256))*(CHUNK//256+1)
        result = GuestChunkFiles(helper).upload('/path ; literal', io.BytesIO(data), len(data))
        self.assertEqual(result, {'uploaded': len(data), 'durable': True}); self.assertEqual(helper.data, data)
        self.assertEqual([r for r, _ in helper.calls], ['upload/begin', 'upload/chunk', 'upload/chunk', 'upload/finish', 'upload/verify'])
        self.assertTrue(all(len(base64.b64decode(b['data'])) <= CHUNK for r, b in helper.calls if r == 'upload/chunk'))
        self.assertEqual(helper.calls[0][1]['path'], '/path ; literal')

    def test_empty_upload_and_download(self):
        helper = Helper(); adapter = GuestChunkFiles(helper)
        self.assertEqual(adapter.upload('/empty', io.BytesIO(), 0), {'uploaded': 0, 'durable': True})
        source = adapter.download('/empty'); source.verify(); self.assertEqual(source.read(4096), b''); source.close()
        self.assertIn('download/finish', [r for r, _ in helper.calls])

    def test_declared_large_size_is_accepted_without_preallocation(self):
        helper = Helper()
        with self.assertRaisesRegex(Error, 'source ended early'):
            GuestChunkFiles(helper).upload('/large', io.BytesIO(b''), 1 << 40)
        self.assertEqual(helper.calls[0][1]['size'], 1 << 40)
        self.assertEqual([r for r, _ in helper.calls], ['upload/begin', 'abort'])

    def test_invalid_protocol_lengths_do_not_dispatch(self):
        for size in (True, -1, 1.5, 1 << 53):
            helper = Helper()
            with self.assertRaises(Error): GuestChunkFiles(helper).upload('/bad', io.BytesIO(), size)
            self.assertFalse(helper.calls)

    def test_lost_write_response_is_not_replayed(self):
        helper = Helper(); helper.fail = 'upload/chunk'
        with self.assertRaisesRegex(Error, 'Interrupted'): GuestChunkFiles(helper).upload('/target', io.BytesIO(b'x'), 1)
        self.assertEqual([r for r, _ in helper.calls], ['upload/begin', 'upload/chunk', 'abort'])

    def test_lost_publication_response_is_not_replayed(self):
        helper = Helper(); helper.fail = 'upload/finish'
        with self.assertRaisesRegex(Error, 'Interrupted'): GuestChunkFiles(helper).upload('/target', io.BytesIO(b'x'), 1)
        self.assertEqual([r for r, _ in helper.calls], ['upload/begin', 'upload/chunk', 'upload/finish', 'abort'])

    def test_upload_rejects_wrong_cursor_identity_digest_and_durability(self):
        for mode in ('offset', 'id', 'sha256', 'durable', 'bytes', 'verify'):
            helper = Helper()
            def transform(route, result):
                result = dict(result)
                if mode == 'offset' and route == 'upload/chunk': result['offset'] = 0
                if mode == 'id': result['id'] = 'wrong'
                if mode == 'sha256' and route == 'upload/verify': result['sha256'] = '0'*64
                if mode == 'durable' and route == 'upload/verify': result['durable'] = False
                if mode == 'bytes' and route == 'upload/verify': result['bytes'] = 1
                if mode == 'verify' and route == 'upload/finish': result['verified'] = 0
                return result
            helper.transform = transform; data = b'x'*(CHUNK+1)
            with self.subTest(mode=mode), self.assertRaises(Error): GuestChunkFiles(helper).upload('/target', io.BytesIO(data), len(data))

    def test_revocation_during_reader_or_after_publication_stops_calls(self):
        for mode in ('reader', 'publish'):
            helper = Helper(); allowed = [True]
            class Source:
                def read(self, size):
                    if mode == 'reader': allowed[0] = False
                    return b'x'
            def transform(route, result):
                if mode == 'publish' and route == 'upload/finish': allowed[0] = False
                return result
            helper.transform = transform
            with self.assertRaisesRegex(Error, 'authorization ended'):
                GuestChunkFiles(helper).upload('/target', Source(), 1, lambda: allowed[0])
            self.assertNotIn('abort', [r for r, _ in helper.calls])
            if mode == 'reader': self.assertEqual([r for r, _ in helper.calls], ['upload/begin'])

    def test_binary_download_small_consumer_reads_and_verified_finish(self):
        data = bytes(range(256))*(CHUNK//256+1); helper = Helper(data); source = GuestChunkFiles(helper).download('/source')
        try:
            source.verify(); received = bytearray()
            while True:
                part = source.read(777)
                if not part: break
                received.extend(part)
            source.verify(); source.verify(); self.assertEqual(received, data)
        finally: source.close()
        self.assertEqual([r for r, _ in helper.calls], ['download/begin', 'download/check', 'download/chunk', 'download/chunk', 'download/finish', 'download/verify'])

    def test_download_changed_source_fails_before_first_read(self):
        helper = Helper(b'bytes'); helper.fail = 'download/check'; source = GuestChunkFiles(helper).download('/source')
        try:
            with self.assertRaises(Error): source.verify()
        finally: source.close()
        self.assertNotIn('download/chunk', [r for r, _ in helper.calls]); self.assertEqual(helper.calls[-1][0], 'abort')

    def test_download_rejects_wrong_length_cursor_encoding_digest_or_verification_progress(self):
        for mode in ('length', 'cursor', 'encoding', 'digest', 'progress', 'identity'):
            helper = Helper(b'x'*(CHUNK+1))
            def transform(route, result):
                result = dict(result)
                if route == 'download/chunk':
                    if mode == 'length': result['data'] = 'eA=='
                    if mode == 'cursor': result['offset'] = 0
                    if mode == 'encoding': result['data'] = '!!!!'
                    if mode == 'identity': result['id'] = None
                if mode == 'digest' and route == 'download/verify': result['sha256'] = '0'*64
                if mode == 'progress' and route == 'download/finish': result['verified'] = 0
                return result
            helper.transform = transform; source = GuestChunkFiles(helper).download('/source')
            try:
                with self.subTest(mode=mode), self.assertRaises(Error):
                    while source.read(CHUNK): pass
                    source.verify()
            finally: source.close()

    def test_close_is_idempotent_and_never_reads_after_revocation(self):
        helper = Helper(b'bytes'); allowed = [True]
        source = GuestChunkFiles(helper).download('/source', lambda: allowed[0]); allowed[0] = False
        with self.assertRaises(Error): source.read(1)
        with self.assertRaises(Error): source.verify()
        source.close(); source.close()
        self.assertEqual([r for r, _ in helper.calls], ['download/begin'])

    def test_download_rejects_unbounded_reads(self):
        helper = Helper(b'x'); source = GuestChunkFiles(helper).download('/source')
        try:
            for size in (-1, True, None):
                with self.assertRaises(Error): source.read(size)
        finally: source.close()

    def test_bad_begin_response_is_aborted(self):
        helper = Helper(b'x'); helper.transform = lambda route, result: {**result, 'bytes': True} if route == 'download/begin' else result
        with self.assertRaises(Error): GuestChunkFiles(helper).download('/source')
        self.assertEqual([r for r, _ in helper.calls], ['download/begin', 'abort'])


if __name__ == '__main__': unittest.main()
