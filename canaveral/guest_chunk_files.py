"""Internal bounded file adapter for the native guest helper.

The owning provider must supply an authenticated, assignment-bound request
transport. This module chooses no destination or credentials and enables no
platform or lease admission.
"""
import base64
import hashlib
import uuid

from .model import Error
from .transfers import Download

CHUNK = 524288
MAX_INTEGER = 9007199254740991


def _integer(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


class GuestChunkFiles:
    def __init__(self, request):
        self.request = request

    def _call(self, route, values, transfer=None):
        result = self.request('/v1/files/' + route, values)
        if not isinstance(result, dict):
            raise Error('Guest file response is malformed.', 409)
        if transfer is not None:
            try: matching = uuid.UUID(result.get('id')) == uuid.UUID(transfer)
            except (ValueError, TypeError, AttributeError): matching = False
            if not matching: raise Error('Guest transfer response identity differs.', 409)
        return result

    def list(self, path):
        return self._call('list', {'path': path})

    def upload(self, path, reader, size, authorized=lambda: True):
        if not _integer(size): raise Error('Invalid guest upload length.', 400)
        transfer = str(uuid.uuid4())
        offset, digest, started = 0, hashlib.sha256(), False

        def call(route, values):
            if not authorized(): raise Error('Guest upload authorization ended; inspect before retrying publication.', 401)
            result = self._call(route, {'id': transfer, **values}, transfer)
            if not authorized(): raise Error('Guest upload authorization ended before acknowledgement; publication may have occurred.', 401)
            return result

        try:
            started = True  # Even a lost begin response may have created staging.
            result = call('upload/begin', {'path': path, 'size': size})
            if result.get('state') != 'receiving' or type(result.get('bytes')) is not int or result.get('bytes') != size:
                raise Error('Guest upload did not enter a fresh receiving state.', 409)
            while offset < size:
                data = reader.read(min(CHUNK, size-offset))
                if not isinstance(data, bytes) or not data or len(data) > min(CHUNK, size-offset):
                    raise Error('Guest upload source ended early or exceeded its declared length.', 400)
                if not authorized(): raise Error('Guest upload authorization ended during read.', 401)
                result = call('upload/chunk', {'offset': offset, 'data': base64.b64encode(data).decode('ascii')})
                if type(result.get('offset')) is not int or result['offset'] != offset+len(data):
                    raise Error('Guest upload cursor differs; input will not be replayed.', 409)
                offset += len(data); digest.update(data)
            result = call('upload/finish', {'bytes': size, 'sha256': digest.hexdigest()})
            verified = 0
            while result.get('state') == 'verifyingUpload':
                current = result.get('verified')
                if not _integer(current) or not verified < current < size or current-verified > CHUNK:
                    raise Error('Guest upload verification cursor differs.', 409)
                verified = current
                result = call('upload/verify', {})
            if (result.get('state') != 'committed' or result.get('durable') is not True
                    or type(result.get('bytes')) is not int or result['bytes'] != size
                    or result.get('sha256') != digest.hexdigest()):
                raise Error('Guest upload durable digest was not confirmed; inspect before retrying.', 409)
            return {'uploaded': size, 'durable': True}
        except BaseException:
            # Abort never removes a published destination; the helper refuses an
            # uncertain publication. Cleanup failures cannot mask the first error.
            if started and authorized():
                try: self._call('abort', {'id': transfer}, transfer)
                except Exception: pass
            raise

    def download(self, path, authorized=lambda: True):
        reader = _GuestDownload(self, path, authorized)
        return Download(reader, reader.size, verify=reader.verify)


class _GuestDownload:
    def __init__(self, owner, path, authorized):
        self.owner, self.authorized = owner, authorized
        self.id, self.offset, self.closed, self.completed = str(uuid.uuid4()), 0, False, False
        self.buffer, self.digest = b'', hashlib.sha256()
        self.size = None
        try:
            result = self.call('download/begin', path=path)
            self.size = result.get('bytes')
            if result.get('state') != 'reading' or not _integer(self.size):
                raise Error('Guest download metadata is invalid.', 409)
        except BaseException:
            self.close(); raise

    def call(self, route, **values):
        if self.closed or not self.authorized(): raise Error('Guest download authorization ended.', 401)
        result = self.owner._call(route, {'id': self.id, **values}, self.id)
        if not self.authorized(): raise Error('Guest download authorization ended before acknowledgement.', 401)
        return result

    def read(self, size):
        if type(size) is not int or size < 0: raise Error('Use a bounded guest download read.', 400)
        if not size: return b''
        if self.closed or not self.authorized(): raise Error('Guest download authorization ended.', 401)
        if not self.buffer and self.offset < self.size:
            result = self.call('download/chunk', offset=self.offset)
            encoded = result.get('data')
            try:
                if not isinstance(encoded, str) or len(encoded) > 700000: raise ValueError()
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError): raise Error('Guest download chunk is malformed.', 409)
            expected = min(CHUNK, self.size-self.offset)
            if (len(data) != expected or type(result.get('offset')) is not int
                    or result['offset'] != self.offset+expected):
                raise Error('Guest download cursor or length differs.', 409)
            self.offset += len(data); self.digest.update(data); self.buffer = data
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result

    def verify(self):
        if self.completed:
            if self.closed or not self.authorized(): raise Error('Guest download authorization ended.', 401)
            return True
        if self.offset != self.size or self.buffer:
            result = self.call('download/check')
            if result.get('state') != 'reading' or type(result.get('bytes')) is not int or result.get('bytes') != self.size:
                raise Error('Guest download source could not be verified.', 409)
            return True
        result, verified = self.call('download/finish'), 0
        while result.get('state') == 'verifying':
            current = result.get('verified')
            if not _integer(current) or not verified < current < self.size or current-verified > CHUNK:
                raise Error('Guest download verification cursor differs.', 409)
            verified = current
            result = self.call('download/verify')
        if (result.get('state') != 'verified' or type(result.get('bytes')) is not int
                or result['bytes'] != self.size or result.get('sha256') != self.digest.hexdigest()):
            raise Error('Guest download digest was not confirmed.', 409)
        self.completed = True
        return True

    def close(self):
        if self.closed: return
        self.closed = True
        self.buffer = b''
        # No reads or retries after revocation. Lease cleanup still owns any
        # helper transfer whose explicit abort cannot be confirmed here.
        if not self.completed and self.authorized():
            try: self.owner._call('abort', {'id': self.id}, self.id)
            except Exception: pass
