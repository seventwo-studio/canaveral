"""Windows staging ownership/I/O doubles; no native filesystem acceptance."""
import ctypes as c
import hashlib
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.guest.windows_file_handles import WindowsRoot, H, IO_STATUS_BLOCK, OBJECT_ATTRIBUTES
from canaveral.guest.windows_staging import WindowsStage, Win32Staging
from canaveral.guest_chunk_files import CHUNK
from canaveral.model import Error
from test_windows_file_handles import API, Node


class StagingAPI(API):
    def __init__(self):
        super().__init__()
        self.owned, self.marked = {}, set()
        self.partial = self.fail_flush = self.fail_discard = False
        self.block_write = self.block_create = False
        self.write_result = None

    def create(self, parent, name):
        self.events.append(('create', parent, name))
        if self.block_create:
            self.entered.set()
            self.release.wait(3)
        directory = self.handles[parent]
        if name in directory.children: raise OSError('already exists')
        node = Node(self.next+1000, data=b'')
        directory.children[name] = node
        directory.info['changed'] += 1
        handle = self.handle(node)
        self.owned[handle] = directory, name, node
        return handle

    def write(self, handle, offset, data):
        self.events.append(('write', handle, offset, len(data)))
        if self.block_write:
            self.entered.set()
            self.release.wait(3)
        if self.write_result is not None: return self.write_result
        count = min(len(data), 8192) if self.partial else len(data)
        node = self.handles[handle]
        node.data = node.data[:offset]+data[:count]+node.data[offset+count:]
        node.info['size'] = len(node.data)
        node.info['changed'] += 1
        return count

    def flush(self, handle):
        self.events.append(('flush', handle))
        if self.fail_flush: raise OSError('private flush failure')

    def discard(self, handle):
        self.events.append(('discard', handle))
        if self.fail_discard: raise OSError('private disposition failure')
        self.marked.add(handle)

    def close(self, handle):
        super().close(handle)
        if handle in self.marked:
            directory, name, node = self.owned[handle]
            if directory.children.get(name) is node: del directory.children[name]


