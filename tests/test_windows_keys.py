"""Keyboard-layout API doubles only; no keyboard layout or input is queried."""
import ctypes as c
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canaveral.guest.windows_keys import WindowsKeys, NAMED
from canaveral.guest.windows_held_input import WindowsHeldInput
from canaveral.model import Error
from test_windows_held_input import Backend
from test_windows_desktop import API as DesktopAPI
from canaveral.guest.windows_desktop import Win32Desktop


class API:
    def __init__(self):
        self.window, self.thread, self.layout = 100, 200, 0x4090409
        self.calls = []
        self.map_hook = self.scan_hook = self.unicode_hook = lambda: None
        self.translated = None
        self.chars = {'a': 0x41, 'A': 0x141, 'c': 0x43, 'C': 0x143, '!': 0x131,
                      ' ': 0x20, '@': 0x651, 'é': 0xba}
        self.scans = {0xa0: 0x2a, 0xa1: 0x36, 0xa2: 0x1d, 0xa3: 0xe01d,
            0xa4: 0x38, 0xa5: 0xe038, 0x5b: 0xe05b, 0x5c: 0xe05c, 0x5d: 0xe05d,
            0x0d: 0x1c, 0x41: 0x1e, 0x43: 0x2e, 0x51: 0x10, 0x31: 2, 0x20: 0x39, 0xba: 0x27}
        for vk in NAMED.values(): self.scans.setdefault(vk, vk)
        functions = {'GetForegroundWindow': self.foreground, 'GetWindowThreadProcessId': self.window_thread,
            'GetKeyboardLayout': self.keyboard, 'VkKeyScanExW': self.character,
            'MapVirtualKeyExW': self.scan, 'ToUnicodeEx': self.unicode}
        def wrap(fn): return lambda *args: fn(*args)
        self.library = SimpleNamespace(**{name: wrap(fn) for name, fn in functions.items()})

    def foreground(self):
        self.calls.append(('window',))
        return self.window

    def window_thread(self, window, process):
        self.calls.append(('thread', window, process))
        return self.thread

    def keyboard(self, thread):
        self.calls.append(('layout', thread))
        return self.layout

    def character(self, text, layout):
        self.calls.append(('character', text, layout))
        self.map_hook()
        return self.chars.get(text, -1)

    def scan(self, vk, mode, layout):
        self.calls.append(('scan', vk, mode, layout))
        self.scan_hook()
        return self.scans.get(vk, 0)

    def unicode(self, vk, scan, state, buffer, size, flags, layout):
        self.calls.append(('unicode', vk, scan, bytes(state), size, flags, layout))
        shifted = bool(state[0x10] & 128)
        value = {0x41: 'A' if shifted else 'a', 0x43: 'C' if shifted else 'c',
                 0x31: '!' if shifted else '1', 0x20: ' ', 0xba: 'é',
                 0x51: '@' if state[0x11] and state[0x12] else 'q'}.get(vk, '')
        if value: buffer[0] = value
        self.unicode_hook()
        return (1 if value else 0) if self.translated is None else self.translated


