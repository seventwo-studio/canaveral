import base64
import unittest
import uuid
from unittest.mock import Mock

from canaveral.guest_chunk_shells import GuestChunkShells
from canaveral.model import Error


class GuestChunkShellsTests(unittest.TestCase):
    def setUp(self): self.session = str(uuid.uuid4())

    def test_open_resize_write_read_and_close_translate_common_controls(self):
        request = Mock(side_effect=[{'session': self.session.upper()}, {'resized': True}, {'written': 3},
            {'session': self.session, 'data': 'YQpi', 'offset': 3, 'truncated': False, 'exited': False, 'exitCode': None}, {'closed': True}])
        adapter = GuestChunkShells(request)
        self.assertEqual(adapter.control('shell-open', {'session': self.session}), {'session': self.session})
        adapter.control('shell-resize', {'session': self.session, 'cols': 120, 'rows': 40})
        self.assertEqual(adapter.control('shell-write', {'session': self.session, 'text': 'a\nb'}), {'written': 3})
        self.assertEqual(adapter.control('shell-read', {'session': self.session, 'offset': 0})['data'], 'YQpi')
        self.assertEqual(adapter.control('shell-close', {'session': self.session}), {'closed': True})
        self.assertEqual(request.call_args_list[0].args, ('/v1/shell/open', {'session': self.session, 'cols': 80, 'rows': 24}))
        self.assertEqual(request.call_args_list[1].args[1], {'session': self.session, 'cols': 120, 'rows': 40})

    def test_binary_output_truncation_and_exit_metadata_are_preserved(self):
        data = bytes(range(256))*256
        request = Mock(return_value={'session': self.session, 'data': base64.b64encode(data).decode(), 'offset': len(data)+100,
                                     'truncated': True, 'exited': True, 'exitCode': 7})
        result = GuestChunkShells(request).control('shell-read', {'session': self.session, 'offset': 0})
        self.assertEqual(base64.b64decode(result['data']), data)
        self.assertEqual((result['truncated'], result['exited'], result['exitCode']), (True, True, 7))

    def test_invalid_dimensions_never_dispatch(self):
        for value in (True, 0, 501, 1.5, None):
            request = Mock()
            with self.subTest(value=value), self.assertRaises(Error):
                GuestChunkShells(request).control('shell-resize', {'session': self.session, 'cols': value, 'rows': 24})
            request.assert_not_called()

    def test_invalid_text_and_wire_envelopes_never_dispatch(self):
        for text in (None, 'nul\0', '\ud800', 'a'*16001, '\U0001f680'*5000, '\n'*9000):
            request = Mock()
            with self.subTest(length=len(text) if text else 0), self.assertRaises(Error):
                GuestChunkShells(request).control('shell-write', {'session': self.session, 'text': text})
            request.assert_not_called()

    def test_unicode_acknowledgement_counts_bytes(self):
        request = Mock(return_value={'written': 4})
        self.assertEqual(GuestChunkShells(request).control('shell-write', {'session': self.session, 'text': '\U0001f680'}), {'written': 4})
        request.return_value = {'written': 1}
        with self.assertRaisesRegex(Error, 'inspect before retrying'):
            GuestChunkShells(request).control('shell-write', {'session': self.session, 'text': '\U0001f680'})
        self.assertEqual(request.call_count, 2)

    def test_lost_open_write_resize_and_close_are_not_retried(self):
        for action, args in [('shell-open', {}), ('shell-write', {'text': 'command\n'}),
                             ('shell-resize', {'cols': 80, 'rows': 24}), ('shell-close', {})]:
            request = Mock(side_effect=Error('Interrupted', 409))
            with self.subTest(action=action), self.assertRaisesRegex(Error, 'Interrupted'):
                GuestChunkShells(request).control(action, {'session': self.session, **args})
            self.assertEqual(request.call_count, 1)

    def test_unknown_action_arguments_session_and_cursor_refused_locally(self):
        for action, args in [('shell', {'argv': ['host-command']}), ('shell-open', {'session': 'bad'}),
                             ('shell-close', {'session': self.session, 'extra': True}),
                             ('shell-read', {'session': self.session, 'offset': True}),
                             ('shell-read', {'session': self.session, 'offset': -1}),
                             ('shell-read', {'session': self.session, 'offset': 2**53})]:
            request = Mock()
            with self.subTest(action=action, args=args), self.assertRaises(Error): GuestChunkShells(request).control(action, args)
            request.assert_not_called()

    def test_wrong_response_identity_is_refused(self):
        for action in ('shell-open', 'shell-read'):
            request = Mock(return_value={'session': str(uuid.uuid4())})
            with self.subTest(action=action), self.assertRaisesRegex(Error, 'identity differs'):
                GuestChunkShells(request).control(action, {'session': self.session})

    def test_malformed_output_never_becomes_a_successful_terminal_read(self):
        original = {'session': self.session, 'data': 'eA==', 'offset': 1, 'truncated': False, 'exited': False, 'exitCode': None}
        changes = [{'data': '!!!!'}, {'data': 'YQ=='*30000}, {'data': base64.b64encode(b'x'*65537).decode()},
                   {'offset': True}, {'offset': -1}, {'offset': 2}, {'offset': 2**53},
                   {'truncated': 1}, {'truncated': True}, {'exited': 1}, {'exitCode': True}, {'exitCode': 2**53}]
        for change in changes:
            request = Mock(return_value={**original, **change})
            with self.subTest(change=str(change)[:100]), self.assertRaises(Error):
                GuestChunkShells(request).control('shell-read', {'session': self.session, 'offset': 0})

    def test_cleanup_and_resize_require_positive_acknowledgement(self):
        for action, args, result in [('shell-close', {}, {'closed': 1}),
                                    ('shell-resize', {'cols': 80, 'rows': 24}, {'resized': 1}),
                                    ('shell-write', {'text': 'x'}, {'written': True})]:
            with self.subTest(action=action), self.assertRaises(Error):
                GuestChunkShells(Mock(return_value=result)).control(action, {'session': self.session, **args})

    def test_nine_distinct_sessions_are_dispatched_without_a_count_cap(self):
        request = Mock(side_effect=lambda route, body: {'session': body['session']})
        adapter = GuestChunkShells(request); sessions = [str(uuid.uuid4()) for _ in range(9)]
        for session in sessions: self.assertEqual(adapter.control('shell-open', {'session': session})['session'], session)
        self.assertEqual(request.call_count, 9)
        self.assertEqual(len({call.args[1]['session'] for call in request.call_args_list}), 9)


if __name__ == '__main__': unittest.main()
