"""HTTPS transport for an explicitly supplied native guest assignment binding.

This selects no guest, enrolls no identity and enables no platform admission.
The provider remains responsible for verified endpoint/boot/lease ownership.
"""
import http.client
import json
import math
import re
import ssl
import time
import urllib.parse

from .model import Error


MAX_REQUEST = 1_000_000  # Native HTTP parser's JSON body envelope.
MAX_RESPONSE = 64 * 1048576  # Includes base64 display frames, not whole files.


class GuestHTTPS:
    def __init__(self, origin, credential, ca_file=None, timeout=20):
        if not isinstance(origin, str):
            raise Error('Invalid native guest HTTPS origin.', 400)
        try:
            parsed = urllib.parse.urlsplit(origin)
            port = 443 if parsed.port is None else parsed.port
        except (TypeError, ValueError) as error:
            raise Error('Invalid native guest HTTPS origin.', 400) from error
        if (parsed.scheme != 'https' or not parsed.hostname or not 1 <= port <= 65535 or parsed.username is not None
                or parsed.password is not None or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or '?' in origin or '#' in origin
                or any(character.isspace() or ord(character) < 32 for character in origin)):
            raise Error('Native guest requires an HTTPS origin without credentials or a path.', 400)
        if (not isinstance(credential, str) or not 32 <= len(credential) <= 4096
                or any(not 33 <= ord(character) <= 126 for character in credential)):
            raise Error('Invalid native guest credential.', 400)
        if type(timeout) not in (float, int) or not math.isfinite(timeout) or not 0 < timeout <= 120:
            raise Error('Native guest request timeout must be finite and bounded.', 400)
        try:
            self.context = ssl.create_default_context(cafile=ca_file)
        except (OSError, ValueError, TypeError) as error:
            raise Error('Could not load native guest certificate trust.', 400) from error
        self.host, self.port = parsed.hostname, port
        self.credential, self.timeout = credential, timeout

    def __call__(self, path, body):
        if not isinstance(path, str) or not re.fullmatch(r'/v1/[a-z]+(?:/[a-z]+)*', path):
            raise Error('Invalid native guest protocol path.', 400)
        if body is not None and not isinstance(body, dict):
            raise Error('Native guest requests require a JSON object.', 400)
        try:
            data = None if body is None else json.dumps(body, ensure_ascii=False,
                allow_nan=False, separators=(',', ':')).encode('utf-8')
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            raise Error('Invalid native guest request JSON.', 400) from error
        if data is not None and len(data) > MAX_REQUEST:
            raise Error('Native guest request exceeds its protocol envelope.', 413)
        deadline = time.monotonic() + self.timeout
        connection = http.client.HTTPSConnection(self.host, self.port,
            context=self.context, timeout=self.timeout)
        wire = None
        response = None

        def remaining():
            duration = deadline - time.monotonic()
            if duration <= 0:
                raise TimeoutError()
            if wire is not None:
                wire.settimeout(duration)
            return duration

        def failure(message, status=502, code='response_invalid'):
            return Error(message, status, code=code, retryable=False,
                         outcome='unknown' if data is not None else None)

        try:
            # One connection per call: terminals, frames and transfers never
            # share a blocking reader. No proxy environment, redirects or retries.
            connection.connect()
            wire = connection.sock
            remaining()
            connection.request('GET' if data is None else 'POST', path, body=data,
                headers={'Authorization': 'Bearer ' + self.credential,
                         'Content-Type': 'application/json', 'Accept': 'application/json',
                         'Accept-Encoding': 'identity', 'Connection': 'close'})
            remaining()
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise failure('Native guest redirects are not followed.', code='redirect_refused')
            lengths = response.headers.get_all('Content-Length', [])
            encodings = response.headers.get_all('Transfer-Encoding', [])
            if (len(lengths) > 1 or len(encodings) > 1 or lengths and encodings
                    or encodings and encodings[0].lower() != 'chunked'
                    or response.getheader('Content-Encoding', 'identity').lower() != 'identity'):
                raise failure('Native guest response framing is invalid.')
            length = None
            if lengths:
                if not re.fullmatch(r'[0-9]+', lengths[0]) or len(lengths[0]) > 10:
                    raise failure('Native guest response length is invalid.')
                length = int(lengths[0])
                if length > MAX_RESPONSE:
                    raise failure('Native guest response exceeds its protocol envelope.', 413)
            limit = MAX_RESPONSE if response.status == 200 else 4096
            raw = bytearray()
            # Newer Python versions close the response's socket as soon as
            # read1 consumes its declared length. Do not touch that socket
            # again once the HTTP reader has completed the response.
            while not response.isclosed():
                remaining()
                chunk = response.read1(min(65536, limit + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > limit:
                    raise failure('Native guest response exceeds its protocol envelope.', 413)
            if length is not None and len(raw) != length:
                raise failure('Native guest response was truncated.')
            if response.getheader('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                raise failure('Native guest response is not JSON.')
            def invalid_constant(value):
                raise ValueError('Nonfinite JSON number')
            def finite_float(value):
                number = float(value)
                if not math.isfinite(number):
                    raise ValueError('Nonfinite JSON number')
                return number
            value = json.loads(raw.decode('utf-8'), parse_constant=invalid_constant,
                               parse_float=finite_float)
            if not isinstance(value, dict):
                raise failure('Native guest response is not a JSON object.')
            if response.status != 200:
                code = value.get('code')
                refusal = response.status == 409 and code in (
                    'input_busy', 'input_stale', 'input_reset_uncertain', 'capability_unsupported')
                # Only recognized pre-effect refusals permit safe control retry.
                raise Error('Native guest request was refused.', response.status,
                    code=code if refusal else None, retryable=False,
                    outcome=None if refusal or data is None else 'unknown')
            return value
        except Error:
            raise
        except (OSError, http.client.HTTPException) as error:
            raise failure('Native guest response was not confirmed; inspect before another command.',
                          503, 'transport_interrupted') from error
        except (ValueError, UnicodeError, RecursionError) as error:
            raise failure('Native guest response JSON is invalid.') from error
        finally:
            if response is not None:
                response.close()
            connection.close()
