"""Real loopback TLS; synthetic guest responses, never a native guest."""
import http.client
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from canaveral.guest_helper_access import GuestHelperBinding
from canaveral.guest_https import GuestHTTPS
from canaveral.model import Error
from test_session_tls import TLSFixture
import test_guest_helper_access as common


class GuestHTTPSTests(TLSFixture, unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.credential = 'private-guest-credential-' + 'a' * 32
        self.reply = lambda path, body: (200, {}, b'{"ok":true}')
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                fixture.seen.append((self.command, self.path, dict(self.headers), body))
                status, headers, data = fixture.reply(self.path, body)
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                if 'Content-Type' not in headers:
                    self.send_header('Content-Type', 'application/json')
                if 'Content-Length' not in headers and 'Transfer-Encoding' not in headers:
                    self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass

        self.server = self.encrypt(ThreadingHTTPServer(('127.0.0.1', 0), Handler))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.origin = 'https://localhost:' + str(self.server.server_port)
        self.client = GuestHTTPS(self.origin, self.credential, self.certificate)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def test_exact_get_and_post_ignore_proxy_environment(self):
        with patch.dict('os.environ', {'HTTPS_PROXY': 'http://127.0.0.1:1', 'https_proxy': 'http://127.0.0.1:1'}):
            self.assertEqual(self.client('/v1/accessibility', None), {'ok': True})
            self.assertEqual(self.client('/v1/shell/write', {'text': 'héllo\n'}), {'ok': True})
        self.assertEqual([(r[0], r[1]) for r in self.seen],
                         [('GET', '/v1/accessibility'), ('POST', '/v1/shell/write')])
        self.assertEqual(json.loads(self.seen[1][3]), {'text': 'héllo\n'})
        self.assertEqual(self.seen[0][2]['Authorization'], 'Bearer ' + self.credential)
        self.assertTrue(self.client.context.check_hostname)

    def test_untrusted_certificate_and_wrong_hostname_never_dispatch(self):
        for origin, ca in [(self.origin, self.untrusted),
                           (self.origin.replace('localhost', '127.0.0.1'), self.certificate)]:
            with self.subTest(origin=origin), self.assertRaises(Error) as caught:
                GuestHTTPS(origin, self.credential, ca)('/v1/accessibility', None)
            self.assertEqual(caught.exception.code, 'transport_interrupted')
        self.assertEqual(self.seen, [])

    def test_completed_response_closes_socket_before_next_read(self):
        # Reproduce Python 3.12+ read1 behavior on older supported interpreters.
        original = http.client.HTTPResponse.read1
        def read_and_close(response, count):
            chunk = original(response, count)
            if response.length == 0:
                response.close()
            return chunk
        with patch.object(http.client.HTTPResponse, 'read1', read_and_close):
            self.assertEqual(self.client('/v1/accessibility', None), {'ok': True})
            self.assertEqual(self.client('/v1/display/event', {}), {'ok': True})
        self.assertEqual(len(self.seen), 2)

    def test_redirects_never_dispatch_another_request_or_repeat_mutation(self):
        self.reply = lambda path, body: (307, {'Location': self.origin + '/v1/other'}, b'{}')
        with self.assertRaises(Error) as caught:
            self.client('/v1/display/event', {'sequence': 1})
        self.assertEqual(caught.exception.code, 'redirect_refused')
        self.assertEqual(caught.exception.outcome, 'unknown')

        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(self.seen), 1)

    def test_unknown_mutation_outcome_survives_binding_error_redaction(self):
        self.reply = lambda path, body: (200, {}, b'not-json-private-secret')
        binding = GuestHelperBinding(self.client, lambda: True)
        with self.assertRaises(Error) as caught:
            binding.call('/v1/files/upload/finish', {'id': 'opaque'})
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertFalse(caught.exception.retryable)
        self.assertNotIn('secret', str(caught.exception))
        self.assertEqual(len(self.seen), 1)

    def test_typed_pre_effect_refusals_remain_distinct_from_unconfirmed_errors(self):
        for code, expected in [('input_busy', 'input_busy'), ('input_stale', 'input_stale'),
                               ('input_reset_uncertain', 'input_reset_uncertain'),
                               ('capability_unsupported', 'capability_unsupported'),
                               ('private-secret', 'conflict')]:
            self.reply = lambda path, body: (409, {}, json.dumps({'code': code, 'error': 'private-secret'}).encode())
            with self.subTest(code=code), self.assertRaises(Error) as caught:
                self.client('/v1/display/event', {})
            self.assertEqual(caught.exception.code, expected)
            self.assertEqual(caught.exception.outcome, 'unknown' if expected == 'conflict' else None)
            self.assertNotIn('private-secret', str(caught.exception))

    def test_malformed_truncated_and_nonfinite_responses_are_not_acknowledgements(self):
        for headers, data in [({}, b'[]'), ({}, b'{"x":NaN}'), ({}, b'{"x":1e999}'), ({}, b'\xff'),
                              ({'Content-Type': 'text/html'}, b'{}'),
                              ({'Content-Length': '20'}, b'{}'),
                              ({'Content-Length': '-1'}, b'{}'),
                              ({'Content-Encoding': 'gzip'}, b'{}')]:
            self.reply = lambda path, body: (200, headers, data)
            with self.subTest(headers=headers, data=data), self.assertRaises(Error) as caught:
                self.client('/v1/shell/write', {})
            self.assertEqual(caught.exception.outcome, 'unknown')

    def test_chunked_response_and_bounded_envelopes(self):
        self.reply = lambda path, body: (200, {'Transfer-Encoding': 'chunked'}, b'2\r\n{}\r\n0\r\n\r\n')
        self.assertEqual(self.client('/v1/accessibility', None), {})
        self.reply = lambda path, body: (200, {}, b'{"data":"' + b'x' * 150 + b'"}')
        with patch('canaveral.guest_https.MAX_RESPONSE', 100), self.assertRaises(Error) as caught:
            self.client('/v1/accessibility', None)
        self.assertEqual(caught.exception.status, 413)
        count = len(self.seen)
        with patch('canaveral.guest_https.MAX_REQUEST', 10), self.assertRaises(Error):
            self.client('/v1/shell/write', {'text': 'x' * 20})
        self.assertEqual(len(self.seen), count)

    def test_slow_terminal_does_not_serialize_display_or_other_shells(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def reply(path, body):
            if path == '/v1/shell/read':
                entered.set()
                release.wait(3)
            return 200, {}, b'{"ok":true}'
        self.reply = reply
        with ThreadPoolExecutor(max_workers=2) as executor:
            waiting = executor.submit(self.client, '/v1/shell/read', {'session': 'first'})
            self.assertTrue(entered.wait(2))
            try:
                ready = executor.submit(self.client, '/v1/display/frame', None)
                self.assertEqual(ready.result(timeout=2), {'ok': True})
                self.assertFalse(waiting.done())
            finally:
                release.set()
            self.assertEqual(waiting.result(timeout=2), {'ok': True})

    def test_invalid_destination_and_request_never_dispatch(self):
        for origin in ['http://localhost', 'https://user@localhost', 'https://localhost/path',
                       'https://localhost?x', 'https://localhost#x', 'https://localhost:bad',
                       'https://localhost:0']:
            with self.subTest(origin=origin), self.assertRaises(Error):
                GuestHTTPS(origin, self.credential)
        for path, body in [('//elsewhere', None), ('/v1/a?x', None), ('/v1/a#x', None),
                           ('/v1/a', []), ('/v1/a', {'n': float('inf')})]:
            with self.subTest(path=path), self.assertRaises(Error):
                self.client(path, body)
        self.assertEqual(self.seen, [])

    def test_timeout_is_not_retried_and_revoked_acknowledgement_stays_unknown(self):
        entered = threading.Event()
        def slow(path, body):
            entered.wait(.2)
            return 200, {}, b'{}'
        self.reply = slow
        with self.assertRaises(Error) as caught:
            GuestHTTPS(self.origin, self.credential, self.certificate, timeout=.05)('/v1/shell/write', {})
        self.assertEqual(caught.exception.code, 'transport_interrupted')
        self.assertEqual(caught.exception.outcome, 'unknown')
        self.assertEqual(len(self.seen), 1)
        entered.set()
        authorized = [True]
        def revoke(path, body):
            authorized[0] = False
            return 200, {}, b'{}'
        self.reply = revoke
        binding = GuestHelperBinding(self.client, lambda: authorized[0])
        with self.assertRaises(Error) as caught:
            binding.call('/v1/files/upload/finish', {})
        self.assertEqual(caught.exception.status, 410)
        self.assertEqual(caught.exception.outcome, 'unknown')


class GuestHTTPSCommonTests(TLSFixture, common.GuestHelperAccessTests):
    """Run common worker/file/RFB/terminal contracts over actual TLS sockets."""
    def setUp(self):
        common.GuestHelperAccessTests.setUp(self)
        GuestHTTPSTests.setUp(self)
        def dispatch(path, raw):
            try:
                value = common.GuestHelperAccessTests.request(self, path,
                    json.loads(raw) if raw else None)
                return 200, {}, json.dumps(value).encode()
            except Error as error:
                return error.status, {}, json.dumps({'code': error.code}).encode()
        self.reply = dispatch
        self.binding = GuestHelperBinding(self.client, lambda: self.allowed,
                                          lambda: self.cleanup_allowed)
        self.resolve.return_value = self.binding

    stop = GuestHTTPSTests.stop
