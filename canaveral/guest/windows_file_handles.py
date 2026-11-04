"""Pinned Windows guest file objects; no listener, enrollment or path fallback.

Callers provide the approved guest root and relative filename components.
Native filesystem calls need a supervised guest worker; this module alone
provides neither upload durability nor platform/lease admission.
"""
import ctypes as c
import json
import struct
import sys
import threading
import time

from canaveral.model import Error

U32, U16, U64, I64, H, SIZE = c.c_uint32, c.c_uint16, c.c_uint64, c.c_int64, c.c_void_p, c.c_size_t
CHUNK = 524288


class UNICODE_STRING(c.Structure):
    _fields_ = [('Length', U16), ('MaximumLength', U16), ('Buffer', H)]


class OBJECT_ATTRIBUTES(c.Structure):
    _fields_ = [('Length', U32), ('RootDirectory', H), ('ObjectName', c.POINTER(UNICODE_STRING)),
               ('Attributes', U32), ('SecurityDescriptor', H), ('SecurityQualityOfService', H)]


class IO_STATUS_BLOCK(c.Structure):
    _fields_ = [('Status', H), ('Information', SIZE)]


class FILE_ID_INFO(c.Structure):
    _fields_ = [('VolumeSerialNumber', U64), ('FileId', c.c_ubyte*16)]


class FILE_BASIC_INFO(c.Structure):
    _fields_ = [('CreationTime', I64), ('LastAccessTime', I64), ('LastWriteTime', I64),
               ('ChangeTime', I64), ('FileAttributes', U32)]


class FILE_STANDARD_INFO(c.Structure):
    _fields_ = [('AllocationSize', I64), ('EndOfFile', I64), ('NumberOfLinks', U32),
               ('DeletePending', c.c_ubyte), ('Directory', c.c_ubyte)]


def component(name):
    if (not isinstance(name, str) or not name or name in ('.', '..')
            or any(ch in name for ch in ('\\', '/', ':', '\0'))
            or name[-1] in (' ', '.') or any(ord(ch) < 32 for ch in name)):
        raise Error('Use unambiguous relative Windows filename components.', 400)
    try: encoded = name.encode('utf-16-le')
    except UnicodeError: raise Error('Invalid Windows filename Unicode.', 400) from None
    if len(encoded) > 65532: raise Error('Windows filename exceeds its native envelope.', 400)
    return encoded


def directory_records(raw):
    """FILE_ID_EXTD_DIR_INFO records; fixed Win32 widths, not host wchar size."""
    offset = 0
    while True:
        if len(raw)-offset < 88: raise ValueError('Truncated Windows directory record')
        next_offset, = struct.unpack_from('<I', raw, offset)
        attributes, name_bytes, _, reparse = struct.unpack_from('<IIII', raw, offset+56)
        if (not name_bytes or name_bytes % 2 or name_bytes > len(raw)-offset-88
                or next_offset and (next_offset % 8 or next_offset < 88+name_bytes
                                    or next_offset > len(raw)-offset)):
            raise ValueError('Invalid Windows directory record')
        name = raw[offset+88:offset+88+name_bytes].decode('utf-16-le')
        size, = struct.unpack_from('<q', raw, offset+40)
        written, = struct.unpack_from('<q', raw, offset+24)
        if size < 0 or '\0' in name: raise ValueError('Invalid Windows directory metadata')
        if name not in ('.', '..'):
            yield {'name': name, 'kind': 'symlink' if attributes & 0x400 else
                'directory' if attributes & 0x10 else 'file', 'size': size,
                'modifiedAt': written/10000000-11644473600,
                'attributes': attributes, 'reparseTag': reparse,
                'nativeFileId': raw[offset+72:offset+88].hex()}
        if not next_offset: return
        offset += next_offset


