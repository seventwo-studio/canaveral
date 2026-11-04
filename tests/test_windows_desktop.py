"""Native-shaped GDI/USER doubles; no host screen or input is accessed."""
import ctypes as c
import struct
import sys
import threading
import unittest
import zlib
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.guest.windows_desktop import (Win32Desktop, INPUT, KEYBDINPUT, MOUSEINPUT,
    BITMAPINFOHEADER, BITMAPINFO, H, U32, I32, key_input, mouse_input, pointer_input, png_bgra)
from canaveral.model import Error
from canaveral.simulator_screen import dimensions


class API:
    def __init__(self):
        self.bounds = (-100, -200, 4, 3)
        self.names = {1: 'WinSta0', 2: 'Default', 50: 'Default'}
        self.active = True
        self.owned, self.calls, self.sent = set(), [], []
        self.failure = None
        self.selected = 40
        self.count = None
        self.after_blt = self.after_send = lambda: None
        self.raw = b'\x01\x02\x03\xff'*12
        user = {'SetThreadDpiAwarenessContext': self.dpi, 'GetSystemMetrics': self.metric,
            'GetProcessWindowStation': lambda: 1, 'GetThreadDesktop': lambda tid: 2,
            'GetUserObjectInformationW': self.information, 'OpenInputDesktop': self.desktop,
            'CloseDesktop': lambda h: self.drop('desktop', h), 'GetDC': lambda h: self.take('dc', 10),
            'ReleaseDC': lambda hwnd, h: self.drop('dc', h), 'SendInput': self.send}
        gdi = {'CreateCompatibleDC': lambda h: self.take('memory', 20), 'DeleteDC': lambda h: self.drop('memory', h),
            'CreateDIBSection': self.dib, 'SelectObject': self.select, 'DeleteObject': lambda h: self.drop('bitmap', h),
            'BitBlt': self.blt, 'GdiFlush': lambda: 0 if self.failure == 'flush' else 1}
        def wrap(function):
            return lambda *args: function(*args)
        self.libraries = tuple(SimpleNamespace(**{name: wrap(fn) for name, fn in values.items()})
                               for values in (user, gdi, {'GetCurrentThreadId': lambda: 9}))

    def take(self, kind, handle):
        self.calls.append(('take', kind, handle))
        if self.failure == 'create-'+kind: return 0
        self.owned.add(handle)
        return handle

    def drop(self, kind, handle):
        self.calls.append(('drop', kind, handle))
        if self.failure == 'drop-'+kind: return 0
        self.owned.remove(handle)
        return 1

    def dpi(self, value):
        value = value.value if isinstance(value, H) else value
        self.calls.append(('dpi', value))
        if value == 100 and self.failure == 'restore-dpi': return 0
        return 100 if value != 100 else H(-4).value

    def metric(self, index): return self.bounds[(76, 77, 78, 79).index(index)]

    def information(self, handle, index, buffer, size, needed):
        if index == 2:
            text = c.create_unicode_buffer(self.names[handle])
            c.memmove(buffer, text, c.sizeof(text))
            c.cast(needed, c.POINTER(U32))[0] = U32(c.sizeof(text))
        else:
            c.cast(buffer, c.POINTER(I32))[0] = I32(int(self.active))
            c.cast(needed, c.POINTER(U32))[0] = U32(4)
        return 1

    def desktop(self, flags, inherit, access):
        self.calls.append(('desktop', flags, inherit, access))
        return self.take('desktop', 50)

    def dib(self, dc, pointer, usage, bits, section, offset):
        info = c.cast(pointer, c.POINTER(BITMAPINFO)).contents.header
        self.calls.append(('dib', info.width, info.height, info.bits, info.planes, info.compression))
        self.pixels = c.create_string_buffer(self.raw)
        c.cast(bits, c.POINTER(H))[0] = H(c.addressof(self.pixels))
        return self.take('bitmap', 30)

    def select(self, dc, handle):
        self.calls.append(('select', dc, handle))
        if handle == 40 and self.failure == 'restore-bitmap': return 0
        previous, self.selected = self.selected, handle
        return previous

    def blt(self, *args):
        self.calls.append(('blt', args))
        self.after_blt()
        return 0 if self.failure == 'blt' else 1

    def send(self, count, values, size):
        self.calls.append(('send', count, size))
        self.sent.extend(INPUT.from_buffer_copy(bytes(values[i])) for i in range(count))
        self.after_send()
        if self.failure == 'send': raise OSError('private user/session data')
        return count if self.count is None else self.count


