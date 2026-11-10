"""Journal/native ownership doubles and private temp files, not Windows proof."""
import copy
import ctypes as c
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from types import SimpleNamespace

from canaveral.guest.windows_input_journal import (WindowsInputJournal, Win32Journal, SLOT, FILE_BYTES, _packed)
from canaveral.guest.windows_file_handles import WindowsRoot, H, OBJECT_ATTRIBUTES
from canaveral.guest.windows_held_input import WindowsHeldInput, _neutral
from canaveral.model import Error
from test_windows_staging import StagingAPI
from test_windows_held_input import Backend


def held(blocked=True):
    return {'version': 1, 'blocked': blocked, 'keys': [{'keysym': 65, 'codes': [[65, 0, 0]]}],
            'buttons': 0, 'transient': []}


class API(StagingAPI):
    def __init__(self):
        super().__init__()
        self.file.data, self.file.info['size'] = b'\0'*FILE_BYTES, FILE_BYTES
        self.remaining = None
        self.after_write = lambda: None
        self.corrupt_read = False

    def journal(self, parent, name):
        self.events.append(('journal', parent, name))
        node = self.handles[parent].children[name]
        if node in self.handles.values(): raise OSError('exclusive journal already open')
        return self.handle(node)

    def write(self, handle, offset, data):
        if self.remaining is not None:
            if not self.remaining: raise OSError('private interrupted journal write')
            data = data[:self.remaining]
        count = super().write(handle, offset, data)
        if self.remaining is not None: self.remaining -= count
        self.after_write()
        return count

    def read(self, handle, offset, count):
        result = super().read(handle, offset, count)
        return result[:-1]+bytes([result[-1]^1]) if self.corrupt_read and result else result


class DiskAPI(API):
    """Real POSIX file bytes/fsync behind the native-shaped root/handle seam."""
    def __init__(self, path):
        super().__init__()
        self.path, self.fds, self.flushes = path, {}, 0
        self.file.info['fileId'] = str(path.stat().st_ino)

    def journal(self, parent, name):
        handle = super().journal(parent, name)
        self.fds[handle] = os.open(self.path, os.O_RDWR | os.O_NOFOLLOW)
        return handle

    def info(self, handle):
        result = super().info(handle)
        if handle in self.fds:
            stat = os.fstat(self.fds[handle])
            result.update(size=stat.st_size, fileId=str(stat.st_ino), written=stat.st_mtime_ns,
                          changed=stat.st_ctime_ns, links=stat.st_nlink)
        return result

    def read(self, handle, offset, count):
        self.events.append(('read', handle, offset, count))
        os.lseek(self.fds[handle], offset, os.SEEK_SET)
        return os.read(self.fds[handle], count)

    def write(self, handle, offset, data):
        self.events.append(('write', handle, offset, len(data)))
        os.lseek(self.fds[handle], offset, os.SEEK_SET)
        return os.write(self.fds[handle], data)

    def flush(self, handle):
        os.fsync(self.fds[handle])
        self.flushes += 1

    def close(self, handle):
        if self.fail_close == handle: raise OSError('private close failure')
        if handle in self.fds: os.close(self.fds.pop(handle))
        super().close(handle)