class Win32Files:
    def __init__(self):
        if sys.platform != 'win32' or c.sizeof(H) != 8:
            raise Error('Native file access requires a 64-bit Windows guest worker.', 409,
                        code='capability_unsupported')
        self.k, self.nt = c.WinDLL('kernel32', use_last_error=True), c.WinDLL('ntdll')
        signatures = {'CreateFileW': ([c.c_wchar_p, U32, U32, H, U32, U32, H], H),
            'GetFileType': ([H], U32), 'GetFileInformationByHandleEx': ([H, c.c_int32, H, U32], c.c_int32),
            'ReadFile': ([H, H, U32, c.POINTER(U32), H], c.c_int32),
            'SetFilePointerEx': ([H, I64, H, U32], c.c_int32), 'CloseHandle': ([H], c.c_int32)}
        for name, (args, result) in signatures.items():
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, result
        self.nt.NtCreateFile.argtypes = [c.POINTER(H), U32, c.POINTER(OBJECT_ATTRIBUTES),
            c.POINTER(IO_STATUS_BLOCK), H, U32, U32, U32, U32, H, U32]
        self.nt.NtCreateFile.restype = c.c_int32

    @staticmethod
    def check(value):
        if not value: raise OSError('Owned Windows file operation failed')

    def drive(self, drive):
        handle = self.k.CreateFileW('\\\\?\\'+drive+'\\', 0x100081, 1, None, 3,
                                    0x02000000 | 0x00200000, None)
        if handle in (None, c.c_void_p(-1).value): raise OSError('Guest drive cannot be pinned')
        return handle

    def open(self, parent, name, directory):
        encoded = component(name)
        storage = c.create_string_buffer(encoded+b'\0\0')
        text = UNICODE_STRING(len(encoded), len(encoded)+2, c.cast(storage, H))
        attributes = OBJECT_ATTRIBUTES(c.sizeof(OBJECT_ATTRIBUTES), parent, c.pointer(text), 0x40, None, None)
        result, status = H(), IO_STATUS_BLOCK()
        # Read/list + read-attributes + synchronize. Read-only sharing denies
        # writable/deleting peers while each component's handle is retained.
        code = self.nt.NtCreateFile(c.byref(result), 0x100081, c.byref(attributes),
            c.byref(status), None, 0, 1, 1, 0x00200000 | 0x20 | (1 if directory else 0x40), None, 0)
        if code < 0 or not result.value: raise OSError('Relative Windows file open was refused')
        return result.value

    def info(self, handle):
        if self.k.GetFileType(handle) != 1: raise OSError('Guest object is not a disk file')
        identity, basic, standard = FILE_ID_INFO(), FILE_BASIC_INFO(), FILE_STANDARD_INFO()
        for kind, value in ((18, identity), (0, basic), (1, standard)):
            self.check(self.k.GetFileInformationByHandleEx(handle, kind, c.byref(value), c.sizeof(value)))
        if basic.FileAttributes & (0x400 | 0x40) or standard.DeletePending or standard.EndOfFile < 0:
            raise OSError('Guest object is reparsed, deleting or invalid')
        return {'volume': identity.VolumeSerialNumber, 'fileId': bytes(identity.FileId).hex(),
            'size': standard.EndOfFile, 'written': basic.LastWriteTime, 'changed': basic.ChangeTime,
            'links': standard.NumberOfLinks, 'directory': bool(standard.Directory),
            'attributes': basic.FileAttributes}

    def read(self, handle, offset, size):
        self.check(self.k.SetFilePointerEx(handle, offset, None, 0))
        buffer, count = c.create_string_buffer(size), U32()
        self.check(self.k.ReadFile(handle, buffer, size, c.byref(count), None))
        return buffer.raw[:count.value]

    def entries(self, handle):
        first = True
        while True:
            buffer = c.create_string_buffer(65536)
            if not self.k.GetFileInformationByHandleEx(handle, 20 if first else 19, buffer, len(buffer)):
                if c.get_last_error() == 18: return
                raise OSError('Windows native directory enumeration failed')
            first = False
            yield from directory_records(buffer.raw)

    def close(self, handle):
        self.check(self.k.CloseHandle(handle))


