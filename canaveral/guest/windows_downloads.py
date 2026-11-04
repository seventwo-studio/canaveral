"""Live-worker Windows read transactions over the common guest file protocol.

Records and handles are volatile. No restart reopens a file or resumes a cursor.
Guest service/worker generation binding and durable recovery remain external
integration gates. This component implements no upload/publication operation.
"""
import base64
from dataclasses import dataclass, field
import hashlib
import json
import threading
import uuid

from canaveral.guest_chunk_files import CHUNK, MAX_INTEGER
from canaveral.model import Error


def validate_request(path, body):
    """Validate control metadata before launching or dispatching native work."""
    routes = {'list': {'path'}, 'download/begin': {'id', 'path'},
        'download/chunk': {'id', 'offset'}, 'download/check': {'id'},
        'download/finish': {'id'}, 'download/verify': {'id'}, 'status': {'id'}, 'abort': {'id'}}
    route = path.removeprefix('/v1/files/') if isinstance(path, str) and path.startswith('/v1/files/') else None
    if route not in routes:
        raise Error('Windows file operation is unsupported.', 409, code='capability_unsupported')
    if not isinstance(body, dict) or set(body) != routes[route]:
        raise Error('Invalid Windows file operation fields.', 400)
    try:
        encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(encoded) > 1_000_000: raise ValueError()
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise Error('Windows file control envelope is invalid.', 400) from None
    if route in ('list', 'download/begin'):
        if not isinstance(body['path'], str) or not body['path'] or '\0' in body['path']:
            raise Error('Invalid guest file path.', 400)
    identity = None
    if route != 'list':
        try: identity = str(uuid.UUID(body['id']))
        except (ValueError, TypeError, AttributeError): raise Error('Transfer requires a UUID.', 400)
    if route == 'download/chunk' and (type(body['offset']) is not int or not 0 <= body['offset'] <= MAX_INTEGER):
        raise Error('Invalid Windows download cursor.', 400)
    return route, identity


@dataclass
class Transfer:
    identity: str
    path: str
    lock: object = field(default_factory=threading.Lock)
    state: str = 'opening'
    pin: object = None
    size: int = 0
    offset: int = 0
    verified: int = 0
    digest: object = field(default_factory=hashlib.sha256)
    second: object = field(default_factory=hashlib.sha256)
    sha256: str = None
    cleanup_pending: bool = False
    orphaned_open: bool = False


