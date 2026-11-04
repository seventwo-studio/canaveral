"""Exclusive native staging and same-directory publication; no durable receipt.

This component must run in the assigned Windows guest under supervision. It
creates only its own fresh temporary object. Publication renames its retained
handle once; cleanup never deletes a potentially published object. Common
upload routes and durable recovery remain gated outside this module.
"""
from contextlib import contextmanager
import ctypes as c
import hashlib
import re
import threading
import uuid

from canaveral.guest_chunk_files import CHUNK, MAX_INTEGER
from canaveral.model import Error
from .windows_file_handles import Win32Files, component, H, U32, UNICODE_STRING, OBJECT_ATTRIBUTES, IO_STATUS_BLOCK


class FILE_RENAME_INFORMATION(c.Structure):
    _fields_ = [('ReplaceIfExists', U32), ('RootDirectory', H),
               ('FileNameLength', U32), ('FileName', c.c_uint16*1)]


class Win32Staging(Win32Files):
    def __init__(self):
        super().__init__()
        self.k.WriteFile.argtypes = [H, H, U32, c.POINTER(U32), H]
        self.k.WriteFile.restype = c.c_int32
        self.k.FlushFileBuffers.argtypes = [H]
        self.k.FlushFileBuffers.restype = c.c_int32
        self.nt.NtSetInformationFile.argtypes = [H, c.POINTER(IO_STATUS_BLOCK), H, U32, c.c_int32]
        self.nt.NtSetInformationFile.restype = c.c_int32

    def create(self, parent, name):
        encoded = component(name)
        raw = c.create_string_buffer(encoded)
        string = UNICODE_STRING(len(encoded), len(encoded), c.cast(raw, H))
        attributes = OBJECT_ATTRIBUTES(c.sizeof(OBJECT_ATTRIBUTES), parent, c.pointer(string), 0x40, None, None)
        handle, status = H(), IO_STATUS_BLOCK()
        # Generic read/write, DELETE and SYNCHRONIZE; no sharing or inheritance.
        # FILE_CREATE never adopts/truncates an existing object. No preallocation.
        code = self.nt.NtCreateFile(c.byref(handle), 0xC0110000, c.byref(attributes),
            c.byref(status), None, 0x80, 0, 2, 0x200062, None, 0)
        if code < 0 or not handle.value: raise OSError('Exclusive Windows stage creation failed')
        return handle.value

    def write(self, handle, offset, data):
        self.check(self.k.SetFilePointerEx(handle, offset, None, 0))
        raw, count = c.create_string_buffer(data), U32()
        self.check(self.k.WriteFile(handle, raw, len(data), c.byref(count), None))
        return count.value

    def flush(self, handle):
        self.check(self.k.FlushFileBuffers(handle))

    def discard(self, handle):
        delete, status = c.c_ubyte(1), IO_STATUS_BLOCK()
        code = self.nt.NtSetInformationFile(handle, c.byref(status), c.byref(delete), 1, 13)
        if code < 0: raise OSError('Owned Windows stage deletion was refused')

    def publish(self, handle, name):
        encoded = component(name)
        offset = FILE_RENAME_INFORMATION.FileName.offset
        raw = c.create_string_buffer(max(c.sizeof(FILE_RENAME_INFORMATION), offset+len(encoded)))
        info = FILE_RENAME_INFORMATION.from_buffer(raw)
        info.ReplaceIfExists, info.RootDirectory, info.FileNameLength = 1, None, len(encoded)
        c.memmove(c.addressof(raw)+offset, encoded, len(encoded))
        status = IO_STATUS_BLOCK()
        # A simple name and NULL RootDirectory rename this retained file in its
        # existing directory. No source reopen, absolute path or copy fallback.
        code = self.nt.NtSetInformationFile(handle, c.byref(status), raw, len(raw), 10)
        if code < 0: raise OSError('Windows relative publication was refused')
        return True


