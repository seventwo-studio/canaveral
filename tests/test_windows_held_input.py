"""Owned held-input state with persistence/native doubles; no keyboard is used."""
import copy
import threading
import unittest

from canaveral.guest.windows_held_input import WindowsHeldInput, validate_state
from canaveral.guest.windows_desktop import INPUT, Win32Desktop
from canaveral.model import Error
from test_windows_desktop import API


class Backend:
    def __init__(self):
        self.batches = []
        self.fail = self.bad_ack = False
        self.hook = lambda: None

    def post(self, events, bounds, cleanup=False):
        self.batches.append(([INPUT.from_buffer_copy(bytes(event)) for event in events], bounds, cleanup))
        self.hook()
        if self.fail: raise Error('private native operation was interrupted', 409, outcome='unknown')
        return {'posted': 1 if self.bad_ack else True}


class WindowsHeldInputTests(unittest.TestCase):
    bounds = (-100, -200, 1000, 800)

    def controller(self, recovered=None, cleanup=None):
        backend, records, allowed, resolutions = Backend(), [], [True], []
        self.fail_save_at = None
        self.save_hook = lambda state: None
        def save(state):
            records.append(copy.deepcopy(state))
            self.save_hook(state)
            return len(records) != self.fail_save_at
        def resolve(keysym, modifiers):
            resolutions.append((keysym, modifiers))
            mapping = {0xffe1: 0xA0, 0xffe2: 0xA1, 0xffe3: 0xA2, 0xffe4: 0xA3}
            return [[mapping.get(keysym, 65+keysym%20), 0, 0]]
        controller = WindowsHeldInput(backend, resolve, save, lambda: allowed[0], cleanup, recovered=recovered)
        return controller, backend, records, allowed, resolutions

    def key(self, controller, keysym, down=True): return controller.key(keysym, down, self.bounds)

    def test_keys_resolve_once_and_repeats_releases_keep_the_original_native_identity(self):
        control, backend, records, _, resolutions = self.controller()
        self.key(control, 65)
        control.resolve = lambda *args: [[99, 0, 0]]
        self.key(control, 65)
        self.key(control, 65, False)
        self.assertEqual(len(resolutions), 1)
        events = [batch[0][0] for batch in backend.batches]
        self.assertEqual([event.key.vk for event in events], [70, 70, 70])
        self.assertEqual([event.key.flags for event in events], [0, 0, 2])
        self.assertTrue(all(records[index]['blocked'] for index in (0, 2, 4)))
        self.assertEqual(control.state['keys'], [])
        self.assertFalse(control.state['blocked'])

    def test_unowned_key_up_never_resolves_posts_or_writes_a_record(self):
        control, backend, records, _, resolutions = self.controller()
        self.assertEqual(self.key(control, 65, False), {'posted': False})
        self.assertEqual((backend.batches, records, resolutions), ([], [], []))

    def test_modifier_sides_are_independent_and_ordinary_reset_releases_come_first(self):
        control, backend, _, _, resolutions = self.controller()
        self.key(control, 0xffe1)
        self.key(control, 0xffe2)
        self.key(control, 0xffe1, False)
        self.assertEqual(control.modifiers, 1)
        self.key(control, 65)
        self.assertEqual(resolutions[-1], (65, 1))
        control.reset()
        events, bounds, cleanup = backend.batches[-1]
        self.assertEqual([event.key.vk for event in events], [70, 0xA1])
        self.assertTrue(all(event.key.flags & 2 for event in events))
        self.assertIsNone(bounds)
        self.assertTrue(cleanup)
        self.assertEqual(control.modifiers, 0)

    def test_pointer_drag_edges_and_wheels_share_the_same_held_state(self):
        control, backend, records, _, _ = self.controller()
        control.pointer(10, 20, 1, self.bounds)
        control.pointer(30, 40, 1, self.bounds)
        control.pointer(30, 40, 0, self.bounds)
        self.assertEqual([[event.mouse.flags for event in batch[0]] for batch in backend.batches],
                         [[0xC001, 2], [0xC001], [0xC001, 4]])
        self.assertEqual(records[0]['buttons'], 1)
        self.assertEqual(records[4]['buttons'], 1)  # A possibly failed release remains in the pending union.
        control.pointer(30, 40, 8|32|128, self.bounds)
        events = backend.batches[-1][0]
        self.assertEqual([(event.mouse.flags, event.mouse.data) for event in events[1:]],
                         [(0x80, 1), (0x800, 120), (0x1000, (-120)&0xFFFFFFFF)])
        self.assertEqual(control.state['buttons'], 128)
        control.reset()
        self.assertEqual([(event.mouse.flags, event.mouse.data) for event in backend.batches[-1][0]], [(0x100, 1)])

    def test_button_swap_failure_retains_both_possible_buttons_until_reset(self):
        control, backend, _, _, _ = self.controller()
        control.pointer(10, 20, 1, self.bounds)
        backend.fail = True
        with self.assertRaises(Error): control.pointer(20, 30, 4, self.bounds)
        self.assertEqual(control.state['buttons'], 5)
        self.assertTrue(control.state['blocked'])
        backend.fail = False
        control.reset()
        self.assertEqual([event.mouse.flags for event in backend.batches[-1][0]], [4, 0x10])

    def test_pending_save_failure_posts_nothing_and_requires_explicit_reset(self):
        control, backend, records, _, _ = self.controller()
        self.fail_save_at = 1
        with self.assertRaises(Error) as caught: self.key(control, 65)
        self.assertIsNone(caught.exception.outcome)
        self.assertEqual(backend.batches, [])
        self.assertTrue(control.state['blocked'])
        with self.assertRaises(Error): self.key(control, 66)
        self.fail_save_at = None
        control.reset()
        self.assertFalse(control.state['blocked'])
        self.assertTrue(records[-1]['keys'] == [])

    def test_post_failure_or_bad_ack_never_replays_and_keeps_release_candidates(self):
        for mode in ('failure', 'bad-ack'):
            control, backend, records, _, _ = self.controller()
            backend.fail, backend.bad_ack = mode == 'failure', mode == 'bad-ack'
            with self.subTest(mode=mode), self.assertRaises(Error) as caught: self.key(control, 65)
            self.assertEqual(caught.exception.outcome, 'unknown')
            self.assertNotIn('private', str(caught.exception))
            self.assertTrue(control.state['blocked'])
            with self.assertRaises(Error): self.key(control, 65)
            self.assertEqual(len(backend.batches), 1)
            self.assertTrue(records[-1]['blocked'])

    def test_final_save_failure_keeps_the_old_and_next_key_union(self):
        control, backend, records, _, _ = self.controller()
        self.key(control, 65)
        self.fail_save_at = 4
        with self.assertRaises(Error) as caught: self.key(control, 65, False)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(len(control.state['keys']), 1)
        self.assertTrue(control.state['blocked'])
        self.assertEqual(records[-1]['keys'], [])
        self.fail_save_at = None
        control.reset()
        self.assertEqual(backend.batches[-1][0][0].key.flags, 2)

    def test_recovered_state_never_posts_presses_and_requires_reset_even_when_neutral(self):
        first, _, _, _, _ = self.controller()
        self.key(first, 65)
        control, backend, _, _, _ = self.controller(recovered=first.state)
        self.assertEqual(backend.batches, [])
        with self.assertRaises(Error): self.key(control, 66)
        control.reset()
        self.assertTrue(all(event.key.flags & 2 for event in backend.batches[-1][0]))
        neutral, backend, records, _, _ = self.controller(recovered=control.state)
        with self.assertRaises(Error): self.key(neutral, 66)
        neutral.reset()
        self.assertEqual(backend.batches, [])
        self.assertFalse(records[-1]['blocked'])

    def test_revocation_after_dispatch_blocks_input_but_explicit_cleanup_can_release(self):
        control, backend, _, allowed, _ = self.controller(cleanup=lambda: True)
        backend.hook = lambda: allowed.__setitem__(0, False)
        with self.assertRaises(Error) as caught: self.key(control, 65)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(caught.exception.status, 410)
        backend.hook = lambda: None
        control.reset()
        allowed[0] = True
        with self.assertRaises(Error): self.key(control, 66)
        self.assertEqual(len(backend.batches), 2)

    def test_default_cleanup_authority_cannot_release_after_revocation(self):
        control, backend, _, allowed, _ = self.controller()
        self.key(control, 65)
        allowed[0] = False
        with self.assertRaises(Error): control.reset()
        self.assertEqual(len(backend.batches), 1)

    def test_text_batches_and_surrogate_pairs_keep_transient_release_evidence(self):
        control, backend, records, _, _ = self.controller()
        control.text('x'*1023+'🚀'+'y'*1024, self.bounds)
        self.assertEqual([len(batch[0]) for batch in backend.batches], [2046, 2048, 4])
        self.assertEqual([event.key.scan for event in backend.batches[1][0][:4]], [0xD83D, 0xD83D, 0xDE80, 0xDE80])
        self.assertTrue(all(record['transient'] for record in records[::2]))
        self.assertTrue(all(not record['transient'] for record in records[1::2]))
        self.assertEqual(control.state['transient'], [])

    def test_text_failure_retains_transient_releases_and_never_resumes_later_batches(self):
        control, backend, _, _, _ = self.controller()
        backend.fail = True
        with self.assertRaises(Error): control.text('🚀'+'x'*2000, self.bounds)
        self.assertEqual(len(backend.batches), 1)
        self.assertTrue(control.state['transient'])
        backend.fail = False
        control.reset()
        self.assertTrue(all(event.key.flags == 6 for event in backend.batches[-1][0]))
        self.assertEqual(control.state['transient'], [])

    def test_bad_input_and_native_aliases_refuse_before_persistence_or_effects(self):
        control, backend, records, _, _ = self.controller()
        for keysym, down in ((True, True), (65, 1), (-1, True)):
            with self.assertRaises(Error): control.key(keysym, down, self.bounds)
        for text in ('\0', '\ud800', 'x'*16001):
            with self.assertRaises(Error): control.text(text, self.bounds)
        for mask in (True, 24, 96, 256):
            with self.assertRaises(Error): control.pointer(0, 0, mask, self.bounds)
        self.assertEqual((backend.batches, records), ([], []))
        self.key(control, 65)
        control.resolve = lambda *args: [[70, 0, 0]]
        before = len(records)
        with self.assertRaises(Error): self.key(control, 66)
        with self.assertRaises(Error): control.text('text', self.bounds)
        self.assertEqual(len(records), before)

    def test_busy_input_does_not_queue_behind_pending_native_effect(self):
        control, backend, _, _, _ = self.controller()
        entered, release = threading.Event(), threading.Event()
        backend.hook = lambda: (entered.set(), release.wait(3))
        errors = []
        def press():
            try: self.key(control, 65)
            except Exception as error: errors.append(error)
        thread = threading.Thread(target=press)
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            with self.assertRaises(Error) as caught: self.key(control, 66)
            self.assertEqual(caught.exception.code, 'input_busy')
        finally:
            release.set(); thread.join(2)
        self.assertEqual(errors, [])

    def test_recovery_validation_and_state_copies_cannot_inject_mutable_native_codes(self):
        control, _, _, _, _ = self.controller()
        self.key(control, 65)
        state = control.state
        state['keys'][0]['codes'][0][0] = 99
        self.assertEqual(control.state['keys'][0]['codes'][0][0], 70)
        malformed = control.state
        malformed['version'] = True
        with self.assertRaises(Error): self.controller(recovered=malformed)
        malformed = control.state
        malformed['keys'][0]['codes'] = [[0, 0xD800, 4]]
        with self.assertRaises(Error): validate_state(malformed)
        malformed['keys'][0]['codes'] = [[0, 0xD800, 4], [0, 0xDC00, 4]]
        validate_state(malformed)

    def test_native_primitive_interoperability_preserves_drag_and_reset_edges(self):
        api, records = API(), []
        backend = Win32Desktop(lambda: True, libraries=api.libraries)
        self.addCleanup(backend.close)
        def save(value): records.append(copy.deepcopy(value)); return True
        control = WindowsHeldInput(backend, lambda key, mods: [[0xA2 if key == 0xffe3 else 65, 0, 0]],
                                   save, lambda: True)
        control.key(0xffe3, True, api.bounds)
        control.key(65, True, api.bounds)
        control.pointer(0, 0, 1, api.bounds)
        control.pointer(3, 2, 1, api.bounds)
        control.reset()
        self.assertEqual([(event.key.vk, event.key.flags) for event in api.sent if event.kind == 1],
                         [(0xA2, 0), (65, 0), (65, 2), (0xA2, 2)])
        self.assertEqual([event.mouse.flags for event in api.sent if event.kind == 0], [0xC001, 2, 0xC001, 4])
        self.assertEqual(api.owned, set())
        self.assertFalse(records[-1]['blocked'])

    def test_native_input_uncertainty_requires_backend_retirement_after_owned_reset(self):
        api = API()
        backend = Win32Desktop(lambda: True, cleanup_authorized=lambda: True, libraries=api.libraries)
        self.addCleanup(backend.close)
        control = WindowsHeldInput(backend, lambda key, mods: [[65, 0, 0]], lambda state: True, lambda: True)
        api.count = 0
        with self.assertRaises(Error): control.key(65, True, api.bounds)
        self.assertTrue(control.state['blocked'])
        api.count = None
        control.reset()
        self.assertFalse(control.state['blocked'])
        self.assertTrue(backend.input_fenced)
        self.assertEqual(api.sent[-1].key.flags, 2)

    def test_revocation_after_pending_persistence_never_posts_press(self):
        control, backend, _, allowed, _ = self.controller(cleanup=lambda: True)
        self.save_hook = lambda state: allowed.__setitem__(0, False)
        with self.assertRaises(Error) as caught: self.key(control, 65)
        self.assertEqual(caught.exception.status, 410)
        self.assertIsNone(caught.exception.outcome)
        self.assertEqual(backend.batches, [])
        self.assertTrue(control.state['blocked'])

    def test_revocation_after_final_persistence_withholds_ack_and_keeps_possible_keys(self):
        control, backend, records, allowed, _ = self.controller(cleanup=lambda: True)
        self.save_hook = lambda state: allowed.__setitem__(0, False) if not state['blocked'] else None
        with self.assertRaises(Error) as caught: self.key(control, 65)
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(caught.exception.status, 410)
        self.assertTrue(control.state['blocked'])
        self.assertEqual(len(control.state['keys']), 1)
        self.assertFalse(records[-1]['blocked'])
        self.assertEqual(len(backend.batches), 1)

    def test_failed_reset_keeps_release_candidates_and_never_sends_press_or_move(self):
        control, backend, _, _, _ = self.controller()
        self.key(control, 65)
        control.pointer(1, 2, 128, self.bounds)
        backend.fail = True
        with self.assertRaises(Error): control.reset()
        self.assertTrue(control.state['blocked'])
        self.assertEqual(control.state['buttons'], 128)
        events, bounds, cleanup = backend.batches[-1]
        self.assertTrue(cleanup)
        self.assertIsNone(bounds)
        self.assertTrue(events[0].key.flags & 2)
        self.assertEqual(events[1].mouse.flags, 0x100)

    def test_resolution_errors_are_redacted_before_journal_or_native_effects(self):
        control, backend, records, _, _ = self.controller()
        def resolve(*args): raise OSError('private foreground account data')
        control.resolve = resolve
        with self.assertRaises(Error) as caught: self.key(control, 65)
        self.assertNotIn('private', str(caught.exception))
        self.assertIsNone(caught.exception.outcome)
        self.assertEqual((backend.batches, records), ([], []))
        self.assertFalse(control.state['blocked'])

    def test_inconsistent_transient_recovery_records_are_rejected(self):
        control, _, _, _, _ = self.controller()
        state = control.state
        state['transient'] = [[0, 65, 4]]
        with self.assertRaises(Error): validate_state(state)
        state['blocked'] = True
        validate_state(state)
        state['buttons'] = 1
        with self.assertRaises(Error): validate_state(state)
        state['buttons'] = 0
        state['keys'] = [{'keysym': 66, 'codes': [[66, 0, 0]]}]
        with self.assertRaises(Error): validate_state(state)

    def test_reset_final_persistence_failure_never_confirms_release(self):
        control, backend, records, _, _ = self.controller()
        control.pointer(1, 2, 1, self.bounds)
        self.fail_save_at = 4
        with self.assertRaises(Error) as caught: control.reset()
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertTrue(control.state['blocked'])
        self.assertEqual(control.state['buttons'], 1)
        self.assertEqual(records[-1]['buttons'], 0)
        self.assertTrue(backend.batches[-1][2])


if __name__ == '__main__': unittest.main()
