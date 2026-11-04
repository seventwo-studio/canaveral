"""Pinned-file API doubles, not Windows filesystem or sharing-mode proof."""
import copy
import ctypes as c
import struct
import sys
import threading
import unittest
from types import SimpleNamespace

from canaveral.guest.windows_file_handles import (WindowsRoot, Win32Files, component,
    directory_records, OBJECT_ATTRIBUTES, UNICODE_STRING, FILE_ID_INFO, FILE_STANDARD_INFO, CHUNK)
from canaveral.model import Error


class Node:
    def __init__(self, identity, directory=False, data=b'hello'):
        self.children, self.data = {}, data
        self.info = {'volume': 99, 'fileId': str(identity), 'size': len(data), 'written': 1,
            'changed': 1, 'links': 1, 'directory': directory, 'attributes': 16 if directory else 128}


class API:
    def __init__(self):
        self.root, self.home, self.file = Node(1, True), Node(2, True), Node(3)
        self.root.children['home'] = self.home
        self.home.children['data'] = self.file
        self.handles, self.next, self.events = {}, 0, []
        self.fail_close = None
        self.entered, self.release = threading.Event(), threading.Event()
        self.block_open = self.block_read = False
        self.list_entries = []

    def handle(self, node):
        self.next += 1
        self.handles[self.next] = node
        return self.next

    def drive(self, drive):
        self.events.append(('drive', drive))
        return self.handle(self.root)

    def open(self, parent, name, directory):
        self.events.append(('open', parent, name, directory))
        if self.block_open:
            self.entered.set()
            self.release.wait(3)
        return self.handle(self.handles[parent].children[name])

    def info(self, handle):
        return copy.deepcopy(self.handles[handle].info)

    def read(self, handle, offset, size):
        self.events.append(('read', handle, offset, size))
        if self.block_read:
            self.entered.set()
            self.release.wait(3)
        value = self.handles[handle].data
        return value(offset, size) if callable(value) else value[offset:offset+size]

    def entries(self, handle):
        yield from self.list_entries

    def close(self, handle):
        if self.fail_close == handle: raise OSError('private native handle error')
        self.events.append(('close', handle))
        del self.handles[handle]