class WindowsDownloads:
    def __init__(self, root, resolve, authorized, cleanup_authorized=None):
        if not callable(resolve) or not callable(authorized) or (cleanup_authorized is not None and not callable(cleanup_authorized)):
            raise Error('Windows files require explicit path and authorization bindings.', 400)
        self.root, self.resolve, self.authorized = root, resolve, authorized
        self.cleanup_authorized = authorized if cleanup_authorized is None else cleanup_authorized
        self.records, self.lock, self.fenced = {}, threading.RLock(), False

    @staticmethod
    def _allowed(predicate):
        try: return bool(predicate())
        except Exception: return False

    def _authorize(self, cleanup=False):
        active = self._allowed(self.authorized)
        if not active: self.fenced = True
        allowed = self._allowed(self.cleanup_authorized) if cleanup else active and not self.fenced
        if not allowed: raise Error('Windows file authorization ended.', 410, retryable=False)

    @staticmethod
    def _status(record):
        result = {'id': record.identity, 'state': record.state, 'bytes': record.size,
                  'offset': record.offset, 'cleanupPending': record.cleanup_pending or record.orphaned_open}
        if record.state in ('verifying', 'cleanupPending'): result['verified'] = record.verified
        if record.state == 'verified': result['sha256'] = record.sha256
        return result

    def _receipt(self, record):
        self._authorize()
        result = self._status(record)
        self._authorize()
        return result

    def __call__(self, path, body):
        route, identity = validate_request(path, body)
        cleanup = route == 'abort'
        self._authorize(cleanup)
        if route == 'list':
            result = {**self.root.list(self.resolve(body['path'])), 'path': body['path']}
            self._authorize()
            return result
        with self.lock:
            record = self.records.get(identity)
            if record is None:
                if route != 'download/begin': raise Error('Windows transfer is unknown; it cannot resume.', 404)
                record = Transfer(identity, body['path'])
                record.lock.acquire()
                self.records[identity] = record  # Reserve before resolver/native open.
                fresh = True
            else:
                if not record.lock.acquire(blocking=False):
                    raise Error('Windows transfer is busy.', 409, code='input_busy', retryable=False)
                fresh = False
        source_attempted = False
        try:
            if route == 'download/begin':
                if record.path != body['path']:
                    raise Error('Transfer identity is already bound to another path.', 409)
                if fresh:
                    self._begin(record)
                return self._receipt(record)
            if route == 'status': return self._receipt(record)
            if route == 'abort': return self._abort(record)
            if record.state in ('failed', 'aborted', 'opening'):
                raise Error('Windows transfer ended or cannot resume.', 409)
            if route == 'download/check':
                if record.state != 'reading': raise Error('Download is no longer reading.', 409)
                source_attempted = True
                record.pin.check()
            elif route == 'download/chunk':
                if record.state != 'reading' or body['offset'] != record.offset:
                    raise Error('Windows download cursor differs; data is not replayed.', 409)
                count = min(CHUNK, record.size-record.offset)
                source_attempted = True
                data = record.pin.read(record.offset, count)
                if len(data) != count: raise Error('Windows source ended before its declared length.', 409)
                self._authorize()
                record.digest.update(data)
                record.offset += len(data)
                result = {'id': identity, 'offset': record.offset, 'data': base64.b64encode(data).decode('ascii')}
                self._authorize()
                return result
            elif route == 'download/finish':
                if record.state == 'reading':
                    if record.offset != record.size: raise Error('Windows download is incomplete.', 409)
                    record.state = 'verifying'
                    return self._verify(record)
                # A repeated finish observes its existing step/receipt. It does
                # not reopen the file or silently advance another hash step.
            elif route == 'download/verify':
                if record.state not in ('verifying', 'cleanupPending', 'verified'):
                    raise Error('Windows download verification has not started.', 409)
                return self._verify(record)
            self._authorize()
            return self._receipt(record)
        except Error as error:
            if error.code != 'input_busy' and route not in ('status', 'abort'):
                # Wrong cursor/path/phase is a confirmed pre-effect refusal;
                # keep the original transfer available for inspection/abort.
                if error.status == 410 or source_attempted:
                    self._fail(record)
            raise
        except Exception as error:
            self._fail(record)
            raise Error('Windows download response was not confirmed.', 409, retryable=False) from error
        finally:
            record.lock.release()

    def _begin(self, record):
        try:
            parts = self.resolve(record.path)
            self._authorize()
            record.pin = self.root.pin(parts)
            size = record.pin.identity['size']
            if type(size) is not int or not 0 <= size <= MAX_INTEGER:
                raise Error('Windows file length exceeds the exact protocol integer range.', 409)
            record.size = size
            record.pin.check()
            self._authorize()
            record.state = 'reading'
        except Exception as error:
            record.orphaned_open = record.pin is None and isinstance(error, Error) and error.outcome == 'unknown'
            self._fail(record)
            raise

    def _verify(self, record):
        if record.state == 'verified': return self._receipt(record)
        try:
            if record.state == 'verifying':
                count = min(CHUNK, record.size-record.verified)
                data = record.pin.read(record.verified, count)
                if len(data) != count: raise Error('Windows source changed during verification.', 409)
                self._authorize()
                record.second.update(data)
                record.verified += count
                if record.verified < record.size: return self._receipt(record)
                record.pin.check()
                if record.second.digest() != record.digest.digest():
                    raise Error('Windows download digest changed; completion is refused.', 409)
                record.sha256 = record.digest.hexdigest()
                record.state = 'cleanupPending'
            self._authorize()
            if not record.pin.close():
                record.cleanup_pending = True
                raise Error('Windows download handle cleanup is unconfirmed.', 409,
                            code='file_cleanup_uncertain', retryable=False)
            record.pin = None
            record.cleanup_pending = False
            self._authorize()
            record.state = 'verified'
            return self._receipt(record)
        except Error as error:
            if record.state != 'cleanupPending' or error.status == 410: self._fail(record)
            raise
        except Exception:
            self._fail(record)
            raise

    def _fail(self, record):
        record.state = 'failed'
        if record.pin is not None:
            record.cleanup_pending = not record.pin.close()
            if not record.cleanup_pending: record.pin = None

    def _abort(self, record):
        if record.orphaned_open:
            raise Error('Failed open cleanup requires confirmed root shutdown.', 409,
                        code='file_cleanup_uncertain', retryable=False)
        if record.pin is not None:
            if not record.pin.close():
                record.cleanup_pending = True
                raise Error('Windows transfer abort cleanup is unconfirmed.', 409,
                            code='file_cleanup_uncertain', retryable=False)
            record.pin = None
        record.cleanup_pending = False
        record.state = 'aborted'
        self._authorize(cleanup=True)
        return {'id': record.identity, 'state': 'aborted', 'bytes': 0}

    def close(self):
        self.fenced = True
        confirmed = self.root.close()
        if confirmed:
            with self.lock:
                for record in self.records.values():
                    record.orphaned_open = record.cleanup_pending = False
        return confirmed
