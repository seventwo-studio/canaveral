"""Handle publication and uncertainty doubles, not Windows rename/durability proof."""
import ctypes as c
import hashlib
import threading
import unittest
from types import SimpleNamespace

from canaveral.guest.windows_file_handles import WindowsRoot
from canaveral.guest.windows_staging import WindowsStage, Win32Staging, FILE_RENAME_INFORMATION
from canaveral.model import Error
from test_windows_staging import StagingAPI


class PublicationAPI(StagingAPI):
    def __init__(self):
        super().__init__()
        self.failure = None
        self.block_publish = False
        self.after_publish = lambda: None

    def publish(self, handle, name):
        self.events.append(('publish', handle, name))
        if self.block_publish:
            self.entered.set()
            self.release.wait(3)
        if self.failure == 'before': raise OSError('private rename refusal')
        parent, old, node = self.owned[handle]
        del parent.children[old]
        parent.children[name] = node
        self.owned[handle] = parent, name, node
        node.info['changed'] += 1
        parent.info['changed'] += 1
        self.after_publish()
        if self.failure == 'after': raise OSError('private lost rename result')
        return False if self.failure == 'false' else True


class WindowsPublicationTests(unittest.TestCase):
    def stage(self, data=b'new data', ready=True):
        api = PublicationAPI()
        root = WindowsRoot('C:', ('home',), api=api)
        root.start()
        active = [True]
        stage = WindowsStage.create(root, (), len(data), lambda: active[0])
        if data: stage.write(0, data)
        if ready:
            result = stage.finish(hashlib.sha256(data).hexdigest())
            while result['state'] == 'verifying': result = stage.verify()
        # Unknown publication deliberately remains tracked in these in-memory
        # doubles. Root.close must not manufacture reconciliation for teardown.
        self.addCleanup(root.close)
        return stage, root, api, active

    def test_replace_uses_retained_handle_and_cleanup_preserves_destination(self):
        stage, root, api, _ = self.stage()
        self.assertEqual(api.home.children['data'].data, b'hello')
        handle, before = stage.handle, list(api.events)
        result = stage.publish('data')
        self.assertEqual(result, {'state': 'published', 'destination': 'data', 'bytes': 8,
            'sha256': hashlib.sha256(b'new data').hexdigest(), 'durable': False})
        self.assertEqual(api.home.children['data'].data, b'new data')
        self.assertNotIn(stage.name, api.home.children)
        self.assertEqual([e for e in api.events[len(before):] if e[0] in ('open', 'create', 'publish')],
                         [('publish', handle, 'data')])
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')
        self.assertFalse(any(e[0] == 'discard' for e in api.events))
        self.assertEqual(stage.state, 'published')

    def test_new_unicode_destination_and_empty_file_are_preserved(self):
        stage, root, api, _ = self.stage(b'')
        result = stage.publish('héllo-🚀.bin')
        self.assertFalse(result['durable'])
        self.assertEqual(api.home.children['héllo-🚀.bin'].data, b'')
        self.assertTrue(root.close())
        self.assertIn('héllo-🚀.bin', api.home.children)
        self.assertEqual(api.home.children['data'].data, b'hello')

    def test_repeated_same_or_different_publication_refuses_without_changing_receipt(self):
        stage, _, api, _ = self.stage()
        stage.publish('data')
        before = list(api.events)
        for name in ('data', 'other'):
            with self.assertRaises(Error) as caught: stage.publish(name)
            self.assertIsNone(caught.exception.outcome)
            self.assertEqual(stage.state, 'published')
            self.assertEqual(stage.destination, 'data')
        self.assertEqual(api.events, before)

    def test_unverified_or_unsafe_destination_has_no_native_effect(self):
        stage, _, api, _ = self.stage(ready=False)
        before = list(api.events)
        with self.assertRaises(Error): stage.publish('data')
        for name in ('..', '.', 'a/b', 'C:stream', '\\server', stage.name, stage.name.upper()):
            with self.subTest(name=name), self.assertRaises(Error): stage.publish(name)
        self.assertFalse(stage.publication_attempted)
        self.assertEqual(api.events, before)
        self.assertEqual(api.home.children['data'].data, b'hello')

    def test_exception_before_or_after_native_rename_retains_unknown_ownership(self):
        for failure in ('before', 'after', 'false'):
            stage, root, api, _ = self.stage()
            api.failure = failure
            with self.subTest(failure=failure), self.assertRaises(Error) as caught: stage.publish('data')
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertFalse(caught.exception.retryable)
            self.assertNotIn('private', str(caught.exception))
            self.assertEqual(stage.state, 'publicationUnknown')
            self.assertFalse(stage.publication_known)
            self.assertFalse(stage.close())
            self.assertFalse(root.close())
            self.assertIn(stage, root.pins)
            self.assertIn(stage.handle, api.handles)
            self.assertFalse(any(e[0] == 'discard' for e in api.events))
            before = list(api.events)
            with self.assertRaises(Error): stage.publish('other')
            self.assertEqual(api.events, before)
            self.assertEqual(api.home.children['data'].data, b'hello' if failure == 'before' else b'new data')

    def test_flush_after_observed_rename_cannot_claim_durability_or_delete_target(self):
        stage, root, api, _ = self.stage()
        api.fail_flush = True
        with self.assertRaises(Error) as caught: stage.publish('data')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(stage.publication_known)
        self.assertEqual(stage.state, 'publicationUnknown')
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')
        self.assertFalse(any(e[0] == 'discard' for e in api.events))

    def test_pre_dispatch_revocation_does_not_rename(self):
        stage, _, api, active = self.stage()
        active[0] = False
        with self.assertRaises(Error) as caught: stage.publish('data')
        self.assertEqual(caught.exception.status, 410)
        self.assertIsNone(caught.exception.outcome)
        self.assertFalse(stage.publication_attempted)
        self.assertFalse(any(e[0] == 'publish' for e in api.events))
        self.assertTrue(stage.close())
        self.assertEqual(api.home.children['data'].data, b'hello')

    def test_revocation_after_rename_withholds_receipt_and_preserves_target(self):
        stage, root, api, active = self.stage()
        api.after_publish = lambda: active.__setitem__(0, False)
        with self.assertRaises(Error) as caught: stage.publish('data')
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(stage.state, 'publicationUnknown')
        self.assertTrue(stage.publication_known)
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')

    def test_close_during_rename_retains_handles_and_never_discards_target(self):
        stage, root, api, _ = self.stage()
        api.block_publish = True
        errors = []
        def publish():
            try: stage.publish('data')
            except Error as error: errors.append(error)
        thread = threading.Thread(target=publish)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            handles = set(api.handles)
            self.assertFalse(root.close())
            self.assertEqual(set(api.handles), handles)
            with self.assertRaises(Error) as caught: stage.publish('data')
            self.assertEqual(caught.exception.code, 'input_busy')
        finally:
            api.release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].outcome, 'unknown')
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')
        self.assertFalse(any(e[0] == 'discard' for e in api.events))

    def test_failed_handle_release_never_turns_into_destination_deletion(self):
        stage, root, api, _ = self.stage()
        stage.publish('data')
        api.fail_close = stage.handle
        try:
            self.assertFalse(stage.close())
            self.assertIn(stage, root.pins)
            self.assertFalse(any(e[0] == 'discard' for e in api.events))
        finally: api.fail_close = None
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')

    def test_parent_or_stage_change_refuses_before_publication(self):
        for node_name in ('parent', 'stage'):
            stage, _, api, _ = self.stage()
            node = api.home if node_name == 'parent' else api.handles[stage.handle]
            node.info['fileId'] = 'different'
            with self.subTest(node=node_name), self.assertRaises(Error): stage.publish('data')
            self.assertFalse(stage.publication_attempted)
            self.assertFalse(any(e[0] == 'publish' for e in api.events))
            self.assertEqual(api.home.children['data'].data, b'hello')

    def test_native_rename_buffer_has_counted_utf16_and_no_source_or_absolute_path(self):
        native = object.__new__(Win32Staging)
        observed = []
        def rename(handle, status, data, length, kind):
            info = c.cast(data, c.POINTER(FILE_RENAME_INFORMATION)).contents
            raw = c.string_at(c.addressof(data)+FILE_RENAME_INFORMATION.FileName.offset, info.FileNameLength)
            observed.append((handle, info.ReplaceIfExists, info.RootDirectory, raw.decode('utf-16-le'), length, kind))
            return 0
        native.nt = SimpleNamespace(NtSetInformationFile=rename)
        self.assertEqual(FILE_RENAME_INFORMATION.RootDirectory.offset, 8)
        self.assertEqual(FILE_RENAME_INFORMATION.FileNameLength.offset, 16)
        self.assertEqual(FILE_RENAME_INFORMATION.FileName.offset, 20)
        self.assertTrue(native.publish(123, 'héllo-🚀.bin'))
        self.assertEqual(observed, [(123, 1, None, 'héllo-🚀.bin', 44, 10)])

    def test_native_error_and_invalid_name_never_use_a_fallback(self):
        native = object.__new__(Win32Staging)
        calls = []
        def reject(*args):
            calls.append(args)
            return -1
        native.nt = SimpleNamespace(NtSetInformationFile=reject)
        with self.assertRaises(OSError): native.publish(123, 'data')
        for name in ('..', 'a/b', 'C:drive', 'a\\b'):
            with self.assertRaises(Error): native.publish(123, name)
        self.assertEqual(len(calls), 1)

    def test_post_rename_identity_refusal_never_disposes_destination(self):
        stage, root, api, _ = self.stage()
        api.after_publish = lambda: api.handles[stage.handle].info.__setitem__('fileId', 'changed')
        with self.assertRaises(Error) as caught: stage.publish('data')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(stage.publication_known)
        self.assertTrue(root.close())
        self.assertEqual(api.home.children['data'].data, b'new data')
        self.assertFalse(any(e[0] == 'discard' for e in api.events))

    def test_native_validation_failure_is_redacted_before_dispatch(self):
        stage, _, api, _ = self.stage()
        info = api.info
        def fail(handle): raise OSError('private path and account')
        api.info = fail
        try:
            with self.assertRaises(Error) as caught: stage.publish('data')
            self.assertNotIn('private', str(caught.exception))
            self.assertIsNone(caught.exception.outcome)
            self.assertFalse(stage.publication_attempted)
        finally: api.info = info
        self.assertTrue(stage.close())
        self.assertEqual(api.home.children['data'].data, b'hello')


if __name__ == '__main__': unittest.main()