class WindowsStage:
    def __init__(self, root, size, authorized):
        self.root, self.size, self.authorized = root, size, authorized
        self.name = '.canaveral-upload-'+uuid.uuid4().hex
        self.io = threading.Lock()
        self.handles, self.parents = [], []
        self.handle = self.identity = None
        self.offset = self.verified = 0
        self.first, self.second = hashlib.sha256(), hashlib.sha256()
        self.expected = None
        self.state = 'opening'
        self.fenced = self.closed = self.delete_marked = False
        self.publication_attempted = self.publication_known = False
        self.destination = None

    @classmethod
    def create(cls, root, parent_parts, size, authorized):
        if type(size) is not int or not 0 <= size <= MAX_INTEGER or not callable(authorized):
            raise Error('A Windows stage requires an exact length and authorization.', 400)
        if not isinstance(parent_parts, (list, tuple)):
            raise Error('Use relative Windows parent components.', 400)
        if sum(len(component(name))+2 for name in parent_parts) > 65532:
            raise Error('Windows parent metadata exceeds its envelope.', 400)
        if any(not callable(getattr(root.api, method, None)) for method in ('create', 'write', 'flush', 'discard')):
            raise Error('Windows staging is unavailable for this file binding.', 409, code='capability_unsupported')
        with root.lock:
            if root.fenced or not root.handles: raise Error('Windows staging root is fenced.', 410)
            stage = cls(root, size, authorized)
            stage.io.acquire()
            root.pins.add(stage)  # Own opens and cleanup before dispatching them.
            parent = root.handles[-1]
        try:
            stage._authorize()
            info = root.api.info(parent)
            stage.parents.append((parent, stage._directory(info)))
            if stage.parents[0][1] != stage._directory(root.identity):
                raise Error('Windows staging root identity changed.', 409)
            for name in parent_parts:
                stage._authorize()
                parent = root.api.open(parent, name, True)
                stage.handles.append(parent)
                info = root.api.info(parent)
                if info['volume'] != root.identity['volume']:
                    raise Error('Windows stage parent crossed its volume.', 409)
                stage.parents.append((parent, stage._directory(info)))
            stage._guard()
            stage.handle = root.api.create(parent, stage.name)
            stage.handles.append(stage.handle)
            stage.identity = root.api.info(stage.handle)
            stage._regular(stage.identity, 0)
            stage._guard()
            stage.state = 'receiving'
            stage.io.release()
            return stage
        except Exception as error:
            stage.state, stage.fenced = 'failed', True
            stage.io.release()
            confirmed = stage.close()
            raise Error('Windows stage setup failed.', 410 if isinstance(error, Error) and error.status == 410 else 409, retryable=False,
                        outcome=None if confirmed else 'unknown') from error

    @staticmethod
    def _directory(info):
        if not info['directory'] or info['attributes'] & 0x400:
            raise Error('Windows stage parent is not a regular directory.', 409)
        # Creating a child changes directory times/size. Pin object identity,
        # volume and non-reparse type instead of those mutable namespace fields.
        return info['volume'], info['fileId'], info['directory'], info['attributes']

    def _regular(self, info, size):
        if (info['directory'] or info['attributes'] & 0x400 or info['links'] != 1
                or info['volume'] != self.root.identity['volume'] or info['size'] != size):
            raise Error('Windows staging object identity or length differs.', 409)
        if self.identity is not None and (info['volume'], info['fileId']) != (self.identity['volume'], self.identity['fileId']):
            raise Error('Windows staging object changed.', 409)

    def _authorize(self):
        try: allowed = bool(self.authorized())
        except Exception: allowed = False
        if self.fenced or self.closed or self.root.fenced or not allowed:
            self.fenced = True
            raise Error('Windows staging authorization ended.', 410, retryable=False)

    def _guard(self):
        self._authorize()
        for handle, identity in self.parents:
            if self._directory(self.root.api.info(handle)) != identity:
                raise Error('Pinned Windows stage parent changed.', 409)
        if self.handle is not None and self.root.api.info(self.handle) != self.identity:
            raise Error('Pinned Windows stage data or metadata changed.', 409)
        self._authorize()

    @contextmanager
    def _work(self, mutation=None):
        if not self.io.acquire(blocking=False):
            raise Error('Windows staging is busy.', 409, code='input_busy', retryable=False)
        try:
            self._guard()
            yield
            self._guard()
        except Error as error:
            self.state, self.fenced = 'failed', True
            if mutation is not None and mutation():
                raise Error('Windows stage write acknowledgement was not confirmed.', error.status,
                            code=error.code, retryable=False, outcome='unknown') from error
            raise
        except Exception as error:
            self.state, self.fenced = 'failed', True
            raise Error('Windows staging operation was not confirmed.', 409,
                        retryable=False, outcome='unknown') from error
        finally:
            self.io.release()

    def write(self, offset, data):
        if (type(offset) is not int or offset != self.offset or self.state != 'receiving'
                or not isinstance(data, bytes) or not 0 < len(data) <= CHUNK
                or self.offset+len(data) > self.size):
            raise Error('Invalid Windows stage cursor, phase or chunk.', 409)
        dispatched = False
        with self._work(mutation=lambda: dispatched):
            # Recheck after acquiring the lane; a concurrent call may have
            # completed between pre-effect validation and lock acquisition.
            if offset != self.offset or self.state != 'receiving':
                raise Error('Windows stage cursor changed before dispatch.', 409)
            written = 0
            while written < len(data):
                self._authorize()
                dispatched = True
                count = self.root.api.write(self.handle, offset+written, data[written:])
                if type(count) is not int or not 0 < count <= len(data)-written:
                    raise Error('Windows stage write length was not confirmed.', 409, outcome='unknown')
                written += count
            info = self.root.api.info(self.handle)
            self._regular(info, offset+written)
            self.identity = info
            self.first.update(data)
            self.offset += written
        return {'offset': self.offset}

    def finish(self, sha256):
        if (not isinstance(sha256, str) or re.fullmatch('[a-f0-9]{64}', sha256) is None
                or self.state != 'receiving' or self.offset != self.size
                or sha256 != self.first.hexdigest()):
            raise Error('Windows stage length or expected digest differs.', 409)
        with self._work():
            if self.state != 'receiving': raise Error('Windows stage already finished.', 409)
            self.root.api.flush(self.handle)
            info = self.root.api.info(self.handle)
            self._regular(info, self.size)
            self.identity = info
            self.expected, self.state = sha256, 'verifying'
        return self.verify()

    def verify(self):
        if self.state not in ('verifying', 'ready'):
            raise Error('Windows stage is not ready for verification.', 409)
        with self._work():
            if self.state == 'verifying':
                count = min(CHUNK, self.size-self.verified)
                data = self.root.api.read(self.handle, self.verified, count) if count else b''
                if not isinstance(data, bytes) or len(data) != count:
                    raise Error('Windows stage ended during verification.', 409)
                self.second.update(data)
                self.verified += count
                if self.verified == self.size:
                    if self.second.hexdigest() != self.expected:
                        raise Error('Windows staged bytes differ from the upload digest.', 409)
                    self.state = 'ready'
            result = {'state': self.state, 'bytes': self.size, 'verified': self.verified,
                      'durable': False}
            if self.state == 'ready': result['sha256'] = self.expected
        # Ready means verified staging only. Publication is a separate step;
        # neither method supplies a committed/durable upload receipt.
        return result

    def publish(self, name):
        component(name)
        if name.casefold() == self.name.casefold():
            raise Error('A stage cannot publish over its temporary name.', 400)
        if not callable(getattr(self.root.api, 'publish', None)):
            raise Error('Windows publication is unavailable for this binding.', 409, code='capability_unsupported')
        if not self.io.acquire(blocking=False):
            raise Error('Windows staging is busy.', 409, code='input_busy', retryable=False)
        dispatched = False
        try:
            if self.publication_attempted or self.state != 'ready':
                raise Error('Windows stage publication cannot restart or replay.', 409)
            self._guard()
            self.destination = name
            self.state = 'publishing'
            # This flag is set before the native dispatch point. Even an
            # exception/lost result must not lead close() to unlink this handle.
            self.publication_attempted = True
            dispatched = True
            if self.root.api.publish(self.handle, name) is not True:
                raise Error('Windows publication was not confirmed.', 409, outcome='unknown')
            self.publication_known = True
            info = self.root.api.info(self.handle)
            self._regular(info, self.size)
            self.identity = info
            self.root.api.flush(self.handle)
            info = self.root.api.info(self.handle)
            self._regular(info, self.size)
            self.identity = info
            self._guard()
            self.state = 'published'
            return {'state': 'published', 'destination': name, 'bytes': self.size,
                    'sha256': self.expected, 'durable': False}
        except Exception as error:
            if dispatched:
                self.state, self.fenced = 'publicationUnknown', True
                raise Error('Windows publication acknowledgement is unconfirmed; reconcile before retrying.',
                    410 if isinstance(error, Error) and error.status == 410 else 409,
                    retryable=False, outcome='unknown') from error
            if not isinstance(error, Error):
                raise Error('Windows publication validation was not confirmed.', 409,
                            retryable=False) from error
            raise
        finally:
            self.io.release()

    def close(self):
        self.fenced = True
        if not self.io.acquire(blocking=False): return False
        try:
            if self.publication_attempted and not self.publication_known:
                return False  # Native outcome needs reconciliation, not deletion.
            if self.handle is not None and not self.delete_marked and not self.publication_attempted:
                try: self.root.api.discard(self.handle)
                except Exception: return False
                self.delete_marked = True
            while self.handles:
                handle = self.handles[-1]
                try: self.root.api.close(handle)
                except Exception: return False
                self.handles.pop()
                if handle == self.handle: self.handle = None
            self.closed = True
            if not self.publication_attempted: self.state = 'discarded'
            with self.root.lock: self.root.pins.discard(self)
            return True
        finally:
            self.io.release()