class WindowsRoot:
    """Explicit drive/root binding; request paths remain relative components."""
    def __init__(self, drive, prefix=(), *, api=None):
        if not isinstance(drive, str) or len(drive) != 2 or not drive[0].isascii() or not drive[0].isalpha() or drive[1] != ':':
            raise Error('Bind an explicit Windows drive, not a device or UNC path.', 400)
        if not isinstance(prefix, (list, tuple)): raise Error('Invalid Windows root components.', 400)
        for name in prefix: component(name)
        self.api, self.drive, self.prefix = api if api is not None else Win32Files(), drive.upper(), tuple(prefix)
        self.lock, self.listing = threading.RLock(), threading.Lock()
        self.handles, self.pins = [], set()
        self.started = self.fenced = False
        self.identity = None

    @staticmethod
    def _directory(info):
        if not info['directory'] or info['attributes'] & 0x400:
            raise Error('A pinned parent must be a non-reparsed directory.', 409)

    def start(self):
        with self.lock:
            if self.started or self.fenced: raise Error('A guest root cannot be restarted or adopted.', 409)
            self.started = True
            try:
                self.handles.append(self.api.drive(self.drive))
                drive_info = self.api.info(self.handles[-1])
                self._directory(drive_info)
                for name in self.prefix:
                    self.handles.append(self.api.open(self.handles[-1], name, True))
                    info = self.api.info(self.handles[-1])
                    self._directory(info)
                    if info['volume'] != drive_info['volume']:
                        raise Error('Windows root cannot cross its bound volume.', 409)
                self.identity = self.api.info(self.handles[-1])
            except Exception as error:
                self.fenced = True
                confirmed = self.close()
                raise Error('Windows root setup failed; cleanup '+('was confirmed.' if confirmed else 'is unconfirmed.'),
                            409, retryable=False, outcome=None if confirmed else 'unknown') from error
        return {'volume': self.identity['volume'], 'fileId': self.identity['fileId']}

    def pin(self, parts, *, directory=False):
        if not isinstance(parts, (list, tuple)):
            raise Error('Invalid Windows relative path components.', 400)
        path_bytes = 0
        for name in parts:
            path_bytes += len(component(name))+2
            if path_bytes > 65532:
                raise Error('Windows relative path metadata exceeds its envelope.', 400)
        with self.lock:
            if self.fenced or not self.handles: raise Error('Windows guest root is fenced.', 410)
            pin = FilePin(self)
            pin.io.acquire()
            self.pins.add(pin)  # Retain cleanup authority before any native open.
            parent = self.handles[-1]
        try:
            for index, name in enumerate(parts):
                is_directory = index < len(parts)-1 or directory
                parent = self.api.open(parent, name, is_directory)
                pin.handles.append(parent)
                info = self.api.info(parent)
                if info['volume'] != self.identity['volume']:
                    raise Error('Windows relative path crossed the pinned volume.', 409)
                if is_directory: self._directory(info)
            if not parts and not directory: raise Error('The guest root is a directory.', 400)
            pin.handle = parent
            pin.identity = self.api.info(parent)
            if pin.identity['directory'] != directory or pin.identity['attributes'] & 0x400:
                raise Error('Guest file type differs from the request.', 409)
            pin._check()
            pin.io.release()
            return pin
        except Exception as error:
            pin.io.release()
            confirmed = pin.close()
            raise Error('Windows relative file binding failed.', 409, retryable=False,
                        outcome=None if confirmed else 'unknown') from error

    def list(self, parts=()):
        if not self.listing.acquire(blocking=False):
            raise Error('Windows directory enumeration is busy.', 409, code='input_busy', retryable=False)
        pin = None
        try:
            pin = self.pin(parts, directory=True)
            entries, size, truncated = [], 0, False
            with pin.io:
                pin._check()
                deadline = time.monotonic()+3
                for entry in self.api.entries(pin.handle):
                    if self.fenced: raise Error('Windows guest root authorization ended.', 410)
                    length = len(json.dumps(entry, ensure_ascii=False, allow_nan=False).encode('utf-8'))
                    if len(entries) == 2000 or size+length+2 > 6*1048576-1024 or time.monotonic() >= deadline:
                        truncated = True
                        break
                    entries.append(entry)
                    size += length+2
                pin._check()
            return {'entries': entries, 'truncated': truncated}
        finally:
            try:
                if pin is not None and not pin.close():
                    self.fenced = True
                    raise Error('Windows directory handle cleanup remains unconfirmed.', 409,
                                code='file_cleanup_uncertain', retryable=False)
            finally:
                self.listing.release()

    def close(self):
        with self.lock:
            self.fenced = True
            confirmed = all([pin.close() for pin in tuple(self.pins)])
            if self.pins or not confirmed: return False
            while self.handles:
                try: self.api.close(self.handles[-1])
                except Exception: return False
                self.handles.pop()
            return True


class FilePin:
    def __init__(self, root):
        self.root, self.handles, self.handle, self.identity = root, [], None, None
        self.io, self.closed, self.fenced = threading.Lock(), False, False

    def check(self):
        if not self.io.acquire(blocking=False):
            raise Error('Windows file metadata check is busy.', 409, code='input_busy', retryable=False)
        try:
            return self._check()
        finally:
            self.io.release()

    def _check(self):
        if self.closed or self.fenced or self.root.fenced: raise Error('Windows file context is fenced.', 410)
        if self.root.api.info(self.handle) != self.identity:
            raise Error('Pinned Windows file identity or metadata changed.', 409)

    def read(self, offset, size):
        if (type(offset) is not int or not 0 <= offset <= 2**53-1
                or type(size) is not int or not 0 <= size <= CHUNK):
            raise Error('Use bounded Windows file reads and exact byte cursors.', 400)
        if not self.io.acquire(blocking=False):
            raise Error('Windows file read is busy.', 409, code='input_busy', retryable=False)
        try:
            self._check()
            if self.identity['directory']: raise Error('Cannot read a directory as a regular file.', 400)
            data = self.root.api.read(self.handle, offset, size) if size else b''
            if not isinstance(data, bytes) or len(data) > size:
                raise Error('Windows file read exceeds its envelope.', 409)
            self._check()
            return data
        finally:
            self.io.release()

    def close(self):
        self.fenced = True
        if not self.io.acquire(blocking=False): return False
        try:
            while self.handles:
                try: self.root.api.close(self.handles[-1])
                except Exception: return False
                self.handles.pop()
            self.closed = True
            with self.root.lock: self.root.pins.discard(self)
            return True
        finally:
            self.io.release()