class WindowsStagingTests(unittest.TestCase):
    def root(self):
        api = StagingAPI()
        root = WindowsRoot('C:', ('home',), api=api)
        root.start()
        active = [True]
        def cleanup():
            api.release.set()
            api.fail_close = None
            api.fail_discard = False
            root.close()
        self.addCleanup(cleanup)
        return root, api, active

    def stage(self, root, active, size):
        return WindowsStage.create(root, (), size, lambda: active[0])

    def test_binary_multichunk_staging_is_verified_but_not_durable_or_published(self):
        root, api, active = self.root()
        data = bytes(range(256))*(CHUNK//256+1)
        stage = self.stage(root, active, len(data))
        for offset in range(0, len(data), CHUNK):
            self.assertEqual(stage.write(offset, data[offset:offset+CHUNK]), {'offset': min(offset+CHUNK, len(data))})
        result = stage.finish(hashlib.sha256(data).hexdigest())
        self.assertEqual(result['state'], 'verifying')
        self.assertEqual(result['verified'], CHUNK)
        result = stage.verify()
        self.assertEqual(result['state'], 'ready')
        self.assertFalse(result['durable'])
        self.assertEqual(result['sha256'], hashlib.sha256(data).hexdigest())
        before = list(api.events)
        self.assertEqual(stage.verify(), result)
        self.assertEqual(api.events, before)
        self.assertEqual(api.file.data, b'hello')
        self.assertEqual(api.home.children[stage.name].data, data)
        self.assertTrue(stage.close())
        self.assertNotIn(stage.name, api.home.children)
        self.assertEqual(api.home.children['data'].data, b'hello')

    def test_empty_stage_flushes_and_verifies_without_native_read(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 0)
        result = stage.finish(hashlib.sha256(b'').hexdigest())
        self.assertEqual(result['state'], 'ready')
        self.assertTrue(any(e[0] == 'flush' for e in api.events))
        self.assertFalse(any(e[0] == 'read' for e in api.events))

    def test_partial_native_writes_continue_only_confirmed_progress(self):
        root, api, active = self.root()
        api.partial = True
        data = b'x'*30000
        stage = self.stage(root, active, len(data))
        self.assertEqual(stage.write(0, data), {'offset': len(data)})
        self.assertEqual(stage.finish(hashlib.sha256(data).hexdigest())['state'], 'ready')
        writes = [e for e in api.events if e[0] == 'write']
        self.assertEqual([e[2] for e in writes], [0, 8192, 16384, 24576])

    def test_bad_write_counts_fence_without_replay_and_keep_owned_cleanup(self):
        for count in (0, -1, True, 10):
            root, api, active = self.root()
            stage = self.stage(root, active, 5)
            api.write_result = count
            with self.subTest(count=count), self.assertRaises(Error) as caught: stage.write(0, b'hello')
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertTrue(stage.fenced)
            self.assertIn(stage, root.pins)
            with self.assertRaises(Error): stage.write(0, b'hello')
            self.assertEqual(len([e for e in api.events if e[0] == 'write']), 1)
            self.assertTrue(stage.close())

    def test_invalid_cursor_phase_and_hash_refuse_before_native_io(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        before = list(api.events)
        for offset, data in ((1, b'h'), (False, b'h'), (0, b''), (0, b'x'*(CHUNK+1)), (0, b'toolong')):
            with self.assertRaises(Error): stage.write(offset, data)
        with self.assertRaises(Error): stage.finish(hashlib.sha256(b'hello').hexdigest())
        self.assertEqual(api.events, before)
        stage.write(0, b'hello')
        before = list(api.events)
        with self.assertRaises(Error): stage.finish('0'*64)
        self.assertEqual(api.events, before)
        self.assertEqual(stage.finish(hashlib.sha256(b'hello').hexdigest())['state'], 'ready')
        with self.assertRaises(Error): stage.write(0, b'hello')

    def test_digest_detects_same_metadata_content_mutation(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        stage.write(0, b'hello')
        api.handles[stage.handle].data = b'other'
        with self.assertRaises(Error): stage.finish(hashlib.sha256(b'hello').hexdigest())
        self.assertEqual(stage.state, 'failed')
        self.assertTrue(stage.close())

    def test_metadata_or_parent_identity_change_refuses_acknowledgement(self):
        for target in ('stage', 'parent'):
            root, api, active = self.root()
            stage = self.stage(root, active, 5)
            node = api.handles[stage.handle] if target == 'stage' else api.home
            node.info['fileId'] = 'replacement'
            before = len([e for e in api.events if e[0] == 'write'])
            with self.subTest(target=target), self.assertRaises(Error): stage.write(0, b'hello')
            self.assertEqual(len([e for e in api.events if e[0] == 'write']), before)
            self.assertTrue(stage.close())

    def test_flush_failure_never_reports_ready(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        stage.write(0, b'hello')
        api.fail_flush = True
        with self.assertRaises(Error) as caught: stage.finish(hashlib.sha256(b'hello').hexdigest())
        self.assertNotIn('private', str(caught.exception))
        self.assertEqual(stage.state, 'failed')
        self.assertEqual(stage.verified, 0)

    def test_revocation_during_write_withholds_cursor_and_cannot_revive(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        write = api.write
        def revoke(*args):
            count = write(*args)
            active[0] = False
            return count
        api.write = revoke
        with self.assertRaises(Error) as caught: stage.write(0, b'hello')
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(caught.exception.outcome, 'unknown')
        active[0] = True
        with self.assertRaises(Error): stage.write(0, b'hello')
        self.assertTrue(stage.close())

    def test_pending_discard_and_close_remain_registered_for_retry(self):
        for failure in ('discard', 'close'):
            root, api, active = self.root()
            stage = self.stage(root, active, 5)
            api.fail_discard = failure == 'discard'
            api.fail_close = stage.handle if failure == 'close' else None
            self.assertFalse(stage.close())
            self.assertIn(stage, root.pins)
            self.assertIn(stage.name, api.home.children)
            self.assertFalse(root.close())
            api.fail_discard, api.fail_close = False, None
            self.assertTrue(root.close())
            self.assertEqual(api.handles, {})
            self.assertNotIn(stage.name, api.home.children)
            if failure == 'close':
                self.assertEqual(len([e for e in api.events if e[0] == 'discard']), 1)

    def test_root_close_during_write_retains_chain_and_refuses_late_cursor(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        api.block_write = True
        errors = []
        def write():
            try: stage.write(0, b'hello')
            except Error as error: errors.append(error)
        thread = threading.Thread(target=write)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            before = set(api.handles)
            self.assertFalse(root.close())
            self.assertEqual(set(api.handles), before)
        finally:
            api.release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].status, 410)
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_root_close_during_create_retains_late_handle_for_discard(self):
        root, api, active = self.root()
        api.block_create = True
        errors = []
        def create():
            try: self.stage(root, active, 5)
            except Error as error: errors.append(error)
        thread = threading.Thread(target=create)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            self.assertFalse(root.close())
        finally:
            api.release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})
        self.assertEqual(list(api.home.children), ['data'])

    def test_declared_large_files_do_not_preallocate_or_add_total_size_cap(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 64*1024**3)
        self.assertEqual(stage.size, 64*1024**3)
        self.assertEqual(api.handles[stage.handle].info['size'], 0)
        stage.write(0, b'x'*CHUNK)
        self.assertEqual(api.handles[stage.handle].info['size'], CHUNK)

    def test_unsafe_parent_and_invalid_lengths_never_create_stage(self):
        root, api, active = self.root()
        before = list(api.events)
        for parts, size in [(('..',), 5), (('a/b',), 5), ((), True), ((), -1), ((), 2**53)]:
            with self.assertRaises(Error): WindowsStage.create(root, parts, size, lambda: True)
        self.assertEqual(api.events, before)

    def test_nested_parent_is_pinned_and_cross_volume_is_rejected(self):
        root, api, active = self.root()
        directory = Node(90, True)
        api.home.children['nested'] = directory
        stage = WindowsStage.create(root, ('nested',), 0, lambda: active[0])
        self.assertIn(stage.name, directory.children)
        self.assertTrue(stage.close())
        directory.info['volume'] = 100
        with self.assertRaises(Error): WindowsStage.create(root, ('nested',), 0, lambda: True)
        self.assertEqual(directory.children, {})

    def test_native_create_requests_exclusive_relative_fresh_file_and_no_allocation(self):
        native = object.__new__(Win32Staging)
        observed = {}
        def create(out, access, attrs, status, allocation, attributes, sharing, disposition, options, ea, size):
            value = c.cast(attrs, c.POINTER(OBJECT_ATTRIBUTES)).contents
            string = value.ObjectName.contents
            observed.update(access=access, parent=value.RootDirectory,
                name=c.string_at(string.Buffer, string.Length).decode('utf-16-le'),
                allocation=allocation, sharing=sharing, disposition=disposition, options=options)
            c.cast(out, c.POINTER(H))[0] = H(123)
            return 0
        native.nt = SimpleNamespace(NtCreateFile=create)
        self.assertEqual(native.create(9, '.canaveral-upload-test'), 123)
        self.assertEqual(observed, {'access': 0xC0110000, 'parent': 9,
            'name': '.canaveral-upload-test', 'allocation': None, 'sharing': 0,
            'disposition': 2, 'options': 0x200062})

    def test_native_discard_sets_only_handle_disposition(self):
        native = object.__new__(Win32Staging)
        observed = []
        def discard(handle, status, data, size, kind):
            observed.append((handle, c.cast(data, c.POINTER(c.c_ubyte))[0], size, kind))
            return 0
        native.nt = SimpleNamespace(NtSetInformationFile=discard)
        native.discard(123)
        self.assertEqual(observed, [(123, 1, 1, 13)])

    def test_temporary_name_collision_never_adopts_or_deletes_existing_object(self):
        root, api, active = self.root()
        with patch('canaveral.guest.windows_staging.uuid.uuid4', return_value=SimpleNamespace(hex='same')):
            first = self.stage(root, active, 5)
            with self.assertRaises(Error): self.stage(root, active, 5)
        self.assertIn(first.name, api.home.children)
        self.assertIn(first, root.pins)
        self.assertEqual(len(root.pins), 1)
        first.write(0, b'hello')
        self.assertTrue(first.close())

    def test_failed_initial_metadata_retains_created_object_until_discard_confirmed(self):
        root, api, active = self.root()
        create = api.create
        def wrong_links(*args):
            handle = create(*args)
            api.handles[handle].info['links'] = 2
            return handle
        api.create, api.fail_discard = wrong_links, True
        with self.assertRaises(Error) as caught: self.stage(root, active, 5)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(len(root.pins), 1)
        self.assertFalse(root.close())
        api.fail_discard = False
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_short_verification_read_and_busy_lane_refuse_success(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        stage.io.acquire()
        try:
            with self.assertRaises(Error) as caught: stage.write(0, b'hello')
            self.assertEqual(caught.exception.code, 'input_busy')
            self.assertEqual(stage.state, 'receiving')
        finally: stage.io.release()
        stage.write(0, b'hello')
        api.handles[stage.handle].data = b'no'
        with self.assertRaises(Error): stage.finish(hashlib.sha256(b'hello').hexdigest())
        self.assertEqual(stage.state, 'failed')

    def test_pre_dispatch_revocation_has_no_write_or_unknown_effect(self):
        root, api, active = self.root()
        stage = self.stage(root, active, 5)
        active[0] = False
        with self.assertRaises(Error) as caught: stage.write(0, b'hello')
        self.assertEqual(caught.exception.status, 410)
        self.assertIsNone(caught.exception.outcome)
        self.assertFalse(any(e[0] == 'write' for e in api.events))
        self.assertTrue(stage.close())


if __name__ == '__main__': unittest.main()