class WindowsDesktopTests(unittest.TestCase):
    def backend(self, cleanup=None):
        api, allowed = API(), [True]
        desktop = Win32Desktop(lambda: allowed[0], cleanup, libraries=api.libraries)
        self.addCleanup(desktop.close)
        return desktop, api, allowed

    def test_capture_physical_top_down_bgra_is_common_png_and_releases_all_owned_handles(self):
        desktop, api, _ = self.backend()
        result = desktop.capture()
        self.assertEqual(result['bounds'], (-100, -200, 4, 3))
        self.assertEqual(dimensions(result['png']), (4, 3))
        raw, offset = b'', 8
        while offset < len(result['png']):
            length, = struct.unpack_from('!I', result['png'], offset)
            kind, data = result['png'][offset+4:offset+8], result['png'][offset+8:offset+8+length]
            if kind == b'IDAT': raw += data
            offset += length+12
        self.assertEqual(zlib.decompress(raw), (b'\0'+b'\x03\x02\x01'*4)*3)
        self.assertIn(('dib', 4, -3, 32, 1, 0), api.calls)
        self.assertEqual(api.owned, set())
        self.assertIsNone(desktop.old_dpi)
        self.assertFalse(desktop.gdi_pending)

    def test_pointer_normalization_uses_virtual_desktop_edges_with_negative_origin(self):
        desktop, api, _ = self.backend()
        bounds = api.bounds
        events = [pointer_input(0, 0, bounds), mouse_input(2), pointer_input(3, 2, bounds), mouse_input(4)]
        self.assertEqual(desktop.post(events, bounds), {'posted': True})
        self.assertEqual([(e.mouse.dx, e.mouse.dy) for e in api.sent[::2]], [(0, 0), (65535, 65535)])
        self.assertEqual([e.mouse.flags for e in api.sent], [0xC001, 2, 0xC001, 4])
        self.assertIn(('send', 4, 40), api.calls)
        self.assertEqual(api.owned, set())

    def test_keyboard_scan_codes_sides_unicode_surrogates_and_release_fields(self):
        desktop, api, _ = self.backend()
        events = [key_input(vk=0xA2), key_input(scan=0x1D, flags=9),
                  key_input(scan=0xD83D, flags=4), key_input(scan=0xDE80, flags=4),
                  key_input(scan=0xD83D, flags=6), key_input(scan=0xDE80, flags=6), key_input(vk=0xA2, flags=2)]
        desktop.post(events, api.bounds)
        self.assertEqual([(e.key.vk, e.key.scan, e.key.flags) for e in api.sent],
                         [(0xA2, 0, 0), (0, 0x1D, 9), (0, 0xD83D, 4), (0, 0xDE80, 4),
                          (0, 0xD83D, 6), (0, 0xDE80, 6), (0xA2, 0, 2)])

    def test_wrong_frame_geometry_refuses_native_input_before_effect(self):
        desktop, api, _ = self.backend()
        with self.assertRaises(Error) as caught: desktop.post([key_input(vk=65)], (0, 0, 4, 3))
        self.assertEqual(caught.exception.code, 'input_stale')
        self.assertIsNone(caught.exception.outcome)
        self.assertEqual(api.sent, [])
        self.assertFalse(desktop.input_fenced)

    def test_partial_or_exceptional_insertion_is_unknown_and_never_replayed(self):
        for failure in (0, 1, 3, True, 'send'):
            desktop, api, _ = self.backend()
            if failure == 'send': api.failure = 'send'
            else: api.count = failure
            with self.subTest(failure=failure), self.assertRaises(Error) as caught:
                desktop.post([key_input(vk=65), key_input(vk=65, flags=2)], api.bounds)
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertNotIn('private', str(caught.exception))
            self.assertTrue(desktop.input_fenced)
            with self.assertRaises(Error): desktop.post([key_input(vk=65)], api.bounds)
            self.assertEqual(len([e for e in api.calls if e[0] == 'send']), 1)
            self.assertEqual(dimensions(desktop.capture()['png']), (4, 3))

    def test_cleanup_is_release_only_after_revocation_and_does_not_revive_input(self):
        desktop, api, allowed = self.backend(cleanup=lambda: True)
        desktop.post([key_input(vk=65), mouse_input(2)], api.bounds)
        allowed[0] = False
        with self.assertRaises(Error): desktop.capture()
        with self.assertRaises(Error): desktop.post([key_input(vk=66)], None, cleanup=True)
        self.assertEqual(desktop.post([key_input(vk=65, flags=2), mouse_input(4)], None, cleanup=True), {'posted': True})
        allowed[0] = True
        with self.assertRaises(Error): desktop.post([key_input(vk=65)], api.bounds)
        with self.assertRaises(Error): desktop.capture()
        self.assertEqual(len(api.sent), 4)

    def test_revocation_after_dispatch_withholds_acknowledgement(self):
        desktop, api, allowed = self.backend(cleanup=lambda: True)
        api.after_send = lambda: allowed.__setitem__(0, False)
        with self.assertRaises(Error) as caught: desktop.post([key_input(vk=65)], api.bounds)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(desktop.input_fenced)
        self.assertTrue(desktop.revoked)
        self.assertEqual(api.owned, set())

    def test_topology_changes_during_capture_or_input_refuse_success(self):
        desktop, api, _ = self.backend()
        api.after_blt = lambda: setattr(api, 'bounds', (0, 0, 5, 3))
        with self.assertRaises(Error) as caught: desktop.capture()
        self.assertEqual(caught.exception.code, 'input_stale')
        self.assertEqual(api.owned, set())
        api.bounds = (-100, -200, 4, 3)
        api.after_send = lambda: setattr(api, 'bounds', (0, 0, 5, 3))
        with self.assertRaises(Error) as caught: desktop.post([key_input(vk=65)], api.bounds)
        self.assertEqual(caught.exception.outcome, 'unknown')

    def test_secure_alternate_inactive_or_noninteractive_desktops_never_capture_or_post(self):
        for kind in ('station', 'thread', 'input', 'inactive'):
            desktop, api, _ = self.backend()
            if kind == 'station': api.names[1] = 'Service-0x0'
            elif kind == 'thread': api.names[2] = 'Other'
            elif kind == 'input': api.names[50] = 'Winlogon'
            else: api.active = False
            with self.subTest(kind=kind), self.assertRaises(Error): desktop.capture()
            with self.assertRaises(Error): desktop.post([key_input(vk=65)], api.bounds)
            self.assertEqual(api.sent, [])
            self.assertFalse(any(e[0] == 'blt' for e in api.calls))
            self.assertEqual(api.owned, set())

    def test_failed_cleanup_retains_handles_and_explicit_retry_never_reopens(self):
        for failure in ('restore-bitmap', 'drop-bitmap', 'drop-memory', 'drop-dc', 'drop-desktop', 'restore-dpi', 'flush'):
            desktop, api, _ = self.backend()
            api.failure = failure
            with self.subTest(failure=failure), self.assertRaises(Error) as caught: desktop.capture()
            self.assertEqual(caught.exception.code, 'display_cleanup_uncertain')
            self.assertTrue(desktop.fenced)
            before = list(api.calls)
            with self.assertRaises(Error): desktop.capture()
            self.assertEqual(api.calls, before)
            api.failure = None
            self.assertTrue(desktop.close())
            self.assertEqual(api.owned, set())
            self.assertIsNone(desktop.old_dpi)

    def test_creation_or_blt_failure_releases_every_acquired_object(self):
        for failure in ('create-desktop', 'create-dc', 'create-memory', 'create-bitmap', 'blt'):
            desktop, api, _ = self.backend()
            api.failure = failure
            with self.subTest(failure=failure), self.assertRaises(Error): desktop.capture()
            self.assertEqual(api.owned, set())
            self.assertIsNone(desktop.old_dpi)

    def test_native_calls_stay_on_one_worker_thread(self):
        desktop, api, _ = self.backend()
        desktop.capture()
        before, errors = list(api.calls), []
        def capture():
            try: desktop.capture()
            except Error as error: errors.append(error)
        thread = threading.Thread(target=capture)
        thread.start(); thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(api.calls, before)

    def test_protocol_bounds_reject_large_geometry_and_bad_buffers(self):
        desktop, api, _ = self.backend()
        api.bounds = (0, 0, 4097, 3)
        with self.assertRaises(Error): desktop.capture()
        self.assertFalse(any(e[0] == 'dib' for e in api.calls))
        for width, height, pixels in ((True, 1, b'1234'), (1, 1, b''), (0, 1, b'')):
            with self.assertRaises(Error): png_bgra(width, height, pixels)

    def test_invalid_native_events_have_no_effect(self):
        desktop, api, _ = self.backend()
        for events in ([], [INPUT()], [key_input(vk=65)]*4097):
            with self.assertRaises(Error): desktop.post(events, api.bounds)
        for flags, data in ((6, 0), (0x1800, 120), (0x180, 1), (0x100, 0), (0x200, 0), (0x8000, 0)):
            with self.assertRaises(Error): mouse_input(flags, data)
        for args in ({'vk': 65, 'flags': 4}, {'vk': True}, {'scan': 0, 'flags': 8}, {'vk': 256}):
            with self.assertRaises(Error): key_input(**args)
        self.assertEqual(api.sent, [])
        self.assertEqual(api.calls, [])

    def test_fixed_width_structures_match_intended_64_bit_windows_layout(self):
        self.assertEqual(c.sizeof(BITMAPINFOHEADER), 40)
        self.assertEqual((c.sizeof(KEYBDINPUT), c.sizeof(MOUSEINPUT), c.sizeof(INPUT)), (24, 32, 40))
        self.assertEqual((KEYBDINPUT.extra.offset, MOUSEINPUT.extra.offset, INPUT.value.offset), (16, 24, 8))

    def test_revocation_during_png_encoding_withholds_frame_after_native_cleanup(self):
        desktop, api, allowed = self.backend()
        def encode(*args):
            result = png_bgra(*args)
            allowed[0] = False
            return result
        with patch('canaveral.guest.windows_desktop.png_bgra', side_effect=encode):
            with self.assertRaises(Error) as caught: desktop.capture()
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(api.owned, set())
        self.assertTrue(desktop.revoked)

    def test_cleanup_without_authority_and_move_cleanup_have_no_input_effect(self):
        desktop, api, allowed = self.backend()
        allowed[0] = False
        with self.assertRaises(Error): desktop.post([key_input(vk=65, flags=2)], None, cleanup=True)
        allowed[0] = True
        with self.assertRaises(Error): desktop.post([pointer_input(0, 0, api.bounds)], None, cleanup=True)
        self.assertEqual(api.sent, [])

    def test_png_size_and_pointer_metadata_are_bounded(self):
        for bounds in ((), (0, 0, True, 1), (0, 0, 4097, 1)):
            with self.assertRaises(Error): pointer_input(0, 0, bounds)
        compressor = SimpleNamespace(compress=lambda data: b'x'*4194304)
        with patch('canaveral.guest.windows_desktop.zlib.compressobj', return_value=compressor):
            with self.assertRaises(Error): png_bgra(1, 1, b'1234')

    def test_revocation_during_native_cleanup_withholds_input_acknowledgement(self):
        desktop, api, allowed = self.backend()
        def dpi(value):
            result = api.dpi(value)
            if value == 100: allowed[0] = False
            return result
        api.libraries[0].SetThreadDpiAwarenessContext = dpi
        with self.assertRaises(Error) as caught: desktop.post([key_input(vk=65)], api.bounds)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(desktop.revoked)
        self.assertTrue(desktop.input_fenced)
        self.assertEqual(api.owned, set())

    @unittest.skipIf(sys.platform == 'win32', 'Native construction must not inspect an actual Windows desktop in this suite')
    def test_native_default_is_unavailable_on_non_windows(self):
        with self.assertRaises(Error) as caught: Win32Desktop(lambda: True)
        self.assertEqual(caught.exception.code, 'capability_unsupported')


if __name__ == '__main__': unittest.main()