class WindowsFileHandleTests(unittest.TestCase):
    def root(self, prefix=('home',)):
        api = API()
        root = WindowsRoot('c:', prefix, api=api)
        self.addCleanup(root.close)
        self.assertEqual(root.start(), {'volume': 99, 'fileId': '2' if prefix else '1'})
        return root, api

    def test_relative_handles_and_pinned_metadata_are_retained_until_close(self):
        root, api = self.root()
        pin = root.pin(('data',))
        self.assertEqual(pin.read(0, 5), b'hello')
        self.assertEqual(api.events[0], ('drive', 'C:'))
        self.assertEqual(api.events[1][2], 'home')
        self.assertEqual(api.events[2][2], 'data')
        self.assertTrue(pin.close())
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})
        self.assertTrue(root.close())

    def test_unsafe_path_components_never_enter_native_resolution(self):
        root, api = self.root()
        before = list(api.events)
        for name in ('..', '.', '', 'a/b', 'a\\b', 'file:stream', '\0', 'x.', 'x ', '\ud800'):
            with self.subTest(name=repr(name)), self.assertRaises(Error): root.pin((name,))
        self.assertEqual(api.events, before)

    def test_unc_and_device_roots_are_not_reinterpreted_as_drives(self):
        for drive in ('C', 'C:\\', '\\\\server\\share', '\\\\?\\C:', '\\\\.\\PhysicalDrive0', 'C:relative'):
            with self.subTest(drive=drive), self.assertRaises(Error): WindowsRoot(drive, api=API())

    def test_reparse_or_wrong_file_types_are_refused_without_leaking_handles(self):
        root, api = self.root()
        expected = set(api.handles)
        api.file.info['attributes'] = 0x400
        with self.assertRaises(Error): root.pin(('data',))
        self.assertEqual(set(api.handles), expected)
        api.file.info['attributes'] = 128
        with self.assertRaises(Error): root.pin(('data',), directory=True)
        self.assertEqual(set(api.handles), expected)
        with self.assertRaises(Error): root.pin(())

    def test_metadata_and_identity_changes_refuse_acknowledgement(self):
        for key, changed in [('fileId', 'other'), ('volume', 100), ('written', 2),
                             ('changed', 2), ('size', 6), ('links', 2), ('attributes', 0x400)]:
            root, api = self.root()
            pin = root.pin(('data',))
            api.file.info[key] = changed
            with self.subTest(key=key), self.assertRaises(Error): pin.read(0, 5)
            self.assertTrue(root.close())

    def test_large_files_use_bounded_reads_with_64_bit_offsets(self):
        root, api = self.root()
        api.file.info['size'] = 64*1024**3
        api.file.data = lambda offset, size: b'x'*size
        pin = root.pin(('data',))
        self.assertEqual(len(pin.read(8*1024**3+17, CHUNK)), CHUNK)
        self.assertEqual(api.events[-1][2:], (8*1024**3+17, CHUNK))
        for offset, size in ((-1, 1), (True, 1), (0, CHUNK+1), (0, -1)):
            with self.assertRaises(Error): pin.read(offset, size)

    def test_valid_deep_paths_are_bounded_by_metadata_not_arbitrary_depth(self):
        root, api = self.root()
        parent = api.home
        for index in range(200):
            child = Node(1000+index, True)
            parent.children['next'] = child
            parent = child
        parent.children['data'] = api.file
        pin = root.pin(('next',)*200+('data',))
        self.assertEqual(pin.read(0, 5), b'hello')
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_close_during_read_retains_handles_and_rejects_late_data(self):
        root, api = self.root()
        pin = root.pin(('data',))
        api.block_read = True
        errors = []
        def read():
            try: pin.read(0, 5)
            except Error as error: errors.append(error)
        thread = threading.Thread(target=read)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            with self.assertRaises(Error) as busy:
                pin.check()
            self.assertEqual(busy.exception.code, 'input_busy')
            handles = set(api.handles)
            self.assertFalse(root.close())
            self.assertEqual(set(api.handles), handles)
        finally:
            api.release.set()
            thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].status, 410)
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_close_during_open_preserves_root_until_late_handle_cleanup(self):
        root, api = self.root()
        api.block_open = True
        errors = []
        def open_file():
            try: root.pin(('data',))
            except Error as error: errors.append(error)
        thread = threading.Thread(target=open_file)
        thread.start()
        try:
            self.assertTrue(api.entered.wait(1))
            self.assertFalse(root.close())
            self.assertEqual(len(api.handles), 2)
        finally:
            api.release.set()
            thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_failed_release_keeps_ownership_and_fences_partly_closed_pin(self):
        root, api = self.root()
        sub = Node(4, True)
        sub.children['data'] = api.file
        api.home.children['sub'] = sub
        pin = root.pin(('sub', 'data'))
        api.fail_close = pin.handles[0]
        self.assertFalse(pin.close())
        self.assertNotIn(pin.handle, api.handles)  # Leaf closed before parent failure.
        with self.assertRaises(Error): pin.read(0, 1)
        self.assertIn(pin, root.pins)
        api.fail_close = None
        self.assertTrue(pin.close())
        self.assertTrue(root.close())

    def test_failed_directory_release_fences_root_and_is_not_silent(self):
        root, api = self.root(prefix=())
        api.fail_close = api.next+1
        with self.assertRaises(Error) as caught: root.list(('home',))
        self.assertEqual(caught.exception.code, 'file_cleanup_uncertain')
        self.assertTrue(root.fenced)
        self.assertTrue(root.pins)
        api.fail_close = None
        self.assertTrue(root.close())
        self.assertEqual(api.handles, {})

    def test_cross_volume_component_is_refused_and_new_handles_are_reclaimed(self):
        root, api = self.root()
        before = set(api.handles)
        api.file.info['volume'] = 100
        with self.assertRaises(Error): root.pin(('data',))
        self.assertEqual(set(api.handles), before)

    def test_directory_listing_is_bounded_and_marks_truncation(self):
        root, api = self.root()
        api.list_entries = [{'name': str(i), 'kind': 'file', 'size': 0} for i in range(2001)]
        result = root.list()
        self.assertEqual(len(result['entries']), 2000)
        self.assertTrue(result['truncated'])
        api.list_entries = []
        self.assertEqual(root.list(), {'entries': [], 'truncated': False})

    def test_directory_identity_mutation_during_enumeration_fails(self):
        root, api = self.root()
        def entries(handle):
            yield {'name': 'data', 'kind': 'file', 'size': 5}
            api.home.info['changed'] = 2
        api.entries = entries
        with self.assertRaises(Error): root.list()

    def test_native_structures_use_fixed_windows_widths(self):
        if c.sizeof(c.c_void_p) == 8:
            self.assertEqual(c.sizeof(UNICODE_STRING), 16)
            self.assertEqual(c.sizeof(OBJECT_ATTRIBUTES), 48)
        self.assertEqual(c.sizeof(FILE_ID_INFO), 24)
        self.assertEqual(c.sizeof(FILE_STANDARD_INFO), 24)

    def record(self, name, *, attributes=128, next_record=False):
        encoded = name.encode('utf-16-le')
        size = (88+len(encoded)+7)//8*8
        data = bytearray(size)
        struct.pack_into('<I', data, 0, size if next_record else 0)
        struct.pack_into('<q', data, 24, 116444736000000000)
        struct.pack_into('<q', data, 40, 123)
        struct.pack_into('<IIII', data, 56, attributes, len(encoded), 0, 0xA000000C if attributes & 0x400 else 0)
        data[72:88] = bytes(range(16))
        data[88:88+len(encoded)] = encoded
        return bytes(data)

    def test_native_directory_records_preserve_unicode_ids_and_reparse_tags(self):
        entries = list(directory_records(self.record('folder', attributes=16, next_record=True)+
            self.record('λ-link', attributes=0x400)))
        self.assertEqual([entry['kind'] for entry in entries], ['directory', 'symlink'])
        self.assertEqual(entries[1]['name'], 'λ-link')
        self.assertEqual(entries[1]['reparseTag'], 0xA000000C)
        self.assertEqual(entries[1]['nativeFileId'], bytes(range(16)).hex())
        self.assertEqual(entries[1]['modifiedAt'], 0)

    def test_invalid_native_directory_records_do_not_escape_their_envelope(self):
        for raw in (b'', b'x'*87, self.record('a')[:89]):
            with self.assertRaises(ValueError): list(directory_records(raw))
        raw = bytearray(self.record('a'))
        struct.pack_into('<I', raw, 0, 1)
        with self.assertRaises(ValueError): list(directory_records(raw))

    def test_native_relative_open_marshals_parent_handle_and_readonly_sharing(self):
        from canaveral.guest.windows_file_handles import H
        api = Win32Files.__new__(Win32Files)
        def create(result, access, attributes, status, allocation, flags, sharing, disposition, options, ea, length):
            attrs = c.cast(attributes, c.POINTER(OBJECT_ATTRIBUTES)).contents
            text = attrs.ObjectName.contents
            self.assertEqual(attrs.RootDirectory, 123)
            self.assertEqual(c.string_at(text.Buffer, text.Length).decode('utf-16-le'), 'λ-file')
            self.assertEqual(sharing, 1)
            self.assertEqual(disposition, 1)
            self.assertEqual(options, 0x00200000 | 0x20 | 0x40)
            c.cast(result, c.POINTER(H)).contents.value = 456
            return 0
        api.nt = SimpleNamespace(NtCreateFile=create)
        self.assertEqual(api.open(123, 'λ-file', False), 456)

    def test_non_windows_never_uses_a_host_filesystem_fallback(self):
        if sys.platform != 'win32':
            with self.assertRaises(Error) as caught: Win32Files()
            self.assertEqual(caught.exception.code, 'capability_unsupported')