class WindowsInputJournalTests(unittest.TestCase):
    def setup_journal(self, api=None):
        api = API() if api is None else api
        root = WindowsRoot('C:', ('home',), api=api)
        root.start()
        active = [True]
        context = str(uuid.uuid4())
        expected = {'volume': 99, 'fileId': api.file.info['fileId']}
        def cleanup():
            api.release.set()
            api.fail_close = None
            root.close()
        self.addCleanup(cleanup)
        def open_journal(initialize=False, **kwargs):
            return WindowsInputJournal.open(root, ('data',), kwargs.get('context', context),
                kwargs.get('expected', expected), lambda: active[0], initialize=initialize)
        return open_journal, api, root, active, context

    def test_controller_flushes_pending_and_final_state_then_recovers_only_releases(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        control = WindowsHeldInput(Backend(), lambda *args: [[65, 0, 0]], journal, lambda: True,
                                   recovered=journal.recovered)
        control.reset()
        control.key(65, True, (0, 0, 10, 10))
        self.assertEqual(journal.sequence, 5)
        self.assertEqual(journal.recovered, held(False))
        self.assertTrue(journal.close())
        recovered = open_journal()
        backend = Backend()
        control = WindowsHeldInput(backend, lambda *args: [[66, 0, 0]], recovered, lambda: True,
                                   recovered=recovered.recovered)
        with self.assertRaises(Error): control.key(66, True, (0, 0, 10, 10))
        control.reset()
        self.assertEqual([(event.key.vk, event.key.flags) for event in backend.batches[0][0]], [(65, 2)])
        self.assertEqual(recovered.recovered, _neutral())
        self.assertEqual(len(api.file.data), FILE_BYTES)
        self.assertFalse(any(event[0] in ('create', 'discard', 'publish') for event in api.events))

    def test_missing_record_never_formats_without_explicit_initialization(self):
        open_journal, api, _, _, _ = self.setup_journal()
        with self.assertRaises(Error): open_journal()
        self.assertEqual(api.file.data, b'\0'*FILE_BYTES)
        self.assertFalse(any(event[0] == 'write' for event in api.events))
        self.assertEqual(open_journal(True).recovered, _neutral())

    def test_foreign_context_or_wrong_file_identity_never_rebinds_or_writes(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        self.assertTrue(journal.close())
        before = api.file.data
        for kwargs in ({'context': str(uuid.uuid4())}, {'expected': {'volume': 99, 'fileId': 'other'}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(Error): open_journal(True, **kwargs)
            self.assertEqual(api.file.data, before)

    def test_exclusive_existing_open_does_not_adopt_a_second_writer(self):
        open_journal, api, root, _, _ = self.setup_journal()
        journal = open_journal(True)
        with self.assertRaises(Error): open_journal()
        self.assertIn(journal, root.pins)
        self.assertTrue(journal(held()))
        self.assertTrue(journal.close())
        self.assertEqual(open_journal().recovered, held())

    def test_illegal_transitions_refuse_before_writing_and_preserve_prior_candidates(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        before = api.file.data
        with self.assertRaises(Error): journal(held(False))
        self.assertEqual(api.file.data, before)
        journal(held())
        before = api.file.data
        extra = held(); extra['buttons'] = 1
        with self.assertRaises(Error): journal(extra)
        self.assertEqual(api.file.data, before)
        self.assertEqual(journal.recovered, held())
        self.assertTrue(journal(_neutral()))

    def test_torn_final_write_recovers_conservative_pending_state_and_can_reset(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        journal(held())
        api.remaining = 100
        with self.assertRaises(Error): journal(held(False))
        self.assertTrue(journal.fenced)
        self.assertTrue(journal.close())
        api.remaining = None
        recovered = open_journal()
        self.assertEqual(recovered.recovered, held())
        backend = Backend()
        control = WindowsHeldInput(backend, lambda *args: [[66, 0, 0]], recovered, lambda: True,
                                   recovered=recovered.recovered)
        control.reset()
        self.assertTrue(backend.batches[0][2])
        self.assertEqual(recovered.recovered, _neutral())

    def test_torn_pending_write_cannot_fall_back_to_an_old_unblocked_record(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        api.remaining = 100
        with self.assertRaises(Error): journal(held())
        self.assertTrue(journal.close())
        api.remaining = None
        before = api.file.data
        with self.assertRaises(Error): open_journal()
        with self.assertRaises(Error): open_journal(True)
        self.assertEqual(api.file.data, before)

    def test_unconfirmed_flush_or_readback_fences_save_without_promoting_old_receipt(self):
        for failure in ('flush', 'readback'):
            open_journal, api, _, _, _ = self.setup_journal()
            journal = open_journal(True)
            api.fail_flush, api.corrupt_read = failure == 'flush', failure == 'readback'
            with self.subTest(failure=failure), self.assertRaises(Error) as caught: journal(held())
            self.assertEqual(caught.exception.outcome, 'unknown')
            with self.assertRaises(Error): journal.recovered
            before = list(api.events)
            with self.assertRaises(Error): journal(held())
            self.assertEqual(api.events, before)
            api.fail_flush, api.corrupt_read = False, False
            journal.close()
            self.assertEqual(open_journal().recovered, held())

    def test_bad_sequences_and_mixed_scope_history_are_fatal(self):
        for failure in ('gap', 'phase', 'context'):
            open_journal, api, _, _, context = self.setup_journal()
            owner = uuid.UUID(context)
            first = _packed(owner, 2, held())
            second = _packed(owner, 5 if failure == 'gap' else 3, held() if failure == 'phase' else held(False))
            if failure == 'phase':
                different = held(); different['buttons'] = 1
                second = _packed(owner, 3, different)
            if failure == 'context': second = _packed(uuid.uuid4(), 3, held(False))
            api.file.data = first+second
            with self.subTest(failure=failure), self.assertRaises(Error): open_journal()

    def test_size_links_reparse_and_file_identity_changes_are_refused(self):
        for key, value in (('size', FILE_BYTES-1), ('links', 2), ('attributes', 0x400), ('directory', True)):
            open_journal, api, _, _, _ = self.setup_journal()
            api.file.info[key] = value
            with self.subTest(key=key), self.assertRaises(Error): open_journal(True)
            self.assertFalse(any(event[0] == 'write' for event in api.events))

    def test_metadata_change_before_save_refuses_effect_and_reopen(self):
        open_journal, api, _, _, _ = self.setup_journal()
        journal = open_journal(True)
        before = api.file.data
        api.file.info['fileId'] = 'replaced'
        with self.assertRaises(Error): journal(held())
        self.assertEqual(api.file.data, before)
        journal.close()
        with self.assertRaises(Error): open_journal()

    def test_revocation_during_write_never_returns_durable_ack_or_flushes_after_expiry(self):
        open_journal, api, _, active, _ = self.setup_journal()
        journal = open_journal(True)
        api.after_write = lambda: active.__setitem__(0, False)
        flushes = len([event for event in api.events if event[0] == 'flush'])
        with self.assertRaises(Error) as caught: journal(held())
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(len([event for event in api.events if event[0] == 'flush']), flushes)
        active[0] = True
        with self.assertRaises(Error): journal(held())
        self.assertTrue(journal.close())

    def test_root_close_during_write_retains_owned_handle_chain_and_refuses_late_ack(self):
        open_journal, api, root, _, _ = self.setup_journal()
        journal = open_journal(True)
        api.block_write = True
        errors = []
        def save():
            try: journal(held())
            except Error as error: errors.append(error)
        thread = threading.Thread(target=save)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            handles = set(api.handles)
            self.assertFalse(root.close())
            self.assertEqual(set(api.handles), handles)
            with self.assertRaises(Error) as caught: journal(held())
            self.assertEqual(caught.exception.code, 'input_busy')
        finally:
            api.release.set(); thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].outcome, 'unknown')
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_failed_close_retains_owned_handle_without_deleting_or_renaming(self):
        open_journal, api, root, _, _ = self.setup_journal()
        journal = open_journal(True)
        api.fail_close = journal.handle
        self.assertFalse(journal.close())
        self.assertIn(journal, root.pins)
        api.fail_close = None
        self.assertTrue(journal.close())
        self.assertIn('data', api.home.children)
        self.assertEqual(len(api.file.data), FILE_BYTES)
        self.assertFalse(any(event[0] in ('create', 'discard', 'publish') for event in api.events))

    @unittest.skipIf(os.name == 'nt', 'POSIX temp-file seam; native Windows I/O remains a separate gate')
    def test_actual_temp_file_flush_reopen_and_controller_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'journal'
            path.write_bytes(b'\0'*FILE_BYTES)
            api = DiskAPI(path)
            open_journal, _, root, _, _ = self.setup_journal(api)
            journal = open_journal(True)
            backend = Backend()
            control = WindowsHeldInput(backend, lambda *args: [[65, 0, 0]], journal, lambda: True,
                                       recovered=journal.recovered)
            control.reset()
            control.key(65, True, (0, 0, 10, 10))
            self.assertGreaterEqual(api.flushes, 5)
            self.assertTrue(journal.close())
            recovered = open_journal()
            self.assertEqual(recovered.recovered, held(False))
            self.assertTrue(root.close())
            self.assertEqual(api.fds, {})
            self.assertEqual(path.stat().st_size, FILE_BYTES)

    def test_native_open_requests_existing_exclusive_read_write_without_delete_or_allocation(self):
        native = object.__new__(Win32Journal)
        observed = []
        def open_file(out, access, attrs, status, allocation, attributes, sharing, disposition, options, ea, size):
            value = c.cast(attrs, c.POINTER(OBJECT_ATTRIBUTES)).contents
            name = value.ObjectName.contents
            observed.append((access, value.RootDirectory, c.string_at(name.Buffer, name.Length).decode('utf-16-le'),
                             allocation, sharing, disposition, options))
            c.cast(out, c.POINTER(H))[0] = H(123)
            return 0
        native.nt = SimpleNamespace(NtCreateFile=open_file)
        self.assertEqual(native.journal(9, 'input-journal'), 123)
        self.assertEqual(observed, [(0xC0100000, 9, 'input-journal', None, 0, 1, 0x200062)])


if __name__ == '__main__': unittest.main()