class WindowsKeysTests(unittest.TestCase):
    def resolver(self):
        api, active = API(), [True]
        keys = WindowsKeys(lambda: active[0], api=api.library)
        self.addCleanup(keys.close)
        return keys, api, active

    def test_plain_unicode_and_surrogates_need_no_layout_lookup(self):
        keys, api, _ = self.resolver()
        self.assertEqual(keys(ord('a'), 0), [[0, 97, 4]])
        self.assertEqual(keys(ord('A'), 1), [[0, 65, 4]])
        self.assertEqual(keys(0x0101f680, 0), [[0, 0xd83d, 4], [0, 0xde80, 4]])
        self.assertTrue(keys.validation()())
        self.assertEqual(api.calls, [])

    def test_modified_shortcuts_use_foreground_thread_layout_and_scan_codes(self):
        keys, api, _ = self.resolver()
        self.assertEqual(keys(ord('c'), 2), [[0, 0x2e, 8]])
        self.assertEqual(keys(ord('C'), 3), [[0, 0x2e, 8]])
        self.assertTrue(keys.validation()())
        self.assertIn(('layout', 200), api.calls)
        self.assertIn(('character', 'c', 0x4090409), api.calls)
        self.assertIn(('scan', 0x43, 4, 0x4090409), api.calls)
        translations = [call for call in api.calls if call[0] == 'unicode']
        self.assertEqual(translations[0][5], 4)  # ToUnicodeEx must not change dead-key state.
        self.assertEqual(len(translations[0][3]), 256)

    def test_modifier_sides_and_keypad_enter_keep_extended_distinctions(self):
        keys, _, _ = self.resolver()
        self.assertEqual(keys(0xffe1, 0), [[0, 0x2a, 8]])
        self.assertEqual(keys(0xffe2, 1), [[0, 0x36, 8]])
        self.assertEqual(keys(0xffe3, 0), [[0, 0x1d, 8]])
        self.assertEqual(keys(0xffe4, 2), [[0, 0x1d, 9]])
        self.assertEqual(keys(0xffea, 0), [[0, 0x38, 9]])
        self.assertEqual(keys(0xff0d, 0), [[0, 0x1c, 8]])
        self.assertEqual(keys(0xff8d, 0), [[0, 0x1c, 9]])

    def test_altgr_requires_owned_right_alt_or_control_plus_alt(self):
        keys, api, _ = self.resolver()
        self.assertEqual(keys(ord('@'), 20), [[0, 0x10, 8]])
        self.assertEqual(keys(ord('@'), 6), [[0, 0x10, 8]])
        with self.assertRaises(Error) as caught: keys(ord('@'), 4)
        self.assertEqual(caught.exception.code, 'capability_unsupported')
        state = [call for call in api.calls if call[0] == 'unicode'][0][3]
        self.assertEqual((state[0x11], state[0x12]), (128, 128))

    def test_letter_case_does_not_synthesize_shift_for_shortcuts_but_punctuation_is_checked(self):
        keys, _, _ = self.resolver()
        self.assertEqual(keys(ord('C'), 2), [[0, 0x2e, 8]])
        self.assertEqual(keys(ord(' '), 3), [[0, 0x39, 8]])
        self.assertEqual(keys(ord('!'), 3), [[0, 2, 8]])
        with self.assertRaises(Error): keys(ord('!'), 2)

    def test_dead_untranslated_or_multicharacter_results_are_refused(self):
        for count in (-1, 0, 2, 9, True):
            keys, api, _ = self.resolver()
            api.translated = count
            with self.subTest(count=count), self.assertRaises(Error) as caught: keys(ord('c'), 2)
            self.assertEqual(caught.exception.code, 'capability_unsupported')

    def test_unknown_scan_prefixes_and_missing_scans_are_not_truncated_or_retried(self):
        for scan in (0, 0xe000, 0xe11d, 0xff01, 0x10001):
            keys, api, _ = self.resolver()
            api.scans[0xa3] = scan
            with self.subTest(scan=scan), self.assertRaises(Error): keys(0xffe4, 0)
            self.assertEqual(len([call for call in api.calls if call[0] == 'scan']), 1)

    def test_locks_pause_legacy_and_invalid_unicode_are_explicitly_unsupported(self):
        keys, api, _ = self.resolver()
        for keysym in (0xffe5, 0xff7f, 0xff14, 0xff13, 0xffb0, 0x1234, 0x01000000, 0x0100d800, 0x01110000):
            with self.subTest(keysym=keysym), self.assertRaises(Error) as caught: keys(keysym, 0)
            self.assertEqual(caught.exception.code, 'capability_unsupported')
        self.assertEqual(api.calls, [])

    def test_layout_or_foreground_change_during_resolution_is_stale(self):
        for field in ('window', 'thread', 'layout'):
            keys, api, _ = self.resolver()
            api.map_hook = lambda: setattr(api, field, getattr(api, field)+1)
            with self.subTest(field=field), self.assertRaises(Error) as caught: keys(ord('c'), 2)
            self.assertEqual(caught.exception.code, 'input_stale')

    def test_validation_captures_immutable_observations_across_later_resolution(self):
        keys, api, _ = self.resolver()
        keys(ord('c'), 2)
        validate = keys.validation()
        keys(ord('a'), 0)
        api.layout += 1
        with self.assertRaises(Error) as caught: validate()
        self.assertEqual(caught.exception.code, 'input_stale')
        self.assertTrue(keys.validation()())  # Unicode resolution is layout independent.

    def test_layout_change_after_pending_save_refuses_native_posting(self):
        keys, api, _ = self.resolver()
        backend, records = Backend(), []
        def save(record):
            records.append(record)
            api.layout += 1
            return True
        control = WindowsHeldInput(backend, keys, save, lambda: True)
        with self.assertRaises(Error) as caught: control.key(0xffe3, True, (0, 0, 10, 10))
        self.assertIsNone(caught.exception.outcome)
        self.assertEqual(backend.batches, [])
        self.assertTrue(control.state['blocked'])
        self.assertEqual(len(records), 1)

    def test_held_repeat_and_release_keep_old_scan_after_layout_change(self):
        keys, api, _ = self.resolver()
        backend = Backend()
        control = WindowsHeldInput(backend, keys, lambda state: True, lambda: True)
        bounds = (0, 0, 10, 10)
        control.key(0xffe3, True, bounds)
        control.key(ord('c'), True, bounds)
        api.layout += 1
        api.scans[0x43] = 0x30
        control.key(ord('c'), True, bounds)
        control.key(ord('c'), False, bounds)
        self.assertEqual([(batch[0][0].key.scan, batch[0][0].key.flags) for batch in backend.batches[1:]],
                         [(0x2e, 8), (0x2e, 8), (0x2e, 10)])
        self.assertEqual(len([call for call in api.calls if call[0] == 'character']), 1)

    def test_right_alt_side_reaches_native_layout_resolution_through_held_controller(self):
        keys, _, _ = self.resolver()
        backend = Backend()
        control = WindowsHeldInput(backend, keys, lambda state: True, lambda: True)
        control.key(0xffea, True, (0, 0, 10, 10))
        self.assertEqual(control.modifiers, 20)
        control.key(ord('@'), True, (0, 0, 10, 10))
        control.reset()
        self.assertEqual([event.key.flags for event in backend.batches[-1][0]], [10, 11])

    def test_revocation_is_sticky_and_closures_cannot_restore_resolution(self):
        keys, api, active = self.resolver()
        keys(ord('c'), 2)
        validate = keys.validation()
        active[0] = False
        with self.assertRaises(Error) as caught: validate()
        self.assertEqual(caught.exception.status, 410)
        before = list(api.calls)
        active[0] = True
        with self.assertRaises(Error): keys(ord('a'), 0)
        self.assertEqual(api.calls, before)

    def test_revocation_during_observation_and_missing_foreground_return_no_resolution(self):
        keys, api, active = self.resolver()
        api.unicode_hook = lambda: active.__setitem__(0, False)
        with self.assertRaises(Error) as caught: keys(ord('c'), 2)
        self.assertEqual(caught.exception.status, 410)
        keys, api, _ = self.resolver()
        api.window = 0
        with self.assertRaises(Error) as caught: keys(0xffe3, 0)
        self.assertEqual(caught.exception.code, 'input_stale')

    def test_invalid_inputs_and_wrong_thread_have_no_layout_effect(self):
        keys, api, _ = self.resolver()
        for keysym, modifiers in ((True, 0), (65, True), (65, 16), (-1, 0), (65, 32)):
            with self.assertRaises(Error): keys(keysym, modifiers)
        self.assertEqual(api.calls, [])
        keys(ord('a'), 0)
        errors = []
        def resolve():
            try: keys(ord('c'), 2)
            except Error as error: errors.append(error)
        thread = threading.Thread(target=resolve)
        thread.start(); thread.join(2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(api.calls, [])

    def test_native_errors_are_redacted_and_old_windows_is_refused_before_dll_loading(self):
        keys, api, _ = self.resolver()
        def fail(): raise OSError('private foreground account')
        api.library.GetForegroundWindow = fail
        with self.assertRaises(Error) as caught: keys(0xffe3, 0)
        self.assertNotIn('private', str(caught.exception))
        with patch('canaveral.guest.windows_keys.sys.platform', 'win32'), \
             patch('canaveral.guest.windows_keys.sys.getwindowsversion', create=True,
                   return_value=SimpleNamespace(major=10, build=10240)), \
             patch('canaveral.guest.windows_keys.c.WinDLL', create=True) as load:
            with self.assertRaises(Error) as caught: WindowsKeys(lambda: True)
            self.assertEqual(caught.exception.code, 'capability_unsupported')
            load.assert_not_called()

    def test_complete_native_primitive_chain_posts_retained_shortcut_scans(self):
        keys, api, _ = self.resolver()
        native = DesktopAPI()
        desktop = Win32Desktop(lambda: True, libraries=native.libraries)
        self.addCleanup(desktop.close)
        control = WindowsHeldInput(desktop, keys, lambda state: True, lambda: True)
        control.key(0xffe3, True, native.bounds)
        control.key(ord('c'), True, native.bounds)
        control.key(ord('c'), False, native.bounds)
        control.key(0xffe3, False, native.bounds)
        self.assertEqual([(event.key.scan, event.key.flags) for event in native.sent],
                         [(0x1d, 8), (0x2e, 8), (0x2e, 10), (0x1d, 10)])
        self.assertEqual(native.owned, set())
        self.assertFalse(control.state['blocked'])
        self.assertEqual(len([call for call in api.calls if call[0] == 'character']), 1)

    def test_unmappable_or_reserved_character_states_have_no_scan_fallback(self):
        for mapping in (-1, 0, 255, 0x1041, 0x8041):
            keys, api, _ = self.resolver()
            api.chars['c'] = mapping
            with self.subTest(mapping=mapping), self.assertRaises(Error): keys(ord('c'), 2)
            self.assertFalse(any(call[0] == 'scan' for call in api.calls))
            with self.assertRaises(Error): keys.validation()

    @unittest.skipIf(sys.platform == 'win32', 'Native construction is not part of these isolated fixtures')
    def test_native_constructor_is_unavailable_on_non_windows(self):
        with self.assertRaises(Error): WindowsKeys(lambda: True)


if __name__ == '__main__': unittest.main()
